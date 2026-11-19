# hyprscope 的 DSH 插件

[English](/docs/DSH-PLUGIN.md) | 中文

`plugins/dsh-hyprscope/` 是本项目原生、开箱即用的 DSH Host 插件组合包（bundle），把 hyprscope 的命令行变成模型可以调用的六个工具。DSH 会话不用再拼 `node bin/hyprscope.ts ...` 这样的 shell 命令：记住仓库路径、参数顺序和 `--json`，再自己解析输出，都是负担。它会带类型化参数调用 `hyprscope_observe`、`hyprscope_screenshot`、`hyprscope_events`、`hyprscope_plan`、`hyprscope_baseline` 或 `hyprscope_desktop`，拿回一个解析好的对象。

这个组合包只是一层薄包装，不是第二份实现：每次工具调用都以子进程运行 `node bin/hyprscope.ts <command> --json`，参数用 argv 数组传递，不经过 shell。所有门控都留在 CLI 里，插件没有加任何绕开它们的办法。它只有 Host 端：只注册工具，不带页面。它还带一条桌面消息桥：一个悬浮提示和一个快捷键，把桌面上写好的一条消息（通常附上发送那一刻的桌面截图）交给会话，不需要把浏览器页面摆在前面。第二个快捷键会打开桌面标注面，把画过标记的截图和按住说话的语音变成一条结构化的用户消息。

## 它解决什么问题

对 agent 来说，走 shell 在观察上是麻烦，在控制上是风险。观察有一连串小细节要弄对：找到仓库、记住哪个参数在位置参数前面、加上 `--json`、分清退出码 2（参数错）和 1（其它失败）、失败时去 stderr 而不是 stdout 读 JSON。控制则多出最关键的一步：同意卡片显示在宿主的屏幕上，由宿主回答，而不是由想要控制租约的进程批准。

组合包把拼命令这件事放回代码里。模型看到的是六个带 JSON Schema 参数的工具定义，拿回一个解析好的对象；失败时，错误信息里保留 hyprscope 的错误码和下一步。CLI 拒绝的事，工具调用同样拒绝。每个工具对应一条子命令：

```sh
hyprscope_observe     -> node bin/hyprscope.ts <kind> --json
hyprscope_screenshot  -> node bin/hyprscope.ts screenshot --json
hyprscope_events      -> node bin/hyprscope.ts events --json
hyprscope_plan        -> node bin/hyprscope.ts control run <plan.json | -> [--dry-run] [--lang zh|en] --json
hyprscope_baseline    -> node bin/hyprscope.ts control baseline --show|--probe [--lang zh|en] --json
hyprscope_desktop     -> node bin/hyprscope.ts control desktop <action> --json
```

内联的 `plan` 通过 stdin 以 `control run -` 交给 CLI：组合包不写计划文件，也不留下任何临时文件。`planPath` 则按文件路径原样交给 CLI 自己读取。

## 安装

组合包就在这个仓库里，安装到某个 DSH profile 中使用，没有发布到 npm registry。两种装法都要填这个组合包的绝对目录：

- 在 DSH 里打开**插件**页，选择**添加插件**，填入本地目录 `/home/jw/workspace/dsh-hyprscope/plugins/dsh-hyprscope`。
- 或者让 DSH 里的 agent 调用 `plugin_manager`，`action: "install_bundle"`，`target` 填同一个绝对目录。

安装对整个 profile 生效，重启后仍然存在；它链接的是当前 checkout，不是复制，所以这个目录不能挪位置。装好后组合包的包名是 `@local/dsh-hyprscope`，插件行 id 是 `hyprscope`，插件页里显示的名称是**桌面观察与操控**。

装出来的就是一个链接。开发用的 checkout 在 web profile 里的链接位置是 `~/.dsh/profiles/web/node_modules/@local/dsh-hyprscope`，指向 `<checkout>/plugins/dsh-hyprscope`；`$DSH_HOME` 可能不在这个位置，所以以实际链接为准，不要假设路径。改 checkout 改的是下一个 DSH 进程会加载的文件，不是运行中的 Host 已经放进内存的那份。

有三个前提：

