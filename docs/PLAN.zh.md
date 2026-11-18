# 计划契约（`hyprscope control run`）

[English](/docs/PLAN.md) | 中文

计划是一串有界、可静态评审的桌面动作，由宿主作为一个整体批准。本文档是写计划的作者与在 [LEASE.zh.md](/docs/LEASE.zh.md) 所述的控制租约下执行它的执行器之间的契约；观察按 [PROTOCOL.zh.md](/docs/PROTOCOL.zh.md) 的规定保持只读。作者提供数据，执行器掌握通往 compositor 的唯一代码路径。

## 1. 定位

计划是数据，不是代码：没有表达式、分支、循环，也没有 §4 目录之外的 dispatch。同意绑定到提交的计划本身（§8），而不是绑定到时间窗口，因此一次批准不能被延伸到一个不同的计划或无期限的会话上。

每个步骤的执行是 `preflight -> commit -> verify`。执行器是确定性的，从不推理：一次尝试要么完成，要么带原因 fault，要么挂起以便派生的恢复计划得以运行（§6）；宿主可以随时撤销租约。执行器从不执行计划未声明的动作，也从不在 §6 之外发明恢复。步骤按数组顺序逐个运行，`budgetMs` 限定一次尝试。

| 角色 | 写入 | 权限 |
|---|---|---|
| 作者（agent） | 计划文档、观察读取 | 提出动作 |
| 执行器（`hyprscope control run`；内部测量模式） | 桌面变更、运行产物 | 唯一注入方 |
| 宿主 | 同意决定、物理输入 | 随时授予与撤销 |
| 观察者（`hyprscope`） | 无 | 只读 |

一次运行只针对一个桌面：`--desktop user|agent|external` 选择它，默认 `user`。`--dry-run` 接受同一个选择器，所以校验和能力检查针对的是真正运行会用的那个桌面。

### 内部测量模式

执行器可以把一份计划当作一次测量来运行，因此探针改动桌面的工作走的是和作者计划相同的校验、租约绑定和每次调用前的租约门控——执行器仍然是唯一的注入方。这个模式只在内部使用：只有探针会选择它，它的测量计划由 `src/compat/probeplan.ts` 根据探针已经只读测到的事实构建，步骤是携带 `requires`/`expect` 的普通目录 op；这份计划和任何计划一样出现在探针的同意卡上。`runPlanFile` 从不设置这个模式，校验也没有对应字段，所以 `hyprscope control run` 和计划文档都请求不到它。

测量会改变失败策略：声明的前提不成立、dispatcher 被拒绝、或者后置条件读不回来的步骤会被记录下来，执行继续，这些记录就是测量证据。只有安全失败会让这次运行停下——租约丢失或被撤销、计划的时间预算，或者外部对桌面的改动。测量模式下从不运行恢复：这次运行既不为派生计划挂起，也不通过干扰询问问宿主，并且探针持有自己的租约，在每次变更之前都会重读它。测量计划只通过符号化的 `app`/`title` 选择器 `hyprscope-scratch` 指向探针自己的测试窗口；任何测量都不得针对用户窗口。

## 2. 计划 schema

```json
{
  "version": 1,
  "id": "live-terminal",
  "reason": "Type one line into a scratch terminal and capture the result",
  "summary": "focus, click, type, Return, capture",
  "workspace": "agent",
  "budgetMs": 8000,
  "settleMs": 800,
  "interferencePromptMs": 12000,
  "steps": [ ... ]
}
```

`reason` 和 `summary` 是宿主在同意卡片上先读到的行。卡片随后逐步列出每一步（`2. click · 在 foot 窗口 内 (0.5, 0.6) 点击左键`），由工具从已校验的计划渲染，因此宿主批准的是计划要做什么，而不是一串 op；超过十步的计划只显示前十步和剩余步数。整张卡片（包括这些步骤行）按 `--lang <zh|en>` 选择的语言渲染（默认 `zh`，或 `HYPRSCOPE_LANG` 环境变量；未知值按用法错误处理），CLI 的 stdout 仍是英文。`id`、`summary`、`workspace` 和 `interferencePromptMs` 可选；其他所有字段都有默认值，默认值在计划被校验时补上。

