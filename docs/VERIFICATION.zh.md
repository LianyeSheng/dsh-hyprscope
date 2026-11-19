# 实机验证记录

[English](/docs/VERIFICATION.md) | 中文

这是某次实机验证的记录，不是持续保证。数字和版本只对这次的环境成立，换机器、升级 Hyprland 或者改配置都可能变。想确认现在的状态，直接跑 `pnpm run typecheck && pnpm test && pnpm run doctor`。验证时间：2026-11-17 和 2026-11-18，覆盖观察层、控制租约、计划执行与输入注入、干扰询问和派生恢复，以及 2026-11-18 的 agent 桌面、漂移检测、同意卡与探针的测量计划。这份记录里的命令写法统一成了当前的单入口：此前的运行用的是合并前的 `hyprlease` 二进制，观察结果不变，但下文命令写作 `hyprscope control ...`。文中写成 `hyprlease-*` 的 layer 名是历史标签，当前名字是 `hyprscope-*`。

## 环境

- 系统：CachyOS（Arch 系滚动发行版）
- compositor：Hyprland 0.57.2，Lua 配置，`drm` 后端，单 `wl_seat`
- 输出：`HDMI-A-1`，2560×1440，scale 1
- 运行时：Node v26.13.1、pnpm 12.20.0、TypeScript 7.0.2（仅类型检查）
- 调用方环境：`WAYLAND_DISPLAY` 和 `HYPRLAND_INSTANCE_SIGNATURE` 都是空的，验证进程不在图形会话里

## 观察层

`pnpm run doctor`（Wayland 探针已编译）识别到 1 个 Hyprland 实例，Wayland display 是 `wayland-1`；探针报回 73 个 Wayland 全局对象、`seatCount 1`，`zwp_virtual_keyboard_manager_v1`、`zwlr_virtual_pointer_manager_v1`、`zwlr_screencopy_manager_v1` 等协议存在。

`node bin/hyprscope.ts state` 读到 `HDMI-A-1`（2560×1440，scale 1），活动窗口在 workspace 1，`layers` 里有 7 个 layer-shell surface，光标全局坐标也读出来了。

全布局截图 2560×1440 成功；区域截图 `--region 0,0,640,360` 也成功，两次都从 PNG 头里解出宽高，返回里有文件大小和 sha256。

`pnpm test` 当时是 70 个测试通过（64 个单元测试加 6 个实时集成测试）；`pnpm run typecheck` 无错误。实时测试连的是同一个 compositor，没有可用会话时整组跳过。会话发现那条路径用真实 unix socket 覆盖过。

## 控制租约

2026-11-17 在测试机上逐项跑过：

- 同意卡片：`hyprscope control request --reason "检查同意卡片与横幅切换" --ttl 120 --consent 90` 弹出全屏模态卡片（`hyprscope layers` 里是 `hyprlease-consent`，level 3，覆盖 2560×1440），文案、原因、倒计时、拒绝/允许按钮都正常。截图：`out/lease-consent-2.png`。
- 批准后横幅：同意被记录之后 `status` 变 `granted`，layer 变成 `hyprlease-banner`（2560×56），显示剩余时间和「立即收回」。截图：`out/lease-banner-2.png`。
- 主动交还：`hyprscope control done` 之后 `phase: released`，layer 消失。
- 强制收回：`hyprscope control panic` 之后 `phase: revoked`，layer 消失（`out/lease-after-failsafe.png` 是干净桌面）。
- 兜底快捷键：`install-bind` 写入 `~/.config/hypr/hyprland.lua` 的标记块并通过 `hyprctl binds -j` 的 `description` 验证（`modmask 72`、`key Escape`、`description` 含 `hyprscope`），`hyprctl configerrors` 为空；直接执行 bind 里的命令（`/usr/bin/node .../bin/hyprscope.ts control panic --source shortcut`）能把 `granted` 租约打到 `revoked`。
- 残留记录：不同租约的 `control.json` 不会误伤新租约（单元测试覆盖）；每次 `request` 会清空上一轮的 decision/control/heartbeat。
- TTL 到期、心跳失主清理、`consent` 阶段 panic 都有单元测试，没有逐条做 UI 实测。

## 计划执行与输入注入

编译：`pnpm run build:inject` 从空的 `tools/inject/generated/` 全量生成协议头并链接 `bin/wl-inject`，无警告；`--probe` 报回 `zwlr_virtual_pointer_manager_v1` v2（global 30）和 `zwp_virtual_keyboard_manager_v1` v1（global 29），一个 seat。

**测试机 dispatch 语义**：这台 compositor 用 Lua 配置 provider，`hyprctl dispatch` 的参数按 Lua 求值，经典字符串 dispatcher 不生效（`hyprctl dispatch focuswindow address:0x...` 直接报 Lua 语法错误）。所有 dispatch 改成白名单模板生成的 `hl.dsp.*` 表达式（`focus`、`window.move`、`window.resize`、`window.float`、`window.pin`），参数先校验格式再拼接；`focuswindow`、`workspace`、`movewindowpixel`、`resizepixel`、`float`、`pin` 六种语义操作逐个实测过效果（位置、尺寸、浮动、pin、焦点、工作区切换）。

**键盘注入**：最初按协议 XML 的注释发 `evdev + 8`，字符整体错位一行（`e`→`[`）；查 Hyprland 0.57.2 源码确认它的 virtual-keyboard 路径把 `key` 参数当作**原始 evdev**、内部再 `+8` 给 xkbcommon，改为发原始 evdev，并在按下/松开合成修饰键时显式发 `modifiers`。修完后 `text`、`chord`（含 `CTRL+c`）、`keysym` 在真实终端里逐项验证：`echo test123` 回显正确，`echo 'ABC xyz 0123 !@#$%^&*()_+-=[]{};:,.<>/?|~'` 全字符集正确，`CTRL+c` 能中断前台命令。

**计划执行全链路**：`plans/live-terminal.json`（focus → click → text → chord Return → screenshot，5 步，budget 8000ms）走真实租约跑通，`status` 返回 `completed`，耗时 646ms：

- 同意卡片显示 plan 摘要和 `sha256 ce69a2839522…`（截图 `out/plan-consent-3.png`）；
- 点击落在锚点解析出的 `1513,940`，`text` 输入 19 个字符，`chord` 发送 Return；
- 窗口截图 `out/runs/20261117T092224-06fc95/step-04-terminal.png` 显示终端里是 `echo hyprscope-live` 和输出 `hyprscope-live`；
- 运行产物：`plan.json`（含哈希）、`timeline.jsonl`、`step-04-terminal.png`、`result.json`；租约在 `finally` 里释放，`status` 随后是 `released`。

**失败路径也实测过**（这些是调试过程中真实发生的，不是构造的）：

- 目标窗口不存在：`faulted`，`broken.kind = target.missing`，`committed: []`，带 fault 截图；
- 绝对坐标 extent 不匹配：点击落在别处，点击步骤的 `expect` 失败，`faulted`，`broken.kind = window.focused`，`committed` 只剩已确认的第 0 步 —— 说明"没有回执的点击不会被重放"；
- dispatch 语法错误：`faulted` 在第一步，`broken.detail` 带 compositor 的原始报错。

