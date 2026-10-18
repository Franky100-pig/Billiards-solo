"""
physics.py — deterministic top-down 2D billiards physics.

Reverse-engineering context (see docs/REA_findings.md):
  bloob.io exposes these constants for 8-ball (E1) and snooker (E2):
    - top-down, no gravity (gravityScale = 0)
    - ball radius 11 (8-ball) / 8.5 (snooker)
    - pocket capture radius 11 (8-ball) / 5 (snooker)
    - ball mass 3, ball-ball restitution 0.9, ball-cushion restitution 0.75
    - solverIterations 20, sleepSpeedLimit 5
    - "damping" 0.45  <-- the exact integration model is NOT statically
      reachable (see findings §6/§8); we model it as an exponential per-second
      linear decay v *= exp(-damping * dt), which is the physically standard
      interpretation of a damping coefficient and reproduces pool-like roll-off.

Everything here is reimplemented from scratch. No bloob source/art is used.
The module is pure Python (no pygame) so the bot can simulate shots headlessly.
"""

from __future__ import annotations

import copy
import math
from typing import List, Optional, Tuple

# ---------------------------------------------------------------------------
# Constants sourced from REA findings (table units; the table interior is
# exactly W x H as shipped by bloob, rendered later with a pixel scale).
# ---------------------------------------------------------------------------
BALL_RADIUS_8BALL = 11.0
POCKET_RADIUS_8BALL = 11.0
FIELD_8BALL = (572.0, 330.0)

# Snooker uses STANDARD table proportions: a 12ft table plays 3569 x 1778 mm,
# i.e. exactly 2:1, with 52.5 mm balls. bloob's own snooker field is 572 x 310
# (1.85:1) which does not look like a real snooker table, so we use the standard
# ratio instead. At a 620-unit playing surface the ball is ~9.1 units; we take
# 8.5 so the 15-red triangle still clears the black spot.
BALL_RADIUS_SNOOKER = 8.5
POCKET_RADIUS_SNOOKER = 7.5
FIELD_SNOOKER = (620.0, 310.0)

# Standard snooker markings, as fractions of the playing surface:
# baulk line at 1/5 of the length, D radius 292 mm (0.1636 of the width), black
# spot 324 mm off the top cushion, pink halfway centre -> top cushion.
SNOOKER_BAULK_X = 0.2065
SNOOKER_D_RADIUS = 0.1636
SNOOKER_BLACK_X = 0.9092
SNOOKER_PINK_X = 0.75

MASS = 3.0
RESTITUTION_BALL = 0.9
RESTITUTION_CUSHION = 0.75
DAMPING = 0.45            # per-second exponential linear decay (modeled; see docstring)
SLEEP_SPEED = 5.0         # u/s; below this a ball is parked
SOLVER_ITER = 20          # bloob uses 20; we resolve overlaps per-substep (cheap at our scale)


def _closest_point_on_segment(px: float, py: float,
                              ax: float, ay: float,
                              bx: float, by: float) -> Tuple[float, float]:
    """Closest point on segment AB to point P."""
    abx, aby = bx - ax, by - ay
    len2 = abx * abx + aby * aby
    if len2 == 0.0:
        return ax, ay
    t = ((px - ax) * abx + (py - ay) * aby) / len2
    t = max(0.0, min(1.0, t))
    return ax + t * abx, ay + t * aby


def _point_seg_dist(px: float, py: float,
                    ax: float, ay: float,
                    bx: float, by: float) -> float:
    """Distance from point P to segment AB."""
    return math.hypot(px - _closest_point_on_segment(px, py, ax, ay, bx, by)[0],
                      py - _closest_point_on_segment(px, py, ax, ay, bx, by)[1])


