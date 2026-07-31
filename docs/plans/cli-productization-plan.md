# MingXu 成品 CLI 剩余收口计划

## 1. 文档目的

本文档只记录截至 2026-07-31 尚未完成的 CLI 产品化工作。已经落库并通过现有自动化测试的阶段历史不再重复，具体变更以 Git 提交记录为准。

当前状态仍是：MingXu 已具备可运行的 Agent 核心、CLI 主链、TUI 产品原型、真实 coding-tools 插件和安装烟测，但尚未达到“可长期日常使用的成品 CLI”标准。

只有第 14 节全部通过后，才能把成品 CLI 标记为完成。

## 2. 保持不变的边界

- `@mingxu/core` 继续负责推理、上下文、Session、治理、调度和扩展宿主，不依赖 CLI 或 TUI。
- `@mingxu/tui` 是唯一终端 UI 实现，不依赖 Core、CLI 或插件实现。
- `@mingxu/cli` 是产品适配层，负责把运行时事件投影为 ViewModel 并驱动 TUI。
- Core 默认不提供文件、命令、浏览器、搜索、PDF、Git 或数据库工具，这些能力继续通过 Plugin 或 MCP 接入。
- 保持现有公共导出、CLI 参数、非 TTY stdout/stderr、Session 和扩展协议兼容，除非对应工作包明确要求迁移。
- 不直接编辑生成的 `dist/`。
- 插件市场、远程自动更新、多工作区标签页、后台守护任务、分布式 Subagent 和 OS 级插件沙箱不在本计划范围内。

## 3. 剩余工作总览

| 工作包 | 优先级 | 目标 | 前置依赖 | 状态 |
| --- | --- | --- | --- | --- |
| R1 终端渲染与真实 scrollback | P0 | 完成历史/活动区域分离和成熟差分渲染包装 | 无 | 已完成（2026-07-31） |
| R2 终端生命周期与异常恢复 | P0 | 所有退出和降级路径对称恢复终端 | 可与 R1 并行 | 待完成 |
| R3 IME、选择区与输入边界 | P0 | 完成真实中文输入法和选择编辑体验 | R1 的 viewport 协议 | 待完成 |
| R4 产品组件与复杂面板 | P1 | 完成 Markdown、Diff、CommandBlock 和面板交互 | R1、R3 | 待完成 |
| R5 CLI 职责拆分与 Session replay | P0 | 完成运行适配、命令、屏幕和回放边界 | 稳定事件投影 | 待完成 |
| R6 coding-tools 两阶段写入 | P0 | 写入前预览，审批后原子提交 | R4、R5 | 待完成 |
| R7 发布级压力与跨平台验收 | P0 | 用真实产物和三平台结果关闭发布门槛 | R1-R6 | 待完成 |

## 4. R1：终端渲染与真实 scrollback

### 目标

完成消息只写入普通终端 scrollback 一次，只有活动 assistant、工具、队列、composer、footer 和 Overlay 参与后续重绘。长历史不能继续作为活动组件反复排版。

### 实施项

- 选择并固定成熟差分渲染能力，封装在 `@mingxu/tui` 内部，CLI 不接触上游 API。
- 记录上游精确版本、许可证、必须携带的辅助文件、本地修改和升级策略。
- 定义 `CommittedTranscript` 与 `ActiveRegion` 协议，明确消息从活动状态固化到 scrollback 的唯一时机。
- `message_end`、工具完成和审批结果只能提交一次；重复、滞后或回放事件不能重复写入历史。
- 普通 delta 只使对应活动 block 及受影响布局失效，不重新渲染已提交历史。
- resize 时只重排活动区域；无法恢复时才允许完整重绘，并记录诊断原因。
- `Ctrl+L` 保留为显式完整重绘入口。普通刷新不得出现 `ESC[2J`。
- 保持同步输出、单帧单次写入、最高约 30 FPS 合并和 p95 小于 100 ms 的现有门槛。
- 1,000 条历史消息不得全部保留为活动渲染组件，内存增长需要有可解释上限。

