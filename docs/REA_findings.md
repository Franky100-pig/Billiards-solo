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
- **走位评估（REIMPLEMENTATION，自写）**：每个模拟候选都会记录**母球停点**，再用同一套幽灵球检查判断"从这个位置还有没有清晰下一杆"——按 **8 球分组 / 斯诺克阶段**推出"下一杆 on 球"，遍历其 × 袋口，取最好的通透度（距离越短越优）归一化到 0..1。落袋后无清晰下一杆时给**负分**，所以 bot 会宁愿选一杆略难但留得住位的球。权重：8 球 `+60`（死位 `-22`），斯诺克 `+6`（死位 `-2.5`）。
- **一库解球（REIMPLEMENTATION，自写）**：无可落袋候选时（被斯诺克），把每个目标球对**每条库边**做镜像，求"母球→镜像点"与库边线段的交点得到撞库点（沿入射方向回退一个球半径补偿），检查母→撞库点、撞库点→目标两条路径，再在克隆世界模拟；优先选**首球合法**的线路（+30，母球进袋 -300、漏球 -60、首球非法 -120）。都不可行才退回安全球。
- 难度档（`DIFFICULTY`）：easy/medium/hard 调整瞄准噪声、候选搜索深度、力度抖动；hard 几乎零噪声、全搜索。
- **力度模型（REIMPLEMENTATION，自写）**：旧公式 `360 + 5.5×距离` 比实际所需大约高一个数量级，几乎每杆都顶到上限（表现为 bot "每次都最大力"）。在每秒指数摩擦下，球恰好滑行 `v₀/k` 个单位，所以所需速度可直接由几何反解：`power = k·(母球→假想球 + 目标球→袋 / cos(切角)) + 40`，薄球按法向分量补偿（`cut` 下限 0.32）。实测一整局 8 球力度落在 ~130–1000（上限 1350），只有开球（`BREAK_8BALL=950` / `BREAK_SNOOKER=520`）是刻意发力。
- **表现层（REIMPLEMENTATION，与规则无关）**：`Ball.angle / dirx / diry` 记录滚动角（`dθ = ds/r`），供渲染把号码盘与高光沿球面滑移、压扁、转到背面时隐去；落定时角度归正到 `2π` 的整数倍，保证静止球的号码始终可读。该状态**从不被规则或 bot 读取**。

## 6. 未知 / 局限（UNKNOWN）与已决建模
- 碰撞积分公式（自研 vs Matter.js 风格）— **已确认，见 §9：Matter.js 系约束求解器**。我们移植时自写脉冲式求解器 + 切向摩擦冲量（见 §10）。
- bot 评分函数与难度档 — 引擎块里的 bot 仍未见（`bots:!0` 只有开关），只有物理/表现层被定位 → **自写幽灵球枚举 + 评分**（见 §5）。
- 旋转(english)是物理模拟还是纯表现层 — **已确认，见 §9.4**：bloob 用「接触材质 + 首次接触后转角」近似，不是真角动量。我们改为**真角动量**（ω / slip / 摩擦冲量），见 §10。
- `damping`(0.45) 的积分模型 — **已确认**：Matter 的 `applyDamping` 在每个 240 Hz 子步做 `v *= (1-0.45)^dt`，等价于 **v *= 0.55 每秒**（时间常数 1/0.598 s）。我们取同一量级的 `e^{-0.45t}`（0.638/秒），落点手感一致。
- `hole.radius`(5/11) 小于球半径 → 字面复刻下球几乎无法落袋 → **落袋捕获半径放宽为 1.5× 球半径**（袋口"嘴"略宽），保证可玩；库边缺口(gap)取 1.1× 球半径。
- 斯诺克状态一致性 → **红球落袋无论是否犯规都同步递减计数**；红球未清空前落袋彩球一律重摆（见 §4 "斯诺克状态一致性" 决策）。这是复刻过程中实测发现并修复的 bug（bot-vs-bot 时计数漂移导致卡死）。
- 高速球**可能从袋口缝隙逃出台面**（角袋缺口的对角长约 17.1 > 捕获半径 16.5，存在一条细缝）→ 增加**台面边界兜底**：出界且靠近袋口判定为落袋，否则夹回台内并按库边弹性反弹。修复后模拟必收敛、球永不离台（见 `_contain_ball`）。
- 斯诺克母球初始位置与棕球重合（均在 `baulk_x, H/2`）→ 母球改为在 D 区内偏移起步；红球三角架方向原本朝左（宽底压住蓝球）→ 改为**顶点朝开球端、向黑球方向张开**。
- **斯诺克台面尺寸/球组（REIMPLEMENTATION 决策，与 bloob 不同）**：bloob 的 `field` 为 572×310（1.85:1），**不是标准斯诺克比例**，画出来不像真台。改为标准 12ft 台比例 **2:1**（`620×310`），球半径 8.5（约 0.0137L，标准值 52.5/3569≈0.0147L，取小一点以保证 15 红三角与黑球之间不重叠），并按标准比例标定：开球线 `0.2065L`、D 区半径 `0.1636W`、蓝球 `0.5L`、粉球 `0.75L`、黑球 `0.9092L`（离顶库 324mm）、黄/绿在 D 区两端、棕球在 D 区中点。袋口位置改回**四角 + 两条长边中点**（标准 6 袋），角袋绘制半径大于中袋。

