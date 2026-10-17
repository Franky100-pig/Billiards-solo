"""
bot.py — shared vs-AI opponent for 8-ball and snooker.

Strategy (standard billiards AI, reimplemented from scratch):
  1. pot search — for each legal target ball, for each pocket: compute the
     ghost-ball contact point so the target would travel to the pocket, check
     the cue->ghost and target->pocket paths are clear, simulate the shot on a
     cloned world, then score the outcome.
  2. position play (走位) — every simulated candidate also reports where the
     CUE BALL came to rest; that resting position is scored by asking "is there
     a clean pot available from here for the next shot?". A pot that leaves a
     good angle earns a bonus, a pot that leaves the cue snookered is penalised.
  3. escape shots — when nothing can be potted (snookered), mirror each target
     across every cushion to build one-rail kick lines, simulate them, and play
     the one that legally contacts the ball that is on.
  4. a soft safety shot as the last resort.

Difficulty tiers adjust aim noise and search depth (botDifficulty in findings E4).
"""

from __future__ import annotations

import math
import random
from typing import Callable, List, Optional, Tuple

from physics import World, Ball

DIFFICULTY = {
    "easy":   {"noise": 0.030, "top_k": 3, "power_jitter": 0.20},
    "medium": {"noise": 0.012, "top_k": 8, "power_jitter": 0.10},
    "hard":   {"noise": 0.0,   "top_k": 99, "power_jitter": 0.04},
}

# how much a good next position is worth, relative to potting a ball
POSITION = {
    "8ball":   {"bonus": 60.0, "dead": -22.0},
    "snooker": {"bonus": 6.0,  "dead": -2.5},
}


# -- geometry --------------------------------------------------------------
def _point_seg_dist(px, py, ax, ay, bx, by) -> float:
    abx, aby = bx - ax, by - ay
    l2 = abx * abx + aby * aby
    if l2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / l2))
    cx, cy = ax + t * abx, ay + t * aby
    return math.hypot(px - cx, py - cy)


def path_clear(world: World, p0: Tuple[float, float], p1: Tuple[float, float],
               ignore: List[int], r: float) -> bool:
    """True if no active ball (except `ignore` numbers) blocks segment p0->p1."""
    for b in world.balls:
        if b.pocketed or b.number in ignore:
            continue
        if _point_seg_dist(b.x, b.y, p0[0], p0[1], p1[0], p1[1]) < 2 * r:
            return False
    return True


def ghost_aim(cue: Ball, target: Ball, pocket: Tuple[float, float],
              r: float) -> Optional[Tuple[float, float]]:
    """Return (angle, ghost_point) for cue to send target toward pocket."""
    dx, dy = pocket[0] - target.x, pocket[1] - target.y
    d = math.hypot(dx, dy)
    if d < 1e-6:
        return None
    ux, uy = dx / d, dy / d
    gx, gy = target.x - ux * 2 * r, target.y - uy * 2 * r
    cdx, cdy = gx - cue.x, gy - cue.y
    cd = math.hypot(cdx, cdy)
    if cd < 1e-6:
        return None
    angle = math.atan2(cdy, cdx)
    return angle, (gx, gy)


def power_for_distance(dist: float) -> float:
    """Heuristic launch speed (u/s) to cover `dist` table-units and still pot."""
    return min(1700.0, 360.0 + 5.5 * dist)


def reflect_point(px: float, py: float, ax: float, ay: float,
                  bx: float, by: float) -> Tuple[float, float]:
    """Mirror point p across the line a->b (used for one-rail bank shots)."""
    abx, aby = bx - ax, by - ay
    l2 = abx * abx + aby * aby
    if l2 < 1e-9:
        return px, py
    t = ((px - ax) * abx + (py - ay) * aby) / l2
    cx, cy = ax + t * abx, ay + t * aby
    return 2 * cx - px, 2 * cy - py


def line_intersect(p0: Tuple[float, float], p1: Tuple[float, float],
                   a: Tuple[float, float], b: Tuple[float, float]
                   ) -> Optional[Tuple[float, float]]:
    """Intersection of segment p0->p1 with segment a->b, else None."""
    rx, ry = p1[0] - p0[0], p1[1] - p0[1]
    sx, sy = b[0] - a[0], b[1] - a[1]
    den = rx * sy - ry * sx
    if abs(den) < 1e-9:
        return None
    apx, apy = a[0] - p0[0], a[1] - p0[1]
    t = (apx * sy - apy * sx) / den
    u = (apx * ry - apy * rx) / den
    if t <= 0.02 or t >= 0.98:
        return None
    if u < -0.05 or u > 1.05:
        return None
    return p0[0] + t * rx, p0[1] + t * ry


