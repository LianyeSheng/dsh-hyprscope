# hyprscope 的 DSH 插件

[English](/docs/DSH-PLUGIN.md) | 中文

`plugins/dsh-hyprscope/` 是本项目原生、开箱即用的 DSH Host 插件组合包（bundle），把 hyprscope 的命令行变成模型可以调用的八个工具。DSH 会话不用再拼 `node bin/hyprscope.ts ...` 这样的 shell 命令：记住仓库路径、参数顺序和 `--json`，再自己解析输出，都是负担。它会带类型化参数调用 `hyprscope_observe`、`hyprscope_screenshot`、`hyprscope_events`、`hyprscope_lease`、`hyprscope_plan`、`hyprscope_act`、`hyprscope_baseline` 或 `hyprscope_desktop`，拿回一个解析好的对象。

这个组合包只是一层薄包装，不是第二份实现：每次工具调用都以子进程运行 `node bin/hyprscope.ts <command> --json`，参数用 argv 数组传递，不经过 shell。所有门控都留在 CLI 里，插件没有加任何绕开它们的办法。它只有 Host 端：只注册工具，不带页面。

## 它解决什么问题

对 agent 来说，走 shell 在观察上是麻烦，在控制上是风险。观察有一连串小细节要弄对：找到仓库、记住哪个参数在位置参数前面、加上 `--json`、分清退出码 2（参数错）和 1（其它失败）、失败时去 stderr 而不是 stdout 读 JSON。控制则多出最关键的一步：同意卡片显示在宿主的屏幕上，由宿主回答，而不是由想要控制租约的进程批准。

组合包把拼命令这件事放回代码里。模型看到的是八个带 JSON Schema 参数的工具定义，拿回一个解析好的对象；失败时，错误信息里保留 hyprscope 的错误码和下一步。CLI 拒绝的事，工具调用同样拒绝。每个工具对应一条子命令：

```sh
hyprscope_observe     -> node bin/hyprscope.ts <kind> --json
hyprscope_screenshot  -> node bin/hyprscope.ts screenshot --json
hyprscope_events      -> node bin/hyprscope.ts events --json
hyprscope_lease       -> node bin/hyprscope.ts control <request|status|done|panic> [--lang zh|en] --json
hyprscope_plan        -> node bin/hyprscope.ts control run <plan.json | -> [--dry-run] [--lang zh|en] --json
hyprscope_act         -> node bin/hyprscope.ts control run - [--lang zh|en] --json
hyprscope_baseline    -> node bin/hyprscope.ts control baseline --show|--probe [--lang zh|en] --json
hyprscope_desktop     -> node bin/hyprscope.ts control desktop <action> --json
```

内联的 `plan`（以及 `hyprscope_act` 组装的一步计划）通过 stdin 以 `control run -` 交给 CLI：组合包不写计划文件，也不留下任何临时文件。`planPath` 则按文件路径原样交给 CLI 自己读取。

## 安装

组合包就在这个仓库里，安装到某个 DSH profile 中使用，没有发布到 npm registry。两种装法都要填这个组合包的绝对目录：

- 在 DSH 里打开**插件**页，选择**添加插件**，填入本地目录 `/home/jw/workspace/dsh-hyprscope/plugins/dsh-hyprscope`。
- 或者让 DSH 里的 agent 调用 `plugin_manager`，`action: "install_bundle"`，`target` 填同一个绝对目录。

安装对整个 profile 生效，重启后仍然存在；它链接的是当前 checkout，不是复制，所以这个目录不能挪位置。装好后组合包的包名是 `@local/dsh-hyprscope`，插件行 id 是 `hyprscope`，插件页里显示的名称是**桌面观察与操控**。

有三个前提：

- DSH Host 和 Hyprland 会话跑在同一台机器、同一个用户下。CLI 通过该用户的运行时目录发现会话，但跨不过不同的 uid，也跨不过容器边界。
- 运行 DSH Host 的 Node 是 22 或更新的版本（插件默认就用这个可执行文件），并且 checkout 里有 `bin/hyprscope.ts`。插件从这份 checkout 运行 CLI，不安装依赖，也不编译 C helper。
- 组合包声明了 `dsh.bundle.platforms: ["linux"]`，所以 DSH 在别的 Host 平台上会拒绝加载它。Hyprland 本来就是 Wayland compositor，这条限制实际不构成麻烦。

装好后，这个 profile 的会话里就能用到这些工具。想先确认安装是否生效，调用一次 `hyprscope_observe`，`kind: "doctor"`：它跑的是只读的能力报告。如果组合包找不到 CLI，插件仍然能激活，只是这次调用会失败，错误信息里会点名 `projectDir`。

