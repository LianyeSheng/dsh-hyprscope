# 能力基线文件 `baseline.json`

[English](/docs/cli/BASELINE.md) | 中文

> 状态：**已实现**。`src/compat/baseline.ts` 读取、校验并计算这个文件，`src/compat/probe.ts` 测量并写草稿，`hyprscope control baseline --probe` 是唯一记录人工批准的路径：测量结果比已验收基线更宽时，同一条命令向浮层要一张确认卡，宿主点击允许之后才写已验收的文件。设计背景和探针流程见 [COMPATIBILITY.md](/docs/cli/COMPATIBILITY.zh.md)。

`baseline.json` 是**一个桌面的能力结论**：用户自己的机器，或者一个受管实例。它记录探针测到了什么、证据在哪、谁在什么时候批准的。它只记录第一层（机器能力），不记录运行时状态，也不记录应用行为。

## 1. 位置与归属

| 项 | 值 |
|---|---|
| 已批准基线 | 用户桌面是 `$XDG_STATE_HOME/hyprscope/baseline.json`；`agent` 或 `external` 桌面是 `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json`（`XDG_STATE_HOME` 默认 `~/.local/state`） |
| 待批准草稿 | 用户桌面是同目录 `baseline.pending.json`，受管桌面是 `<signature>.pending.json`，由 `baseline --probe` 写 |
| 选择器 | `--desktop user|agent|external`；省略即 `user` |
| 原始证据 | `out/baseline/<probeId>/`（`probe.jsonl`：只读事实、测量计划、每步结果和测试窗口的输出；`summary.json`；`capture.png`；测量运行的计划快照和时间线），`out/` 已在 `.gitignore` 中；`HYPRSCOPE_BASELINE_EVIDENCE_DIR` 可以为测试挪动根目录 |
| 写入者 | 只有 `hyprscope control baseline`（`hyprscope control` 下的子命令；`--desktop` 选择文件）；引擎和计划只读 |
| 权限 | `0600`，和租约状态文件一致 |
| 写入方式 | 先写临时文件再 rename，避免读到半截 |

基线不是安全边界：它和执行器跑在同一个 uid 下，和租约状态一样，靠的是"没人去改"而不是权限。它要挡住的是**换机器之后带着旧假设继续跑**，不是恶意进程。

## 2. 顶层结构

| 字段 | 类型 | 含意 |
|---|---|---|
| `schema` | `1` | 格式版本；读取方遇到更高的版本必须拒绝，不能猜 |
| `state` | `usable` \| `degraded` \| `incomplete` | 见 §5；由写入方计算，读取方会重新核算 |
| `tool` | `{ name, version }` | 写这份基线的工具版本 |
| `probe` | `{ id, mode, script, startedAt, finishedAt, durationMs }` | `mode` 是 `full`（含测量计划）或 `read-only`；`script` 是探测脚本版本标识，当前是 `hyprscope-probe/2`，用来解释证据 |
| `fingerprint` | 对象 | 见 §3，环境指纹 |
| `capabilities` | `{ [id]: entry }` | 见 §4，能力结论 |
| `evidence` | `{ file, sha256 }` \| `null` | 原始证据文件及其哈希；证据文件丢了不影响基线有效，但放宽能力时必须重测 |
| `approval` | `{ approvedAt, approvedBy, source, evidenceSha256 }` \| `null` | `approvedBy` 只能是 `human`；`source` 记录确认方式：`overlay`（确认卡）、`desktop`（受管桌面的程序化同意）或 `cli`（直接调用，测试用） |
| `revisions` | 数组（可选） | 审计：`{ kind: "accept" \| "narrow", at, evidenceSha256 }`，收窄自动追加 |
| `notes` | `string[]`（可选） | 降级原因等给人看的补充，不参与判定 |

`approval` 为 `null` 的文件只是草稿：引擎必须按"没有基线"处理。

## 3. 环境指纹

