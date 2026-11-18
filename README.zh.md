# dsh-hyprscope

[English](/README.md) | 中文

> **说明：** 本仓库的代码由 AI 生成，作者只负责项目设计和代码审查。

一个用于观察 Hyprland 桌面、并在同意门控下实施控制的 CLI 工具，外加一个原生、开箱即用的 DeepSeek Harness（DSH）插件。观察层只读：找会话、读窗口/工作区/监视器、截图、订阅事件。需要动手的时候另走一套控制租约：宿主同意之后 agent 才能接管，随时可以收回。

它先解决一个具体问题：DSH 的进程常常不在图形会话里，`WAYLAND_DISPLAY`、`HYPRLAND_INSTANCE_SIGNATURE` 都是空的，既看不见桌面，也不知道该把请求发给哪个 compositor。hyprscope 负责找到会话，把状态整理成稳定的字段，方便以后接 DSH 的 CUA provider。

项目只有一个入口：`hyprscope` 负责只读观察，`hyprscope control` 是带同意门控的控制面。两边共用会话发现和观察代码，但只读命令不会加载租约、执行器或桌面生命周期的代码，所有会改变桌面的命令都在 `control` 下面。

## 快速开始

需要 Node 22 以上、pnpm，以及一个正在运行的 Hyprland。截图依赖 `grim`；锁状态读 `loginctl`，读不到时相关字段会标成不可用。

```sh
pnpm install
pnpm test
pnpm run doctor
pnpm run typecheck
```

`pnpm install` 装的是 TypeScript 和 Node 类型声明这两个开发依赖，运行时依旧零依赖；代码主体是 TypeScript，Node 直接执行 `.ts`，没有构建步骤。

`pnpm test` 跑单元测试和实时测试，没有 Hyprland 时实时那部分自动跳过；`pnpm run doctor` 打印会话发现结果、compositor 版本和可观察项；`pnpm run typecheck` 只做类型检查，不产出文件。

Wayland 探针是可选的，编译之后 `doctor` 才会多报 seat 数量和注入相关的协议：

```sh
pnpm run build:probe
```

要执行带指针/键盘动作的计划，还得编译注入 helper（C，纯 Wayland 客户端，无额外依赖）：

```sh
pnpm run build:inject     # -> bin/wl-inject
```

控制还需要一份已验收的能力基线（capability baseline）。`hyprscope control` 在动桌面之前，得先知道这台机器确实支持工具假定的那些能力；探针会打开自己的测试窗口（scratch client），做几次往返来测量，所以它先申请一份短租约：

```sh
pnpm run build:scratch                          # -> bin/wl-scratch, the probe's own window
node bin/hyprscope.ts control baseline --probe          # measure this machine; the consent card says why
node bin/hyprscope.ts control baseline --show           # what was measured, what is missing, the diff
node bin/hyprscope.ts control baseline --accept         # the host confirms on a desktop card; control is gated by this file
```

在这份文件通过验收之前，`hyprscope control run` 和 `hyprscope control request` 会在同意卡片出现之前就拒绝；只读的 `hyprscope` 不受影响。

日常命令走入口脚本：

```sh
node bin/hyprscope.ts state
node bin/hyprscope.ts screenshot --region 0,0,640,360 --output out/region.png
node bin/hyprscope.ts events --match 'workspace|activewindow' --count 2 --timeout 5000
```

## 功能

### 借桌面控制权给 agent

`hyprscope` 只做观察、不改桌面；要操作桌面时使用 `hyprscope control`，它是一套带租约门控的工具和行为控制逻辑，Agent 使用它来操控界面，这样迫使 Agent 不会做出预期之外的行为，同时更加地高效（见批执行一节）：
```sh
node bin/hyprscope.ts control install-bind                     # install once: SUPER + ALT + ESC revokes at any time
node bin/hyprscope.ts control request --reason "填写登录表单" --ttl 120
node bin/hyprscope.ts control done                             # the agent hands control back when done
```