## 8. 引擎块定位（2026-10-17 补做，推翻原结论）
- 原先判断"引擎不在静态部署里"是**错的**：`PoolGame-*.js` 里有一句运行时 `import("./PoolScene-ajVjIEk9.js")`，随后 `new PoolScene({...})`。该块（95 KB）**就在同一个 `/assets/` 下**，之前扫的 116 个块里没有它，因为它是**动态 import、只在进房间时请求**。
- 同一句 import 还带了 `__vite__mapDeps([...])` 的完整依赖列表 —— 这就是"按哈希命名的私有包"的真身。
- 结论：bloob 的**物理 + 碰撞 + 加塞 + 落袋 + 回放**全在 `PoolScene` 这一个块里，已抓到并静态分析（E6）。bot 的搜索仍不在静态块中（只有 `bots:!0` 开关），仍属未知。

## 9. 引擎本体（OBSERVATION, E6 = `PoolScene-ajVjIEk9.js`）
### 9.1 是什么
- **Matter.js 系（v0.19 风格）的 2D 刚体引擎**内联在块里：`Constraint`（6 维 `G` 向量、`lambda`、`invMassSolve`、`warm start`）、`GSSolver`（`iterations/tolerance/frictionIterations`）、`Body.applyDamping/applyImpulse/integrate`、`sleepSpeedLimit`、`firstImpact` 恢复系数、`collisionGroup/collisionMask` 位掩码（`cueBall=1, poolBall=2, cushion=4, hole=8, fieldBorder=16`）。
- 步长 `stepDt = 1/240`；`solver.iterations = config.solverIterations (20)`、`tolerance = .01`、`setGlobalStiffness(1e8)`、`gravity=[0,0]`、`islandSplit=false`、`sleepMode=BODY_SLEEPING`。
- 每颗球 `new Body({mass:3, damping:.45, angularDamping:.9, sleepSpeedLimit:5})`，形状是 `circle(ball.radius)`。
- 一次击球 = `hitBall({type, position, velocity, angle, modifier})` → `body.applyImpulse([v·cosθ, v·sinθ])`（**不施加角冲量**）→ 预跑到全部球静止，把每帧位置写进 `Float64Array` 回放（这就是它的"确定性 + 可回放"）。

### 9.2 落袋
- `hole` 是半径 `hole.radius`（8 球 11 / 斯诺克 5）的**静态圆**，`collisionMask = poolBall|cueBall`；球心一进入就 `pocketBall()`：从世界移除、`pocketEvent`。**没有任何下沉动画**（表现层直接让球消失），所以"突兀"是它的原始行为，不必照抄。

### 9.3 阻尼
- `Body.applyDamping(dt)`：`v *= (1 - damping)^dt`，`ω *= (1 - angularDamping)^dt`，`dt` 直接是 1/240 秒。
- 因此 `damping .45` = **每秒 ×0.55**（`e^{-0.598t}`），`angularDamping .9` = 每秒 ×0.1。