指纹描述"测的是哪套环境"。`effective` 块和 `configHash` 是漂移检查要比对的值；其余字段只作描述。比对规则见 [COMPATIBILITY.md](/docs/cli/COMPATIBILITY.zh.md) §5.1。

```json
{
  "compositor": {
    "name": "hyprland", "version": "0.57.2", "branch": null, "commit": "…",
    "configProvider": "lua", "backend": "drm"
  },
  "monitors": [
    { "name": "HDMI-A-1", "x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1, "refreshRate": 143.99, "transform": 0, "dpmsStatus": true }
  ],
  "seats": { "count": 1, "name": 1 },
  "waylandGlobals": [
    { "interface": "zwlr_virtual_pointer_manager_v1", "version": 2 },
    { "interface": "zwp_virtual_keyboard_manager_v1", "version": 1 }
  ],
  "config": {
    "dir": "/home/user/.config/hypr",
    "luaFile": "/home/user/.config/hypr/hyprland.lua",
    "failsafeKey": "SUPER + ALT + ESC",
    "failsafeBound": true
  },
  "helpers": { "inject": true, "scratch": true },
  "effective": {
    "configProvider": "lua",
    "followMouse": 1,
    "binds": { "count": 163, "plainF12": false },
    "configErrors": []
  },
  "configHash": "…"
}
```

`effective` 和 `configHash` 由探针写入、由陈旧比对读取。更早版本写下的基线没有 `effective` 块，在重测之前一直是 `unverified`。

- `monitors` 按 `name` 排序，`waylandGlobals` 按 `interface` 排序，方便比较；
- 字段名沿用原始 `hyprctl -j` 输出（`at`、`size`、`dpmsStatus`），不是 `docs/cli/PROTOCOL.md` 的归一化契约名（`position`、`size`、`dpmsOn`）。指纹描述的是环境，不是对调用方的观察契约；
- `waylandGlobals` 存全量列表（不只关心的几个），换 compositor 或加插件时差异一眼能看出来；
- `helpers` 记录两个 C 程序这次是否可用：`inject`（`bin/wl-inject`）和 `scratch`（`bin/wl-scratch`，用 `pnpm run build:scratch` 编译）。
- `effective` 是版本不变也可能变的那层运行时状态：config provider、`input:follow_mouse`、绑定摘要和 `hyprctl configerrors`。探针用 `hyprctl status`、`getoption`、`binds` 和 `configerrors` 读它，不解析配置文件；compositor 报的 `[""]`（"没有错误"）会归一化成 `[]`。
- `configHash` 对 `agent` 桌面哈希生成的 `hyprland.lua` 和每个 `agent/*.lua` 片段；用户桌面和 `external` 实例没有生成配置，所以是 null。它只是一个便宜的失效触发器，因为 Lua 配置是程序，文件哈希说明不了它实际做了什么。

## 4. 能力条目

```json
{
  "dispatch.window.fullscreen-state": {
    "level": "optional",
    "status": "supported",
    "evidence": "measured",
    "checks": [
      {
        "name": "set-fullscreen",
        "at": "2026-11-17T21:40:12.345Z",
        "expected": { "internal": 1, "client": 0 },
        "observed": { "internal": 1, "client": 0 },
        "ok": true
      }
    ],
    "detail": null
  }
}
```

| 字段 | 类型 | 含意 |
|---|---|---|
| `level` | `required` \| `degraded` \| `optional` | 写入时的级别，**仅供参考**；读取方一律以代码目录为准（见 §6） |
| `status` | `supported` \| `unsupported` \| `unknown` | 结论 |
| `evidence` | `measured` \| `advertised` \| `unknown` | 结论的依据强度 |
| `checks` | 数组 | 每一小步的往返记录；`measured` 至少一条 `ok: true` |
| `detail` | `string` \| `null` | 不支持或未知时的原因，一句话 |

写入规则：

