# 文档索引

[English](/docs/INDEX.md) | 中文

本索引是理解 hyprscope 做什么、怎么设计以及为什么这样设计的入口。文档是契约，代码实现契约；阅读时只看英文一侧即可，中文一侧是相同的内容。

## 1. 按顺序阅读

每份在范围内的文档都会出现在这个清单里；如果 `docs/` 下的文档没有列在这里，或这里列出的文档已经不存在，一致性检查会失败。

1. [README.md](/README.zh.md) —— 定位、功能集合、两个面（只读面与控制面）与快速开始。
2. [PROTOCOL.md](/docs/PROTOCOL.zh.md) —— 观察什么、如何报告：快照、坐标、事件流、错误码、能力报告；§8–§9 声明控制面。
3. [LEASE.md](/docs/LEASE.zh.md) —— 控制为什么需要经过同意：生命周期、状态与文件、兜底链条、边界（"为什么不拦截输入"）与限制。
4. [PLAN.md](/docs/PLAN.zh.md) —— 计划 schema、前提与预期、操作、干扰策略、恢复、fault 记录、同意绑定、限制与非目标。
5. [BASELINE.md](/docs/BASELINE.zh.md) 和 [COMPATIBILITY.md](/docs/COMPATIBILITY.zh.md) —— 没有测量过的基线为什么拒绝控制：状态计算、读取规则、人工审批与收窄、漂移与陈旧判定。
6. [DESKTOP.md](/docs/DESKTOP.zh.md) —— agent 为什么拥有自己的嵌套 compositor：目标选择与寻址、生命周期、目录、同意、失败处理，以及它不是什么。
7. [DSH-PLUGIN.md](/docs/DSH-PLUGIN.zh.md) —— 面向 agent 的封装以及它为什么保持薄：六个工具、桌面消息提示与快捷键，以及安全边界如何成立。
8. [VERIFICATION.md](/docs/VERIFICATION.zh.md) —— 一次真机验证记录；它是那台机器上的证据，不是长期保证。

## 2. 动机写在哪里

设计意图是被写下来的，不靠代码暗示。去找那些点明动机的章节：定位（Positioning）、边界（Boundaries）、限制与非目标（Limits and non-goals）、它不是什么（What it is not）。不要只从代码推断意图。当文档与代码不一致时，测试确定行为、文档记录意图，因此同一次提交里两边一起改。

## 3. 契约与代码对照

| 领域 | 契约 | 代码 |
|---|---|---|
| 只读命令 | `docs/PROTOCOL.md` | `src/cli.ts` |
| 控制租约 | `docs/LEASE.md` | `src/lease/` |
| 计划语言 | `docs/PLAN.md` | `src/plan/` |
| 能力基线 | `docs/BASELINE.md`、`docs/COMPATIBILITY.md` | `src/compat/` |
| agent 桌面 | `docs/DESKTOP.md` | `src/desktop/` |
| DSH 插件与桌面消息 | `docs/DSH-PLUGIN.md` | `plugins/dsh-hyprscope/`、`src/message/`、`overlay/message/` |
