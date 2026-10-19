/*
 * app.js — Canvas 2D UI for Billiards-solo (browser port of src/main.py).
 *
 * Menu -> pick 8-ball or snooker + difficulty -> play vs the built-in bot.
 * All physics/rules/AI live in the sibling modules; this file only handles
 * input, rendering, and turn flow. No network access anywhere.
 *
 * Controls:
 *   - Ball-in-hand: click/tap inside the allowed area to place the cue ball.
 *   - Aiming: move the cursor. The aim is the ray from the cue ball TO the
 *     cursor, so the cue line and the shot both point at the mouse.
 *   - Power: press anywhere to lock that direction, then drag BACK along the
 *     cue line and release. Only the backward component counts, so loading
 *     power can never change the aim (bloob's own input works this way).
 *   - English: drag the spin dial, or step the tip with the arrow keys
 *     (up/down = follow/draw, left/right = side; shift = fine step).
 *     Double-click the dial or press S to re-centre. Every stroke resets the
 *     tip to dead centre on its own, so english never carries over.
 *   - R / Esc: return to the menu.
 */

const WIN_W = 960, WIN_H = 660;
const HUD_TOP = 78, HUD_BOTTOM = 56;
const RAIL = 26;
// Real time. The simulation runs at 240 Hz (as bloob does) and we advance four
// substeps per 60 Hz frame, i.e. exactly 1/60 s of table time per frame. The
// old build stepped 16 x 1/360 = 44 ms per frame, so every shot played at
// 2.7x speed — which is why the balls looked like pinballs.
const ANIM_H = 1.0 / 240.0;
const SUBSTEPS_PER_FRAME = 4;
// Stroke speeds match the physics: a ball launched at v coasts v / DAMPING
// (~0.45) table units, so 1350 crosses the table four times and 40 is a tap.
const MAX_LAUNCH = 1350.0;
const MIN_LAUNCH = 40.0;
const MAX_DRAG = 205.0;
// Pocket drop animation (presentation only; the ball is already pocketed).
const SINK_TIME = 0.42;

// How the ball's printing is laid out on the sphere, as cosines of the polar
// angle. A striped ball is white at both ends and coloured in between, so the
// white cap covers everything poleward of BAND_COS; a solid ball carries a
// small white number patch, i.e. a cap of PATCH_COS. Both are real caps, not
// screen-space ellipses, so they wrap over the horizon as the ball turns.
const BAND_COS = 0.62;
const PATCH_COS = 0.88;

// How far a numeral may be tipped before it is dropped, and how hard its
// foreshortening is clamped. Measured against a rendered sweep of the same ball
// at every angle: past ~1:1.7 the glyph misreads ("8" becomes "0"), and past
// facing 0.30 the patch is a sliver too thin to carry a glyph at all.
const NUMERAL_MIN_FACING = 0.30;
const NUMERAL_FADE = 0.20;
const NUMERAL_MIN_SQUASH = 0.60;

// Spin dial: the tip contact point on the cue ball. Screen offsets in units of
// the ball radius; +x = right english, +y = top spin.
// Dead centre is a stun; the dial returns here after every stroke.
const SPIN_CENTER = [0.0, 0.0];
// One arrow-key press moves the tip this far (fraction of the ball radius).
// Hold shift for a fine nudge, which is what you want near the centre.
const SPIN_STEP = 0.2;
const SPIN_STEP_FINE = 0.05;

// 8-ball colours (number -> rgb); 9-15 reuse 1-7 as stripes
const EIGHT_COLORS = {
  1: [240, 205, 45], 2: [40, 70, 200], 3: [210, 45, 45], 4: [150, 45, 200],
  5: [225, 130, 35], 6: [40, 165, 70], 7: [155, 45, 45], 8: [22, 22, 22],
};
// snooker colours (number -> rgb). Standard ball set: plain gloss, no numbers.
const SNOOKER_COLORS = {
  1: [188, 32, 44],    // red
  2: [242, 200, 68],   // yellow
  3: [18, 116, 58],    // green
  4: [120, 72, 32],    // brown
  5: [18, 70, 162],    // blue
  6: [230, 122, 152],  // pink
  7: [24, 24, 24],     // black
};
const SNOOKER_CUE = [247, 243, 232];   // ivory cue ball

function ballColor(b, snooker) {
  if (b.kind === "cue") {
    return { fill: snooker ? SNOOKER_CUE : [235, 235, 235], stripe: false };
  }
  if (snooker) return { fill: SNOOKER_COLORS[b.number] || [200, 200, 200], stripe: false };
  if (b.number >= 9 && b.number <= 15) {
    return { fill: EIGHT_COLORS[b.number - 8], stripe: true };
  }
  return { fill: EIGHT_COLORS[b.number] || [200, 200, 200], stripe: false };
}

function rgb(a) { return `rgb(${a[0]},${a[1]},${a[2]})`; }

/** Mix a colour toward white (k>0) or black (k<0). */
function shade(a, k) {
  const t = Math.min(1, Math.abs(k));
  const target = k > 0 ? 255 : 0;
  return `rgb(${Math.round(a[0] + (target - a[0]) * t)},`
    + `${Math.round(a[1] + (target - a[1]) * t)},`
    + `${Math.round(a[2] + (target - a[2]) * t)})`;
}

function getPos(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  return [
    (evt.clientX - rect.left) * (WIN_W / rect.width),
    (evt.clientY - rect.top) * (WIN_H / rect.height),
  ];
}

class App {
  constructor(canvas) {
    this.canvas = canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = WIN_W * dpr;
    canvas.height = WIN_H * dpr;
    this.ctx = canvas.getContext("2d");
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.mode = "8ball";
    this.difficulty = "medium";
    this.phase = "menu";           // menu | play | over
    this.game = null;
    this.snooker = false;

    this.scale = 1.0;
    this.ox = 0.0; this.oy = 0.0;

    this.mouse = [0, 0];
    this.mouse_seen = false;      // until the pointer moves, keep the default aim
    this.pointer_touch = false;
    this.pulling = false;
    this.pull_from = null;        // where the power drag started
    this.pull_len = 0.0;          // px pulled back along the cue line
    this.simulating = false;
    this.await_place = false;
    this.pending_bot = false;
    this.bot_think_frames = 0;
    this.bot_aim = null;        // [angle, power] the bot has settled on
    this.bot_search = null;     // generator for the incremental shot search
    this.aim_angle = 0.0;
    this.power = 0.0;
    this.overBtn = null;
    // strike animation: the cue snaps through the ball, then fades
    this.strike_t = 0.0;
    this.strike_from = null;
    this.strike_angle = 0.0;
    this.strike_power = 0.0;
    // english (加塞): tip offset on the cue ball, [right, top]
    this.spin = SPIN_CENTER.slice();
    this.spin_drag = false;
    // presentation: contact sparks and pocket drops
    this.fx = [];
    this.pocket_flash = [];

    this._buildMenu();
    this._bindInput();
  }

  // -- layout ------------------------------------------------------------
  _layout(game) {
    const W = game.world.width, H = game.world.height;
    const avail_w = WIN_W - 2 * 30 - 2 * RAIL;
    const avail_h = WIN_H - HUD_TOP - HUD_BOTTOM - 2 * RAIL;
    this.scale = Math.min(avail_w / W, avail_h / H);
    const tw = W * this.scale + 2 * RAIL;
    this.ox = (WIN_W - tw) / 2 + RAIL;
    this.oy = HUD_TOP + (avail_h - H * this.scale) / 2 + RAIL;
  }
  w2s(x, y) { return [this.ox + x * this.scale, this.oy + y * this.scale]; }
  s2w(sx, sy) { return [(sx - this.ox) / this.scale, (sy - this.oy) / this.scale]; }

  // -- menu --------------------------------------------------------------
  _buildMenu() {
    const cx = WIN_W / 2;
    this.modeBtns = {
      "8ball": { x: cx - 220, y: 232, w: 200, h: 74 },
      "snooker": { x: cx + 20, y: 232, w: 200, h: 74 },
    };
    this.diffBtns = {
      easy: { x: cx - 220, y: 360, w: 130, h: 52 },
      medium: { x: cx - 75, y: 360, w: 150, h: 52 },
      hard: { x: cx + 95, y: 360, w: 130, h: 52 },
    };
  }