如果兜底快捷键是在 CLI 合并之前装的，需要重装：旧 bind 指向已删除的 `bin/hyprlease.ts`。`hyprscope control uninstall-bind` 仍能识别旧标记并删除它，随后 `install-bind` 写入 `hyprscope control panic` 命令。合并前启动的受管桌面，其生成的应急键也有同样问题；停掉再启动即可。

`request` 会在屏幕中央弹一张同意卡片（允许 / 拒绝，45 秒不选自动拒绝）。批准后卡片缩成顶部横幅，显示剩余时间，右侧有「立即收回」。撤销控制权有四种方法：Agent 调 `done`、用户按 `SUPER + ALT + ESC`、点横幅按钮、或者 TTL 到期。

由于 wayland 设计支出本身就是为了给单用户使用，所以无法在 Agent 控制期间直接屏蔽用户的操作，所以物理键鼠不会被冻结。这条边界的完整解释和兜底链条在 [docs/LEASE.zh.md](/docs/LEASE.zh.md)。

### agent 桌面

`hyprscope control desktop start` 会为这个 agent 起一个嵌套 Hyprland，在宿主桌面上显示为一个窗口。这个嵌套 compositor 是真正的 Hyprland，有自己的监视器、工作区和客户端，但它与 agent 共用同一个 uid 和同一个文件系统：分开的是桌面，不是权限。人只在 `desktop start` 或 `desktop attach` 时同意一次；进入这个桌面后，`run`、`request` 和 `baseline --probe` 拿的是程序化租约，不再为每次运行弹卡，租约照旧绑定这次提交的计划和 TTL，也照旧由 `wl-inject` 校验。`desktop status` 重新核对 pid、实例目录和 socket，`desktop attach --runtime-dir <dir>` 挂接用户指定的实例，`desktop stop` 结束工具启动的桌面（挂接来的只删记录）。

```sh
node bin/hyprscope.ts control desktop start --size 1280x800   # one nested Hyprland window
node bin/hyprscope.ts control desktop attach --runtime-dir /run/user/1000 --signature <sig>
node bin/hyprscope.ts control desktop status
node bin/hyprscope.ts control desktop stop
```

### 批执行

只要动作超过一两步，就应该写一份计划让程序执行：

```sh
node bin/hyprscope.ts control run plans/live-terminal.json --dry-run   # validate only, no consent card
node bin/hyprscope.ts control run plans/live-terminal.json             # show the consent card, execute after approval
```

计划只在提交时读取一次：试运行只做校验、不征求同意；正式运行在弹同意卡之前把同一份文档加载并校验一次，之后执行的是内存里的计划，所以同意之后在磁盘上改文件也影响不了已经批准的尝试。`control run -` 从 stdin 读计划，DSH 插件就是用它提交计划，不再落盘。

每一步都带前提（`requires`）和预期结果（`expect`）。执行器按 `preflight → commit → verify` 走，前提不成立就快速失败并写一份 fault 记录，包含：哪条假设被打破了、已经确认生效的是哪几步、现场截图在哪。

宿主中途动鼠标、切工作区、抢焦点这类可恢复干扰，会先暂停并弹一张卡片，让你选「继续执行」还是「终止操作」。选继续，执行器不会就地修补，也不重放被中断的那一步：它把这次尝试挂起，用代码合成的恢复步骤加原计划剩下的步骤组成一份新计划，续借同一份租约、给这次尝试独立的执行时间窗，再接着跑。恢复只做机械的事——切工作区、取消全屏、恢复浮动/置顶/位置、回焦点、挪光标；一次运行默认最多恢复 1 次，`--max-resumes 3` 放宽到 3 次、`0` 关闭恢复，每次恢复在浮层回执和运行报告的 `attempts` 里都留痕。关窗口、改监视器、应用界面变化这类接不上的情况不弹卡片，直接终止，把事实交回 agent 重新规划——不会自作主张地"回滚"。

计划能做的事被收得很窄：没有 `exec`、没有任意 dispatcher、没有配置修改，坐标默认相对窗口，绝对坐标属于低置信动作。完整的谓词表、op 表、恢复模型和 fault 格式在 [docs/PLAN.zh.md](/docs/PLAN.zh.md)。每次运行的产物在 `out/runs/<runId>/`（计划、时间线、截图、fault、恢复尝试各自的子目录）。