- `status: "supported"` 且 `evidence: "measured"`：至少有一条成功的往返记录；
- `status: "supported"` 且 `evidence: "advertised"`：只允许出现在 `optional` 或 `degraded` 能力上，且 `checks` 里是字段/协议存在性的记录；
- `status: "unsupported"`：必须有 `detail`，`checks` 里保留失败的往返记录；
- `status: "unknown"`：没测或测不成，`detail` 说明原因。

## 5. `state` 怎么算

```
requiredOk = ∀ cap, level(cap) === 'required' ⇒
               status === 'supported' && evidence === 'measured'
degradedOk = ∀ cap, level(cap) === 'degraded' ⇒
               status === 'supported' && evidence !== 'unknown'

state = !requiredOk  ? 'incomplete'
      : !degradedOk  ? 'degraded'
      :                'usable'
```

- `incomplete`：控制不可用，只读可用；
- `degraded`：控制可用，但少一条安全路径（例如兜底快捷键），回执和 `doctor` 必须写出来；
- `usable`：全部达标。

文件由 `--desktop` 选择：`hyprscope control baseline --probe / --show --desktop user|agent|external`，省略即 `user`。state 按文件分别计算，所以一个桌面的结论永远不会门控另一个。

## 6. 读取方规则（引擎侧）

```
effective(cap) =
     code declares cap
  && entry.status === 'supported'
  && entry.evidence !== 'unknown'                 # supported + unknown is treated as unknown
  && (entry.evidence === 'measured' || level(cap) !== 'required')
```

另外几条容错，都是往"能力更少"的方向倒：

| 情况 | 处理 |
|---|---|
| 文件不存在、`approval` 为 `null` | 当成没有任何基线 → 控制不可用 |
| `schema` 比代码支持的高 | 拒绝读取，按无基线处理 |
| `capabilities` 里多出代码不认识的 id | 忽略并告警（可能是更新版本写的） |
| 缺某个 id | 按 `unknown` |
| 条目里的 `level` 和代码目录不一致 | 以代码为准，忽略文件值并告警 |
| `status: supported` 但 `evidence: unknown` | 按 `unknown` 处理 |
| `state` 字段和重新核算的结果不一致 | 以重新核算为准，告警 |
| 证据文件已被清理 | 基线仍有效；但下一次放宽能力必须重新探测 |
| 运行中实例的生效配置与指纹不一致，或者运行中的 compositor 报不出某个值 | 标记基线 `stale`；`run`/`request` 以 `CAPABILITY` 拒绝，直到重测 |
| 基线没有 `effective` 块（在漂移跟踪之前写下） | 标记 `unverified`；控制以 `CAPABILITY` 拒绝，直到重测 |
| 记录的 `configHash` 与磁盘上生成的配置不一致 | 标记 `stale`；先停再启动桌面，然后重测，因为运行中的 compositor 还在用旧配置 |

这些规则指向同一件事：**文件可以被读坏、写坏，最坏结果只能是能力变少。**任何一条规则都不允许数据把能力放大到代码没有声明的程度。

代码在基线被验收之后新增的能力 id 不会出现在旧基线里，因此读出来是 `unknown`，不会被授予。所以像 `capture.window` 这样的新可选能力**不会被已有的已验收基线授予**：带窗口 `screenshot` 步骤的计划会以 `CAPABILITY` 被拒绝，直到 `hyprscope control baseline --probe` 测到它、并且宿主在同一命令为放宽后的基线弹出的确认卡上点了允许（新增能力 id 属于放宽，见 §7）。

## 7. 批准与收窄

