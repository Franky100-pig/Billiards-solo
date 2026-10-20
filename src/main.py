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
  - Spin: ↑/↓ move the tip up (follow) or down (draw), ←/→ add english, C puts
    it back to dead centre. The cue-ball face in the corner shows the offset.
  - R: return to the menu (restart) after a frame ends.
"""

from __future__ import annotations

import math
import sys

import pygame

from physics import (Ball, SNOOKER_BAULK_X, SNOOKER_D_RADIUS,
                     q_rotate, SPIN_DEFAULT, SPIN_ZONE)
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

# Printed features, as the cosine of the half-angle of the cap they occupy.
# A solid ball prints its number on a white patch this big at each pole; a
# stripe ball has white poles of the same size and the colour band is what is
# left between them.
BAND_COS = 0.62
PATCH_COS = 0.88
NUMERAL_MIN_FACING = 0.30     # drop the numeral before it becomes a sliver
NUMERAL_FADE = 0.20
NUMERAL_MIN_SQUASH = 0.60     # never squash a glyph past 1:1.7
NUMERAL_BASE_PX = 72          # the size the glyph metrics are measured at
NUMERAL_SUPERSAMPLE = 4       # glyphs are turned at 4x and averaged down

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
        # big, bold, and rendered once per number: the ball numerals are scaled
        # down from this, so starting small would just look blurry
        self.numfont = pygame.font.SysFont("dejavusans", NUMERAL_BASE_PX, bold=True)
        self._glyphs = {}          # (number, font px) -> ink-trimmed glyph
        self._glyph_metrics = {}   # number -> (ink width, ink height) per em
        self._shades = {}          # ball px radius -> shading overlay
        self._shadows = {}         # ball px radius -> contact shadow

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
        # Tip offset on the cue ball face, in ball radii: [english, follow].
        # follow < 0 is draw, > 0 is follow; english < 0 is left, > 0 is right.
        # Arrows move it; it persists between shots the way a real cueing
        # habit does, and the default matches the web build's dial.
        self.spin = [0.0, SPIN_DEFAULT]

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
        self.game.launch(self.aim_angle, self.power, (self.spin[0], self.spin[1]))
        self.simulating = True

    def _human_turn(self):
        return self.game.current == 0

    def adjust_spin(self, key):
        """Move the tip offset on the cue-ball face.

        Only the human can do this: the bot's stroke is chosen by its search, and
        the web build's bot lets the shot default handle spin too.
        """
        step = 0.12
        if key == pygame.K_UP:
            self.spin[1] = min(1.0, self.spin[1] + step)      # follow
        elif key == pygame.K_DOWN:
            self.spin[1] = max(-1.0, self.spin[1] - step)     # draw
        elif key == pygame.K_LEFT:
            self.spin[0] = max(-1.0, self.spin[0] - step)     # left english
        elif key == pygame.K_RIGHT:
            self.spin[0] = min(1.0, self.spin[0] + step)      # right english
        elif key in (pygame.K_c, pygame.K_KP5):
            self.spin = [0.0, 0.0]                            # dead centre
        elif key == pygame.K_n:
            self.spin = [0.0, SPIN_DEFAULT]

    def spin_label(self):
        eng, fol = self.spin
        if abs(eng) < 0.06 and abs(fol) < 0.06:
            return "centre"
        if abs(eng) < 0.06:
            return f"follow {fol:+.2f}" if fol > 0 else f"draw {fol:+.2f}"
        side = "right" if eng > 0 else "left"
        return f"{side} {abs(eng):.2f}, {fol:+.2f}"

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
                    elif self.phase == "play" and not self.simulating:
                        self.adjust_spin(event.key)

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
        self.screen.blit(hint, (WIN_W / 2 - hint.get_width() / 2, 460))
        keys = self.small.render(
            "Aim with the mouse · pull back to load power · "
            "↑↓ follow/draw, ←→ english, C = centre",
            True, (150, 155, 165))
        self.screen.blit(keys, (WIN_W / 2 - keys.get_width() / 2, 484))

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
        for b in self.game.world.balls:
            if b.pocketed:
                continue
            sx, sy = self.w2s(b.x, b.y)
            self._draw_ball(b, sx, sy, max(4.0, b.radius * self.scale))

    def _draw_ball(self, b, sx, sy, r):
        """Draw one ball at a screen position and pixel radius.

        Split out from the loop so a still or a test can ask for a ball at any
        size without a whole table around it.
        """
        fill, stripe = ball_color(b, self.snooker)

        # The orientation the physics actually turned through.
        axis = q_rotate(b.q, (0.0, 0.0, 1.0))
        e1 = q_rotate(b.q, (1.0, 0.0, 0.0))
        e2 = q_rotate(b.q, (0.0, 1.0, 0.0))

        # Contact shadow first, so nothing has to be drawn under the ball.
        sh = self._shadow(r)
        self.screen.blit(sh, (sx + 0.20 * r - sh.get_width() / 2.0,
                              sy + 0.34 * r - sh.get_height() / 2.0))

        pygame.draw.circle(self.screen, fill, (int(sx), int(sy)), int(r))
        if not self.snooker:
            # A printed feature (number patch on a solid, white poles on a
            # stripe) is the visible part of a spherical cap; painting it this
            # way is what makes the printing wrap and vanish over the edge
            # instead of being a sticker dragged along.
            cos_r = BAND_COS if stripe else PATCH_COS
            white = (236, 236, 236) if stripe else (244, 244, 244)
            self._ball_cap(sx, sy, r, axis, e1, e2, cos_r, white)
            self._ball_cap(sx, sy, r,
                           (-axis[0], -axis[1], -axis[2]),
                           (-e1[0], -e1[1], -e1[2]), e2, cos_r, white)
        else:
            self._rolling_sheen(sx, sy, r, axis)

        # A flat disc reads as a sticker no matter what is printed on it: the
        # shading (highlight upper-left, terminator lower-right) is what makes
        # the printing look like it is on a sphere.
        self.screen.blit(self._shade(r), (sx - r - 1, sy - r - 1))

        pygame.draw.circle(self.screen, (0, 0, 0), (int(sx), int(sy)), int(r), 1)

        if not self.snooker and b.kind != "cue" and b.number:
            cos_r = BAND_COS if stripe else PATCH_COS
            k = (1.42 if stripe else 1.75) * (0.76 if b.number >= 10 else 1.0)
            self._numeral(b.number, sx, sy, r, axis, e1, e2, cos_r, k)
            # real balls print the number at both ends; the far one needs its
            # own right-handed frame or it comes out mirror-imaged
            self._numeral(b.number, sx, sy, r,
                          (-axis[0], -axis[1], -axis[2]),
                          (-e1[0], -e1[1], -e1[2]), e2, cos_r, k)

    def _shadow(self, r):
        """The soft contact shadow under a ball, cached per pixel radius.

        Same ellipse the web build uses (offset a fifth of a radius right and a
        third down, slightly wider than the ball) because the ball sits in the
        cloth, not on it: without it every ball looks pasted on.
        """
        key = int(round(r))
        surf = self._shadows.get(key)
        if surf is not None:
            return surf
        w = max(4, int(round(r * 2.6)))
        h = max(4, int(round(r * 1.9)))
        surf = pygame.Surface((w, h), pygame.SRCALPHA)
        # three passes, widest and faintest last: a cheap soft edge
        for grow, alpha in ((0.0, 50), (0.10, 26), (0.20, 12)):
            rw = int(round(r * 0.96 * (1.0 + grow)))
            rh = int(round(r * 0.70 * (1.0 + grow)))
            pygame.draw.ellipse(surf, (0, 0, 0, alpha),
                                pygame.Rect(w / 2 - rw, h / 2 - rh, rw * 2, rh * 2))
        self._shadows[key] = surf
        return surf

    def _shade(self, r):
        """Radial shading overlay for a ball of pixel radius r, cached.

        Per-pixel rather than a stack of translucent circles: the gradient has
        to be smooth at a 12 px radius, where banding on a stack shows up as
        rings. One surface per radius, reused by every ball of that size.
        """
        key = int(round(r))
        surf = self._shades.get(key)
        if surf is not None:
            return surf
        w = int(round(r)) * 2 + 2
        surf = pygame.Surface((w, w), pygame.SRCALPHA)
        # highlight centre, upper-left; distance 1.0 at the far side of the ball
        hx, hy = w / 2.0 - 0.35 * r, w / 2.0 - 0.35 * r
        span = 1.45 * r
        for y in range(w):
            dy = y + 0.5 - w / 2.0
            for x in range(w):
                dx = x + 0.5 - w / 2.0
                if dx * dx + dy * dy > r * r:
                    continue
                t = min(1.0, math.hypot(x + 0.5 - hx, y + 0.5 - hy) / span)
                white = 0.38 * (1.0 - t / 0.32) if t < 0.32 else 0.0
                black = 0.22 * min(1.0, max(0.0, (t - 0.45) / 0.55))
                if white > 0.0:
                    surf.set_at((x, y), (255, 255, 255, int(255 * white)))
                elif black > 0.0:
                    surf.set_at((x, y), (0, 0, 0, int(255 * black)))
        self._shades[key] = surf
        return surf

    def _ball_cap(self, sx, sy, r, axis, e1, e2, cos_r, colour):
        """Fill the visible part of one spherical cap on the ball.

        The feature is the set of surface points n.a >= c, so its rim is a
        circle on the sphere. On screen that rim is an ellipse, and the part of
        it that is in view has to be closed along the ball's silhouette -- along
        the limb, on the side the cap is on. Getting the closing direction wrong
        encloses the whole ball instead.
        """
        sin_r = math.sqrt(max(0.0, 1.0 - cos_r * cos_r))
        axy = math.hypot(axis[0], axis[1])
        if cos_r * axis[2] + sin_r * axy <= 0.0:
            return                            # nothing of this cap is in view

        tau = math.pi * 2.0
        n = 48
        # One pass over the rim: the same samples are needed to find where it
        # goes behind the ball and to walk the visible arc.
        rx = [0.0] * n
        ry = [0.0] * n
        rz = [0.0] * n
        for i in range(n):
            t = (i / n) * tau
            ct = math.cos(t) * sin_r
            st = math.sin(t) * sin_r
            rx[i] = cos_r * axis[0] + ct * e1[0] + st * e2[0]
            ry[i] = cos_r * axis[1] + ct * e1[1] + st * e2[1]
            rz[i] = cos_r * axis[2] + ct * e1[2] + st * e2[2]

        hidden = -1
        for i in range(n):
            if rz[i] < 0.0:
                hidden = i
                break

        if hidden < 0:
            pts = [(rx[i], ry[i]) for i in range(n)]
        else:
            start = -1
            for k in range(1, n + 1):
                i = (hidden + k) % n
                if rz[i] >= 0.0:
                    start = i
                    break
            if start < 0:
                return                        # wholly behind the ball
            pts = []
            for k in range(n):
                i = (start + k) % n
                if rz[i] < 0.0:
                    break
                pts.append((rx[i], ry[i]))
            if not pts:
                return

            def norm(x):
                return ((x % tau) + tau) % tau

            a0 = math.atan2(pts[0][1], pts[0][0])
            a1 = math.atan2(pts[-1][1], pts[-1][0])
            ap = math.atan2(axis[1], axis[0])
            sweep = norm(a0 - a1)
            mid = norm(a1 + sweep * 0.5)
            apart = abs(((norm(ap - mid) + math.pi) % tau) - math.pi)
            if apart > math.pi / 2:
                sweep -= tau                  # sweep the other way round
            steps = max(4, int(round(abs(sweep) / tau * n)))
            for i in range(1, steps):
                ang = a1 + sweep * (i / steps)
                pts.append((math.cos(ang), math.sin(ang)))

        if len(pts) >= 3:
            poly = [(sx + px * r, sy + py * r) for px, py in pts]
            pygame.draw.polygon(self.screen, colour, poly)

    def _rolling_sheen(self, sx, sy, r, axis):
        """Snooker balls carry no printing, so the only readable cue that they
        are turning is a highlight that rides the surface."""
        facing = axis[2]
        if facing <= 0.05:
            return
        off = 0.42 * r * math.sqrt(max(0.0, 1.0 - facing * facing))
        hx = sx + axis[0] * off
        hy = sy + axis[1] * off
        rad = max(1, int(r * (0.16 + 0.16 * facing)))
        sheen = pygame.Surface((rad * 2 + 2, rad * 2 + 2), pygame.SRCALPHA)
        pygame.draw.circle(sheen, (255, 255, 255, int(120 * facing)),
                           (rad + 1, rad + 1), rad)
        self.screen.blit(sheen, (hx - rad - 1, hy - rad - 1))

    def _numeral(self, number, sx, sy, r, axis, e1, e2, cos_r, k):
        """Print the numeral in the patch's own tangent frame.

        The glyph therefore foreshortens and turns with the surface. Two
        concessions, both measured on the web build: a patch that has gone
        edge-on is dropped rather than drawn as a sliver (a squeezed '8' reads
        as '0'), and the foreshortening is clamped so the letterform survives.
        """
        facing = axis[2]
        if facing < NUMERAL_MIN_FACING:
            return
        sin_r = math.sqrt(max(0.0, 1.0 - cos_r * cos_r))
        cx = sx + cos_r * axis[0] * r
        cy = sy + cos_r * axis[1] * r

        lu = math.hypot(e1[0], e1[1]) or 1.0
        lv = math.hypot(e2[0], e2[1]) or 1.0
        hi = max(lu, lv)
        su, sv = lu, lv
        if min(lu, lv) < hi * NUMERAL_MIN_SQUASH:
            if lu <= lv:
                su = hi * NUMERAL_MIN_SQUASH
            else:
                sv = hi * NUMERAL_MIN_SQUASH

        # The web build sets a font in ball-radius units and lets the tangent
        # frame scale it, so px/py describe the EM BOX, not the ink. Sizing the
        # ink box to px/py instead — what the first port did — drew every digit
        # about 40% oversized, which is why a number on a turned ball spilled
        # off the silhouette and over the felt.
        em = 0.95 * sin_r * k * r
        rw, rh = self._glyph_ratios(number)
        px = em * su * rw
        py = em * sv * rh
        if px < 3.0 or py < 4.0:
            return

        # Render at (close to) the final ink height so the glyph is hinted at
        # the size it is shown at. Downscaling the 72 px master straight to nine
        # pixels turned "8" into a blurry ring and "12" into "(2".
        #
        # The rotation is done at NUMERAL_SUPERSAMPLE times the final size: a
        # nine-pixel glyph cannot survive rotate(), which resamples with nearest
        # neighbour and turns a "4" into a blob at anything past twenty degrees.
        glyph = self._glyph(number, NUMERAL_SUPERSAMPLE * py / rh if rh else py)
        w = max(1, int(round(px * NUMERAL_SUPERSAMPLE)))
        h = max(1, int(round(py * NUMERAL_SUPERSAMPLE)))
        big = pygame.transform.smoothscale(glyph, (w, h))
        side = int(math.hypot(w, h)) + 2
        canvas = pygame.Surface((side, side), pygame.SRCALPHA)
        canvas.blit(big, ((side - w) // 2, (side - h) // 2))
        # pygame rotates counter-clockwise in screen coordinates, so the angle
        # is negated: local +x has to land on the projected e1 direction
        canvas = pygame.transform.rotozoom(
            canvas, -math.degrees(math.atan2(e1[1], e1[0])), 1.0)
        # divide by the supersample factor, not by the pre-rotation side: the
        # rotated canvas is bigger than the square it came from, and scaling to
        # a fixed size would shrink the glyph more the further it is turned
        out = max(2, int(round(canvas.get_width() / float(NUMERAL_SUPERSAMPLE))))
        surf = pygame.transform.smoothscale(canvas, (out, out))
        surf.set_alpha(int(255 * min(1.0, (facing - NUMERAL_MIN_FACING) / NUMERAL_FADE)))
        self.screen.blit(surf, (cx - surf.get_width() / 2.0,
                                cy - surf.get_height() / 2.0))

    def _glyph(self, number, font_px=NUMERAL_BASE_PX):
        """One number's glyph, ink-trimmed, rendered at about font_px tall.

        Cached per size: a numeral is asked for at whatever the ball's
        foreshortening works out to, which is a handful of distinct sizes.
        """
        size = max(6, int(round(font_px)))
        key = (number, size)
        surf = self._glyphs.get(key)
        if surf is None:
            font = (self.numfont if size == NUMERAL_BASE_PX
                    else pygame.font.SysFont("dejavusans", size, bold=True))
            base = font.render(str(number), True, (22, 22, 22))
            # Crop to the ink: the font box carries padding above and below the
            # digit, and scaling the box rather than the glyph is why the first
            # attempt printed numbers that were small and spilling out of the
            # patch at once.
            ink = base.get_bounding_rect()
            surf = base.subsurface(ink).copy() if ink.width and ink.height else base
            self._glyphs[key] = surf
        return surf

    def _glyph_ratios(self, number):
        """(ink width, ink height) of a number, per unit of font size."""
        got = self._glyph_metrics.get(number)
        if got is None:
            g = self._glyph(number, NUMERAL_BASE_PX)
            got = (g.get_width() / float(NUMERAL_BASE_PX),
                   g.get_height() / float(NUMERAL_BASE_PX))
            self._glyph_metrics[number] = got
        return got

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
        self._render_spin_widget()

    def _render_spin_widget(self):
        """The cue-ball face in the corner: where the tip would strike it.

        Without this the spin control is invisible and draw/follow look like
        the ball misbehaving, so it is drawn whenever the human can shoot.
        """
        if self.phase != "play" or not self._human_turn() or self.simulating:
            return
        cx = WIN_W - 48
        cy = WIN_H - HUD_BOTTOM / 2.0 + 6
        rr = 16
        pygame.draw.circle(self.screen, (238, 238, 234), (int(cx), int(cy)), rr)
        pygame.draw.line(self.screen, (196, 196, 196),
                         (cx - rr, cy), (cx + rr, cy), 1)
        pygame.draw.line(self.screen, (196, 196, 196),
                         (cx, cy - rr), (cx, cy + rr), 1)
        pygame.draw.circle(self.screen, (0, 0, 0), (int(cx), int(cy)), rr, 1)
        # the tip can only reach SPIN_ZONE of the radius before it miscues, so
        # the dot is drawn at the offset the physics will actually use
        tx = cx + self.spin[0] * SPIN_ZONE * rr
        ty = cy - self.spin[1] * SPIN_ZONE * rr
        pygame.draw.circle(self.screen, (205, 62, 62), (int(tx), int(ty)), 4)
        lbl = self.small.render(self.spin_label(), True, (200, 205, 215))
        self.screen.blit(lbl, (cx - rr - 10 - lbl.get_width(), cy - 8))

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
