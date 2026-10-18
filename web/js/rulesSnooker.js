/*
 * rulesSnooker.js — snooker frame state machine, scoring & foul detection.
 * Faithful JS port of src/rules_snooker.py (includes the state-consistency
 * fix: reds decrement even on fouls; colours re-spot while reds remain).
 */

const COLOR_VALUES = { 2: "yellow", 3: "green", 4: "brown", 5: "blue", 6: "pink", 7: "black" };
const COLOR_ORDER = [2, 3, 4, 5, 6, 7];   // ascending, end-game sequence

/**
 * Standard snooker spots on a W x H playing surface.
 * Baulk line at 0.2065 L, D radius 0.1636 W, blue dead centre, pink at 0.75 L
 * (midway centre->top cushion), black at 0.9092 L (324 mm off the top cushion).
 * Yellow / green sit on the corners of the D, brown in its middle.
 */
function snookerSpots(W, H) {
  const baulk = W * SNOOKER_BAULK_X;
  const d_r = H * SNOOKER_D_RADIUS;
  return {
    baulk_x: baulk,
    d_radius: d_r,
    colors: {
      2: [baulk, H * 0.5 + d_r],   // yellow
      3: [baulk, H * 0.5 - d_r],   // green
      4: [baulk, H * 0.5],         // brown
      5: [W * 0.5, H * 0.5],       // blue
      6: [W * SNOOKER_PINK_X, H * 0.5],   // pink
      7: [W * SNOOKER_BLACK_X, H * 0.5],  // black
    },
  };
}

class SnookerGame {
  constructor(human_is_player = 0) {
    this.world = makeSnookerWorld();
    this.is_bot = [false, false];
    this.is_bot[1 - human_is_player] = true;
    this.current = 0;
    this.scores = [0, 0];
    this.reds_remaining = 15;
    this.colors_down = new Set();       // permanently potted colours
    this.phase = "red";                 // "red" or "color"
    this.free_ball = false;
    this.ball_in_hand = false;          // only after cue is potted (in-off)
    this.winner = null;
    this.message = "Snooker — pot a red to start.";
    this.foul = false;
    this.last_shot = null;
    this.game_type = "snooker";
    this._rack();
  }

  _rack() {
    const w = this.world;
    const r = w.ball_radius;
    const W = w.width, H = w.height;
    const spots = snookerSpots(W, H);
    for (const key of Object.keys(spots.colors)) {
      const [sx, sy] = spots.colors[key];
      w.addBall(new Ball(sx, sy, r, MASS, Number(key), "color"));
    }
    // Reds: apex faces the baulk end, the pack widens toward black.
    const apex_x = spots.colors[6][0] + 2 * r + 0.4;
    const apex_y = H * 0.50;
    for (let row = 0; row < 5; row++) {
      const x = apex_x + row * r * Math.sqrt(3.0);
      for (let j = 0; j <= row; j++) {
        const y = apex_y + (j - row / 2.0) * 2.0 * r;
        w.addBall(new Ball(x, y, r, MASS, 1, "red"));
      }
    }
    // Cue ball starts INSIDE the D (rule 3.3: the striker plays from in the D)
    const cue = new Ball(
      spots.baulk_x - spots.d_radius * 0.45,
      H * 0.50 + spots.d_radius * 0.55,
      r, MASS, 0, "cue");
    w.addBall(cue);
  }

  cue() { return this.world.cueBall(); }

  on_balls() {
    const w = this.world;
    if (this.reds_remaining > 0) {
      return w.balls.filter(b => b.kind === "red" && !b.pocketed);
    }
    for (const val of COLOR_ORDER) {
      if (!this.colors_down.has(val)) {
        return w.balls.filter(b => b.kind === "color" && b.number === val && !b.pocketed);
      }
    }
    return [];
  }