**人机交互修复（2026-11-17 第二轮）**：

- 同意卡片的按钮此前绑在两个未定义的属性上（`nodePath`/`binPath`），点击只会启动一个空命令，所以点了没反应；现在补齐属性并做了乐观 UI——点击当场收起卡片，横幅立即显示「正在交接控制…」。
- 横幅原来随租约结束被 requester 立刻杀掉，看不到任何回执；现在改成执行器逐步骤写 `progress.json`，横幅显示「执行中 k/n · op」，正常结束（done/denied/expired）时浮层自己保留约 2.4 秒展示结果再退出，只有 `revoked`（宿主抢回）才立即消失。截图 `out/ux-banner-sequence.png`（交接中 → 执行中 4/9 → 6/9 → 9/9）、`out/ux-10-receipt.png`（执行完成 · 9 步）。
- 浮层此前是 requester 的子进程、stderr 走管道；requester 一退出管道关闭，浮层的下一次 stderr 写入就吃 SIGPIPE 直接死掉，回执永远渲染不出来。现在浮层用自己的日志 fd 并 `detach`，与 requester 生命周期解耦。
- 横幅上的「立即收回」按钮原来调用一个内部同意入口，而它只在 consent 阶段有效，granted 阶段点了没用；改成调用 `hyprscope control panic`（走 holder 的交还路径）。

**同意卡片不是认证**：这一轮还发现一个更根本的问题——同意卡片和注入在同一个 seat 上，agent 可以直接用 `bin/wl-inject` 点掉自己的「允许」。实测确认（用注入的点击测试按钮可用性时暴露）。已加的缓解是：注入 helper 现在要求租约证明（`--lease-state/--lease/--plan`），每条会注入的命令前重读 `state.json`，`phase` 不是 `granted`、id/hash 不匹配或过期就拒绝；`consent` 阶段注入实测返回 `lease gate: phase is "consent", not "granted"`，`revoked` 之后同样拒绝。另外每次批准都会记录来源：`grantedBy` 在 `status` 里可见（`overlay` 表示卡片按钮，`cli` 表示数据面）。同意状态仍然是同一 uid 下的数据面状态，同 uid 也能伪造；真正的边界需要独立 uid 的 broker 或独立 compositor，见 `docs/cli/LEASE.md`。

**阻塞式干扰询问（2026-11-17 第三轮）**：可恢复干扰不再自动修复。执行器先发布 `interference.json`（带 id、第 k/n 步、被打破的假设、倒计时），浮层弹出模态卡片，宿主选「继续执行」才恢复并重放，选「终止操作」或超时未答就 fault 并保留已确认步骤。计划里的 `repairGraceMs` 相应换成 `interferencePromptMs`（默认 12 秒）。（这一段记录的是当时的实现；第四轮把"原地修复"整体换成了派生恢复计划，`repairable`/`repairs` 字段和 `repairGraceMs` 都已从代码里删除，保留在这里只为说明演进过程。）

实机验证（`interference-demo` 计划，4 步，`interferencePromptMs: 8000`）：在步骤间用注入把光标挪走制造 `pointer.position` 违反，卡片弹出 `hyprlease-interference` layer（2560×1440，level 3），显示 `第 3/4 步 · pointer.position` 和 8 秒倒计时（截图 `out/iface-prompt.png`）。选「继续执行」后执行器恢复光标、重放该步，运行 `completed`，该步记录为 `repaired 1`；另一次运行选「终止操作」，运行 `faulted`，`committed` 只有第 0 步，`broken.detail` 为 `pointer is not where the step expects it (host chose to terminate)`。

这轮测试还抓到一个误报：我们自己的 `focusWindow` dispatch 产生的 `activewindow` 事件可能晚于提交窗口到达，被当成宿主干扰直接 fault。执行器现在按 op 记录预期的回声事件种类并在 2 秒内归因（`ECHO_KINDS`），修掉之后再跑同一计划不再出现误判。

**恢复改为派生计划（2026-11-17 第四轮）**：第三轮的"原地修复再重放"被替换成"挂起 + 派生恢复计划"。判定标准只有一条：工具自己观测得到、且用现有 dispatch 白名单能重新建立的前提才恢复；关掉的窗口、变化的应用画面、监视器变化一律不恢复，直接 fault 把事实交回调用方。

- **可恢复性**按谓词种类决定（`PREDICATE_SPECS.restore`）：`window.focused`、`window.state`、`workspace.active`、`pointer.position` 可恢复；`window.geometry` 只在窗口浮动时恢复（平铺窗口的几何归布局管）；`window.exists`/`clients.set`/`monitor.config`/`region.*`/`time.budget`/`lease.valid` 不可恢复。执行器在 preflight 里发现前提被打破时，先用当前快照判定；全是可恢复的才发询问，出现不可恢复的直接 fault，不弹窗。
- **派生顺序**固定为 工作区 → 窗口结构（关全屏、浮动、pin）→ 几何（move + resize）→ 焦点 → 指针。依据是 compositor 的实际依赖：全屏时 move/resize 会被拒（源码里 `Window is fullscreen`），resize/move 可能改变焦点，`focus` 会把光标吸进窗口还可能切工作区。
- **挂起**：宿主选「继续执行」后，这一次尝试以 `suspended` 结束（`suspended.json` 记录被打破的前提、`committed`、基线几何），`run` 重新观测桌面，用代码合成恢复步骤，拼上原计划未提交的步骤，得到带 `lineage`（`rootPlanId`/`rootPlanHash`/`attempt`/`interruptedAtStep`/`broken`）的新计划；它有自己的 `budgetMs` 和新哈希，租约用 `renewLease` 原地续期（同一 `leaseId`，`attempt` 加一，`expiresAt` 前移，追加 `renewals[]`），所以恢复有独立时间窗口、不需要第二次同意。
- **只恢复一次**：`maxResumes` 默认 1（上限 3，`--max-resumes` 可调），派生尝试里再出现前提破坏就直接 fault（`the recovery attempt may not recover again`）。恢复预算 = 原 `budgetMs`，总预算 = `(1 + maxResumes) × budgetMs`。

实机验证（`recover-demo` 计划：9 步，`budgetMs 14000`，`settleMs 700`）：焦点 → 浮动 → 移到 `140,120` → resize 到 `720×480` → pause 900ms → click（`requires` 焦点 + 显式几何）→ 输入 → Return → 截图。在 pause 期间用 `hl.dsp.window.move` 把目标窗口挪到 `300,220` 制造几何漂移，走到 click 的 preflight 时触发：

