/*
 * physics.js — deterministic top-down 2D billiards physics.
 *
 * Reimplementation of the model observed in bloob.io's runtime engine
 * (`PoolScene-*.js`: a Matter.js-style rigid-body solver, 240 Hz, 20 solver
 * iterations, restitution .9/.75, exponential air damping) — see
 * docs/REA_findings.md §9. No bloob code is copied; the solver here is an
 * independent impulse-based one.
 *
 * What makes this feel like real pool:
 *   - every ball carries linear velocity AND angular velocity (wx, wy = the
 *     rolling axis, wz = side spin about the vertical axis);
 *   - the cloth applies sliding friction while the contact patch slips, which
 *     is what turns back-spin into a draw shot and top-spin into follow;
 *   - ball-ball contacts apply a tangential (friction) impulse, so a cut shot
 *     throws the object ball and a spinning cue ball is deflected;
 *   - cushions apply a friction impulse too, so side spin changes the rebound
 *     angle instead of being cosmetic.
 *
 * All functions/classes are global (classic script) so the sibling rule
 * modules and the Canvas app can reference them directly, and so this file can
 * also be loaded in Node for headless verification.
 */

// --- Constants sourced from REA findings (table units) --------------------
const BALL_RADIUS_8BALL = 11.0;
const POCKET_RADIUS_8BALL = 11.0;
const FIELD_8BALL = [572.0, 330.0];

// Snooker uses STANDARD table proportions: a 12ft table plays 3569 x 1778 mm,
// i.e. exactly 2:1, with 52.5 mm balls. Scaled to a 620-unit playing surface
// the ball is ~9.1 units, so we use 9.0. (bloob's own snooker field was
// 572 x 310, a 1.85:1 ratio which does not look like a real snooker table.)
const BALL_RADIUS_SNOOKER = 8.5;
const POCKET_RADIUS_SNOOKER = 7.5;
const FIELD_SNOOKER = [620.0, 310.0];

// Standard snooker markings, expressed as fractions of the playing surface.
const SNOOKER_BAULK_X = 0.2065;   // fraction of table LENGTH
const SNOOKER_D_RADIUS = 0.1636;  // fraction of table WIDTH
const SNOOKER_BLACK_X = 0.9092;
const SNOOKER_PINK_X = 0.75;

const MASS = 3.0;
const RADIUS_RATIO = 2.0 / 5.0;   // I = 2/5 m r^2 for a solid sphere
const INV_RATIO = 1.0 / RADIUS_RATIO;

// Contact response. bloob ships .9 / .75 (materials.ballHitBall /
// ballHitCushion); a real phenolic ball on cloth is ~.93 and a rail ~.7, and
// the slightly deader rail is what stops shots rattling around for ever.
const RESTITUTION_BALL = 0.93;
const RESTITUTION_CUSHION = 0.72;

// bloob's `damping: .45` is Matter's frictionAir: v *= (1 - .45)^dt applied
// per 240 Hz substep, i.e. v *= 0.55 each second. We use the same per-second
// exponential so distances match: a ball coasts v0 / k units.
const DAMPING = 0.45;
const SLEEP_SPEED = 4.5;          // u/s; below this a ball is parked
const SOLVER_ITER = 2;            // contact passes per substep

// Friction coefficients. Ball-ball friction is small (a pool ball slaps rather
// than grips) but it is what produces throw on a cut; the cushion rubber grips
// more, which is how side spin kicks off a rail.
const BALL_FRICTION = 0.055;
const CUSHION_FRICTION = 0.17;

// Cloth friction while the ball slides on its contact patch. Big enough that a
// draw shot visibly comes back, small enough that a rolling ball is unaffected.
const SLIP_DECEL = 470.0;         // u/s^2
const SLIP_SNAP = 1.6;            // below this the ball is treated as rolling
const SPIN_DAMPING = 0.75;        // per-second decay of side spin
// The tip can only contact the ball within ~half a radius of centre without
// miscueing, and 0.4 R is exactly natural roll (w = v/r).
const SPIN_ZONE = 0.55;
const SPIN_DEFAULT = 0.5;         // dial position the bot strokes with

