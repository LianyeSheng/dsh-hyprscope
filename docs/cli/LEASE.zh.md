# 控制租约（`hyprscope control`）

[English](/docs/cli/LEASE.md) | 中文

`hyprscope control` 让 agent 在**宿主同意之后**短暂接管桌面控制，并在结束、超时或宿主按下快捷键时把控制交还。它管的是"谁在控制"这件事，不是输入拦截：这一点在下面的[边界](#边界为什么不做输入拦截)里说清楚。

## 一次租约的完整过程

```
agent:   hyprscope control run plan.json
host:    a consent card pops up in the middle of the screen (allow / deny; auto-deny after 45 seconds)
host:    clicks allow
agent:   the run executes the plan under the lease, then hands control back when it ends
agent:   hits recoverable interference → writes interference.json and waits for the host's answer
host:    chooses "Continue execution"
agent:   renews the same lease and runs the derived recovery plan (1 by default, at most 3)
host:    SUPER + ALT + ESC          # or press this key at any time to interrupt
```

- `run` 就是 agent 的完整工作流：它校验计划，在同一次调用里弹出同意卡；批准后为整个运行持有租约、执行计划、结束时交还控制权；没有单独的申请或交还命令。
- 租约有 TTL（默认 120 秒）：agent 崩溃、一直没有交还、或者进程被杀，都会在到期时自动交还。
- 浮层有两副面孔：同意阶段是全屏独占键盘的模态卡片；批准后缩成顶部窄条，显示"Agent 正在操控桌面 · 剩余时间"，右侧有「立即收回」。窄条不拦截鼠标和键盘，agent 的注入不会被挡住。

在 agent 或 external 桌面里，人只在 `desktop start` 或 `desktop attach` 时同意一次。此后 `run` 和 `baseline --probe` 拿到的是**程序化租约**，不弹卡片（`grantedBy: desktop`），前提是桌面记录里带着这份同意；计划运行仍把这份租约绑定到这次提交的计划和 TTL，`wl-inject` 仍校验同一份证明。用户自己的桌面永远不走这条路：它保留逐次运行的同意卡片。程序化租约从不启动浮层。

关掉桌面的窗口并不会顺带撤销租约。`desktop stop` 会显式释放被停止桌面的租约；compositor 消失打断的运行以 `target.desktop-closed` fault，并在自己的 `finally` 路径里释放；没有 run 在释放的内部 holder 会一直持有租约，直到 TTL 到期。

## 状态与文件

状态机：`consent` → `granted` → `released` / `denied` / `expired` / `revoked`。终态之后不会再回到 `granted`。

用户桌面的状态目录是 `$XDG_STATE_HOME/hyprlease`（默认 `~/.local/state/hyprlease`，权限 `0700`，文件 `0600`）。agent 或 external 桌面按实例签名使用 `$XDG_STATE_HOME/hyprlease/<signature>/`；内部的 `HYPRSCOPE_LEASE_SIGNATURE` 选择它，这不是面向用户的选项。目录名沿用历史上的 `hyprlease`；这是磁盘上的协议名，不是第二个命令。下表的每个文件都位于选中的目录里：

| 文件 | 作用 |
|---|---|
| `state.json` | 唯一事实来源：阶段、原因、起止时间、pid；绑定计划时还带 `planBound: true`、`planSummary`、`card`（同意卡展示的内容：描述与步骤行，或一次批准的事实）、`attempt`、`maxResumes`、`totalBudgetMs`、`renewals[]`；仅批准请求带同一份 `card`，并有 `approvalOnly: true` 和 `ttlMs: 0` |
| `decision.json` | 同意阶段由浮层或宿主写入 `allow` / `deny` / `panic` |
| `control.json` | 由宿主兜底（`panic`）或由结束的运行写入交还请求 |
| `heartbeat.json` | requester 和 holder 每 500ms 刷新，用来判断租约是否失主 |
| `lease.lock` | 单租约互斥；带 `leaseId`，第二次租约申请会被 `LEASE_ACTIVE` 拒绝 |
| `notice.json` | 执行器发布的短暂提示；浮层只在 `leaseId` 匹配且未过期时显示，恢复开始时是「第 N 次恢复：…」 |
| `progress.json` | 执行器逐步发布的执行进度：`step`/`total`/`op`、`status`、`attempt`、`maxResumes`、`phase`；派生尝试全程是 `recovering`，浮层据此渲染横幅和回执 |
| `interference.json` | 执行器发布的阻塞式干扰询问：id、第 k/n 步、全部被打破前提、恢复次数、追加预算、截止时间 |
| `interference-decision.json` | 浮层按钮直接写入的 `continue` / `abort`，必须回带询问的 `id` |
| `overlay.log` | Quickshell 浮层的 stderr |

状态文件都带 `leaseId` 校验：旧租约残留的交还记录不会结束新租约（有回归测试覆盖）。每次新的租约申请也会清掉上一轮的 decision/control/heartbeat。

状态目录不放在 `XDG_RUNTIME_DIR`：Harness 的文件沙箱可能把 `/run/user/<uid>` 挂成只读，而快捷键进程（从 compositor 启动）和 agent 进程必须访问同一份文件。

### 续期与恢复字段

计划运行可以恢复可恢复的干扰，但不会重新弹同意卡：执行器用 `renewLease` 把同一份租约续到下一次尝试，把下一个尝试编号和新的到期时间写回 `state.json`。

| 字段 | 含义 |
|---|---|
| `planBound` | 租约是否批准了一份具体提交的计划：`run` 和 `baseline --probe` 为 `true`，仅批准租约（内部使用，给基线验收）为 `false` |
| `planSummary` | 宿主在同意卡上看到的预览：`steps`、`ops`、`workspace`、`summary` |
| `attempt` | 当前尝试：`0` 是原始计划，`1..maxResumes` 是恢复尝试 |
| `maxResumes` | 同意覆盖的恢复次数；默认 `1`，硬上限 `3` |
| `totalBudgetMs` | 从 `createdAt` 起算的总预算，或 `null`（不限）；`run` 申请时是 `(1 + maxResumes) × 计划 budgetMs` |
| `renewals[]` | 每次续期一条 `{ at, attempt, ttlMs, expiresAt }`，按时间顺序 |

`renewLease` 的规则全部对着磁盘上的 `state.json` 检查，任一条不满足都报 `LEASE_MISMATCH` 且不改文件：

1. 只续 `granted` 且未过期的租约，`leaseId` 必须一致；
2. `attempt` 必须正好是当前 `attempt + 1`，不能跳号，也不能超过 `maxResumes`；
3. 新到期时间是「现在 + 本次 TTL」，不叠加旧到期时间；`run` 每次尝试的 TTL 是 `计划 budgetMs + 20000ms`，给询问与 settle 留余量；
4. 时间预算：所有已记录续期的 `ttlMs` 之和加上本次 `ttlMs`，不得超过 `totalBudgetMs + (renewals.length + 1) × 20000ms`；
5. 成功后写回 `attempt`、`expiresAt`、追加的 `renewals[]`，并刷新心跳；`leaseId` 和 `planBound` 保持不变；
6. 旧版 `state.json` 缺这些字段时按保守值处理：`attempt` 视为 `0`、`maxResumes` 视为 `1`、`renewals` 视为空；早于 `planBound` 写下的状态文件不算绑定计划，执行器和注入 helper 都会拒绝它。

续期不重开同意流程：宿主批的是计划本身加固定次数的机械恢复，每次续期之后执行器都会重读租约并要求它刚刚开启的那个尝试。`status --json` 里有 `planBound`、`planSummary`、`attempt`、`maxResumes`、`totalBudgetMs`、`renewals`（条数），人读输出在尝试大于 0 时显示 `recovery k/maxResumes`。

### 同一种同意卡

同意卡只有一种：`card: { title, lines[], acceptLabel, denyLabel }`；申请路径也只有一个：`requestLease`。计划租约用它装计划的描述与步骤；仅批准请求用它装一件不改变桌面状态的行动的事实（目前是放宽的 `baseline --probe` 展示的能力基线验收卡）。卡片按 `--lang <zh|en>` 选择的语言渲染。浮层对两者渲染同一张卡，答案都走同一个 `decision.json`：按钮直接写入回答，等待中的进程记录决定并继续，这一下点击不启动任何 CLI 命令。

模式差异用 `approvalOnly: true` 表示：state 保持 `ttlMs: 0` 和 `planBound: false`，记录在 `allow` 时以 `released` 结束（否则是 `denied` / `expired`），永远不会进入 `granted`，不启动 holder，也不授予任何 TTL，所以执行器和 `wl-inject` 都不可能凭它注入（两者都要求 `phase=granted` 且 `planBound: true`）。`grantedBy` 仍记录是谁回答的：点卡是 `overlay`，受管桌面的程序化同意是 `desktop`。

### 干扰询问记录

可恢复前提被打破时，执行器先写 `interference.json` 再停下来等，不会自动修。字段：

| 字段 | 含义 |
|---|---|
| `leaseId` / `runId` | 所属租约与运行 |
| `id` | 本次询问的唯一 id；回答必须回带，旧回复不会串台 |
| `step` / `total` | 第几步（1 起）与本次尝试的总步数 |
| `kind` / `detail` | 第一条被打破前提的种类与说明 |
| `attempt` / `maxResumes` | 这次询问要启动的恢复尝试（`1` 起，第一次就是 `1`）与总共允许几次 |
| `budgetMs` | 继续后恢复尝试可用的执行窗口（计划 `budgetMs`） |
| `at` / `expiresAt` | 发布时刻与回答截止；`run` 到点按 `abort` 处理 |
| `broken[]` | 全部被打破前提：`{ kind, detail, expected, observed }` |

回答写在 `interference-decision.json`：`{ id, decision: "continue" | "abort", at, source }`。宿主点按钮时由浮层直接写入；等待中的进程会校验询问仍在、`id` 一致、未过期，执行器只认 `id` 匹配的回答，读到后清掉询问与回答。浮层卡片、倒计时和「继续执行 / 终止操作」的渲染在 `overlay/shell.qml`，运行语义见下一节。

`interferencePromptMs` 只约束这一次等待；等待不占计划预算，但占租约 TTL，所以每次尝试的 TTL 里带了 20000ms 余量。等待期间租约被收回时，运行按 `revoked` 结束。

agent 或 external 桌面里没有浮层，也就没有询问：可恢复的冲突会让这次尝试 fault，由 agent 在对话里问宿主。

## 命令

```
hyprscope control run <plan.json> [--consent 45] [--max-resumes 1] [--dry-run] [--json]   # ask for consent, execute, release
hyprscope control ops [--json]          # the operation catalog a plan can use
hyprscope control status [--json]       # phase, remaining time, holder/overlay pid, stale, recovery progress
hyprscope control panic [--json]        # emergency revoke (the shortcut and `desktop stop` run it)
hyprscope control install-bind [--key "SUPER + ALT + ESC"] [--message-key "SUPER + ALT + M"] [--annotate-key "SUPER + ALT + A"]
hyprscope control uninstall-bind
hyprscope control baseline --probe [--read-only] [--json]   # measure this machine; a widening result asks the host and writes the accepted baseline on Allow
hyprscope control baseline --show [--diff] [--json]         # review the accepted baseline and any draft
hyprscope control desktop start [--size WxH] [--consent-source chat|card] [--json]
hyprscope control desktop attach --runtime-dir <dir> [--signature <sig>] [--consent-source chat|card] [--json]
hyprscope control desktop status [--json]
hyprscope control desktop stop [--json]
```

每个 `hyprscope control ...` 命令还接受 `--lang <zh|en>`：它选择同意卡或确认卡、以及它启动的浮层的语言。省略时取 `HYPRSCOPE_LANG` 环境变量，再否则 `zh`；不支持的值按用法错误处理。卡片内容（计划预览行、基线确认行、原因与恢复提示）和浮层外观都跟随它，CLI 的 stdout 仍是英文。

`--desktop user|agent|external` 选择 `run`、`ops`、`status`、`panic`、`baseline` 和 `desktop` 作用的桌面；省略即 `user`。`status` 和 `panic` 操作的是该桌面按签名区分的租约，所以 `panic` 必须指向持有租约的那个桌面。

`run` 先读它所针对桌面的已验收能力基线（capability baseline）：`user` 用按机器的 `$XDG_STATE_HOME/hyprscope/baseline.json`，`agent`/`external` 用 `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json`（见 [BASELINE.md](/docs/cli/BASELINE.zh.md)）：文件缺失、仍是草稿、`incomplete`，或者 staleness 判定不是 `fresh` 时，它们会在任何同意卡片出现之前以 `CAPABILITY` 失败，宿主因此不会被要求批准这台机器跑不了的事。`baseline --probe` 是唯一不需要基线也能走的控制路径，因为基线正是它创建的；它仍然要申请自己的短租约。

`--max-resumes` 取 `0..3`（默认 `1`），是同意卡覆盖的恢复次数：`0` 表示第一次遇到可恢复干扰就直接 fault，不再弹询问卡。`--dry-run` 会顺带打印这项额度。`--consent` 对 `run` 与 `baseline --probe` 有效；`run` 每次尝试的 TTL 由计划 `budgetMs` 加 20000ms 余量决定。

退出码：`run` 计划完成为 0，fault、被撤销、同意被拒绝或超时为 1，参数错误为 2。分离的 holder 是租约代码启动的内部模块入口，不是 CLI 命令，也不属于对外文档化的命令面。

`install-bind` 会往 `~/.config/hypr/hyprland.lua` 追加一段带标记的块，里面有三处 `hl.bind(...)`：兜底键（`control panic --source shortcut`）、桌面消息键（`hyprscope message open`，默认 `SUPER + ALT + M`，可用 `--message-key` 改）和桌面标注键（`hyprscope message annotate`，默认 `SUPER + ALT + A`，可用 `--annotate-key` 改）。它先检查三个组合互不相同、且都没被别的 bind 占用，生成带时间戳的备份，然后 `hyprctl reload`，再通过 `hyprctl binds -j` 的三个 `description` 字段确认绑定真的生效；缺一个就恢复配置和两份快捷键记录、删掉生成的 Lua 文件，并报 `BIND_FAILED`。消息键和标注键会记进浮层读取的消息状态目录：`shortcut.txt` 和 `annotate-shortcut.txt`。`uninstall-bind` 删除这一段、两份快捷键记录和生成的 Lua 文件，然后重新加载。替换或卸载时同时接受新的 `hyprscope` 标记和历史 `hyprlease` 标记；CLI 合并之前安装的 bind 指向已删除的 `bin/hyprlease.ts`，需要重装。两个桌面快捷键都不是控制路径：它们只打开输入框或标注面，最终消息通过 Host 的 prompt 准入发出。安装或移除任一 bind 都会改变能力基线记录的 bind 数量，所以跑过 `install-bind`/`uninstall-bind` 之后已验收的基线会变 stale；下一次控制运行前要重新 probe。

为什么把 bind 内联在 `hyprland.lua` 里，而不是单独文件加 `dofile`：在测试机的 0.57 Lua 配置里，`dofile`/`require` 的间接注册在 reload 时不生效，内联 `hl.bind` 才可靠（实测过）。

## 兜底链条

按可靠性从高到低：

1. **快捷键** `SUPER + ALT + ESC`：compositor 级 bind，浮层是否抢键盘都不影响它。命令是绝对路径，链接到 `hyprscope control panic`。
2. **浮层上的「立即收回」**：鼠标点一下就结束，不依赖键盘。
3. **TTL 到期**：holder 自己到点交还，不依赖任何一方配合。
4. **心跳失主清理**：holder/requester 的心跳超过 5 秒没更新，下一次 `status` 或 `run` 会把租约标成 `revoked` 并清掉浮层和锁。
5. **`panic` 的强制路径**：写了 `control.json` 后 5 秒内没等到终态，就自己杀浮层（只杀 `/proc/<pid>/comm` 是 quickshell 的进程）、写终态、放锁。

已经发出的输入不可撤销（注入启用后），所以所有路径的语义都是"停止后续动作 + 释放已按下的按键/按钮"，不是回滚。

## 边界：为什么不做输入拦截

测试机实测只有一个 `wl_seat`，而且沙箱里没有 `/dev/input`、`sudo` 也不可用。结论很直接：

- 同一 seat 上，layer-shell 的 exclusive 键盘焦点会同时拦住宿主和 agent 的虚拟键盘；全屏输入区域会同时吞掉两边的指针事件。**没法只拦住宿主输入而不拦住注入**。
- 要真正做到物理隔离，只能给 agent 一个独立的 compositor 会话（嵌套或 headless），或者走 evdev 抢占用物理设备（需要 input 组/udev 权限，而且键盘被拦时快捷键也会失效，兜底要另设计）。

所以租约是**协议级互斥 + 协作**：同意、可见、可打断、会超时。它保证"控制权有明确归属和明确结束方式"，不保证"宿主物理上动不了鼠标"。文档和 `status` 输出都不应让人误以为后者成立。

### 同意不是安全边界

这一点必须写下来：同意卡片渲染在同一个 seat 上，任何能注入指针/键盘的进程都能把「允许」点掉。我们实测过一次：用 `bin/wl-inject` 往按钮坐标发一次点击，卡片就关掉了——那次是测试按钮是否真的可点，但它同时证明了卡片自身不构成认证。

现在能做的门控：注入 helper 要求调用方提供**已授予**的租约证明（`--lease-state` + `--lease`），每次注入前重读 `state.json`，要求 `phase=granted`、`leaseId` 匹配、`planBound: true`、未过期。于是同意阶段（`consent`）注入一律被拒绝，agent 不能再用官方 helper 点自己的同意卡。仅批准租约（内部使用，给基线验收）的 `planBound` 为 `false`，这条证明对"先批准再点同意"同样不成立。

它挡不住什么：同一 uid 下，能跑任意代码的 agent 可以自己写一个 Wayland 客户端用同样的协议注入，也可以直接伪造 `state.json` 或 `decision.json`。真正的边界只有两条路：把租约状态和注入通道交给独立 uid 的 broker（agent 侧拿不到 compositor socket 和状态目录），或者给 agent 一个独立 compositor 会话。在补齐之前，同意卡片的作用是**可见性和知情**，不是认证。

## 与计划执行器的接口

现在只有一条写入口：`hyprscope control run <plan.json | ->`。它从文件或 stdin 读取并校验一次计划，再把 `planBound` 和 `planSummary` 放进租约申请；同意卡片因此显示的是"批准哪一份计划"，而不是"借我一段时间"。

执行器在**每个**会改状态的调用之前重读 `state.json`，要求同时满足：阶段是 `granted`、`leaseId` 与发起时一致、`planBound` 为 `true`、未过期。任一不符就按 `revoked` 结束整次运行——这样 `panic`、TTL 到期或换租约之后，不会再有排队中的按键或点击落下去。

可恢复干扰不会被原地修复。执行器写 `interference.json` 并停下来等：浮层弹出模态卡片，显示被打破的前提、第几步、第几次恢复和倒计时，等你选「继续执行」或「终止操作」（Esc 终止、Enter 继续）。选继续，执行器不重放被中断的步骤：它先挂起这次尝试，再根据被打破的前提合成一份派生计划（恢复步骤在前、原计划从被中断那一步起的剩余步骤在后），然后续期同一租约、以新哈希执行。恢复尝试有独立的执行窗口，但只有第一次尝试能触发恢复；恢复中再破前提就直接 fault。选终止、超时未答、或前提根本不可恢复，都按 fault 结束，并把事实（哪条前提、已确认的步骤、时间线、现场截图）交回上层重新规划。

`interference.json` 的 `id` 用来防止旧回复串台。宿主批的是根计划加 `maxResumes` 次机械恢复：哈希绑定、租约门控和故障记录语义都不变，恢复只是把「另一份计划」这条路走了一遍。

这也意味着宿主在计划执行中途碰桌面时，会先被问一次，而不是被默默"纠正"。这里是协作语义，不是强制冻结，理由见上一节。

计划格式、谓词表、恢复模型和 fault 记录见 `docs/cli/PLAN.md`。

## 当前限制

- 快捷键只绑定在 Hyprland 层；未安装 bind 时靠浮层按钮和 TTL 兜底。
- 恢复只覆盖可观察、可用 dispatch 子集重建的前提：关窗口、换应用界面、改监视器都直接 fault；恢复不会重新问宿主，也不会再恢复一次。
- `interferencePromptMs` 可以长于每次尝试的 TTL 余量（20000ms）；等太久会先撞上租约到期，运行按 `revoked` 结束。
- 多用户/多 seat 场景没有验证；同一用户的多个未记录实例共用按机器的租约目录，按 `leaseId` 区分但只有一个全局租约槽，而记录在案的 agent 和 external 桌面各有按签名的目录。
- 浮层用 Quickshell 0.3.2 的 layer-shell；没有 Quickshell 的环境会报 `OVERLAY_FAILED`（可以注入假的 overlay 做无界面测试）。
- 心跳 500ms 是进程级证据，跨 pid namespace（例如从沙箱外看沙箱内）会误判为 `stale`，`status` 里的 `stale` 只作诊断参考。