### 9.4 加塞（modifier）—— 关键发现
- 输入是一个二维圆盘上的触点偏移 `modifier = [mx, my]`（`spin-selector` 组件，返回单位圆内的点）。
- **`my`（高低杆）不是角速度**，而是改**母球接触材质**：
  `contactMaterial.cueballHitBall.friction = 1 + 0.3*mx?` —— 实际为 `friction = material.friction + spin.frictionOffset(.3) * my`、`restitution = material.restitution + spin.restitutionOffset(.45) * my`，只对 `cueballHitBall` / `cueballHitCushion` 生效。
- **`mx`（左右塞）**：母球**第一次接触到球/库之后**，`_modifyAngle(cue, maxAngleModifier(.25) * mx)` 把母球速度方向旋转最多 0.25 rad，然后材质与 modifier 一起复位。
- 开球另有一条：`maxBreakAngleModifier(.6)` 用 seed 的每一位数字产生 `0.6*(digit/5-1)` 的角度扰动，每发生一次球-球碰撞就用一位 —— 即**开球撒点的随机性来自 seed，不是物理**。
- 结论：bloob 的加塞是**材质 + 角度修正的近似**，高低杆产生不了真正的缩杆回拉（它没有给球角速度）。我们理解其意图后**改用真实角动量**实现（§10），属于独立重写。

### 9.5 瞄准与力度（输入模型，OBSERVATION, E7 = `PoolGame-DjLak87n.js`）
输入状态对象：`J = {active, launcher, angle, angleOffset, power, velocity, ball, start, end}`。

- **方向＝母球到鼠标**。桌面端每次 `mousemove`：`J.angle = atan2(球屏幕Y - clientY, 球屏幕X - clientX)`
  （即"鼠标→球"方向）；开球时 `hitBall({ angle: J.angle + Math.PI, ... })`，所以**射出方向 = 球→鼠标**，
  球杆画在 `angle` 一侧（也就是你这一侧）。这是"瞄准线指向鼠标"的直接证据。
- **方向先定、力度后拉**。按下（非触摸左键）：`J.start = J.end = 鼠标`、`J.active = true`、`J.power = 0`；
  随后 `mousemove` 里 `if (J.active) { ... $e(...); return; }` 在更新角度**之前**返回，
  **拖动期间 `angle` 被冻结**，只有 `power` 会变。触摸端才用 `angleOffset` 边拖边瞄。
- **力度只认"往回"**：`Be({start, end, angle})` 先算拖动方向与 `angle` 的夹角差 `diff`，
  若 `diff ∈ (90°, 270°)`（即往球前方拖）直接返回 0，否则 `power = clamp01(dist / (max - min))`。
- **另有一个独立 launcher 控件**（`ze`）：横向拖条 `power = clamp01((start.x - end.x) / launcherSize)`，
  纯力度、不参与方向。
- 松手：`power > .05` 才 `hitBall`，否则只把 `power` 清零（空点不发射）。

结论：bloob 是"**先瞄准、再单独拉杆**"的两段式输入，方向与力度互不影响。原实现是"拖拽弹弓"——方向由拖动
向量反推、且拖动中一直在变，方向和力度耦合在一起，手感与 bloob 不同（见 §11.7 的改法）。

## 10. 复刻路线（我们怎么做）
1. 用 §2/§3 的常量 + 自写**确定性步进 2D 物理**（`src/physics.py`：top-down、无重力、圆-圆弹性碰撞、库边反弹、摩擦减速、袋口判定）。
2. 规则层照搬 §4：`src/rules_eightball.py`（八球）、`src/rules_snooker.py`（斯诺克）。
3. bot：`src/bot.py` 按"枚举候选(球, 袋, 接触点) → 路径贯通 → 自写模拟 → 评分"实现，难度档校准见 §5。
4. 界面/输入/渲染：`src/main.py`（pygame 菜单 + 瞄准/拉杆两段式输入 + 动画步进 + HUD）。
5. 全部代码独立重写，不含 bloob 专有代码/素材；bloob 原始 JS 仅在 `artifacts/`（被 `.gitignore` 排除，不入库）。
6. **离线网页（`web/`）**：把上述物理/规则/bot **逐行移植为纯 JavaScript**，UI 用 Canvas 2D 重写。刻意使用 classic `<script>`（非 ES module），因此 `file://` 直接双击即可运行，无需本地服务器、零依赖、零网络。
7. 验证：Node 无头跑逻辑不变量（26 项）+ 无头 DOM/Canvas 跑 UI 交互（41 项）；并用 headless Chrome 真实截图核对版式（见 `docs/screenshots/`）。
8. **斯诺克台面按标准样式重绘**：木质台身、比台呢略亮的库边胶条、绿色台呢带光泽、开球线与 D 区、六个点位、角袋大于中袋、无色号的高光球体（母球象牙白）。
9. **表现层**：球滚动（号码盘随角度滑移/压扁/隐去、高速拖影尾部渐细）、完整球杆（紫檀后把 + 线缠 + 接牙 + 枫木前节 + 白铜先角 + 巧克杆头，随球半径缩放、拉杆后撤、出杆抽送、贴边自动缩短以免被画布硬切）、瞄准辅助（母球路径 + 假想球 + 目标球预测线（遇球/库截断，正对袋口时袋口脉冲）+ 母球分离线）。8 球与斯诺克共用同一套木质台身渲染，只是袋口与标线不同。