### 特征测试

- 200 个及以上流式分块只更新一个 assistant block，不重复正文。
- 1,000 条历史消息后继续流式输出，验证活动组件数量、重绘行数和内存。
- 60x20、80x24、120x40 下验证提交、resize、长行、宽字符和 scrollback。
- Overlay 打开和关闭期间，已提交历史不被覆盖或重新输出。
- 普通 delta 的输出中不包含 `ESC[2J`，重绘行数只覆盖受影响活动区域。

### 验收

- 用户可以使用终端原生滚动条回看完整对话。
- 完成 block 的终端字节只提交一次。
- 1,000 条历史消息不会导致每次 delta 全历史重排。
- 普通流式更新最高约 30 FPS，95% delta 在 100 ms 内进入终端输出。

### 完成状态

R1 已于 2026-07-31 完成，后续工作包仍按本计划独立验收：

- `@mingxu/tui` 已固定包装 pi-tui `0.82.1`、pi-mono commit `2efa728d2ee90ef597626e96b1e28ef2b279f07c` 的 viewport 差分渲染思路，并在源码、根目录及 TUI 包内记录 MIT 来源、裁剪边界和升级策略。
- `PreparedRenderFrame` 将终端写入与 committed 前缀推进绑定；普通帧只保留活动区域，完整回放仍保留全部 block 索引。
- 连续完成前缀、重复/滞后事件、Overlay 往返、普通 delta、60x20/80x24/120x40、仅高度 resize、1,000 条历史和 200 分块性能门槛均已有自动化覆盖。
- R1 聚焦测试共 5 个文件、14 个用例通过；`pnpm typecheck`、`pnpm test`（55 个文件、244 个用例）和 `pnpm build` 通过。
- 本状态不包含 R2 的信号、异常退出、EPIPE 或完整终端生命周期恢复工作，也不代表成品 CLI 已完成。

## 5. R2：终端生命周期与异常恢复

### 目标

任何正常、异常或信号退出路径都恢复 raw mode、光标、bracketed paste、同步输出和进程监听器；能力不足的终端自动降级而不是挂起或崩溃。

### 实施项

- 在 `@mingxu/tui` 建立单一 `TerminalLifecycle` 所有权，进入和恢复操作必须幂等。
- 明确 Windows VT、raw mode、同步输出和 bracketed paste 的能力探测与降级顺序。
- 覆盖正常退出、Ctrl+C、Ctrl+D、Provider 错误、插件错误、SIGINT、SIGTERM、SIGHUP、未捕获异常和未处理 Promise rejection。
- 处理初始化只完成一半、重复 shutdown、stdout/stderr EPIPE 和 resize 期间退出。
- 进程信号监听器必须在 Session 结束后移除，不能跨多次交互运行泄漏。
- 降级模式不得输出不受支持的控制序列，也不得永久等待输入。

### 特征测试

- 使用子进程和 headless terminal 验证每种退出路径的最终控制序列。
- 模拟 `setRawMode`、同步输出或 resize 不可用以及初始化中途抛错。
- 连续启动和关闭多个交互 Session，检查监听器数量不增长。
- 在 stdout 和 stderr 分别断管时验证退出码和恢复顺序。

### 验收

- 所有退出路径都恢复终端并清理监听器。
- 恢复逻辑多次调用不会抛错或重复破坏终端状态。
- `TERM=dumb`、非 TTY 和缺少 raw mode 时有稳定、可测试的降级行为。

## 6. R3：IME、选择区与输入边界

### 目标

补齐现有 grapheme、多行、历史、粘贴和撤销/重做之上的真实输入法与选择编辑能力。

### 实施项

- 为 Editor 增加基于 grapheme cluster 的 anchor/focus 选择模型。
- 选择、替换、Backspace、Delete、Home、End、撤销和重做不得拆分组合字符或 emoji。
- 明确 IME composition 期间的临时文本、提交文本和光标显示规则，composition 未提交时不得触发命令或提交 prompt。
- 验证中文、日文、韩文输入法以及组合音标、ZWJ emoji 和宽字符列换算。
- 对无法区分 Shift+Enter 的终端提供一致的换行替代路径和简短提示。
- bracketed paste 与 selection、undo/redo、slash completion 共同使用时保持单次编辑事务。