| 字段 | 规则 |
|---|---|
| `version` | 必须恰好为 `1` |
| `id` | `[A-Za-z0-9._-]{1,64}`，默认 `plan` |
| `reason` | 必填，1–200 个字符 |
| `summary` | 可选自由文本，最多 200 个字符；仅供参考 |
| `workspace` | 可选 `[A-Za-z0-9._-]{1,32}`；展示给宿主并复制进派生计划，不是隐式前提 |
| `budgetMs` | 整数 500–30000，默认 8000；一次尝试的墙钟上限 |
| `settleMs` | 整数 50–5000，默认 600；每个步骤的校验期限 |
| `interferencePromptMs` | 整数 1000–60000，默认 12000；在尝试被终止之前，宿主回答干扰询问的时限 |
| `steps` | 1–64 个条目，按顺序执行 |
| `text` 操作 | 整个计划合计最多 4096 个字符 |
| 未知字段 | 在每一层都被拒绝，因此校验正好覆盖被读取的全部内容 |

计划文档不得携带 `lineage` 字段：只有工具从被中断的运行派生出的计划才有该字段（§6），作者撰写却声称有 lineage 的文档会被拒绝。上面的默认值由校验补上；一次运行只加载一次文档，执行的就是这份已校验的文档，之后不会再读文件。

窗口目标按地址或精确的 `app`/`title` 选择：

```json
{ "id": "0x55a1aaa0", "app": "Alacritty", "title": "terminal" }
```

存在 `id` 时以 `id` 为准。否则 `app` 和/或 `title` 必须恰好匹配一个已映射的客户端；零个匹配是 `target.missing`，多个是 `target.ambiguous`，两者都会让运行 fault。

窗口相对位置从不是布局像素。指针锚点坐标或截取区域在执行时针对目标窗口当前的矩形解析：

```json
{ "window": { "app": "foot" }, "point": [0.5, 0.6] }
{ "window": { "app": "foot" }, "rect": [0.0, 0.0, 1.0, 1.0] }
```

点坐标是窗口宽/高的 `0..1`；矩形是同一单位下的 `[x, y, width, height]`，并且必须留在窗口内。因此窗口改变尺寸会打破几何断言，而不是悄悄移动点击位置。指针目标位置也可以是绝对的布局像素：

```json
{ "x": 1512, "y": 900 }
```

优先使用锚点坐标：窗口移动后它们仍然有效，而绝对位置会悄悄不再指向同一个东西。

## 3. 前提与预期

每个步骤都可以携带 `requires`（提交前检查）和 `expect`（提交后检查）。谓词种类由代码固定；作者只提供参数，不能引入种类，也不能改变其严重级别。

| 种类 | 参数 | 开销 | 允许出现于 | 破坏时 | 能力 |
|---|---|---|---|---|---|
| `lease.valid` | — | 缓存 | 隐式 | 致命 | — |
| `time.budget` | — | 缓存 | 隐式 | 致命 | — |
| `window.exists` | target | 状态 | requires, expect | 致命 | `observe.hyprctl` |
| `window.focused` | target | 状态 | requires, expect | 可恢复（聚焦） | `observe.hyprctl`、`dispatch.focus.window` |
| `window.geometry` | target，可选 x/y/width/height，`tol` | 状态 | requires, expect | 窗口浮动时可恢复（移动 + 缩放）；平铺时致命 | `observe.geometry`、`dispatch.window.move`、`dispatch.window.resize` |
| `window.state` | target，`floating`/`pinned`，`fullscreen`/`fullscreenClient`（0\|1\|2） | 状态 | requires, expect | 窗口存在时可恢复（fullscreen/float/pin） | `observe.hyprctl`、`observe.window.modes`，外加 float/pin/fullscreen-state，仅限该实例断言的模式 |
| `workspace.active` | name | 状态 | requires, expect | 可恢复（激活工作区） | `observe.hyprctl`、`dispatch.focus.workspace` |
| `monitor.config` | name，width/height/scale | 状态 | requires, expect | 致命 | `observe.hyprctl` |
| `clients.set` | 精确的窗口地址 | 状态 | requires | 致命 | `observe.hyprctl` |
| `pointer.position` | `target`+`point`，或 `x`/`y`；`tol` | 指针查询 | requires | 可恢复（重新定位）；锚点坐标需要其窗口仍然存在 | `observe.cursor`、`inject.pointer` |
| `region.unchanged` | target，rect，label | 截取 | requires | 致命 | `capture.grim` |
| `region.changed` | target，rect | 截取 | expect | 致命 | `capture.grim` |
| `no.foreign_event` | — | 缓存 | 隐式 | 致命 | `events.socket` |

