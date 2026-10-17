/*
 * rules8ball.js — 8-ball game state machine, rules & foul detection.
 * Faithful JS port of src/rules_eightball.py.
 */

const SOLIDS = [1, 2, 3, 4, 5, 6, 7];      // 1-7
const STRIPES = [9, 10, 11, 12, 13, 14, 15]; // 9-15
const EIGHT = 8;

// Fixed rack order (apex first). Rules for a legal rack: the 8 sits in the
// middle of the third row and the two back corners are one solid and one
// stripe — hence 5 (solid) and 15 (stripe) at the ends of the last row.
const RACK_ORDER = [1, 9, 2, 10, 8, 11, 3, 12, 4, 13, 5, 14, 6, 7, 15];

class EightBallGame {
  constructor(human_is_player = 0) {
    this.world = make8BallWorld();
    this.is_bot = [false, false];
    this.is_bot[1 - human_is_player] = true;
    this.current = 0;
    this.groups = [null, null];      // "solid"/"stripe"
    this.open = true;
    this.ball_in_hand = true;
    this.ball_in_hand_kitchen = true; // restrict to left quarter on break
    this.pocketed = new Set();
    this.winner = null;
    this.message = "Break! Place the cue ball, then aim.";
    this.foul = false;
    this.consecutive_fouls = [0, 0];
    this.last_shot = null;
    this.game_type = "8ball";
    this._rack();
  }

  _rack() {
    const w = this.world;
    const r = w.ball_radius;
    const foot_x = w.width * 0.72;
    const apex_y = w.height / 2.0;
    let idx = 0;
    for (let row = 0; row < 5; row++) {
      const x = foot_x + row * r * Math.sqrt(3.0);
      for (let j = 0; j <= row; j++) {
        const y = apex_y + (j - row / 2.0) * 2.0 * r;
        const num = RACK_ORDER[idx];
        const kind = (SOLIDS.includes(num) ? "solid"
          : STRIPES.includes(num) ? "stripe" : "eight");
        const b = new Ball(x, y, r, MASS, num, kind);
        w.addBall(b);
        idx++;
      }
    }
    const cue = new Ball(w.width * 0.25, w.height / 2.0, r, MASS, 0, "cue");
    w.addBall(cue);
  }

  cue() { return this.world.cueBall(); }

  balls_by_kind(kind) {
    return this.world.balls.filter(b => b.kind === kind && !b.pocketed);
  }

  group_of(player) { return this.groups[player]; }

  cleared_group(player) {
    const g = this.groups[player];
    if (g === null) return false;
    const nums = g === "solid" ? SOLIDS : STRIPES;
    return nums.every(n => this.pocketed.has(n));
  }

  legal_target_numbers(player) {
    if (this.open) return SOLIDS.concat(STRIPES);
    if (this.cleared_group(player)) return [EIGHT];
    const g = this.groups[player];
    return g === "solid" ? SOLIDS : STRIPES;
  }

  legal_first_contact(player) {
    if (this.open) return SOLIDS.concat(STRIPES);
    return this.legal_target_numbers(player);
  }

  on_balls() {
    const nums = new Set(this.legal_target_numbers(this.current));
    return this.world.balls.filter(b => nums.has(b.number) && !b.pocketed);
  }

  place_cue(x, y) {
    if (!this.ball_in_hand) return false;
    const w = this.world;
    const r = w.ball_radius;
    if (this.ball_in_hand_kitchen && x > w.width / 2.0) return false;
    if (!(r <= x && x <= w.width - r && r <= y && y <= w.height - r)) return false;
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
    if (this.winner !== null) return { error: "game over" };
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
    const eight_sunk = pocketed.includes(EIGHT);

    const fouls = [];
    if (cue_sunk) fouls.push("CUE_BALL_POCKET");
    if (first === null) fouls.push("CUE_BALL_HIT_NO_BALL");
    else {
      const legal_first = this.legal_first_contact(player);
      if (!legal_first.includes(first)) fouls.push("CUE_BALL_HIT_WRONG_BALL");
    }

    if (this.ball_in_hand_kitchen) { // this shot was the break
      const balls_to_rail = w.rail_hit.size;
      if (pocketed.length === 0 && balls_to_rail < 4) {
        fouls.push("CUSHION_HIT_MIN_ON_BREAK");
      }
      this.ball_in_hand_kitchen = false;
    }

    // premature 8-ball = loss
    if (eight_sunk && !this.cleared_group(player)) {
      this.winner = opp;
      this.message = `Player ${player + 1} pocketed the 8 too soon — Player ${opp + 1} wins!`;
      this.foul = true;
      return { foul: true, loss: true, winner: opp, pocketed, first, fouls };
    }

    for (const n of pocketed) {
      if (n !== 0) this.pocketed.add(n);
    }

    if (this.open && fouls.length === 0) {
      const obj = pocketed.filter(n => SOLIDS.includes(n) || STRIPES.includes(n));
      if (obj.length > 0) {
        const first_obj = obj[0];
        const grp = SOLIDS.includes(first_obj) ? "solid" : "stripe";
        this.groups[player] = grp;
        this.groups[opp] = grp === "solid" ? "stripe" : "solid";
        this.open = false;
      }
    }

    if (eight_sunk && this.cleared_group(player)) {
      this.winner = player;
      this.message = `Player ${player + 1} sinks the 8 and wins!`;
      return { foul: false, win: true, winner: player, pocketed, first, fouls };
    }

    const potted_own = this._potted_own(player, pocketed);
    const fouled = fouls.length > 0;
    this.foul = fouled;
    if (fouled) {
      this.consecutive_fouls[player] += 1;
      this.ball_in_hand = true;
      if (cue_sunk) this._respot_cue();
      else this.ball_in_hand_kitchen = false;
      this.message = (`Player ${player + 1} foul `
        + `(${fouls.join(", ")}). Ball in hand to Player ${opp + 1}.`);
      this.current = opp;
    } else {
      this.consecutive_fouls[player] = 0;
      this.ball_in_hand = false;
      if (potted_own) {
        this.message = `Player ${player + 1} pots and continues.`;
      } else {
        this.message = `Player ${player + 1} misses. Turn to Player ${opp + 1}.`;
        this.current = opp;
      }
    }
    return { foul: fouled, pocketed, first, potted_own, fouls, turn: this.current };
  }

  _potted_own(player, pocketed) {
    if (this.open) {
      return pocketed.some(n => SOLIDS.includes(n) || STRIPES.includes(n));
    }
    const g = this.groups[player];
    if (g === "solid") return pocketed.some(n => SOLIDS.includes(n));
    if (g === "stripe") return pocketed.some(n => STRIPES.includes(n));
    return false;
  }

  _respot_cue() {
    const w = this.world;
    const r = w.ball_radius;
    let cue = this.cue();
    if (cue === null) {
      cue = new Ball(0, 0, r, MASS, 0, "cue");
      w.addBall(cue);
    }
    let x = w.width * 0.25, y = w.height / 2.0;
    while (w.balls.some(b => b !== cue && !b.pocketed &&
      Math.hypot(b.x - x, b.y - y) < 2 * r)) {
      x += r;
      if (x > w.width / 2.0) { x = w.width * 0.25; y += r; }
    }
    cue.x = x; cue.y = y;
    cue.pocketed = false;
    cue.vx = cue.vy = 0.0;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { EightBallGame, SOLIDS, STRIPES, EIGHT, RACK_ORDER };
}