1. `hyprscope control baseline --probe [--lang zh|en] [--desktop user|agent|external]` 先用只读阶段已经测到的事实（活动工作区的名字、布局原点、原本的活动窗口）构建测量计划，再取得它的租约（用户桌面弹卡，卡片展示这份计划的预览；受管桌面走程序化租约，见下文），然后打开测试窗口，向它发一次 `SIGUSR1` 解除固定尺寸提示，并通过执行器的内部测量模式执行测量计划。提交不了或验证不了的步骤会被记录下来，运行继续；只有租约丢失、计划的时间预算或外部对桌面的改动会让它停下。之后探针写证据目录，并把测量结果和已验收基线作比较。结果只收窄时，直接改已验收的文件（第 3 条）；结果更宽时，留下待批准草稿 `baseline.pending.json`（`approval: null`），并且同一条命令会向宿主弹出确认卡，写着结论（`state`）、必需/可选能力的计数和证据哈希。这一步不会让任何能力生效：待批准草稿按"没有基线"处理；
2. 探针在同一个进程里等待那张确认卡。允许时，它重读草稿指名的证据文件——哈希对不上就拒绝，因此批准绑定的是人实际复核过的那串字节（证据文件被清理只是警告）——把草稿提升为已验收文件，写入 `approval` 和一条 `revisions[kind: "accept"]`，删除待批准草稿，并打印已验收的基线。拒绝或超时什么都不写，草稿保留，报告说明卡片未被批准。没有单独的验收入口，待批准草稿也不能事后再验收：重新运行 `baseline --probe` 再测一次、再问一次。探针的租约卡（允许这次测量）和这张验收卡是同一套卡片机制上的两次不同同意；两张卡都按 `baseline --probe` 的 `--lang <zh|en>` 选择的语言渲染（默认 `zh`，或 `HYPRSCOPE_LANG` 环境变量；未知值按用法错误处理），CLI 的 stdout 仍是英文；
3. 之后重新探测**只会收窄**：新的有效集是旧的子集、且没有任何有效能力的证据变强时，直接改正式文件（`state` 可能降到 `degraded`/`incomplete`），保留已有的 `approval`，追加一条 `revisions[kind: "narrow"]`，不需要重新批准。旧的 `approval.evidenceSha256` 仍然指向人实际复核过的那份证据，而 `evidence` 和 revision 指向新的测量；
4. 任何放宽——`unknown` 变 `supported`、已经有效的能力的 `advertised` 变 `measured`、新增 `required` 项、新增能力 id——都是探针不能自行应用的放宽：它用第 2 条的卡片请人验收，只有宿主允许之后才写已验收文件。探针会把证据从 `advertised` 提升到 `measured` 的有效能力当作放宽，因此后来才编译测试窗口的机器要重新询问，而不是悄悄升级证据；
5. 收窄不需要重新批准，是因为它只会让工具更保守；放宽意味着"允许我做上一次不被允许的事"，必须重新经过人。

在 `agent` 或 `external` 桌面里，探针用的是程序化租约：人在 `desktop start`/`desktop attach` 时已经同意过一次，所以不再弹卡，验收也以程序化方式记在那次同意之下。用户桌面上，探针先拿它的租约卡，测量完成后再展示验收卡。验收始终是一次人工动作；拒绝或超时的卡片会让草稿保持待批准，只有再跑一次 `baseline --probe` 才能重新询问。

## 8. 与计划、租约的关系

- 能力集在 `hyprscope control run` 开始时就确定：校验期拒绝用到缺失能力的谓词和 op，并且**在请求租约之前**拒绝，避免为一份注定跑不了的计划弹同意卡；stale 或 unverified 的基线也以同样方式（`CAPABILITY`）被拒绝；
- 探针的测量计划是一份普通的已校验计划，由同一个执行器在内部测量模式下执行；`hyprscope control run` 和计划文档都请求不到这个模式，它也从不会运行恢复或弹出干扰询问；
- 运行回执记录这次使用的基线：`state`、`approvedAt`、`fingerprint.compositor.version`、降级项列表；
- 基线文件按桌面区分：`--desktop` 选择它，受管桌面的文件按签名区分，所以一个桌面的结论永远不会门控另一个；
- 基线不替代计划同意，也不替代每步的租约门控：它只回答"这台机器支不支持"，不回答"这一次允不允许动桌面"；
- 运行期间基线文件被改，不影响已经开始的运行；这一点和租约的信任模型一致，都是正确性机制，不是安全边界。