- 询问卡片（`out/ux-recovery-prompt.png`）：`检测到外部操作`、`第 6/9 步 · 第 1/1 次恢复`、`window.geometry · window geometry changed beyond tolerance`、`继续将恢复前提并追加 14s 执行窗口（本次运行最多恢复 1 次）`、15 秒倒计时。
- 选「继续执行」：横幅切到琥珀色的 `恢复中 · 第 4/6 步（第 1 次恢复）`（`out/ux-recovery-running.png`），恢复步骤先把窗口挪回 `140,120`、resize 回 `720×480`，然后继续 click/text/Return；运行 `completed`，回执 `执行完成 · 9 步（含 1 次恢复）`（`out/ux-recovery-banner.png`）。派生尝试目录里的 `out/runs/20261117T112528-c8286a/step-05-recovered.png` 显示 `echo hyprscope-recovered` 回显成功——说明恢复后注入 helper 接受的是续期后的新 `planHash`。
- 选「终止操作」：运行 `faulted`，`fault.step = 5`，`broken.detail` 结尾是 `(host chose to terminate)`，`committed: [0,1,2,3]`，没有第二次尝试。
- 在 pause 期间直接关掉目标窗口：`faulted`，`broken.kind = target.missing`，**没有**写 `interference.json`（不可恢复前提不弹窗），`committed` 保留到第 3 步。

产物与租约状态：根运行目录 `out/runs/20261117T112526-ea7de0/` 有第一段的 `suspended.json`、`timeline.jsonl`（`step.suspend`、`run.suspended`、`run.resume`）和聚合后的 `result.json`（`attempts: [suspended, completed]`）；派生尝试目录 `out/runs/20261117T112528-c8286a/` 有自己的 `plan.json`（带 lineage 和哈希）。`state.json` 里 `rootPlanHash` 保持原计划哈希，`planHash` 换成派生计划哈希，`renewals` 有一条 `attempt: 1`、`ttlMs: 34000` 的记录。

取消类验证的说明：这三轮实机运行里的同意是通过数据面记录而不是真人点击卡片完成的，`grantedBy` 记成 `cli`；真实人手点击卡片的恢复流程这次没有留记录，恢复卡片的渲染与按钮逻辑靠浮层的 52 条断言和交互截图覆盖。

这轮还补了一个事件消费的漏洞：`pause`/`waitEvent`/`screenshot` 这类不走 preflight 的步骤原来会把 tap 的游标推进到当前末尾，等于吞掉到达之前的硬事件（新窗口打开、窗口关闭、监视器变化）。现在这些步骤执行前先检查一次硬事件，`waitEvent` 只消费它等到的那一个事件、保留后面的事件。实测：计划三步各 1 秒的 `pause`，在第一个 pause 期间用 `foot` 打开一个新窗口，运行在下一个 pause 之前 `faulted`，`broken.kind = foreign-event`、`detail = external openwindow event`。

这轮顺手删掉了 `ECHO_KINDS` 回声归因表：既然违反与否以声明的前提重新求值为准，就不再需要从事件反推自己的副作用；事件只剩 `openwindow`/`closewindow`/`monitor*`/`submap` 这类"没有任何前提能解释"的硬失败。

本轮自动化测试：`pnpm test` 149 个全通过（观察层与控制租约的实时测试、计划引擎、租约、恢复合成与派生、dispatch 白名单），`pnpm run typecheck` 无错误，`qmllint overlay/shell.qml` 无输出。

**干扰提示**：手动往租约目录写 `notice.json`（`leaseId` 匹配、20 秒过期），横幅在 300ms 轮询内变成两行并显示琥珀色提示条「检测到外部操作，正在恢复 1/2；按 SUPER+ALT+Escape 收回控制」，截图 `out/notice-banner.png`；`panic` 之后浮层和 layer 都消失。

**自动化测试（第三轮时）**：`pnpm test` 当时 111 个（观察层与控制租约的实时测试 70 个 + 计划引擎 17 个 + 租约绑定与记录 24 个），`pnpm run typecheck` 无错误。计划引擎的测试用假 world 覆盖了完成、fault、可修复干扰、撤销、后置条件失败、外键事件修复、waitEvent、区域截图和 key 映射；真实 compositor 只用在实时测试和上面这些手工验证里。

## 能力基线

第四轮之后补上；2026-11-17 在测试机上验证过。

**编译**：`pnpm run build:scratch` 用系统 `xdg-shell` 协议编译 `probe/wl-scratch.c`，带 `-Wall -Wextra` 且无警告，产出 `bin/wl-scratch`；单独运行时它映射一个 320×200、标题为 `hyprscope-scratch` 的浮动窗口，打印 `{"event":"ready","width":320,"height":200}`，把注入的功能键按 evdev 键码报出来，收到 SIGTERM 后干净退出。它会一直保持固定尺寸提示，直到收到 SIGUSR1——探针在测量 resize 之前会发这个信号；否则固定尺寸的 toplevel 没法改尺寸，读回也就没有意义。

**探针**：`hyprscope control baseline --probe` 先申请验收租约（同意卡片理由「installation acceptance: capability probe」，计划哈希 `sha256("hyprscope-probe/1")` = `48dcf1a2…`，TTL 60 s），测量、写 `out/baseline/<probeId>/{probe.jsonl,summary.json,capture.png,scratch.log}`，然后释放租约。连续三次探针都得到 `state: usable`、18 项能力 `supported/measured`，只有 `dispatch.window.move-to-workspace` 是 unknown（记录用，不门控）。测到的往返包括：指针移到测试窗口（scratch client）中心 `1305,720` 后读回偏差 `0,0`；`F12` 被测试窗口按 evdev `88` 收到，按下与松开都收到；move 读回完全一致，resize 读回 `360×240`，float/pin/fullscreen 设置与清除都有读回；`openwindow`/`closewindow` 按地址匹配；清理恢复了之前的焦点和工作区，没有留下测试窗口或 helper 进程；租约以 `released` 结束（`grantedBy: cli`）。

**验收与收窄**：验收写出 `baseline.json`（0600），带 `approval {approvedBy: "human", source: "cli", evidenceSha256}` 和一条 `revisions[kind: "accept"]`；之后 `doctor` 报告 `baseline: usable · approved … · hyprland 0.57.2`。后来一次探针的有效集是子集、证据也没有变强，它就地重写了已验收的文件，保留批准并追加 `revisions[kind: "narrow"]`；任何更宽的变化（包括有效能力的 `advertised → measured`）都会变回待批准草稿，等下一次探针请宿主确认。

**门控**：没有基线时，`hyprscope control run --dry-run` 以 `CAPABILITY` 失败，且不弹同意卡片；基线是 `incomplete` 时，它准确列出了没测到的必需能力（`observe.geometry`、`inject.pointer`、`inject.keyboard`、`events.socket`）；验收之后，一个单步 `pause` 计划跑到 `completed`，报告里带 `baseline {state: usable, approvedAt, compositorVersion: "0.57.2", degraded: []}`。

**验证中发现并修掉的缺陷**（都是真实发生的）：

