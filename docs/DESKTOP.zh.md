# agent 专用桌面（`hyprscope control desktop`）

[English](/docs/DESKTOP.md) | 中文

> 状态：**已实现**。`hyprscope control desktop start|attach|status|stop` 管理嵌套或挂接的实例，观察命令和控制命令都用 `--desktop user|agent|external` 选择目标，2026-11-18 的实机验证记录在 [VERIFICATION.md](/docs/VERIFICATION.zh.md)。能力基线（[COMPATIBILITY.md](/docs/COMPATIBILITY.zh.md)、[BASELINE.md](/docs/BASELINE.zh.md)）和租约（[LEASE.md](/docs/LEASE.zh.md)）在这里复用；§12 列出仍未决的问题。

## 1. 它是什么

嵌套 Hyprland 是在用户会话里、作为一个普通 Wayland 客户端运行的第二个合成器，它把整个桌面画进一个窗口。用户看到一个窗口；agent 得到自己的窗口列表、工作区、seat 和 socket，注入进去的输入不会到达用户的 seat。

它隔离的是**输入和注意力**，不是权限：同一个 uid、同一个文件系统。agent 桌面里的程序照样能读用户的文件；如果在意这一点，边界应该是独立 uid 或容器，而不是这个功能。

三种 target，必须显式选择：

| target | 谁提供 | 同意 | 计划如何运行 |
|---|---|---|---|
| `user` | 用户自己的 Hyprland | 和现在一样，每次 run 一张卡 | 在租约下运行 |
| `agent` | `hyprscope control desktop start` 启动一个嵌套实例 | 启动时一次 | 不再逐次弹卡 |
| `external` | 用户指定一个实例 | 挂接时一次 | 不再逐次弹卡 |

默认是 `user`。已经存在的 agent 桌面不会悄悄截走本来发给用户桌面的命令：只有明确要求时，`agent` 和 `external` 才会生效。

## 2. 目标选择与寻址

- 观察命令和所有针对桌面的控制命令都接受 `--desktop user|agent|external`；省略即 `user`。
- 默认的 `user` 解析会排除 `desktop.json` 里记录的签名，正在运行的嵌套桌面因此不会悄悄变成用户的桌面；显式传 `--signature` 仍然优先。
- `agent` 必须用 `desktop start` 显式创建；没有实例时 `run --desktop agent` 以 `TARGET_UNAVAILABLE` 失败，绝不顺手起一个桌面。
- `external` 用 `desktop attach --runtime-dir <dir> [--signature <sig>]` 挂接；与用户自己实例相同的签名会被拒绝，因为那是 `user`，需要逐次卡片。
- 回执（`doctor`、`run`、`desktop status`）都带 `target` 和解析出的 `signature`，回执不可能被读成另一个桌面的；数组形式的观察命令通过 `session` 标识实例。
- `hyprscope` 也接受同一个选择器做只读观察；解析 target 只读 `desktop.json`，从不获取租约。

## 3. 生命周期

`desktop start` 以脱离的方式拉起嵌套合成器（建议把命令作为 DSH 后台任务运行），等待实例目录和 Wayland socket 就绪，写 `desktop.json` 后返回。`desktop status` 重新核对记录的 pid、实例目录、两个 socket，以及（对生成的配置而言）配置哈希，报告 `absent`、`running`、`closed` 或 `stale`。`desktop stop` 是"关窗"的主动版本。

- 没有 systemd unit，也没有自动重启：桌面会一直运行到 `desktop stop`、窗口被关闭或登录会话结束。
- 关窗即销毁桌面。这是桌面自身唯一的撤销路径，`desktop stop` 是它的主动形式。
- 如果当时有计划在跑，它以 `target.desktop-closed` fault，保留已确认的步骤，把事实交回来；agent 在对话里问用户是不是误触。
- 关掉的桌面不会自动重启。关掉之后再 `desktop start` 会创建新实例，带新签名，新桌面需要自己的探针和验收。

还有两点仍未决（§12）：关父窗口是否真的终止嵌套合成器，以及 DSH 会话结束时会不会回收后台任务的子进程。`desktop stop` 本身已经在测试机上验证过。

## 4. 目录

```
/run/user/1000/hs/                     # runtime, 0700, recreated on start
  hypr/<signature>/                    # hyprctl and event sockets
  wayland-1                            # the nested compositor's Wayland socket
  desktop.pid

$XDG_STATE_HOME/hyprscope/desktop/     # persistent, agent-editable
  desktop.json                         # signature, display, pid, config hash, consent
  config/hypr/hyprland.lua             # generated, minimal
  config/hypr/agent/*.lua              # the agent's own binds and rules
  logs/
  baseline/<signature>.json            # probe result for this desktop
```