`window.state` 对 `floating` 和 `pinned` 取布尔值，对 `fullscreen` / `fullscreenClient` 取数字模式：`0` 无、`1` fullscreen、`2` maximized；客户端侧模式使用同一套编码。`pointer.position` 要么是窗口相对的（`target` + `point`，单位 0..1），要么是绝对的（`x` + `y`，布局像素），一个谓词里不能同时用两者。`tol` 在 `window.geometry` 中默认为 `0`（范围 0–64），在 `pointer.position` 中默认为 `2`（范围 0–256）。

没有坐标的 `window.geometry` 与运行开始时观察到的几何比较。求值从最便宜的开始，遇到致命失败就短路，因此截取谓词只有在没有任何更便宜的检查已经失败时才会运行。预期从不恢复：即使同一种谓词作为前提时可恢复，失败的 `expect` 也会让这次尝试 fault（§6）。

隐式谓词不写在计划里：每个步骤之前都会重读租约并重新检查预算，在检查声明的 `requires` 之前会先排空事件流。

`capabilities` 列会在同意卡片出现之前对照已验收的能力基线（capability baseline）检查；缺少某项能力是一次 `CAPABILITY` 失败，并指明该 id，而不是运行时 fault。基线只能收窄代码声明的内容，仅被 advertised 的 `required` 能力永远不算 measured。带 `window` 的 `screenshot` 步骤由 `capture.window` 门控，而不是 `capture.grim`（见 §4）。见 [COMPATIBILITY.md](/docs/COMPATIBILITY.zh.md) §5 和 [BASELINE.md](/docs/BASELINE.zh.md) §6。

## 4. 操作

| 操作 | 字段 | 变更状态 | 幂等 | 声明的 `requires` | 声明的 `expect` | 能力 |
|---|---|---|---|---|---|---|
| `movePointer` | `at` | 是 | 是 | 可选 | 可选 | `inject.pointer` |
| `click` | `at`, `button`, `count` | 是 | 否 | 必填；必须包含 `window.focused` 和 `window.geometry` | 必填 | `inject.pointer` |
| `scroll` | `value`, `axis` | 是 | 否 | 必填 | 必填 | `inject.pointer` |
| `chord` | `keys` | 是 | 否 | 必填 | 必填 | `inject.keyboard` |
| `text` | `text` | 是 | 否 | 必填 | 必填 | `inject.keyboard` |
| `focusWindow` | `target` | 是 | 是 | 必填 | 可选 | `dispatch.focus.window` |
| `workspace` | `name` | 是 | 是 | 可选 | 可选 | `dispatch.focus.workspace` |
| `moveWindow` | `target`, `x`, `y` (absolute) | 是 | 是 | 必填 | 可选 | `dispatch.window.move` |
| `resizeWindow` | `target`, `width`, `height` (absolute) | 是 | 是 | 必填 | 可选 | `dispatch.window.resize` |
| `floatWindow` | `target`, `floating`, `pinned` | 是 | 是 | 必填 | 可选 | `dispatch.window.float` 和/或 `dispatch.window.pin`，仅限该步骤设置的字段 |
| `fullscreenWindow` | `target`, `internal`, `client` (0\|1\|2) | 是 | 是 | 必填 | 可选 | `dispatch.window.fullscreen-state` |
| `screenshot` | `label`，外加 `region` 或 `window`（两者至多一个） | 否 | — | 可选 | — | 区域用 `capture.grim`；窗口用 `capture.window` |
| `pause` | `ms` (1–1000) | 否 | — | 可选 | — | — |
| `assert` | `requires` | 否 | — | 可选 | 禁止 | —（由谓词决定） |
| `waitEvent` | `kind`, `timeoutMs` | 否 | — | 可选 | — | `events.socket` |

`moveWindow` 和 `resizeWindow` 是绝对的：`x`/`y` 与 `width`/`height` 是布局像素，发出的 Lua 调用不携带 `relative` 字段，而该可选字段本来会选择相对放置。窗口处于 fullscreen 时 compositor 会拒绝这两个调用，因此几何步骤必须先清除 fullscreen；§6 的恢复顺序在构造上做到了这一点。