### 命令

| 命令 | 作用 |
|---|---|
| `doctor` | 会话发现路径、compositor 版本、可观察项、Wayland 全局对象 |
| `state` | 一次快照：焦点 + monitors + workspaces + clients + layers + cursor + lock |
| `active` | 只取活动窗口和工作区 |
| `clients` / `workspaces` / `monitors` / `layers` / `cursor` | 单项读取 |
| `screenshot` | 全布局、单监视器（`--monitor`）或区域（`--region x,y,w,h`）截图 |
| `events` | 订阅 compositor 事件流，可用 `--match`、`--once`、`--count`、`--timeout` |
| `hyprscope control run <plan.json \| ->` | 校验计划、把同意绑定到这次提交的计划、执行并交还控制 |
| `hyprscope control baseline --probe / --show / --accept` | 测量这台机器、复核证据、验收控制所依赖的能力基线（验收是一张宿主点击的确认卡） |
| `hyprscope control request / done / panic / status` | 申请、结束、强制收回、查看控制租约 |
| `hyprscope control desktop start / attach / status / stop` | 启动嵌套 agent 桌面、挂接已有实例、查看两者状态，或停止 |
| `hyprscope control install-bind / uninstall-bind` | 安装或移除 `SUPER + ALT + ESC` 兜底 |

通用选项：`--json`、`--desktop <user|agent|external>`、`--signature <sig>`、`--runtime-dir <dir>`、`-h`、`-v`；`hyprscope` 另外接受 `--timeout <ms>`。`--desktop` 选命令作用在哪个实例上；观察命令以及 `hyprscope control run`、`request`、`status`、`done`、`panic`、`baseline` 都接受它，省略即用户桌面。脚本里请用 `--json`，人类可读输出只求顺眼，列对齐和措辞不保证稳定；参数错退出码 2，其它失败退出码 1。

截图有三种取法：默认截整个布局，`--monitor NAME` 只截一个输出，`--region x,y,w,h` 用全局布局坐标（`grim` 要的是 `X,Y WxH`，转换由工具做）。会话报告锁定时截图默认拒绝，传 `--allow-locked` 才放行；输出默认写到缓存目录的 `hyprscope/` 下，`--output` 可以换地方。

### DSH 插件

`plugins/dsh-hyprscope/` 是本项目原生、开箱即用的 DSH Host 插件组合包（bundle），把这些命令变成模型可调用的八个工具，DSH 会话不用再自己拼 `node bin/hyprscope.ts ... --json` 命令。`hyprscope_observe`、`hyprscope_screenshot` 和 `hyprscope_events` 只读桌面；`hyprscope_lease`、`hyprscope_plan`、`hyprscope_act`、`hyprscope_baseline` 和 `hyprscope_desktop` 走 `hyprscope control`；`hyprscope_act` 把单个动作当作一步计划执行。观察不需要同意；改变桌面仍然要宿主在控制租约里同意，并且要有一份已验收的能力基线，插件没有加绕开它们的办法。

在**插件**页选择**添加插件**，填入绝对目录 `/home/jw/workspace/dsh-hyprscope/plugins/dsh-hyprscope`；或者让 DSH 里的 agent 用 `plugin_manager` 的 `install_bundle` 装同一个目录。组合包只在 Linux 上加载，需要 checkout 和 Node 22 与 DSH 在同一台机器上。完整的工具面、配置键和限制在 [docs/DSH-PLUGIN.zh.md](/docs/DSH-PLUGIN.zh.md)。

## 为什么会话要自己找

DSH 进程是从服务或另一条链路起来的，环境里没有 `HYPRLAND_INSTANCE_SIGNATURE`，`WAYLAND_DISPLAY` 也常常是空的，没法像普通客户端那样连上 compositor。hyprscope 先扫 `$XDG_RUNTIME_DIR/hypr/` 下的实例目录，挑一个还挂着控制 socket 的，再从目录里的 `hyprland.lock` 读第一行的 pid、第二行的 Wayland display；这两样是 Hyprland 启动时自己写下的，跟调用方的环境无关。