## 八个工具

| 工具 | 类别 | 作用 | 参数 |
|---|---|---|---|
| `hyprscope_observe` | 只读 | 读取会话、一次快照或某一类集合；从不调用 `control` | `kind`（必填）：`doctor`、`state`、`active`、`clients`、`workspaces`、`monitors`、`layers` 或 `cursor`；`timeoutMs` |
| `hyprscope_screenshot` | 只读 | 截整个布局、单个监视器、一个区域或单个窗口；会话报告锁定时拒绝 | `scope`（默认 `layout`，可取 `monitor`、`region`）、`monitor`、`region`（`{x,y,width,height}`）、`window`（`{id}`、`{app}`、`{title}` 三选一，可截不在当前屏幕上的窗口）、`output`（PNG 绝对路径）、`allowLocked`（默认 `false`） |
| `hyprscope_events` | 只读 | 在有限时间内订阅 compositor 事件流 | `match`、`count`（1 到 50）、`once`、`timeoutMs`（100 到 60000，默认 `5000`） |
| `hyprscope_lease` | 控制 | 申请、查看或结束控制租约；`request` 在用户桌面上弹出宿主的同意卡片并等待 | `action`（必填）：`request`、`status`、`done` 或 `panic`；`reason`（`request` 必填）；`ttlSeconds`（5 到 600，默认 `120`）和 `consentSeconds`（5 到 120，默认 `45`）都只在 `request` 时生效；`language`（`zh` 或 `en`）仅 `request` |
| `hyprscope_plan` | 控制 | 以试运行校验计划，或在同意后执行计划（卡片会列出计划描述和每一步操作）；这些工具改变桌面只有这一条路 | `action`（必填）：`validate` 或 `run`；`planPath` 和 `plan` 二选一；`maxResumes`（0 到 3，默认 `1`）和 `consentSeconds`（5 到 120，默认 `45`）都只在 `run` 时生效；`language`（`zh` 或 `en`）仅 `run` |
| `hyprscope_act` | 控制 | 把单个动作当作一步计划执行：提交的 step 被套进计划骨架，走计划和运行这条路径，因此校验、同意卡、执行器和租约完全一致；不存在第二条执行路径 | `step`（必填）：一个计划 step 对象，含 `op` 和该 op 的字段（可带 `requires`/`expect`）；`reason`（必填，1 到 200 字符）；`planId`（默认 `act`）、`budgetMs`（500 到 30000）、`maxResumes`（0 到 3，默认 `1`）、`consentSeconds`（5 到 120，默认 `45`）、`language`（`zh` 或 `en`） |
| `hyprscope_baseline` | 控制 | 查看或测量门控控制的能力基线（capability baseline）；放宽已验收基线时，同一次 `probe` 还会弹出宿主的确认卡，并在宿主回答后返回 | `action`（必填）：`show` 或 `probe`；`diff`（仅 `show`）、`readOnly`（仅 `probe`）、`consentSeconds`（仅 `probe`）；`language`（`zh` 或 `en`，仅 `probe`） |
| `hyprscope_desktop` | 生命周期 | 启动、挂接、查看或停止 agent 桌面；从不移动用户窗口 | `action`（必填）：`start`、`attach`、`status` 或 `stop`；`size`（仅 `start`）、`runtimeDir`（`attach` 必填）、`consentSource`（默认 `chat`，可取 `card`，仅 `start` 和 `attach`） |

观察、截图、事件、租约、计划和基线这六个工具还接受 `desktop`（`user`、`agent` 或 `external`）、`signature` 和 `runtimeDir`，只在调用方传了值时才转发给 CLI；`hyprscope_desktop` 是例外，`signature` 和 `runtimeDir` 只在 `attach` 时用，也不接受 `desktop` 选择器。`desktop` 省略即用户桌面；CLI 的默认解析会跳过这个仓库启动的桌面，所以受管桌面不会悄悄变成用户的桌面。省略的其它参数都按 CLI 的默认值走。

会弹同意卡的四个工具接受可选的 `language`（`zh` 或 `en`），并以 `--lang` 传给 CLI：`hyprscope_lease`（`request`）、`hyprscope_plan`（`run`）、`hyprscope_act` 和 `hyprscope_baseline`（`probe`）。省略即沿用 CLI 默认（`zh`），不支持的值在启动 CLI 之前就失败，CLI 的 stdout 仍是英文。

三个只读工具标记为可以并发调用，其余五个不行。结果太长时会压缩：给模型看的文本受 `maxRenderChars` 限制，超长的列表只回来前几项，外加 `total` 和 `omitted` 计数。

## 截取单个窗口