- runtime 根目录必须短：Hyprland 0.57.2 的实例签名是 61 个字符，Unix socket 路径上限是 107 字节。workspace 下的路径光是 `.socket2.sock` 就会超限，事件流直接不可用；产品用 `$XDG_RUNTIME_DIR/hs`（测试环境是 `/run/user/1000/hs`），`HYPRSCOPE_DESKTOP_RUNTIME_DIR` 可以为测试覆盖它。启动前先做长度检查，超限就明确失败。
- `/run/user/1000` 是 tmpfs：随登录会话存在，登出或重启即清空。socket、pid 和实例目录放这里；agent 想长期保留的东西不放这里。
- `$XDG_STATE_HOME/hyprscope/desktop/` 是持久目录：生成的配置、agent 自己的片段、日志、`desktop.json`，以及这个桌面的基线。
- 这个桌面的基线是 `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json`（草稿 `<signature>.pending.json`）；用户桌面保留机器级的 `$XDG_STATE_HOME/hyprscope/baseline.json`。
- 这个桌面的租约状态在 `$XDG_STATE_HOME/hyprlease/<signature>/`；用户桌面保留 `$XDG_STATE_HOME/hyprlease/`。`HYPRSCOPE_LEASE_SIGNATURE` 只在内部选中按实例的目录，不是用户可见选项。
- `desktop.json` 和基线是 `0600`；runtime 根目录是 `0700`。

## 5. 配置

- 生成的 `config/hypr/hyprland.lua` 是最小配置：一条 monitor 规则、没有用户快捷键、没有 autostart，还有一个为这个桌面跑 `hyprscope control panic` 的应急键。`--size` 会写进这条 monitor 规则并记进 `desktop.json`，但它只是请求，不是能生效的 resize：实机测试里嵌套输出仍然跟着宿主窗口走（1228×1398）。把它当建议值。
- agent 可以在 `config/hypr/agent/*.lua` 里加自己的快捷键和窗口规则；生成的文件会把它们内联进去，所以"agent 配置自己的桌面"能跨重启保留。
- 第一版只生成 Lua。`hyprctl status` 报出的 provider 不是 `lua` 时，`start` 会明确拒绝，而不是塞给 compositor 一份解析不了的配置；provider 读不到时，交给 spawn 失败和日志尾部兜底。
- 默认不继承用户配置：autostart、全局绑定、monitor 规则和 provider 格式都会跟着进来，基线又会变成跟用户配置相关。之后可以单独做"只继承外观"的显式导入。
- 任何与能力相关的配置改动都会让桌面基线失效（§6）。生成的文件和每个 agent 片段一起哈希成 `configHash`；改一个片段就会改变它，基线随之 stale，直到重启桌面并重测。

## 6. 能力基线与陈旧判定

基线仍然是按实例的结论。用户桌面保留机器级的 `$XDG_STATE_HOME/hyprscope/baseline.json`；`agent` 或 `external` 桌面各有自己的文件 `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json`，所以对一个桌面的探针永远不会门控另一个。

- 漂移比对记录的版本、provider、`input:follow_mouse`、绑定数量、是否绑定了不带修饰键的 F12、作为集合的配置错误，以及记录存在时的 `configHash`。任何不一致都是 `stale`；基线没有记录的值是 `unverified`；运行中的 compositor 报不出来的值是 `stale`。
- 在漂移跟踪之前写下的基线没有 `effective` 块，它是 `unverified`，控制会以 `CAPABILITY` 拒绝，直到重测。
- `desktop status` 会把改动过的生成配置报成 `stale`；`doctor` 报告 target、`fresh`/`stale`/`unverified` 判定、原因和字段差异。`run`（含 `--dry-run`）和 `request` 会在任何同意卡片之前以 `CAPABILITY` 拒绝 stale 或 unverified 的基线，因为控制必须由"对正在运行的东西的测量"来决定；只读观察不受影响。
- 改 agent 片段会让基线失效。运行中的 compositor 还在用旧配置时，探针会被 `DESKTOP_FAILED` 拒绝（`stop and start the desktop before probing it`），所以流程是：先停桌面，再启动（新签名意味着新桌面需要单独探针），然后探测并验收。重启前把片段改回去，基线会重新变成 `fresh`。
- 其余情况下，重测 stale 基线走正常的探针/接受流程；收窄仍然自动生效，放宽仍然需要人工接受。

这也是 agent 桌面比用户桌面便宜的原因：配置是我们生成的，所以版本相关的那一层可以按每个 Hyprland 版本认证一次，而安装层塌缩成"每份生成的配置测一次"。

## 7. 同意

- 启动或挂接 agent 桌面需要一次明确的用户确认（`--consent-source chat|card`，默认 `chat`）；`desktop.json` 记录确认的时间和方式（`source: "chat"` 或 `"card"`），这条记录是桌面内一切操作的依据。
- 在 `agent` 或 `external` 桌面里，`run` 和 `request` 仍然以程序方式获取租约，绑定这次提交的计划和本次尝试的 TTL，但不弹卡片：桌面本身就是同意边界。`baseline --probe` 用的是同一套程序化租约。执行器的租约门禁和注入助手的租约自检照常生效，没有任何路径绕过它们。
- 干扰询问属于用户桌面的浮层，受管桌面没有浮层。所以在 `agent` 或 `external` 里，可恢复干扰会直接让运行 fault，而不是弹卡片；agent 在对话里问用户，也不会派生恢复计划。
- `user` 目标保持现在的模型：每次 run 一张卡、一个租约，随时可撤销。
- `desktop stop` 会显式释放这个桌面的租约。关掉 compositor 窗口会杀掉进行中的 run，它以 `target.desktop-closed` fault，并在自己的 `finally` 路径里释放；没有 run 在跑、只由已脱离的 holder 持有的租约，到 TTL 自然结束。关窗没有单独的撤销路径，因为 compositor 已经没了，但 holder 是独立进程。