- 行匹配器拿它启动的子进程 pid 和 `clients[].pid` 比较。这个环境里子进程跑在 pid namespace 里，compositor 报的是另一个 pid，于是真实的测试窗口被当成「没出现」丢掉了；现在按 app_id + title 匹配，要求恰好一行，并交叉核对 `openwindow` 的地址。
- 事件 socket 打印地址时不带 `0x`，而客户端行带；比较时现在会归一化，这也是之前 `closewindow` 明明已经缓冲却报缺失的原因。
- 同意卡片在关闭时把焦点交还给上一个窗口，和第一次焦点 dispatch 抢跑：有一次探针把 `activewindow` 读成浏览器，于是停止注入，把 `inject.pointer`/`inject.keyboard` 记成 unknown，把已验收的基线收窄成 `incomplete`。焦点是幂等的，所以探针现在最多重试三次 dispatch；修复后连续三次探针都是 `usable`。
- 探针失败会自动收窄已验收的基线（安全方向）。这是有意的，但意味着一次时序竞争就能让控制不可用，直到下一次探针成功；上面的重试就是缓解，revision 轨迹（`accept, accept, narrow, accept`）如实记录了发生过什么。

本轮自动化测试：`pnpm test` 181 个全通过（其中 32 个是目录、基线读取器、门控和验收的测试，用固定夹具、不需要 compositor），`pnpm run typecheck` 无错误，双语配对门禁通过。

## 桌面与漂移（2026-11-18）

桌面和漂移这部分于 2026-11-18 在测试机上验证，环境是 Hyprland 0.57.2、Lua provider 和 `wayland` 后端。这一节记录的是那一次运行，不保证另一台宿主的嵌套窗口、输出尺寸或配置哈希也会如此。

`hyprscope control desktop start` 在 runtime 根目录 `/run/user/1000/hs` 下创建了签名 `11cbc6c..._1794934801_1106711295` 的嵌套实例；嵌套监视器是 `WAYLAND-1`，1228×1398。agent 桌面上的探针报告 `usable`，17 项 supported、0 项 unsupported、2 项 unknown：`observe.window.modes`（当时没有打开窗口）和 `dispatch.window.move-to-workspace`（有意不测）。用户桌面的探针报告 `usable`，18 项 supported、0 项 unsupported、1 项 unknown，仍是 `dispatch.window.move-to-workspace`。

验收 agent 基线之后，`doctor --desktop agent` 报告 `fresh`。加入 `config/hypr/agent/extra.lua` 后，观察到的配置哈希变成 `f0386a45...`；`doctor` 随即报告 `stale`，差异是 `configHash`，`hyprscope control run plans/live-terminal.json --dry-run --desktop agent` 以退出码 1 和 `CAPABILITY` 结束。删掉这个片段后恢复 `fresh`。

另一次检查里，改过片段之后，探针守卫面对的是与记录哈希不一致的生成配置：`hyprscope control baseline --probe --desktop agent` 以退出码 1 和 `DESKTOP_FAILED` 结束，消息是 `The desktop configuration changed since it started; stop and start the desktop before probing it`。随后桌面被停止；没有在配置已变的情况下重新跑探针。

`hyprscope control run plans/live-terminal.json --desktop agent` 在没有同意卡片的情况下完成 5 个 op（`focusWindow`、`click`、`text`、`chord`、`screenshot`）。运行回执带 `target {kind: "agent", signature: "...", managed: true}`，运行目录是 `out/runs/20261117T170106-5e8a83`；截图是 1186×1356 和 1139×1220，来自嵌套输出，而不是用户的 2560×1440。按桌面区分的租约记录最后是 `phase: released`、`grantedBy: desktop`。

在 `waitEvent` 计划执行到 1.5 秒时停止桌面，运行变成 `faulted`，`fault.broken.kind` 为 `target.desktop-closed`。嵌套桌面运行期间，`hyprscope doctor` 和 `doctor --desktop user` 都解析到用户的签名，`--desktop agent` 解析到嵌套实例。`hyprscope control desktop attach --runtime-dir /run/user/1000 --signature <用户签名>` 以退出码 2 和 `USAGE` 结束。

更早的用户基线没有 effective 字段；一次探针把它自动收窄，并记录 `followMouse: "1"`、`binds {count: 163, plainF12: false}`、`configErrors: []`；之后 `doctor` 报告 `fresh`，用户的 `run --dry-run` 通过。

本轮自动化检查：`pnpm test` 258 个测试全部通过，`pnpm run check` 通过（11 个文档对、类型检查、测试）。

## 统一 CLI（2026-11-18）

两个入口合并成了 `bin/hyprscope.ts`；`bin/hyprlease.ts` 已删除。观察命令保持原样，所有会改变桌面或租约的命令都在 `hyprscope control` 下。

- `node bin/hyprscope.ts --help` 列出观察命令和一行 `control`；`node bin/hyprscope.ts control --help` 列出 `run`、`request`、`status`、`done`、`panic`、`baseline`、`install-bind`、`uninstall-bind` 和 `desktop`。
- `node bin/hyprscope.ts run` 以退出码 2 结束，提示 `Unknown command run; control commands live under "hyprscope control run"`，漏写命名空间不会落到观察路径。
- `node bin/hyprscope.ts control status --json` 在没有 compositor 时也能读出租约记录；没有受管桌面时，`node bin/hyprscope.ts control desktop status --json` 报告 `absent`。
- `pnpm run typecheck` 和 `pnpm test` 都通过：264 个测试，包含新增的路由测试，以及删除历史兜底块的测试。
- `node bin/hyprscope.ts control desktop start --size 900x700` 启动了嵌套实例，`control desktop status` 的各项检查都为 true，生成的 bind 调用 `bin/hyprscope.ts control panic --desktop agent`，`control desktop stop` 删除了 runtime 根目录。
- 合并前安装的兜底快捷键指向已删除的 `bin/hyprlease.ts`。`hyprscope control uninstall-bind` 同时识别两代标记，`hyprscope control install-bind` 写入 `hyprscope` 的命令和描述。这一轮没有改写用户的实机配置；合并后请重新安装快捷键。

## DSH 插件（2026-11-18）

DSH 插件 bundle 于 2026-11-18 在同一台测试机上验证：Hyprland 0.57.2、Lua provider、`wayland-1` 显示、runtime `/run/user/1000`、Node 26.13.1，DSH 0.2.2-rc.3 装在 `/home/jw/.local/share/deepseek-harness`，profile 为 `web`。

**安装**：`plugins/dsh-hyprscope-tools/` 用 `plugin_manager` 的 `install_bundle` 装进 profile；结果是 `application: applied`，插件行 `include:hyprscope-tools` 处于 `active`，运行中的工具注册表列出了七个工具：`hyprscope_observe`、`hyprscope_screenshot`、`hyprscope_events`、`hyprscope_lease`、`hyprscope_plan`、`hyprscope_baseline` 和 `hyprscope_desktop`。下面的后续小节加入了 `hyprscope_act`，现在是八个。

**实机调用**：这次跑过的调用要么只读，要么在同意卡片出现之前就被拒绝：