# -- what is "on" after a hypothetical shot ---------------------------------
def next_targets(game, wc: World, potted: List[int]) -> List[Ball]:
    alive = [b for b in wc.balls if not b.pocketed and b.number != 0]
    if game.__class__.__name__ == "EightBallGame":
        eight = [b for b in alive if b.number == 8]
        grp = game.groups[game.current]
        if game.open:
            solid_potted = any(1 <= n <= 7 for n in potted)
            stripe_potted = any(9 <= n <= 15 for n in potted)
            if solid_potted and not stripe_potted:
                grp = "solid"
            elif stripe_potted and not solid_potted:
                grp = "stripe"
        if grp is None:
            any_ball = [b for b in alive if b.number != 8]
            return any_ball if any_ball else eight
        is_solid = grp == "solid"
        mine = [b for b in alive if b.number != 8 and (1 <= b.number <= 7) == is_solid]
        return mine if mine else eight
    # snooker
    reds = [b for b in alive if b.kind == "red"]
    colors = [b for b in alive if b.kind == "color" and b.number not in game.colors_down]
    if reds:
        if 1 in potted:
            # a colour is on; colours pocketed this shot are re-spotted
            return [b for b in wc.balls if b.kind == "color" and not b.pocketed
                    and b.number not in game.colors_down]
        if any(2 <= n <= 7 for n in potted):
            return reds
        return reds + colors
    if not colors:
        return []
    low = min(b.number for b in colors)
    return [b for b in colors if b.number == low]


def position_quality(world: World, cue_after: Ball, targets: List[Ball],
                     pockets, r: float) -> float:
    """How good is the cue ball's resting position? 0..1, 1 = dead-straight pot."""
    best = 0.0
    for t in targets:
        for p in pockets:
            g = ghost_aim(cue_after, t, p, r)
            if g is None:
                continue
            ghost = g[1]
            if not path_clear(world, (cue_after.x, cue_after.y), ghost,
                              [0, t.number], r):
                continue
            if not path_clear(world, (t.x, t.y), p, [0, t.number], r):
                continue
            d = math.hypot(ghost[0] - cue_after.x, ghost[1] - cue_after.y) + \
                math.hypot(p[0] - t.x, p[1] - t.y)
            q = max(0.0, 1.0 - d / 700.0)
            if q > best:
                best = q
    return best


def position_bonus(game, wc: World, cue_after: Ball, potted: List[int],
                   r: float) -> float:
    """Position bonus for a candidate shot (negative = a dead leave)."""
    cfg = POSITION["8ball"] if game.__class__.__name__ == "EightBallGame" \
        else POSITION["snooker"]
    targets = next_targets(game, wc, potted)
    if not targets:
        return cfg["bonus"]            # frame over / group cleared
    q = position_quality(wc, cue_after, targets, wc.pockets, r)
    return cfg["bonus"] * q if q > 0.0 else cfg["dead"]


# -- core search -----------------------------------------------------------
def enumerate_pots(world: World, cue: Ball, targets: List[Ball],
                  pockets: List[Tuple[float, float]], r: float,
                  pos_fn: Optional[Callable] = None) -> List[dict]:
    """Return candidate pots with geometry + simulated outcome scores."""
    cands: List[dict] = []
    for t in targets:
        for p in pockets:
            g = ghost_aim(cue, t, p, r)
            if g is None:
                continue
            angle, ghost = g
            cue_clear = path_clear(world, (cue.x, cue.y), ghost,
                                   [cue.number, t.number], r)
            tgt_clear = path_clear(world, (t.x, t.y), p,
                                   [cue.number, t.number], r)
            if not (cue_clear and tgt_clear):
                continue  # only attempt geometrically clear pots
            # simulate (lighter settings; the bot only needs an approximate read)
            wc = world.clone()
            wc.begin_shot()
            cc = wc.cue_ball()
            dist = math.hypot(ghost[0] - cue.x, ghost[1] - cue.y) + \
                   math.hypot(p[0] - t.x, p[1] - t.y)
            wc.shoot(cc, angle, power_for_distance(dist))
            wc.simulate(h=1.0 / 300.0, max_steps=4500)

            cue_sunk = 0 in wc.pocketed_this_shot
            cue_after = None
            pos = 0.0
            cb = wc.cue_ball()
            if not cue_sunk and cb is not None and not cb.pocketed:
                cue_after = (cb.x, cb.y)
                if pos_fn is not None:
                    pos = pos_fn(wc, cb, list(wc.pocketed_this_shot))
            cands.append({
                "target": t.number, "pocket": p, "angle": angle,
                "cue_clear": cue_clear, "tgt_clear": tgt_clear,
                "pocketed": list(wc.pocketed_this_shot),
                "first": wc.first_contact,
                "cue_sunk": cue_sunk,
                "ghost": ghost, "cue_after": cue_after, "pos": pos,
            })
    return cands