- DSH Host 和 Hyprland 会话跑在同一台机器、同一个用户下。CLI 通过该用户的运行时目录发现会话，但跨不过不同的 uid，也跨不过容器边界。
- 运行 DSH Host 的 Node 是 22 或更新的版本（插件默认就用这个可执行文件），并且 checkout 里有 `bin/hyprscope.ts`。插件从这份 checkout 运行 CLI，不安装依赖，也不编译 C helper。
- 组合包声明了 `dsh.bundle.platforms: ["linux"]`，所以 DSH 在别的 Host 平台上会拒绝加载它。Hyprland 本来就是 Wayland compositor，这条限制实际不构成麻烦。

装好后，这个 profile 的会话里就能用到这些工具。想先确认安装是否生效，调用一次 `hyprscope_observe`，`kind: "doctor"`：它跑的是只读的能力报告。如果组合包找不到 CLI，插件仍然能激活，只是这次调用会失败，错误信息里会点名 `projectDir`。

`doctor` 还会说明当前加载的是哪份代码。除了 CLI 的报告，结果还带两个新增的顶层字段：`pluginVersion` 是 Host 加载插件时从组合包 `package.json` 读到的 `version`，`cliPath` 是插件实际启动的 `bin/hyprscope.ts` 绝对路径。把 `pluginVersion` 和 checkout 里的 `plugins/dsh-hyprscope/package.json` 对比，把 `cliPath` 和预期的 checkout 对比；对不上就说明 Host 还在跑内存里的旧副本。

## 编辑组合包

Host 把 `index.js` 加载进自己的进程，并不会监视这个文件。改 checkout 里的组合包，改的是下一个 DSH 进程会加载的内容；运行中的 Host 仍然用启动时加载的代码和工具 schema。**每次改完插件都要重启 DSH**：组合包已经加载过之后，只重载 profile 或页面不够。

不重启的话，模型看到的是旧 schema：新加到工具定义里的参数不在 schema 里，传进去会被静默忽略而不是被拒绝，`doctor` 也继续报告旧的 `pluginVersion`。重启后调用 `hyprscope_observe`，`kind: "doctor"`，确认 `pluginVersion` 与 checkout 的 `package.json` 一致、`cliPath` 指向预期的 `bin/hyprscope.ts`，再信任新参数。

## 六个工具

| 工具 | 类别 | 作用 | 参数 |
|---|---|---|---|
| `hyprscope_observe` | 只读 | 读取会话、一次快照或某一类集合；从不调用 `control` | `kind`（必填）：`doctor`、`state`、`active`、`clients`、`workspaces`、`monitors`、`layers` 或 `cursor`；`timeoutMs` |
| `hyprscope_screenshot` | 只读 | 截整个布局、单个监视器、一个区域或单个窗口；会话报告锁定时拒绝 | `scope`（默认 `layout`，可取 `monitor`、`region`）、`monitor`、`region`（`{x,y,width,height}`）、`window`（`{id}`、`{app}`、`{title}` 三选一，可截不在当前屏幕上的窗口）、`output`（PNG 绝对路径）、`allowLocked`（默认 `false`） |
| `hyprscope_events` | 只读 | 在有限时间内订阅 compositor 事件流 | `match`、`count`（1 到 50）、`once`、`timeoutMs`（100 到 60000，默认 `5000`） |
| `hyprscope_plan` | 控制 | 以试运行校验计划，或在同意后执行计划（卡片会列出计划描述和每一步操作）；`run` 本身就是同意步骤，会阻塞到运行结束；这些工具改变桌面只有这一条路 | `action`（必填）：`validate` 或 `run`；`planPath` 和 `plan` 二选一；`maxResumes`（0 到 3，默认 `1`）和 `consentSeconds`（5 到 120，默认 `45`）都只在 `run` 时生效；`language`（`zh` 或 `en`）仅 `run` |
| `hyprscope_baseline` | 控制 | 查看或测量门控控制的能力基线（capability baseline）；放宽已验收基线时，同一次 `probe` 还会弹出宿主的确认卡，并在宿主回答后返回 | `action`（必填）：`show` 或 `probe`；`diff`（仅 `show`）、`readOnly`（仅 `probe`）、`consentSeconds`（仅 `probe`）；`language`（`zh` 或 `en`，仅 `probe`） |
| `hyprscope_desktop` | 生命周期 | 启动、挂接、查看或停止 agent 桌面；从不移动用户窗口 | `action`（必填）：`start`、`attach`、`status` 或 `stop`；`size`（仅 `start`）、`runtimeDir`（`attach` 必填）、`consentSource`（默认 `chat`，可取 `card`，仅 `start` 和 `attach`） |

