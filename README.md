# Billiards-solo

Offline 8-ball & snooker vs-AI — as a **zero-dependency offline web page** *and* a pygame desktop app.

A reverse-engineering study of [bloob.io](https://bloob.io)'s human-vs-bot play: analyse the front end to
extract physics constants and bot heuristics, then **reimplement everything from scratch** (no obfuscated
source or art is copied).

![Menu](docs/screenshots/menu.png)

## Play online

| Host | Link |
|---|---|
| GitHub Pages | <https://franky100-pig.github.io/Billiards-solo/> |
| WorkBuddy | <https://billiards-solo.app.workbuddy.host/> |

Both serve the same static build from `web/` — no backend, no cookies, no tracking.

## Play — offline web (recommended)

No install, no local server, no network:

1. Open **`web/index.html`** in any modern browser (double-click it).
2. Pick **8-BALL** or **SNOOKER** and a difficulty.
3. Play against the built-in bot.

| 8-Ball | Snooker |
|---|---|
| ![8-ball](docs/screenshots/8ball.png) | ![snooker](docs/screenshots/snooker.png) |

### Controls
- **Ball-in-hand** — click/tap inside the allowed area to place the cue ball.
- **Aim & shoot** — press & hold, drag **away** from the cue (slingshot), release. Pull distance = power;
  the shot travels opposite the drag.
- **R / Esc** — back to the menu.

The drag is gamma-shaped (`power = min + frac^1.35 · range`), so the first third of the pull is a soft touch
and only the last stretch reaches a full stroke. A live `POWER n%` bar makes it easy to judge.

### Presentation

![Break](docs/screenshots/break.png)

- **Rolling balls.** Each ball carries a roll angle (`dθ = ds / r`, so it turns exactly as far as it travels).
  The number patch and the snooker sheen slide and squash across the sphere as it turns, and disappear behind
  the horizon when the ball has rolled past them; a soft ball-coloured comet tail trails anything moving fast.
  When a ball settles, the pattern eases face-up so the number is always readable at rest.
- **The cue.** A drawn cue — rosewood butt, linen wrap, joint collar, maple shaft, ivory ferrule, chalked tip
  — sits off the cue ball, pulls back as you drag and snaps through the ball on release. Its thickness scales
  with the ball radius, and it is shortened if the butt would leave the canvas.
- **The shot line.** The cue-ball path to first contact, the **ghost ball** at that contact point, the object
  ball's line (clipped to the first ball or cushion in the way, and pulsing the pocket when it is lined up),
  and the cue ball's deflection afterwards — all from pure geometry, recomputed every frame.

### Why it really is offline
- Plain classic `<script>` tags (no ES modules), so opening the file via `file://` works — **no `http.server` needed**.
- No network requests, no accounts, no cookies, no `localStorage`.

## Desktop version (pygame)

The original desktop build keeps the identical logic in Python:

```bash
pip install -r requirements.txt
python src/main.py
```

Same menu, controls and rules as the web build.

## Layout

```
web/                     offline web page — Canvas 2D, zero dependencies
  index.html
  css/style.css
  js/physics.js          deterministic top-down physics
  js/rules8ball.js       8-ball state machine (groups, fouls, win/loss)
  js/rulesSnooker.js     snooker state machine (reds/colours, re-spot, scoring)
  js/bot.js              ghost-ball AI (path clearance + cloned-world simulation)
  js/app.js              Canvas UI (menu, aim, HUD, turn flow)
src/                     pygame desktop build (same logic in Python)
docs/REA_findings.md     reverse-engineering findings & modelling decisions
```

## How the AI works

**Pot search.** For every legal target ball × pocket it computes the **ghost-ball** contact point, checks
that both the cue→ghost and target→pocket paths are clear, simulates the shot on a clone of the world, and
scores the outcome.

**Position play (走位).** Every simulated candidate also reports where the **cue ball came to rest**. The bot
then scores that resting position by asking "is there a clean pot available from here?" — it re-runs the
ghost-ball check from the new cue position against the balls that will be *on* next (group-aware for 8-ball,
phase-aware for snooker). A pot that leaves a good angle gets a bonus; a pot that leaves the cue snookered
gets a **penalty**, so the bot prefers a slightly harder pot that keeps position.

**Escape shots.** When nothing can be potted (blocked line, i.e. snookered), it mirrors each target across
every cushion to build **one-rail bank/kick** lines, simulates them, and plays the one that legally contacts
the ball that is on. A plain safety is the last resort.

**Measured power, not maximum power.** The old heuristic (`360 + 5.5 × distance`) was roughly ten times too
hot, so almost every shot saturated the cap and the bot smashed everything. With per-second exponential
friction a ball coasts exactly `v₀ / k` units, so the stroke a shot actually needs follows from the geometry:

```
power = k · (d_cue→ghost + d_object→pocket / cos(cut)) + 40
```

Thin cuts need proportionally more cue speed because only the normal component transfers. The result is short
positional strokes for short pots and a full stroke only when the table demands one — a full 8-ball frame now
strokes between roughly 130 and 1000 units instead of pinning 1350, and the break is the one shot that is
deliberately fired hard (`BREAK_8BALL = 950`, `BREAK_SNOOKER = 520`).

Difficulty tiers change aim noise, search depth and power jitter. The physics is framework-agnostic, so the
whole bot runs headless (that is how it is verified).

## Standard snooker table

The snooker table is built to real proportions rather than bloob's 1.85:1 field:

| Item | Standard | In game |
|---|---|---|
| Playing surface | 3569 × 1778 mm (**2:1**) | 620 × 310 units |
| Baulk line | 737 mm from baulk cushion (**0.2065 L**) | same fraction |
| The D | 292 mm radius (**0.1636 W**) | same fraction |
| Blue / pink / black | centre / 0.75 L / 324 mm off the top cushion | 0.5 / 0.75 / 0.9092 L |
| Yellow, green, brown | corners + middle of the D | same |

Rendering is standard snooker too: mahogany body, lighter rubber cushion band, green baize with a cloth
sheen, baulk line + D, the six spots, corner pockets larger than the middles, and plain glossy unnumbered
balls in the real snooker colours (ivory cue ball).

## Physics & rules highlights

- Deterministic top-down 2D physics: circle-circle elastic impulses, circle-segment cushion reflection,
  exponential friction, and **segment-based pocket capture** (so fast balls can't tunnel past a pocket).
- Ball-ball restitution `0.9`, ball-cushion `0.75`, mass `3`, sleep speed `5`, `20` solver iterations —
  constants extracted from bloob (see `docs/REA_findings.md`).
- Standard 8-ball: open table, group assignment, the meaningful foul set, premature-8 = loss, legal-8 = win.
- Standard snooker: 15 reds + 6 colours, red→colour scoring, colour re-spotting, ascending end-game order,
  foul penalty = `max(4, value of ball first hit, value of ball potted)`.

> **Modelling note (playability):** bloob's literal `hole.radius` (5 / 11) is smaller than the ball, so a
> shot aimed at a pocket would miss. Capture radius is relaxed to **1.5× ball radius**, and the friction
> model uses the standard per-second exponential decay (`v *= exp(-0.45·t)`) since the exact integration
> model is not statically reachable. Both decisions are documented in `physics.py` / `docs/REA_findings.md`.

## Fixed while porting to the web

The JavaScript port surfaced three genuine bugs that also affected the Python build; all are fixed in both:

1. **Balls could leave the table.** A fast ball could thread a sliver of a corner-pocket gap (gap diagonal
   slightly exceeds the capture radius), then fly off to infinity — simulations never settled. A hard
   containment safety net now captures out-of-bounds balls near a pocket and clamps/bounces anything else.
2. **The snooker cue ball started on the brown spot**, overlapping it and blocking every pot. The cue now
   starts offset inside the D.
3. **The red triangle was inverted**, so its wide back row overlapped the blue ball. The apex now faces the
   baulk end and the pack widens toward black.

## Verification

- **Logic (Node, headless): 23/23** — physics settles; rolling advances with travel; a full 8-ball frame
  completes; **no ball ever leaves the table**; the bot's strokes stay inside the power envelope and average
  well below the cap; snooker reds decrement consistently; colours pot in ascending order.
- **Position play & escapes (Node, headless): 6/6** — a deliberately snookered cue finds a one-rail kick that
  contacts the ball on, stays on the table, and the 8-ball / snooker frames still finish.
- **UI wiring (headless DOM/Canvas): 30/30** — menu → start → place → aim → pull → strike → resolve → bot
  turn, for both modes, plus the game-over overlay and a monotonic power curve from a soft tap to a full
  stroke.
- Screenshots above are real renders captured with headless Chrome.

## Scope / progress

- [x] Repo & offline skeleton
- [x] REA recon + static analysis (`docs/REA_findings.md`)
- [x] Physics engine (Python + JS)
- [x] 8-ball rules + AI
- [x] Snooker rules + AI
- [x] pygame desktop UI
- [x] **Zero-dependency offline web build (Canvas 2D)**
- [x] Standard-proportion snooker table, markings and ball set
- [x] Bot position play (走位) + one-rail escape shots
- [x] Rolling-ball animation, drawn cue and the full aiming aid
- [x] Measured bot power (no more "everything at maximum")
- [x] Offline verification: 8-ball and snooker can be played to completion
- [x] Hosted copies: GitHub Pages & WorkBuddy

## Disclaimer

Learning / engineering exercise. Gameplay inspiration comes from bloob.io (Kinglet Code, closed source);
**all code here is independently rewritten** and contains no bloob proprietary source or art.

---

## 中文简介

离线八球 / 斯诺克人机对战。现在提供**零依赖离线网页**：直接双击 `web/index.html` 即可在浏览器里玩，
无需安装、无需本地服务器、全程无网络。原有 `src/`（Python + pygame）桌面版逻辑完全一致，保留可用。
斯诺克台面按**标准 2:1 比例**重建（开球线 0.2065L、D 区半径 0.1636W、粉球 0.75L、黑球 0.9092L），
配木质台身、绿色台呢、开球线与 D 区、六个点位、角袋大于中袋、无色号的高光球体。
bot 除 ghost-ball 进球搜索外，新增**走位评估**（打完球后母球是否还有清晰下一杆）与**一库解球**救球，
被斯诺克时不再直接犯规。逆向结论、建模决策与移植中修复的 bug 见上文与 `docs/REA_findings.md`。

**画面**：球会真的滚（号码盘随滚动滑移、压扁、转到背面消失，停下时自动转正），快速移动带拖影；
球杆是完整的（紫檀后把、线缠、接牙、枫木前节、白铜先角、巧克杆头），拉杆时后撤、出杆时抽送；
瞄准辅助给出母球路径、假想球、目标球预测线（遇到球或库边就截断，正对袋口时袋口脉冲）和母球分离线。

**力度**：bot 不再"每杆最大力"。指数摩擦下球滑行距离恰为 `v₀/k`，于是所需速度可由几何直接算出
`power = k·(母球到假想球距离 + 目标球到袋距离 / cos(切角))`，薄球按法向分量补偿。实测一整局 8 球
力度落在 ~130–1000（上限 1350），只有开球是刻意发力。玩家侧拖拽用 gamma 曲线，前 1/3 是轻推，
后段才到满杆，并实时显示 `POWER n%`。

---

MIT License © 2026 Franky100-pig
