# 术语表

[English](/.agents/se/contracts/i18n/terminology.md) | 中文

本表是本仓库中英双语文档的术语真源，本身也是配对文档：两侧行一一对应，「中文」列在两侧都给出中文术语。配对约定见 [README.zh.md](/.agents/se/contracts/i18n/README.zh.md)。

**通用规则：**

- 「中文」列是中文正文的默认用词。该列写英文时，中文正文保留英文不翻译。
- 「首现括注」列非空时，只在全文首次出现处按该列书写，之后只写「中文」列的主词，不再重复括注。
- 「用法约束」列是词条的一部分：同一概念在产品文案、代码标识符与叙述文字中的写法可能不同，不能只改其中一处。
- 未收录的术语按 [translation-rules.zh.md](/.agents/se/contracts/i18n/translation-rules.zh.md) 处理：保留英文，或采用有出处的中文通行译法，不得即兴造词。

## 产品与入口

| English | 中文 | 首现括注 | 用法约束 |
|---|---|---|---|
| hyprscope | hyprscope | | 项目名与只读入口；不翻译。 |
| hyprlease | hyprlease | | 控制入口；不翻译。 |
| read-only entry | 只读入口 | | `hyprscope` 这个 CLI，永不改变桌面。 |
| control entry | 控制入口 | | `hyprlease` 这个 CLI，每次改动都要过租约。 |
| observation layer | 观察层 | | 状态读取、截图与事件流；不写成「观察器」。 |
| control lease | 控制租约 | | 有期限的控制权；首次出现后可简称「租约」。 |
| session discovery | 会话发现 | | 找到 compositor 实例与 Wayland display；不写成「会话探测」。 |
| compositor | compositor | | 保留英文；不写成「合成器」。 |
| capability report | 能力报告 | | `doctor` 的输出；不写成「能力清单」（那是基线文件）。 |

## 观察

| English | 中文 | 首现括注 | 用法约束 |
|---|---|---|---|
| snapshot | 快照 | | 某一时刻读到的 clients、monitors 与焦点；不写成「截图」。 |
| field | 字段 | | 观察契约里的一个键；不写成「属性」。 |
| stability contract | 稳定性承诺 | | 调用方可以跨版本依赖的东西；不写成「稳定契约」。 |
| layout coordinates | 布局坐标 | | 整个布局的全局坐标，可以是负数；不写成「屏幕坐标」。 |
| anchor point | 锚点坐标 | | 窗口内 0..1 的点，换算成布局像素；不写成「锚点」（那是 se-tools 的记录锚点）。 |
| absolute coordinate | 绝对坐标 | | 布局像素；点击时属于低置信动作，不写成「全局坐标」。 |
| region | 区域 | | 相对窗口的矩形，用于截图与断言；不写成「选区」。 |
| layer | 图层 | | `layers` 里报出的 layer-shell surface；不写成「层」。 |
| workspace | 工作区 | | Hyprland 的工作区；不写成「桌面」。 |
| monitor | 监视器 | | 一个输出；字段名 `monitor` 保留英文。 |
| window | 窗口 | | client 窗口；不写成「窗体」。 |
| event stream | 事件流 | | `.socket2.sock` 的订阅；不写成「事件队列」。 |
| lock state | 锁状态 | | 只读 logind 的 LockedHint，尽力而为；`null` 不等于已解锁。 |

## 控制与计划

