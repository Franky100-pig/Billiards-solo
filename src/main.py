"""
main.py — Billiards-solo offline desktop app (pygame).

Menu -> pick 8-ball or snooker + difficulty -> play vs the built-in bot.
All physics/rules/AI live in the sibling modules; this file only handles
input, rendering, and turn flow. No network access anywhere.

Controls:
  - Ball-in-hand: click inside the allowed area to place the cue ball.
  - Aiming: just move the mouse. The aim is the ray from the cue ball TO the
    cursor, so the cue line and the shot both point where the pointer is.
  - Power: press the left button to lock that direction, then drag BACK along
    the cue line and release. Only the backward component counts, so loading
    power can never change the aim.
  - R: return to the menu (restart) after a frame ends.
"""

from __future__ import annotations

import math
import sys

import pygame

from physics import Ball, SNOOKER_BAULK_X, SNOOKER_D_RADIUS
from rules_eightball import EightBallGame
from rules_snooker import SnookerGame
import bot as botmod

# --------------------------------------------------------------------------
# Window / rendering
# --------------------------------------------------------------------------
WIN_W, WIN_H = 960, 660
HUD_TOP, HUD_BOTTOM = 78, 56
RAIL = 26
FPS = 60
ANIM_H = 1.0 / 360.0          # physics substep for the animated shot
SUBSTEPS_PER_FRAME = 16        # ~5760 substeps/sec -> shots resolve in ~1-3 s
MAX_LAUNCH = 2000.0           # u/s at full pull
MIN_LAUNCH = 160.0
MAX_DRAG = 230.0              # px of pull for full power

# 8-ball colours (number -> rgb), 9-15 reuse 1-7 as stripes
EIGHT_COLORS = {
    1: (240, 205, 45), 2: (40, 70, 200), 3: (210, 45, 45), 4: (150, 45, 200),
    5: (225, 130, 35), 6: (40, 165, 70), 7: (155, 45, 45), 8: (22, 22, 22),
}
# snooker colours (number -> rgb), standard ball set
SNOOKER_COLORS = {
    1: (188, 32, 44),    # red
    2: (242, 200, 68),   # yellow
    3: (18, 116, 58),    # green
    4: (120, 72, 32),    # brown
    5: (18, 70, 162),    # blue
    6: (230, 122, 152),  # pink
    7: (24, 24, 24),     # black
}
SNOOKER_CUE = (247, 243, 232)   # ivory cue ball


def ball_color(b: Ball, snooker: bool):
    """Return (fill_rgb, is_stripe)."""
    if b.kind == "cue":
        return (SNOOKER_CUE if snooker else (235, 235, 235)), False
    if snooker:
        return SNOOKER_COLORS.get(b.number, (200, 200, 200)), False
    if b.number in (9, 10, 11, 12, 13, 14, 15):
        return EIGHT_COLORS[b.number - 8], True
    return EIGHT_COLORS.get(b.number, (200, 200, 200)), False


