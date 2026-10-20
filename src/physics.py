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
RADIUS_RATIO = 2.0 / 5.0  # I = 2/5 m r^2 for a solid sphere
INV_RATIO = 1.0 / RADIUS_RATIO
RESTITUTION_BALL = 0.93
RESTITUTION_CUSHION = 0.72
DAMPING = 0.45            # per-second exponential linear decay (modeled; see docstring)
SLEEP_SPEED = 4.5         # u/s; below this a ball is parked
SOLVER_ITER = 20          # bloob uses 20; we resolve overlaps per-substep (cheap at our scale)

# Friction coefficients. Ball-ball friction is small (a pool ball slaps rather
# than grips) but it is what produces throw on a cut; the cushion rubber grips
# more, which is how side spin kicks off a rail.
BALL_FRICTION = 0.055
CUSHION_FRICTION = 0.17

# Cloth friction while the ball slides on its contact patch. Big enough that a
# draw shot visibly comes back, small enough that a rolling ball is unaffected.
SLIP_DECEL = 470.0        # u/s^2
SLIP_SNAP = 1.6           # below this the ball is treated as rolling
SPIN_DAMPING = 0.75       # per-second decay of side spin
# The tip can only contact the ball within ~half a radius of centre without
# miscueing, and 0.4 R is exactly natural roll (w = v/r).
SPIN_ZONE = 0.55
SPIN_DEFAULT = 0.5        # dial position the bot strokes with


# ---------------------------------------------------------------------------
# Orientation quaternions. The renderer needs to know which way the printed
# surface is facing; the mechanics need it too, because the roll you see has to
# come from the angular velocity rather than from the distance travelled.
# Stored as (w, x, y, z).
# ---------------------------------------------------------------------------
def q_mul(a: Tuple[float, float, float, float],
          b: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw)


def q_normalise(q: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    n = math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) or 1.0
    return (q[0] / n, q[1] / n, q[2] / n, q[3] / n)


def q_rotate(q: Tuple[float, float, float, float],
             v: Tuple[float, float, float]) -> Tuple[float, float, float]:
    """Rotate vector v by quaternion q (v' = q v q*)."""
    w, x, y, z = q
    vx, vy, vz = v
    tx = 2.0 * (y * vz - z * vy)
    ty = 2.0 * (z * vx - x * vz)
    tz = 2.0 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx))


def q_integrate(q: Tuple[float, float, float, float],
                wx: float, wy: float, wz: float,
                h: float) -> Tuple[float, float, float, float]:
    """Advance orientation by world-frame angular velocity (wx, wy, wz) over h."""
    w, x, y, z = q
    k = 0.5 * h
    return q_normalise((
        w + k * (-(wx * x + wy * y + wz * z)),
        x + k * (w * wx + (wy * z - wz * y)),
        y + k * (w * wy + (wz * x - wx * z)),
        z + k * (w * wz + (wx * y - wy * x)),
    ))


