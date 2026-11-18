# 兼容性与能力基线

[English](/docs/COMPATIBILITY.md) | 中文

> 状态：**已实现**。`src/compat/` 负责能力目录、基线读取器、有效集规则和陈旧比对；`src/compat/probe.ts` 测量这台机器，`hyprscope control baseline --probe/--show` 是命令接口（放宽已验收基线的那次探针自己会要一张确认卡），`doctor` 报告基线摘要和陈旧判定。探针的只读阶段留在 `src/compat/probe.ts`；每个会改变桌面的测量都是 `src/compat/probeplan.ts` 构建的一份测量计划里的一步，由普通计划执行器在内部测量模式下、在探针自己的租约和同一套注入门控下运行。这份文档解释这个安装步骤为什么存在、必须保证什么。

测试机验证过的数字（Hyprland 0.57.2、Lua 配置、单 `wl_seat`、单输出 2560×1440）只对那台测试机成立，[VERIFICATION.md](/docs/VERIFICATION.zh.md) 开头已经写明。这份文档把这句话变成一个安装动作：**测一遍、记下来、人确认、运行时按它收窄**。

## 1. 会变的三种东西

| 层 | 例子 | 归属 |
|---|---|---|
| 机器能力 | `hl.dsp.window.fullscreen_state` 在不在、绝对注入落点准不准、`.socket2.sock` 有没有、`clients[].fullscreenClient` 这个字段叫什么 | 安装时测一次，进能力基线 |
| 运行时状态 | 这个窗口现在是不是浮动、在哪个工作区、焦点在哪、指针在哪 | 每次运行现场读，**永不**进基线 |
| 应用行为 | 点了没反应、窗口关了状态没了、应用忽略 activate | 不可测、不可恢复；直接 fault |

一条计划能不能跑是三者的交集，但基线只负责第一层。把后两层塞进基线会变成过度承诺："机器能力 ✓" 不等于 "这些前提都能恢复"。

## 2. 命名与角色

| 词 | 是什么 | 谁产生 | 谁能改 |
|---|---|---|---|
| 探针（probe） | 一次测量：读接口，在自己的测试窗口上跑一份测量计划，记录原始证据 | 工具，代码固定脚本 | 只能改代码 |
| 能力基线（capability baseline） | 一台机器一份的结论文件：支持哪些能力、证据等级、环境指纹、批准人 | 探针写草稿 | 只有人能批准 |
| 验收（accept） | 人看过证据和差异后批准这份基线 | 人 | — |

不叫 checklist 的理由：checklist 暗示静态、人工勾选、勾了即放行。这三条都不成立——结论靠测、会随环境漂移、而且只能收窄不能放行。

**验收的同意和计划的同意是两件事。** 前者说的是"这台机器有哪些能力、证据在这里"，后者说的是"这一次允许你动桌面"。不能复用同一张卡，也不能因为验收过了就免掉计划同意。

## 3. 能力目录

每条能力有：一个 id、一个级别、一个检测方式、一个缺失后果。

### 3.1 级别

| 级别 | 含意 | 缺失后果 |
|---|---|---|
| `required` | 控制赖以存在的基础 | 控制整体不可用，`hyprscope control run` 在校验期就拒绝；只读观察不受影响 |
| `degraded` | 能控制，但少一条安全路径 | 基线、回执、`doctor` 里必须写出来 |
| `optional` | 只有对应谓词/op 依赖它 | 用到它的计划在校验期被拒，其余计划照跑 |

### 3.2 required

