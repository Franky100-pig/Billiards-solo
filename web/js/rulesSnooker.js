/*
 * rulesSnooker.js — snooker frame state machine, scoring & foul detection.
 * Faithful JS port of src/rules_snooker.py (includes the state-consistency
 * fix: reds decrement even on fouls; colours re-spot while reds remain).
 */

const COLOR_VALUES = { 2: "yellow", 3: "green", 4: "brown", 5: "blue", 6: "pink", 7: "black" };
const COLOR_ORDER = [2, 3, 4, 5, 6, 7];   // ascending, end-game sequence

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
    const baulk_x = W * 0.25;
    const spots = {
      2: [baulk_x, H * 0.70],
      3: [baulk_x, H * 0.30],
      4: [baulk_x, H * 0.50],
      5: [W * 0.50, H * 0.50],
      6: [W * 0.72, H * 0.50],
      7: [W * 0.90, H * 0.50],
    };
    for (const val of Object.keys(spots)) {
      const [sx, sy] = spots[val];
      const b = new Ball(sx, sy, r, MASS, Number(val), "color");
      w.addBall(b);
    }
    // Reds: apex faces the baulk end (left), the pack widens toward black.
    const apex_x = W * 0.75, apex_y = H * 0.50;
    for (let row = 0; row < 5; row++) {
      const x = apex_x + row * r * Math.sqrt(3.0);
      for (let j = 0; j <= row; j++) {
        const y = apex_y + (j - row / 2.0) * 2.0 * r;
        const b = new Ball(x, y, r, MASS, 1, "red");
        w.addBall(b);
      }
    }
    // cue ball in the D (offset from the brown spot so they don't overlap)
    const cue = new Ball(baulk_x + r * 3, H * 0.50, r, MASS, 0, "cue");
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
    const baulk_x = w.width * 0.25;
    if (!(baulk_x - r <= x && x <= baulk_x + w.height * 0.5 + r)) return false;
    if (!(r <= y && y <= w.height - r)) return false;
    if (Math.hypot(x - baulk_x, y - w.height / 2.0) > w.height * 0.5 + r) return false;
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

  take_shot(angle, power) {
    if (this.winner !== null) return { error: "frame over" };
    const cue = this.cue();
    if (cue === null) return { error: "cue not on table — place it first" };
    this.launch(angle, power);
    this.world.simulate();
    return this.resolve_shot();
  }

  launch(angle, power) {
    const cue = this.cue();
    this.world.beginShot();
    this.world.shoot(cue, angle, power);
  }

  resolve_shot() {
    const result = this._evaluate();
    this.last_shot = result;
    return result;
  }

  auto_place_cue() {
    const w = this.world;
    this.place_cue(w.width * 0.25, w.height / 2.0);
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
    const baulk_x = W * 0.25;
    const spots = {
      2: [baulk_x, H * 0.70], 3: [baulk_x, H * 0.30], 4: [baulk_x, H * 0.50],
      5: [W * 0.50, H * 0.50], 6: [W * 0.72, H * 0.50], 7: [W * 0.90, H * 0.50],
    };
    for (const v of vals) {
      let b = w.balls.find(x => x.number === v && x.kind === "color");
      if (b === undefined) {
        b = new Ball(0, 0, r, MASS, v, "color");
        w.addBall(b);
      }
      let [sx, sy] = spots[v];
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
    const baulk_x = w.width * 0.25;
    let cue = this.cue();
    if (cue === null) {
      cue = new Ball(0, 0, r, MASS, 0, "cue");
      w.addBall(cue);
    }
    let x = baulk_x, y = w.height * 0.50;
    while (w.balls.some(b => b !== cue && !b.pocketed &&
      Math.hypot(b.x - x, b.y - y) < 2 * r)) {
      y += r;
      if (y > w.height - r) { y = w.height * 0.50; x += r; }
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
  module.exports = { SnookerGame, COLOR_VALUES, COLOR_ORDER };
}
