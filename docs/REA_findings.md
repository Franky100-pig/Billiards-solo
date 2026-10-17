# REA Findings — bloob.io 八球 / 斯诺克人机对局

> 来源：bloob.io 前端部署 JS（闭源，Kinglet Code，Proprietary）。
> 方法：`curl` 下载前端 bundle → 静态分析（REA 思路）。**只记录观察/推断的事实与常量，不搬运源码。**
> 合规：仓库内的 `artifacts/` 含 bloob 原始 JS，已被 `.gitignore` 排除，**不入库、不公开**。

证据文件代号：
- **E1** = `artifacts/bloob/assets/poolGeneric-CkD_MP1Q.js`（8 球配置：物理 + 球桌 + 连接杆）
- **E2** = `artifacts/bloob/assets/Game-pI0zpS2H.js`（斯诺克 Game 壳，内联斯诺克物理/球桌常量）
- **E3** = `artifacts/bloob/assets/poolRackLogic-DO3WX2Yk.js`（球组枚举 / 8 球犯规枚举 / 胜负判定 / 斯诺克提示）
- **E4** = `artifacts/bloob/assets/game-DJQCDyWZ.js`（pool 注册表：游戏定义、`bots:!0`、Game→块映射、难度字段）
- **E5** = `artifacts/bloob/assets/Game-CCNP_3aA2.js`（8 球 Game 壳，指向共享引擎 `PoolGame` + `poolGeneric`）

---

## 1. 架构（OBSERVATION, E1–E5）
- bloob.io = **Vue 3 + Pinia + rolldown** 打包的 SPA（闭源）。
- 按游戏拆分：`Game-<hash>.js` 是**进房间才动态 import 的薄壳**，各台球游戏共享：
  - `PoolGame-<hash>.js`：台球 **Vue UI 组件**（相机 / 拉杆 / 旋转选择器 / 渲染 / `simulatingPhysics` 状态）。
  - `poolGeneric-<hash>.js`：**8 球配置**（物理、输入、球桌，见 E1）。
  - `poolRackLogic-<hash>.js`：**规则层**（球组枚举、犯规枚举、胜负判定、斯诺克提示，见 E3）。
  - `usePoolResources-<hash>.js`：素材加载器（仅 2KB）。
- 物理求解器本体**不在**上述任何文件：配置里的 `mass/damping/restitution/stiffness/solverIterations/gravityScale/allowSleep` 由某个被提升的**共享引擎块**消费（该块按哈希命名，正通过后台扫描定位，见 §5）。
- Game→块映射（OBSERVATION, E4）：`eightBallPool → Game-CCNP_3aA2.js`、`snooker → Game-pI0zpS2H.js`、`nineBallPool → Game-DWy3gxtD.js`、`cutthroatPool → Game-BQ3y4QcO.js`。

## 2. 物理常量 — 8 球（OBSERVATION, E1）
| 量 | 值 |
|---|---|
| 球半径 `ball.radius` | **11** |
| 袋口捕获半径 `hole.radius` | **11** |
| 球质量 `mass`（目标球 & 母球） | **3** |
| 线性阻尼 `damping` | **0.45** |
| 角阻尼 `angularDamping` | **0.9** |
| 休眠 `allowSleep` / `sleepSpeedLimit` | `true` / **5** |
| 重力 `gravityScale` | **0**（top-down，无重力） |
| 母球旋转 `spin` | `frictionOffset .3`、`restitutionOffset .45`、`maxAngleModifier .25` |
| 目标球 `maxBreakAngleModifier` | **0.6** |
| 材质 `ballHitBall` | `friction 1`、`restitution .9`、`stiffness 1e9` |
| 材质 `ballHitCushion` | `friction 1`、`restitution .75`、`stiffness 1e9` |
| `cueballHitBall` / `cueballHitCushion` | 同上加球 / 加库（restitution 球 .9 / 库 .75） |
| 求解迭代 `solverIterations` | **20** |
| 球桌 `field` | `width 572`、`height 330`、`thickness 15`、`size 28` |
| 拉杆/力度 `pull` | `distance 1..100`、`velocity 10..2000`、`breakVelocity 10..3500` |
| 库边 cushions | 6 条（bottomLeft/bottomRight/topLeft/topRight/left/right），含 `cornerSharp`/`cornerHalf` 角型 |