| id | 检测什么 | 证据怎么来 | 缺了会怎样 |
|---|---|---|---|
| `observe.hyprctl` | `version`、`status`、`clients`、`monitors`、`workspaces`、`layers`、`activewindow` 都返回可解析 JSON | 纯读，`measured` | 观察层失能，验收直接失败 |
| `observe.geometry` | `clients[].at` / `size` 存在、是整数、落在 `monitors[]` 铺出的布局范围内；`dispatch.window.move` 可用时，测量计划把测试窗口 move 一次，探针读回比对，确认是同一套坐标（`at`/`size` 是原始 `hyprctl -j` 字段名，归一化契约里叫 `position`/`size`） | 存在性 + 往返，`measured` | `window.geometry` 谓词和几何恢复失效 |
| `observe.cursor` | `cursorpos` 返回 `{x, y}` | 纯读，`measured` | `pointer.position` 谓词和指针恢复失效 |
| `dispatch.lua` | `status.configProvider === "lua"`，且测量计划里的工作区往返（重新激活只读阶段先读到的那个工作区）被接受、不返回 `error:`/`warning:` | 测量计划里的工作区往返，`measured` | dispatch 子集整段失效（`hyprlang` 是另一套语法），控制不可用 |
| `inject.pointer` | `wl-inject --probe` 报 `zwlr_virtual_pointer_manager_v1`，并且测量计划里的 `movePointer` 落在测试窗口内一个已知布局坐标的 `pointer.position` 默认容差（2 px）以内，通过 `cursorpos` 读回 | 协议存在 + 往返，`measured` | 指针注入不可用，或绝对落点不可信 |
| `inject.keyboard` | `--probe` 报 `zwp_virtual_keyboard_manager_v1`，并且测量计划注入的 `F12` 能被测试窗口收到（helper 键表里有 `F1`–`F12`，没有更冷门的 F13）；探针从测试窗口的 stdout 确认送达 | 协议存在 + 往返，`measured` | 键盘注入不可用，`text` / `chord` 一类步骤跟着失效 |
| `events.socket` | `.socket2.sock` 可连；开关测试窗口能读到 `openwindow` / `closewindow` | 往返，`measured` | 外部干扰检测和 `waitEvent` 失效；**没有它就不接管** |

`required` 能力一律要求 `measured`：协议里广告了不等于 compositor 真的照做（`exact` 字段那次就是"看着有、实际被忽略"）。只拿到 `advertised` 时记 `unknown`——接口在、语义没验，不算 `supported`。

### 3.3 degraded

| id | 检测什么 | 缺了会怎样 |
|---|---|---|
| `safety.failsafe-bind` | Lua 入口配置存在且可读、`hyprctl binds -j` 里能看到带描述文字的绑定 | 少一条交还路径；TTL、运行自身的交还路径、横幅按钮仍在，所以不算 `required` |

注意这一项在探测时**只做只读核对**：不写配置、不装快捷键、不跑 `hyprctl reload`。reload 能不能成功只有 `hyprscope control install-bind` 自己知道：它检查的是 `~/.config/hypr/hyprland.lua` 存在且可读（没有额外的 config provider 检查），配置报错或绑定没出现在 `hyprctl binds` 时会还原配置；但 `hyprctl reload` 本身抛错的分支不会还原，这是已知缺口。

### 3.4 optional

| id | 影响的谓词 / op / 恢复模板 |
|---|---|
| `dispatch.focus.window` | op `focusWindow`；谓词 `window.focused`；恢复模板 `focus` |
| `dispatch.focus.workspace` | op `workspace`；谓词 `workspace.active`；恢复模板 `workspace` |
| `dispatch.window.move` | op `moveWindow`；恢复模板 `geometry`（move 那一半） |
| `dispatch.window.resize` | op `resizeWindow`；恢复模板 `geometry`（resize 那一半） |
| `dispatch.window.float` | op `floatWindow`（`floating`）；恢复模板 `state` |
| `dispatch.window.pin` | op `floatWindow`（`pinned`）；恢复模板 `state` |
| `dispatch.window.fullscreen-state` | op `fullscreenWindow`；恢复模板 `state`（全屏那一半） |
| `observe.window.modes` | 谓词 `window.state` 依赖的数字字段 `fullscreen` / `fullscreenClient` |
| `capture.grim` | 携带 `region` 的 `screenshot` op；谓词 `region.unchanged` / `region.changed` |
| `capture.window` | 携带 `window` 的 `screenshot` op；需要编译好的 `bin/wl-capture`，以及提供 `ext-image-copy-capture`、`ext-foreign-toplevel-list`、`ext-image-capture-source` 的 compositor；由测量计划截取探针自己的测试窗口来测 |
| `observe.lock` | `hyprscope state` 快照里的 `lock` 字段（执行器用的 lean snapshot 没有它，也没有谓词或 op 依赖，属于记录用；尽力而为，`null` 不等于已解锁） |
| `dispatch.window.move-to-workspace` | 只有 dispatcher，计划 op 没有对应项；记录用，不门控 |