`floatWindow` 和 `fullscreenWindow` 设置状态而不是切换状态：`floating`/`pinned` 变成显式的 `on`/`off` 动作，fullscreen 步骤携带一个内部模式和一个客户端模式，各自是 `0`（无）、`1`（fullscreen）或 `2`（maximized），缺失的模式默认为 `0`。

`screenshot` 截取一个区域或者一个窗口。带 `window` 时使用和其他 op 相同的目标选择器——`{ "window": { "app": "foot" } }`——并且 `window` 与 `region` 互斥；两者都不带的步骤截取整个布局。目标像其他窗口目标一样针对运行快照解析，所以零个或多个匹配会以 `target.missing` / `target.ambiguous` fault，匹配到的窗口如果没有 compositor 报告的 foreign-toplevel 标识也会以 `target.missing` fault；随后由 compositor 通过 `ext-image-copy-capture` 渲染这一个 toplevel，因此它位于其他工作区或者被遮住也能截到。只能截已映射的窗口（最小化或未映射的窗口会被拒绝），光标不会合成进图像，带 `no_screen_share` 规则或截图权限被拒绝的窗口会得到 compositor 的拒答占位图。截取失败时这次尝试会带着 helper 给出的原因 fault，而不是记录一张截图。这个步骤由 `capture.window` 门控；区域和布局截取仍然由 `capture.grim` 门控（§3）。它的卡片行是 `截图窗口「<app>」`，依次用 class、标题、id 命名窗口。

`chord` 和 `text` 走 compositor 正常的按键 dispatch，因此 `chord` 可以触发宿主自己的键绑定；计划语言刻意不提供通用的 `dispatch` 操作，不提供 `exec`，不提供配置编辑，也没有逃生门。

幂等性是操作在代码中的属性，不是计划字段。非幂等操作最多执行一次：如果一次提交可能已经落地，但预期无法确认，执行器会让这次尝试 fault，而不是重放。幂等操作在预算内预期失败时可以重试一次。

`movePointer` 和 `workspace` 不声明前提要求（目标位置是步骤的一部分）；其他每个会变更状态的操作都必须声明至少一个，非幂等操作还必须声明一个预期。

## 5. 干扰策略

宿主被当作外部 fault 来源。在每个会提交的步骤之前，执行器重读租约、检查这次尝试的 `budgetMs`、按最便宜优先的顺序求值声明的 `requires`，并排空事件流。不变更状态的 `pause` / `screenshot` / `waitEvent` 步骤跳过这次预检，但在运行前仍会因硬性外部事件而停止，`waitEvent` 只消费它等待的那个事件。只有被破坏的前提能让一次运行挂起；失败的预期、致命前提和硬性外部事件都会立刻结束这次尝试（§6）。

外部事件只有在破坏了计划声明的某项内容时才可处理。硬性例外是 `openwindow`、`closewindow`、`monitoradded`、`monitorremoved`、`monitorlayout` 和 `submap`：当没有任何已声明的前提能解释这一变化时，它们会让这次尝试直接 fault，不发出询问。其他会改变状态的事件（`workspace`、`activewindow`、`fullscreen`、`changefloatingmode`、`pin`、`movewindow`……）由覆盖它们的前提捕获（如果有的话）；不做任何投机式纠正。

当所有被破坏的前提都可恢复时，执行器停止注入并询问宿主：

1. 在租约目录中发布 `interference.json`：包含询问 `id`、从 1 开始计数的步骤（`step`/`total`）、它将启动的恢复尝试与允许次数（`attempt`/`maxResumes`）、恢复尝试将获得的预算（`budgetMs`）、每个被破坏的前提及其期望值/观察值，以及 `interferencePromptMs` 的期限（§2）；
2. 浮层渲染一张模态卡片：「检测到外部操作」、被破坏的前提、步骤行 `第 k/n 步 · 第 r/m 次恢复`、倒计时和两个按钮：`终止操作`（Escape）与 `继续执行`（Return/Enter）；卡片还会说明，继续执行会恢复前提并增加一个新的执行窗口；
3. 回答写入 `interference-decision.json`，并且必须回显询问 `id`；携带其他 id 的决定会被忽略，过期的询问会被拒绝；
4. `继续执行` 会挂起这次尝试（§6）：不在原地重建任何东西，被中断的尝试也不会重放该步骤；
5. `终止操作`，或期限已过仍没有回答，会让运行以细节 `(host chose to terminate)` fault，并保留 `committed` 集合，以便作者能围绕已经发生的事继续。