观察、截图、事件、计划和基线这五个工具还接受 `desktop`（`user`、`agent` 或 `external`）、`signature` 和 `runtimeDir`，只在调用方传了值时才转发给 CLI；`hyprscope_desktop` 是例外，`signature` 和 `runtimeDir` 只在 `attach` 时用，也不接受 `desktop` 选择器。`desktop` 省略即用户桌面；CLI 的默认解析会跳过这个仓库启动的桌面，所以受管桌面不会悄悄变成用户的桌面。省略的其它参数都按 CLI 的默认值走。

会弹同意卡的两个工具接受可选的 `language`（`zh` 或 `en`），并以 `--lang` 传给 CLI：`hyprscope_plan`（`run`）和 `hyprscope_baseline`（`probe`）。省略即沿用 CLI 默认（`zh`），不支持的值在启动 CLI 之前就失败，CLI 的 stdout 仍是英文。

三个只读工具标记为可以并发调用，其余三个不行。结果太长时会压缩：给模型看的文本受 `maxRenderChars` 限制，超长的列表只回来前几项，外加 `total` 和 `omitted` 计数。压缩后的 `doctor` 报告会保留稳定段落，其中包括 `pluginVersion` 和 `cliPath`。

## 桌面消息、悬浮提示和快捷键

组合包还带一条与工具相互独立的桌面消息桥。当 Host profile 提供 `sessionController` 服务、且没有关掉 `desktopMessage` 时，插件激活后会写心跳，并启动 `overlay/message/` 里的 Quickshell 浮层：一个很小的提示条，说明 DSH 正在后台运行、hyprscope 已启用；另有收一条桌面消息的输入框。headless profile 没有 `sessionController`，因此只是没有提示条，工具不受影响。

这些快捷键都是 compositor 的 bind，由 `hyprscope control install-bind` 和兜底快捷键一起装一次：`SUPER + ALT + M` 开输入框（可用 `--message-key` 改），`SUPER + ALT + A` 开标注面（可用 `--annotate-key` 改）。安装器会把两个规范化后的键写进消息状态目录（`shortcut.txt` 和 `annotate-shortcut.txt`），提示条显示的因此是真正绑上的键；还没装时，提示条写的是输入框快捷键未安装，而不是一个按了没反应的键。插件自己不调用 `hyprctl`，也不改 compositor 配置。

按下快捷键会运行 `hyprscope message open`：浮层没在跑就先启动它，并写一份 `open.json` 请求。提交时输入框先收起所有浮层，把一份 JSON 文档写进 `outbox/`，然后等回执。桥只消费这份文档一次，在 `messageAttachScreenshot` 为真时截一张布局，再通过 Host 公开的 `sessionController.prompt` 以 `mode: "queue"` 注入一条普通用户消息。用户写的文字就是消息内容，截图作为内联 PNG 块一起走；路由或会话拒绝图片时，桥会不带图重试一次。于是 agent 看到的是用户的原话，正常情况下还有发送那一刻的桌面截图；没有图时，它可以先调用 `hyprscope_screenshot`（layout）或 `hyprscope_observe` 再回答。系统提示词段落会把这一点讲清楚。

目标会话的优先级是：配置了 `messageSessionId` 就用它；否则用 Host 最近观察到的根会话（跨重启记在 `last-session.json`）；否则用最近活跃的可见会话；再否则新建一个。子 agent 会话永远不会成为目标。`ack.json` 里的回执告诉浮层消息是否被接收，提示条会短暂显示“已发送”。

共享状态在 `$XDG_STATE_HOME/hyprscope/message`（默认 `~/.local/state/hyprscope/message`；`HYPRSCOPE_MESSAGE_DIR` 可覆盖）：`status.json`、`open.json`、`ack.json`、`quit.json`、`shortcut.txt`、`annotate-shortcut.txt`、`outbox/`、`last-session.json`、`overlay.log` 和 `annotate/` 会话树。CLI 面是 `hyprscope message open|annotate|overlay|stop`（`--json`、`--lang`）。这些都不拿租约、不改桌面状态、也不绕过任何工具门控：它只画一个浮层、写文件，并通过 Host 自己的 prompt 准入敲一条用户消息。