def escape_shots(game, world: World, cue: Ball, targets: List[Ball],
                 r: float, pos_fn=None) -> List[dict]:
    """One-rail kick search: bank off a cushion into a legal ball."""
    pockets = world.pockets
    pool = sorted(targets, key=lambda t: math.hypot(t.x - cue.x, t.y - cue.y))[:4]
    out: List[dict] = []
    for t in pool:
        for seg in world.cushions:
            ax, ay, bx, by = seg
            mx, my = reflect_point(t.x, t.y, ax, ay, bx, by)
            I = line_intersect((cue.x, cue.y), (mx, my), (ax, ay), (bx, by))
            if I is None:
                continue
            dx, dy = I[0] - cue.x, I[1] - cue.y
            d1 = math.hypot(dx, dy)
            if d1 < 2 * r:
                continue
            # aim a ball-radius short of the cushion so the bounce lands on I
            ux, uy = dx / d1, dy / d1
            aim = (I[0] - ux * r, I[1] - uy * r)
            if not path_clear(world, (cue.x, cue.y), aim, [cue.number, t.number], r):
                continue
            if not path_clear(world, I, (t.x, t.y), [cue.number, t.number], r):
                continue
            angle = math.atan2(aim[1] - cue.y, aim[0] - cue.x)
            path = d1 + math.hypot(t.x - I[0], t.y - I[1])
            power = min(1750.0, power_for_distance(path) * 1.18)
            wc = world.clone()
            wc.begin_shot()
            wc.shoot(wc.cue_ball(), angle, power)
            wc.simulate(h=1.0 / 300.0, max_steps=4500)

            cue_sunk = 0 in wc.pocketed_this_shot
            pos = 0.0
            cb = wc.cue_ball()
            if not cue_sunk and cb is not None and not cb.pocketed and pos_fn:
                pos = pos_fn(wc, cb, list(wc.pocketed_this_shot))

            if cue_sunk:
                sc = -300.0
            elif wc.first_contact is None:
                sc = -60.0
            elif wc.first_contact not in {x.number for x in targets}:
                sc = -120.0
            else:
                sc = 30.0 + pos * 0.5
            out.append({"score": sc, "angle": angle, "power": power})
    return out


# -- per-mode scoring ------------------------------------------------------
def score_8ball(game, c: dict) -> float:
    sc = 0.0
    potted = c["pocketed"]
    if c["cue_sunk"]:
        return -250.0
    if 8 in potted:
        # premature 8 = loss; avoid unless legal (handled by rules)
        if not game.cleared_group(game.current):
            return -1000.0
    own = []
    opp = []
    if game.open:
        own = [n for n in potted if n in range(1, 8) or n in range(9, 16)]
    else:
        grp = game.groups[game.current]
        own = [n for n in potted if (n in range(1, 8)) == (grp == "solid")
               and n != 8]
        opp = [n for n in potted if (n in range(1, 8)) != (grp == "solid")
               and n != 8 and n != 0]
    sc += 100.0 * len(own)
    sc -= 30.0 * len(opp)
    if c["first"] is None:
        sc -= 200.0  # no contact foul
    elif not game.open and c["first"] not in game.legal_first_contact(game.current):
        sc -= 120.0  # wrong-ball-first
    # small bonus for a clear (unobstructed) pot
    if c["cue_clear"] and c["tgt_clear"] and own:
        sc += 25.0
    # winning 8-ball pot is the best outcome
    if 8 in potted and game.cleared_group(game.current):
        sc += 500.0
    return sc