- `hyprscope_observe` 的 `kind` 分别取 `active`、`state` 和 `doctor`，都拿回了解析后的结果；`doctor` 的渲染去掉了 `capabilities.wayland.globals`，`state` 的结果没有超出渲染上限。
- `hyprscope_screenshot` 用 `scope: "region"` 和 `region {x: 0, y: 0, width: 480, height: 270}` 截出 480×270 的 PNG，并把图片挂到了结果上。
- `hyprscope_events` 用 `timeoutMs: 600` 返回 `{events: [], timedOut: true}`。
- `hyprscope_lease` 的 `status` 读到已释放的租约，`hyprscope_desktop` 的 `status` 读到已关闭的 agent 桌面记录。
- `hyprscope_plan` 的 `validate`（对 `plans/live-terminal.json`）和 `hyprscope_lease` 的 `request` 都在同意卡片出现之前以 `CAPABILITY` 失败，因为这台机器上没有已验收的能力基线；一份故意写错的内联计划则以 `PLAN_INVALID` 失败。

**第一次实机运行暴露的缺陷**（真实发生）：`hyprscope_events` 的渲染返回了一个裸字符串，报错 `content.some is not a function`；修复渲染、重新组合 profile 之后再次验证通过。

**没有验证的**：控制执行（没有验收基线，计划 `run`、租约授予都没有实际跑过）、bundle 的 locale、图标与详情元数据在 GUI 里的渲染、纯文本模型路由上的图片（只有单元测试覆盖）、agent 桌面生命周期（`start`、`attach` 和 `stop` 没有在实机上演练）。

本轮自动化检查：`node --test plugins/dsh-hyprscope-tools/test/` 59 个测试全部通过，0 失败；仓库测试套件 264 个测试全部通过；`pnpm run typecheck` 无错误；双语配对门禁通过。

## 计划绑定后续（2026-11-18）

同一天晚些时候简化了计划提交路径：计划只提交一次、不会重发，因此去掉了规范计划哈希和 helper 的 `--plan` 证明。

- `hyprscope control run` 现在还接受 `-`，从 stdin 读取计划文档（一个 JSON 文档，最多 1 MiB）；文件路径照旧可用。文档在同意卡片之前只加载并校验一次，执行器跑的就是内存里的计划。
- 租约记录 `planBound: true` 和 `planSummary`，不再有 `planHash`/`rootPlanHash`；每条 `renewals[]` 是 `{at, attempt, ttlMs, expiresAt}`。执行器每次变更前要求同一 lease id、`planBound: true`、未过期；注入 helper 用 `--lease-state` + `--lease`，检查 `planBound` 而不是摘要。
- DSH 组合包把内联计划通过 stdin 提交，不写计划文件，并新增 `hyprscope_act`：把单个动作作为一步计划走同一条运行路径。
- 去掉哈希的原因是它从来没有防住"运行中途改文件"（执行器在同意之前只加载一次计划）；剩下的作用只是审计便利，而规范的 `plan.json` 快照和租约身份/尝试计数已经覆盖了这一点。

本轮验证：`pnpm run typecheck` 无错误；`pnpm test` 通过 339 个测试（仓库 272 + 组合包 67）；`pnpm run build:inject` 用新证明重建了 `bin/wl-inject`，并把重建后的 helper 对着实机会话跑过：无计划绑定、已过期、consent 阶段三种租约都在发出任何命令之前被门控拒绝，`--plan` 参数也按未知参数被拒绝。手工用 `control run -` 提交的文档被解析后以 `CAPABILITY` 拒绝（本机没有已验收基线），而非法 JSON、空输入和缺少参数分别按预期报 `PLAN_INVALID` 或用法错误。双语文档门禁通过 12 对。

未验证：新绑定下"同意卡片 → 执行"这条路径（本机仍没有已验收的能力基线）、`planBound` 下的实机注入，以及 `hyprscope_act` 的真实运行。本记录前面的小节提到 `planHash`，该字段已不存在。

## 同意界面：基线验收与计划预览（2026-11-18）

基线验收和计划预览挪到了同一张同意卡上：基线流程不再需要终端命令，计划则是"读懂它要做什么"之后再批准。上一节留下的未验证项——同意卡到执行的路径、`planBound` 下的注入、`hyprscope_act` 的实跑——这里补上了。

- 测量结果放宽已验收基线时，探针在同一条命令里向浮层要一张确认卡：结论、必需/可选能力计数、证据哈希。拒绝或超时的卡什么都不写，草稿保留，只有下一次探针会重新询问。确认用的租约记录以 `released`/`denied`/`expired` 结束，带卡片（当时是 `confirm`；下文合并后是 `card` + `approvalOnly`）、`ttlMs: 0`、`planBound: false`，不启动 holder，也永远不会进入 `granted`，所以执行器和 `wl-inject` 都不可能凭它注入。
- 计划租约带一张卡：计划描述、预算和每步一行（`2. click · 在 foot 窗口 内 (0.5, 0.6) 点击左键`），由 `src/plan/card.ts` 从已校验的计划渲染；超过十步的计划显示前十步和剩余步数。旧的单行 `plan · N steps · ops` 预览只作为这次改动之前写入的租约文件的回退。（当时的字段名是 `planCard`；下一节把两个卡片字段合并成了一个。）
- DSH 组合包通过 `hyprscope_baseline` 的 `probe` 动作暴露验收：同一次调用先测量，结果放宽时再让 CLI 弹出确认卡；工具自己不回答那张卡。

本轮实机验证：

- 全程工具调用：`hyprscope_baseline` 的 `probe` 测出 `f1e1ac0e-…`（full、`usable`、19 项能力、451 ms），同一次调用弹出确认卡，宿主点了允许。`baseline.json` 记录 `approval.source: "overlay"`、`approvedAt`，证据哈希与探针写下的相同（`dd7638165d7a…`）；草稿 `baseline.pending.json` 已删除。
- 确认对应的租约记录以 `phase: released` 结束，`grantedBy: overlay`、`ttlMs: 0`、`planBound: false`、`holderPid: null`——是一条批准记录，不是控制窗口。
- 之后 `doctor` 报 `baseline {present: true, state: usable, staleness: fresh}`，无差异；`hyprscope control run` 不再以 `CAPABILITY` 拒绝。
- 一步的 `hyprscope_act`（`movePointer` 到 `1280,720`）由宿主点计划卡后执行，16 ms 完成；回执带 `baseline {state: usable, approvedAt, compositorVersion: 0.57.2}`，运行目录里有 `plan.json`、`result.json`、`timeline.jsonl`。
- 新计划卡用一份两步内联计划（`movePointer` + `assert pointer.position`）验证：卡上显示 `计划 pointer-check：…`、`共 2 步 · 预算 8 秒`、`1. movePointer · 移动指针到 (1280, 720)`、`2. assert · 校验 pointer.position`；租约状态里带这份卡且 `planBound: true`；运行完成，指针回读正好是 `1280,720`，说明断言证明注入确实落地，而不是只信 dispatch 的 ack。`/tmp` 下没有写任何计划文件。

这一轮未验证：探针改用测量计划、两张卡合并这两件事在同一天稍晚完成，记录在下一节。恢复流程和干扰询问本轮没有重新演练。

## 探针改为测量计划，同意卡合并为一张（2026-11-18）