class Ball:
    __slots__ = ("x", "y", "px", "py", "vx", "vy", "radius", "mass",
                 "pocketed", "number", "kind")

    def __init__(self, x: float, y: float, radius: float, mass: float = MASS,
                 number: int = 0, kind: str = "object"):
        self.x = x
        self.y = y
        self.px = x
        self.py = y
        self.vx = 0.0
        self.vy = 0.0
        self.radius = radius
        self.mass = mass
        self.pocketed = False
        self.number = number
        self.kind = kind  # "cue", "solid", "stripe", "eight", "red", "color"

    def speed(self) -> float:
        return math.hypot(self.vx, self.vy)

    def clone(self) -> "Ball":
        b = Ball(self.x, self.y, self.radius, self.mass,
                 self.number, self.kind)
        b.vx, b.vy = self.vx, self.vy
        b.pocketed = self.pocketed
        return b


class World:
    """A billiards table + balls with deterministic stepping."""

    def __init__(self, width: float, height: float,
                 ball_radius: float, pocket_radius: float,
                 pockets: List[Tuple[float, float]],
                 restitution_ball: float = RESTITUTION_BALL,
                 restitution_cushion: float = RESTITUTION_CUSHION,
                 damping: float = DAMPING,
                 sleep_speed: float = SLEEP_SPEED):
        self.width = width
        self.height = height
        self.ball_radius = ball_radius
        self.pocket_radius = pocket_radius          # documented bloob value
        # Playability: bloob's literal hole.radius (5 / 11) is smaller than the
        # ball, so a shot aimed at a pocket misses. We capture within 1.5x the
        # ball radius (segment-based) for reliable, fair drops, and open a
        # modest cushion gap around each pocket mouth.
        self.capture_radius = ball_radius * 1.5
        self.gap = ball_radius * 1.1
        self.pockets = list(pockets)
        self.restitution_ball = restitution_ball
        self.restitution_cushion = restitution_cushion
        self.damping = damping
        self.sleep_speed = sleep_speed
        self.balls: List[Ball] = []
        # shot event tracking (reset by begin_shot)
        self.first_contact: Optional[int] = None      # ball number cue hit first
        self.pocketed_this_shot: List[int] = []        # ball numbers pocketed this shot
        self.rail_hit: set = set()                     # ball numbers that touched a cushion
        self.rail_after_contact = False                # did anything reach a rail once
                                                       # the cue ball had met a ball?
        # cushion segments leave a "mouth" gap near each pocket so balls drop
        # instead of bouncing on the rail right next to a pocket.
        self.cushions = self._build_cushions(gap=self.gap)

    # -- setup -------------------------------------------------------------
    def _build_cushions(self, gap: float) -> List[Tuple[float, float, float, float]]:
        W, H = self.width, self.height
        segs: List[Tuple[float, float, float, float]] = []
        mid = W / 2.0
        # top & bottom rails: two segments each (gap at corners + middle pocket)
        for y in (0.0, H):
            segs.append((gap, y, mid - gap, y))
            segs.append((mid + gap, y, W - gap, y))
        # left & right rails: one segment each (gap at both corners)
        for x in (0.0, W):
            segs.append((x, gap, x, H - gap))
        return segs

    def add_ball(self, ball: Ball) -> None:
        self.balls.append(ball)

    def cue_ball(self) -> Optional[Ball]:
        for b in self.balls:
            if b.kind == "cue" and not b.pocketed:
                return b
        return None

    # -- simulation --------------------------------------------------------
    def advance(self, h: float) -> None:
        """One fixed substep of duration h (seconds)."""
        # 1) integrate + exponential damping + sleep
        decay = math.exp(-self.damping * h)
        for b in self.balls:
            if b.pocketed:
                continue
            b.px, b.py = b.x, b.y
            b.x += b.vx * h
            b.y += b.vy * h
            b.vx *= decay
            b.vy *= decay
            if b.speed() < self.sleep_speed:
                b.vx = 0.0
                b.vy = 0.0

        # 2) ball-ball collisions (resolve a few times for stability)
        for _ in range(max(1, SOLVER_ITER // 10)):
            self._collide_balls()

        # 3) pockets then cushions per ball
        for b in self.balls:
            if b.pocketed:
                continue
            if self._check_pockets(b):
                continue
            self._collide_cushions(b)

        # 4) safety net: never let a ball leave the table. A fast ball can thread
        # the tiny sliver of a corner pocket gap (gap diagonal slightly exceeds
        # the capture radius); without this it would fly off to infinity and the
        # simulation would never settle. Out-of-bounds balls near a pocket are
        # captured as legitimate drops; otherwise they are clamped and bounced.
        for b in self.balls:
            if b.pocketed:
                continue
            self._contain_ball(b)

    def _contain_ball(self, b: Ball) -> None:
        r = b.radius
        W, H = self.width, self.height
        if not (b.x < r or b.x > W - r or b.y < r or b.y > H - r):
            return
        for px, py in self.pockets:
            if math.hypot(b.x - px, b.y - py) < self.capture_radius + self.gap + r:
                b.pocketed = True
                b.vx = 0.0
                b.vy = 0.0
                self.pocketed_this_shot.append(b.number)
                return
        e = self.restitution_cushion
        if b.x < r:
            b.x = r
            if b.vx < 0:
                b.vx = -b.vx * e
                self._touched_rail(b)
        elif b.x > W - r:
            b.x = W - r
            if b.vx > 0:
                b.vx = -b.vx * e
                self._touched_rail(b)
        if b.y < r:
            b.y = r
            if b.vy < 0:
                b.vy = -b.vy * e
                self._touched_rail(b)
        elif b.y > H - r:
            b.y = H - r
            if b.vy > 0:
                b.vy = -b.vy * e
                self._touched_rail(b)

    def simulate(self, h: float = 1.0 / 480.0, max_steps: int = 8000) -> int:
        """Run until all balls rest or max_steps reached. Returns steps used."""
        steps = 0
        for _ in range(max_steps):
            self.advance(h)
            steps += 1
            if self.all_resting():
                break
        return steps

    def begin_shot(self) -> None:
        """Reset per-shot event tracking before launching the cue ball."""
        self.first_contact = None
        self.pocketed_this_shot = []
        self.rail_hit = set()
        self.rail_after_contact = False

    def all_resting(self) -> bool:
        for b in self.balls:
            if not b.pocketed and b.speed() > 0.0:
                return False
        return True

    def _collide_balls(self) -> None:
        n = len(self.balls)
        for i in range(n):
            a = self.balls[i]
            if a.pocketed:
                continue
            for j in range(i + 1, n):
                b = self.balls[j]
                if b.pocketed:
                    continue
                dx = b.x - a.x
                dy = b.y - a.y
                dist2 = dx * dx + dy * dy
                rsum = a.radius + b.radius
                if dist2 >= rsum * rsum or dist2 == 0.0:
                    continue
                dist = math.sqrt(dist2)
                nx, ny = dx / dist, dy / dist
                # positional correction (split overlap)
                overlap = rsum - dist
                inv_a = 1.0 / a.mass
                inv_b = 1.0 / b.mass
                corr = overlap / (inv_a + inv_b)
                a.x -= nx * corr * inv_a
                a.y -= ny * corr * inv_a
                b.x += nx * corr * inv_b
                b.y += ny * corr * inv_b
                # relative velocity along normal
                rvx, rvy = b.vx - a.vx, b.vy - a.vy
                vn = rvx * nx + rvy * ny
                if vn > 0.0:
                    continue  # separating
                # record first cue contact for foul detection
                if self.first_contact is None:
                    if a.kind == "cue":
                        self.first_contact = b.number
                    elif b.kind == "cue":
                        self.first_contact = a.number
                e = self.restitution_ball
                jimp = -(1.0 + e) * vn / (inv_a + inv_b)
                a.vx -= jimp * inv_a * nx
                a.vy -= jimp * inv_a * ny
                b.vx += jimp * inv_b * nx
                b.vy += jimp * inv_b * ny

    def _check_pockets(self, b: Ball) -> bool:
        # segment-based capture: test the swept path (prev->cur) against each
        # pocket so fast balls can't tunnel past a tight pocket mouth.
        for px, py in self.pockets:
            if _point_seg_dist(px, py, b.px, b.py, b.x, b.y) < self.capture_radius:
                b.pocketed = True
                b.vx = 0.0
                b.vy = 0.0
                self.pocketed_this_shot.append(b.number)
                return True
        return False

    def _touched_rail(self, b: Ball) -> None:
        """Record a rail contact, and whether it happened after the first ball.

        The rules need both facts: which balls reached a cushion (four-ball
        break rule) and whether it happened after the cue ball first met an
        object ball, which is what separates a legal shot from one too soft to
        reach anything.
        """
        self.rail_hit.add(b.number)
        if self.first_contact is not None:
            self.rail_after_contact = True

    def _collide_cushions(self, b: Ball) -> None:
        r = b.radius
        # inside the pocket "jaws": don't bounce off the rail end, let it drop
        for px, py in self.pockets:
            if math.hypot(b.x - px, b.y - py) < self.capture_radius + r:
                return
        for ax, ay, bx, by in self.cushions:
            cx, cy = _closest_point_on_segment(b.x, b.y, ax, ay, bx, by)
            dx, dy = b.x - cx, b.y - cy
            d2 = dx * dx + dy * dy
            if d2 >= r * r or d2 == 0.0:
                continue
            d = math.sqrt(d2)
            nx, ny = dx / d, dy / d
            # push out of the rail
            b.x = cx + nx * r
            b.y = cy + ny * r
            # reflect the inward-normal velocity component
            vn = b.vx * nx + b.vy * ny
            if vn < 0.0:
                e = self.restitution_cushion
                b.vx -= (1.0 + e) * vn * nx
                b.vy -= (1.0 + e) * vn * ny
                self._touched_rail(b)

    # -- shots -------------------------------------------------------------
    def shoot(self, ball: Ball, angle: float, speed: float) -> None:
        """Launch a ball at `angle` (radians) with initial `speed` (u/s)."""
        ball.vx = math.cos(angle) * speed
        ball.vy = math.sin(angle) * speed

    # -- helpers for AI / rendering ---------------------------------------
    def clone(self) -> "World":
        w = World(self.width, self.height, self.ball_radius,
                  self.pocket_radius, self.pockets,
                  self.restitution_ball, self.restitution_cushion,
                  self.damping, self.sleep_speed)
        w.balls = [b.clone() for b in self.balls]
        return w

    def active_balls(self) -> List[Ball]:
        return [b for b in self.balls if not b.pocketed]


def make_8ball_world() -> World:
    W, H = FIELD_8BALL
    pockets = [
        (0.0, 0.0), (W / 2.0, 0.0), (W, 0.0),
        (0.0, H), (W / 2.0, H), (W, H),
    ]
    return World(W, H, BALL_RADIUS_8BALL, POCKET_RADIUS_8BALL, pockets)


def make_snooker_world() -> World:
    W, H = FIELD_SNOOKER
    # Standard pockets: four corners plus the two middle pockets on the long
    # rails (which is why a snooker table is not a simple 6-hole rectangle).
    pockets = [
        (0.0, 0.0), (W / 2.0, 0.0), (W, 0.0),
        (0.0, H), (W / 2.0, H), (W, H),
    ]
    return World(W, H, BALL_RADIUS_SNOOKER, POCKET_RADIUS_SNOOKER, pockets)


if __name__ == "__main__":
    # quick self-test: a straight break-like shot should settle.
    w = make_8ball_world()
    cue = Ball(w.width / 2, w.height / 2, w.ball_radius, kind="cue")
    obj = Ball(w.width / 2 + 60, w.height / 2, w.ball_radius, kind="object", number=1)
    w.add_ball(cue)
    w.add_ball(obj)
    w.shoot(cue, 0.0, 1400.0)
    steps = w.simulate()
    print(f"settled in {steps} steps; cue pos=({cue.x:.1f},{cue.y:.1f}) "
          f"pocketed={cue.pocketed}; obj pocketed={obj.pocketed}")