### 特征测试

- selection 跨视觉行、宽字符和组合字符的移动、替换、删除、撤销与重做。
- composition start/update/commit/cancel 的状态转换，不把中间态写入命令菜单或 transcript。
- 60、80、120 列和 resize 后的选择高亮、逻辑光标与显示列。
- Windows Terminal、PowerShell、cmd、常见 Unix terminal 的真实输入样本。

### 验收

- IME composition 不产生半字符、重复字符或意外提交。
- 选择区操作始终按 grapheme 边界执行。
- resize、历史切换和 Overlay 往返后草稿、选择和光标位置保持一致。

## 7. R4：产品组件与复杂面板

### 目标

把仍处于基础实现的展示组件和面板收口为宽度感知、可折叠、可滚动且安全的产品组件。

### 实施项

- Markdown 使用稳定解析器支持标题、列表、引用、代码块、行内代码、链接和基本表格。
- Diff 支持文件头、行号、增删状态、折叠、超长行截断和 no-color 表达。
- 新增 CommandBlock，支持实时 stdout/stderr、运行状态、退出码、信号、耗时、截断、折叠和取消摘要。
- 完善 Table、Tree、KeyValue 和 Progress 的宽度分配、窄终端降级和控制字符净化。
- 所有外部文本继续统一阻断 ANSI、OSC 8、OSC 52、DCS、C0 控制字符、无效 Unicode 和二进制样式输出。
- Agent Tree 支持取消单个节点或子树，并显示确认、结果和失败原因。
- Overlay 嵌套、筛选、resize 和关闭后必须恢复 composer 草稿、选择、光标和原焦点。
- 高度不足时只滚动面板 viewport，composer 始终可见。

### 特征测试

- 超长 Markdown、Diff、Command 输出、无空格长文本和恶意控制序列。
- 多个并发工具的运行、完成、失败、取消和乱序更新。
- Overlay 多层 push/pop、Approval 抢占、resize 和焦点恢复。
- Agent 节点与子树取消的成功、拒绝、竞态和恢复路径。

### 验收

- 60 列紧凑模式下组件不重叠，composer 始终可见。
- 工具和命令输出不会混入 assistant 正文或操纵终端。
- 任意时刻只有栈顶 Overlay 接收输入，关闭后完整恢复编辑状态。

## 8. R5：CLI 职责拆分与 Session replay

### 目标

让显示继续作为运行时事件的幂等投影，同时移除 `CliTuiApp` 中过多的产品适配、命令处理和渲染职责。

### 实施项

- 建立 `RuntimeAdapter`，只负责订阅 Core/Session、规范化事件和暴露产品所需命令。
- 建立 `CommandController`，统一命令注册、解析、dispatch、错误和异步结果。
- 建立 `ProductScreen`，只消费 ViewModel、Overlay 状态和主题，不直接调用 Core。
- `CliTuiApp` 只负责生命周期编排和依赖连接，不再包含具体产品面板业务。
- PresentationBlock 按 `id + revision` 幂等更新，并与 ToolCall、assistant 正文和运行状态相互独立。
- Session resume 从持久化记录重建消息、工具摘要、审批摘要、PresentationBlock 和扩展快照。
- replay 不依赖历史屏幕输出，不重新执行工具，也不把短旧内容覆盖到新内容。
- 无法恢复的乱序或损坏记录进入诊断通道，不污染 stdout 或 transcript。

### 特征测试

- 同一事件序列经实时订阅和 Session replay 得到相同 ViewModel。
- 重复、滞后、缺失和损坏事件的恢复或拒绝策略。
- PresentationBlock revision、工具状态和 assistant 正文互不覆盖。
- CommandController 的注册表、help、completion 和 dispatch 完全一致。
- 拆分前后的非 TTY stdout/stderr、resume 和 continue 契约保持不变。