浮层需要 Quickshell 和一个能连上的 Hyprland 会话，消息路径需要暴露 `sessionController` 的 profile（Web 和 Desktop 组合包都有）。浮层起不来时工具照常工作，`status.json` 会记下错误；心跳会按退避重试，已经启动成功之后死掉的浮层也会被发现并重启。

## 桌面标注、按住说话与意图卡

同一条桥还带第二个桌面面。标注快捷键（默认 `SUPER + ALT + A`，由安装器记录）运行 `hyprscope message annotate`：CLI 启动那一个 Quickshell 浮层，并写一份带 `mode: "annotate"` 的 `open.json`，插件按 nonce 打开一个会话。浮层冻结截图，负责画图工具、按住说话和审查卡；插件负责截屏、录音、转写和 prompt 准入，和桌面消息完全一样。这里同样不拿租约，也不改桌面。

只有 Host 提供 `sessionController` 且没有关掉 `desktopMessage` 时才会创建这条桥；`desktopAnnotate: false` 只去掉标注这一半。语音还需要 Host 的 `speechToText` 服务；没有它时，会话仍然可以用文字评论完成。

**截屏与上下文。** 插件先给浮层 300 ms 收起提示条和输入框，再通过只读 CLI 读 `state --json`，选指针所在监视器（取不到就用聚焦的监视器）。它用 `screenshot --monitor` 截取该监视器，记下干净 PNG 的路径、像素尺寸、监视器布局矩形、scale、transform 和哈希，以及指针位置、焦点窗口和与截图相交、按 z 序排列的最多 24 个窗口。PNG 上从不作画；形状、评论和窗口元数据都作为卡片文字传递，agent 读几何，而不是猜像素。

**按住说话与转写。** 插件把整个会话录成 16 kHz 单声道 s16le 原始 PCM，写进会话的 `audio.pcm`，优先用 `parec`，起不来再退到 `arecord`；两个都起不来时 `audioStartedAt` 为 null，会话不带语音继续。按住 Space 录一段，每段从 PCM 里切出，用帧能量 VAD 切成短语，每个短语编码成规范的 44 字节头 WAV，交给 Host 的 `speechToText` 服务（先 `resolve` 再 `transcribe`，语言取会话的 `zh` 或 `en`）。转写、时长和短语边界写进 `voice/<id>.json`；一段可以切出多个短语，每个短语分别和它描述的标注配对。单段上限 60 秒，单次转写调用上限 30 秒。

**审查与提交。** 审查卡列出每个标注和每条转写。用户可以改转写、把某段改绑到某个标注或全局备注、写一条总备注、返回或提交。提交时浮层写 `send.json`，其中 `segments[].text` 是用户最终的文字，可选的 `segments[].annotationId` 是最终的改绑结果。桥最多等 6 秒转写队列，应用改动，把短语和标注配对，组装意图卡，再通过 `sessionController.prompt` 以 `mode: "queue"` 注入一条普通用户消息，目标会话和桌面消息桥的解析方式相同。回执写进会话的 `ack.json`；注入被拒或失败时，标注和转写保留在屏幕上，可以重试。

**意图卡。** 文本块是确定性的：一行标题（N 个标注、M 段话）、一句“截图是干净原图、以几何为准”、监视器尺寸与 scale、指针与焦点窗口、按 z 序排列的可见窗口及其矩形；然后每个标注的时间范围、图像像素矩形、屏幕对应位置、命中窗口和评论；再按时间列出每段话的时间范围，以及它绑定的标注或“未绑定，按全局备注理解”；最后是用户备注。干净 PNG 作为内联图片附在文字之后。卡片上限 8000 字符，图片上限 8 MiB；图片被跳过时卡片会注明，agent 仍然拿得到几何。

**配置与降级。** `desktopAnnotate` 默认 true，是这一面的唯一开关；`messageLanguage` 决定审查卡和转写语言；`messageDir`（或 `HYPRSCOPE_MESSAGE_DIR`）必须让 Host、CLI 和浮层看到同一个目录，因为会话文件在它的 `annotate/` 子树下。`messageAttachScreenshot` 只作用于写好的桌面消息：标注会话总是附上自己的干净监视器截图，`attachScreenshotImage` 也只管工具结果。`speechToText` 缺失、没有准备好的 provider，或者 `parec`/`arecord` 起不来时，失败只影响转写：浮层显示“转写失败”，用户可以在审查卡里直接输入文字，提交不被阻塞。DSH 不在运行时，浮层会给出提示，而不是打开会话。

