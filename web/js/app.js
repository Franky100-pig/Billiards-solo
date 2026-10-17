/*
 * app.js — Canvas 2D UI for Billiards-solo (browser port of src/main.py).
 *
 * Menu -> pick 8-ball or snooker + difficulty -> play vs the built-in bot.
 * All physics/rules/AI live in the sibling modules; this file only handles
 * input, rendering, and turn flow. No network access anywhere.
 *
 * Controls:
 *   - Ball-in-hand: click/tap inside the allowed area to place the cue ball.
 *   - Aiming: press & hold, drag AWAY from the cue (slingshot), release to shoot.
 *     Pull distance = power; the shot goes opposite the drag direction.
 *   - R / Esc: return to the menu.
 */

const WIN_W = 960, WIN_H = 660;
const HUD_TOP = 78, HUD_BOTTOM = 56;
const RAIL = 26;
const ANIM_H = 1.0 / 360.0;
const SUBSTEPS_PER_FRAME = 16;
const MAX_LAUNCH = 2000.0;
const MIN_LAUNCH = 160.0;
const MAX_DRAG = 230.0;

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
    this.pulling = false;
    this.simulating = false;
    this.await_place = false;
    this.pending_bot = false;
    this.bot_think_frames = 0;
    this.aim_angle = 0.0;
    this.power = 0.0;
    this.overBtn = null;

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
    this.pending_bot = false;
    this.bot_think_frames = 0;
    this.power = 0.0;
    this.aim_angle = 0.0;
    this.overBtn = null;
    this.await_place = !!this.game.ball_in_hand;
  }

  // -- input -------------------------------------------------------------
  _bindInput() {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      const pos = getPos(this.canvas, e);
      this.mouse = pos;
      this.onClick(pos);
    });
    window.addEventListener("pointermove", (e) => {
      this.mouse = getPos(this.canvas, e);
    });
    window.addEventListener("pointerup", (e) => {
      this.onRelease(getPos(this.canvas, e));
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "r" || e.key === "R" || e.key === "Escape") {
        this.phase = "menu";
        this.pulling = false;
        this.simulating = false;
        this.pending_bot = false;
      }
    });
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
    if (this.await_place) {
      const [wx, wy] = this.s2w(pos[0], pos[1]);
      if (this.game.place_cue(wx, wy)) {
        this.await_place = false;
        this.game.message = "Cue placed — aim and shoot.";
      }
      return;
    }
    if (!this.simulating && this._humanTurn()) this.pulling = true;
  }

  onRelease(pos) {
    if (this.phase !== "play" || !this.pulling) return;
    this.pulling = false;
    if (this.power < MIN_LAUNCH * 0.5) return;
    const cue = this.game.cue();
    if (cue === null) return;
    this.game.launch(this.aim_angle, this.power);
    this.simulating = true;
  }

  _humanTurn() { return this.game.current === 0; }

  _updatePull() {
    if (!this.pulling) return;
    const cue = this.game.cue();
    if (cue === null) return;
    const [cx, cy] = this.w2s(cue.x, cue.y);
    const dx = this.mouse[0] - cx, dy = this.mouse[1] - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 4) { this.power = 0.0; return; }
    this.aim_angle = Math.atan2(-dy, -dx);
    this.power = Math.min(MAX_LAUNCH, (Math.min(dist, MAX_DRAG) / MAX_DRAG) * MAX_LAUNCH);
    if (this.power < MIN_LAUNCH) this.power = MIN_LAUNCH;
  }

  // -- turn flow ---------------------------------------------------------
  afterResolve() {
    const g = this.game;
    if (g.winner !== null) { this.phase = "over"; this.overBtn = null; return; }
    this.await_place = !!g.ball_in_hand;
    if (g.current === 1) {
      this.pending_bot = true;
      this.bot_think_frames = 0;
    } else {
      this.pending_bot = false;
    }
  }

  doBotTurn() {
    const g = this.game;
    if (g.ball_in_hand) g.auto_place_cue();
    const ap = chooseShot(g, this.difficulty);
    g.launch(ap[0], ap[1]);
    this.simulating = true;
    this.pending_bot = false;
    this.await_place = false;
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

  tick() {
    if (this.phase !== "play") return;
    this._updatePull();
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
      if (this.bot_think_frames > 8) this.doBotTurn();
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
      }
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

  _renderTable() {
    if (this.snooker) { this._renderSnookerTable(); return; }
    const ctx = this.ctx;
    const w = this.game.world;
    const [x0, y0] = this.w2s(0, 0);
    const tw = w.width * this.scale, th = w.height * this.scale;

    // drop shadow + rail
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.45)";
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = "#165c2e";
    this._roundRect(x0 - RAIL, y0 - RAIL, tw + 2 * RAIL, th + 2 * RAIL, 12);
    ctx.fill();
    ctx.restore();

    // cloth
    ctx.fillStyle = "#0f4623";
    ctx.fillRect(x0, y0, tw, th);

    // subtle cloth sheen
    const sh = ctx.createLinearGradient(x0, y0, x0, y0 + th);
    sh.addColorStop(0, "rgba(255,255,255,.045)");
    sh.addColorStop(0.5, "rgba(0,0,0,0)");
    sh.addColorStop(1, "rgba(0,0,0,.10)");
    ctx.fillStyle = sh;
    ctx.fillRect(x0, y0, tw, th);

    // pockets
    for (const [px, py] of w.pockets) {
      const [sx, sy] = this.w2s(px, py);
      const pr = Math.max(7, w.pocket_radius * this.scale);
      ctx.fillStyle = "#070707";
      ctx.beginPath(); ctx.arc(sx, sy, pr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.65)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, pr, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /**
   * Standard snooker table: mahogany body, green baize, cushion band, baulk
   * line + D, the six spots, and corner pockets larger than the middles.
   */
  _renderSnookerTable() {
    const ctx = this.ctx;
    const w = this.game.world;
    const [x0, y0] = this.w2s(0, 0);
    const tw = w.width * this.scale, th = w.height * this.scale;
    const rail = RAIL + 8;
    const cush = Math.max(10, 17 * this.scale);

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

    // brass-ish sight markers along the rails (nice, cheap detail)
    ctx.fillStyle = "rgba(214,178,110,.55)";
    for (const f of [0.25, 0.5, 0.75]) {
      const sx = x0 + tw * f;
      for (const yy of [y0 - rail / 2, y0 + th + rail / 2]) {
        ctx.beginPath(); ctx.arc(sx, yy, 1.6, 0, Math.PI * 2); ctx.fill();
      }
    }

    // --- cushion band (rubber, lighter than the cloth, dark shadow line) --
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

    // --- markings: baulk line, D, spots ----------------------------------
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

    // --- pockets ---------------------------------------------------------
    const cr = w.capture_radius * this.scale;
    for (let i = 0; i < w.pockets.length; i++) {
      const [sx, sy] = this.w2s(w.pockets[i][0], w.pockets[i][1]);
      const middle = (i === 1 || i === 4);
      const pr = (middle ? 0.80 : 1.05) * cr;
      // mouth
      const pg = ctx.createRadialGradient(sx, sy, pr * 0.15, sx, sy, pr);
      pg.addColorStop(0, "#000000");
      pg.addColorStop(0.72, "#050d08");
      pg.addColorStop(1, "#123024");
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(sx, sy, pr, 0, Math.PI * 2); ctx.fill();
      // leather rim
      ctx.strokeStyle = "rgba(28,16,8,.85)";
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(sx, sy, pr + 1.2, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _drawBall(b) {
    const ctx = this.ctx;
    const [sx, sy] = this.w2s(b.x, b.y);
    const r = Math.max(4, b.radius * this.scale);
    const info = ballColor(b, this.snooker);
    const fill = rgb(info.fill);

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

    // base
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = info.stripe ? "#ececec" : fill;
    ctx.fill();

    // stripe band (white ball with a coloured equator band)
    if (info.stripe) {
      ctx.save();
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = fill;
      ctx.fillRect(sx - r, sy - r * 0.60, 2 * r, r * 1.20);
      ctx.restore();
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

    // number disc (8-ball only)
    if (!this.snooker && b.kind !== "cue") {
      const dr = r * 0.46;
      ctx.beginPath(); ctx.arc(sx, sy, dr, 0, Math.PI * 2);
      ctx.fillStyle = "#f4f4f4"; ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.22)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#141414";
      ctx.font = `700 ${Math.max(7, r * 0.8)}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(b.number), sx, sy + 0.5);
      ctx.textBaseline = "alphabetic";
    }
  }

  _renderBalls() {
    for (const b of this.game.world.balls) {
      if (b.pocketed) continue;
      this._drawBall(b);
    }
  }

  _renderAim() {
    const ctx = this.ctx;
    const cue = this.game.cue();
    if (cue === null) return;
    const [cx, cy] = this.w2s(cue.x, cue.y);
    const ang = this.aim_angle;

    // forward aim line (dashed)
    const ex = cx + Math.cos(ang) * 340, ey = cy + Math.sin(ang) * 340;
    ctx.save();
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.restore();

    // cue stick pulled back
    if (this.pulling && this.power > 0) {
      const frac = this.power / MAX_LAUNCH;
      const backLen = 40 + frac * MAX_DRAG;
      const bx = cx - Math.cos(ang) * backLen;
      const by = cy - Math.sin(ang) * backLen;
      // stick
      ctx.strokeStyle = "#d8b382";
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(
        bx - Math.cos(ang) * 150, by - Math.sin(ang) * 150); ctx.stroke();
      // tip
      ctx.strokeStyle = "#5b8fd6";
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(
        bx + Math.cos(ang) * 10, by + Math.sin(ang) * 10); ctx.stroke();
      // pull-back marker
      ctx.fillStyle = "rgba(255,120,90,.9)";
      ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  _renderPowerBar() {
    const ctx = this.ctx;
    const bw = 220, bh = 13;
    const bx = WIN_W / 2 - bw / 2, by = WIN_H - 34;
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

    this._text("POWER", WIN_W / 2, by - 8, 11, "#9aa1ad", "center", 700);
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
      msg = "Ball in hand — click inside the allowed area to place the cue ball.";
    } else if (this.pending_bot) msg = "Bot is taking its shot…";
    else if (this.simulating) msg = "…";
    else {
      const who = this._humanTurn() ? "Your turn" : "Bot's turn";
      msg = `${who} — ${g.message}`;
    }
    this._text(msg, 20, 54, 14.5, "#c2c8d3", "left", 400);

    this._text("R / Esc: menu", WIN_W - 18, WIN_H - 14, 12, "#8b929e", "right", 400);
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
