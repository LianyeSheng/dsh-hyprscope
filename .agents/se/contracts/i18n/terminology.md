# Terminology

English | [中文](/.agents/se/contracts/i18n/terminology.zh.md)

This table is the terminology source of truth for this repository's English–Chinese documents, and it is itself a bilingual pair: both sides carry the same rows, and the Chinese column gives the Chinese term on both sides. The pairing contract is in [README.md](/.agents/se/contracts/i18n/README.md).

**General rules:**

- The Chinese column is the default wording for Chinese prose. When the column holds an English term, Chinese prose keeps that English term untranslated.
- When the first-occurrence gloss column is non-empty, use it only at the term's first occurrence in the document; afterwards write the Chinese-column term without the gloss.
- The usage-constraint column is part of the entry: the same concept may be written differently in product copy, code identifiers and narrative text, and you must not change only one of them.
- Terms not listed here follow [translation-rules.md](/.agents/se/contracts/i18n/translation-rules.md): keep the English term, or use an established Chinese rendering with a citable source; never coin one on the spot.

## Products and entry points

| English | Chinese | First-occurrence gloss | Usage constraint |
|---|---|---|---|
| hyprscope | hyprscope |  | The project name and the read-only entry; never translated. |
| hyprlease | hyprlease |  | The control entry; never translated. |
| read-only entry | 只读入口 |  | The `hyprscope` CLI; it never mutates the desktop. |
| control entry | 控制入口 |  | The `hyprlease` CLI; every mutation passes its lease. |
| observation layer | 观察层 |  | State reads, screenshots and the event stream; not 观察器. |
| control lease | 控制租约 |  | The right to mutate for a bounded window; after first use, 租约 alone is enough. |
| session discovery | 会话发现 |  | Finding the compositor instance and the Wayland display; not 会话探测. |
| compositor | compositor |  | Kept in English; not 合成器. |
| capability report | 能力报告 |  | The `doctor` output; not 能力清单 (that is the baseline file). |

## Observation

| English | Chinese | First-occurrence gloss | Usage constraint |
|---|---|---|---|
| snapshot | 快照 |  | A point-in-time read of clients, monitors and focus; not 截图 (screenshot). |
| field | 字段 |  | One key of the observation contract; not 属性. |
| stability contract | 稳定性承诺 |  | What callers may rely on across versions; not 稳定契约. |
| layout coordinates | 布局坐标 |  | Global coordinates of the whole layout, possibly negative; not 屏幕坐标. |
| anchor point | 锚点坐标 |  | A window-relative 0..1 point resolved to layout pixels; not 锚点 (that is se-tools' record anchor). |
| absolute coordinate | 绝对坐标 |  | Layout pixels, low-confidence for clicks; not 全局坐标. |
| region | 区域 |  | A rectangle relative to a window for captures and assertions; not 选区. |
| layer | 图层 |  | A layer-shell surface reported under `layers`; not 层. |
| workspace | 工作区 |  | A Hyprland workspace; not 桌面. |
| monitor | 监视器 |  | An output; the `monitor` field stays English. |
| window | 窗口 |  | A client window; not 窗体. |
| event stream | 事件流 |  | The `.socket2.sock` subscription; not 事件队列. |
| lock state | 锁状态 |  | Best-effort logind LockedHint; `null` does not mean unlocked. |

## Control and plans

| English | Chinese | First-occurrence gloss | Usage constraint |
|---|---|---|---|
| lease | 租约 |  | The coordination record in `state.json`; not 授权. |
| host | 宿主 |  | The person at the screen; not 用户. |
| consent | 同意 |  | The host's approval of one action; not 授权. |
| consent card | 同意卡片 |  | The modal shown before a lease or a plan; not 授权弹窗. |
| overlay | 浮层 |  | The Quickshell UI; not 覆盖层. |
| banner | 横幅 |  | The top strip after approval; not 标题栏. |
| receipt | 回执 |  | The end-of-run summary shown to the host; not 收据. |
| plan | 计划 |  | A validated document of steps; not 脚本. |
| plan hash | 计划哈希 |  | The SHA-256 of the canonical plan; not 签名. |
| canonical hash | 规范哈希 |  | The hash over the defaulted document with sorted keys; not 标准哈希. |
| step | 步骤 |  | One op plus its requires and expect; not 动作 (that is the effect). |
| predicate | 谓词 |  | A fact a step declares and the executor evaluates; not 断言 (`assert` is an op). |
| premise | 前提 |  | A predicate instance in `requires`; not 前置条件. |
| expectation | 预期 |  | A predicate instance in `expect`; not 期望. |
| preflight | 预检 |  | The lease, budget, event and premise checks before a commit; keep `preflight → commit → verify` as one phrase. |
| dispatch | dispatch |  | The allowlisted Hyprland expression; not 派发. |
| allowlist | 白名单 |  | The closed set of commands or expressions; not 允许列表. |
| injection | 注入 |  | Pointer and keyboard events sent through the helper; not 插值. |
| helper | helper |  | The `bin/wl-inject` binary; not 辅助进程. |
| fault | fault |  | The JSON record of an ended run; not 故障. |
| run | 运行 |  | One `hyprlease run` lifecycle; the verb 执行 belongs to the executor. |
| attempt | 尝试 |  | One execution window inside a run; recovery attempts are numbered. |
| executor | 执行器 |  | The only injector; not 运行器. |
| dry run | 试运行 |  | `--dry-run` validates and prints without consent; not 空跑. |

## Interference and recovery

| English | Chinese | First-occurrence gloss | Usage constraint |
|---|---|---|---|
| interference | 干扰 |  | An external change that breaks a premise; not 冲突. |
| interference prompt | 干扰询问 |  | The blocking card; not 提示 (notice is the banner hint). |
| suspend | 挂起 |  | Ending an attempt without a fault so a derived plan can start; not 暂停 (pause is a step op). |
| interruption | 中断 |  | The moment an attempt stops at a step; not 打断. |
| recovery | 恢复 |  | Rebuilding premises with a derived plan; not 回滚. |
| derived plan | 派生计划 |  | The tool-built plan carrying lineage; authors never write `lineage`. |
| lineage | lineage |  | The recovery provenance object; not 谱系. |
| restore | 恢复步骤 |  | The concrete steps that re-establish a premise; bare 恢复 means recovery. |
| restorability | 可恢复性 |  | Whether the tool can re-establish a premise; not 恢复能力. |
| ladder | 恢复顺序 |  | The fixed outside-in order of restore steps; not 阶梯. |

## Capability baseline

| English | Chinese | First-occurrence gloss | Usage constraint |
|---|---|---|---|
| capability baseline | 能力基线 | capability baseline | The per-machine capability verdict; not 兼容性清单. |
| probe | 探针 |  | The install-time measurement; not 探测器. |
| evidence | 证据 |  | Raw probe records; not 凭据. |
| evidence level | 证据等级 |  | `measured` / `advertised` / `unknown`; the level names stay English. |
| fingerprint | 指纹 |  | The recorded environment; not 哈希 (that is the evidence hash). |
| acceptance | 验收 |  | The human step that approves a baseline; not 接受. |
| degrade | 降级 |  | Losing a degraded capability; not 退化. |
| invariant | 不变量 |  | A condition that must always hold; not 恒等式. |
| scratch client | 测试窗口 | scratch client | The probe's own window; not 测试客户端 (that name is the executable). |