## 截取单个窗口

`hyprscope_screenshot` 可以只截取某一个窗口，而不是整个布局、某个输出或一个区域。在 `window` 里提供恰好一个选择器：

- `window.id`：Hyprland 地址（`0x...`），或像 `180001c6` 这样的 foreign-toplevel 标识符。
- `window.app`：应用 id，也就是窗口 class。
- `window.title`：精确的窗口标题。

这条路径用 ext-image-copy-capture 截取，而不是让 `grim` 复制合成后的输出，所以窗口即使在隐藏的工作区上、或者被别的窗口遮挡，也照样能截到。`window` 与 `monitor`、`region` 互斥，`scope` 必须省略或为 `layout`；其它组合在 CLI 启动之前就会被拒绝。这条路径和其它截图一样只读：不涉及租约、计划或能力基线，会话锁定时照旧拒绝。

它需要原生的窗口截取 helper，组合包不负责编译。在 checkout 里跑一次 `pnpm run build:capture`，它会生成 `bin/wl-capture`；没有它时，CLI 会报错并点名缺失的 helper。返回结果的元数据形状不变，只是 `source.scope` 变成 `window`，`source.window` 带上 `{identifier, appId, title}`。

## 从 agent 会话截取同意卡

要验证同意卡能正常渲染，需要同时满足两件事：一个弹出卡片的 CLI 进程，以及卡片在屏幕上时截到的一张图。不要指望一次工具调用同时做到。会弹卡的两个工具——`hyprscope_plan`（`run`）和 `hyprscope_baseline`（`probe`）——都会一直阻塞到宿主回答或卡片过期。这个阻塞是同意契约本身，不是实现上的疏忽：计划运行只在运行结束之后才返回，所以模型不能发完就不管。不要为了方便截图把工具改成异步，也不要从 agent 侧回答卡片。

正确做法是在工具之外把 CLI 跑成后台任务，然后用只读工具调用按时截图：

```sh
# background job: a no-op plan raises the consent card; the run waits for the host
printf '%s\n' '{"version":1,"id":"card-capture","reason":"card capture","steps":[{"op":"pause","ms":100}]}' > /tmp/hyprscope-card-plan.json
node bin/hyprscope.ts control run /tmp/hyprscope-card-plan.json --consent 120 --lang en
```

这条后台命令就是 `hyprscope_plan` 的 `run` 的 CLI 形式；工具调用同样会阻塞，所以截图必须在工具之外进行。控制必须已经可用：基线缺失或 stale 时，会在任何卡片出现之前就以 `CAPABILITY` 失败，所以先探针并让宿主验收。然后在 agent 会话里，大约一秒后截整个布局：

```
hyprscope_screenshot(scope: "layout", output: "/tmp/hyprscope-card.png")
```

截图是只读的，重复截也安全；唯一的约束是时机：等卡片出现，并在同意窗口关闭前截。之后回答卡片或让它过期，并停掉后台任务；agent 绝不能替宿主批准。同一个办法也能截到基线探针的验收确认卡。

## 调用失败时

失败的工具调用会保留 CLI 的稳定错误码；对下面这些已知原因，还会在原始 stderr 之外补上一条可执行的下一步：

- `CAPABILITY`：没有已验收且仍然有效的基线——缺失、stale、不完整或 unverified。调用 `hyprscope_baseline`，`action: "probe"`，解释证据，并让宿主回答探针可能弹出的确认卡。不要自己回答那张卡，也不要声称基线已被验收。
- 状态目录只读（`EROFS`）：当前 `XDG_STATE_HOME` 下写不了租约和基线文件。在 DSH Host 的环境里把它指向可写目录，然后重启 DSH。已验收的基线存在真实的状态目录里（`$XDG_STATE_HOME/hyprscope/baseline.json`，默认 `~/.local/state/hyprscope`），换目录并不能替代那个文件。
- 用法错误或未知命令：调用 `hyprscope_observe`，`kind: "doctor"`，查看当前加载的接线，包括 `pluginVersion` 和 `cliPath`；如果组合包改过，重启 DSH，让新 schema 取代旧的那份。

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
| `desktopMessage` | `true` | 启动悬浮提示，接收桌面消息和标注请求；`false` 保留工具、去掉两条桥 |
| `desktopAnnotate` | `true` | 接收 `hyprscope message annotate` 并运行标注桥；`false` 只去掉标注这一半 |
| `messageLanguage` | `zh` | 提示条、输入框、标注审查卡和转写的语言：`zh` 或 `en` |
| `messageAttachScreenshot` | `true` | 每条桌面*消息*都截一张布局作为内联图片发出；标注会话总是附自己的干净监视器截图，忽略这个键 |
| `messageSessionId` | 未设置 | 把所有桌面消息固定到某个会话；省略则用最近活跃的根会话 |
| `messageDir` | `$XDG_STATE_HOME/hyprscope/message` | CLI 与浮层共享的状态目录；标注会话在它的 `annotate/` 子树下；回退值是 `HYPRSCOPE_MESSAGE_DIR` |

