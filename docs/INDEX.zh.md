# 文档索引

[English](/docs/INDEX.md) | 中文

本索引（[INDEX.zh.md](/docs/INDEX.zh.md)）是理解 hyprscope 做什么、怎么设计以及为什么这样设计的入口。从 [README.zh.md](/README.zh.md) 开始：那里有定位、功能集合、两个面和快速开始。文档是契约，代码实现契约；阅读时只看英文一侧即可，中文一侧是相同的内容。下面的编号就是唯一的推荐阅读顺序：先 CLI 契约，再插件与标注面。

## 1. CLI 软件

CLI 就是产品本身：它观察桌面、掌握控制门控、执行经同意的计划。这些文档是它的契约，按这里的顺序阅读。

1. [PROTOCOL.md](/docs/cli/PROTOCOL.zh.md) —— 观察什么、如何报告：快照、坐标、事件流、错误码、能力报告；§8–§9 声明控制面，§11 记录插件驱动的标注会话。
2. [LEASE.md](/docs/cli/LEASE.zh.md) —— 控制为什么需要经过同意：生命周期、状态与文件、兜底链条、边界（"为什么不拦截输入"）与限制。
3. [PLAN.md](/docs/cli/PLAN.zh.md) —— 计划 schema、前提与预期、操作、干扰策略、恢复、fault 记录、同意绑定、限制与非目标。
4. [BASELINE.md](/docs/cli/BASELINE.zh.md) 和 [COMPATIBILITY.md](/docs/cli/COMPATIBILITY.zh.md) —— 没有测量过的基线为什么拒绝控制：状态计算、读取规则、人工审批与收窄、漂移与陈旧判定。
5. [DESKTOP.md](/docs/cli/DESKTOP.zh.md) —— agent 为什么拥有自己的嵌套 compositor：目标选择与寻址、生命周期、目录、同意、失败处理，以及它不是什么。

## 2. 插件

插件是 DSH Host 那一半：CLI 之上的一层薄封装，加上桌面消息面和标注面。这些文档在 CLI 契约之后阅读。

6. [DSH-PLUGIN.md](/docs/plugin/DSH-PLUGIN.zh.md) —— 面向 agent 的封装以及它为什么保持薄：六个工具、桌面消息提示与快捷键，以及安全边界如何成立。
7. [ANNOTATE.md](/docs/plugin/ANNOTATE.zh.md) —— 标注会话的设计契约：所有权与边界、单会话时钟、只记几何、语音链路、对齐、干净图与意图卡、降级、上限，以及平台适配器。

## 3. 跨领域记录

8. [VERIFICATION.md](/docs/VERIFICATION.zh.md) —— 一次真机验证记录；它是那台机器上的证据，不是长期保证。

## 4. 动机写在哪里

设计意图是被写下来的，不靠代码暗示。去找那些点明动机的章节：定位（Positioning）、边界（Boundaries）、限制与非目标（Limits and non-goals）、它不是什么（What it is not）。不要只从代码推断意图。当文档与代码不一致时，测试确定行为、文档记录意图，因此同一次提交里两边一起改。

## 5. 契约与代码对照

| 领域 | 契约 | 代码 |
|---|---|---|
| 只读命令 | `docs/cli/PROTOCOL.md` | `src/cli.ts` |
| 控制租约 | `docs/cli/LEASE.md` | `src/lease/` |
| 计划语言 | `docs/cli/PLAN.md` | `src/plan/` |
| 能力基线 | `docs/cli/BASELINE.md`、`docs/cli/COMPATIBILITY.md` | `src/compat/` |
| agent 桌面 | `docs/cli/DESKTOP.md` | `src/desktop/` |
| DSH 插件 | `docs/plugin/DSH-PLUGIN.md` | `plugins/dsh-hyprscope/`、`overlay/message/` |
| 桌面标注与意图卡 | `docs/plugin/ANNOTATE.md`、`docs/cli/PROTOCOL.md` §11 | `plugins/dsh-hyprscope/annotate.js`、`overlay/message/` |
