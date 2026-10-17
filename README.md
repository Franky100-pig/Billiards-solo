# Billiards-solo

Offline 8-ball & snooker vs-AI — as a **zero-dependency offline web page** *and* a pygame desktop app.

A reverse-engineering study of [bloob.io](https://bloob.io)'s human-vs-bot play: analyse the front end to
extract physics constants and bot heuristics, then **reimplement everything from scratch** (no obfuscated
source or art is copied).

![Menu](docs/screenshots/menu.png)

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

For every legal target ball × pocket it computes the **ghost-ball** contact point, checks that both the
cue→ghost and target→pocket paths are clear, simulates the shot on a clone of the world, and scores the
outcome. It picks the best makeable pot, or plays a safety when none exists. Difficulty tiers change aim
noise and search depth. The physics is framework-agnostic, so the bot runs headless.

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

- **Logic (Node, headless): 14/14** — physics settles; a full 8-ball frame completes; **no ball ever leaves
  the table**; snooker reds decrement consistently; colours pot in ascending order.
- **UI wiring (headless DOM/Canvas): 20/20** — menu → start → place → aim → shoot → resolve → bot turn, for
  both modes, plus the game-over overlay.
- Screenshots above are real renders captured with headless Chrome.

## Scope / progress

- [x] Repo & offline skeleton
- [x] REA recon + static analysis (`docs/REA_findings.md`)
- [x] Physics engine (Python + JS)
- [x] 8-ball rules + AI
- [x] Snooker rules + AI
- [x] pygame desktop UI
- [x] **Zero-dependency offline web build (Canvas 2D)**
- [x] Offline verification: 8-ball and snooker can be played to completion

## Disclaimer

Learning / engineering exercise. Gameplay inspiration comes from bloob.io (Kinglet Code, closed source);
**all code here is independently rewritten** and contains no bloob proprietary source or art.

---

## 中文简介

离线八球 / 斯诺克人机对战。现在提供**零依赖离线网页**：直接双击 `web/index.html` 即可在浏览器里玩，
无需安装、无需本地服务器、全程无网络。原有 `src/`（Python + pygame）桌面版逻辑完全一致，保留可用。
逆向结论、建模决策与三处移植中修复的 bug 见上文与 `docs/REA_findings.md`。

---

MIT License © 2026 Franky100-pig