### 验收

- `CliTuiApp` 不再拥有具体命令和面板业务。
- 实时运行与 resume 重建得到同样的可见顺序和摘要。
- Provider、工具或插件错误后可以继续下一轮，且不会产生重复 block。

## 9. R6：coding-tools 两阶段写入

### 目标

write/edit 在任何文件副作用发生前生成可审阅 Diff，经 Policy 和 Approval 允许后才原子提交，并完整记录 Audit 与 Session 摘要。

### 协议设计要求

- 在 plugin SDK 中定义向后兼容的 prepare/commit 协议；现有单阶段只读工具不受影响。
- prepare 阶段解析 workspace realpath、规范化目标、读取基线并返回 DiffBlock、内容摘要和不可伪造的变更指纹。
- Approval 必须绑定 principal、Session、工具、规范化目标、基线哈希、目标内容哈希和变更指纹。
- commit 前重新检查 realpath、符号链接、网络路径和基线哈希，发现 TOCTOU 或内容漂移时拒绝写入并要求重新预览。
- commit 使用同目录临时文件和原子替换；失败或 Abort 时清理临时文件并保留原文件。
- Audit 记录 prepare、Policy 决定、Approval 决定、commit、拒绝和失败；不得记录 secret 或无上限全文。
- Session 只保存稳定摘要、Diff 引用、决定和最终结果，不保存可重新执行的隐式副作用。

### 特征测试

- 未审批、拒绝、审批超时和 Abort 时文件保持不变。
- prepare 与 commit 之间文件变化、符号链接替换、workspace 移动和权限变化。
- allow once、allow for session 和 principal 隔离。
- 原子写入失败、临时文件清理和重试。
- 安装、启用、执行、停用、卸载后 ToolRegistry、Audit 和 Session 的一致性。

### 验收

- Diff 在副作用前可见，审批绑定的正是最终提交内容。
- 任何基线或路径变化都会使旧审批失效。
- 停用或卸载后工具立即不可用，已存在 Session 仍可继续。

## 10. R7：发布级压力与跨平台验收

### 目标

只有真实 tarball、真实平台结果和完整压力门槛同时通过，才能关闭成品 CLI 计划。

### 自动化矩阵

- Windows、Linux、macOS 均运行 Node 22 和当前受支持的最新 Node 版本的 typecheck、test 和 build。
- 三个平台均从临时目录通过包管理器全局安装真实 tarball，运行 `--help`、`--version`、`init`、`chat`、`resume`、`--continue`、`doctor` 和扩展闭环。
- Windows 增加从 `C:\Windows\System32` 启动 `mingxu.cmd` 的配置、Session 和 Audit 路径测试。
- CI 和 release workflow 不允许 `continue-on-error`、平台跳过或用源码入口替代安装产物。
- 发布 workflow 必须执行完整验收命令和生产依赖审计；实际 publish 仍需显式授权。

### 压力与安全场景

- 1,000 条历史消息、200 个以上流式分块和多个并发工具。
- 超长 Markdown、Diff、Command 输出、无空格长文本和大段粘贴。
- Provider 错误、插件错误、进程信号、EPIPE、resize 风暴和 Overlay 竞态。
- ANSI、OSC 8、OSC 52、DCS、C0、无效 Unicode、孤立 surrogate 和二进制样式输出。
- 非 TTY、管道、stdout/stderr 分别重定向、`TERM=dumb`、`NO_COLOR` 和 `--plain`。

### 性能记录

- 首屏时间。
- delta 到终端输出延迟的 p50、p95 和最大值。
- 每帧输出字节数、重绘行数和整屏重绘次数。
- 1,000 条历史消息前后的活动组件数和进程内存。
- resize 与 Overlay 打开/关闭耗时。

### 实机记录

- 保存 Windows Terminal、PowerShell、cmd 和至少一个 Unix terminal 的版本、终端尺寸、执行命令和结果摘要。
- IME、resize、scrollback、信号恢复和安装路径至少各保留一个人工抽查记录。
- CI 配置存在不等于三平台验收通过，必须引用实际成功运行结果。