`hyprscope_screenshot` 可以只截取某一个窗口，而不是整个布局、某个输出或一个区域。在 `window` 里提供恰好一个选择器：

- `window.id`：Hyprland 地址（`0x...`），或像 `180001c6` 这样的 foreign-toplevel 标识符。
- `window.app`：应用 id，也就是窗口 class。
- `window.title`：精确的窗口标题。

这条路径用 ext-image-copy-capture 截取，而不是让 `grim` 复制合成后的输出，所以窗口即使在隐藏的工作区上、或者被别的窗口遮挡，也照样能截到。`window` 与 `monitor`、`region` 互斥，`scope` 必须省略或为 `layout`；其它组合在 CLI 启动之前就会被拒绝。这条路径和其它截图一样只读：不涉及租约、计划或能力基线，会话锁定时照旧拒绝。

它需要原生的窗口截取 helper，组合包不负责编译。在 checkout 里跑一次 `pnpm run build:capture`，它会生成 `bin/wl-capture`；没有它时，CLI 会报错并点名缺失的 helper。返回结果的元数据形状不变，只是 `source.scope` 变成 `window`，`source.window` 带上 `{identifier, appId, title}`。

## 配置

组合包放在当前 checkout 里时不需要配置。它会在插件激活时解析这些键，来源是插件行的 `config`。要改的话，在 profile 自己的 patch 层里覆盖 `hyprscope` 这一行（`$DSH_HOME/profiles/<name>/cordis.patch.yml`；整行覆盖会替换整个 `config`）：