| English | 中文 | 首现括注 | 用法约束 |
|---|---|---|---|
| lease | 租约 | | `state.json` 里的协调记录；不写成「授权」。 |
| host | 宿主 | | 坐在屏幕前的人；不写成「用户」。 |
| consent | 同意 | | 宿主对某一次动作的批准；不写成「授权」。 |
| consent card | 同意卡片 | | 申请租约或计划前的模态卡片；不写成「授权弹窗」。 |
| overlay | 浮层 | | Quickshell 渲染的界面；不写成「覆盖层」。 |
| banner | 横幅 | | 批准后缩成的顶部窄条；不写成「标题栏」。 |
| receipt | 回执 | | 结束时给宿主看的结果摘要；不写成「收据」。 |
| plan | 计划 | | 校验过的步骤文档；不写成「脚本」。 |
| plan hash | 计划哈希 | | 规范计划的 SHA-256；不写成「签名」。 |
| canonical hash | 规范哈希 | | 对补全默认值、键排序后的文档求的哈希；不写成「标准哈希」。 |
| step | 步骤 | | 一个 op 加上它的 requires 与 expect；不写成「动作」（动作指效果）。 |
| predicate | 谓词 | | 步骤声明、执行器求值的事实；不写成「断言」（`assert` 是另一个 op）。 |
| premise | 前提 | | 谓词在 `requires` 里的角色；不写成「前置条件」。 |
| expectation | 预期 | | 谓词在 `expect` 里的角色；不写成「期望」。 |
| preflight | 预检 | | commit 之前的租约、预算、事件与前提检查；`preflight → commit → verify` 作为一个短语保留。 |
| dispatch | dispatch | | 白名单里的 Hyprland 表达式；不写成「派发」。 |
| allowlist | 白名单 | | 封闭的命令或表达式集合；不写成「允许列表」。 |
| injection | 注入 | | 经 helper 发出的指针与键盘事件；不写成「插值」。 |
| helper | helper | | `bin/wl-inject` 这个二进制；不写成「辅助进程」。 |
| fault | fault | | 一次运行结束时写下的 JSON 记录；不写成「故障」。 |
| run | 运行 | | 一次 `hyprlease run` 的完整生命周期；「执行」是执行器的动作。 |
| attempt | 尝试 | | 运行里的一段执行窗口；恢复尝试带编号。 |
| executor | 执行器 | | 唯一的注入方；不写成「运行器」。 |
| dry run | 试运行 | | `--dry-run` 只校验并打印，不征求同意；不写成「空跑」。 |

## 干扰与恢复

| English | 中文 | 首现括注 | 用法约束 |
|---|---|---|---|
| interference | 干扰 | | 打破前提的外部改动；不写成「冲突」。 |
| interference prompt | 干扰询问 | | 阻塞式卡片；不写成「提示」（提示是横幅上的小字）。 |
| suspend | 挂起 | | 结束这次尝试但不 fault，好让派生计划开始；不写成「暂停」（pause 是一个 op）。 |
| interruption | 中断 | | 尝试停在某一步的时刻；不写成「打断」。 |
| recovery | 恢复 | | 用派生计划重建前提；不写成「回滚」。 |
| derived plan | 派生计划 | | 工具生成的、带 lineage 的计划；作者永远不写 `lineage`。 |
| lineage | lineage | | 恢复来源对象；不写成「谱系」。 |
| restore | 恢复步骤 | | 重建前提的具体步骤；单说「恢复」指 recovery。 |
| restorability | 可恢复性 | | 工具能不能重建某条前提；不写成「恢复能力」。 |
| ladder | 恢复顺序 | | 恢复步骤固定的由外向内顺序；不写成「阶梯」。 |

## 能力基线

| English | 中文 | 首现括注 | 用法约束 |
|---|---|---|---|
| capability baseline | 能力基线 | capability baseline | 一台机器一份的能力结论；不写成「兼容性清单」。 |
| probe | 探针 | | 安装时的测量动作；不写成「探测器」。 |
| evidence | 证据 | | 探针的原始记录；不写成「凭据」。 |
| evidence level | 证据等级 | | `measured`／`advertised`／`unknown`；等级名保留英文。 |
| fingerprint | 指纹 | | 记录下来的环境；不写成「哈希」（哈希指证据文件的哈希）。 |
| acceptance | 验收 | | 人批准基线的那一步；不写成「接受」。 |
| degrade | 降级 | | 少了 degraded 能力；不写成「退化」。 |
| invariant | 不变量 | | 必须一直成立的条件；不写成「恒等式」。 |
| scratch client | 测试窗口 | scratch client | 探针自己开的窗口；不写成「测试客户端」（那是可执行文件的名字）。 |