> 建模决策（UNKNOWN 项）已在 §6 给出：摩擦用每秒指数衰减；落袋捕获半径放宽为 1.5× 球半径以保证可玩；
> 另加台面边界兜底、母球在 D 区内偏移起步、红球三角架方向修正。移植到网页时这三处真实 bug 一并修复（Python / JS 双端同步）。

## 11. 真实角动量物理（本次实现的模型）
> 目标：把"打了像弹珠"改成"打了像台球"。bloob 用材质/角度近似加塞（§9.4），我们自己按刚体力学写。

### 11.1 状态
每颗球除 `(x, y, vx, vy)` 外还有**角速度**：
- `(wx, wy)`：滚动轴（水平面内），无滑滚动时 `w = (v/r)·(ẑ×u)`，即沿 +x 前进的球绕 +y 转；
- `wz`：绕竖直轴的侧旋（左右塞）。
接触点相对台呢的**滑动速度** `u = (vx - r·wy, vy + r·wx)`；`u = 0` 才是纯滚动。
滚动角只用于渲染（号码盘滑移），从不参与规则/搜索。

### 11.2 台呢摩擦（缩杆/高杆从哪来）
滑动时按库仑摩擦处理：`a = μ·g` 方向与 `u` 相反；力矩使 `Δw = (5/2)·a/r`，于是
**滑动衰减速度是线速度衰减的 3.5 倍**（`1 + 5/2`）。击中球瞬间得到
`w = 2.5·h·v/r`（`h` = 杆头离球心的偏移，单位球半径），所以：
- 中杆 `h=0` → **没有旋转**，球先滑后滚（真台球就是这样）；
- `h=0.4` → 纯滚动；`h<0.4` → 前旋不足（滑），`h<0` → 回旋（缩杆）。
母球撞到目标球后线速度几乎全部让出，**残留的回旋让它在台呢上倒着滚回来** —— 这就是缩杆，不需要任何特判。高杆同理。
参数：`SLIP_DECEL = 470 u/s²`、`SPIN_ZONE = 0.55`（杆头够不到更边）、`SPIN_DAMPING = 0.75/s`。

### 11.3 球-球碰撞（切球会"甩"）
法向：`j = -(1+e)·v_n / (1/m₁+1/m₂)`，`e = 0.93`。
切向：按 `t = ẑ×n` 求接触点相对滑动
`v_t = (v₂-v₁)·t - r·(wz₁+wz₂)`，所需冲量 `j_t = v_t / (3.5·(1/m₁+1/m₂))`，
上限 `μ_ball·j_n`（`μ_ball = 0.055`）。冲量同时改两球的 `v` 与 `wz`。
效果：左右塞会把目标球**甩偏**（throw），母球反方向偏；无塞时目标球严格沿球心连线走。

### 11.4 库边
法向 `e = 0.72`；切向摩擦 `μ_cushion = 0.17`，接触点在 `-r·n`，摩擦冲量同时改 `v_t` 与 `wz`
（`Δwz = -2.5·j_t/(m·r)`）。效果：**侧旋会改变反弹角**，而不是只做装饰。

### 11.5 时间步
240 Hz 定步长（与 bloob 的 `stepDt` 一致），网页每帧 4 子步 = **正好 1/60 s 台面时间**。
旧版每帧推进 16×(1/360) = 44 ms，等于 **2.7 倍速播放**——这就是"球太快"的根因。