几何恢复同时需要 `dispatch.window.move` 和 `dispatch.window.resize`：只能移动不能改尺寸时，整类 `geometry` 恢复都按不可用处理，而不是只恢复一半。

### 3.5 证据等级

| 等级 | 含意 | 能支撑 `required` 吗 |
|---|---|---|
| `measured` | 工具做了往返：发出动作、读回状态、与预期比对一致 | 能 |
| `advertised` | 只看到接口、字段、协议 global 存在，语义没验过 | 不能；`optional` 和 `degraded` 可以记成 `supported` |
| `unknown` | 没测到、测不了、或探测中途被打断 | 不能 |

结论只有三态：`supported` / `unsupported` / `unknown`。`unknown` 一律按不可用处理，不做乐观推断。

## 4. 探针

### 4.1 只读阶段

无副作用，先跑：

1. 全量 `hyprctl -j` 读一遍，检查 §3.2 里那几个字段在不在；
2. 如果编译了 `bin/wl-globals`（`pnpm run build:probe`），取 registry 全局列表；
3. 如果编译了 `bin/wl-inject`，跑 `wl-inject --probe`，取 seat 数量和两个管理器的存在性；
4. 只读核对 `safety.failsafe-bind`；
5. 记录环境指纹和锁状态；
6. 取一次区域截取（`capture.grim`）；截屏不改变任何东西。

只读阶段能为只需要读的 `observe.*` 项支撑 `measured`；一切需要往返的东西都由测量计划和探针自己的测试窗口生命周期来测。

### 4.2 测量计划

要动桌面，因此要租约，**不是旁路**：

- `hyprscope control baseline --probe` 在请求租约之前先构建测量计划，依据是只读阶段已经测到的事实——活动工作区的名字、布局原点、原本的活动窗口。计划是一份普通的已校验文档：它只通过符号化的 `app`/`title` 选择器 `hyprscope-scratch` 指向探针自己的 `bin/wl-scratch` 窗口，步骤是普通目录 op（`workspace`、`focusWindow`、`movePointer`、`assert`、`chord`、`floatWindow`、`fullscreenWindow`、`moveWindow`、`resizeWindow`，外加一个通过 `window` 目标截取测试窗口的 `screenshot` 步骤，`capture.window` 就是这样测的），并携带 `requires`/`expect`；
- 探针随后自己走 `requestLease`（reason「安装验收：能力探测」，`planBound: true` 标明这是一次计划形式的同意，`planSummary` 写明这是验收，TTL 不超过 60 s，`maxResumes` 为 0）。因为测量计划就是一份普通计划，同意卡片展示的是和任何计划卡一样的预览——一句描述加每步一行——只是卡片标题是探针专用的。这张同意卡批准的是"允许探针临时接管桌面做测量"，**不是**批准基线本身；验收是第二次同意，由同一条命令在证据出来之后展示（§9）；
- 批准之后探针打开自带的测试窗口（`probe/wl-scratch.c`，产物 `bin/wl-scratch`，由 `pnpm run build:scratch` 编译），等它 map 出来，向它发一次 `SIGUSR1`，让它解除固定的 320×200 尺寸提示（这样 resize 往返才是真的），然后通过 `executePlan` 在内部测量模式下执行测量计划；
- 声明的前提不成立、dispatcher 被拒绝、或者后置条件读不回来的步骤会被记录下来，执行继续；这些记录就是测量证据，决定受影响能力记成 `unsupported` 还是 `unknown`。只有安全失败会让这次运行停下：租约丢失或被撤销、计划的时间预算、外部对桌面的改动。测量模式从不恢复、从不挂起，也从不弹出干扰询问；
- `hyprctl dispatch` 没报错只能证明表达式被接受，永远不能证明效果发生了；只有效果读回来，一次 dispatch 才算证据。因此计划声明自己的 `expect` 谓词，窗口 op（`floatWindow`、`fullscreenWindow`、`moveWindow`、`resizeWindow`）只有在 dispatcher 接受调用、状态又读回来时才作数；探针在运行结束后读回测试窗口的几何（move 和 resize 的 dispatch 真的落地了），并读测试窗口自己的 stdout（注入的 `F12` 到了）。这些是观察，不是注入；
- 运行结束后探针把测量结果与已验收基线比较：只收窄的结果直接写进已验收文件；更宽的结果留下待批准草稿，同一条命令随即向宿主弹出一张仅批准的确认卡，写着结论、能力计数和证据哈希，只有允许才写已验收的基线。拒绝或超时的卡让草稿保持待批准，下一次探针重新询问（[BASELINE.md](/docs/BASELINE.zh.md) §7）；
- 结束：关掉测试窗口，检查没有残留窗口和进程；
- 预算 60 s，计划的时间预算耗尽或超时按"未测"处理；产物写 `out/baseline/<probeId>/`：`probe.jsonl`（只读事实、测量计划、每步结果、测试窗口的输出）、`summary.json`（结论草稿）、`capture.png`，以及测量运行自己的产物（计划快照和时间线）。