  _legal_first_numbers() {
    if (this.free_ball) {
      return new Set(this.world.balls
        .filter(b => (b.kind === "red" || b.kind === "color") && !b.pocketed)
        .map(b => b.number));
    }
    if (this.reds_remaining > 0) {
      if (this.phase === "red") return new Set([1]);
      return new Set(this.world.balls
        .filter(b => b.kind === "color" && !this.colors_down.has(b.number))
        .map(b => b.number));
    }
    const low = Math.min(...COLOR_ORDER.filter(c => !this.colors_down.has(c)));
    return new Set([low]);
  }

  value(number) {
    if (number === 1) return 1;
    return number;
  }

  place_cue(x, y) {
    if (!this.ball_in_hand) return false;
    const w = this.world;
    const r = w.ball_radius;
    const spots = snookerSpots(w.width, w.height);
    if (!(r <= y && y <= w.height - r)) return false;
    // rule: the cue ball must be played from inside the D
    if (Math.hypot(x - spots.baulk_x, y - w.height / 2.0) > spots.d_radius) return false;
    for (const b of w.balls) {
      if (b.kind === "cue" || b.pocketed) continue;
      if (Math.hypot(b.x - x, b.y - y) < 2 * r) return false;
    }
    const cue = this.cue();
    cue.x = x; cue.y = y;
    cue.pocketed = false;
    cue.vx = cue.vy = 0.0;
    return true;
  }

  take_shot(angle, power, spin = null) {
    if (this.winner !== null) return { error: "frame over" };
    const cue = this.cue();
    if (cue === null) return { error: "cue not on table — place it first" };
    this.launch(angle, power, spin);
    this.world.simulate();
    return this.resolve_shot();
  }

  launch(angle, power, spin = null) {
    const cue = this.cue();
    this.world.beginShot();
    this.world.shoot(cue, angle, power, spin);
  }

  resolve_shot() {
    const result = this._evaluate();
    this.last_shot = result;
    return result;
  }

  auto_place_cue() {
    const w = this.world;
    const spots = snookerSpots(w.width, w.height);
    this.place_cue(spots.baulk_x - spots.d_radius * 0.50,
      w.height / 2.0 + spots.d_radius * 0.55);
  }

  _evaluate() {
    const w = this.world;
    const player = this.current;
    const opp = 1 - player;
    const pocketed = w.pocketed_this_shot.slice();
    const first = w.first_contact;
    const cue_sunk = pocketed.includes(0);

    const fouls = [];
    const on_nums = this._legal_first_numbers();

    if (first === null) fouls.push("MISS");
    else if (!this.free_ball && !on_nums.has(first)) fouls.push("WRONG_BALL_FIRST");

    const potted_nums = pocketed.filter(n => n !== 0);
    const potted_reds = potted_nums.filter(n => n === 1);
    const potted_colors = potted_nums.filter(n => COLOR_VALUES[n] !== undefined);
    if (cue_sunk) fouls.push("IN_OFF");

    // --- table state must stay consistent even when a foul occurs ---
    if (potted_reds.length > 0) {
      this.reds_remaining -= potted_reds.length;
      if (this.reds_remaining < 0) this.reds_remaining = 0;
    }
    if (this.reds_remaining > 0 && potted_colors.length > 0) {
      this._respot_colors(potted_colors);
    }
    this.phase = this.reds_remaining > 0 ? "red" : "color";

    // --- scoring & pot legality (only when no foul) ---
    let scored = 0;
    let potted_correct = false;
    if (fouls.length === 0) {
      if (this.reds_remaining > 0) {
        if (potted_reds.length > 0) {
          scored += potted_reds.length;
          potted_correct = true;
          if (potted_colors.length > 0) scored += Math.max(...potted_colors);
        } else if (potted_colors.length > 0 && !this.free_ball) {
          fouls.push("COLOUR_POTTED_EARLY");
        }
      } else {
        if (potted_colors.length > 0 && potted_reds.length === 0) {
          const val = Math.max(...potted_colors);
          const low = Math.min(...COLOR_ORDER.filter(c => !this.colors_down.has(c)));
          if (val === low) {
            scored += val;
            potted_correct = true;
            this.colors_down.add(val);
            if (val === 7) this._end_frame();
          } else {
            fouls.push("WRONG_COLOUR_ORDER");
            this._respot_colors(potted_colors);
          }
        } else if (potted_reds.length > 0) {
          fouls.push("RED_POTTED_WHEN_COLOUR_ON");
          this._respot_colors(potted_colors);
        }
      }
    } else {
      if (this.reds_remaining === 0 && potted_colors.length > 0) {
        this._respot_colors(potted_colors);
      }
    }

    if (fouls.length > 0) {
      this.foul = true;
      const firstVal = first ? this.value(first) : 0;
      const pottedMax = potted_nums.length > 0
        ? Math.max(...potted_nums.map(n => this.value(n))) : 0;
      const penalty = Math.max(4, firstVal, pottedMax);
      this.scores[opp] += penalty;
      this.free_ball = true;
      this.ball_in_hand = cue_sunk;
      if (cue_sunk) this._respot_cue();
      this.message = (`Player ${player + 1} foul (+${penalty} to P${opp + 1}): `
        + `${fouls.join(", ")}.`);
      this.current = opp;
    } else {
      this.foul = false;
      this.scores[player] += scored;
      this.free_ball = false;
      this.ball_in_hand = false;
      if (potted_correct) {
        this.message = (`Player ${player + 1} pots (+${scored}). `
          + `Score ${this.scores[0]}-${this.scores[1]}.`);
      } else {
        this.message = (`Player ${player + 1} misses. `
          + `Score ${this.scores[0]}-${this.scores[1]}.`);
        this.current = opp;
      }
    }

    return {
      foul: fouls.length > 0, fouls, scored, pocketed, first,
      scores: this.scores.slice(), turn: this.current, reds: this.reds_remaining,
    };
  }