const TWO_PI = Math.PI * 2.0;

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

    // Angular velocity. (wx, wy) is the rolling axis in the table plane, wz is
    // side spin about the vertical axis. For a ball rolling in direction u at
    // speed v the no-slip state is w = (v/r) * (z x u), i.e. a ball moving +x
    // spins about +y. Slip is measured at the contact patch:
    //     u_slip = (vx - r*wy, vy + r*wx)
    // and the cloth kills that slip with Coulomb friction.
    this.wx = 0.0;
    this.wy = 0.0;
    this.wz = 0.0;

    // Presentation-only state for the rolling animation. `angle` is the angle
    // the ball has rolled through (radians, v*h/r accumulated) and (dirx,diry)
    // is the last direction it travelled in, so the renderer can slide the
    // painted pattern over the sphere. Never read by the rules or the bot.
    this.angle = 0.0;
    this.dirx = 1.0;
    this.diry = 0.0;
  }
  speed() {
    return Math.hypot(this.vx, this.vy);
  }
  /** Velocity of the contact patch relative to the cloth. */
  slip() {
    return [this.vx - this.radius * this.wy, this.vy + this.radius * this.wx];
  }
  clone() {
    const b = new Ball(this.x, this.y, this.radius, this.mass, this.number, this.kind);
    b.vx = this.vx; b.vy = this.vy; b.pocketed = this.pocketed;
    b.wx = this.wx; b.wy = this.wy; b.wz = this.wz;
    b.angle = this.angle; b.dirx = this.dirx; b.diry = this.diry;
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
    // Contact events for the presentation layer (rings / rail sparks). The bot
    // simulates on clones, so this never leaks into a search.
    this.fx = [];
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

  _fx(x, y, speed, kind) {
    if (this.fx.length >= 40) return;
    this.fx.push({ x, y, str: Math.min(1.0, speed / 900.0), kind });
  }

  // -- simulation --------------------------------------------------------
  advance(h) {
    const decay = Math.exp(-this.damping * h);
    const spin_decay = Math.exp(-SPIN_DAMPING * h);
    for (const b of this.balls) {
      if (b.pocketed) continue;
      this._clothFriction(b, h);
      b.vx *= decay;
      b.vy *= decay;
      b.wz *= spin_decay;

      b.px = b.x; b.py = b.y;
      b.x += b.vx * h;
      b.y += b.vy * h;

      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 1e-6) {
        // rolling without slipping: d(theta) = ds / r
        b.angle += (sp * h) / b.radius;
        if (b.angle > TWO_PI) b.angle -= TWO_PI;
        b.dirx = b.vx / sp;
        b.diry = b.vy / sp;
      }
      // A ball only rests when it is neither travelling NOR spinning against
      // the cloth: killing a slow ball that still carries draw spin would
      // silently eat the shot (and the cue ball would never come back).
      const slip = Math.hypot(b.vx - b.radius * b.wy, b.vy + b.radius * b.wx);
      if (sp < this.sleep_speed && slip < this.sleep_speed * 3.0) {
        b.vx = 0.0; b.vy = 0.0;
        b.wx = 0.0; b.wy = 0.0; b.wz = 0.0;
        // Settle the painted pattern face-up. A ball rolls through arbitrary
        // angles, so without this a ball can come to rest with its number
        // pointing at the floor and stay unreadable for the rest of the frame.
        b.angle = Math.round(b.angle / TWO_PI) * TWO_PI;
      }
    }

    for (let k = 0; k < SOLVER_ITER; k++) this._collideBalls();

    for (const b of this.balls) {
      if (b.pocketed) continue;
      if (this._checkPockets(b)) continue;
      this._collideCushions(b);
    }

    // Safety net: never let a ball leave the table. Balls can thread the tiny
    // sliver of a corner pocket gap; anything out of bounds is either a
    // legitimate drop (near a pocket) or is clamped back and bounced.
    for (const b of this.balls) {
      if (b.pocketed) continue;
      this._containBall(b);
    }
  }

  /**
   * Coulomb friction between the ball and the cloth, applied at the contact
   * patch. For a sphere the slip decays 3.5x faster than the ball decelerates
   * (1 + 5/2 from the moment of inertia), so a struck ball reaches pure rolling
   * in a fraction of a second — exactly the little "skid then roll" a real
   * ball does, and the reason draw and follow exist at all.
   */
  _clothFriction(b, h) {
    const R = b.radius;
    let ux = b.vx - R * b.wy;
    let uy = b.vy + R * b.wx;
    const us = Math.hypot(ux, uy);
    if (us < SLIP_SNAP) {
      // pure rolling: snap the spin to the velocity so nothing buzzes
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 1e-6) {
        b.wx = -(b.vy / R);
        b.wy = (b.vx / R);
      } else {
        b.wx = 0.0; b.wy = 0.0;
      }
      return;
    }
    // never overshoot the remaining slip inside one substep
    const dec = Math.min(SLIP_DECEL * h, us / (1.0 + INV_RATIO));
    const f = dec / us;
    const dvx = -ux * f;
    const dvy = -uy * f;
    b.vx += dvx;
    b.vy += dvy;
    b.wx += (INV_RATIO * dvy) / R;
    b.wy -= (INV_RATIO * dvx) / R;
  }

  _containBall(b) {
    const r = b.radius, W = this.width, H = this.height;
    const out = (b.x < r) || (b.x > W - r) || (b.y < r) || (b.y > H - r);
    if (!out) return;
    for (const [px, py] of this.pockets) {
      if (Math.hypot(b.x - px, b.y - py) < this.capture_radius + this.gap + r) {
        this._pocket(b);
        return;
      }
    }
    const e = this.restitution_cushion;
    if (b.x < r) { b.x = r; if (b.vx < 0) { b.vx = -b.vx * e; this.rail_hit.add(b.number); } }
    else if (b.x > W - r) { b.x = W - r; if (b.vx > 0) { b.vx = -b.vx * e; this.rail_hit.add(b.number); } }
    if (b.y < r) { b.y = r; if (b.vy < 0) { b.vy = -b.vy * e; this.rail_hit.add(b.number); } }
    else if (b.y > H - r) { b.y = H - r; if (b.vy > 0) { b.vy = -b.vy * e; this.rail_hit.add(b.number); } }
  }

  simulate(h = 1.0 / 240.0, max_steps = 6000) {
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
    this.fx.length = 0;
  }

  allResting() {
    for (const b of this.balls) {
      if (!b.pocketed && b.speed() > 0.0) return false;
    }
    return true;
  }

  _pocket(b) {
    b.pocketed = true;
    b.vx = 0.0; b.vy = 0.0;
    b.wx = 0.0; b.wy = 0.0; b.wz = 0.0;
    this.pocketed_this_shot.push(b.number);
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
        if (dist2 >= rsum * rsum) continue;
        const dist = Math.sqrt(dist2) || 1e-6;
        const nx = dx / dist, ny = dy / dist;
        const overlap = rsum - dist;
        const inv_a = 1.0 / a.mass, inv_b = 1.0 / b.mass;

        // positional correction (split evenly when the masses match)
        const corr = Math.max(0.0, overlap - 0.02) / (inv_a + inv_b);
        a.x -= nx * corr * inv_a; a.y -= ny * corr * inv_a;
        b.x += nx * corr * inv_b; b.y += ny * corr * inv_b;

        const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn > 0.0) continue; // separating

        if (this.first_contact === null) {
          if (a.kind === "cue") this.first_contact = b.number;
          else if (b.kind === "cue") this.first_contact = a.number;
        }

        // --- normal impulse -------------------------------------------
        const jn = -(1.0 + this.restitution_ball) * vn / (inv_a + inv_b);
        a.vx -= jn * inv_a * nx; a.vy -= jn * inv_a * ny;
        b.vx += jn * inv_b * nx; b.vy += jn * inv_b * ny;

        // --- tangential (friction) impulse: throw + spin transfer ------
        // t = z x n. Surface speed at the equator is v +- wz*r*t, so side
        // spin shows up directly in the relative tangential velocity.
        const tx = -ny, ty = nx;
        const vt = (rvx * tx + rvy * ty) - a.radius * (a.wz + b.wz);
        const inv_t = 1.0 / ((1.0 + INV_RATIO) * (inv_a + inv_b));
        let jt = vt * inv_t;
        const jmax = BALL_FRICTION * jn;
        if (jt > jmax) jt = jmax;
        else if (jt < -jmax) jt = -jmax;
        a.vx += jt * inv_a * tx; a.vy += jt * inv_a * ty;
        b.vx -= jt * inv_b * tx; b.vy -= jt * inv_b * ty;
        // d(wz) = r*jt / I with I = 2/5 m r^2  ->  2.5*jt/(m r)
        a.wz += (INV_RATIO * jt * inv_a) / a.radius;
        b.wz += (INV_RATIO * jt * inv_b) / b.radius;

        const impact = -vn;
        if (impact > 90.0) {
          this._fx(a.x + nx * (a.radius - overlap * 0.5),
                   a.y + ny * (a.radius - overlap * 0.5), impact, "ball");
        }
      }
    }
  }

  _checkPockets(b) {
    for (const [px, py] of this.pockets) {
      if (_pointSegDist(px, py, b.px, b.py, b.x, b.y) < this.capture_radius) {
        this._pocket(b);
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
      if (vn >= 0.0) continue;

      this.rail_hit.add(b.number);
      const e = this.restitution_cushion;
      b.vx -= (1.0 + e) * vn * nx;
      b.vy -= (1.0 + e) * vn * ny;

      // Friction on the rubber: this is what turns side spin into a change of
      // rebound angle ("the rail grabbed it") instead of a cosmetic effect.
      const m = b.mass;
      const tx = -ny, ty = nx;
      const vt = b.vx * tx + b.vy * ty - r * b.wz;
      const jn = (1.0 + e) * (-vn) * m;
      let jt = (m * vt) / (1.0 + INV_RATIO);
      const jmax = CUSHION_FRICTION * jn;
      if (jt > jmax) jt = jmax;
      else if (jt < -jmax) jt = -jmax;
      b.vx += (jt / m) * tx;
      b.vy += (jt / m) * ty;
      b.wz -= (INV_RATIO * jt) / (m * r);

      if (-vn > 70.0) this._fx(cx, cy, -vn, "rail");
    }
  }

  /**
   * Strike the cue ball.
   *
   * `spin` is the tip offset on the ball face, in units of the ball radius:
   *   spin[0] < 0 = left english, > 0 = right english
   *   spin[1] < 0 = draw (below centre), > 0 = follow (above centre)
   *
   * A cue strike at height h*r above the centre of mass gives
   *     w = 2.5 * h * v / r
   * (impulse through the centre: v = J/m, w = h*r*J / (2/5 m r^2)). So a dead
   * centre hit leaves NO spin — the ball skids, then the cloth rolls it — and
   * natural roll needs h = 0.4. The tip can only reach about half a radius from
   * centre without miscueing, hence SPIN_ZONE.
   *
   * bloob models english as a contact-material tweak (friction += .3*off,
   * restitution += .45*off) plus a 0.25*off rad rotation applied to the cue
   * ball after its first contact — cheap, but it cannot produce a real draw
   * shot. Here the offset becomes actual angular velocity, and the cloth
   * friction above does the rest.
   */
  shoot(ball, angle, speed, spin = null) {
    const sx = spin ? spin[0] : 0.0;
    const sy = spin ? spin[1] : SPIN_DEFAULT;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    ball.vx = ux * speed;
    ball.vy = uy * speed;

    const R = ball.radius;
    const h = Math.max(-1.0, Math.min(1.0, sy)) * SPIN_ZONE;
    const roll = 2.5 * h;                // 1.0 = pure rolling
    ball.wx = -(speed / R) * roll * uy;
    ball.wy = (speed / R) * roll * ux;
    ball.wz = (sx * speed * 0.55) / R;   // surface speed ~55% of cue speed
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
  const [W, H] = FIELD_SNOOKER;
  // Standard pockets: four corners plus the two middle pockets on the long
  // rails (which is why a snooker table is not a simple 6-hole rectangle).
  const pockets = [
    [0.0, 0.0], [W / 2.0, 0.0], [W, 0.0],
    [0.0, H], [W / 2.0, H], [W, H],
  ];
  return new World(W, H, BALL_RADIUS_SNOOKER, POCKET_RADIUS_SNOOKER, pockets);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    Ball, World, make8BallWorld, makeSnookerWorld,
    BALL_RADIUS_8BALL, POCKET_RADIUS_8BALL, FIELD_8BALL,
    BALL_RADIUS_SNOOKER, POCKET_RADIUS_SNOOKER, FIELD_SNOOKER,
    SNOOKER_BAULK_X, SNOOKER_D_RADIUS, SNOOKER_BLACK_X, SNOOKER_PINK_X,
    MASS, RESTITUTION_BALL, RESTITUTION_CUSHION, DAMPING, SLEEP_SPEED,
    SOLVER_ITER, BALL_FRICTION, CUSHION_FRICTION, SLIP_DECEL, SPIN_DAMPING,
    INV_RATIO,
  };
}