### 4.3 探针不做的事

- 不碰用户窗口，只碰自己的测试窗口；
- 不装、不卸快捷键，不改配置（`safety.failsafe-bind` 只读核对）；
- 不执行作者写的计划，不读用户输入；它唯一运行的计划是工具自己构建的测量计划；
- 不清理用户桌面，只清理自己开的东西。

### 4.4 没有测试窗口时

只跑只读阶段：`observe.*` 仍然可以 `measured`（纯读），而 `dispatch.lua`、`inject.pointer`、`inject.keyboard`、`events.socket`、`capture.window` 需要测量计划和测试窗口，只能拿到 `advertised`、记 `unknown`。只要有 `required` 没达到 `measured`，基线就是 `incomplete`（§5），控制保持关闭。这是有意的严格：宁可不能用，也不要拿没验证过的语义去点用户的界面。

### 4.5 测量模式只在内部使用

现在这已经是一条规则，不是一个方向：AGENTS.md 记下了它，代码也在执行它。执行器是唯一的注入方，探针只通过它的内部测量模式接触桌面。这个模式不属于计划语言：`runPlanFile` 从不设置它，校验也没有对应字段，所以 `hyprscope control run` 和计划文档都请求不到它。探针在 `hyprscope control baseline --probe` 下走固定的代码路径；它持有自己的租约，在每次变更之前重读它，并且只通过测量计划指向自己的测试窗口。不设旁路，不设"不经过同意就测量"的开关，也不设针对用户窗口的路径。`--read-only` 也不是旁路：它不发 dispatch、不跑测量计划，产出的基线是 `incomplete`，因为必需能力没法用这种方式测到。

## 5. 有效能力集

```
effective(cap) =
     code declares cap                               # code is the upper bound
  && baseline.status(cap) === 'supported'
  && evidence(cap) !== 'unknown'                     # supported + unknown is treated as unknown
  && (level(cap) !== 'required' || evidence(cap) === 'measured')
```

- **方向**：代码是上界，基线只能减。基线里出现代码不认识的 id → 忽略并告警；基线里缺的 id → 按 `unknown`。
- **失败位置**（越早越好）：
  1. 同意卡片之前：`hyprscope control run` 和 `hyprscope control run --dry-run` 会拒绝用到缺失能力的计划（`CAPABILITY`），并点名能力 id 和一句人话；
  2. 恢复：派生计划在租约续期之前会对照同一份固定基线重新检查，因此机器跑不了的恢复步骤会让这次尝试以 `recovery.capability` fault，而不是悄悄续期控制权；
  3. 执行期：只剩「基线说支持、现场却变了」这一类，走现有 fault 与干扰路径。
- **基线不存在或 `incomplete`**：控制不可用，只读可用（`state`、`screenshot`、`events` 不受影响）。默认就该是关的。

### 5.1 漂移与陈旧判定