有两种情况从不询问。只要有一个被破坏的前提不可恢复，运行会立刻 fault，并把该前提作为 `broken`；工具不会请宿主批准它做不到的事。恢复尝试也不会再获得第二次恢复：如果前提在那里被破坏，这次尝试会以细节 `(the recovery attempt may not recover again)` fault；加上 `--max-resumes 0` 时，第一次尝试会改为以 `(recovery is disabled for this run)` fault。

agent 或 external 桌面里没有浮层，也没有询问：可恢复的冲突会让这次尝试以被打破的前提作为 `broken` fault，由 agent 在对话里问宿主。

什么都不会回滚。撤销宿主的动作不在范围内，而且常常不可能；恢复通过运行派生计划重新主张工具自己的前提，而不是变更被中断的计划。已关闭的应用从不重开，因为替代者不是同一个对象，引用它的计划已经结束。

## 6. 恢复

干扰通过派生新计划来恢复，从不去纠正正在运行的计划。标准刻意收得很窄：只有工具既能观察、又能用它自己的 dispatch 子集（§4）触及的前提才可恢复。已关闭的窗口、变化的应用表面或监视器重配置不可恢复：这时尝试会 fault，把事实交回请求方，因为只有请求方能对应用状态进行推理。

### 可恢复性

可恢复性是谓词目录（`src/plan/model.ts` 中的 `PREDICATE_SPECS`）的属性，不是文档的属性，并且取决于恢复时观察到的内容：

| 种类 | 可恢复 | 恢复步骤 | 条件 / 为何致命 |
|---|---|---|---|
| `window.focused` | 是 | 聚焦 | 目标必须仍然存在 |
| `window.state` | 是 | fullscreen / float / pin | 目标必须仍然存在 |
| `window.geometry` | 是 | 移动 + 缩放 | 仅在窗口浮动时；平铺几何属于布局；需要声明的几何或运行开始时的基线 |
| `workspace.active` | 是 | 激活工作区 | 前提必须命名一个工作区 |
| `pointer.position` | 是 | 移动指针 | 绝对位置，或窗口仍然存在的锚点坐标 |
| `window.exists` | 否 | — | 重新打开的窗口不是同一个对象 |
| `monitor.config` | 否 | — | 输出配置在工具之外 |
| `clients.set` | 否 | — | 应用集合变了 |
| `region.unchanged` | 否 | — | 应用表面变了 |
| `region.changed` | 否 | — | 预期从不恢复 |
| `time.budget` | 否 | — | 这次尝试的墙钟用尽 |
| `lease.valid` | 否 | — | 控制权被撤销 |

预期失败总是致命的，即使同一种谓词作为前提时可恢复。恢复时不再恰好匹配一个窗口（缺失或有歧义）的窗口目标同样不可恢复。

能力基线也会收窄可恢复性。`restorability()` 要求每个恢复模板所需的能力（`RESTORE_CAPABILITIES`）都具备，因此没有 `dispatch.window.pin` 的机器无法重建 `state` 前提，即使该谓词本身可恢复；几何恢复则需要 `dispatch.window.move` 和 `dispatch.window.resize` 两者。派生计划在租约续期之前会对照同一份固定基线检查；基线不授予的恢复步骤会让这次尝试以 `recovery.capability` fault，而不是悄悄续期控制权。

### 恢复顺序

派生计划按固定的由外到内顺序前置恢复步骤，这也是 compositor 强加的依赖顺序：

1. 工作区：切换可能移动焦点；
2. 窗口结构：先关闭 fullscreen，再处理 floating 和 pinned；
3. 几何：`moveWindow` 然后是 `resizeWindow`，两者都要求窗口处于浮动，且在窗口 fullscreen 时都不合法；
4. 焦点：一次焦点提交会提升窗口并移动指针；
5. 指针：最后，因为每个更早的层都可能移动光标。

因此恢复内层永远不会让外层失效。前提按窗口合并：关于同一个窗口的所有被破坏的状态前提最多产生一次结构变更和一次几何变更；几何恢复会先清除 fullscreen 模式，即使计划从未声明 fullscreen，因为 compositor 拒绝在 fullscreen 窗口上移动/缩放。

### 派生计划

派生计划是由工具构建的普通已校验文档：