探针里会改变桌面的测量不再是第二个注入方，两张同意卡也合并成了一张。

- 只测量、不自己注入：只读阶段仍在 `src/compat/probe.ts`；探针用已经读到的事实构建一份普通的、已校验的测量计划（`src/compat/probeplan.ts`），把它显示在租约卡上，启动自己的 `bin/wl-scratch` 窗口，发一次 `SIGUSR1` 让客户端解除固定的 320×200 尺寸提示，然后以内部测量模式把计划交给普通执行器。`src/compat/behavior.ts` 已删除；执行器是唯一的注入方。
- 测量模式记录失败而不是 fault：前提不成立、dispatcher 被拒绝、后置条件读不回来，都会被记录下来并继续执行；只有租约丢失、计划预算用尽或外部桌面变化才停止。这个模式不会跑恢复流程，`hyprscope control run` 和计划文档都无法请求它。
- 测量计划只对 scratch 窗口跑了 16 步：幂等工作区 dispatch、聚焦、带断言回读的指针移动、F12 按键、浮动开/关、置顶开/关、全屏开/关、缩放、移动，最后是工作区和焦点恢复。16 步全部提交（`stage: done`）；`probe.jsonl` 记录了每步一条事实、scratch 客户端的 `ready` 与按键行、事件 socket 的往返以及运行后的回读，证据目录里还有这次运行的 `plan.json`、`result.json` 和 `timeline.jsonl`。
- 第一次探测真实验证了测量模式"记录并继续"的行为，也暴露了一个真实缺陷：先移动再缩放浮动窗口时，合成器会以窗口中心为基准缩放，请求的 `(0,0)` 回读成 `(-20,-20)`，`dispatch.window.move` 因此被记为不支持。因为这只是收窄有效集，探针自己应用了更窄的基线（`diff.removed: ["dispatch.window.move"]`）。把测量计划改成先缩放、后移动之后，第二次探测（`c8666874…`）回读到正好 `(0,0,360,240)`，所有被测量的能力都是 supported、没有警告，草稿只放宽了基线。
- 因为草稿重新加回了 `dispatch.window.move`，它需要一次新的验收：卡片弹出，宿主点了允许，`baseline.json` 记录 `approval.source: "overlay"`，证据哈希是 `6ca2096164f2…`。之后 `doctor` 报 `baseline {state: usable, staleness: fresh}`，18 项能力生效，0 项降级、0 项必需能力缺失。
- 只有一张同意卡：`state.json` 只带一个 `card` 字段（标题、行、按钮文字），申请路径只有 `requestLease`。计划租约用它装计划描述和步骤；仅批准请求（`approvalOnly: true`，放宽的探针展示验收卡时使用）用同一张卡装这次行动的事实。浮层只渲染一张卡，记录规则不变：批准保持 `ttlMs: 0` 和 `planBound: false`，允许后以 `released` 结束，不启动 holder，永远不能注入。探针的租约卡和任何计划卡一样，当天早些时候引入的探针专用卡片变体已删除。
- 单卡在真实浮层上核对过。计划同意卡渲染出标题 `Agent 请求执行计划`、原因、`计划 card-check：…`、`共 2 步 · 预算 8 秒`、每步一行、`拒绝` / `允许操控` 和倒计时；仅批准卡渲染出标题 `hyprscope · 接受能力基线`、结论/计数行、`拒绝` / `允许并接受`，没有 TTL 文案。两张都来自同一个 `card` 字段和同一个浮层卡片（`out/verify-plan-card.png`、`out/verify-approval-card.png`）。截图之后由 agent 侧拒绝了这两张卡，所以没有批准任何东西，也没有改基线文件。
- 计划断言不了的效果由探针观察：注入的 F12 到达了 scratch 客户端（`keyPressed: true`），事件往返看到 `openwindow`、`closewindow` 和 `windowGone`，运行结束后 scratch 窗口已从 `hyprctl clients` 消失，工作区和焦点由计划自己的最后几步恢复到原来的样子。没有留下 scratch 窗口或租约。
- 本轮自动检查：`pnpm run typecheck` 干净；`pnpm test` 通过 386 个测试（318 仓库 + 68 组合包），包括 `test/probe-plan.test.ts`（9）、`test/measure.test.ts`（9）和 `test/probe-derive.test.ts`（13）；双语门禁通过 12 对文档。

未验证：多显示器布局下的探测（移动目标是布局原点，指针原点是布局盒），以及两行匹配的 scratch 窗口的歧义路径。恢复流程和干扰询问本轮没有重新演练。

## 组合包改名与新图标（2026-11-18）

DSH 组合包换成了项目自己的名字，插件页的条目也开始说清楚 agent 能用它做什么。

- 改名：目录 `plugins/dsh-hyprscope/`、包 `@local/dsh-hyprscope`（0.3.0）、插件行 id `hyprscope`、模块 `name` 导出 `dsh-hyprscope`。原来的名字是 `plugins/dsh-hyprscope-tools/`、`@local/dsh-hyprscope-tools`、`hyprscope-tools` 和 `dsh-hyprscope-tools`；这份记录前面小节里的路径是改名之前的。
- 插件页标题是 `Desktop observation and control`（`桌面观察与操控`），描述同时点明能力的两半：读取 Hyprland 桌面（会话、窗口、截图、事件），以及只在宿主批准的计划下改变窗口、指针或工作区。
- 眼睛图标换成了屏幕加指针（`icon.svg`）：屏幕是 agent 观察的桌面，指针是它执行的动作；同意的含义留在卡片上，图标不需要监视的符号。
- `web` profile 用 `plugin_manager` 更新：先对旧包名 `remove_bundle`，再对 `/home/jw/workspace/dsh-hyprscope/plugins/dsh-hyprscope` 执行 `install_bundle`。两次都返回 `application: applied`，`list_bundles` 现在只有 `@local/dsh-hyprscope` 0.3.0（已启用、已安装，行 `hyprscope`，来源是链接目录），旧条目已消失。
- 显示元数据用 DSH 自己的 `readPluginMeta` 配上 profile 的模块基址读了一遍：`title` 解析为 `{en: "Desktop observation and control", zh: "桌面观察与操控"}`，`description` 是对应的中英一对，`icon` 是一个 `image/svg+xml` data URI，没有诊断信息。工具注册表里仍然是同样的八个 `hyprscope_*` 工具，说明改名没有动工具名。
- 自动检查：`pnpm test` 通过 386 个测试（318 仓库 + 68 组合包），`pnpm run typecheck` 干净，双语门禁通过 12 对文档。

未验证：插件页和设置页在浏览器里怎么画这个新图标和本地化文字，这个会话没有浏览器控制；图标只在 DSH 之外用 `rsvg-convert` 渲染，在行内尺寸和卡片尺寸、浅色和深色背景上看过。

## 语言、离屏截图与 doctor（2026-11-18）

双语同意卡、插件的语言映射、离屏窗口截图和新的 doctor 检查都在同一台测试机上于 2026-11-18 验证：Hyprland 0.57.2，`wayland-1`，活动工作区 2，工作区 1 上有一个 `foot` 窗口，工作区 4 上还有一个 `foot` 窗口。