  _respot_colors(vals) {
    const w = this.world;
    const r = w.ball_radius;
    const W = w.width, H = w.height;
    const spots = snookerSpots(W, H);
    for (const v of vals) {
      let b = w.balls.find(x => x.number === v && x.kind === "color");
      if (b === undefined) {
        b = new Ball(0, 0, r, MASS, v, "color");
        w.addBall(b);
      }
      let [sx, sy] = spots.colors[v];
      while (w.balls.some(other => other !== b && !other.pocketed &&
        Math.hypot(other.x - sx, other.y - sy) < 2 * r)) {
        sy += r;
        if (sy > H - r) { sy = H * 0.50; sx += r; }
      }
      b.x = sx; b.y = sy;
      b.pocketed = false;
      b.vx = b.vy = 0.0;
    }
  }

  _respot_cue() {
    const w = this.world;
    const r = w.ball_radius;
    const spots = snookerSpots(w.width, w.height);
    let cue = this.cue();
    if (cue === null) {
      cue = new Ball(0, 0, r, MASS, 0, "cue");
      w.addBall(cue);
    }
    let x = spots.baulk_x - spots.d_radius * 0.50;
    let y = w.height * 0.50 + spots.d_radius * 0.55;
    while (w.balls.some(b => b !== cue && !b.pocketed &&
      Math.hypot(b.x - x, b.y - y) < 2 * r)) {
      y += r;
      if (y > w.height * 0.5 + spots.d_radius) {
        y = w.height * 0.5 - spots.d_radius * 0.6;
        x -= r;
      }
    }
    cue.x = x; cue.y = y;
    cue.pocketed = false;
    cue.vx = cue.vy = 0.0;
  }

  _end_frame() {
    if (this.scores[0] === this.scores[1]) {
      this.winner = null;
      this.message = "Frame tie — re-spot black (simplified draw).";
      return;
    }
    this.winner = this.scores[0] > this.scores[1] ? 0 : 1;
    this.message = `Frame over — Player ${this.winner + 1} wins `
      + `${this.scores[this.winner]}-${this.scores[1 - this.winner]}.`;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SnookerGame, COLOR_VALUES, COLOR_ORDER, snookerSpots };
}