| 字段 | 值 |
|---|---|
| `lineage` | `rootPlanId`、`attempt`（从 1 开始）、`interruptedAtStep`（被中断计划中从 0 开始的索引）、`broken`（不重复的前提种类） |
| `id` | 被中断计划的 id，缩短以腾出空间，再加 `-r<attempt>`；最多 64 个字符 |
| `reason` | 被中断计划的 reason 追加 `(recovery <attempt>)`，截断到 200 个字符 |
| `summary` | `恢复…后继续第 k/n 步`，替换作者写的 summary；在询问和租约横幅中展示 |
| `steps` | 合成的恢复步骤，随后是被中断计划从 `interruptedAtStep` 开始的步骤 |
| `budgetMs` | 被中断计划的 `budgetMs`；每次尝试都有自己的执行窗口 |
| `workspace` / `settleMs` / `interferencePromptMs` | 从被中断计划继承（根计划没有声明时，`workspace` 以 null 携带） |

派生计划不得超过 `PLAN_LIMITS.maxSteps`（64）。合成过程会为被中断计划中仍在等待的步骤预留位置，当恢复步骤放不下时以 `recovery.too-many-steps` 拒绝。作者撰写的文档不得携带 `lineage`；只有工具会创建它。

### 同意与续期

批准一个计划的同时也批准一份有界的恢复额度，因此恢复尝试从不再次询问宿主。同意覆盖：

- `maxResumes` 次恢复尝试：默认 `1`（`PLAN_LIMITS.defaultMaxResumes`），硬上限 `3`（`PLAN_LIMITS.maxResumes`）；`hyprscope control run --max-resumes <0..3>` 设置它，`0` 禁用恢复；
- `totalBudgetMs = (1 + maxResumes) * budgetMs`，即所有尝试 TTL 总和的上限；每次尝试还可以额外持有一次 `LEASE_RECOVERY_MARGIN_MS`（20 s）的询问/校验余量，因此同意延迟不会饿死后续尝试。

执行器为每次尝试续期同一个租约：使用下一个尝试编号、新的到期时间（该次尝试的 `budgetMs + 20000 ms`），并写入一条 `renewals[]` 条目；租约 id 从不改变。续期规则（只对已授予的租约、同一 lease id、未过期、尝试编号恰好加一、尝试次数不超过 `maxResumes`、总 TTL 上限）见 LEASE.md。

恢复尝试不得再次恢复：`resumeAllowed` 只对第一次尝试为真。如果前提在恢复期间被破坏，运行会 fault，因此派生计划的数量保持有界，且在该同意下的每次尝试都可通过租约 lineage 追踪。

### 终止与回执

一次运行以下列形态之一结束：

| 形态 | 结果 |
|---|---|
| completed | 某次尝试的每个步骤都已提交 |
| 因致命前提或预期而 fault | `broken` 指明它；`committed` 列出 fault 的那次尝试中已确认的步骤 |
| 宿主终止询问或期限已过之后 fault | 同上，细节以 `(host chose to terminate)` 结尾 |
| 因无法派生恢复而 fault | `broken.kind` 是 `recovery.unavailable`、`recovery.too-many-steps`、`recovery.invalid`、`recovery.lease`、`recovery.capability` 或 `executor-error` |
| 因所针对的桌面消失而 fault | `broken.kind` 是 `target.desktop-closed`；被中断尝试的 `committed` 和时间线保留 |
| 被撤销 | `broken.kind` 是 `lease.valid` |

报告是一份运行报告：最后一次尝试的结果，加上 `rootRunId`、`rootDir` 和 `attempts[]`；其中每个条目对应一次尝试，带有自己的 `runId`、`dir`、`status`（`completed`、`faulted`、`revoked` 或 `suspended`）、步骤数以及导致中断的 kind，外加 `target`（`kind`、`signature`、`managed`），即这次运行针对的桌面，以及 `baseline`（`state`、`approvedAt`、`compositorVersion`、`degraded[]`），即这次运行据以门控的能力基线。每次尝试写自己的运行目录；被中断的尝试会额外写 `suspended.json`（被中断的步骤、被破坏的前提、已提交的步骤、基线几何），根目录的 `result.json` 就是上面的报告。根时间线记录 `run.suspended`、`run.resume`（尝试编号、恢复步骤数、summary）和 `run.recovery-refused`；租约的 `renewals[]` 是这条 lineage 在控制侧的补充。`committed` 始终只属于一次尝试，从不跨尝试累计。

