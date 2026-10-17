/*
 * physics.js — deterministic top-down 2D billiards physics.
 *
 * Faithful JavaScript port of src/physics.py (Python -> JS, 1:1 logic).
 * Reverse-engineering context lives in docs/REA_findings.md.
 * All functions/classes are global (classic script) so the sibling rule
 * modules and the Canvas app can reference them directly, and so this file
 * can also be loaded in Node for headless verification.
 */

// --- Constants sourced from REA findings (table units) --------------------
const BALL_RADIUS_8BALL = 11.0;
const POCKET_RADIUS_8BALL = 11.0;
const FIELD_8BALL = [572.0, 330.0];

const BALL_RADIUS_SNOOKER = 8.5;
const POCKET_RADIUS_SNOOKER = 5.0;
const FIELD_SNOOKER = [572.0, 310.0];

const MASS = 3.0;
const RESTITUTION_BALL = 0.9;
const RESTITUTION_CUSHION = 0.75;
const DAMPING = 0.45;            // per-second exponential linear decay (modeled)
const SLEEP_SPEED = 5.0;         // u/s; below this a ball is parked
const SOLVER_ITER = 20;

// --- geometry helpers ----------------------------------------------------
function _closestPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0.0) return [ax, ay];
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = Math.max(0.0, Math.min(1.0, t));
  return [ax + t * abx, ay + t * aby];
}

function _pointSegDist(px, py, ax, ay, bx, by) {
  const [cx, cy] = _closestPointOnSegment(px, py, ax, ay, bx, by);
  return Math.hypot(px - cx, py - cy);
}

// --- Ball ----------------------------------------------------------------
class Ball {
  constructor(x, y, radius, mass = MASS, number = 0, kind = "object") {
    this.x = x;
    this.y = y;
    this.px = x;
    this.py = y;
    this.vx = 0.0;
    this.vy = 0.0;
    this.radius = radius;
    this.mass = mass;
    this.pocketed = false;
    this.number = number;
    this.kind = kind; // "cue","solid","stripe","eight","red","color"
  }
  speed() {
    return Math.hypot(this.vx, this.vy);
  }
  clone() {
    const b = new Ball(this.x, this.y, this.radius, this.mass, this.number, this.kind);
    b.vx = this.vx; b.vy = this.vy; b.pocketed = this.pocketed;
    return b;
  }
}

// --- World ---------------------------------------------------------------
class World {
  constructor(width, height, ball_radius, pocket_radius, pockets,
              restitution_ball = RESTITUTION_BALL,
              restitution_cushion = RESTITUTION_CUSHION,
              damping = DAMPING, sleep_speed = SLEEP_SPEED) {
    this.width = width;
    this.height = height;
    this.ball_radius = ball_radius;
    this.pocket_radius = pocket_radius;          // documented bloob value
    // Playability: bloob's literal hole.radius (5/11) is smaller than the ball,
    // so a shot aimed at a pocket misses. Capture within 1.5x the ball radius
    // (segment-based) for reliable, fair drops, and open a modest cushion gap.
    this.capture_radius = ball_radius * 1.5;
    this.gap = ball_radius * 1.1;
    this.pockets = pockets.map(p => [p[0], p[1]]);
    this.restitution_ball = restitution_ball;
    this.restitution_cushion = restitution_cushion;
    this.damping = damping;
    this.sleep_speed = sleep_speed;
    this.balls = [];
    this.first_contact = null;     // ball number cue hit first
    this.pocketed_this_shot = [];  // ball numbers pocketed this shot
    this.rail_hit = new Set();     // ball numbers that touched a cushion
    this.cushions = this._buildCushions(this.gap);
  }

  _buildCushions(gap) {
    const W = this.width, H = this.height;
    const segs = [];
    const mid = W / 2.0;
    for (const y of [0.0, H]) {
      segs.push([gap, y, mid - gap, y]);
      segs.push([mid + gap, y, W - gap, y]);
    }
    for (const x of [0.0, W]) {
      segs.push([x, gap, x, H - gap]);
    }
    return segs;
  }

  addBall(ball) { this.balls.push(ball); }

  cueBall() {
    for (const b of this.balls) {
      if (b.kind === "cue" && !b.pocketed) return b;
    }
    return null;
  }

  // -- simulation --------------------------------------------------------
  advance(h) {
    const decay = Math.exp(-this.damping * h);
    for (const b of this.balls) {
      if (b.pocketed) continue;
      b.px = b.x; b.py = b.y;
      b.x += b.vx * h;
      b.y += b.vy * h;
      b.vx *= decay;
      b.vy *= decay;
      if (b.speed() < this.sleep_speed) {
        b.vx = 0.0; b.vy = 0.0;
      }
    }
    const iters = Math.max(1, Math.floor(SOLVER_ITER / 10));
    for (let k = 0; k < iters; k++) this._collideBalls();

    for (const b of this.balls) {
      if (b.pocketed) continue;
      if (this._checkPockets(b)) continue;
      this._collideCushions(b);
    }

    // Safety net: never let a ball leave the table. Balls can thread the tiny
    // sliver of a corner pocket gap (gap diagonal slightly exceeds the capture
    // radius); if that happens they would fly off to infinity, and simulations
    // would never settle. Anything out of bounds is either a legitimate drop
    // (near a pocket) or is clamped back and bounced.
    for (const b of this.balls) {
      if (b.pocketed) continue;
      this._containBall(b);
    }
  }