def score_snooker(game, c: dict) -> float:
    if c["cue_sunk"]:
        return -300.0
    potted = [n for n in c["pocketed"] if n != 0]
    # legal first contact?
    on_nums = {b.number for b in game.on_balls()}
    if c["first"] is None or (c["first"] not in on_nums and not game.free_ball):
        return -200.0
    sc = 0.0
    for n in potted:
        sc += game.value(n)
    if c["cue_clear"] and c["tgt_clear"] and potted:
        sc += 10.0
    return sc


# -- public API ------------------------------------------------------------
def choose_shot(game, difficulty: str = "medium") -> Tuple[float, float]:
    cfg = DIFFICULTY.get(difficulty, DIFFICULTY["medium"])
    world = game.world
    cue = game.cue()
    if cue is None:
        return 0.0, 0.0
    r = world.ball_radius
    pockets = world.pockets
    targets = game.on_balls()

    cands = enumerate_pots(
        world, cue, targets, pockets, r,
        pos_fn=lambda wc, cb, potted: position_bonus(game, wc, cb, potted, r))
    if game.__class__.__name__ == "EightBallGame":
        scorer = score_8ball
    else:
        scorer = score_snooker

    # keep only candidates whose simulated first contact is legal-ish
    scored = []
    for c in cands:
        s = scorer(game, c) + c["pos"]
        # require a legal first contact in simulation (unless free ball)
        on_nums = {b.number for b in targets}
        if c["first"] not in on_nums and c["first"] is not None:
            s -= 150.0
        scored.append((s, c))
    scored.sort(key=lambda x: x[0], reverse=True)

    # pick among top_k; easier bots may pick a weaker option
    top_k = max(1, cfg["top_k"])
    pool = scored[:top_k] if scored else []
    if pool and pool[0][0] > -50.0:  # a worthwhile pot exists
        if difficulty == "easy" and len(pool) > 1 and random.random() < 0.4:
            s, c = random.choice(pool[1:])
        else:
            s, c = pool[0]
        angle = c["angle"] + random.gauss(0, cfg["noise"])
        pw = power_for_distance(
            math.hypot(c["ghost"][0] - cue.x, c["ghost"][1] - cue.y) +
            math.hypot(c["pocket"][0] - _target_xy(game, c["target"])[0],
                       c["pocket"][1] - _target_xy(game, c["target"])[1]))
        pw *= (1.0 + random.gauss(0, cfg["power_jitter"]))
        return angle, min(1800.0, max(250.0, pw))

    # 2) nothing worth potting -> try a one-rail escape before a plain safety
    if targets:
        escapes = escape_shots(
            game, world, cue, targets, r,
            pos_fn=lambda wc, cb, potted: position_bonus(game, wc, cb, potted, r))
        if escapes:
            escapes.sort(key=lambda x: x["score"], reverse=True)
            best = escapes[0]
            if best["score"] > -50.0:
                return best["angle"] + random.gauss(0, cfg["noise"]), best["power"]

    # 3) safety: contact a legal ball we can reach in a straight line, softly
    return safety_shot(game, cue, targets, r, cfg, world)


def _target_xy(game, number: int) -> Tuple[float, float]:
    for b in game.world.balls:
        if b.number == number and not b.pocketed:
            return (b.x, b.y)
    return (0.0, 0.0)


def safety_shot(game, cue: Ball, targets: List[Ball], r: float,
                cfg: dict, world: Optional[World] = None) -> Tuple[float, float]:
    """Contact a legal ball softly, preferring one we can reach in a straight line."""
    w = world if world is not None else game.world
    reachable = []
    for t in targets:
        d = math.hypot(t.x - cue.x, t.y - cue.y)
        clear = path_clear(w, (cue.x, cue.y), (t.x, t.y), [cue.number, t.number], r)
        reachable.append((0 if clear else 1, d, t))
    if not reachable:
        return 0.0, 300.0
    reachable.sort(key=lambda x: (x[0], x[1]))
    _, best_d, best = reachable[0]
    angle = math.atan2(best.y - cue.y, best.x - cue.x)
    angle += random.gauss(0, cfg["noise"] * 1.5)
    pw = min(900.0, 320.0 + 3.0 * best_d) * (1.0 + random.gauss(0, cfg["power_jitter"]))
    return angle, max(250.0, pw)
