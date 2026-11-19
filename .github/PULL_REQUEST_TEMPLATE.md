# What changed / 改了什么

<!-- One paragraph. Link the issue it closes. / 一段话说清楚，关联对应的 issue。 -->

Closes #

# How it was verified / 怎么验证的

<!-- Paste the commands and the tail of their output. / 贴上命令和输出的末尾。 -->

- [ ] `pnpm test`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run check:consistency`
- [ ] `node scripts/pack-check.ts` (when packaging or the DSH bundle changed / 改到打包或 DSH 组合包时)
- [ ] Live Hyprland session / 真机 Hyprland（否则说明为什么可以跳过 / otherwise say why it is safe to skip）

# Documents / 文档

- [ ] Paired documents updated on both sides (`foo.md` and `foo.zh.md`) / 成对文档两侧都已更新
- [ ] Pair re-recorded: `python3 .agents/se/scripts/docs/verify_translation_pairing.py --write <pair>` / 已重录配对记录
- [ ] `docs/INDEX.md` updated if a document was added / 新增文档时已更新索引

# Boundaries / 边界

- [ ] Read-only commands still load no control code / 只读命令仍然不会加载控制代码
- [ ] Every desktop change still goes through the lease, the plan binding and the capability baseline / 桌面改动仍然走租约、计划绑定和能力基线
- [ ] No new runtime dependency / 没有新增运行时依赖

# Notes for the reviewer / 给审查者的说明

<!-- Trade-offs, things you deliberately did not do, follow-ups. / 取舍、刻意没做的事、后续计划。 -->
