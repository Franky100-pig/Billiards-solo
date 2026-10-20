"""
rules_snooker.py — snooker frame state machine, scoring & foul detection.

Reimplemented from scratch. Values (E3 / standard rules, INFERENCE noted in
findings §4): red=1, yellow=2, green=3, brown=4, blue=5, pink=6, black=7.
Reds must be cleared first; then colours are potted in ascending order.
A colour potted while reds remain (or out of rotation) is re-spotted.
Foul penalty = max(4, value of ball first hit, value of any ball potted).
A basic free-ball flag is exposed for the bot/UI (full free-ball nuance is
simplified but playable).
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

from physics import (Ball, make_snooker_world,
                     SNOOKER_BAULK_X, SNOOKER_D_RADIUS,
                     SNOOKER_BLACK_X, SNOOKER_PINK_X)

COLOR_VALUES = {2: "yellow", 3: "green", 4: "brown", 5: "blue", 6: "pink", 7: "black"}
COLOR_ORDER = [2, 3, 4, 5, 6, 7]   # ascending, end-game sequence


def snooker_spots(W: float, H: float) -> dict:
    """Standard snooker spots on a W x H playing surface.

    Baulk line at 0.2065 L, D radius 0.1636 W, blue dead centre, pink at
    0.75 L (midway centre -> top cushion), black at 0.9092 L (324 mm off the
    top cushion). Yellow / green sit on the corners of the D, brown in its
    middle.
    """
    baulk = W * SNOOKER_BAULK_X
    d_r = H * SNOOKER_D_RADIUS
    return {
        "baulk_x": baulk,
        "d_radius": d_r,
        "colors": {
            2: (baulk, H * 0.5 + d_r),          # yellow
            3: (baulk, H * 0.5 - d_r),          # green
            4: (baulk, H * 0.5),                # brown
            5: (W * 0.5, H * 0.5),              # blue
            6: (W * SNOOKER_PINK_X, H * 0.5),   # pink
            7: (W * SNOOKER_BLACK_X, H * 0.5),  # black
        },
    }


class SnookerGame:
    def __init__(self, human_is_player: int = 0):
        self.world = make_snooker_world()
        self.is_bot = [False, False]
        self.is_bot[1 - human_is_player] = True
        self.current = 0
        self.scores = [0, 0]
        self.reds_remaining = 15
        self.colors_down: set = set()          # permanently potted colours
        self.phase = "red"                      # "red" or "color"
        self.free_ball = False
        self.ball_in_hand = False               # only after cue is potted (in-off)
        self.winner: Optional[int] = None
        self.message = "Snooker — pot a red to start."
        self.foul = False
        self.last_shot: Optional[dict] = None
        self._rack()

    # -- setup -------------------------------------------------------------
    def _rack(self) -> None:
        w = self.world
        r = w.ball_radius
        W, H = w.width, w.height
        spots = snooker_spots(W, H)
        # colours
        for val, (sx, sy) in spots["colors"].items():
            b = Ball(sx, sy, r, number=val, kind="color")
            w.add_ball(b)
        # reds: apex faces the baulk end (left), the pack widens toward black
        apex_x = spots["colors"][6][0] + 2 * r + 0.4
        apex_y = H * 0.50
        for row in range(5):
            x = apex_x + row * r * math.sqrt(3.0)
            for j in range(row + 1):
                y = apex_y + (j - row / 2.0) * 2.0 * r
                b = Ball(x, y, r, number=1, kind="red")
                w.add_ball(b)
        # cue ball starts INSIDE the D (rule 3.3: the striker plays from in the D)
        cue = Ball(spots["baulk_x"] - spots["d_radius"] * 0.45,
                   H * 0.50 + spots["d_radius"] * 0.55, r, number=0, kind="cue")
        w.add_ball(cue)

    # -- queries -----------------------------------------------------------
    def cue(self) -> Ball:
        return self.world.cue_ball()

    def on_balls(self) -> List[Ball]:
        """Balls that are legally 'on' for the current striker.

        Simplified model: while any reds remain, a red is always 'on'
        (we do not alternate red/colour per shot — see findings §4). Once the
        reds are cleared, the lowest colour not yet down is 'on'.
        """
        w = self.world
        if self.reds_remaining > 0:
            return [b for b in w.balls if b.kind == "red" and not b.pocketed]
        for val in COLOR_ORDER:
            if val not in self.colors_down:
                return [b for b in w.balls if b.kind == "color"
                        and b.number == val and not b.pocketed]
        return []

    def _legal_first_numbers(self) -> set:
        """Numbers that may legally be struck first THIS turn (state-based,
        independent of balls already pocketed during the shot)."""
        if self.free_ball:
            return {b.number for b in self.world.balls
                    if b.kind in ("red", "color") and not b.pocketed}
        if self.reds_remaining > 0:
            if self.phase == "red":
                return {1}
            return {b.number for b in self.world.balls
                    if b.kind == "color" and b.number not in self.colors_down}
        low = min(c for c in COLOR_ORDER if c not in self.colors_down)
        return {low}

    def value(self, number: int) -> int:
        if number == 1:
            return 1
        return number  # colours are numbered by value

    # -- actions -----------------------------------------------------------
    def place_cue(self, x: float, y: float) -> bool:
        if not self.ball_in_hand:
            return False
        w = self.world
        r = w.ball_radius
        spots = snooker_spots(w.width, w.height)
        if not (r <= y <= w.height - r):
            return False
        # rule: the cue ball must be played from inside the D
        if math.hypot(x - spots["baulk_x"], y - w.height / 2.0) > spots["d_radius"]:
            return False
        for b in w.balls:
            if b.kind == "cue" or b.pocketed:
                continue
            if math.hypot(b.x - x, b.y - y) < 2 * r:
                return False
        cue = self.cue()
        cue.x, cue.y = x, y
        cue.pocketed = False
        cue.vx = cue.vy = 0.0
        cue.wx = cue.wy = cue.wz = 0.0
        return True

    def take_shot(self, angle: float, power: float,
                  spin: Optional[Tuple[float, float]] = None) -> dict:
        if self.winner is not None:
            return {"error": "frame over"}
        cue = self.cue()
        if cue is None:
            return {"error": "cue not on table — place it first"}
        self.launch(angle, power, spin)
        self.world.simulate()
        return self.resolve_shot()

    def launch(self, angle: float, power: float,
               spin: Optional[Tuple[float, float]] = None) -> None:
        cue = self.cue()
        self.world.begin_shot()
        self.world.shoot(cue, angle, power, spin)

    def resolve_shot(self) -> dict:
        result = self._evaluate()
        self.last_shot = result
        return result

    def auto_place_cue(self) -> None:
        w = self.world
        spots = snooker_spots(w.width, w.height)
        self.place_cue(spots["baulk_x"] - spots["d_radius"] * 0.50,
                       w.height / 2.0 + spots["d_radius"] * 0.55)

    # -- evaluation --------------------------------------------------------
    def _evaluate(self) -> dict:
        w = self.world
        player = self.current
        opp = 1 - player
        pocketed = list(w.pocketed_this_shot)
        first = w.first_contact
        cue_sunk = 0 in pocketed

        fouls: List[str] = []
        on_nums = self._legal_first_numbers()

        # first-contact legality
        if first is None:
            fouls.append("MISS")
        else:
            # free ball: any object ball may be hit first (treated as the on-ball)
            if not self.free_ball:
                if first not in on_nums:
                    fouls.append("WRONG_BALL_FIRST")

        # potting legality
        potted_nums = [n for n in pocketed if n != 0]
        potted_reds = [n for n in potted_nums if n == 1]
        potted_colors = [n for n in potted_nums if n in COLOR_VALUES]
        if cue_sunk:
            fouls.append("IN_OFF")

        # --- table state must stay consistent even when a foul occurs ---
        # A red that is pocketed stays down (snooker rule) — decrement whether
        # or not the shot was clean, otherwise the counter drifts out of sync
        # with the balls actually on the table (caused the bot to chase
        # phantom reds during bot-vs-bot play).
        if potted_reds:
            self.reds_remaining -= len(potted_reds)
            if self.reds_remaining < 0:
                self.reds_remaining = 0
        # Any colour pocketed while reds remain must be re-spotted: it cannot
        # legitimately stay down during the red phase (foul or not).
        if self.reds_remaining > 0 and potted_colors:
            self._respot_colors(potted_colors)
        # Derive the "on" phase from the remaining reds (simplified model:
        # reds are always "on" until cleared, then colours in ascending order).
        self.phase = "red" if self.reds_remaining > 0 else "color"

        # --- scoring & pot legality (only when no foul) ---
        scored = 0
        potted_correct = False
        if not fouls:
            if self.reds_remaining > 0:
                # red phase: a red (optionally with one bonus colour) is "on"
                if potted_reds:
                    scored += len(potted_reds)
                    potted_correct = True
                    if potted_colors:
                        scored += max(potted_colors)
                elif potted_colors and not self.free_ball:
                    fouls.append("COLOUR_POTTED_EARLY")
            else:
                # end game: colours in ascending order
                if potted_colors and not potted_reds:
                    val = max(potted_colors)
                    low = min(c for c in COLOR_ORDER if c not in self.colors_down)
                    if val == low:
                        scored += val
                        potted_correct = True
                        self.colors_down.add(val)
                        if val == 7:  # black potted last
                            self._end_frame()
                    else:
                        fouls.append("WRONG_COLOUR_ORDER")
                        self._respot_colors(potted_colors)
                elif potted_reds:
                    fouls.append("RED_POTTED_WHEN_COLOUR_ON")
                    self._respot_colors(potted_colors)
        else:
            # foul: a colour pocketed in the end game must also be re-spotted
            if self.reds_remaining == 0 and potted_colors:
                self._respot_colors(potted_colors)

        # apply scoring / fouls
        if fouls:
            self.foul = True
            penalty = max(4, self.value(first) if first else 0,
                          max([self.value(n) for n in potted_nums], default=0))
            self.scores[opp] += penalty
            self.free_ball = True
            self.ball_in_hand = cue_sunk
            if cue_sunk:
                self._respot_cue()
            self.message = (f"Player {player+1} foul (+{penalty} to P{opp+1}): "
                            f"{', '.join(fouls)}.")
            self.current = opp
        else:
            self.foul = False
            self.scores[player] += scored
            self.free_ball = False
            self.ball_in_hand = False
            if potted_correct:
                self.message = (f"Player {player+1} pots (+{scored}). "
                                f"Score {self.scores[0]}-{self.scores[1]}.")
                # same player continues when a ball was legally potted
            else:
                self.message = (f"Player {player+1} misses. "
                                f"Score {self.scores[0]}-{self.scores[1]}.")
                self.current = opp

        result = {"foul": bool(fouls), "fouls": fouls, "scored": scored, "pocketed": pocketed,
                  "first": first, "scores": list(self.scores),
                  "turn": self.current, "reds": self.reds_remaining}
        return result

    def _respot_colors(self, vals: List[int]) -> None:
        """Re-spot colours that were potted (whilst reds remain)."""
        w = self.world
        r = w.ball_radius
        W, H = w.width, w.height
        spots = snooker_spots(W, H)["colors"]
        for v in vals:
            b = next((x for x in w.balls if x.number == v and x.kind == "color"), None)
            if b is None:
                b = Ball(0, 0, r, number=v, kind="color")
                w.add_ball(b)
            sx, sy = spots[v]
            # nudge if the spot is occupied
            while any(other is not b and not other.pocketed and
                      math.hypot(other.x - sx, other.y - sy) < 2*r
                      for other in w.balls):
                sy += r
                if sy > H - r:
                    sy = H * 0.50
                    sx += r
            b.x, b.y = sx, sy
            b.pocketed = False
            b.vx = b.vy = 0.0

    def _respot_cue(self) -> None:
        w = self.world
        r = w.ball_radius
        spots = snooker_spots(w.width, w.height)
        cue = self.cue()
        if cue is None:
            cue = Ball(0, 0, r, number=0, kind="cue")
            w.add_ball(cue)
        x = spots["baulk_x"] - spots["d_radius"] * 0.50
        y = w.height * 0.50 + spots["d_radius"] * 0.55
        while any(b is not cue and not b.pocketed and
                  math.hypot(b.x - x, b.y - y) < 2*r for b in w.balls):
            y += r
            if y > w.height * 0.5 + spots["d_radius"]:
                y = w.height * 0.5 - spots["d_radius"] * 0.6
                x -= r
        cue.x, cue.y = x, y
        cue.pocketed = False
        cue.vx = cue.vy = 0.0
        cue.wx = cue.wy = cue.wz = 0.0

    def _end_frame(self) -> None:
        # frame ends when black is potted and all colours down
        if self.scores[0] == self.scores[1]:
            # tie-break: re-spot black and continue (simplified: declare draw)
            self.winner = None
            self.message = "Frame tie — re-spot black (simplified draw)."
            return
        self.winner = 0 if self.scores[0] > self.scores[1] else 1
        self.message = f"Frame over — Player {self.winner+1} wins " \
                       f"{self.scores[self.winner]}-{self.scores[1-self.winner]}."