def rack_orientation(n: int) -> Tuple[float, float, float, float]:
    """A deterministic orientation for ball `n` as it comes out of the rack.

    It makes no difference to the mechanics, but it makes a visible one: a rack
    where every ball starts at the same orientation shows every stripe's white
    pole to the camera, so seven of the balls look like spare cue balls. This
    spreads them from the ball number, which keeps the rack reproducible.
    """
    ax, ay, az = 0.9 * n, 1.7 * n, 2.3 * n
    qx = (math.cos(ax / 2.0), math.sin(ax / 2.0), 0.0, 0.0)
    qy = (math.cos(ay / 2.0), 0.0, math.sin(ay / 2.0), 0.0)
    qz = (math.cos(az / 2.0), 0.0, 0.0, math.sin(az / 2.0))
    return q_normalise(q_mul(q_mul(qz, qy), qx))


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
    __slots__ = ("x", "y", "px", "py", "vx", "vy", "wx", "wy", "wz", "q",
                 "radius", "mass", "pocketed", "number", "kind")

    def __init__(self, x: float, y: float, radius: float, mass: float = MASS,
                 number: int = 0, kind: str = "object"):
        self.x = x
        self.y = y
        self.px = x
        self.py = y
        self.vx = 0.0
        self.vy = 0.0
        # Angular velocity, world frame: (wx, wy) is the rolling spin seen as a
        # rotation about the x/y axes, wz is side spin about the vertical.
        self.wx = 0.0
        self.wy = 0.0
        self.wz = 0.0
        # Orientation, presentation-only in effect but kept on the ball so the
        # renderer draws the surface the mechanics actually turned.
        self.q: Tuple[float, float, float, float] = (1.0, 0.0, 0.0, 0.0)
        self.radius = radius
        self.mass = mass
        self.pocketed = False
        self.number = number
        self.kind = kind  # "cue", "solid", "stripe", "eight", "red", "color"

    def speed(self) -> float:
        return math.hypot(self.vx, self.vy)

    def slip(self) -> float:
        """Speed of the contact patch relative to the cloth."""
        return math.hypot(self.vx - self.radius * self.wy,
                          self.vy + self.radius * self.wx)

    def clone(self) -> "Ball":
        b = Ball(self.x, self.y, self.radius, self.mass,
                 self.number, self.kind)
        b.vx, b.vy = self.vx, self.vy
        b.wx, b.wy, b.wz = self.wx, self.wy, self.wz
        b.q = self.q
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
        # Track the printed surface only in worlds that get drawn. The bot
        # simulates thousands of steps on scratch worlds it never renders, and
        # integrating a quaternion there is pure cost (it doubled think time in
        # the web build), so clone() switches it off.
        self.track_orientation = True
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
        # 1) cloth friction, then damping, integrate, sleep
        decay = math.exp(-self.damping * h)
        spin_decay = math.exp(-SPIN_DAMPING * h)
        for b in self.balls:
            if b.pocketed:
                continue
            self._cloth_friction(b, h)
            b.vx *= decay
            b.vy *= decay
            b.wz *= spin_decay
            b.px, b.py = b.x, b.y
            b.x += b.vx * h
            b.y += b.vy * h

            # Turn the ball by however much it actually spun this step. Taking
            # the rotation from the angular velocity, and not from the distance
            # travelled, is what makes a skidding ball slide without turning
            # and a draw shot rotate backwards while it is still going forward.
            if self.track_orientation and (b.wx or b.wy or b.wz):
                b.q = q_integrate(b.q, b.wx, b.wy, b.wz, h)

            # A ball only rests when it is neither travelling nor spinning
            # against the cloth: killing a slow ball that still carries draw
            # spin would silently eat the shot, and the cue ball would never
            # come back.
            if b.speed() < self.sleep_speed and b.slip() < self.sleep_speed * 3.0:
                b.vx = 0.0
                b.vy = 0.0
                b.wx = 0.0
                b.wy = 0.0
                b.wz = 0.0

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

    def _cloth_friction(self, b: Ball, h: float) -> None:
        """Coulomb friction between the ball and the cloth, at the contact patch.

        For a sphere the slip decays 3.5x faster than the ball decelerates
        (1 + 5/2 from the moment of inertia), so a struck ball reaches pure
        rolling in a fraction of a second -- the little "skid then roll" a real
        ball does, and the reason draw and follow exist at all. Because the spin
        is a real angular velocity, a ball struck below centre keeps turning
        backwards while it is still travelling forwards, and that is exactly
        what drags it back.
        """
        R = b.radius
        ux = b.vx - R * b.wy
        uy = b.vy + R * b.wx
        us = math.hypot(ux, uy)
        if us < SLIP_SNAP:
            # pure rolling: snap the spin to the velocity so nothing buzzes
            sp = b.speed()
            if sp > 1e-6:
                b.wx = -(b.vy / R)
                b.wy = (b.vx / R)
            else:
                b.wx = 0.0
                b.wy = 0.0
            return
        # never overshoot the remaining slip inside one substep
        dec = min(SLIP_DECEL * h, us / (1.0 + INV_RATIO))
        f = dec / us
        dvx = -ux * f
        dvy = -uy * f
        b.vx += dvx
        b.vy += dvy
        b.wx += (INV_RATIO * dvy) / R
        b.wy -= (INV_RATIO * dvx) / R

    def _contain_ball(self, b: Ball) -> None:
        r = b.radius
        W, H = self.width, self.height
        if not (b.x < r or b.x > W - r or b.y < r or b.y > H - r):
            return
        for px, py in self.pockets:
            if math.hypot(b.x - px, b.y - py) < self.capture_radius + self.gap + r:
                self._pocket(b)
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

                # --- tangential (friction) impulse: throw + spin transfer -----
                # t = z x n. The surface speed at the equator is v +- wz*r*t, so
                # side spin shows up directly in the relative tangential
                # velocity -- this is what makes a cut shot "throw" the object
                # ball off the pure 90-degree line.
                tx, ty = -ny, nx
                vt = (rvx * tx + rvy * ty) - a.radius * (a.wz + b.wz)
                inv_t = 1.0 / ((1.0 + INV_RATIO) * (inv_a + inv_b))
                jt = vt * inv_t
                jmax = BALL_FRICTION * jimp
                jt = -jmax if jt < -jmax else (jmax if jt > jmax else jt)
                a.vx += jt * inv_a * tx
                a.vy += jt * inv_a * ty
                b.vx -= jt * inv_b * tx
                b.vy -= jt * inv_b * ty
                # d(wz) = r*jt / I with I = 2/5 m r^2  ->  2.5*jt/(m r)
                a.wz += (INV_RATIO * jt * inv_a) / a.radius
                b.wz += (INV_RATIO * jt * inv_b) / b.radius

    def _pocket(self, b: Ball) -> None:
        """A pocketed ball carries nothing onward: no travel, no spin."""
        b.pocketed = True
        b.vx = 0.0
        b.vy = 0.0
        b.wx = 0.0
        b.wy = 0.0
        b.wz = 0.0
        self.pocketed_this_shot.append(b.number)

    def _check_pockets(self, b: Ball) -> bool:
        # segment-based capture: test the swept path (prev->cur) against each
        # pocket so fast balls can't tunnel past a tight pocket mouth.
        for px, py in self.pockets:
            if _point_seg_dist(px, py, b.px, b.py, b.x, b.y) < self.capture_radius:
                self._pocket(b)
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

                # Friction on the rubber: this is what turns side spin into a
                # change of rebound angle ("the rail grabbed it") instead of a
                # cosmetic effect.
                #
                # The impulse OPPOSES the slip at the contact patch, so it is
                # negative. Getting that sign wrong is not a subtle error: the
                # rail then pushes the ball along itself, so a 45-degree bank
                # leaves at 61 degrees and the ball gains speed it never had.
                # See docs/REA_findings.md 12.4.
                m = b.mass
                tx, ty = -ny, nx
                vt = b.vx * tx + b.vy * ty - r * b.wz
                jn = (1.0 + e) * (-vn) * m
                jt = -(m * vt) / (1.0 + INV_RATIO)
                jmax = CUSHION_FRICTION * jn
                jt = -jmax if jt < -jmax else (jmax if jt > jmax else jt)
                b.vx += (jt / m) * tx
                b.vy += (jt / m) * ty
                b.wz -= (INV_RATIO * jt) / (m * r)

    # -- shots -------------------------------------------------------------
    def shoot(self, ball: Ball, angle: float, speed: float,
              spin: Optional[Tuple[float, float]] = None) -> None:
        """Strike a ball at `angle` (radians) with initial `speed` (u/s).

        `spin` is the tip offset on the ball face, in units of the ball radius:
          spin[0] < 0 = left english, > 0 = right english
          spin[1] < 0 = draw (below centre), > 0 = follow (above centre)

        A cue strike at height h*r above the centre of mass gives
            w = 2.5 * h * v / r
        (impulse through the centre: v = J/m, w = h*r*J / (2/5 m r^2)). So a
        dead-centre hit leaves NO spin: the ball skids, and the cloth rolls it
        up. Natural roll needs h = 0.4, and the tip can only reach about half a
        radius from centre without miscueing, hence SPIN_ZONE.

        The spin is a real angular velocity, not a cosmetic offset, which is why
        the cloth friction above turns a draw shot into a ball that comes back.
        """
        sx = spin[0] if spin else 0.0
        sy = spin[1] if spin else SPIN_DEFAULT
        ux, uy = math.cos(angle), math.sin(angle)
        ball.vx = ux * speed
        ball.vy = uy * speed

        r = ball.radius
        hgt = max(-1.0, min(1.0, sy)) * SPIN_ZONE
        roll = 2.5 * hgt                     # 1.0 = pure rolling
        ball.wx = -(speed / r) * roll * uy
        ball.wy = (speed / r) * roll * ux
        ball.wz = (sx * speed * 0.55) / r    # surface speed ~55% of cue speed

    # -- helpers for AI / rendering ---------------------------------------
    def clone(self) -> "World":
        w = World(self.width, self.height, self.ball_radius,
                  self.pocket_radius, self.pockets,
                  self.restitution_ball, self.restitution_cushion,
                  self.damping, self.sleep_speed)
        w.balls = [b.clone() for b in self.balls]
        # A clone is the bot's scratch world: it is simulated thousands of times
        # per shot and never drawn, so tracking the printed surface there would
        # cost time for nothing.
        w.track_orientation = False
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
