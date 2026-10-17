# Billiards-solo

离线桌面台球（八球 + 斯诺克）人机对战。Python + pygame，纯本地运行，**无网络**。

这是一个对 [bloob.io](https://bloob.io) 八球 / 斯诺克「人机对局」的**逆向工程学习项目**：
分析其前端实现以提取物理常量与 bot 启发式，再**从零重写**实现（不搬运其混淆源码）。

> Offline desktop billiards (8-ball & snooker) vs-AI. A reverse-engineering study of
> bloob.io's human-vs-bot play, reimplemented from scratch in Python/pygame.

## 技术栈
- Python 3.11+ · pygame（2D 渲染，全本地）
- 确定性步进的物理引擎（自写，非照搬）
- 人机 AI：候选球枚举 + 模拟 + 评分选杆（自写）

## 范围 / 进度
- [x] 仓库与离线骨架（本步）
- [ ] 定位并下载 bloob 前端 JS 包（REA recon）
- [ ] REA 静态分析：物理常量 + bot 启发式（`docs/REA_findings.md`）
- [ ] 物理引擎：碰撞 / 摩擦 / 袋口 / 确定性步进
- [ ] 八球（WPA/UPA 风格）规则 + 人机 AI
- [ ] 斯诺克规则 + 人机 AI
- [ ] 离线运行验证

## 运行
```bash
pip install -r requirements.txt
python src/main.py
```

## 声明 / Disclaimer
本项目仅作学习与工程练习。玩法思路源自 bloob.io（Kinglet Code，闭源产品），
但**全部代码为独立重写**，不包含 bloob 的专有源码或美术资源。

---

MIT License © 2026 Franky100-pig