### 文档收口

- README 删除 coding-tools 骨架期口径，明确真实能力和仍未实现的 web-search。
- CHANGELOG 记录 CLI 行为、插件协议和安装门槛变化。
- SECURITY 描述两阶段写入、插件宿主进程边界和控制字符防护。
- development roadmap 与本计划保持同一状态，不提前宣称成品完成。

## 11. 执行顺序

```text
R1 渲染与 scrollback -----> R3 IME 与选择区 -----> R4 产品组件与面板
          |                                          |
          +-----> R2 生命周期恢复                    v
                                             R6 两阶段写入
R5 职责拆分与 replay -------------------------------+
                                                     |
                                                     v
                                              R7 发布验收
```

- R1、R2 可以并行，但终端生命周期所有权必须在两者合并前统一。
- R5 可以与 R1-R3 并行，前提是不改变已冻结的非 TTY 和 Session 公共契约。
- R4 完成稳定 DiffBlock/CommandBlock 后再实现 R6，避免 coding-tools 自定义展示协议。
- R7 可以持续补测试，但只有 R1-R6 全部完成后才能执行最终发布判定。

## 12. 每个工作包的交付规则

- 开始前检查并保护未提交修改，读取所属源码、测试和本计划。
- 只修改当前工作包及其可靠测试所必需的边界，不提前实现后续工作包。
- 运行最小相关测试和 `pnpm typecheck`。
- 涉及共享 CLI、Session、Policy、插件或 TUI 行为时运行 `pnpm test`。
- 涉及导出或打包时运行 `pnpm build`。
- 涉及安装产物时运行 `pnpm test:smoke` 和 `pnpm pack:dry-run`。
- 失败后保留复现和诊断，修复后重新运行同一检查。
- 更新本计划的工作包状态和验收证据，但不得提前勾选最终完成定义。

## 13. 最终验收命令

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:dry-run
pnpm audit --prod
```

这些命令必须在最后一次代码修改后运行。真实 tarball 安装、平台矩阵和实机记录不能用本地源码测试代替。

## 14. 成品 CLI 完成定义

- [ ] Transcript 使用普通终端 scrollback，完成消息只提交一次，普通 delta 不清屏或重排全部历史。
- [ ] 差分渲染能力通过 `@mingxu/tui` 固定包装，并记录版本、许可证和升级边界。
- [ ] 正常退出、异常、信号、EPIPE 和降级终端均恢复终端状态并清理监听器。
- [ ] Editor 通过 IME composition、选择区、宽字符、resize 和真实终端输入测试。
- [ ] Markdown、Diff、CommandBlock、Table、Tree 和 Progress 达到产品组件验收标准。
- [ ] Overlay、Approval 和 Agent Tree 通过复杂焦点、viewport 和取消测试。
- [ ] RuntimeAdapter、CommandController、ProductScreen 和 Session replay 边界完成。
- [ ] coding-tools write/edit 通过预览、审批、原子提交、TOCTOU 防护、Audit 和 Session 全链路。
- [ ] 1,000 条历史、并发工具、恶意输出和性能指标通过发布门槛。
- [ ] Windows、Linux、macOS 的真实 tarball 全局安装 CI 实际通过，Windows System32 场景通过。
- [ ] README、CHANGELOG、SECURITY 和 development roadmap 与真实能力一致。
- [ ] 第 13 节全部命令通过且没有平台静默跳过。

## 15. 发布口径

在第 14 节全部勾选之前，只使用以下表述：

> MingXu 已具备可运行的 Agent 核心、CLI 主链、真实终端 scrollback、TUI 产品原型、真实 coding-tools 插件和安装烟测，正在完成异常恢复、输入法边界、两阶段写入和跨平台发布验收。

全部通过以后，才可以使用：

> MingXu CLI 已达到可长期日常使用的本地 Agent 产品闭环，并具备稳定的扩展安装、治理和终端交互体验。
