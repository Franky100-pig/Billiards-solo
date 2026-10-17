"""
rules_eightball.py — 8-ball game state machine, rules & foul detection.

Reimplemented from scratch. The 13 foul enums from bloob's poolRackLogic (E3)
are mapped onto a standard WPA/bar-rules 8-ball implementation:
  CONSECUTIVE_FOULS_EXCEEDED, ILLEGAL_EIGHT_BALL_POCKET,
  ILLEGAL_EIGHT_BALL_POCKET_TOO_SOON, ILLEGAL_EIGHT_BALL_POCKET_ON_BREAK,
  CUE_BALL_POCKET, CUE_BALL_HIT_NO_BALL, CUE_BALL_HIT_WRONG_BALL,
  CUSHION_HIT_MIN_ON_BREAK, CUSHION_HIT_INVALID, POCKETED_WRONG_BALL,
  POCKETED_STRAY_COLOR, POCKETED_OWN_BALL, SKIP_TURN.

We implement the meaningful subset: scratch, no-contact, wrong-first-contact,
no-rail-on-break, premature 8-ball (loss), legal 8-ball (win), group
assignment on open table. Win condition matches E3: a player wins when every
ball of their group is pocketed (plus the 8 ball legally).
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

from physics import Ball, make_8ball_world

SOLIDS = list(range(1, 8))        # 1-7
STRIPES = list(range(9, 16))      # 9-15
EIGHT = 8

# Fixed rack order (apex first). A legal rack puts the 8 in the middle of the
# third row and one solid + one stripe in the two back corners — hence 5
# (solid) and 15 (stripe) at the ends of the last row.
RACK_ORDER = [1, 9, 2, 10, 8, 11, 3, 12, 4, 13, 5, 14, 6, 7, 15]


class EightBallGame:
    def __init__(self, human_is_player: int = 0):
        self.world = make_8ball_world()
        self.is_bot = [False, False]
        self.is_bot[1 - human_is_player] = True
        self.current = 0
        self.groups: List[Optional[str]] = [None, None]  # "solid"/"stripe"
        self.open = True
        self.ball_in_hand = True
        self.ball_in_hand_kitchen = True  # restrict to left quarter on break
        self.pocketed: set = set()
        self.winner: Optional[int] = None
        self.message = "Break! Place the cue ball, then aim."
        self.foul = False
        self.consecutive_fouls = [0, 0]
        self.last_shot: Optional[dict] = None
        self._rack()

    # -- setup -------------------------------------------------------------
    def _rack(self) -> None:
        w = self.world
        r = w.ball_radius
        foot_x = w.width * 0.72
        apex_y = w.height / 2.0
        idx = 0
        for row in range(5):
            x = foot_x + row * r * math.sqrt(3.0)
            for j in range(row + 1):
                y = apex_y + (j - row / 2.0) * 2.0 * r
                num = RACK_ORDER[idx]
                kind = ("solid" if num in SOLIDS else
                        "stripe" if num in STRIPES else "eight")
                b = Ball(x, y, r, number=num, kind=kind)
                w.add_ball(b)
                idx += 1
        # cue ball
        cue = Ball(w.width * 0.25, w.height / 2.0, r, number=0, kind="cue")
        w.add_ball(cue)

    # -- queries -----------------------------------------------------------
    def cue(self) -> Ball:
        return self.world.cue_ball()

    def balls_by_kind(self, kind: str) -> List[Ball]:
        return [b for b in self.world.balls if b.kind == kind and not b.pocketed]

    def group_of(self, player: int) -> Optional[str]:
        return self.groups[player]

    def cleared_group(self, player: int) -> bool:
        g = self.groups[player]
        if g is None:
            return False
        nums = SOLIDS if g == "solid" else STRIPES
        return all(n in self.pocketed for n in nums)

    def legal_target_numbers(self, player: int) -> List[int]:
        """Numbers the player may legally pot this turn."""
        if self.open:
            return SOLIDS + STRIPES  # any object ball (8 illegal as first contact)
        if self.cleared_group(player):
            return [EIGHT]
        g = self.groups[player]
        return SOLIDS if g == "solid" else STRIPES

    def legal_first_contact(self, player: int) -> List[int]:
        """Numbers the cue may legally strike first this turn."""
        if self.open:
            return SOLIDS + STRIPES  # not the 8 on an open table
        return self.legal_target_numbers(player)

    def on_balls(self) -> List[Ball]:
        """Ball objects the current striker may legally pot this turn."""
        nums = set(self.legal_target_numbers(self.current))
        return [b for b in self.world.balls
                if b.number in nums and not b.pocketed]

    # -- actions -----------------------------------------------------------
    def place_cue(self, x: float, y: float) -> bool:
        """Ball-in-hand placement. Returns True if accepted."""
        if not self.ball_in_hand:
            return False
        w = self.world
        r = w.ball_radius
        if self.ball_in_hand_kitchen and x > w.width / 2.0:
            return False
        # must be inside the table
        if not (r <= x <= w.width - r and r <= y <= w.height - r):
            return False
        # must not overlap another ball
        for b in w.balls:
            if b.kind == "cue" or b.pocketed:
                continue
            if math.hypot(b.x - x, b.y - y) < 2 * r:
                return False
        cue = self.cue()
        cue.x, cue.y = x, y
        cue.pocketed = False
        cue.vx = cue.vy = 0.0
        return True

    def take_shot(self, angle: float, power: float) -> dict:
        """Headless: launch, fully simulate, then evaluate the shot."""
        if self.winner is not None:
            return {"error": "game over"}
        cue = self.cue()
        if cue is None:
            return {"error": "cue not on table — place it first"}
        self.launch(angle, power)
        self.world.simulate()
        return self.resolve_shot()

    def launch(self, angle: float, power: float) -> None:
        """Set the cue ball in motion (no simulation yet — UI steps it)."""
        cue = self.cue()
        self.world.begin_shot()
        self.world.shoot(cue, angle, power)

    def resolve_shot(self) -> dict:
        """Evaluate the shot that has already been simulated."""
        result = self._evaluate()
        self.last_shot = result
        return result

    def auto_place_cue(self) -> None:
        """Default cue placement for the bot (head spot, nudged if blocked)."""
        w = self.world
        self.place_cue(w.width * 0.25, w.height / 2.0)

    # -- evaluation --------------------------------------------------------
    def _evaluate(self) -> dict:
        w = self.world
        player = self.current
        opp = 1 - player
        pocketed = list(w.pocketed_this_shot)
        first = w.first_contact
        cue_sunk = 0 in pocketed
        eight_sunk = EIGHT in pocketed

        fouls: List[str] = []
        if cue_sunk:
            fouls.append("CUE_BALL_POCKET")
        if first is None:
            fouls.append("CUE_BALL_HIT_NO_BALL")
        else:
            legal_first = self.legal_first_contact(player)
            if first not in legal_first:
                fouls.append("CUE_BALL_HIT_WRONG_BALL")

        # break-specific: need >=1 pocket OR >=4 balls to a rail
        if self.ball_in_hand_kitchen:  # this shot was the break
            balls_to_rail = len(w.rail_hit)
            if not pocketed and balls_to_rail < 4:
                fouls.append("CUSHION_HIT_MIN_ON_BREAK")
            self.ball_in_hand_kitchen = False

        # premature 8-ball = loss
        if eight_sunk and not self.cleared_group(player):
            self.winner = opp
            self.message = f"Player {player+1} pocketed the 8 too soon — Player {opp+1} wins!"
            self.foul = True
            return {"foul": True, "loss": True, "winner": opp, "pocketed": pocketed,
                    "first": first, "fouls": fouls}

        # commit pocketed balls
        for n in pocketed:
            if n != 0:
                self.pocketed.add(n)

        # open-table group assignment
        if self.open and not fouls:
            obj = [n for n in pocketed if n in SOLIDS or n in STRIPES]
            if obj:
                # assign by the type of the first object ball potted
                first_obj = obj[0]
                grp = "solid" if first_obj in SOLIDS else "stripe"
                self.groups[player] = grp
                self.groups[opp] = "stripe" if grp == "solid" else "solid"
                self.open = False

        # legal 8-ball win
        if eight_sunk and self.cleared_group(player):
            self.winner = player
            self.message = f"Player {player+1} sinks the 8 and wins!"
            return {"foul": False, "win": True, "winner": player, "pocketed": pocketed,
                    "first": first, "fouls": fouls}

        # turn logic
        potted_own = self._potted_own(player, pocketed)
        fouled = bool(fouls)
        self.foul = fouled
        if fouled:
            self.consecutive_fouls[player] += 1
            self.ball_in_hand = True
            # scratch => cue must be replaced
            if cue_sunk:
                self._respot_cue()
            else:
                self.ball_in_hand_kitchen = False
            self.message = (f"Player {player+1} foul "
                            f"({', '.join(fouls)}). Ball in hand to Player {opp+1}.")
            self.current = opp
        else:
            self.consecutive_fouls[player] = 0
            self.ball_in_hand = False
            if potted_own:
                self.message = f"Player {player+1} pots and continues."
                # same player shoots again
            else:
                self.message = f"Player {player+1} misses. Turn to Player {opp+1}."
                self.current = opp
        return {"foul": fouled, "pocketed": pocketed, "first": first,
                "potted_own": potted_own, "fouls": fouls, "turn": self.current}

    def _potted_own(self, player: int, pocketed: List[int]) -> bool:
        if self.open:
            return any(n in SOLIDS or n in STRIPES for n in pocketed)
        g = self.groups[player]
        if g == "solid":
            return any(n in SOLIDS for n in pocketed)
        if g == "stripe":
            return any(n in STRIPES for n in pocketed)
        return False

    def _respot_cue(self) -> None:
        w = self.world
        r = w.ball_radius
        cue = self.cue()
        if cue is None:
            cue = Ball(0, 0, r, number=0, kind="cue")
            w.add_ball(cue)
        # place at head spot, nudged if occupied
        x, y = w.width * 0.25, w.height / 2.0
        while any(b is not cue and not b.pocketed and
                  math.hypot(b.x - x, b.y - y) < 2 * r for b in w.balls):
            x += r
            if x > w.width / 2.0:
                x = w.width * 0.25
                y += r
        cue.x, cue.y = x, y
        cue.pocketed = False
        cue.vx = cue.vy = 0.0