还有几点需要注意：

- 配置在插件激活时校验：值的类型不对或超出范围会让激活失败，DSH 会把插件报成激活失败，而不是带着一个悄悄错掉的值继续运行。
- `projectDir` 会在每次调用时重新检查。里面没有 `bin/hyprscope.ts` 时，插件照样加载，但每次调用都会失败，错误信息会点名这个目录；CLI 出现在那里之后，调用不用重载就能开始工作。组合包或 CLI 不在默认位置时设置 `projectDir`。
- `messageDir`（或 `HYPRSCOPE_MESSAGE_DIR`）是三个进程之间的契约：Host、快捷键运行的 CLI、浮层。只在插件上配一个自定义目录，`hyprscope message open` 仍会写默认目录，输入框就不会出现；请给 compositor 会话也导出同一个环境变量。
- `messageAttachScreenshot` 和 `attachScreenshotImage` 不改标注会话：标注桥总是自己渲染干净截图和一张意图卡，只有 PNG 缺失、读不出来或超过 8 MiB 时才退回纯文字。

## 安全边界如何成立

插件只加工具，不加权限。它能做的一切都是 CLI 的某条子命令，真正决定边界的是 CLI：一面是只读面，一面是 `control` 面。这条边界写在 [docs/PROTOCOL.zh.md](/docs/PROTOCOL.zh.md)，租约和基线的契约分别在 [docs/LEASE.zh.md](/docs/LEASE.zh.md) 和 [docs/BASELINE.zh.md](/docs/BASELINE.zh.md)。

- **只读工具仍然是只读的。** `hyprscope_observe`、`hyprscope_screenshot` 和 `hyprscope_events` 只启动裸的 `hyprscope` 命令，不会调用 `hyprscope control`。CLI 的只读侧从不加载租约、计划执行器、注入路径或桌面生命周期，插件自身也完全不导入仓库代码：它把 CLI 起成独立进程。插件不直接调用 `hyprctl` 或 `grim`，也不经过 shell。
- **截图保留锁定时的默认拒绝。** 会话报告锁定时，截图工具会拒绝；只有调用方显式传 `allowLocked: true` 时才加 `--allow-locked`。重试和默认值都不会把它翻过来。
- **计划运行本身就是同意步骤。** 没有单独的租约申请工具，也没有 agent 侧的 `done`/`panic`：`hyprscope_plan` 的 `run` 在用户桌面上弹出宿主的同意卡片，并阻塞到运行结束。在 agent 或 external 桌面里，同意是在 `desktop start` 或 `attach` 时一次给出的，运行在那里以程序化方式继续。模型无法回答这张卡片，工具也没有哪个参数能代替宿主批准。
- **计划是改变桌面的唯一方式。** `hyprscope_plan` 的 `run` 在获得同意后执行一份校验过的计划。执行器在每次有副作用的调用之前重新读取租约、核对它的计划绑定，注入 helper 自己还会再验一遍租约证明。`validate` 是试运行：不弹卡片，不改桌面。运行以 fault 结束时交回的是事实，供重新规划，不是一条绕行路径。
- **控制受已验收的能力基线门控。** 基线缺失、还只是草稿、不完整、stale 或 unverified 时，计划运行（包括试运行）会在同意卡片出现之前以 `CAPABILITY` 失败。错误信息给出下一步：调用 `hyprscope_baseline`，`action: "probe"`，并解释证据。测量结果放宽已验收基线时，同一次调用会向桌面要一张确认卡，上面写着结论、能力计数和证据哈希，只有在宿主点击允许或拒绝之后才返回；拒绝或超时什么都不写（草稿保持待批准，下一次探针重新询问），工具自己也永远不回答那张卡。探针自己也要拿租约，并且只向它自己的测试窗口注入。
- **agent 桌面属于生命周期，不是桌面变更。** `hyprscope_desktop` 的 `start` 只能启动它自己的嵌套 compositor，`attach` 只记录宿主指定的实例，`stop` 只结束它自己启动的桌面。它们不会移动、聚焦或关闭宿主桌面上的任何窗口；`status` 可以放心轮询。