**CLI 双语同意卡。** 演示计划只是移动两次指针再暂停，所以批准也碰不到任何窗口；原因是 `demonstrate the bilingual consent card`。中文卡和英文卡来自同一条命令，只改语言选项：

```bash
node bin/hyprscope.ts control run .tmp/lang-demo-plan.json --lang zh
node bin/hyprscope.ts control run .tmp/lang-demo-plan.json --lang en
```

- `--lang zh` 渲染中文卡：标题 `Agent 请求执行计划`、原因、`计划 lang-demo：move the pointer twice, then pause; nothing is clicked`、`共 3 步 · 预算 8 秒`、每步一行、`拒绝` / `允许操控` 和倒计时。
- `--lang en` 渲染英文卡：标题 `Agent requests to run a plan`、同样的原因、`Plan lang-demo: move the pointer twice, then pause; nothing is clicked`、`3 steps · budget 8 s`、每步一行、`Deny` / `Allow control` 和倒计时。
- 等待中的 `state.json` 原样带着这张卡——标题、行、`acceptLabel: "允许操控"`、`denyLabel: "拒绝"`——宿主点了允许之后它记下 `grantedBy: "overlay"`；租约以 `released` 结束，`planBound: true`、`ttlMs: 28000`，运行就在这次同意下完成。
- 这次点击让等待中的调用继续，没有另起 CLI 进程：浮层自己写答案文件，等待的工具读到决定后继续。
- 三次演示运行都以 3 步完成，耗时 324–332 ms（`out/runs/20261118T153417-2c3f0d`、`…-73dc5f`、`…-b52d83`）；上面引用的记录来自 `…-b52d83` 的 `state.json`。

**DSH 插件语言映射。** 计划工具用插件自己的 handler、以 `language: "en"` 驱动：

```bash
node .tmp/dsh-plugin-driver.mjs
```

驱动脚本调用 `execute({ action: "run", planPath: ".tmp/lang-demo-plan.json", language: "en", consentSeconds: 60 })`；插件把语言映射成生成 CLI 上的 `--lang en`，卡片用英文渲染（`Agent requests to run a plan`、`Deny` / `Allow control`），调用返回 `RESULT {"runId":"20261118T153952-35bd94","status":"completed","steps":3,"fault":null}`。同一张卡期间又做了一次定时运行（`out/runs/20261118T154048-2abedb`），同样 3/3 完成，耗时 334 ms。

**离屏窗口截图。** 工作区 2 处于活动状态时，`--window-id` 截取了工作区 1 上映射中的 `foot` 窗口，以及工作区 4 上的另一个：

```bash
node bin/hyprscope.ts screenshot --window-id 0x560360f3c380 --output .tmp/verify-window-ws1.png --json
node bin/hyprscope.ts screenshot --window-id 0x56035f695030 --output .tmp/verify-window-ws4.png --json
```

工作区 1 的截图是 2448×1378，`source.scope: "window"`，`window {identifier: "180002d9", appId: "foot", title: "~/w/dsh-hyprscope"}`；工作区 4 的截图是 1228×1398，`window {identifier: "180001c6", appId: "foot", title: "rclone mount OneDriv ~"}`。Hyprland 地址经 `hyprctl clients` 转成 foreign-toplevel id，每张 PNG 用的是窗口自己的尺寸，而不是 2560×1440 的输出尺寸。

**新的 doctor 检查。** `doctor` 现在报告一个 `environment` 块和一条 `capture.window` 限制；两者都是对既有字段的追加：

```bash
node bin/hyprscope.ts doctor
node bin/hyprscope.ts doctor --json
```

- 浮层运行时：`quickshell at /usr/bin/quickshell (default)`——这是 PATH 查找，遵循 `HYPRSCOPE_QUICKSHELL`；doctor 从不启动浮层或该二进制。
- 状态目录：`/home/jw/.local/state/hyprscope (exists, not writable)`，`state hint` 写着 `EROFS: read-only file system`。这是本 agent 的文件沙箱，不是宿主：用新的 `XDG_STATE_HOME=$PWD/.tmp/state-probe` 再跑一次，报告 `exists: false, writable: true, probe: …/.tmp/state-probe`，之后目录仍然是空的，说明检查不创建任何东西。
- `capture.window`：窗口截图对非活动工作区上或离屏的已映射窗口同样有效，PNG 用的是窗口尺寸而不是输出尺寸。
- 截图预检：显式 `--output` 必须指向一个已存在且可写的目录。缺失的目录和 `chmod 500` 的目录都以退出码 1 失败，报 `SCREENSHOT_FAILED: Cannot write the capture: …; pass --output <writable path>`；而 `XDG_CACHE_HOME=$PWD/.tmp/cache node bin/hyprscope.ts screenshot` 仍然创建默认的 `hyprscope` 缓存目录，并写下一张 2560×1440 的布局截图。

本轮自动检查：`node --test test/doctor.test.ts test/screenshot.test.ts test/cli.test.ts test/live.test.ts` 通过 50 个测试（11 + 17 + 14 + 8）；新增的 live 测试从运行中的合成器读取 doctor 的 `environment` 块，既有的 live 窗口截图测试截取了一个离屏窗口。本对文档已用双语配对门禁重新记录。

## 歧义窗口选择器与显式截图输出（2026-11-18）

当时开着两个 `foot` 窗口，一个在工作区 1、一个在工作区 4，活动工作区是 2。`--window-app foot` 现在会把歧义拒绝掉，每个候选一行稳定的说明，而不是只给一个数量：

```bash
node bin/hyprscope.ts screenshot --window-app foot --output .tmp/ambiguous.png
```

命令以退出码 2 结束，报 `USAGE: 2 windows match this application id; use --window-id to pick one:`，随后按工作区、再按地址排序列出候选：工作区 1 的 `0x560360f3c380` `foot` `title "~/w/dsh-hyprscope"`，工作区 4 的 `0x56035f695030` `foot` `title "rclone mount OneDriv ~"`；因为活动工作区是 2，两者都标成 `off-screen`。`--json` 在 `details.candidates` 里带同样的有序列表，外加 `details.hint`；`--window-title` 的重名窗口走同一条路径（两个真实 `foot` 标题不同，所以用假合成器做了单元测试）。

显式 `--output` 指向不存在的目录时，现在会在截图 helper 运行之前失败：`captureToplevel()` 复用 `capture()` 的同一个 `SCREENSHOT_FAILED` 预检，因此 `--window-id 180002d9 --output .tmp/no-dir/window.png` 以退出码 1 结束，报 `Cannot write the capture: the capture directory does not exist; pass --output <writable path>`，并且没有创建目录。布局截图的默认 `$XDG_CACHE_HOME/hyprscope` 路径仍然会被创建。

本轮自动检查：`node --test test/window-selector.test.ts test/toplevel.test.ts test/screenshot.test.ts test/cli.test.ts test/live.test.ts` 通过 53 个测试（6 + 8 + 17 + 14 + 8），`pnpm run typecheck` 干净。本对文档已用双语配对门禁重新记录。