  _containBall(b) {
    const r = b.radius, W = this.width, H = this.height;
    const out = (b.x < r) || (b.x > W - r) || (b.y < r) || (b.y > H - r);
    if (!out) return;
    for (const [px, py] of this.pockets) {
      if (Math.hypot(b.x - px, b.y - py) < this.capture_radius + this.gap + r) {
        b.pocketed = true;
        b.vx = 0.0; b.vy = 0.0;
        this.pocketed_this_shot.push(b.number);
        return;
      }
    }
    const e = this.restitution_cushion;
    if (b.x < r) { b.x = r; if (b.vx < 0) { b.vx = -b.vx * e; this.rail_hit.add(b.number); } }
    else if (b.x > W - r) { b.x = W - r; if (b.vx > 0) { b.vx = -b.vx * e; this.rail_hit.add(b.number); } }
    if (b.y < r) { b.y = r; if (b.vy < 0) { b.vy = -b.vy * e; this.rail_hit.add(b.number); } }
    else if (b.y > H - r) { b.y = H - r; if (b.vy > 0) { b.vy = -b.vy * e; this.rail_hit.add(b.number); } }
  }

  simulate(h = 1.0 / 480.0, max_steps = 8000) {
    let steps = 0;
    for (let k = 0; k < max_steps; k++) {
      this.advance(h);
      steps++;
      if (this.allResting()) break;
    }
    return steps;
  }

  beginShot() {
    this.first_contact = null;
    this.pocketed_this_shot = [];
    this.rail_hit = new Set();
  }

  allResting() {
    for (const b of this.balls) {
      if (!b.pocketed && b.speed() > 0.0) return false;
    }
    return true;
  }

  _collideBalls() {
    const n = this.balls.length;
    for (let i = 0; i < n; i++) {
      const a = this.balls[i];
      if (a.pocketed) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.balls[j];
        if (b.pocketed) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy;
        const rsum = a.radius + b.radius;
        if (dist2 >= rsum * rsum || dist2 === 0.0) continue;
        const dist = Math.sqrt(dist2);
        const nx = dx / dist, ny = dy / dist;
        const overlap = rsum - dist;
        const inv_a = 1.0 / a.mass, inv_b = 1.0 / b.mass;
        const corr = overlap / (inv_a + inv_b);
        a.x -= nx * corr * inv_a; a.y -= ny * corr * inv_a;
        b.x += nx * corr * inv_b; b.y += ny * corr * inv_b;
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn > 0.0) continue; // separating
        if (this.first_contact === null) {
          if (a.kind === "cue") this.first_contact = b.number;
          else if (b.kind === "cue") this.first_contact = a.number;
        }
        const e = this.restitution_ball;
        const jimp = -(1.0 + e) * vn / (inv_a + inv_b);
        a.vx -= jimp * inv_a * nx; a.vy -= jimp * inv_a * ny;
        b.vx += jimp * inv_b * nx; b.vy += jimp * inv_b * ny;
      }
    }
  }

  _checkPockets(b) {
    for (const [px, py] of this.pockets) {
      if (_pointSegDist(px, py, b.px, b.py, b.x, b.y) < this.capture_radius) {
        b.pocketed = true;
        b.vx = 0.0; b.vy = 0.0;
        this.pocketed_this_shot.push(b.number);
        return true;
      }
    }
    return false;
  }

  _collideCushions(b) {
    const r = b.radius;
    for (const [px, py] of this.pockets) {
      if (Math.hypot(b.x - px, b.y - py) < this.capture_radius + r) return;
    }
    for (const [ax, ay, bx, by] of this.cushions) {
      const [cx, cy] = _closestPointOnSegment(b.x, b.y, ax, ay, bx, by);
      const dx = b.x - cx, dy = b.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r || d2 === 0.0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;
      b.x = cx + nx * r; b.y = cy + ny * r;
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0.0) {
        const e = this.restitution_cushion;
        b.vx -= (1.0 + e) * vn * nx;
        b.vy -= (1.0 + e) * vn * ny;
        this.rail_hit.add(b.number);
      }
    }
  }

  shoot(ball, angle, speed) {
    ball.vx = Math.cos(angle) * speed;
    ball.vy = Math.sin(angle) * speed;
  }

  clone() {
    const w = new World(this.width, this.height, this.ball_radius,
      this.pocket_radius, this.pockets,
      this.restitution_ball, this.restitution_cushion,
      this.damping, this.sleep_speed);
    w.balls = this.balls.map(b => b.clone());
    return w;
  }

  activeBalls() { return this.balls.filter(b => !b.pocketed); }
}

function make8BallWorld() {
  const [W, H] = FIELD_8BALL;
  const pockets = [
    [0.0, 0.0], [W / 2.0, 0.0], [W, 0.0],
    [0.0, H], [W / 2.0, H], [W, H],
  ];
  return new World(W, H, BALL_RADIUS_8BALL, POCKET_RADIUS_8BALL, pockets);
}

function makeSnookerWorld() {
  const g = 572.0, h = 310.0;
  const cx = g / 2.0, cy = h / 2.0;
  const raw = [
    [g / 2 - 5, h / 2 - 5], [0, h / 2 - 2.5], [-g / 2 + 5, h / 2 - 5],
    [g / 2 - 5, -h / 2 + 5], [0, -h / 2 + 2.5], [-g / 2 + 5, -h / 2 + 5],
  ];
  const pockets = raw.map(([x, y]) => [cx + x, cy + y]);
  return new World(g, h, BALL_RADIUS_SNOOKER, POCKET_RADIUS_SNOOKER, pockets);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    Ball, World, make8BallWorld, makeSnookerWorld,
    BALL_RADIUS_8BALL, POCKET_RADIUS_8BALL, FIELD_8BALL,
    BALL_RADIUS_SNOOKER, POCKET_RADIUS_SNOOKER, FIELD_SNOOKER,
    MASS, RESTITUTION_BALL, RESTITUTION_CUSHION, DAMPING, SLEEP_SPEED, SOLVER_ITER,
  };
}
