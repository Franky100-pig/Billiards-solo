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
- **斯诺克计分（INFERENCE，标准规则）**：red=1，yellow=2，green=3，brown=4，blue=5，pink=6，black=7；红→彩轮换，罚分取 max(犯规值, 对应球值)。是否完全照搬 bloob 仍待引擎块确认。

## 5. Bot / AI（PARTIAL — 待引擎块定位后补全）
- 各台球模式 `bots:!0`（OBSERVATION, E4）；难度为设置项（`botDifficulty`）。
- bloob 的 AI 据推断为**前向模拟候选球 + 评分选杆**（依据：`simulatingPhysics` 状态 + 标准台球 AI 设计）。
- **尚未提取**：候选生成方式、评分权重、难度分级曲线、旋转(english)是否真参与物理。→ 后台扫描正定位共享引擎块（含物理 + 很可能含 bot）以补全。

## 6. 未知 / 局限（UNKOWN）
- 碰撞积分公式（自研 vs Matter.js 风格）— 引擎块未隔离前无法确认。
- bot 评分函数与难度档 — 同上。
- 旋转(english)是物理模拟还是纯表现层 — 待确认。

## 7. 复刻路线（我们怎么做）
1. 用 §2/§3 的常量 + 自写**确定性步进 2D 物理**（top-down、无重力、圆-圆弹性碰撞、库边反弹、摩擦减速、袋口判定）。
2. 规则层照搬 §4。
3. bot：先按"枚举候选(球, 袋, 接触点) → 自写模拟 → 评分"实现，待 §5 补全后用 bloob 思路校准难度。
4. 全部代码独立重写，不含 bloob 专有代码/素材。
