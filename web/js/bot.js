/*
 * bot.js — shared vs-AI opponent for 8-ball and snooker.
 * Faithful JS port of src/bot.py (ghost-ball aiming, path clearance,
 * cloned-world simulation, scoring, difficulty tiers).
 */

const DIFFICULTY = {
  easy:   { noise: 0.030, top_k: 3,  power_jitter: 0.20 },
  medium: { noise: 0.012, top_k: 8,  power_jitter: 0.10 },
  hard:   { noise: 0.0,   top_k: 99, power_jitter: 0.04 },
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

// --- geometry (reuses physics.js's global _pointSegDist) -----------------
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

function powerForDistance(dist) {
  return Math.min(1700.0, 360.0 + 5.5 * dist);
}

// --- core search ---------------------------------------------------------
function enumeratePots(world, cue, targets, pockets, r) {
  const cands = [];
  for (const t of targets) {
    for (const p of pockets) {
      const g = ghostAim(cue, t, p, r);
      if (g === null) continue;
      const angle = g[0], ghost = g[1];
      const cue_clear = pathClear(world, [cue.x, cue.y], ghost, [cue.number, t.number], r);
      const tgt_clear = pathClear(world, [t.x, t.y], p, [cue.number, t.number], r);
      if (!(cue_clear && tgt_clear)) continue; // only attempt clear pots
      const wc = world.clone();
      wc.beginShot();
      const cc = wc.cueBall();
      const dist = Math.hypot(ghost[0] - cue.x, ghost[1] - cue.y)
        + Math.hypot(p[0] - t.x, p[1] - t.y);
      wc.shoot(cc, angle, powerForDistance(dist));
      wc.simulate(1.0 / 300.0, 4500);
      cands.push({
        target: t.number, pocket: p, angle,
        cue_clear, tgt_clear,
        pocketed: wc.pocketed_this_shot.slice(),
        first: wc.first_contact,
        cue_sunk: wc.pocketed_this_shot.includes(0),
        ghost,
      });
    }
  }
  return cands;
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
function chooseShot(game, difficulty = "medium") {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  const world = game.world;
  const cue = game.cue();
  if (cue === null) return [0.0, 0.0];
  const r = world.ball_radius;
  const pockets = world.pockets;
  const targets = game.on_balls();

  const cands = enumeratePots(world, cue, targets, pockets, r);
  const scorer = game.game_type === "8ball" ? score8ball : scoreSnooker;

  const scored = [];
  for (const c of cands) {
    let s = scorer(game, c);
    const on_nums = new Set(targets.map(b => b.number));
    if (c.first !== null && !on_nums.has(c.first)) s -= 150.0;
    scored.push([s, c]);
  }
  scored.sort((a, b) => b[0] - a[0]);

  const top_k = Math.max(1, cfg.top_k);
  const pool = scored.slice(0, top_k);
  if (pool.length > 0) {
    let s, c;
    if (difficulty === "easy" && pool.length > 1 && rand01() < 0.4) {
      const pick = pool[1 + Math.floor(rand01() * (pool.length - 1))];
      s = pick[0]; c = pick[1];
    } else {
      s = pool[0][0]; c = pool[0][1];
    }
    if (s > -50.0) {
      const angle = c.angle + randGauss(0, cfg.noise);
      const tpos = targetXY(game, c.target);
      const pw = powerForDistance(
        Math.hypot(c.ghost[0] - cue.x, c.ghost[1] - cue.y)
        + Math.hypot(c.pocket[0] - tpos[0], c.pocket[1] - tpos[1]));
      const pw2 = pw * (1.0 + randGauss(0, cfg.power_jitter));
      return [angle, Math.min(1800.0, Math.max(250.0, pw2))];
    }
  }
  return safetyShot(game, cue, targets, r, cfg);
}

function targetXY(game, number) {
  for (const b of game.world.balls) {
    if (b.number === number && !b.pocketed) return [b.x, b.y];
  }
  return [0.0, 0.0];
}

function safetyShot(game, cue, targets, r, cfg) {
  let best = null, best_d = 1e9;
  for (const t of targets) {
    const d = Math.hypot(t.x - cue.x, t.y - cue.y);
    if (d < best_d) { best_d = d; best = t; }
  }
  if (best === null) return [0.0, 300.0];
  let angle = Math.atan2(best.y - cue.y, best.x - cue.x);
  angle += randGauss(0, cfg.noise * 1.5);
  const pw = Math.min(900.0, 320.0 + 3.0 * best_d) * (1.0 + randGauss(0, cfg.power_jitter));
  return [angle, Math.max(250.0, pw)];
}

// expose the global helper name used above (so both browser & Node share it)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DIFFICULTY, chooseShot, enumeratePots, score8ball, scoreSnooker,
    safetyShot, botSeed, rand01, randGauss,
  };
}
