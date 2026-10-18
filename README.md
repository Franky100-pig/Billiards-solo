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

Four presses of **↓** put the tip on the bottom of the dial — the dot sits at 6 o'clock and the stroke is a
draw. This is the same dial the stroke animation and the physics read, not a separate indicator:

![draw, dialled with the down arrow](docs/screenshots/english.png)

### Controls
- **Ball-in-hand** — click/tap inside the allowed area to place the cue ball.
- **Aim** — just move the cursor. The aim is the ray **from the cue ball to the pointer**, so the line,
  the ghost ball and the cue all point where you are looking. (Clicking is not what aims.)
- **Power** — press anywhere to **lock** that direction, then drag **back** along the cue and release. The
  shot only ever uses the backward component of the drag, so loading power cannot change where you are
  pointing; a sideways or forward drag loads nothing. **Right-click** puts a loaded cue back down.
- **English (加塞)** — click/drag inside the spin dial on the right, or walk the tip with **↑ ↓ ← →**
  (up = follow, down = draw, left/right = side spin; **Shift** = a fine 0.05 step). The tip cannot leave
  the ball: overshooting slides it along the rim. **S** or a double-click re-centres, and **every stroke
  resets the tip to dead centre on its own** — english is consumed by the shot it was dialled in for and
  can never leak into the next one. The cue itself is drawn off-centre, matching the strike point.
- **R / Esc** — back to the menu.

This is how bloob's own input works: its `power(start, end, angle)` helper throws the pull away unless it is
within 90° of the cue, which is exactly why aiming and loading are two separate gestures there. The pull is
gamma-shaped (`power = min + frac^1.35 · range`), so the first third of the drag is a soft touch and only the
last stretch reaches a full stroke. A live `POWER n%` bar makes it easy to judge.

### Pacing

The table runs in **real time**: a fixed 240 Hz integration step, 4 substeps per 60 Hz frame — i.e. exactly
1/60 s of table time per frame, no matter how fast the display refreshes. (The earlier build ran 16 steps of
1/360 s per frame, so every ball moved **2.7× faster than reality** and collisions were over before you could
read them.) The speeds that come out are the physical ones: a medium stroke is ~200–400 units/s, i.e.
0.35–0.7 table-lengths a second, and such a ball takes 3–4 s to run the length of the table and settle.
A hard break takes ~8 s to play itself out, which is about right for fifteen balls on two rails.

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
- **Dropping into a pocket.** A potted ball is no longer deleted on the frame it is captured. It slides the
  last few units into the pocket, shrinks, fades, and disappears under a rim shadow clipped to the pocket
  mouth, while the pocket flashes a ripple and the cloth dims around it. Contact also sprays a short ring of
  spark dots at the impact point, so you can *see* which pair of balls touched and how hard.

![Pocket drop](docs/screenshots/pocket.png)

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
  js/physics.js          deterministic top-down physics (angular momentum, cloth slip, throw)
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

- Deterministic top-down 2D physics: circle-circle impulses, circle-segment cushion reflection, and
  **segment-based pocket capture** (so fast balls can't tunnel past a pocket). Fixed 1/240 s step, 2 contact
  passes per step, `I = ⅖ m r²`, restitution `0.93` ball-ball and `0.72` ball-cushion, speed damping
  `v *= 0.55 per second` (`DAMPING = 0.45`, the same figure bloob uses — see `docs/REA_findings.md`).
- Standard 8-ball: open table, group assignment, the meaningful foul set, premature-8 = loss, legal-8 = win.
- Standard snooker: 15 reds + 6 colours, red→colour scoring, colour re-spotting, ascending end-game order,
  foul penalty = `max(4, value of ball first hit, value of ball potted)`.

### Real angular momentum (draw / follow / throw)

bloob's own spin is cosmetic: the dial tweaks the contact material (`friction = 1 + 0.3·my`,
`restitution = .9 + .45·my`) and rotates the *cue ball's velocity* by `0.25·mx` radians once after the first
contact. Nothing ever gets an angular impulse, so a real draw shot is impossible there. This build replaces
it with the actual mechanics of a sphere on cloth:

- Every ball carries `(wx, wy)` — the rolling axis — plus `wz`, side spin about the vertical.
- The contact patch slips at `u = (vx − r·wy, vy + r·wx)`. While `u ≠ 0` the cloth applies Coulomb friction
  `a = μ_slip·g`, and the friction force also spins the ball up: the slip decays at `(1 + m r²/I) = 3.5×` the
  rate the linear velocity does. That factor is the whole reason a draw shot checks up and comes back.
- The strike point sets the spin directly: for tip offset `h` (fraction of the ball radius) at cue speed `v`,
  `w = 2.5·h·v/r`. `h = 0` is a stun, `h = 0.4` is natural roll, and `h < 0` is back-spin.
- Ball-ball contact applies a tangential friction impulse (`μ_ball = 0.055`), so a cut shot **throws** the
  object ball off the geometric line and a spinning cue ball is deflected by the throw it imparts.
- Cushions apply a tangential impulse too (`μ_cushion = 0.17`), so side spin bends the rebound angle instead
  of being decoration, and `wz` bleeds off as the ball runs along the rail.
- A ball is only parked when its **speed and its slip** are both small, so a stationary-looking ball with
  back-spin left still bites and rolls back.

> **Modelling note (playability):** bloob's literal `hole.radius` (5 / 11) is smaller than the ball, so a
> shot aimed at a pocket would miss. Capture radius is relaxed to **1.5× ball radius**. The damping model is
> not a guess any more: the real engine chunk (`PoolScene-*.js`) turned out to be statically reachable, and
> its `applyDamping` is Matter's `v *= (1 − d)^dt` at 240 Hz — which is exactly the per-second
> `v *= exp(−0.45·t)` used here. Both decisions are documented in `physics.py` / `docs/REA_findings.md` §9.

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