  startGame() {
    if (this.mode === "8ball") {
      this.game = new EightBallGame(0);
      this.snooker = false;
    } else {
      this.game = new SnookerGame(0);
      this.snooker = true;
    }
    this._layout(this.game);
    this.phase = "play";
    this.simulating = false;
    this.pulling = false;
    this.pull_from = null;
    this.pull_len = 0.0;
    this.pending_bot = false;
    this.bot_think_frames = 0;
    this.bot_aim = null;
    this.bot_search = null;
    this.power = 0.0;
    this.aim_angle = 0.0;         // the break aims straight up the table
    this.overBtn = null;
    this.strike_t = 0.0;
    this.strike_from = null;
    this.spin = SPIN_CENTER.slice();
    this.spin_drag = false;
    this.fx = [];
    this.pocket_flash = [];
    for (const b of this.game.world.balls) b._sink = null;
    this.await_place = !!this.game.ball_in_hand;
  }

  // -- input -------------------------------------------------------------
  _bindInput() {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2) {          // right click: put a loaded cue back down
        e.preventDefault();
        this.pulling = false;
        this.pull_from = null;
        this.pull_len = 0.0;
        this.power = 0.0;
        return;
      }
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      const pos = getPos(this.canvas, e);
      this.mouse = pos;
      this.mouse_seen = true;
      this.pointer_touch = (e.pointerType === "touch");
      this.onClick(pos);
    });
    window.addEventListener("pointermove", (e) => {
      this.mouse = getPos(this.canvas, e);
      this.mouse_seen = true;
      this.pointer_touch = (e.pointerType === "touch");
      if (this.spin_drag) { this._setSpinFrom(this.mouse); return; }
      this._aimAt(this.mouse);
    });
    window.addEventListener("pointerup", (e) => {
      if (this.spin_drag) { this.spin_drag = false; return; }
      this.onRelease(getPos(this.canvas, e));
    });
    this.canvas.addEventListener("dblclick", (e) => {
      const pos = getPos(this.canvas, e);
      if (this.phase === "play" && this._inDial(pos)) {
        this.spin = SPIN_CENTER.slice();
      }
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "r" || e.key === "R" || e.key === "Escape") {
        this.phase = "menu";
        this.pulling = false;
        this.simulating = false;
        this.pending_bot = false;
        this.bot_search = null;
        this.spin_drag = false;
        return;
      }
      if (e.key === "s" || e.key === "S") {
        // re-centre the english dial (no draw, no follow, no side)
        this.spin = SPIN_CENTER.slice();
        return;
      }
      // Arrow keys walk the tip around the cue ball: up/down = follow/draw,
      // left/right = side spin. Holding a key auto-repeats, so the tip keeps
      // travelling; shift gives a fine step for small adjustments.
      const arrows = {
        ArrowUp: [0, 1], ArrowDown: [0, -1],
        ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      };
      const d = arrows[e.key];
      if (d === undefined) return;
      e.preventDefault();          // otherwise the page scrolls
      if (this.phase !== "play" || !this._humanTurn() || this.simulating) return;
      this._nudgeSpin(d[0], d[1], e.shiftKey);
    });
  }

  // -- spin dial ---------------------------------------------------------
  _dialCenter() { return [WIN_W - 54, 40]; }
  _dialRadius() { return 25; }

  _inDial(pos) {
    const [cx, cy] = this._dialCenter();
    const R = this._dialRadius();
    return Math.hypot(pos[0] - cx, pos[1] - cy) <= R + 6;
  }

  _setSpinFrom(pos) {
    const [cx, cy] = this._dialCenter();
    const R = this._dialRadius();
    let sx = (pos[0] - cx) / (R * 0.80);
    let sy = -(pos[1] - cy) / (R * 0.80);
    const m = Math.hypot(sx, sy);
    if (m > 1.0) { sx /= m; sy /= m; }
    this.spin = [sx, sy];
  }

  /**
   * Move the tip by one step on a given axis (arrow keys). The tip cannot
   * leave the ball, so the offset is clamped to the unit disc: an overshoot
   * is projected back onto the rim instead of being dropped, which is why
   * holding "up" parks the tip at 12 o'clock rather than flickering.
   */
  _nudgeSpin(dx, dy, fine = false) {
    const step = fine ? SPIN_STEP_FINE : SPIN_STEP;
    let sx = this.spin[0] + dx * step;
    let sy = this.spin[1] + dy * step;
    const m = Math.hypot(sx, sy);
    if (m > 1.0) { sx /= m; sy /= m; }
    // snap the last hair to exact zero / exact rim so the dot sits cleanly
    if (Math.abs(sx) < 1e-9) sx = 0;
    if (Math.abs(sy) < 1e-9) sy = 0;
    this.spin = [sx, sy];
  }

  _hit(rect, pos) {
    return pos[0] >= rect.x && pos[0] <= rect.x + rect.w &&
           pos[1] >= rect.y && pos[1] <= rect.y + rect.h;
  }

  onClick(pos) {
    if (this.phase === "menu") {
      let startMode = null;
      for (const [m, r] of Object.entries(this.modeBtns)) {
        if (this._hit(r, pos)) { this.mode = m; startMode = m; }
      }
      for (const [d, r] of Object.entries(this.diffBtns)) {
        if (this._hit(r, pos)) { this.difficulty = d; }
      }
      if (startMode) this.startGame();
      return;
    }
    if (this.phase === "over") {
      if (this.overBtn && this._hit(this.overBtn, pos)) this.phase = "menu";
      return;
    }
    // play
    if (this._humanTurn() && this._inDial(pos)) {
      this.spin_drag = true;
      this._setSpinFrom(pos);
      return;
    }
    if (this.await_place) {
      const [wx, wy] = this.s2w(pos[0], pos[1]);
      if (this.game.place_cue(wx, wy)) {
        this.await_place = false;
        this.game.message = "Cue placed — aim and shoot.";
      } else {
        // Say why: "it did nothing" is the worst possible answer to a click.
        const why = this.game.place_refusal ? this.game.place_refusal(wx, wy) : null;
        if (why) this.game.message = why;
      }
      return;
    }
    if (!this.simulating && this._humanTurn()) this._beginPull(pos);
  }

  /**
   * Aim straight at the cursor: the ray runs from the cue ball TO the mouse, so
   * the line, the ghost ball and the cue all point where you are looking. (The
   * old build aimed opposite the pointer and only while dragging, which is why
   * the direction felt inverted and could not be set before loading power.)
   */
  _aimAt(pos) {
    if (this.phase !== "play" || this.pulling || this.simulating) return;
    if (!this.mouse_seen || !this._humanTurn()) return;
    const cue = this.game.cue();
    if (cue === null) return;
    const [cx, cy] = this.w2s(cue.x, cue.y);
    const dx = pos[0] - cx, dy = pos[1] - cy;
    if (Math.hypot(dx, dy) < 6.0) return;   // ignore jitter sitting on the ball
    this.aim_angle = Math.atan2(dy, dx);
  }

  /**
   * Press locks the direction and starts loading the cue. Touch has no hover,
   * so there the press point doubles as the aim (ball -> finger), which is the
   * only way a finger can point at anything.
   */
  _beginPull(pos) {
    const cue = this.game.cue();
    if (cue === null) return;
    if (this.pointer_touch) {
      const [cx, cy] = this.w2s(cue.x, cue.y);
      const dx = pos[0] - cx, dy = pos[1] - cy;
      if (Math.hypot(dx, dy) > 6.0) this.aim_angle = Math.atan2(dy, dx);
    }
    this.pulling = true;
    this.pull_from = [pos[0], pos[1]];
    this.pull_len = 0.0;
    this.power = 0.0;
  }

  onRelease(pos) {
    if (this.phase !== "play" || !this.pulling) return;
    this.pulling = false;
    if (this.power < MIN_LAUNCH * 0.6) { this.power = 0.0; this.pull_from = null; return; }
    this.pull_from = null;
    if (this.game.cue() === null) return;
    this._strike(this.aim_angle, this.power, this.spin);
    this.power = 0.0;
  }

  /** Fire the cue ball and start the strike animation. */
  _strike(angle, power, spin = null) {
    const cue = this.game.cue();
    this.strike_from = cue ? [cue.x, cue.y] : null;
    this.strike_angle = angle;
    this.strike_power = power;
    this.strike_spin = spin ? [spin[0], spin[1]] : [0.0, 0.0];
    this.strike_t = 1.0;
    this.game.launch(angle, power, spin);
    // Every stroke consumes its english: the next shot starts from dead centre,
    // so a draw you dialled in for one shot can never leak into the next. The
    // strike animation keeps its own copy in strike_spin, so the cue is still
    // drawn off-centre while the ball is travelling.
    this.spin = SPIN_CENTER.slice();
    this.simulating = true;
    this.pending_bot = false;
    this.bot_aim = null;
    this.bot_search = null;
    this.await_place = false;
  }

  _humanTurn() { return this.game.current === 0; }

  /** True while the break is waiting for a cue-ball placement behind the line. */
  _inKitchenPlacement() {
    return !!(this.game && this.await_place && this.game.ball_in_hand_kitchen);
  }

  /**
   * Power only. The direction was settled when the press locked it, so this
   * measures how far the pointer has been dragged BACK along the cue line and
   * nothing else: sideways wobble changes neither the aim nor the strength,
   * and a forward drag never fires. Same rule as bloob's `power(start,end,angle)`,
   * which discards any pull more than 90 deg off the cue.
   */
  _updatePull() {
    if (!this.pulling || !this.pull_from) return;
    const cue = this.game.cue();
    if (cue === null) { this.power = 0.0; return; }
    const ux = Math.cos(this.aim_angle), uy = Math.sin(this.aim_angle);
    const dx = this.mouse[0] - this.pull_from[0];
    const dy = this.mouse[1] - this.pull_from[1];
    this.pull_len = Math.max(0.0, Math.min(MAX_DRAG, -(dx * ux + dy * uy)));
    if (this.pull_len < 2.0) { this.power = 0.0; return; }
    // gamma curve: the first part of the pull stays gentle so soft touches
    // are easy to hit, and only the last stretch reaches a full stroke
    const frac = this.pull_len / MAX_DRAG;
    this.power = MIN_LAUNCH + Math.pow(frac, 1.35) * (MAX_LAUNCH - MIN_LAUNCH);
  }

  // -- turn flow ---------------------------------------------------------
  afterResolve() {
    const g = this.game;
    this.bot_search = null;
    if (g.winner !== null) { this.phase = "over"; this.overBtn = null; return; }
    this.await_place = !!g.ball_in_hand;
    if (g.current === 1) {
      this.pending_bot = true;
      this.bot_think_frames = 0;
      this.bot_aim = null;
    } else {
      this.pending_bot = false;
    }
  }

  doBotTurn(pre = null) {
    const g = this.game;
    if (!pre) {
      if (g.ball_in_hand) g.auto_place_cue();
      pre = chooseShot(g, this.difficulty);
    }
    this._strike(pre[0], pre[1]);
  }
  // -- loop --------------------------------------------------------------
  start() {
    let last = performance.now(), acc = 0;
    const FRAME = 1000 / 60;
    const step = (now) => {
      let dt = now - last; last = now;
      if (dt > 100) dt = 100;
      acc += dt;
      let guard = 0;
      while (acc >= FRAME && guard++ < 5) { this.tick(); acc -= FRAME; }
      this.render();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _now() {
    return (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
  }

  tick() {
    if (this.phase !== "play") return;
    // keep the aim on the cursor even when the cue ball itself moved (a shot
    // resolved, the cue was replaced) — the pointer has not had to move
    this._aimAt(this.mouse);
    this._updatePull();
    this._updateEffects();
    if (this.strike_t > 0) this.strike_t = Math.max(0.0, this.strike_t - 0.26);
    if (this.simulating) {
      for (let i = 0; i < SUBSTEPS_PER_FRAME; i++) {
        this.game.world.advance(ANIM_H);
        if (this.game.world.allResting()) break;
      }
      if (this.game.world.allResting()) {
        this.game.resolve_shot();
        this.simulating = false;
        this.afterResolve();
      }
    } else if (this.pending_bot) {
      this.bot_think_frames++;
      if (this.bot_search === null && this.bot_aim === null) {
        if (this.game.ball_in_hand) this.game.auto_place_cue();
        this.bot_search = shotSearch(this.game, this.difficulty);
      }
      // Spend a slice of every frame on the search instead of blocking the
      // animation for a second: the bot visibly lines up while it thinks.
      if (this.bot_search !== null) {
        const t0 = this._now();
        while (this._now() - t0 < 7.0) {
          const r = this.bot_search.next();
          if (r.done) {
            this.bot_aim = r.value;
            this.bot_search = null;
            break;
          }
        }
      }
      if (this.bot_aim && this.bot_think_frames > 26) this.doBotTurn(this.bot_aim);
    }
  }

  /**
   * Presentation-only effects: contact sparks from the solver, and the ball
   * dropping into a pocket. Physics hands us `world.fx` once per shot step;
   * the drop is tracked here so the simulation stays free of animation state.
   */
  _updateEffects() {
    const w = this.game.world;
    if (w.fx && w.fx.length) {
      for (const e of w.fx) {
        if (this.fx.length >= 40) break;
        this.fx.push({ x: e.x, y: e.y, str: e.str, kind: e.kind, t: 0.0 });
      }
      w.fx.length = 0;
    }
    const dt = 1.0 / 60.0;
    for (const e of this.fx) e.t += dt;
    if (this.fx.length) this.fx = this.fx.filter(e => e.t < 0.34);
    for (const p of this.pocket_flash) p.t += dt;
    if (this.pocket_flash.length) {
      this.pocket_flash = this.pocket_flash.filter(p => p.t < 0.6);
    }

    for (const b of w.balls) {
      if (b.pocketed) {
        if (!b._sink) {
          let best = [b.x, b.y], bd = Infinity;
          for (const p of w.pockets) {
            const d = Math.hypot(b.x - p[0], b.y - p[1]);
            if (d < bd) { bd = d; best = p; }
          }
          b._sink = { from: [b.x, b.y], to: [best[0], best[1]], t: 0.0 };
          this.pocket_flash.push({ x: best[0], y: best[1], t: 0.0 });
        } else {
          b._sink.t += dt;
        }
      } else if (b._sink) {
        b._sink = null;
      }
    }
  }

  // -- rendering ---------------------------------------------------------
  render() {
    const ctx = this.ctx;
    if (this.phase === "menu") {
      this._renderMenu();
    } else {
      ctx.fillStyle = "#1c1e22";
      ctx.fillRect(0, 0, WIN_W, WIN_H);
      this._renderTable();
      this._renderBalls();
      if (this.phase === "play" && this._humanTurn() && !this.simulating && !this.await_place) {
        this._renderAim();
      } else if (this.simulating && this.strike_t > 0 && this.strike_from) {
        this._renderStrike();
      } else if (this.phase === "play" && this.pending_bot && this.bot_aim
                 && this.bot_think_frames > 8) {
        // let the player watch the bot line up its shot
        const cue = this.game.cue();
        if (cue) {
          const [bx, by] = this.w2s(cue.x, cue.y);
          const r = Math.max(4, cue.radius * this.scale);
          this._renderCue(bx, by, this.bot_aim[0], r * 2.0, 0.9);
        }
      }
      this._drawEffects();
      this._renderHud();
      if (this.phase === "over") this._renderOver();
    }
    if (this.phase === "play" && this.pulling && this.power > 0) this._renderPowerBar();

    const aiming = this.phase === "play" && this._humanTurn() &&
      !this.simulating && !this.await_place;
    this.canvas.classList.toggle("aiming", aiming);
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _text(str, x, y, size, color, align = "left", weight = 400) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(str, x, y);
  }

  _button(rect, label, selected, selColor) {
    const ctx = this.ctx;
    ctx.fillStyle = selected ? selColor : "#3c4048";
    this._roundRect(rect.x, rect.y, rect.w, rect.h, 9);
    ctx.fill();
    ctx.strokeStyle = selected ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.10)";
    ctx.lineWidth = 1.5;
    this._roundRect(rect.x, rect.y, rect.w, rect.h, 9);
    ctx.stroke();
    this._text(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 7,
      rect.h > 60 ? 22 : 17, "#f1f3f6", "center", 600);
  }

  _renderMenu() {
    const ctx = this.ctx;
    ctx.fillStyle = "#1c1e22";
    ctx.fillRect(0, 0, WIN_W, WIN_H);

    // soft top glow
    const g = ctx.createRadialGradient(WIN_W / 2, 40, 20, WIN_W / 2, 40, 420);
    g.addColorStop(0, "rgba(80,140,100,.16)");
    g.addColorStop(1, "rgba(80,140,100,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIN_W, 360);

    this._text("Billiards-solo", WIN_W / 2, 122, 42, "#eef1f5", "center", 700);
    this._text("Offline 8-ball & snooker vs a built-in bot — pure Canvas, zero dependencies",
      WIN_W / 2, 158, 15, "#a3a9b4", "center", 400);

    for (const [m, r] of Object.entries(this.modeBtns)) {
      this._button(r, m === "8ball" ? "8-BALL" : "SNOOKER", this.mode === m, "#3f7d57");
    }

    this._text("Difficulty", WIN_W / 2 - 220, 338, 14, "#aeb4bf", "left", 600);
    for (const [d, r] of Object.entries(this.diffBtns)) {
      this._button(r, d, this.difficulty === d, "#4a629c");
    }

    this._text("Click a game mode to start", WIN_W / 2, 462, 15, "#98a0ac", "center", 400);
    this._text("R / Esc returns to this menu", WIN_W / 2, 486, 13, "#7c838f", "center", 400);
    this._text("Reimplemented from scratch. No bloob source or art is used.",
      WIN_W / 2, WIN_H - 26, 12, "#6d7480", "center", 400);
  }

  /**
   * Shared table body: mahogany rail, bevelled edge, brass sight markers,
   * rubber cushion band, baize with a sheen and the inner shadow where the
   * cloth meets the cushions. Both modes are built on this so the two tables
   * belong to the same set of furniture.
   */
  _drawTableBody(rail, cush) {
    const ctx = this.ctx;
    const w = this.game.world;
    const [x0, y0] = this.w2s(0, 0);
    const tw = w.width * this.scale, th = w.height * this.scale;

    // --- mahogany body ---------------------------------------------------
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 13;
    const body = ctx.createLinearGradient(x0 - rail, y0 - rail,
      x0 + tw + rail, y0 + th + rail);
    body.addColorStop(0.00, "#4a2a18");
    body.addColorStop(0.22, "#7b482a");
    body.addColorStop(0.52, "#63381f");
    body.addColorStop(0.78, "#7d4a2b");
    body.addColorStop(1.00, "#3f2113");
    ctx.fillStyle = body;
    this._roundRect(x0 - rail, y0 - rail, tw + 2 * rail, th + 2 * rail, 16);
    ctx.fill();
    ctx.restore();

    // bevelled top edge of the wood
    ctx.strokeStyle = "rgba(255,226,190,.16)";
    ctx.lineWidth = 1.5;
    this._roundRect(x0 - rail + 1.5, y0 - rail + 1.5,
      tw + 2 * rail - 3, th + 2 * rail - 3, 15);
    ctx.stroke();

    // brass sight markers along the rails
    ctx.fillStyle = "rgba(214,178,110,.55)";
    for (const f of [0.25, 0.5, 0.75]) {
      const sx = x0 + tw * f;
      for (const yy of [y0 - rail / 2, y0 + th + rail / 2]) {
        ctx.beginPath(); ctx.arc(sx, yy, 1.6, 0, Math.PI * 2); ctx.fill();
      }
    }

    // --- cushion band ----------------------------------------------------
    ctx.fillStyle = "#24955c";
    ctx.fillRect(x0 - cush, y0 - cush, tw + 2 * cush, th + 2 * cush);
    ctx.strokeStyle = "rgba(255,255,255,.10)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 - cush + 1, y0 - cush + 1,
      tw + 2 * cush - 2, th + 2 * cush - 2);

    // --- cloth -----------------------------------------------------------
    const cloth = ctx.createLinearGradient(x0, y0, x0 + tw * 0.4, y0 + th);
    cloth.addColorStop(0, "#127a48");
    cloth.addColorStop(0.55, "#0e6a3e");
    cloth.addColorStop(1, "#0a5933");
    ctx.fillStyle = cloth;
    ctx.fillRect(x0, y0, tw, th);

    // cushion nose (where the rubber meets the cloth)
    ctx.strokeStyle = "rgba(0,0,0,.42)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, tw, th);

    // inner shadow where the cloth meets the cushions
    const sh = ctx.createLinearGradient(0, y0, 0, y0 + 12);
    sh.addColorStop(0, "rgba(0,0,0,.30)");
    sh.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sh;
    ctx.fillRect(x0, y0, tw, 12);
    ctx.save();
    ctx.translate(0, y0 + th);
    ctx.scale(1, -1);
    ctx.fillStyle = sh;
    ctx.fillRect(x0, 0, tw, 12);
    ctx.restore();
  }

  _renderTable() {
    const ctx = this.ctx;
    const w = this.game.world;
    const [x0, y0] = this.w2s(0, 0);
    const tw = w.width * this.scale, th = w.height * this.scale;

    if (this.snooker) {
      this._drawTableBody(RAIL + 8, Math.max(10, 17 * this.scale));
    } else {
      this._drawTableBody(RAIL - 2, Math.max(9, 14 * this.scale));
    }

    if (this.snooker) {
      // --- markings: baulk line, D, spots --------------------------------
      const bx = this.ox + w.width * SNOOKER_BAULK_X * this.scale;
      const dr = w.height * SNOOKER_D_RADIUS * this.scale;
      const cys = y0 + th / 2;
      ctx.strokeStyle = "rgba(238,240,228,.40)";
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(bx, y0); ctx.lineTo(bx, y0 + th); ctx.stroke();
      ctx.beginPath();
      ctx.arc(bx, cys, dr, Math.PI / 2, Math.PI * 1.5);   // bulge toward baulk
      ctx.stroke();

      const spots = snookerSpots(w.width, w.height);
      ctx.fillStyle = "rgba(238,240,228,.50)";
      for (const key of Object.keys(spots.colors)) {
        const [wx, wy] = spots.colors[key];
        const [sx, sy] = this.w2s(wx, wy);
        ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill();
      }

      // --- pockets: corners bigger than the middles ----------------------
      const cr = w.capture_radius * this.scale;
      for (let i = 0; i < w.pockets.length; i++) {
        const [sx, sy] = this.w2s(w.pockets[i][0], w.pockets[i][1]);
        const middle = (i === 1 || i === 4);
        const pr = (middle ? 0.80 : 1.05) * cr;
        const pg = ctx.createRadialGradient(sx, sy, pr * 0.15, sx, sy, pr);
        pg.addColorStop(0, "#000000");
        pg.addColorStop(0.72, "#050d08");
        pg.addColorStop(1, "#123024");
        ctx.fillStyle = pg;
        ctx.beginPath(); ctx.arc(sx, sy, pr, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(28,16,8,.85)";
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(sx, sy, pr + 1.2, 0, Math.PI * 2); ctx.stroke();
      }
      return;
    }

    // --- 8-ball pockets: six leather-lined jaws, corners a touch wider ---
    // The break may only be played out of the kitchen, so shade it while the
    // player is choosing a spot: the rule becomes something you can see rather
    // than something you discover by clicking and being refused.
    const placing_break = this._inKitchenPlacement();
    const hx = this.ox + this.game.head_string() * this.scale;
    if (placing_break) {
      ctx.fillStyle = "rgba(175,255,215,.15)";
      ctx.fillRect(x0, y0, hx - x0, th);
    }
    const cr = w.capture_radius * this.scale;
    for (let i = 0; i < w.pockets.length; i++) {
      const [sx, sy] = this.w2s(w.pockets[i][0], w.pockets[i][1]);
      const middle = (i === 1 || i === 4);
      const pr = (middle ? 0.86 : 1.10) * cr;
      const pg = ctx.createRadialGradient(sx, sy, pr * 0.15, sx, sy, pr);
      pg.addColorStop(0, "#000000");
      pg.addColorStop(0.70, "#060606");
      pg.addColorStop(1, "#1a2b1f");
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(sx, sy, pr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(26,14,6,.85)";
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(sx, sy, pr + 1.2, 0, Math.PI * 2); ctx.stroke();
    }

    // head string, as on a real pool table
    ctx.strokeStyle = placing_break ? "rgba(160,220,190,.60)" : "rgba(238,240,228,.20)";
    ctx.lineWidth = placing_break ? 1.8 : 1.4;
    ctx.beginPath(); ctx.moveTo(hx, y0); ctx.lineTo(hx, y0 + th); ctx.stroke();
    const fsx = this.ox + w.width * 0.75 * this.scale;
    ctx.fillStyle = "rgba(238,240,228,.42)";
    ctx.beginPath(); ctx.arc(fsx, y0 + th / 2, 2.2, 0, Math.PI * 2); ctx.fill();
  }

  _drawBall(b, over) {
    const ctx = this.ctx;
    let sx, sy, r;
    if (over) {
      sx = over.sx; sy = over.sy; r = Math.max(2, over.r);
    } else {
      const p = this.w2s(b.x, b.y);
      sx = p[0]; sy = p[1];
      r = Math.max(4, b.radius * this.scale);
    }
    const info = ballColor(b, this.snooker);
    const fill = rgb(info.fill);

    // --- motion streak: a tapered comet tail behind the ball ------------
    const sp = b.speed();
    if (sp > 90) {
      const len = Math.min(r * 4.6, sp * 0.040) * (r / 11 + 0.55);
      const ux = b.vx / sp, uy = b.vy / sp;
      const pxx = -uy, pyy = ux;                 // perpendicular
      const a = Math.min(0.32, (sp - 90) / 1500);
      // start the tail at the ball's far edge so it never covers the ball
      const nx = sx - ux * r * 0.55, ny = sy - uy * r * 0.55;
      const tx = sx - ux * (r * 0.55 + len), ty = sy - uy * (r * 0.55 + len);
      const w0 = r * 0.86;                       // half-width at the ball
      const tg = ctx.createLinearGradient(nx, ny, tx, ty);
      tg.addColorStop(0.00, `rgba(${info.fill[0]},${info.fill[1]},${info.fill[2]},${a})`);
      tg.addColorStop(0.45, `rgba(${info.fill[0]},${info.fill[1]},${info.fill[2]},${a * 0.45})`);
      tg.addColorStop(1.00, `rgba(${info.fill[0]},${info.fill[1]},${info.fill[2]},0)`);
      ctx.save();
      ctx.fillStyle = tg;
      ctx.beginPath();
      ctx.moveTo(nx + pxx * w0, ny + pyy * w0);
      ctx.lineTo(tx, ty);
      ctx.lineTo(nx - pxx * w0, ny - pyy * w0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // contact shadow on the cloth
    ctx.beginPath();
    ctx.ellipse(sx + r * 0.20, sy + r * 0.34, r * 0.96, r * 0.70, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,.30)";
    ctx.fill();

    // snooker balls: plain glossy spheres, no numbers
    if (this.snooker) {
      const g = ctx.createRadialGradient(
        sx - r * 0.40, sy - r * 0.44, r * 0.10,
        sx + r * 0.12, sy + r * 0.26, r * 1.18);
      g.addColorStop(0.00, shade(info.fill, 0.62));
      g.addColorStop(0.42, fill);
      g.addColorStop(1.00, shade(info.fill, -0.46));
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = g; ctx.fill();

      // rolling read: a fat, faint sheen that sweeps around as it turns. The
      // material point that started at the pole is a real point on the ball,
      // so the sheen tracks the actual rotation instead of a fake phase.
      const up = _qRotate(b.q, [0.0, 0.0, 1.0]);
      const ca = up[2];
      if (ca > 0.05) {
        ctx.save();
        ctx.beginPath(); ctx.arc(sx, sy, r * 0.995, 0, Math.PI * 2); ctx.clip();
        ctx.globalAlpha = 0.09 * ca;
        ctx.fillStyle = "#ffffff";
        const sa = Math.hypot(up[0], up[1]);
        ctx.beginPath();
        ctx.ellipse(sx + up[0] * r * 0.62, sy + up[1] * r * 0.62,
          r * 0.46, r * 0.30, Math.atan2(up[1], up[0]), 0, Math.PI * 2);
        void sa;
        ctx.fill();
        ctx.restore();
      }

      // specular glint
      ctx.beginPath();
      ctx.ellipse(sx - r * 0.33, sy - r * 0.37, r * 0.26, r * 0.19,
        -Math.PI / 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,.62)";
      ctx.fill();

      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,.38)";
      ctx.lineWidth = Math.max(0.7, r * 0.07);
      ctx.stroke();
      return;
    }

    // --- a printed sphere, not a sprite ----------------------------------
    // The ball's printing is a fixed pattern on the surface, so it is painted
    // from the ball's real orientation: `axis` is the pole the pattern is
    // built around, and e1/e2 are the material axes the numeral is printed
    // along. Every visible feature is the projection of a circle on the
    // sphere, which is why the stripe wraps, the number squashes, and both of
    // them disappear over the horizon exactly when they should.
    const axis = _qRotate(b.q, [0.0, 0.0, 1.0]);
    const e1 = _qRotate(b.q, [1.0, 0.0, 0.0]);
    const e2 = _qRotate(b.q, [0.0, 1.0, 0.0]);

    // base: the whole ball is the ball's colour, then the white ends are cut
    // out of it. A striped ball is a white ball with a coloured band, which is
    // the same thing as a coloured ball with two white pole caps.
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    // the far pole needs its OWN tangent frame: a real ball has the number
    // printed twice, each upright for the side you are looking at, which in
    // material coordinates means the second print is mirrored. Using the
    // right-handed frame of that pole does exactly that — without it the far
    // number comes out mirror-imaged ("Ɛ" for a 3).
    const axis2 = [-axis[0], -axis[1], -axis[2]];
    const e1b = [-e1[0], -e1[1], -e1[2]];

    if (info.stripe) {
      this._ballCap(sx, sy, r, axis, e1, e2, BAND_COS, "#ececec");
      this._ballCap(sx, sy, r, axis2, e1b, e2, BAND_COS, "#ececec");
    } else {
      this._ballCap(sx, sy, r, axis, e1, e2, PATCH_COS, "#f4f4f4");
      this._ballCap(sx, sy, r, axis2, e1b, e2, PATCH_COS, "#f4f4f4");
    }

    // highlight + shading
    const g = ctx.createRadialGradient(sx - r * 0.35, sy - r * 0.35, r * 0.08,
      sx, sy, r * 1.1);
    g.addColorStop(0, "rgba(255,255,255,.38)");
    g.addColorStop(0.32, "rgba(255,255,255,.05)");
    g.addColorStop(1, "rgba(0,0,0,.22)");
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();

    // outline
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.lineWidth = 1; ctx.stroke();


    // the numerals ride on top of the shading so they stay readable. A solid
    // ball's white circle is smaller than a striped ball's white end, so its
    // digit is set a little larger relative to that circle: on a 26 px ball the
    // literal size would be about five pixels and unreadable.
    if (b.kind !== "cue" && b.number) {
      const cosR = info.stripe ? BAND_COS : PATCH_COS;
      // two-digit numbers are half again as wide, so they are set smaller to
      // stay inside the white patch instead of spilling onto the colour
      const k = (info.stripe ? 1.42 : 1.75) * (b.number >= 10 ? 0.76 : 1.0);
      this._ballNumber(sx, sy, r, axis, e1, e2, cosR, b.number, k);
      this._ballNumber(sx, sy, r, axis2, e1b, e2, cosR, b.number, k);
    }
  }

  /**
   * Paint one circular patch of the ball's printed surface, given the patch's
   * outward normal `axis`, its angular radius (as a cosine) and the material
   * axes e1/e2 that span its rim.
   *
   * The rim is a real 3D circle, so its outline on screen is the projection of
   * that circle — and because the camera only sees the near hemisphere, any
   * part of the rim that has tipped behind the ball is projected onto the
   * silhouette, which is exactly where the patch visually ends. Clipping an
   * ellipse instead would make the patch slide off the edge of a flat disc.
   */
  _ballCap(sx, sy, r, axis, e1, e2, cosR, colour) {
    const ctx = this.ctx;
    const sinR = Math.sqrt(Math.max(0.0, 1.0 - cosR * cosR));
    const axy = Math.hypot(axis[0], axis[1]);
    // nothing of this cap reaches the near hemisphere
    if (cosR * axis[2] + sinR * axy <= 0.0) return;

    const TAU = Math.PI * 2;
    const N = 48;
    // One pass over the rim: the same samples are needed three times (to find
    // where it goes behind the ball, to walk the visible arc, and to place the
    // limb), so they are computed once. Sixteen balls at 60 Hz is otherwise a
    // few million trig calls a second for nothing.
    const rx = new Array(N), ry = new Array(N), rz = new Array(N);
    for (let i = 0; i < N; i++) {
      const t = (i / N) * TAU;
      const ct = Math.cos(t) * sinR, st = Math.sin(t) * sinR;
      rx[i] = cosR * axis[0] + ct * e1[0] + st * e2[0];
      ry[i] = cosR * axis[1] + ct * e1[1] + st * e2[1];
      rz[i] = cosR * axis[2] + ct * e1[2] + st * e2[2];
    }

    const pts = [];
    let hidden = -1;
    for (let i = 0; i < N; i++) {
      if (rz[i] < 0.0) { hidden = i; break; }
    }
    if (hidden < 0) {
      // the whole rim is in view, so the cap is just the rim's own outline
      for (let i = 0; i < N; i++) pts.push([rx[i], ry[i]]);
    } else {
      // the visible rim is one contiguous arc: walk from the first visible
      // point until the rim dips behind the ball again
      let start = -1;
      for (let k = 1; k <= N; k++) {
        const i = (hidden + k) % N;
        if (rz[i] >= 0.0) { start = i; break; }
      }
      if (start < 0) return;                       // wholly behind the ball
      for (let k = 0; k < N; k++) {
        const i = (start + k) % N;
        if (rz[i] < 0.0) break;
        pts.push([rx[i], ry[i]]);
      }
      // close the region along the silhouette, the way round that passes the
      // side the cap is on (the other way would enclose the whole ball)
      const first = pts[0], last = pts[pts.length - 1];
      const a0 = Math.atan2(first[1], first[0]);
      const a1 = Math.atan2(last[1], last[0]);
      const ap = Math.atan2(axis[1], axis[0]);
      const norm = (x) => ((x % TAU) + TAU) % TAU;
      let sweep = norm(a0 - a1);
      const mid = norm(a1 + sweep * 0.5);
      const apart = Math.abs(((norm(ap - mid) + Math.PI) % TAU) - Math.PI);
      if (apart > Math.PI / 2) sweep -= TAU;         // sweep the other way
      const steps = Math.max(4, Math.round(Math.abs(sweep) / TAU * N));
      for (let i = 1; i < steps; i++) {
        const ang = a1 + sweep * (i / steps);
        pts.push([Math.cos(ang), Math.sin(ang)]);
      }
    }

    ctx.save();
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.clip();
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = sx + pts[i][0] * r, py = sy + pts[i][1] * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.restore();
  }

  /**
   * Print the numeral on a pole patch, in the patch's own tangent frame, so it
   * foreshortens and turns with the surface instead of staying screen-aligned;
   * it fades out as the patch goes edge-on, where a real number would be
   * invisible too.
   *
   * Two concessions to the size of the ball, both measured rather than guessed:
   *
   *  - Below NUMERAL_MIN_FACING the print is a sliver a pixel or two wide, and a
   *    glyph foreshortened that far stops being a digit and starts being a
   *    smudge that misreads as a different one ("8" as "0", "12" as "(2"). No
   *    numeral is better than a wrong one, so it is dropped. Colour and stripe
   *    already identify every ball uniquely.
   *  - Foreshortening itself is clamped at NUMERAL_MIN_SQUASH. True projection
   *    is right for the patch -- it still wraps and disappears on cue -- but a
   *    letterform squeezed past ~1:1.7 is no longer legible, and this is the
   *    range where the ball is still perfectly visible.
   */
  _ballNumber(sx, sy, r, axis, e1, e2, cosR, number, k = 1.0) {
    const ctx = this.ctx;
    const sinR = Math.sqrt(Math.max(0.0, 1.0 - cosR * cosR));
    const facing = axis[2];
    if (facing < NUMERAL_MIN_FACING) return;
    const alpha = Math.min(1.0, (facing - NUMERAL_MIN_FACING) / NUMERAL_FADE);
    const cx = sx + cosR * axis[0] * r;
    const cy = sy + cosR * axis[1] * r;

    // Decompose the tangent frame into rotation + the two scale factors it
    // applies, so the shorter one can be lifted without introducing shear:
    // scaling a basis vector along its own direction is still an orthonormal
    // frame, just a less squashed one.
    const ux = e1[0], uy = e1[1], vx = e2[0], vy = e2[1];
    const lu = Math.hypot(ux, uy) || 1.0;
    const lv = Math.hypot(vx, vy) || 1.0;
    const hi = Math.max(lu, lv);
    let su = lu, sv = lv;
    if (Math.min(lu, lv) < hi * NUMERAL_MIN_SQUASH) {
      if (lu <= lv) su = hi * NUMERAL_MIN_SQUASH;
      else sv = hi * NUMERAL_MIN_SQUASH;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.transform(r * ux / lu * su, r * uy / lu * su,
                  r * vx / lv * sv, r * vy / lv * sv, cx, cy);
    ctx.fillStyle = "#141414";
    ctx.font = `700 ${0.95 * sinR * k}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // the glyph is drawn in ball radii because the transform scales it
    ctx.fillText(String(number), 0, 0);
    ctx.restore();
  }

  _renderBalls() {
    const w = this.game.world;
    for (const b of w.balls) {
      if (!b.pocketed) { this._drawBall(b); continue; }
      if (b._sink && b._sink.t < SINK_TIME) this._drawSinkingBall(b);
    }
  }

  /**
   * A ball dropping into a pocket: it slides the last few units to the mouth,
   * shrinks as it passes the lip and fades out under the rim, all clipped to
   * the pocket so the cloth never shows a stray circle. Without this the ball
   * simply blinked out of existence, which read as a bug.
   */
  _drawSinkingBall(b) {
    const ctx = this.ctx;
    const s = b._sink;
    const p = Math.min(1.0, s.t / SINK_TIME);
    const slide = Math.min(1.0, p * 2.1);            // ease into the mouth
    const wx = s.from[0] + (s.to[0] - s.from[0]) * slide;
    const wy = s.from[1] + (s.to[1] - s.from[1]) * slide;
    const [sx, sy] = this.w2s(wx, wy);
    const r0 = Math.max(4, b.radius * this.scale);
    const shrink = Math.max(0.0, (p - 0.28) / 0.72);
    const r = r0 * (1.0 - 0.72 * shrink);
    const alpha = 1.0 - Math.max(0.0, (p - 0.50) / 0.50);
    const [px, py] = this.w2s(s.to[0], s.to[1]);
    const pr = this.game.world.capture_radius * this.scale * 1.02;

    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = Math.max(0.0, alpha);
    this._drawBall(b, { sx, sy, r });
    ctx.restore();

    // the lip of the pocket darkens over the ball as it drops
    if (p > 0.45) {
      const k = (p - 0.45) / 0.55;
      const g = ctx.createRadialGradient(px, py, pr * 0.25, px, py, pr);
      g.addColorStop(0, `rgba(0,0,0,${0.55 * k})`);
      g.addColorStop(0.7, `rgba(0,0,0,${0.85 * k})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = g;
      ctx.fillRect(px - pr, py - pr, 2 * pr, 2 * pr);
      ctx.restore();
    }
  }

  /** Contact sparks and the ripple when a ball drops. */
  _drawEffects() {
    const ctx = this.ctx;
    for (const e of this.fx) {
      const p = e.t / 0.34;
      const [sx, sy] = this.w2s(e.x, e.y);
      const rail = e.kind === "rail";
      const rr = (rail ? 4.0 : 5.0) + p * (rail ? 9.0 : 15.0);
      const a = (1.0 - p) * (rail ? 0.30 : 0.42) * (0.35 + e.str * 0.65);
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.lineWidth = rail ? 1.4 : 1.8;
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.stroke();
      if (!rail && e.str > 0.35) {
        ctx.fillStyle = `rgba(255,255,255,${(a * 0.55).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 1.6 * (1.0 - p * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    for (const f of this.pocket_flash) {
      const p = f.t / 0.6;
      const [sx, sy] = this.w2s(f.x, f.y);
      const r0 = this.game.world.capture_radius * this.scale;
      ctx.save();
      ctx.strokeStyle = `rgba(150,255,190,${(1 - p) * 0.55})`;
      ctx.lineWidth = 2.4 * (1 - p) + 0.6;
      ctx.beginPath();
      ctx.arc(sx, sy, r0 * (0.65 + p * 1.15), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // -- aiming, shot line, cue -------------------------------------------
  /**
   * What the cue ball meets first travelling along `ang`: another ball
   * (contact point at 2r, i.e. the ghost ball) or a cushion. Pure geometry
   * so the aim line redraws instantly every frame.
   */
  _firstHit(cue, ang) {
    const w = this.game.world;
    const r = w.ball_radius;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let best = null;
    for (const b of w.balls) {
      if (b.pocketed || b.kind === "cue") continue;
      const ox = b.x - cue.x, oy = b.y - cue.y;
      const proj = ox * ux + oy * uy;
      if (proj <= 0) continue;
      const perp2 = ox * ox + oy * oy - proj * proj;
      const R = 2 * r;
      if (perp2 > R * R) continue;
      const t = proj - Math.sqrt(R * R - perp2);
      if (t < 0) continue;
      if (best === null || t < best.t) best = { t, ball: b };
    }
    let tw = Infinity;
    if (ux > 1e-9) tw = Math.min(tw, (w.width - r - cue.x) / ux);
    if (ux < -1e-9) tw = Math.min(tw, (r - cue.x) / ux);
    if (uy > 1e-9) tw = Math.min(tw, (w.height - r - cue.y) / uy);
    if (uy < -1e-9) tw = Math.min(tw, (r - cue.y) / uy);
    if (best === null || tw < best.t) return { t: Math.max(0.0, tw), ball: null };
    return best;
  }

  _ballLineColor(b) {
    const info = ballColor(b, this.snooker);
    return `rgba(${info.fill[0]},${info.fill[1]},${info.fill[2]},.92)`;
  }

  /**
   * Aim assist: the cue-ball path up to the first contact, the ghost ball at
   * that contact, the object ball's predicted line (extended to a pocket when
   * it is lined up with one) and the cue ball's deflection afterwards.
   */
  _renderShotLine(cue, ang) {
    const ctx = this.ctx;
    const w = this.game.world;
    const r = w.ball_radius;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const hit = this._firstHit(cue, ang);
    const hx = cue.x + ux * hit.t, hy = cue.y + uy * hit.t;
    const [sx, sy] = this.w2s(cue.x, cue.y);
    const [ex, ey] = this.w2s(hx, hy);
    const rs = Math.max(4, r * this.scale);

    // --- cue-ball path (marching dashes so it reads as "will travel") ----
    ctx.save();
    ctx.setLineDash([9, 8]);
    ctx.lineDashOffset = -performance.now() * 0.018;
    ctx.strokeStyle = "rgba(255,255,255,.80)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.restore();

    if (hit.ball === null) {
      // cushion first — show the reflection so bank shots can be aimed
      let rx = ux, ry = uy;
      if (hx <= r + 0.5 || hx >= w.width - r - 0.5) rx = -ux;
      else ry = -uy;
      const L = 120;
      const [bx, by] = this.w2s(hx + rx * L, hy + ry * L);
      ctx.save();
      ctx.setLineDash([7, 9]);
      ctx.strokeStyle = "rgba(255,255,255,.32)";
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(bx, by); ctx.stroke();
      ctx.restore();
      return;
    }

    const tb = hit.ball;
    const [gx, gy] = this.w2s(hx, hy);

    // --- ghost ball at the contact point --------------------------------
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = "rgba(255,255,255,.50)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(gx, gy, rs, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // --- line of centres = where the object ball goes -------------------
    let ndx = tb.x - hx, ndy = tb.y - hy;
    const nd = Math.hypot(ndx, ndy) || 1.0;
    ndx /= nd; ndy /= nd;
    const cut = Math.max(0.0, ux * ndx + uy * ndy);

    // How far the object ball would actually travel: stop at the first ball
    // in its path or at the cushion, otherwise the line just paints over the
    // rest of the rack and off the table.
    const R2 = 2 * r;
    let len = Math.min(240, w.width * 0.45);
    for (const o of w.balls) {
      if (o.pocketed || o === tb || o.kind === "cue") continue;
      const ox = o.x - tb.x, oy = o.y - tb.y;
      const along = ox * ndx + oy * ndy;
      if (along <= 0) continue;
      const perp2 = ox * ox + oy * oy - along * along;
      if (perp2 >= R2 * R2) continue;
      const t = along - Math.sqrt(R2 * R2 - perp2);
      if (t > 0 && t < len) len = t;
    }
    // and at the cushion
    const toCushion = (nx, ny, lo, hi, p, d) => {
      if (d > 1e-9) return (hi - p) / d;
      if (d < -1e-9) return (lo - p) / d;
      return Infinity;
    };
    len = Math.min(len,
      toCushion(1, 0, r, w.width - r, tb.x, ndx),
      toCushion(0, 1, r, w.height - r, tb.y, ndy));

    // is it lined up with a pocket within that distance?
    let pk = -1, pkLen = Infinity;
    for (let i = 0; i < w.pockets.length; i++) {
      const [px, py] = w.pockets[i];
      const ox = px - tb.x, oy = py - tb.y;
      const t = ox * ndx + oy * ndy;
      if (t <= 0 || t > len) continue;
      if (Math.abs(-ox * ndy + oy * ndx) > w.capture_radius * 0.95) continue;
      if (t < pkLen) { pkLen = t; pk = i; }
    }
    if (pk >= 0) len = pkLen;

    const [bx2, by2] = this.w2s(tb.x, tb.y);
    const [tx, ty] = this.w2s(tb.x + ndx * Math.max(6, len),
      tb.y + ndy * Math.max(6, len));

    ctx.save();
    ctx.strokeStyle = this._ballLineColor(tb);
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(bx2, by2); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.restore();

    if (pk >= 0) {
      // the object ball is lined up with a pocket: pulse that pocket
      const [pxs, pys] = this.w2s(w.pockets[pk][0], w.pockets[pk][1]);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
      ctx.save();
      ctx.strokeStyle = `rgba(126,236,166,${0.30 + 0.55 * pulse})`;
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(pxs, pys, rs * 1.55, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // --- cue ball deflection after the hit ------------------------------
    const defl = Math.sqrt(Math.max(0.0, 1.0 - cut * cut));
    if (defl > 0.10) {
      const dx = ux - cut * ndx, dy = uy - cut * ndy;
      const dl = Math.hypot(dx, dy) || 1.0;
      const L = 26 + 78 * defl;
      const [ax, ay] = this.w2s(hx + (dx / dl) * L, hy + (dy / dl) * L);
      ctx.save();
      ctx.setLineDash([5, 6]);
      ctx.strokeStyle = "rgba(255,255,255,.38)";
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(ax, ay); ctx.stroke();
      ctx.restore();
    }
  }

  _renderAim() {
    const cue = this.game.cue();
    if (cue === null) return;
    this._renderShotLine(cue, this.aim_angle);
    const [cx, cy] = this.w2s(cue.x, cue.y);
    const r = Math.max(4, cue.radius * this.scale);
    const frac = this.pulling ? this.pull_len / MAX_DRAG : 0.0;
    // the cue draws back as the player pulls, and sits just off the ball idle
    const gap = r * 1.25 + frac * r * 3.6;
    // english is shown, not told: the cue is laid across the ball face, so a
    // side-spin stroke visibly strikes off centre
    const off = -this.spin[0] * r * 0.72;
    this._renderCue(cx, cy, this.aim_angle, gap, 1.0, off);

    // where the tip meets the ball (plan view): a small ring at the back edge
    if (Math.abs(this.spin[0]) > 0.06 || Math.abs(this.spin[1]) > 0.06) {
      const ctx = this.ctx;
      const ux = Math.cos(this.aim_angle), uy = Math.sin(this.aim_angle);
      const px = cx - ux * r * 0.62 - uy * off;
      const py = cy - uy * r * 0.62 + ux * off;
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(px, py, r * 0.20, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * A real cue: tapered maple shaft, ivory ferrule, chalked tip, rosewood
   * butt with a linen wrap, lit from above and casting a shadow on the cloth.
   * Drawn in a rotated frame whose +x is the shot direction, so the cue always
   * lies along -x with its tip `gap` pixels from the cue ball's centre.
   */
  _renderCue(px, py, ang, gap, alpha = 1.0, off = 0.0) {
    const ctx = this.ctx;
    let L = 225;
    // Keep the whole cue on the canvas: walking back from the ball along
    // (-cos, -sin), find where that ray leaves the frame and shorten the cue
    // if the butt would poke out. A hard cut at the window edge reads as a
    // rendering glitch, a slightly shorter cue does not.
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const M = 6;
    let room = Infinity;
    if (ca > 1e-6) room = Math.min(room, (px - M) / ca);
    else if (ca < -1e-6) room = Math.min(room, (WIN_W - M - px) / -ca);
    if (sa > 1e-6) room = Math.min(room, (py - M) / sa);
    else if (sa < -1e-6) room = Math.min(room, (WIN_H - M - py) / -sa);
    if (gap + L > room) L = Math.max(70, room - gap);

    // A real cue's tip is roughly a fifth of a ball's diameter; scale the
    // shaft by the ball's on-screen radius so the proportions hold in both
    // modes (the snooker ball draws much smaller than an 8-ball).
    const rr = (this.game && this.game.world)
      ? this.game.world.ball_radius * this.scale : 11.0;
    const k = Math.max(0.85, Math.min(2.4, rr / 7.6));

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px, py);
    ctx.rotate(ang);
    if (off) ctx.translate(0, off);
    ctx.scale(1, k);

    const tipX = -gap;
    const buttX = -gap - L;
    const shaftEnd = tipX - L * 0.58;     // where the shaft meets the butt
    const ferruleX = tipX - 9.0;

    // shadow on the cloth
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 11;
    ctx.shadowOffsetY = 7;
    ctx.beginPath();
    ctx.moveTo(tipX, -1.5); ctx.lineTo(buttX, -4.2);
    ctx.lineTo(buttX, 4.2); ctx.lineTo(tipX, 1.5);
    ctx.closePath();
    ctx.fillStyle = "#150e07";
    ctx.fill();
    ctx.restore();

    // maple shaft
    const sg = ctx.createLinearGradient(0, -3.0, 0, 3.0);
    sg.addColorStop(0.00, "#fbf1dc");
    sg.addColorStop(0.28, "#eddbb2");
    sg.addColorStop(0.62, "#d2b384");
    sg.addColorStop(1.00, "#9c7a4f");
    ctx.beginPath();
    ctx.moveTo(tipX, -1.45); ctx.lineTo(shaftEnd, -2.7);
    ctx.lineTo(shaftEnd, 2.7); ctx.lineTo(tipX, 1.45);
    ctx.closePath();
    ctx.fillStyle = sg; ctx.fill();

    // rosewood butt
    const bg = ctx.createLinearGradient(0, -4.2, 0, 4.2);
    bg.addColorStop(0.00, "#74432a");
    bg.addColorStop(0.26, "#43251a");
    bg.addColorStop(0.58, "#251410");
    bg.addColorStop(1.00, "#110a08");
    ctx.beginPath();
    ctx.moveTo(shaftEnd, -2.7); ctx.lineTo(buttX, -4.2);
    ctx.lineTo(buttX, 4.2); ctx.lineTo(shaftEnd, 2.7);
    ctx.closePath();
    ctx.fillStyle = bg; ctx.fill();

    // linen wrap
    ctx.save();
    ctx.globalAlpha = alpha * 0.30;
    ctx.strokeStyle = "#cfa76e";
    ctx.lineWidth = 0.8;
    for (let x = shaftEnd - 6; x > buttX + 24; x -= 5.5) {
      ctx.beginPath(); ctx.moveTo(x, -3.3); ctx.lineTo(x - 2.0, 3.3); ctx.stroke();
    }
    ctx.restore();

    // joint collar
    ctx.fillStyle = "#d9dee4";
    ctx.fillRect(shaftEnd - 2, -2.8, 4, 5.6);

    // ferrule + chalked tip
    ctx.fillStyle = "#f5f2e7";
    ctx.fillRect(ferruleX, -1.5, 6, 3.0);
    ctx.fillStyle = "#3f74b8";
    ctx.beginPath();
    ctx.moveTo(tipX - 3, -1.55); ctx.lineTo(tipX, -1.45);
    ctx.lineTo(tipX, 1.45); ctx.lineTo(tipX - 3, 1.55);
    ctx.closePath();
    ctx.fill();

    // specular highlight along the shaft
    ctx.strokeStyle = "rgba(255,255,255,.42)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(ferruleX, -0.8); ctx.lineTo(shaftEnd - 3, -1.5);
    ctx.stroke();

    ctx.restore();
  }

  /** The cue snapping through the ball right after the trigger. */
  _renderStrike() {
    if (!this.strike_from) return;
    const cue = this.game.cue();
    const r = cue ? Math.max(4, cue.radius * this.scale) : 5;
    const [px, py] = this.w2s(this.strike_from[0], this.strike_from[1]);
    const t = this.strike_t;                     // 1 -> 0
    const follow = (1.0 - t) * r * 2.6;          // drifts through the ball
    const off = -(this.strike_spin ? this.strike_spin[0] : 0) * r * 0.72;
    this._renderCue(px, py, this.strike_angle, r * 1.35 * t - follow,
      Math.min(1.0, t * 2.4), off);
  }

  _renderPowerBar() {
    const ctx = this.ctx;
    const bw = 220, bh = 13;
    const bx = WIN_W / 2 - bw / 2, by = WIN_H - 44;
    const frac = this.power / MAX_LAUNCH;

    ctx.fillStyle = "rgba(0,0,0,.40)";
    this._roundRect(bx - 3, by - 3, bw + 6, bh + 6, 6); ctx.fill();
    ctx.fillStyle = "#3a3d44";
    this._roundRect(bx, by, bw, bh, 4); ctx.fill();

    let col = "#5ac87a";
    if (frac > 0.5) col = "#e0b45a";
    if (frac > 0.8) col = "#e26b5a";
    ctx.fillStyle = col;
    this._roundRect(bx, by, Math.max(2, bw * frac), bh, 4); ctx.fill();

    // quarter ticks so a soft touch is easy to judge
    ctx.strokeStyle = "rgba(0,0,0,.28)";
    ctx.lineWidth = 1;
    for (const q of [0.25, 0.5, 0.75]) {
      const qx = bx + bw * q;
      ctx.beginPath(); ctx.moveTo(qx, by + 1); ctx.lineTo(qx, by + bh - 1); ctx.stroke();
    }

    this._text(`POWER  ${Math.round(frac * 100)}%`,
      WIN_W / 2, by - 8, 11, "#9aa1ad", "center", 700);
  }

  /**
   * The english dial: a plan-view cue ball. Click (or drag) on it to place the
   * tip, or walk the tip with the arrow keys; up = follow, down = draw,
   * left/right = side spin. Double-click or S re-centres, and every stroke
   * returns here on its own.
   */
  _renderDial() {
    const ctx = this.ctx;
    const [cx, cy] = this._dialCenter();
    const R = this._dialRadius();
    const live = this.phase === "play" && this._humanTurn() && !this.simulating;

    ctx.save();
    ctx.globalAlpha = live ? 1.0 : 0.42;

    // panel
    ctx.beginPath(); ctx.arc(cx, cy, R + 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#2b2f36"; ctx.fill();
    ctx.strokeStyle = this.spin_drag ? "rgba(160,220,190,.65)" : "rgba(255,255,255,.13)";
    ctx.lineWidth = 1.4; ctx.stroke();

    // cue ball
    const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.40, R * 0.10,
      cx + R * 0.10, cy + R * 0.20, R * 1.10);
    g.addColorStop(0.00, "#ffffff");
    g.addColorStop(0.55, "#f2efe6");
    g.addColorStop(1.00, "#c9c2b2");
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();

    // crosshair
    ctx.strokeStyle = "rgba(30,30,30,.20)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.82, cy); ctx.lineTo(cx + R * 0.82, cy);
    ctx.moveTo(cx, cy - R * 0.82); ctx.lineTo(cx, cy + R * 0.82);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.82, 0, Math.PI * 2); ctx.stroke();

    // natural-roll tick (0.4 R above centre)
    ctx.strokeStyle = "rgba(30,30,30,.28)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx + R * 0.62, cy - R * 0.33);
    ctx.lineTo(cx + R * 0.80, cy - R * 0.33);
    ctx.stroke();

    // the tip
    const dx = cx + this.spin[0] * R * 0.80;
    const dy = cy - this.spin[1] * R * 0.80;
    ctx.beginPath(); ctx.arc(dx, dy, 4.6, 0, Math.PI * 2);
    ctx.fillStyle = "#1d1d1f"; ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = 1.1; ctx.stroke();
    ctx.restore();

    this._text("spin", cx - R - 9, cy + 4, 10.5, "#8b929e", "right", 600);
  }

  _renderHud() {
    const g = this.game;
    let txt;
    if (this.snooker) {
      txt = `Snooker   |   P1 (You) ${g.scores[0]} — ${g.scores[1]} P2 (Bot)   `
        + `|   reds ${g.reds_remaining}   |   ${this.difficulty}`;
    } else {
      const tag = (p) => {
        if (g.groups[p] === null) return "open";
        const nums = g.groups[p] === "solid"
          ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
        const n = nums.filter(x => g.pocketed.has(x)).length;
        return `${g.groups[p]} ${n}/7`;
      };
      txt = `8-Ball   |   You: ${tag(0)}     Bot: ${tag(1)}     ${this.difficulty}`;
    }
    this._text(txt, 20, 28, 19, "#e1e6ee", "left", 600);

    let msg;
    if (this.phase === "over") msg = g.message;
    else if (this.await_place && this._humanTurn()) {
      msg = this._inKitchenPlacement()
        ? "Break — place the cue ball behind the head string (the shaded quarter)."
        : this.snooker
          ? "Ball in hand — place the cue ball inside the D."
          : "Ball in hand — click anywhere on the table to place the cue ball.";
    } else if (this.pending_bot) {
      msg = this.bot_aim
        ? `Bot is lining up — ${Math.round(this.bot_aim[1] / MAX_LAUNCH * 100)}% power…`
        : "Bot is thinking…";
    } else if (this.simulating) msg = "balls rolling…";
    else {
      const who = this._humanTurn() ? "Your turn" : "Bot's turn";
      msg = `${who} — ${g.message}`;
    }
    this._text(msg, 20, 54, 14.5, "#c2c8d3", "left", 400);

    if (this.phase === "play" && this._humanTurn() && !this.await_place && !this.simulating) {
      this._text("aim with the mouse  ·  press, then drag back to load  ·  "
        + "english: arrow keys or drag the dial, S centres",
        20, WIN_H - 16, 12, "#8b929e", "left", 400);
    }
    this._text("R / Esc: menu", WIN_W - 18, WIN_H - 16, 12, "#8b929e", "right", 400);
    this._renderDial();
  }

  _renderOver() {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(0,0,0,.70)";
    ctx.fillRect(0, 0, WIN_W, WIN_H);

    this._text("Frame over", WIN_W / 2, WIN_H / 2 - 52, 38, "#ffffff", "center", 700);
    this._text(this.game.message, WIN_W / 2, WIN_H / 2 - 6, 18, "#e8eaee", "center", 400);

    this.overBtn = { x: WIN_W / 2 - 95, y: WIN_H / 2 + 38, w: 190, h: 50 };
    this._button(this.overBtn, "Back to menu", false, "#3f7d57");

    this._text("Press R or Esc", WIN_W / 2, WIN_H / 2 + 126, 13, "#b9bfca", "center", 400);
  }
}

// -- bootstrap ------------------------------------------------------------
const app = new App(document.getElementById("game"));
window.__billiards = app;
app.start();