## 桌面消息、提示条与快捷键（2026-11-19）

桌面消息面在同一台机器上演练过（Hyprland 0.57.2、Quickshell 0.3.2、2560×1440）。

- 渲染：用夹具 `status.json` 运行 `quickshell -p overlay/message -n`，右上角画出了提示胶囊（`hyprctl layers` 报告 `hyprscope-message-hint`）；没有 `shortcut.txt` 时胶囊写“快捷键未安装”，而不是拿一个没绑上的键冒充；把 `SUPER + ALT + M` 写进去后，胶囊显示的就是这个键。写一份 `open.json` 请求后，输入框出现在中央，文本框获得焦点。截图：`out/hint-no-shortcut.png`、`out/message-hint.png`、`out/message-composer.png`。真实运行时输入框确实占着键盘：打开期间输入法把操作者的按键送进了文本框，这正是预期的独占焦点，也是提交时要先收起浮层的原因。一个调用同一提交函数的调试副本把 `{"id":"mwn831pa-ikeqko","text":"hello from the desktop composer","at":"…"}` 写进了 `outbox/msg-mwn831pa-ikeqko.json`，也就是插件消费的那份文档。
- CLI：`node bin/hyprscope.ts message open --json --lang en` 返回 `{command, dir, overlay: {pid, log}, request, dsh}`，写下 `open.json`，并以 `WAYLAND_DISPLAY=wayland-1`、真实的 `XDG_RUNTIME_DIR` 和指定语言启动浮层；`message stop` 写下 `quit.json`；没有 compositor 时 `message overlay` 以 `NO_SESSION` 失败，缺 Quickshell 时以 `OVERLAY_FAILED` 失败。
- 快捷键：`installBind` 只对着假 `hyprctl` 演练过（两个 `description` 都验证、消息键写进 `shortcut.txt`、冲突和相同键被拒绝）。本轮没有改真实的 `~/.config/hypr/hyprland.lua`，所以两条 bind 还没有真机 `hyprctl binds -j` 条目。
- 插件桥：单元测试用假 Cordis 上下文和假 `bin/hyprscope.ts` 驱动，覆盖激活与状态、启动时浮层重试、会话跟踪（只跟根会话）、消费消息文档、附带截图、`sessionController.prompt` 注入、图片被拒时的不带图重试、错误回执和释放。浮层在成功启动后被杀掉、以及心跳把它重新拉起，只用报告死 pid 的假 CLI 做过单元测试，没有真的去杀一个运行中的 Quickshell。没有对真正在运行的 DSH Host 做注入：当前运行的 Host 早于这次改动，本轮也没有重启它，因此 `sessionController.prompt` 的进程内调用由它的公开方法契约和假服务确立，而不是真机消息。

## 桌面标注、按住说话与意图卡（2026-11-19）

标注面及其桥接和桌面消息面在同一天加入。本节记录这次改动的自动检查覆盖，并如实写明没有演练的部分；它不是“实机路径在别的机器上也成立”的声明。

**自动检查。** `pnpm test` 通过全部 540 个测试，0 失败、0 跳过，覆盖仓库测试套件和 DSH 组合包：契约校验、单元测试，以及一个端到端的假会话集成用例。`qmllint overlay/message/AnnotateSurface.qml overlay/message/shell.qml` 无输出。

- **契约与状态文件** —— `test/message.test.ts`：标注会话 id 与路径形状、拒绝错误版本或字段类型的校验器、原子读写 helper、旧 `open.json` 形状与 `mode: "annotate"` 的对比，以及 CLI 的 annotate 成功、Host 不可用、`NO_SESSION` 和 `OVERLAY_FAILED` 路径（后两者不写请求）。
- **受管 bind** —— `test/lease.test.ts`：三条 bind 及其 description、`--annotate-key` 覆盖、已占用或重复键被拒绝、受管块被替换、reload 失败或部分验证失败后回滚配置和两份快捷键记录（并删掉生成的 Lua 文件），以及完整卸载。
- **桥与意图卡** —— `plugins/dsh-hyprscope/test/annotate.test.js`：按指针再按焦点选监视器、相交窗口列表及其上限、卡片的几何/窗口/评论/语音绑定行、未绑定短语按全局备注、缺截图的说明与文本上限、nonce 与重复请求处理，以及一个完整的假会话：截屏、转写并只注入一条 prompt。
- **语音几何** —— `plugins/dsh-hyprscope/test/voice.test.js`：规范的 44 字节 RIFF/WAVE 头、绝对时间的 PCM 偏移与按采样对齐的切分、带静音/补边/最短长度的 VAD 短语切分，以及全部配对规则，包括 60% 阈值、anchor 回退和 2 秒顺序窗口。

**没有在真实桌面上验证的部分。** 安装器只对着假 `hyprctl` 和假实例演练过，所以真实的 `hyprctl binds -j` 里还没有标注条目，三个快捷键也没有在运行中的 compositor 上按过。标注浮层没有在真实 Quickshell 会话里渲染或操作过：画图、按住 Space 录音、审查卡编辑和错误卡由单元测试和 QML 静态检查覆盖，不是交互验证。没有录过真实麦克风，也没有跑过真实的 SenseVoice 转写；测试喂的是合成 PCM 和假的 `speechToText` 服务。没有向运行中的 DSH Host 注入过意图卡：`sessionController.prompt` 的进程内调用由公开方法契约和假服务确立，而不是真机消息。装上这份 checkout 之后，重启 DSH，运行 `hyprscope control install-bind`，再手工确认：标注快捷键能打开冻结画面，画一个形状并说一段话会出现在审查卡里，最终消息带着干净截图和几何卡片进入会话。

## 没有覆盖到的

多显示器、多 Hyprland 实例、多 seat、锁屏状态下的行为，这份记录里都没有实测条目，也没做跨版本对比；租约的物理输入拦截能力本来就不存在（见 [LEASE.zh.md](/docs/cli/LEASE.zh.md)）。要下结论得在对应环境里再跑。

宿主窗口关闭这条路径（相对于 `hyprscope control desktop stop`）和一次成功的 external 桌面挂接，本轮都没有演练；只检查了用户自己签名的拒绝，因此这份记录覆盖的是 `desktop stop`，不是关掉宿主窗口。探针对两行匹配的歧义处理，以及它在多显示器布局上的指针原点，都没有在实机上演练过（这里只有一台 2560×1440 显示器）；两者只由夹具或单显示器约定覆盖。计划执行还有几点没做真机验证：焦点/工作区/全屏状态这三类前提的恢复只有单元测试，实机只覆盖了几何前提；`maxResumes > 1` 的多次恢复、跨工作区恢复、特殊工作区都没有实测；`moveWindow`/`floatWindow`/`resizeWindow`/`fullscreenWindow` 在计划里的端到端效果只覆盖了 move/resize/float（dispatch 本身单独实测过，全屏恢复的 `fullscreen_state` 只在源码和单元测试层面确认）。