class App:
    def __init__(self):
        pygame.init()
        self.screen = pygame.display.set_mode((WIN_W, WIN_H))
        pygame.display.set_caption("Billiards-solo — offline 8-ball & snooker vs AI")
        self.clock = pygame.time.Clock()
        self.font = pygame.font.SysFont("dejavusans", 20)
        self.small = pygame.font.SysFont("dejavusans", 15)
        self.big = pygame.font.SysFont("dejavusans", 30)

        self.mode = "8ball"          # selected in menu
        self.difficulty = "medium"
        self.phase = "menu"          # menu | play | over
        self.game = None
        self.snooker = False

        # layout (set when a game starts)
        self.scale = 1.0
        self.ox = self.oy = 0.0

        # interaction
        self.mouse = (0, 0)
        self.mouse_seen = False       # keep the default aim until the mouse moves
        self.pulling = False
        self.pull_from = None         # where the power drag started
        self.pull_len = 0.0           # px pulled back along the cue line
        self.simulating = False
        self.await_place = False
        self.pending_bot = False
        self.bot_think_frames = 0
        self.aim_angle = 0.0
        self.power = 0.0

        # menu button rects
        self._build_menu()

    # -- layout ------------------------------------------------------------
    def _layout(self, game):
        W = game.world.width
        H = game.world.height
        avail_w = WIN_W - 2 * 30 - 2 * RAIL
        avail_h = WIN_H - HUD_TOP - HUD_BOTTOM - 2 * RAIL
        self.scale = min(avail_w / W, avail_h / H)
        tw = W * self.scale + 2 * RAIL
        th = H * self.scale + 2 * RAIL
        self.ox = (WIN_W - tw) / 2 + RAIL
        self.oy = HUD_TOP + (avail_h - H * self.scale) / 2 + RAIL

    def w2s(self, x, y):
        return (self.ox + x * self.scale, self.oy + y * self.scale)

    def s2w(self, sx, sy):
        return ((sx - self.ox) / self.scale, (sy - self.oy) / self.scale)

    # -- menu --------------------------------------------------------------
    def _build_menu(self):
        self.mode_btns = {
            "8ball": pygame.Rect(WIN_W / 2 - 220, 250, 200, 70),
            "snooker": pygame.Rect(WIN_W / 2 + 20, 250, 200, 70),
        }
        self.diff_btns = {
            "easy": pygame.Rect(WIN_W / 2 - 220, 360, 130, 50),
            "medium": pygame.Rect(WIN_W / 2 - 75, 360, 150, 50),
            "hard": pygame.Rect(WIN_W / 2 + 95, 360, 130, 50),
        }

    def start_game(self):
        if self.mode == "8ball":
            self.game = EightBallGame(human_is_player=0)
            self.snooker = False
        else:
            self.game = SnookerGame(human_is_player=0)
            self.snooker = True
        self._layout(self.game)
        self.phase = "play"
        self.simulating = False
        self.pulling = False
        self.pull_from = None
        self.pull_len = 0.0
        self.pending_bot = False
        self.await_place = self.game.ball_in_hand

    # -- input -------------------------------------------------------------
    def on_click(self, pos):
        if self.phase == "menu":
            for m, r in self.mode_btns.items():
                if r.collidepoint(pos):
                    self.mode = m
            for d, r in self.diff_btns.items():
                if r.collidepoint(pos):
                    self.difficulty = d
            # start when a mode button is clicked (mode already set above)
            for m, r in self.mode_btns.items():
                if r.collidepoint(pos):
                    self.start_game()
            return
        if self.phase == "over":
            return
        # play phase
        if self.await_place:
            wx, wy = self.s2w(*pos)
            if self.game.place_cue(wx, wy):
                self.await_place = False
            else:
                # say why: a click that does nothing is the worst possible answer
                why = getattr(self.game, "place_refusal", lambda x, y: None)(wx, wy)
                if why:
                    self.game.message = why
            return
        if not self.simulating and self._human_turn():
            self.begin_pull(pos)

    def aim_at(self, pos):
        """Aim straight at the cursor: the ray runs from the cue ball TO the
        mouse, so the line and the shot both point where you are looking.
        (This used to be the opposite direction and only updated while
        dragging, which made the aim feel inverted and impossible to set
        before loading power.)"""
        if self.phase != "play" or self.pulling or self.simulating:
            return
        if not self.mouse_seen or not self._human_turn():
            return
        cue = self.game.cue()
        if cue is None:
            return
        cx, cy = self.w2s(cue.x, cue.y)
        dx, dy = pos[0] - cx, pos[1] - cy
        if math.hypot(dx, dy) < 6.0:
            return
        self.aim_angle = math.atan2(dy, dx)

    def begin_pull(self, pos):
        """Press locks the direction and starts loading the cue; the drag that
        follows only ever changes the power."""
        if self.game.cue() is None:
            return
        self.pulling = True
        self.pull_from = (pos[0], pos[1])
        self.pull_len = 0.0
        self.power = 0.0

    def on_release(self, pos):
        if self.phase != "play" or not self.pulling:
            return
        self.pulling = False
        self.pull_from = None
        if self.power < MIN_LAUNCH * 0.5:
            return
        cue = self.game.cue()
        if cue is None:
            return
        self.game.launch(self.aim_angle, self.power)
        self.simulating = True

    def _human_turn(self):
        return self.game.current == 0

    def update_pull(self):
        # aiming happens on hover, not on drag: the direction is settled first
        self.aim_at(self.mouse)
        if not self.pulling or self.pull_from is None:
            return
        cue = self.game.cue()
        if cue is None:
            self.power = 0.0
            return
        ux, uy = math.cos(self.aim_angle), math.sin(self.aim_angle)
        dx = self.mouse[0] - self.pull_from[0]
        dy = self.mouse[1] - self.pull_from[1]
        # only the component dragged BACK along the cue counts, so sideways
        # wobble changes neither aim nor strength and a forward drag never fires
        self.pull_len = max(0.0, min(MAX_DRAG, -(dx * ux + dy * uy)))
        if self.pull_len < 2.0:
            self.power = 0.0
            return
        self.power = (MIN_LAUNCH
                      + (self.pull_len / MAX_DRAG) ** 1.35 * (MAX_LAUNCH - MIN_LAUNCH))

    # -- turn flow ---------------------------------------------------------
    def after_resolve(self):
        g = self.game
        if g.winner is not None:
            self.phase = "over"
            return
        if g.ball_in_hand:
            self.await_place = True
        else:
            self.await_place = False
        # if it is now the bot's turn, queue its shot
        if g.current == 1:
            self.pending_bot = True
            self.bot_think_frames = 0
        else:
            self.pending_bot = False

    def do_bot_turn(self):
        g = self.game
        if g.ball_in_hand:
            g.auto_place_cue()
        angle, power = botmod.choose_shot(g, self.difficulty)
        g.launch(angle, power)
        self.simulating = True
        self.pending_bot = False

    # -- main loop ---------------------------------------------------------
    def run(self):
        running = True
        while running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                elif event.type == pygame.MOUSEMOTION:
                    self.mouse = event.pos
                    self.mouse_seen = True
                elif event.type == pygame.MOUSEBUTTONDOWN:
                    if event.button == 1:
                        self.on_click(event.pos)
                    elif event.button == 3:
                        # right click: put a loaded cue back down
                        self.pulling = False
                        self.pull_from = None
                        self.pull_len = 0.0
                        self.power = 0.0
                elif event.type == pygame.MOUSEBUTTONUP:
                    if event.button == 1:
                        self.on_release(event.pos)
                elif event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_r and self.phase in ("play", "over"):
                        self.phase = "menu"
                    elif event.key == pygame.K_ESCAPE:
                        self.phase = "menu"

            self.update_pull()

            if self.phase == "play":
                if self.simulating:
                    for _ in range(SUBSTEPS_PER_FRAME):
                        self.game.world.advance(ANIM_H)
                        if self.game.world.all_resting():
                            break
                    if self.game.world.all_resting():
                        self.game.resolve_shot()
                        self.simulating = False
                        self.after_resolve()
                elif self.pending_bot:
                    self.bot_think_frames += 1
                    if self.bot_think_frames > 8:   # show "thinking" briefly
                        self.do_bot_turn()

            self.render()
            pygame.display.flip()
            self.clock.tick(FPS)

        pygame.quit()
        sys.exit()

    # -- rendering ---------------------------------------------------------
    def render(self):
        self.screen.fill((28, 30, 34))
        if self.phase == "menu":
            self._render_menu()
        else:
            self._render_table()
            self._render_balls()
            if self.phase == "play" and self._human_turn() and not self.simulating \
                    and not self.await_place:
                self._render_aim()
            self._render_hud()
            if self.phase == "over":
                self._render_over()

    def _render_menu(self):
        title = self.big.render("Billiards-solo", True, (235, 235, 235))
        self.screen.blit(title, (WIN_W / 2 - title.get_width() / 2, 110))
        sub = self.small.render("Reverse-engineered study of bloob.io — reimplemented offline in pygame",
                               True, (170, 175, 185))
        self.screen.blit(sub, (WIN_W / 2 - sub.get_width() / 2, 160))
        for m, r in self.mode_btns.items():
            col = (70, 130, 90) if self.mode == m else (60, 64, 72)
            pygame.draw.rect(self.screen, col, r, border_radius=8)
            t = self.font.render(m.upper(), True, (240, 240, 240))
            self.screen.blit(t, (r.centerx - t.get_width() / 2, r.centery - 10))
        dl = self.small.render("Difficulty:", True, (200, 205, 215))
        self.screen.blit(dl, (WIN_W / 2 - 220, 335))
        for d, r in self.diff_btns.items():
            col = (90, 110, 160) if self.difficulty == d else (60, 64, 72)
            pygame.draw.rect(self.screen, col, r, border_radius=8)
            t = self.font.render(d, True, (240, 240, 240))
            self.screen.blit(t, (r.centerx - t.get_width() / 2, r.centery - 10))
        hint = self.small.render("Click a game mode to start.  (R = menu, Esc = menu)",
                                 True, (150, 155, 165))
        self.screen.blit(hint, (WIN_W / 2 - hint.get_width() / 2, 470))

    def _render_table(self):
        g = self.game
        w = g.world
        # cloth
        x0, y0 = self.w2s(0, 0)
        tw = w.width * self.scale
        th = w.height * self.scale
        pygame.draw.rect(self.screen, (22, 92, 46),
                         pygame.Rect(x0 - RAIL, y0 - RAIL, tw + 2 * RAIL, th + 2 * RAIL))
        pygame.draw.rect(self.screen, (15, 70, 35), pygame.Rect(x0, y0, tw, th))
        # baulk line + D for snooker (standard positions, see physics constants)
        if self.snooker:
            bx = self.ox + w.width * SNOOKER_BAULK_X * self.scale
            dr = w.height * SNOOKER_D_RADIUS * self.scale
            pygame.draw.line(self.screen, (210, 210, 210), (bx, y0), (bx, y0 + th), 2)
            cy = y0 + th / 2
            pygame.draw.arc(self.screen, (210, 210, 210),
                           pygame.Rect(bx - dr, cy - dr, 2 * dr, 2 * dr),
                           -math.pi / 2, math.pi / 2, 2)
        # head string: the break is played from the quarter behind this line, so
        # shade it (and brighten the line) while the player is choosing a spot
        if not self.snooker:
            hx = self.ox + self.game.head_string() * self.scale
            placing = self.await_place and getattr(self.game, "ball_in_hand_kitchen", False)
            if placing:
                shade = pygame.Surface((int(hx - x0), int(th)), pygame.SRCALPHA)
                # the desktop cloth (15, 70, 35) is much darker than the web
                # one, so a 10 % wash disappears into it; this lands at roughly
                # (48, 112, 76) — a quadrant you can see at a glance
                shade.fill((120, 200, 160, 72))
                self.screen.blit(shade, (x0, y0))
            pygame.draw.line(self.screen,
                             (160, 220, 190) if placing else (90, 130, 105),
                             (hx, y0), (hx, y0 + th), 2 if placing else 1)
        # pockets
        for px, py in w.pockets:
            sx, sy = self.w2s(px, py)
            pr = max(7, w.pocket_radius * self.scale)
            pygame.draw.circle(self.screen, (8, 8, 8), (int(sx), int(sy)), int(pr))

    def _render_balls(self):
        g = self.game
        for b in g.world.balls:
            if b.pocketed:
                continue
            sx, sy = self.w2s(b.x, b.y)
            r = max(4, b.radius * self.scale)
            fill, stripe = ball_color(b, self.snooker)
            pygame.draw.circle(self.screen, fill, (int(sx), int(sy)), int(r))
            if stripe:
                # draw a white band to mark a stripe ball (top-down look)
                pygame.draw.rect(self.screen, (235, 235, 235),
                                 pygame.Rect(sx - r, sy - r * 0.32, 2 * r, r * 0.64))
                pygame.draw.circle(self.screen, fill, (int(sx), int(sy)), int(r))
                pygame.draw.circle(self.screen, fill, (int(sx), int(sy)), int(r * 0.62))
            pygame.draw.circle(self.screen, (0, 0, 0), (int(sx), int(sy)), int(r), 1)
            # number label for 8-ball (skip cue)
            if not self.snooker and b.kind != "cue":
                lbl = self.small.render(str(b.number), True, (20, 20, 20)
                                       if b.number != 8 else (235, 235, 235))
                self.screen.blit(lbl, (sx - lbl.get_width() / 2, sy - 8))

    def _render_aim(self):
        g = self.game
        cue = g.cue()
        if cue is None:
            return
        cx, cy = self.w2s(cue.x, cue.y)
        # aim line (forward)
        ang = self.aim_angle
        end = (cx + math.cos(ang) * 320, cy + math.sin(ang) * 320)
        pygame.draw.line(self.screen, (255, 255, 255), (cx, cy), end, 2)
        # pull indicator (backwards) while charging: it shows the actual drag
        # distance along the cue, which is the only thing loading power
        if self.pulling and self.pull_len > 0:
            back = (cx - math.cos(ang) * self.pull_len,
                    cy - math.sin(ang) * self.pull_len)
            pygame.draw.line(self.screen, (255, 120, 90), (cx, cy), back, 3)
            # power bar
            bw, bh = 200, 14
            bx, by = WIN_W / 2 - bw / 2, HUD_TOP - 26
            pygame.draw.rect(self.screen, (60, 60, 60), (bx, by, bw, bh), 1)
            frac = self.power / MAX_LAUNCH
            pygame.draw.rect(self.screen, (90, 200, 120),
                             (bx, by, int(bw * frac), bh))

    def _render_hud(self):
        g = self.game
        y = 16
        if self.snooker:
            txt = (f"Snooker  |  P1(You) {g.scores[0]}  -  {g.scores[1]} P2(Bot)  "
                   f"| reds {g.reds_remaining}  | {self.difficulty}")
        else:
            grp0 = g.groups[0]
            grp1 = g.groups[1]
            def tag(p):
                if g.groups[p] is None:
                    return "open"
                n = sum(1 for n in range(1, 8) if n in g.pocketed) if g.groups[p] == "solid" \
                    else sum(1 for n in range(9, 16) if n in g.pocketed)
                return f"{g.groups[p]} {n}/7"
            txt = (f"8-Ball  |  You: {tag(0)}   Bot: {tag(1)}   {self.difficulty}")
        t = self.font.render(txt, True, (225, 230, 238))
        self.screen.blit(t, (20, y))
        # turn / message
        if self.phase == "over":
            msg = g.message
        elif self.await_place and self._human_turn():
            if getattr(g, "ball_in_hand_kitchen", False):
                msg = "Break — place the cue ball behind the head string."
            else:
                msg = "Ball in hand — click anywhere on the table to place the cue ball."
        elif self.pending_bot:
            msg = "Bot is taking its shot…"
        elif self.simulating:
            msg = "…"
        else:
            who = "Your turn" if self._human_turn() else "Bot's turn"
            msg = f"{who} — {g.message}"
        mt = self.small.render(msg, True, (200, 205, 215))
        self.screen.blit(mt, (20, HUD_TOP + 8))

    def _render_over(self):
        g = self.game
        overlay = pygame.Surface((WIN_W, WIN_H), pygame.SRCALPHA)
        overlay.fill((0, 0, 0, 170))
        self.screen.blit(overlay, (0, 0))
        t = self.big.render("Frame over", True, (255, 255, 255))
        self.screen.blit(t, (WIN_W / 2 - t.get_width() / 2, WIN_H / 2 - 60))
        m = self.font.render(g.message, True, (235, 235, 235))
        self.screen.blit(m, (WIN_W / 2 - m.get_width() / 2, WIN_H / 2 - 10))
        r = self.small.render("Press R or Esc for the menu", True, (210, 210, 210))
        self.screen.blit(r, (WIN_W / 2 - r.get_width() / 2, WIN_H / 2 + 40))


if __name__ == "__main__":
    App().run()