基线记录的是"当时测到了什么"；`src/compat/staleness.ts` 负责判断运行中的实例是否仍然与它一致。检查朝着"能力更少"的方向失败：基线没有记录的值是 `unverified`，运行中的 compositor 报不出来的值是 `stale`。

| 信息源 | 回答什么 | 何时运行 |
|---|---|---|
| 版本表 | schema、协议 global、JSON 字段名、`hl.dsp.*` 是否存在 | 每个 Hyprland 版本一次 |
| 运行时查询 | 生效配置：`configProvider`、`input:follow_mouse`、`hyprctl binds`（含 modmask）、`configerrors` | 探针时，以及每次 `run` 之前 |
| 薄探针 | 查询替代不了的往返：dispatch 被接受、指针落点、按键送达、测试窗口规则、事件流 | 安装时，以及任何失效之后 |

比对遵循四条规则：

1. **精确比对字段，没有阈值。** 版本、provider、`input:follow_mouse`、绑定数量、是否绑定了不带修饰键的 F12、作为集合的配置错误，都逐项精确比对；任何不一致都是 `stale`。
2. **只有记录了 `configHash` 才比对它。** 有生成配置的基线会记录 `configHash`；记录为 null 表示没有生成配置，也就没有可比的东西。改一个片段就会改变这个哈希。
3. **基线缺记录值 → `unverified`。** 在漂移跟踪之前写下的基线没有 `effective` 块；它无法证明任何事，控制会一直拒绝，直到重测。
4. **运行中观测不到值 → `stale`；`stale` 优先于 `unverified`。** 两种判定都按失败关闭：`run`（含 `--dry-run`）会在任何同意卡片之前以 `CAPABILITY` 拒绝。

- 配置文件不是推断依据。Lua provider 下它是程序；`hyprlang` 下它仍会 include 其它文件、使用变量。`hyprctl getoption`、`binds` 和 `configerrors` 报告的是真正生效的状态；文件 hash 只是一个便宜的失效触发器。
- 窗口规则没有查询接口：通配规则是否让测试窗口变成平铺、改尺寸或拒绝聚焦，只能开那个窗口观察。这个观察很便宜（一个窗口、几次读取），留在薄探针里。
- `doctor` 报告 target、判定、原因和字段差异，并且保持只读；stale 或 unverified 的基线不影响只读观察。
- 重测陈旧基线走正常的探针流程；放宽已验收基线时，探针会在同一条命令里请宿主验收。对生成的桌面，要先停再启动：运行中的 compositor 还在用旧配置时，探针会被 `DESKTOP_FAILED` 拒绝（`stop and start the desktop before probing it`），重启会带来新签名和新基线条目。收窄仍然自动生效，放宽仍然需要人工接受。

## 6. 反洗白

这套东西和"同意不是认证"是同一个坑：让 agent 同时当能力的权威和消费者，它就能靠改基线让失败变成通过。

- 探针写**事实**，不写结论：证据到结论的映射是代码里的规则表，不是 agent 的措辞；
- agent 可以发起探测、读证据、解释差异、起草给人看的说明；不可以编辑基线、不可以把 failed 改写成 `unknown`、不可以跳过 `required`；
- 运行失败永远不写基线：一次 plan fault 不改变机器能力结论，否则"恢复不了"会变成"能力不支持"的挡箭牌；
- 收窄自动生效（安全方向）；放宽（`unknown` → `supported`、`advertised` → `measured`、新增 `required`）必须人工重新验收；
- 每次写入记录证据文件的哈希，人批准的是这个哈希。

## 7. 未决问题