## 3. 物理常量 — 斯诺克（OBSERVATION, E2）
| 量 | 值 |
|---|---|
| 球半径 `ball.radius` | **8.5** |
| 袋口 `hole.radius` | **5** |
| `mass` / `damping` / `angularDamping` / `gravityScale` | 同 8 球（3 / .45 / .9 / 0） |
| 母球 `spin` | 同 8 球（.3 / .45 / .25） |
| 材质 restitution（球/库） | **.9 / .75**，`stiffness 1e9` |
| `solverIterations` | **20** |
| 球桌 `field` | `width 572`、`height 310`、`thickness 15` |
| 拉杆 `pull.velocity` / `breakVelocity` | `10..2000` / `10..3500` |
| 6 袋坐标（原点=台心，x∈[-286,286], y∈[-155,155]） | `(g/2−5, _/2−5)`,`(0, _/2−2.5)`,`(−286+5, _/2−5)`,`(g/2−5, −155+5)`,`(0, −155+2.5)`,`(−286+5, −155+5)`，`g=572,_=310` |

> 注：8 球与斯诺克**球半径、袋半径、台尺寸不同** → 两个模式是独立调参，不能共用一套数值。

## 4. 规则（OBSERVATION, E3 / INFERENCE 标注处）
- 球组枚举：`solid(1-7)`、`stripe(9-15)`、`eightBall(8)`；斯诺克：`red(×15)`、`yellow/green/brown/blue/pink/black`。
- **8 球犯规枚举（13 种）**：`CONSECUTIVE_FOULS_EXCEEDED`、`ILLEGAL_EIGHT_BALL_POCKET`、`ILLEGAL_EIGHT_BALL_POCKET_TOO_SOON`、`ILLEGAL_EIGHT_BALL_POCKET_ON_BREAK`、`CUE_BALL_POCKET`、`CUE_BALL_HIT_NO_BALL`、`CUE_BALL_HIT_WRONG_BALL`、`CUSHION_HIT_MIN_ON_BREAK`、`CUSHION_HIT_INVALID`、`POCKETED_WRONG_BALL`、`POCKETED_STRAY_COLOR`、`POCKETED_OWN_BALL`、`SKIP_TURN`。
- **8 球胜负（OBSERVATION, E3）**：当某一组（`solid`/`stripe`）的全部球都已落袋 → 该玩家胜（`groups[group].every(b => pocketed.includes(b))`）。
- **斯诺克计分（INFERENCE，标准规则）**：red=1，yellow=2，green=3，brown=4，blue=5，pink=6，black=7；罚分取 max(4, 犯规值, 对应球值)。是否完全照搬 bloob 仍待引擎块确认。
- **斯诺克"on 球"简化（REIMPLEMENTATION 决策）**：标准规则每杆红→彩轮换；**我们的复刻为可玩性简化为"红球清空前始终 on red（不强制每杆轮换），红球清空后按黄→黑升序收彩"**。`src/rules_snooker.py` 的 `on_balls()` / `phase` 据此实现。
- **斯诺克状态一致性（REIMPLEMENTATION 决策）**：红球一旦落袋即离台，**即便该杆犯规也同步递减 `reds_remaining`**（避免计数器与台面实际球数漂移导致 bot 追逐幽灵红球）；红球未清空前任何落袋的彩球一律重摆（不可留在台下）。

## 5. Bot / AI（复刻实现，见 §8）
- 各台球模式 `bots:!0`（OBSERVATION, E4）；难度为设置项（`botDifficulty`）。
- bloob 的 AI 据推断为**前向模拟候选球 + 评分选杆**（依据：`simulatingPhysics` 状态 + 标准台球 AI 设计）。
- **我们的复刻**（均自写，见 `src/bot.py`）：对每个合法目标球 × 每个袋，用**幽灵球（ghost-ball）**算出母球应到达的触点，做母→幽灵、目标→袋两条**路径贯通检查**；仅对几何通透的候选在克隆世界上模拟，再按模式评分：
  - 8 球：自己球组落袋 +100、对手球 -30、母球进袋 -250、未清组误落 8 直接 -1000、通透加 +25、清组后合法 8 球 +500。
  - 斯诺克：落袋按分值计分（红 1 / 黄 2 / 绿 3 / 棕 4 / 蓝 5 / 粉 6 / 黑 7）；犯规（母球进袋 / 首球非法 / 漏球）对手得 `max(4, 首球值, 落袋值)`。
  - 找不到可落袋候选时走**安全球**：轻碰最近的合法球、避免进袋。
  - 难度档（`DIFFICULTY`）：easy/medium/hard 调整瞄准噪声、候选搜索深度、力度抖动；hard 几乎零噪声、全搜索。

