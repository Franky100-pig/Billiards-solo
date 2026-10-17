# Billiards-solo

离线桌面台球（八球 + 斯诺克）人机对战。Python + pygame，纯本地运行，**无网络**。

这是一个对 [bloob.io](https://bloob.io) 八球 / 斯诺克「人机对局」的**逆向工程学习项目**：
分析其前端实现以提取物理常量与 bot 启发式，再**从零重写**实现（不搬运其混淆源码）。

> Offline desktop billiards (8-ball & snooker) vs-AI. A reverse-engineering study of
> bloob.io's human-vs-bot play, reimplemented from scratch in Python/pygame.

## 技术栈
- Python 3.11+ · pygame（2D 渲染，全本地）
- 确定性步进的物理引擎（自写：圆-圆弹性碰撞、库边反弹、指数摩擦、袋口判定）
- 人机 AI：幽灵球（ghost-ball）候选枚举 + 路径贯通检查 + 自写模拟 + 评分选杆

## 运行
```bash
pip install -r requirements.txt
python src/main.py
```
- 菜单选择 **八球 / 斯诺克** 与难度（easy / medium / hard）。
- **自由球（ball-in-hand）**：点击台面允许区域放置母球。
- **瞄准/出杆**：按住左键并**向后拖拽**（弹弓式），松开击球；拖拽距离 = 力度，方向为拖拽反方向。
- **R / Esc**：返回菜单。

## 逆向工程结论（要点）
详见 `docs/REA_findings.md`。关键事实：
- bloob 为 Vue 3 + Pinia + rolldown 的闭源 SPA；物理 + bot 引擎**不在静态部署中**（进房时按需加载 / 强混淆），无法静态定位。
- 已提取的**常量**（在 `physics.py` 中复刻）：8 球球半径 11 / 袋半径 11；斯诺克球半径 8.5 / 袋半径 5；质量 3；球-球弹性 0.9、球-库 0.75；无重力；休眠速度 5。
- 规则层（球组枚举、犯规枚举、胜负判定、斯诺克计分）按 bloob 的 `poolRackLogic` 与标准规则重写。

> **建模说明**：bloob 的 `damping`(0.45) 与 `solverIterations` 等仅出现在配置块、引擎不按字面读取这些键，
> 因此摩擦模型采用标准「每秒指数衰减」(`v *= exp(-0.45·t)`) 复刻；而 bloob 字面 `hole.radius`(5/11)
> 小于球半径、对准精度下几乎无法落袋，故落袋捕获半径放宽为 **1.5× 球半径**以保证可玩（见 `physics.py` 注释）。

## 范围 / 进度
- [x] 仓库与离线骨架
- [x] REA recon：定位并下载 bloob 前端 JS 包（存于 `artifacts/`，已被 `.gitignore` 排除，**不入库**）
- [x] REA 静态分析：物理常量 + 规则枚举（`docs/REA_findings.md`）
- [x] 物理引擎：碰撞 / 摩擦 / 袋口 / 确定性步进（`src/physics.py`）
- [x] 八球（WPA/UPA 风格）规则 + 人机 AI（`src/rules_eightball.py`）
- [x] 斯诺克规则 + 人机 AI（`src/rules_snooker.py`）
- [x] 共享 bot（`src/bot.py`）+ pygame 界面 / 菜单 / 输入 / 渲染（`src/main.py`）
- [x] 离线运行验证（8 球、斯诺克均可完整打完一局）

## 声明 / Disclaimer
本项目仅作学习与工程练习。玩法思路源自 bloob.io（Kinglet Code，闭源产品），
但**全部代码为独立重写**，不包含 bloob 的专有源码或美术资源。

---
MIT License © 2026 Franky100-pig