- **失效阈值已经定下**：§5.1 逐项精确比对记录的字段，并在记录存在时比对生成的配置哈希；没有编辑次数或 option 白名单。
- `--accept-advertised` 逃生门（没有测试窗口可跑时，拿未验证的语义去操作）：**不提供**，这是决定。
- `dispatch.lua` 用测量计划里的工作区往返来测（重新激活探针先读到的那个工作区）。这是接受的：它在验收租约下运行，是对那个工作区的幂等空转，也是证明 Lua provider 会求值表达式的唯一办法。
- 测试窗口客户端已经存在（`probe/wl-scratch.c`，由 `pnpm run build:scratch` 编译）。没有它，或者用了 `--read-only`，`dispatch.lua`、`inject.pointer`、`inject.keyboard`、`events.socket`、`capture.window` 都只能记 `unknown`，控制保持关闭。
- 多显示器、多 seat、分数缩放只作为指纹记录，不改变恢复模型；多 seat 仍按"共享 seat"假设处理，要不要在基线里单独降级待定。
- 基线粒度：用户桌面保留一份机器级文件；`agent` 或 `external` 桌面按实例签名各有一份（`$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json`），所以对一个桌面的探针永远不会门控另一个。监视器布局变化会记进指纹，但不是比对字段，今天不会让基线失效。
- 要不要支持"只在某个工作区探测"，避免打断用户当前工作：待定。

## 8. 落到代码上的位置

| 位置 | 做什么 |
|---|---|
| `src/compat/catalog.ts` | 能力 id、级别、检测与后果文案、需求映射、按参数收窄 |
| `src/compat/baseline.ts` | 读取器、写入规则、有效集、重新核算的 state、原子 `0600` 写入 |
| `src/compat/gate.ts` | 计划级门控、新鲜度门控、`CAPABILITY` 失败、缺失的必需能力列表 |
| `src/compat/probe.ts` | 探针编排：租约、只读阶段、测试窗口生命周期、通过执行器跑测量计划、指纹、证据、草稿 |
| `src/compat/probeplan.ts` | 从只读事实构建测量计划；步骤只通过符号选择器指向测试窗口 |
| `src/lease/baseline.ts` | `--probe` / `--show`、探针的验收卡、收窄、待批准草稿 |
| `probe/wl-scratch.c`, `tools/scratch/build.sh` | 测试窗口，产物 `bin/wl-scratch` |
| `src/plan/model.ts` | 每个谓词和 op 上的 `requires: CapabilityId[]`（仍是代码常量） |
| `src/plan/run.ts` | 同意卡片之前的门控、运行报告里的基线回执、派生计划复查 |
| `src/plan/recover.ts`, `src/plan/executor.ts` | `restorability()` 查询有效集；`executePlan` 也承载探针的内部测量模式 |
| `src/lease/cli.ts` | 命令接口；`run`/`--dry-run` 的门控；`--desktop` 选择 |
| `src/cli.ts`, `src/types.ts` | `doctor` 基线摘要，只读 |
| `test/compat.test.ts`, `test/compat-gate.test.ts` | 目录、读取器与门控测试，不需要 compositor |
| `src/compat/staleness.ts` | 测量生效配置并与指纹比对，给出 `fresh`、`stale` 或 `unverified` |

测量计划只用普通的目录 op（`workspace`、`focusWindow`、`movePointer`、`assert`、`chord`、`floatWindow`、`fullscreenWindow`、`moveWindow`、`resizeWindow`），不新增表达式；真要新增必须走同一套白名单模板和同一份代码目录。`hyprscope` 保持只读，`action` 保持为空。

## 9. 安装时完整走一遍

```sh
pnpm run build:probe && pnpm run build:inject   # compile the probe and the injection helper
pnpm run build:scratch                          # compile the scratch client the probe measures against
node bin/hyprscope.ts control install-bind              # failsafe shortcut (optional)
node bin/hyprscope.ts control baseline --probe          # shows the lease card, measures, and on a widening result asks the host and writes the accepted baseline on Allow
node bin/hyprscope.ts control baseline --show --diff    # human review: what is supported, what is missing, where the evidence is
node bin/hyprscope.ts control run plan.json             # normal use afterwards
```

`--probe` 就是完整的人工流程：只收窄有效集的结果自己生效并追加一条 revision；任何放宽——包括某个有效能力的证据从 `advertised` 提升到 `measured`——都会留下草稿，并由同一条命令弹出确认卡，只有宿主点允许才写已验收的基线。拒绝或超时的卡让草稿保持待批准，重跑探针会再问一次。验收之后，`doctor` 和每次运行的回执都会带上基线状态（state、批准时间、compositor 版本、缺失的降级项），这样换机器时不会悄悄带着一套旧前提继续跑。