## 6. 未知 / 局限（UNKNOWN）与已决建模
- 碰撞积分公式（自研 vs Matter.js 风格）— 引擎块未静态定位，无法确认 → **我们采用标准脉冲式圆-圆弹性碰撞 + 库边反射**。
- bot 评分函数与难度档 — 同上 → **自写幽灵球枚举 + 评分**（见 §5）。
- 旋转(english)是物理模拟还是纯表现层 — 待确认 → **当前未实现旋转（纯直线母球）**，留作后续。
- `damping`(0.45) 的积分模型未知 → **采用标准每秒指数衰减** `v *= exp(-0.45·t)`（详见 `physics.py` 注释）；实测落点手感接近真实台球。
- `hole.radius`(5/11) 小于球半径 → 字面复刻下球几乎无法落袋 → **落袋捕获半径放宽为 1.5× 球半径**（袋口"嘴"略宽），保证可玩；库边缺口(gap)取 1.1× 球半径。
- 斯诺克状态一致性 → **红球落袋无论是否犯规都同步递减计数**；红球未清空前落袋彩球一律重摆（见 §4 "斯诺克状态一致性" 决策）。这是复刻过程中实测发现并修复的 bug（bot-vs-bot 时计数漂移导致卡死）。
- 高速球**可能从袋口缝隙逃出台面**（角袋缺口的对角长约 17.1 > 捕获半径 16.5，存在一条细缝）→ 增加**台面边界兜底**：出界且靠近袋口判定为落袋，否则夹回台内并按库边弹性反弹。修复后模拟必收敛、球永不离台（见 `_contain_ball`）。
- 斯诺克母球初始位置与棕球重合（均在 `baulk_x, H/2`）→ 母球改为在 D 区内偏移 `3r` 起步；红球三角架方向原本朝左（宽底压住蓝球）→ 改为**顶点朝开球端、向黑球方向张开**，粉球/黑球点位同步微调（6→0.72W、7→0.90W）。

## 8. 引擎/bot 源码未静态可达（重要结论）
- 已下载：8ballpool 静态 HTML 的全部 `/assets/*.js`（41 个）+ 台球相关专用块（`Game-*`、`PoolGame`、`poolGeneric`、`poolRackLogic`、`usePoolResources`）+ `app` 引用的全部 116 个块（含 `engine_hunt/` 全量扫描）。
- 物理引擎本体**不在任何静态块中**：`gravityScale/stiffness/solverIterations` 仅在配置块（E1/E2）出现，引擎不按字面读取这些键；也无 `.wasm`、无 `Matter/planck/box2d` 特征串。
- **推断**：物理 + bot 引擎是**进房间时才由运行时按需加载的私有包**（或强混淆），不在公开静态部署里。
- **处置（已与你确认"分析后自己重写"）**：物理用 §2/§3 常量 + 自写确定性步进引擎；bot 用"枚举候选(球,袋,接触点) → 自写模拟 → 评分"标准台球 AI 实现并校准难度。不搬运任何 bloob 源码/素材。

## 7. 复刻路线（我们怎么做）
1. 用 §2/§3 的常量 + 自写**确定性步进 2D 物理**（`src/physics.py`：top-down、无重力、圆-圆弹性碰撞、库边反弹、摩擦减速、袋口判定）。
2. 规则层照搬 §4：`src/rules_eightball.py`（八球）、`src/rules_snooker.py`（斯诺克）。
3. bot：`src/bot.py` 按"枚举候选(球, 袋, 接触点) → 路径贯通 → 自写模拟 → 评分"实现，难度档校准见 §5。
4. 界面/输入/渲染：`src/main.py`（pygame 菜单 + 弹弓式瞄准 + 动画步进 + HUD）。
5. 全部代码独立重写，不含 bloob 专有代码/素材；bloob 原始 JS 仅在 `artifacts/`（被 `.gitignore` 排除，不入库）。
6. **离线网页（`web/`）**：把上述物理/规则/bot **逐行移植为纯 JavaScript**，UI 用 Canvas 2D 重写。刻意使用 classic `<script>`（非 ES module），因此 `file://` 直接双击即可运行，无需本地服务器、零依赖、零网络。
7. 验证：Node 无头跑逻辑不变量（14 项）+ 无头 DOM/Canvas 跑 UI 交互（20 项）；并用 headless Chrome 真实截图核对版式（见 `docs/screenshots/`）。

> 建模决策（UNKNOWN 项）已在 §6 给出：摩擦用每秒指数衰减；落袋捕获半径放宽为 1.5× 球半径以保证可玩；
> 另加台面边界兜底、母球在 D 区内偏移起步、红球三角架方向修正。移植到网页时这三处真实 bug 一并修复（Python / JS 双端同步）。
