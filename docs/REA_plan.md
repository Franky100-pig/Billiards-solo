# REA 逆向计划：bloob.io 八球 / 斯诺克人机对局

目标：还原 bloob.io 的 **8 球** 与 **斯诺克**「人机对局」——核心是两块：
1. **球桌物理**：球半径、摩擦/衰减、球-球弹性碰撞、库边反弹、袋口判定。
2. **bot 决策**：面对一杆局面，枚举候选球与目标袋，模拟落点，按某种评分选杆。

## 合规边界（重要）
- bloob.io 是 **Kinglet Code 的闭源 / Proprietary** 产品。
- 做法：用 REA 拉取其**前端部署 JS 包**做静态分析，**提取思路、常量、启发式**；
  然后**从零重写** Python 实现。**不搬运其混淆源码，不使用其美术资源。**
- 仓库 MIT、public，仅作学习与工程练习。

## 目标路由（REA）
- 目标类型：浏览器 SPA，游戏逻辑在部署的前端 JS 包里（静态 HTML 无脚本，需下载 bundle）。
- 工具：`analyze_javascript_application`（静态，无需 Hopper/Ghidra；本机这三个引擎也都未装）。
- 入口 URL：`https://bloob.io/8ballpool` 与 `https://bloob.io/snooker`。

## 步骤
1. **Recon（T2）**：定位游戏 bundle 的真实 URL / asset host，下载到本地 `artifacts/`。
2. **静态分析（T3）**：跑 `analyze_javascript_application`，产出 `docs/REA_findings.md`，
   每条结论标注 观察 / 推断 / 未知 并引用 Evidence ID。重点找：
   - 物理常量（球半径、台尺寸、恢复系数、摩擦/滚动阻力、袋口半径）。
   - 碰撞与积分模型（定步长？连续？子步数？）。
   - bot 选杆：候选生成、是否做前向模拟、评分权重（角度/距离/难度/安全球）。
   - 规则实现：8 球分组判定、犯规；斯诺克红球/彩球轮换与罚分。
3. **实现（T4-T6）**：把提取的常量与启发式落成自己的 pygame 物理引擎与 AI。
4. **验证（T7）**：离线跑通一局 8 球与一局斯诺克。

## 已知约束
- 本机 `rea` MCP 已连（6.3.0，139 工具 / 59 可用），但 12 个工具因缺 Hopper/Ghidra/IDA 不可用
  （仅影响 native 反编译，本次纯 JS 分析不受影响）。
- `analyze_javascript_application` 需要**本地目录或 ASAR**；必须先下载再分析。