控制 socket 和 `grim` 于是落在同一个实例上，截图不会拍错 compositor。显式传 `--signature` 能把目标钉到某个实例，`--runtime-dir` 和 `HYPRSCOPE_*` 可以覆盖运行目录和 display，`doctor` 的 `discovery` 字段会说明这次实际走的是哪条路。租约也复用同一套发现逻辑，浮层进程同样拿到正确的 `WAYLAND_DISPLAY`。

字段含义、坐标约定、错误码和与 `dsh-cua` 的映射在 [docs/PROTOCOL.zh.md](/docs/PROTOCOL.zh.md)，租约的完整设计在 [docs/LEASE.zh.md](/docs/LEASE.zh.md)，测试机当时的验证记录在 [docs/VERIFICATION.zh.md](/docs/VERIFICATION.zh.md)。换机器、升 Hyprland 或者改配置之后凭什么还敢接管桌面，思路在 [docs/COMPATIBILITY.zh.md](/docs/COMPATIBILITY.zh.md) 和 [docs/BASELINE.zh.md](/docs/BASELINE.zh.md)：安装时用探针把能力测一遍、由人验收成一份基线，运行时只能按它收窄。控制受这份基线门控：需要的能力如果没有测出可用，计划会在同意卡片之前被拒绝；运行失败也不会改动基线。

agent 桌面——给 agent 一个自己的嵌套 Hyprland——已经实现；设计与生命周期在 [docs/DESKTOP.zh.md](/docs/DESKTOP.zh.md)。

## 已知限制

- 租约不拦截物理输入：宿主可以在租约期间照常动键鼠，靠快捷键/按钮/TTL 结束控制，不靠冻结输入。
- 计划里的绝对坐标点击是低置信动作：谓词检查和注入之间仍有无法消除的缝隙（TOCTOU），所以这类步骤要求焦点、几何和结果断言一起成立；能用键盘和 dispatch 表达的动作优先用它们。
- 租约状态和执行器都跑在 agent 同一个 uid 下，租约绑定和门控目前是正确性机制，不是安全边界；要变成真边界得把租约状态挪到独立 broker（见 `docs/LEASE.md`）。
- 能力基线要由人验收之后控制才可用，而基线只反映上一次探针的结果：`doctor` 会报告漂移，`run` / `request` 遇到 stale 或 unverified 的基线会以 `CAPABILITY` 拒绝。换机器、升 Hyprland 或改配置之后要重跑 `hyprscope control baseline --probe`；旧版本写下的基线没有 effective 值，读出来是 `unverified`，需要重新探一次并验收。
- agent 桌面是宿主上的一个窗口，不是另一台机器：它和 agent 共用 uid 和文件系统，嵌套输出跟着宿主窗口走（`--size` 只是请求，不是保证），关掉这个窗口就会销毁桌面。正在里面执行的运行会以 `target.desktop-closed` fault。
- agent 桌面默认不跨 DSH 重启存活；新的 DSH 会话要自己起一个，或者挂接已有的实例。
- 改动运行中 agent 桌面的生成配置会让它的基线变成 stale，而 `baseline --probe` 拒绝测量已经变化的实时配置；先重启桌面，再跑一次探针并验收。
- 恢复只覆盖 compositor 能观察、能用 dispatch 子集重建的前提；应用内部状态接不上的情况直接 fault，让 agent 重新规划，不假装恢复。
- 锁状态是尽力而为：只读 logind 的 `LockedHint`，`locked: null` 只说明没有证据，不等于会话已解锁。
- 同机跑多个 Hyprland 时默认按日志新旧挑一个，不确认它是否还响应，最好显式传 `--signature`。
- 其余字段跟着 Hyprland 版本走，版本敏感点和字段定义看 [docs/PROTOCOL.zh.md](/docs/PROTOCOL.zh.md)，脚本请依赖 `--json`。