## 限制

- **每次调用一个进程。** 一次调用要启动 Node、加载 CLI、重新发现会话再退出。门控因此完整、结果因此诚实，但每次都要付出进程启动和会话发现的时间，而且没有批处理，也不保持常驻。一份计划是一次调用；把同样的步骤拆成多次工具调用只会更慢，并不更安全。
- **events 是有界等待，不是订阅。** `hyprscope_events` 会一直占着这次调用，直到满足 `count` 或 `once`，或者 `timeoutMs` 到期；等待超时算成功，结果是 `timedOut: true`，不是错误。DSH 会话不能用它持续盯着桌面。
- **结果会被压缩。** 模型读到的文本受 `maxRenderChars` 限制：超长的列表只剩前几项加 `total` 和 `omitted`，`doctor` 的渲染会去掉 `capabilities.wayland.globals`，过大的 state 会退化成摘要。供程序调用的解析值保留 CLI 的 JSON，但只读文本的模型可能漏掉字段；列表重要时换一个更窄的 `kind`。
- **它包装的是 checkout，不是发行版。** 工具运行的是这个仓库的 `bin/hyprscope.ts`，依赖它的 `--json` 输出形状。仓库目录不能挪位置，CLI 一改，工具返回的内容也可能跟着变。它也不负责编译 C helper：需要注入的计划仍然需要 `bin/wl-inject`，能力基线探针仍然需要 `bin/wl-scratch`，截取单个窗口还需要 `pnpm run build:capture` 生成的 `bin/wl-capture`（前两个见 [README.zh.md](/README.zh.md) 的快速开始）。
- **图片要模型路由支持。** 只有会话挂载了附件存储、并且被路由到的模型声明接受图片输入时，截图工具才会把 PNG 挂到结果上。没有存储、纯文本路由、路由无法解析或保存失败时，结果仍然带着路径、大小和哈希，并附一条 `imageError` 说明；截图本身照常成功。
- **不含 CUA provider。** 这个组合包给模型的是工具；把同样的操作接进 DSH 的 CUA provider 属于以后的工作，不在这个插件里。
- **桌面两条桥都不增加控制路径。** 它们只启动 `hyprscope message ...` 和只读的 `screenshot`，从不调用 `hyprscope control`；通过 Host 的 `sessionController.prompt` 以普通用户消息注入，从不回答卡片，不拿租约，也不改桌面状态。
- **控制始终需要人。** 没有哪个工具能回答同意卡片或跳过租约。基线缺失或 stale 时，agent 可以运行探针并解释；探针放宽基线时会自己弹出验收确认卡，真正让基线生效的是宿主的那一次点击，任何工具都点不了那张卡。
- **提示条是尽力而为的。** 它只在 Host 运行、浮层还活着时存在，不会去重启 compositor。目标是最近活跃的根会话，不一定是用户最后看的那一页，需要固定一个会话时设置 `messageSessionId`。浮层写完消息之后 Host 崩溃会丢掉那一条（outbox 在投递前就被消费，所以重试不会重复）；截图超过 8 MiB 或路由声明不支持图片时会跳过。
- **标注语音是尽力而为的。** 会话始终需要 Quickshell 和运行中的 Host；语音还需要 `parec` 或 `arecord`，以及准备好的 DSH `speechToText` provider。缺这些时，截图、形状、评论和手工文字仍然能交给 agent，但说的话不行，审查卡会说明。单段按住说话上限 60 秒，意图卡上限 8000 字符，图片上限 8 MiB。
- **验证状态。** 这一页写的是组合包的契约，不是验证记录。仓库的[验证记录](/docs/VERIFICATION.zh.md)只覆盖一台测试机上的 CLI，不代表 DSH 工具在你的机器上跑过；组合包自己的测试在 `plugins/dsh-hyprscope/test/`。
