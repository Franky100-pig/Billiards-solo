/*
 * bot.js — shared vs-AI opponent for 8-ball and snooker.
 * Faithful JS port of src/bot.py, plus simple position play ("走位"):
 *
 *   1. ghost-ball pot search (target x pocket), simulated on a cloned world
 *   2. position scoring — where does the CUE BALL end up, and is there a
 *      clean pot available from there for the next shot?
 *   3. one-rail kick/escape search — when nothing can be potted (snookered),
 *      mirror the target across each cushion and try the bank line
 *   4. plain safety shot as the last resort
 */

const DIFFICULTY = {
  easy:   { noise: 0.030, top_k: 3,  sims: 8,  power_jitter: 0.20 },
  medium: { noise: 0.012, top_k: 8,  sims: 14, power_jitter: 0.10 },
  hard:   { noise: 0.0,   top_k: 99, sims: 20, power_jitter: 0.04 },
};

// how much "good next position" is worth, relative to potting a ball
const POSITION = {
  "8ball": { bonus: 60.0, dead: -22.0 },
  snooker: { bonus: 6.0,  dead: -2.5 },
};

// --- seedable RNG (mulberry32) so verification is reproducible ------------
let _rand = Math.random;
function botSeed(seed) {
  let s = seed >>> 0;
  _rand = function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rand01() { return _rand(); }
function randGauss(mu = 0, sigma = 1) {
  let u = 0, v = 0;
  while (u === 0) u = rand01();
  while (v === 0) v = rand01();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- geometry -------------------------------------------------------------
function pathClear(world, p0, p1, ignore, r) {
  for (const b of world.balls) {
    if (b.pocketed || ignore.includes(b.number)) continue;
    if (_pointSegDist(b.x, b.y, p0[0], p0[1], p1[0], p1[1]) < 2 * r) return false;
  }
  return true;
}

function ghostAim(cue, target, pocket, r) {
  const dx = pocket[0] - target.x, dy = pocket[1] - target.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return null;
  const ux = dx / d, uy = dy / d;
  const gx = target.x - ux * 2 * r, gy = target.y - uy * 2 * r;
  const cdx = gx - cue.x, cdy = gy - cue.y;
  const cd = Math.hypot(cdx, cdy);
  if (cd < 1e-6) return null;
  const angle = Math.atan2(cdy, cdx);
  return [angle, [gx, gy]];
}

/**
 * Power model.
 *
 * With per-second exponential friction v(t) = v0 * exp(-k t) a ball coasts
 * exactly v0 / k table units before it parks, so the speed needed to cover a
 * distance is simply k * distance. The old heuristic (360 + 5.5 * distance)
 * was ~10x too hot and saturated the cap on almost every shot — which is
 * exactly why the bot used to smash everything at maximum power. Deriving the
 * stroke from the geometry gives short, positional strokes for short pots and
 * a full stroke only when the table actually demands one.
 */
const FRICTION_K = (typeof DAMPING === "number") ? DAMPING : 0.45;
const POWER_MIN = 70.0;      // softest usable tap
const POWER_MAX = 1350.0;    // hardest break
const BREAK_8BALL = 950.0;
const BREAK_SNOOKER = 520.0;

/**
 * Speed required to send the cue `d1` units to the ghost ball and then the
 * object ball `d2` units on to the pocket at a cut angle of `cutCos`
 * (1 = dead straight, 0 = impossible thin cut). Only the normal component of
 * the impact transfers, so thin cuts need proportionally more cue speed.
 */
function powerForPot(d1, d2, cutCos = 1.0) {
  const cut = Math.max(0.32, Math.min(1.0, cutCos));
  const need = FRICTION_K * (d1 + d2 / cut) + 40.0;
  return Math.max(POWER_MIN, Math.min(POWER_MAX, need));
}

/** Keep the old name working (distance-only strokes: safeties, kicks). */
function powerForDistance(dist) {
  return powerForPot(dist, 0.0, 1.0);
}

/**
 * A stroke that touches a ball and then leaves everything short is a foul under
 * the standard "no cushion after contact" rule — the ball must be potted or
 * driven to a rail. Cheap to test: the world records both facts.
 */
function isSoftFoul(wc) {
  return wc.first_contact !== null
    && wc.pocketed_this_shot.length === 0
    && !wc.rail_after_contact;
}

/**
 * Fire the same line with more pace until the shot is legal. The bot must never
 * hand the table over by tapping the cue ball, so instead of scoring a soft
 * stroke badly, it simply refuses to play one: power goes up by 45% at a time
 * until something reaches a cushion or drops. Three tries is enough in practice;
 * if the line is hopeless the caller still gets the strongest version.
 */
function legalise(world, angle, power) {
  const sim = (pw) => {
    const wc = world.clone();
    wc.beginShot();
    wc.shoot(wc.cueBall(), angle, pw);
    wc.simulate(1.0 / 180.0, 4000);
    return wc;
  };
  let wc = sim(power);
  const start = power;
  for (let i = 0; i < 3 && isSoftFoul(wc); i++) {
    power = Math.min(POWER_MAX, power * 1.45);
    if (power === start) break;
    wc = sim(power);
  }
  return { wc, power, foul: isSoftFoul(wc) };
}

/** Mirror point p across the line a->b (used for one-rail bank shots). */
function reflectPoint(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-9) return [px, py];
  const t = ((px - ax) * abx + (py - ay) * aby) / l2;
  const cx = ax + t * abx, cy = ay + t * aby;
  return [2 * cx - px, 2 * cy - py];
}

/** Intersection of segment p0->p1 with segment a->b, or null. */
function lineIntersect(p0, p1, a, b) {
  const rx = p1[0] - p0[0], ry = p1[1] - p0[1];
  const sx = b[0] - a[0], sy = b[1] - a[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const apx = a[0] - p0[0], apy = a[1] - p0[1];
  const t = (apx * sy - apy * sx) / den;   // along p0->p1
  const u = (apx * ry - apy * rx) / den;   // along a->b
  if (t <= 0.02 || t >= 0.98) return null;
  if (u < -0.05 || u > 1.05) return null;
  return [p0[0] + t * rx, p0[1] + t * ry];
}

// --- what is "on" after a hypothetical shot -------------------------------
function nextTargets(game, wc, potted) {
  const alive = wc.balls.filter(b => !b.pocketed && b.number !== 0);
  if (game.game_type === "8ball") {
    const eight = alive.filter(b => b.number === 8);
    let grp = game.groups[game.current];
    if (game.open) {
      const solidPotted = potted.some(n => n >= 1 && n <= 7);
      const stripePotted = potted.some(n => n >= 9 && n <= 15);
      if (solidPotted && !stripePotted) grp = "solid";
      else if (stripePotted && !solidPotted) grp = "stripe";
    }
    if (grp === null) {
      const any = alive.filter(b => b.number !== 8);
      return any.length ? any : eight;
    }
    const isSolid = grp === "solid";
    const mine = alive.filter(b => b.number !== 8 && (b.number <= 7) === isSolid);
    return mine.length ? mine : eight;
  }
  // snooker
  const reds = alive.filter(b => b.kind === "red");
  const colors = alive.filter(b => b.kind === "color" && !game.colors_down.has(b.number));
  if (reds.length > 0) {
    const pottedRed = potted.includes(1);
    const pottedColor = potted.some(n => n >= 2 && n <= 7);
    if (pottedRed) {
      // a colour is on; any colour pocketed this shot is re-spotted, so fall
      // back to every colour still in play (slightly pessimistic on geometry)
      return wc.balls.filter(b => b.kind === "color" && !b.pocketed
        && !game.colors_down.has(b.number));
    }
    if (pottedColor) return reds;
    return reds.concat(colors);
  }
  if (colors.length === 0) return [];
  const low = Math.min(...colors.map(b => b.number));
  return colors.filter(b => b.number === low);
}

/**
 * How good is the cue ball's resting position? Returns 0..1, where 1 means
 * "there is a dead-straight short pot available for the next shot".
 */
function positionQuality(world, cueAfter, targets, pockets, r) {
  let best = 0.0;
  for (const t of targets) {
    for (const p of pockets) {
      const g = ghostAim(cueAfter, t, p, r);
      if (g === null) continue;
      const ghost = g[1];
      if (!pathClear(world, [cueAfter.x, cueAfter.y], ghost, [0, t.number], r)) continue;
      if (!pathClear(world, [t.x, t.y], p, [0, t.number], r)) continue;
      const d = Math.hypot(ghost[0] - cueAfter.x, ghost[1] - cueAfter.y)
        + Math.hypot(p[0] - t.x, p[1] - t.y);
      const q = Math.max(0.0, 1.0 - d / 700.0);
      if (q > best) best = q;
    }
  }
  return best;
}

/** Position bonus applied to a candidate shot (may be negative = dead leave). */
function positionBonus(game, wc, cueAfter, potted, r) {
  const cfg = game.game_type === "8ball" ? POSITION["8ball"] : POSITION.snooker;
  const targets = nextTargets(game, wc, potted);
  if (targets.length === 0) return cfg.bonus;              // frame is over / cleared
  const q = positionQuality(wc, cueAfter, targets, wc.pockets, r);
  return q > 0.0 ? cfg.bonus * q : cfg.dead;
}

// --- core search ---------------------------------------------------------
/**
 * Geometry pass: every (target, pocket) pair that is physically clear, with
 * the numbers the stroke will need. Doing all of this before any simulation
 * lets us simulate only the most promising handful — the search used to
 * simulate every candidate, which cost seconds per shot.
 */
function collectPots(world, cue, targets, pockets, r) {
  const out = [];
  for (const t of targets) {
    for (const p of pockets) {
      const g = ghostAim(cue, t, p, r);
      if (g === null) continue;
      const angle = g[0], ghost = g[1];
      if (!pathClear(world, [cue.x, cue.y], ghost, [cue.number, t.number], r)) continue;
      if (!pathClear(world, [t.x, t.y], p, [cue.number, t.number], r)) continue;
      const ux = Math.cos(angle), uy = Math.sin(angle);
      const ndx = t.x - ghost[0], ndy = t.y - ghost[1];
      const nd = Math.hypot(ndx, ndy) || 1.0;
      const cutCos = (ux * ndx + uy * ndy) / nd;
      if (cutCos < 0.12) continue;                 // thinner than this is a fluke
      const d1 = Math.hypot(ghost[0] - cue.x, ghost[1] - cue.y);
      const d2 = Math.hypot(p[0] - t.x, p[1] - t.y);
      out.push({
        target: t, pocket: p, angle, ghost, cutCos, d1, d2,
        power: powerForPot(d1, d2, cutCos),
        rank: cutCos - (d1 + d2) / 1500.0,
      });
    }
  }
  out.sort((a, b) => b.rank - a.rank);
  return out;
}

/**
 * Simulate the best candidates. A generator so the UI can spread the work over
 * frames ("bot is thinking") instead of blocking the animation loop for a
 * second; `chooseShot` below drains it synchronously for tests.
 */
function* enumeratePots(world, cue, targets, pockets, r, posFn, limit) {
  const geo = collectPots(world, cue, targets, pockets, r);
  const n = Math.min(geo.length, Math.max(1, limit | 0));
  for (let i = 0; i < n; i++) {
    const c = geo[i];
    const t = c.target, p = c.pocket;
    const { wc, power, foul } = legalise(world, c.angle, c.power);

    const cue_sunk = wc.pocketed_this_shot.includes(0);
    let cue_after = null, pos = 0.0;
    const cb = wc.cueBall();
    if (!cue_sunk && cb && !cb.pocketed) {
      cue_after = [cb.x, cb.y];
      if (posFn) pos = posFn(wc, cb, wc.pocketed_this_shot);
    }
    yield {
      target: t.number, pocket: p, angle: c.angle,
      cue_clear: true, tgt_clear: true,
      pocketed: wc.pocketed_this_shot.slice(),
      first: wc.first_contact,
      cue_sunk, ghost: c.ghost, cue_after, pos, foul,
      power, bumped: power > c.power + 1e-9, cut: c.cutCos,
    };
  }
}

/**
 * One-rail escape search: aim at the cushion so the cue ball banks into a
 * legal ball. Used when the direct pot line is blocked (snookered).
 */
function* escapeShots(game, world, cue, targets, r, posFn) {
  const pockets = world.pockets;
  const pool = targets
    .map(t => [Math.hypot(t.x - cue.x, t.y - cue.y), t])
    .sort((a, b) => a[0] - b[0])
    .slice(0, 4)
    .map(x => x[1]);

  for (const t of pool) {
    for (const seg of world.cushions) {
      const m = reflectPoint(t.x, t.y, seg[0], seg[1], seg[2], seg[3]);
      const I = lineIntersect([cue.x, cue.y], m, [seg[0], seg[1]], [seg[2], seg[3]]);
      if (I === null) continue;
      const dx = I[0] - cue.x, dy = I[1] - cue.y;
      const d1 = Math.hypot(dx, dy);
      if (d1 < 2 * r) continue;
      // aim a ball-radius short of the cushion so the reflection lands on I
      const ux = dx / d1, uy = dy / d1;
      const aim = [I[0] - ux * r, I[1] - uy * r];
      if (!pathClear(world, [cue.x, cue.y], aim, [cue.number, t.number], r)) continue;
      if (!pathClear(world, [I[0], I[1]], [t.x, t.y], [cue.number, t.number], r)) continue;

      const angle = Math.atan2(aim[1] - cue.y, aim[0] - cue.x);
      const path = d1 + Math.hypot(t.x - I[0], t.y - I[1]);
      // the cushion eats 25% of the speed, so ask for slightly more
      const want = Math.min(POWER_MAX, powerForPot(path / 0.75, 0.0, 1.0));
      const { wc, power } = legalise(world, angle, want);

      const cue_sunk = wc.pocketed_this_shot.includes(0);
      let pos = 0.0;
      const cb = wc.cueBall();
      if (!cue_sunk && cb && !cb.pocketed && posFn) pos = posFn(wc, cb, wc.pocketed_this_shot);

      let sc = 0.0;
      if (cue_sunk) sc -= 300.0;
      else if (wc.first_contact === null) sc -= 60.0;
      else if (!targets.some(x => x.number === wc.first_contact)) sc -= 120.0;
      else {
        sc += 30.0; sc += pos * 0.5;
        if (isSoftFoul(wc)) sc -= 80.0;
      }
      yield { score: sc, angle, power };
    }
  }
}

// --- per-mode scoring ----------------------------------------------------
function score8ball(game, c) {
  const potted = c.pocketed;
  if (c.cue_sunk) return -250.0;
  if (potted.includes(8)) {
    if (!game.cleared_group(game.current)) return -1000.0;
  }
  let own = [], opp = [];
  if (game.open) {
    own = potted.filter(n => (n >= 1 && n <= 7) || (n >= 9 && n <= 15));
  } else {
    const grp = game.groups[game.current];
    const isSolid = grp === "solid";
    own = potted.filter(n => ((n >= 1 && n <= 7) === isSolid) && n !== 8);
    opp = potted.filter(n => ((n >= 1 && n <= 7) !== isSolid) && n !== 8 && n !== 0);
  }
  let sc = 0.0;
  sc += 100.0 * own.length;
  sc -= 30.0 * opp.length;
  if (c.first === null) sc -= 200.0;
  else if (!game.open && !game.legal_first_contact(game.current).includes(c.first)) sc -= 120.0;
  if (c.cue_clear && c.tgt_clear && own.length > 0) sc += 25.0;
  if (potted.includes(8) && game.cleared_group(game.current)) sc += 500.0;
  return sc;
}

function scoreSnooker(game, c) {
  if (c.cue_sunk) return -300.0;
  const potted = c.pocketed.filter(n => n !== 0);
  const on_nums = new Set(game.on_balls().map(b => b.number));
  if (c.first === null || (!on_nums.has(c.first) && !game.free_ball)) return -200.0;
  let sc = 0.0;
  for (const n of potted) sc += game.value(n);
  if (c.cue_clear && c.tgt_clear && potted.length > 0) sc += 10.0;
  return sc;
}

// --- public API ----------------------------------------------------------
/**
 * True on the opening stroke, while the pack is still racked. The break is the
 * one shot where a full stroke is correct; every other shot is measured.
 */
function isBreakShot(game) {
  if (game.game_type === "8ball") {
    if (game.ball_in_hand_kitchen) return true;
    if (game.pocketed.size > 0) return false;
    return game.world.balls.every(b => b.number === 0 || b.pocketed
      || b.x > game.world.width * 0.55);
  }
  return game.reds_remaining >= 15;
}

/**
 * Pick a stroke. A generator: every simulated candidate yields, so the UI can
 * spend a few milliseconds per frame on the search (the bot visibly "thinks")
 * instead of freezing the animation loop. `chooseShot` below drains it for
 * headless use.
 */
function* shotSearch(game, difficulty = "medium") {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  const world = game.world;
  const cue = game.cue();
  if (cue === null) return [0.0, 0.0];
  const r = world.ball_radius;
  const pockets = world.pockets;
  const targets = game.on_balls();

  // 0) break: fire into the apex of the pack at a real break speed
  if (isBreakShot(game) && targets.length > 0) {
    // The apex is the ball nearest the cue — not the one deepest in the pack
    // (aiming at the back row walks the cue ball through the rack and into a
    // pocket, which is exactly what a break must never do).
    let apex = targets[0];
    let best = Math.hypot(apex.x - cue.x, apex.y - cue.y);
    for (const t of targets) {
      const d = Math.hypot(t.x - cue.x, t.y - cue.y);
      if (d < best) { best = d; apex = t; }
    }
    let angle = Math.atan2(apex.y - cue.y, apex.x - cue.x);
    angle += randGauss(0, cfg.noise * 0.5);
    const base = game.game_type === "8ball" ? BREAK_8BALL : BREAK_SNOOKER;
    const pw = base * (1.0 + randGauss(0, cfg.power_jitter * 0.5));
    return [angle, Math.max(POWER_MIN, Math.min(POWER_MAX, pw))];
  }

  const posFn = (wc, cueAfter, potted) => positionBonus(game, wc, cueAfter, potted, r);
  const scorer = game.game_type === "8ball" ? score8ball : scoreSnooker;

  const scored = [];
  for (const c of enumeratePots(world, cue, targets, pockets, r, posFn, cfg.sims)) {
    let s = scorer(game, c) + c.pos;
    const on_nums = new Set(targets.map(b => b.number));
    if (c.first !== null && !on_nums.has(c.first)) s -= 150.0;
    if (c.foul) s -= 120.0;
    scored.push([s, c]);
    yield;
  }
  scored.sort((a, b) => b[0] - a[0]);

  const top_k = Math.max(1, cfg.top_k);
  const pool = scored.slice(0, top_k);
  if (pool.length > 0 && pool[0][0] > -50.0) {
    let c;
    if (difficulty === "easy" && pool.length > 1 && rand01() < 0.4) {
      c = pool[1 + Math.floor(rand01() * (pool.length - 1))][1];
    } else {
      c = pool[0][1];
    }
    const angle = c.angle + randGauss(0, cfg.noise);
    // reuse the exact stroke the candidate was simulated with, so the bot's
    // read of its own shot stays honest; jitter models a human's touch
    // jitter models a human's touch, but a stroke that was given extra pace to
    // become legal must never jitter back below that threshold
    const jittered = c.power * (1.0 + randGauss(0, cfg.power_jitter));
    const pw = c.bumped ? Math.max(c.power, jittered) : jittered;
    return [angle, Math.min(POWER_MAX, Math.max(POWER_MIN, pw))];
  }

  // 2) nothing worth potting -> try a one-rail escape before a plain safety
  if (targets.length > 0) {
    const escapes = [];
    for (const e of escapeShots(game, world, cue, targets, r, posFn)) {
      escapes.push(e);
      yield;
    }
    if (escapes.length > 0) {
      escapes.sort((a, b) => b.score - a.score);
      const best = escapes[0];
      if (best.score > -50.0) {
        return [best.angle + randGauss(0, cfg.noise), best.power];
      }
    }
  }

  return safetyShot(game, cue, targets, r, cfg, world);
}

/** Synchronous wrapper (tests, bot-vs-bot, headless play). */
function chooseShot(game, difficulty = "medium") {
  const it = shotSearch(game, difficulty);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

function targetXY(game, number) {
  for (const b of game.world.balls) {
    if (b.number === number && !b.pocketed) return [b.x, b.y];
  }
  return [0.0, 0.0];
}

function safetyShot(game, cue, targets, r, cfg, world) {
  const w = world || game.world;
  // prefer a target we can actually reach in a straight line
  const reachable = [];
  for (const t of targets) {
    const d = Math.hypot(t.x - cue.x, t.y - cue.y);
    const clear = pathClear(w, [cue.x, cue.y], [t.x, t.y], [cue.number, t.number], r);
    reachable.push([clear ? 0 : 1, d, t]);
  }
  reachable.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (reachable.length === 0) return [0.0, 300.0];
  const best = reachable[0];
  const t = best[2];
  let angle = Math.atan2(t.y - cue.y, t.x - cue.x);
  angle += randGauss(0, cfg.noise * 1.5);
  // a safety is a touch shot: enough to reach the ball and push it to a rail
  const base = Math.min(POWER_MAX, FRICTION_K * best[1] * 1.25 + 45.0);
  const pw = base * (1.0 + randGauss(0, cfg.power_jitter));
  // A safety still has to be legal: if the touch dies before reaching a rail,
  // push it until one does.
  const fixed = legalise(w, angle, Math.max(POWER_MIN, pw));
  return [angle, fixed.power];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DIFFICULTY, POSITION, chooseShot, shotSearch, collectPots,
    enumeratePots, escapeShots, score8ball, scoreSnooker, safetyShot,
    positionQuality, positionBonus, nextTargets, botSeed, rand01, randGauss,
    powerForPot, powerForDistance, isBreakShot,
    POWER_MIN, POWER_MAX, BREAK_8BALL, BREAK_SNOOKER,
  };
}