### 11.6 验证（Node 无头，26 项）
- 速度衰减严格等于 `v₀·e^{-0.45t}`；中杆起手无滑移；
- 缩杆：撞后母球 `vx < 0`；中杆：几乎停在触点；高杆：穿过去；三者顺序正确；
- 无塞时目标球 `|vy| < 1`；右塞使它 `+15 u/s` 以上、左塞反向、母球反向偏；左右对称误差 < 6；
- 正撞库：回弹 `vy` 在 0.72 倍区间、`vx≈0`；侧旋使 `|vx| > 20`；
- 满力开球：全部停稳、无球出台、无深度穿插。

### 11.7 输入：瞄准与力度解耦（对齐 §9.5）
旧实现是"弹弓"：`aim = atan2(-dy, -dx)`（拖动方向取反），且只在拖动中更新——方向要靠拖出来、拖动过程中
还一直在变，力度和方向天然耦合，看起来"反着来"。现在改成 bloob 的两段式：

- **悬停即瞄准**：`aim = atan2(mouseY - cueY, mouseX - cueX)`，直接是母球→鼠标；球杆、假想球、预测线都
  用同一个角，所以全都指向光标。
- **按下锁定**：`begin_pull(pos)` 只记录 `pull_from`，不改 `angle`；`_updatePull` 里不再写 `aim_angle`。
- **只认回拉分量**：`pull = clamp(-(Δ·û), 0, MAX_DRAG)`，`û = (cos aim, sin aim)`。横向/往前拖得 0，
  所以蓄力不可能改变方向（与 bloob 的 90° 判定等价，且更平滑）。
- **右键取消**：拉满的杆放回去，不发射。
- 触摸端没有 hover：按下点兼作瞄准（母球→手指），其余逻辑相同。
- 球杆后撤量改用 `pull_len / MAX_DRAG`（按实际拖动距离），而不是力度百分比，视觉上跟手一致。

验证（无头 DOM，41 项）新增：指右瞄右、指上瞄上、球上抖动不改变瞄准、按下不移动瞄准、拉满前后 `aim_angle`
完全一致、横向与往前拖力度严格为 0、回拉后力度可精确复现。

### 11.8 加塞的键盘输入与"每杆归零"

旋钮只能"点/拖"，细调很别扭；而且加塞值会一直留在那里，上一杆的低杆会悄悄影响下一杆。现在两条一起改：

- **方向键步进**：`↑` = 高杆、`↓` = 低杆、`←/→` = 左右塞，每格 0.2 个球半径；按住 **Shift** 变成 0.05。
- **不出球**：`|(sx, sy)| > 1` 时把向量**投影回单位圆**（`sx,m /= m`），而不是丢弃这一步。所以连按 20 次
  `↑` 会稳稳停在 12 点方向，继续按也只是贴着圆周；从圆周上再按 `↓` 会沿圆周滑下来（`x` 保持），
  手感是"指尖在球面上走"而不是二轴各管各的。
- **`preventDefault()`**：否则方向键会滚动页面。只在 `phase === "play" && 人类回合 && !simulating` 时生效。
- **每杆自动回中**：`_strike()` 在 `launch()` 之后立刻 `spin = SPIN_CENTER`（= `[0, 0]`，定杆）。
  击球动画另存一份 `strike_spin`，所以球在跑的时候球杆仍按原来那个击球点偏画，不会闪回中心。
  机器人出手也走 `_strike`，所以它的杆同样会归零，旋钮不会在机器人思考时显示上一杆的残留。
- 默认值由"略高于中心"（`[0, 0.45]`，约 0.62 倍自然滚动）改成**正中心**，与"回中"语义一致。

验证（无头 DOM，64 项）新增：↑ 恰好一步且无侧塞、↓ 精确抵消回 0、Shift 五分之一格、连按 20 次停在 12 点、
越界沿圆周滑、滚球时方向键无效、S 回中、击球后 `spin == [0,0]` 且 `strike_spin` 保留原值；
端到端对比"中杆 vs 连按五次 ↓"：两杆方向力度相同，中杆母球 `wy == 0`（定杆），低杆那杆 `wy < -3`（真后旋），
两杆都停稳且无球出台。
