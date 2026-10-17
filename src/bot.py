"""
bot.py — shared vs-AI opponent for 8-ball and snooker.

Strategy (standard billiards AI, reimplemented from scratch):
  for each legal target ball, for each pocket:
    compute the ghost-ball contact point so the target would travel to the
    pocket, check the cue->ghost and target->pocket paths are clear, simulate
    the shot on a cloned world, then score the outcome. Pick the best; when no
    makeable pot exists, play a soft safety that at least contacts a legal ball.

Difficulty tiers adjust aim noise and search depth (botDifficulty in findings E4).
"""

from __future__ import annotations

import math
import random
from typing import List, Optional, Tuple

from physics import World, Ball

DIFFICULTY = {
    "easy":   {"noise": 0.030, "top_k": 3, "power_jitter": 0.20},
    "medium": {"noise": 0.012, "top_k": 8, "power_jitter": 0.10},
    "hard":   {"noise": 0.0,   "top_k": 99, "power_jitter": 0.04},
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


# -- core search -----------------------------------------------------------
def enumerate_pots(world: World, cue: Ball, targets: List[Ball],
                  pockets: List[Tuple[float, float]], r: float
                  ) -> List[dict]:
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
            cands.append({
                "target": t.number, "pocket": p, "angle": angle,
                "cue_clear": cue_clear, "tgt_clear": tgt_clear,
                "pocketed": list(wc.pocketed_this_shot),
                "first": wc.first_contact,
                "cue_sunk": 0 in wc.pocketed_this_shot,
                "ghost": ghost,
            })
    return cands


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

    cands = enumerate_pots(world, cue, targets, pockets, r)
    if game.__class__.__name__ == "EightBallGame":
        scorer = score_8ball
    else:
        scorer = score_snooker

    # keep only candidates whose simulated first contact is legal-ish
    scored = []
    for c in cands:
        s = scorer(game, c)
        # require a legal first contact in simulation (unless free ball)
        on_nums = {b.number for b in targets}
        if c["first"] not in on_nums and c["first"] is not None:
            s -= 150.0
        scored.append((s, c))
    scored.sort(key=lambda x: x[0], reverse=True)

    # pick among top_k; easier bots may pick a weaker option
    top_k = max(1, cfg["top_k"])
    pool = scored[:top_k] if scored else []
    if pool:
        if difficulty == "easy" and len(pool) > 1 and random.random() < 0.4:
            s, c = random.choice(pool[1:])
        else:
            s, c = pool[0]
        if s > -50.0:  # a worthwhile pot exists
            angle = c["angle"] + random.gauss(0, cfg["noise"])
            pw = power_for_distance(
                math.hypot(c["ghost"][0] - cue.x, c["ghost"][1] - cue.y) +
                math.hypot(c["pocket"][0] - _target_xy(game, c["target"])[0],
                           c["pocket"][1] - _target_xy(game, c["target"])[1]))
            pw *= (1.0 + random.gauss(0, cfg["power_jitter"]))
            return angle, min(1800.0, max(250.0, pw))

    # safety: contact the nearest legal ball softly, aim away from own pocket
    return safety_shot(game, cue, targets, r, cfg)


def _target_xy(game, number: int) -> Tuple[float, float]:
    for b in game.world.balls:
        if b.number == number and not b.pocketed:
            return (b.x, b.y)
    return (0.0, 0.0)


def safety_shot(game, cue: Ball, targets: List[Ball], r: float,
                cfg: dict) -> Tuple[float, float]:
    """Aim at the nearest legal ball with low power; nudge to avoid a scratch."""
    best = None
    best_d = 1e9
    for t in targets:
        d = math.hypot(t.x - cue.x, t.y - cue.y)
        if d < best_d:
            best_d = d
            best = t
    if best is None:
        return 0.0, 300.0
    angle = math.atan2(best.y - cue.y, best.x - cue.x)
    angle += random.gauss(0, cfg["noise"] * 1.5)
    pw = min(900.0, 320.0 + 3.0 * best_d) * (1.0 + random.gauss(0, cfg["power_jitter"]))
    return angle, max(250.0, pw)