```yaml
- id: hyprscope
  config:
    projectDir: /home/jw/workspace/dsh-hyprscope
    attachScreenshotImage: false
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `projectDir` | 仓库根目录，从组合包往上两级；回退值是 `HYPRSCOPE_PROJECT_DIR` | 包含 `bin/hyprscope.ts` 的 checkout |
| `nodeExecutable` | `process.execPath` | 用来运行 CLI 的 Node 可执行文件 |
| `timeoutMs` | `30000` | 观察和状态查询的超时，单位毫秒 |
| `controlTimeoutMs` | `180000` | 同意、控制和计划调用的超时，单位毫秒 |
| `maxOutputBytes` | `16777216`（16 MiB） | 单次调用最多捕获的 stdout 和 stderr 字节数 |
| `screenshotDir` | `<OS temp directory>/dsh-hyprscope-screenshots` | 截图的默认目录；不存在时创建 |
| `attachScreenshotImage` | `true` | 会话有附件存储时，把截到的 PNG 挂到工具结果上 |
| `maxRenderChars` | `7000` | 单个工具结果的文本预算，低于 profile 的 8192 字符裁剪阈值 |

两点需要注意：

- 配置在插件激活时校验：值的类型不对或超出范围会让激活失败，DSH 会把插件报成激活失败，而不是带着一个悄悄错掉的值继续运行。
- `projectDir` 会在每次调用时重新检查。里面没有 `bin/hyprscope.ts` 时，插件照样加载，但每次调用都会失败，错误信息会点名这个目录；CLI 出现在那里之后，调用不用重载就能开始工作。组合包或 CLI 不在默认位置时设置 `projectDir`。

## 安全边界如何成立

插件只加工具，不加权限。它能做的一切都是 CLI 的某条子命令，真正决定边界的是 CLI：一面是只读面，一面是 `control` 面。这条边界写在 [docs/PROTOCOL.zh.md](/docs/PROTOCOL.zh.md)，租约和基线的契约分别在 [docs/LEASE.zh.md](/docs/LEASE.zh.md) 和 [docs/BASELINE.zh.md](/docs/BASELINE.zh.md)。

- **只读工具仍然是只读的。** `hyprscope_observe`、`hyprscope_screenshot` 和 `hyprscope_events` 只启动裸的 `hyprscope` 命令，不会调用 `hyprscope control`。CLI 的只读侧从不加载租约、计划执行器、注入路径或桌面生命周期，插件自身也完全不导入仓库代码：它把 CLI 起成独立进程。插件不直接调用 `hyprctl` 或 `grim`，也不经过 shell。
- **截图保留锁定时的默认拒绝。** 会话报告锁定时，截图工具会拒绝；只有调用方显式传 `allowLocked: true` 时才加 `--allow-locked`。重试和默认值都不会把它翻过来。
- **控制从租约开始。** 这些工具要控制桌面，唯一入口是 `hyprscope_lease` 的 `request`。在用户桌面上，它弹出宿主的同意卡片并等待宿主决定；模型无法回答这张卡片，工具也没有哪个参数能代替宿主批准。在 agent 或 external 桌面里，同意是在 `desktop start` 或 `attach` 时一次给出的，那里的租约是程序化的：照样绑定这次提交的计划和 TTL，并且永远不会用在用户桌面上。
- **计划是改变桌面的唯一方式。** `hyprscope_plan` 的 `run` 在获得同意后执行一份校验过的计划。执行器在每次有副作用的调用之前重新读取租约、核对它的计划绑定，注入 helper 自己还会再验一遍租约证明。`validate` 是试运行：不弹卡片，不改桌面。运行以 fault 结束时交回的是事实，供重新规划，不是一条绕行路径。
- **单步动作就是一步计划。** `hyprscope_act` 不实现任何动作：它把提交的 step 放进计划骨架（`version`、`id`、`reason`、`steps: [step]`），走同一条运行路径。CLI 像校验多步计划一样校验它，同意卡显示同样的单步预览，执行器和租约门控原样不变。`requires`/`expect` 仍由调用方负责，包装器不会替你生成前提。
- **控制受已验收的能力基线门控。** 基线缺失、还只是草稿、不完整、stale 或 unverified 时，计划运行（包括试运行）或租约申请会在同意卡片出现之前以 `CAPABILITY` 失败。错误信息给出下一步：调用 `hyprscope_baseline`，`action: "probe"`，并解释证据。测量结果放宽已验收基线时，同一次调用会向桌面要一张确认卡，上面写着结论、能力计数和证据哈希，只有在宿主点击允许或拒绝之后才返回；拒绝或超时什么都不写（草稿保持待批准，下一次探针重新询问），工具自己也永远不回答那张卡。探针自己也要拿租约，并且只向它自己的测试窗口注入。
- **agent 桌面属于生命周期，不是桌面变更。** `hyprscope_desktop` 的 `start` 只能启动它自己的嵌套 compositor，`attach` 只记录宿主指定的实例，`stop` 只结束它自己启动的桌面。它们不会移动、聚焦或关闭宿主桌面上的任何窗口；`status` 可以放心轮询。

## 限制

- **每次调用一个进程。** 一次调用要启动 Node、加载 CLI、重新发现会话再退出。门控因此完整、结果因此诚实，但每次都要付出进程启动和会话发现的时间，而且没有批处理，也不保持常驻。一份计划是一次调用；把同样的步骤拆成多次工具调用只会更慢，并不更安全。
- **events 是有界等待，不是订阅。** `hyprscope_events` 会一直占着这次调用，直到满足 `count` 或 `once`，或者 `timeoutMs` 到期；等待超时算成功，结果是 `timedOut: true`，不是错误。DSH 会话不能用它持续盯着桌面。
- **结果会被压缩。** 模型读到的文本受 `maxRenderChars` 限制：超长的列表只剩前几项加 `total` 和 `omitted`，`doctor` 的渲染会去掉 `capabilities.wayland.globals`，过大的 state 会退化成摘要。供程序调用的解析值保留 CLI 的 JSON，但只读文本的模型可能漏掉字段；列表重要时换一个更窄的 `kind`。
- **它包装的是 checkout，不是发行版。** 工具运行的是这个仓库的 `bin/hyprscope.ts`，依赖它的 `--json` 输出形状。仓库目录不能挪位置，CLI 一改，工具返回的内容也可能跟着变。它也不负责编译 C helper：需要注入的计划仍然需要 `bin/wl-inject`，能力基线探针仍然需要 `bin/wl-scratch`，截取单个窗口还需要 `pnpm run build:capture` 生成的 `bin/wl-capture`（前两个见 [README.zh.md](/README.zh.md) 的快速开始）。
- **图片要模型路由支持。** 只有会话挂载了附件存储、并且被路由到的模型声明接受图片输入时，截图工具才会把 PNG 挂到结果上。没有存储、纯文本路由、路由无法解析或保存失败时，结果仍然带着路径、大小和哈希，并附一条 `imageError` 说明；截图本身照常成功。
- **不含 CUA provider。** 这个组合包给模型的是工具；把同样的操作接进 DSH 的 CUA provider 属于以后的工作，不在这个插件里。
- **控制始终需要人。** 没有哪个工具能回答同意卡片或跳过租约。基线缺失或 stale 时，agent 可以运行探针并解释；探针放宽基线时会自己弹出验收确认卡，真正让基线生效的是宿主的那一次点击，任何工具都点不了那张卡。
- **验证状态。** 这一页写的是组合包的契约，不是验证记录。仓库的[验证记录](/docs/VERIFICATION.zh.md)只覆盖一台测试机上的 CLI，不代表 DSH 工具在你的机器上跑过；组合包自己的测试在 `plugins/dsh-hyprscope/test/`。