`desktop.json` 里的同意记录是可见性，不是认证：agent 用同一个 uid 运行，也能写同样的文件。

## 8. 失败与清理

- `start` 以有界超时等待实例目录、`.socket.sock` 和 Wayland socket；超时就杀掉进程、清掉 runtime 根目录，并带日志尾部报告 `DESKTOP_FAILED`。
- 与运行实例不一致的记录（缺少 socket、配置哈希变化，或 pid 已死但 socket 还在）报告为 `stale`；pid 和 socket 都没了则报告为 `closed`；`start` 在创建新实例前先清理非 running 的记录。
- `attach` 对等于用户自己桌面的签名报 `USAGE`，对 runtime 目录有多个实例报 `USAGE`，对受管的 runtime 根目录报 `DESKTOP_FAILED`，对没有可用实例的 runtime 目录报 `TARGET_UNAVAILABLE`；它只写记录，从不碰外部 runtime 目录。
- `stop` 先向进程组发 SIGTERM、等待、再 SIGKILL，删除 runtime 根目录，把记录标成 `closed` 并释放这个桌面的租约；删不掉就如实报错，不掩盖。对 `external` 桌面，`stop` 只忘掉记录，从不杀进程。
- 计划运行期间桌面消失时以 `target.desktop-closed` fault；run 目录保留时间线和已确认的步骤。受管桌面里的可恢复干扰不会弹卡片，直接 fault，同样保留已确认的步骤和时间线。

## 9. 命令面

```
hyprscope control desktop start [--size 1280x800] [--consent-source chat|card] [--json]
hyprscope control desktop attach --runtime-dir <dir> [--signature <sig>] [--consent-source chat|card] [--json]
hyprscope control desktop status [--json]
hyprscope control desktop stop [--json]
hyprscope control run plan.json --desktop user|agent|external [--json]
hyprscope control request / status / done / panic --desktop user|agent|external [--json]
hyprscope control baseline --probe / --show / --accept --desktop user|agent|external [--json]
hyprscope <command> --desktop user|agent|external [--json]
```

这些命令只在控制入口下存在；`hyprscope` 只是获得选择器，永远不负责启动或停止桌面。`--size` 是建议值（§5）。

## 10. 代码落点

| 位置 | 作用 |
|---|---|
| `src/desktop/lifecycle.ts` | 启动、挂接、状态、停止、就绪等待、清理、Lua 宿主检查 |
| `src/desktop/record.ts` | `desktop.json` 读写、路径、socket 长度检查 |
| `src/desktop/config.ts` | 生成的 Lua、内联 agent 片段、monitor 模式 |
| `src/desktop/hash.ts` | `configHash`：哈希生成的文件和每个片段；只读入口也能导入 |
| `src/desktop/target.ts` | `--desktop` 解析、受管桌面排除、基线/租约键 |
| `src/compat/baseline.ts` | 按实例的基线路径、读取与写入 |
| `src/compat/staleness.ts` | 生效配置测量与 `fresh`/`stale`/`unverified` 比对 |
| `src/lease/cli.ts` | `desktop` 子命令；其余命令上的 `--desktop` |
| `src/plan/run.ts` | 感知 target 的 run、程序化租约、`target.desktop-closed` |
| `test/desktop-config.test.ts`、`test/desktop-lifecycle.test.ts`、`test/desktop-target.test.ts`、`test/staleness.test.ts` | 不依赖合成器的 fixture |

## 11. 它不是什么

- 不是安全边界：同 uid、同文件、没有沙箱。
- 不是剪贴板、portal、音频或 session bus 的桥接；这些一开始是分开的，属于后续工作。
- 不是 headless 或远程：第一版是用户会话里的一个窗口，所以关窗就是 kill switch。
- 不是多 seat：嵌套合成器有自己的 seat，但机器上仍然只有一个物理 seat。
- 默认不跨 DSH 重启存活：合成器是脱离的进程，新的 DSH 会话不会接管它。

## 12. 未决问题

- 关父窗口是终止嵌套合成器，还是只移除它的 output。
- DSH 会话结束时是否会回收后台任务的子进程，以及 `desktop start` 是否需要为 `--persist` 模式用 `setsid` 脱离。
- 用户指定的 `external` 实例里可能有什么，以及它是否应该比 `agent` 有更弱的同意。
- agent 经常改自己的片段时，`configHash` 应该多粗；今天每次改动都会让基线 stale，需要重启再重测，一个 reload 标记可能更便宜。
- 多显示器下的指针原点，单显示器 spike 覆盖不到。