## 7. fault 记录

fault 是数据，不是异常：执行器把它写入 `out/runs/<runId>/fault.json`，并返回同一份记录。

```json
{
  "runId": "20261117T165012-a1b2c3",
  "status": "faulted",
  "step": 4,
  "broken": {
    "kind": "window.exists",
    "detail": "target window is not present",
    "expected": "present",
    "observed": "absent",
    "detectedAt": "2026-11-17T16:50:12.345Z"
  },
  "committed": [0, 1, 2],
  "lastConfirmedEffect": "step 2 (text): typed 18 characters",
  "screenshot": "out/runs/20261117T165012-a1b2c3/step-04-fault.png",
  "timeline": "out/runs/20261117T165012-a1b2c3/timeline.jsonl"
}
```

当所针对的 agent 或 external 桌面消失时，fault 保留被打破前提的事实，但 `broken.kind` 变成 `target.desktop-closed`，`detail` 说明桌面状态；agent 需要在对话里问宿主发生了什么。`committed` 列出本次尝试中效果已确认的步骤，因此作者可以围绕已经发生的事写一份新计划继续，而不必重复它们。`lastConfirmedEffect` 指明最后一个已确认的动作。被撤销的运行使用相同形态，`status` 为 `"revoked"`，`kind` 为 `"lease.valid"`。因无法派生恢复而抛出的 fault 保留被中断尝试的事实（`step`、`committed`、`lastConfirmedEffect`），并把拒绝的 kind 用作 `broken.kind`，原因作为 `detail`，`expected`/`observed` 为 null。

## 8. 同意绑定

`hyprscope control run` 只读取并校验一次计划——从文件，或从 stdin（`run -`）——然后把 `planBound: true`、summary 和卡片预览（`card`：一句描述加每步一行）一起传给 `requestLease`；同意卡片展示的就是这段描述和这些步骤行。在 `agent` 或 `external` 桌面里，人已经批准过这个桌面，所以运行改用程序化租约：不出现卡片，但计划绑定与 TTL、每次调用前的租约检查和 `wl-inject` 的证明都不变。`user` 保留逐次运行的卡片。无论走哪条路径，stale 或 unverified 的基线都会在进入同意之前以 `CAPABILITY` 拒绝。已校验的计划（补上默认值）按规范形式序列化（对象键递归排序、无空白），与运行一起存放在 `plan.json` 中，因此产物就是被批准的那份文档。

每次会变更状态的调用之前，执行器都会重读租约并要求：阶段为 `granted`、同一 lease id、`planBound` 为 `true`、未过期。不匹配会以 `revoked` 结束运行。同一张卡片还批准上面的有界恢复额度；派生计划通过续期同一份租约覆盖，而不是第二张卡片，因此宿主批准一个计划，以及固定次数的机械尝试来重新主张它。同意、租约绑定和变更门控在今天都是正确性机制，而不是安全边界：在 broker 接管之前，租约状态存放在 agent 的 uid 下（§9、LEASE.md）。尤其是同意卡片与注入输入共享同一个席位，因此 helper 现在要求已授予的租约证明，并在卡片打开期间拒绝注入；一个自己写 Wayland 客户端的进程仍然可以绕过这一点，这正是 broker/uid 分离才是真正修复的原因。

## 9. 限制与非目标

- 最后一次谓词读取与注入之间的 TOCTOU 无法避免。它通过在进程内针对一个快照加一次 fence read 求值来保持很小；绝对坐标点击在构造上就是低置信度的：它们需要 `window.focused`、`window.geometry`，以及一个确认效果已落地的预期。
- 没有撤销，也没有应用内部的断言：一切都只在 compositor 处可观察，因此「保存对话框出现了」是一条区域或窗口断言，而不是控件检查。
- 恢复是机械的：它在一份派生计划里重新建立可观察的 compositor 前提，从不对应用状态进行推理。任何需要决定的事情都会结束运行，以便作者从 fault 记录重新规划。
- 单席位：物理输入和注入输入交错。引擎能检测并恢复，但无法阻止。
- 计划语言刻意保持小。新增一个操作或一种谓词是带固定严重级别的代码变更，从不是文档变更。
- 运行产物（`plan.json`、`timeline.jsonl`、截图、`suspended.json`、`fault.json`、`result.json`）是诊断信息，不是稳定性承诺；只有上面的 fault 记录是向调用方承诺的。