- **Physics & logic (Node, headless): 26/26** — the table settles; rolling advances exactly with travel; a
  full 8-ball frame completes; **no ball ever leaves the table**; the bot's strokes stay inside the power
  envelope and average well below the cap; snooker reds decrement consistently; colours pot in ascending
  order. Plus the new mechanics: a back-spin stroke **draws back**, a top-spin stroke **follows through**, a
  stun stops dead, side spin **throws** the object ball off line and **bends** the cushion rebound, and a
  coasting ball's speed follows `v₀·e^(−0.45 t)` to within a few per cent.
- **Position play & escapes (Node, headless): 6/6** — a deliberately snookered cue finds a one-rail kick that
  contacts the ball on, stays on the table, and the 8-ball / snooker frames still finish.
- **UI wiring (headless DOM/Canvas): 64/64** — menu → start → place → aim → pull → strike → resolve → bot
  turn, for both modes, plus the game-over overlay, a monotonic power curve from a soft tap to a full stroke,
  the spin dial setting the strike point, and ball-in-hand on both tables. The aim/power split has its own
  cases: pointing right aims right (not left), pointing up aims up, jitter sitting on the ball is ignored,
  pressing does not move the aim, the aim is identical before and after a full pull, and sideways/forward
  drags load exactly zero power.
- **Keyboard english (same suite)** — ↑ adds exactly one follow step and no side spin, ↓ undoes it to the
  bit, shift is a five-times finer step, twenty presses of ↑ park the tip at 12 o'clock and never off the
  ball, coming off the rim stays on the rim, arrows are prevented from scrolling the page and are inert
  while the balls roll, S re-centres, and **a stroke leaves the dial at dead centre**. End-to-end: the same
  shot fired from the centre and after five ↓ differ *only* in spin — the centre ball leaves with no rolling
  spin at all, the down-arrow ball leaves with a real backspin, and both settle without anything leaving the
  table.
- Screenshots above are real renders captured with headless Chrome.

The bot search is a **generator** that is drained in ~7 ms slices per frame, so choosing a shot never freezes
the page — the bot "thinks" while the table keeps rendering.

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
- [x] **True angular momentum physics** — draw, follow, stun, throw and spin-bent cushions
- [x] **Real-time pacing** (240 Hz, exactly 1/60 s per frame) and a clickable english dial
- [x] Pocket-drop animation, contact sparks and pocket ripples
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
力度落在 ~130–1000（上限 1350），只有开球是刻意发力。

**瞄准与发力分开**（和 bloob 一样）：鼠标移动就决定方向——瞄准线是**母球到鼠标的射线**，球杆、假想球、
预测线全都指向你看着的地方；按下只是**锁定**这个方向，之后往回拖才拉杆蓄力。蓄力只取"沿球杆往回"的那
一个分量，所以拉多大力都改不了方向，横着拖、往前拖都是 0，右键把拉满的杆放回去。gamma 曲线让前 1/3
是轻推、后段才到满杆，并实时显示 `POWER n%`。

**节奏**：台面现在按**真实时间**跑——固定 240 Hz 积分步长、每帧 4 个子步，也就是每帧恰好推进 1/60 秒
的台面时间。旧版本每帧跑 16 个 1/360 秒的步，等于所有球**快 2.7 倍**，碰撞在看清之前就结束了，这就是
"基础速度太快、反应不过来"的根因。

**碰撞**：每颗球都带真正的角速度（`wx, wy` 滚动轴 + `wz` 侧旋）。接触点打滑时台呢给的是库仑摩擦，
摩擦力同时把球"转"起来，所以滑移衰减比线速度衰减快 `1 + mr²/I = 3.5` 倍——这正是低杆能缩回来、高杆
能跟进的原因。球球接触带切向摩擦冲量（`μ = 0.055`），所以切球会**甩**目标球（throw），带旋的母球也会
被甩偏；库边同样有切向冲量（`μ = 0.17`），侧旋会真的改变反弹角，而不是装饰。球只有在**速度和滑移都
很小**时才会停下，所以"看着不动但还有后旋"的球会继续咬地往回滚。

**加塞**：右侧旋钮点一下就把击球点挪过去，拖到下面是**低杆**、上面是**高杆**、左右是**侧塞**；也可以
直接用 **↑ ↓ ← →** 一格一格走（每格 0.2 个球半径，按住 **Shift** 变成 0.05 的细调）。击球点不会走出球
体——越界会被投影回圆周上，所以一直按住 ↑ 会稳稳停在 12 点方向，而不是乱跳。双击旋钮或按 **S** 回中；
**每打完一杆都会自动回到正中心**，这杆调的塞不会被带到下一杆去。球杆画出来时也会偏离球心，和击球点
一致。击球点偏移 `h` 直接决定角速度 `w = 2.5·h·v/r`：正中心是定杆，往下四格就是真低杆。

**进袋**：进袋不再"一帧消失"。球会滑进袋口最后几个单位、缩小、淡出，并在一道裁剪到袋口的袋沿阴影下
消失，同时袋口泛起涟漪、附近台呢变暗；碰撞点还会溅出一圈短促的火花点，能看清是哪两颗球撞了、多重。

> 顺带一提：bloob 自己的加塞是"假"的——旋钮只改接触材质（`friction = 1 + 0.3·my`、
> `restitution = .9 + .45·my`），`mx` 只在第一次接触后把母球**速度**转 `0.25·mx` 弧度一次，全程没有任何
> 角冲量，所以它做不出真正的低杆。这里换成了真角动量（详见 `docs/REA_findings.md` §9、§11）。

---

MIT License © 2026 Franky100-pig
