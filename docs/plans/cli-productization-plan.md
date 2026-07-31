# MingXu 成品 CLI 收口计划

## 1. 文档目的

本文档定义 MingXu 从“核心运行时可用、TUI 原型可运行”走向“可长期日常使用的成品 CLI”所需的完整工作。

对标 Codex CLI、Claude CLI 和 pi-mono，指的是终端交互质量、稳定性和信息组织达到同一成熟度，不复制它们的品牌、颜色、文案、源码或产品定位。

MingXu 仍然是通用 Agent 大脑：Core 负责推理、上下文、Session、治理、调度和扩展宿主；文件、命令、搜索、PDF、浏览器、Git 和数据库继续通过 Plugin 或 MCP 接入。

## 2. 当前基线

### 2.1 已经具备

- Provider、流式模型执行、AgentSession、Session 恢复和上下文压缩主链。
- Policy、Approval、Audit、Budget、Abort、Secret reference 和项目 Trust。
- MCP、Memory、Resource、Skill、Preset、Subagent 和本地扩展治理入口。
- `chat`、`--prompt`、`resume`、`--continue`、`sessions`、`doctor` 和 `init`。
- OpenAI-compatible、DeepSeek、Anthropic 和 Gemini 的统一模型事件转换。
- 独立的 `@mingxu/tui` 包，以及基础 Terminal、Editor、Box、SelectList、Tree、Table、Diff 和 Progress 组件。
- 基于稳定消息 ID 的基础 ConversationViewModel，流式更新不再按 token 追加新消息。
- `/extensions`、`/context`、`/agents`、`/audit`、`/trust`、`/preset`、`/compact` 和 `/steer` 面板入口。
- Windows `mingxu.cmd`、非 TTY 纯文本模式和打包烟测基础。

### 2.2 当前不足

- `@mingxu/tui` 仍是初级自研行渲染器，尚未接入计划中的成熟差分渲染能力。
- 首次渲染仍会清屏，Transcript 还没有真正固化到普通终端 scrollback。
- Overlay 目前是 CLI 内部的单面板状态，不是真正的栈、焦点和 viewport 系统。
- Editor 仍按字符串索引移动和删除，组合字符、emoji、视觉行和 IME 边界不完整。
- Markdown、Diff、Table、Command 输出和主题系统仍是原型级实现。
- CLI 产品适配、命令处理、运行事件和界面渲染仍集中在 `CliTuiApp`。
- `coding-tools` 和 `web-search` 仍是协议骨架，不能作为完整扩展闭环的真实样例。
- 测试主要依赖 fake terminal，尚未形成 xterm、Windows 和真实 tarball 的发布矩阵。

### 2.3 当前成熟度判断

| 领域 | 当前估计 | 成品目标 |
| --- | ---: | ---: |
| Agent 核心运行时 | 80%～85% | 95% |
| 非交互 CLI 与 Session | 75%～80% | 95% |
| 扩展安装与治理 | 65%～70% | 90% |
| TUI 架构 | 55%～60% | 95% |
| TUI 视觉和交互手感 | 35%～45% | 90% |
| 跨终端发布验证 | 40%～50% | 95% |

这些百分比只用于排定优先级，不作为验收依据。最终完成状态只由本文后面的测试和发布门槛决定。

## 3. 成品定义

MingXu CLI 同时满足以下条件时，才可以称为成品：

1. 用户可以在 Windows、Linux 和 macOS 的常见终端中稳定启动、聊天、中止、退出和恢复会话。
2. 长流式响应只更新当前 assistant block，不重复、不整屏闪烁、不破坏历史 scrollback。
3. 用户消息、assistant 正文、工具、审批、错误和状态有明确但克制的信息层级。
4. 输入框在生成期间保持可用，Follow-up 和 Steering 行为可预测。
5. `/` 菜单、选择器和 Overlay 具有统一焦点、滚动、关闭和恢复规则。
6. 非 TTY、管道、重定向和 `--prompt` 保持稳定、可解析的纯文本契约。
7. Core 默认没有外部工具，但用户可以安装一个真实插件完成“安装、检查、启用、审批、执行、停用、卸载”闭环。
8. 模型、工具和插件输出不能通过 ANSI、OSC 或控制字符操纵终端。
9. 所有异常退出路径恢复 raw mode、光标、bracketed paste 和同步输出状态。
10. 发布验收链在真实安装产物上通过，不能以跳过代替成功。

## 4. 产品与技术边界

### 4.1 本阶段包含

- Inline scrollback TUI，不进入 alternate screen。
- 差分渲染、稳定活动区域、主题、语义块和 Overlay 栈。
- ConversationViewModel、输入系统、审批、扩展中心、上下文检查器和任务树。
- Windows、非 TTY、resume、continue 和异常恢复收口。
- 一个真实可用的官方参考插件，用于验证扩展治理协议。
- 完整终端测试、真实 tarball 安装和发布文档。

### 4.2 本阶段不包含

- 插件市场、推荐系统和远程自动更新。
- 默认内置文件、命令、浏览器、搜索、PDF、Git 或数据库能力。
- 任意插件自定义 TUI 组件。
- 多工作区标签页、后台守护任务和分布式 Subagent。
- OS 或容器级插件沙箱。
- 像素级复制 Codex、Claude 或 pi-mono。

## 5. 目标架构

```text
@mingxu/core
  Runtime / AgentSession / Policy / Approval / Audit / Session / EventBus
                         |
                         v
@mingxu/cli
  RuntimeAdapter -> ConversationViewModel -> Product Components
                         |
                         v
@mingxu/tui
  Terminal / Renderer / Input / Overlay / Theme / Generic Components

@mingxu/plugin-sdk <--- Plugin / MCP contributions ---> @mingxu/cli
```

依赖规则：

- `@mingxu/core` 不依赖 CLI 或 TUI。
- `@mingxu/tui` 不依赖 Core、CLI 或插件实现。
- `@mingxu/plugin-sdk` 只提供稳定协议和类型。
- `@mingxu/cli` 是唯一产品适配层，负责把运行时事件投影为 ViewModel。
- 插件只能返回 Tool、Resource、Skill 等标准贡献和 PresentationBlock，不能控制终端。

## 6. 实施阶段

### 阶段 A：冻结基线和建立终端特征测试

目标：在改写渲染器之前，固定现有公共行为，避免修 TUI 时破坏 Session、流式事件和非交互输出。

工作项：

- 为当前 `mingxu`、`chat`、`--prompt`、`resume`、`--continue` 建立字符级输出基线。
- 固定 stdout 和 stderr 契约：assistant 正文进入 stdout，诊断、工具状态和错误进入 stderr。
- 记录 TTY、非 TTY、`TERM=dumb`、`NO_COLOR` 和 stdout 重定向的分流矩阵。
- 给 AgentMessage、ToolCall、PresentationBlock 和 Run 建立稳定 ID 测试。
- 建立 200 个分块、重复事件、滞后事件和中止事件的回归用例。
- 在改动开始前保存 Windows Terminal 与 PowerShell 的真实输出样本。

验收：

- 现有核心行为拥有自动化特征测试。
- 测试可以稳定重现当前流式重复、光标或 scrollback 问题。
- 后续阶段不能改变非交互 stdout 契约。

### 阶段 B：终端引擎和 inline scrollback

目标：建立不会闪屏、不会破坏历史记录、能够安全恢复的终端底座。

工作项：

- 在 `@mingxu/tui` 内封装固定版本的成熟差分渲染能力；CLI 不直接依赖上游 API。
- 记录上游版本、MIT 许可证、修改点和必需辅助文件。
- 将终端内容分成“已经提交到 scrollback 的历史区域”和“可重绘的活动区域”。
- 完成消息只向终端提交一次，活动 assistant、队列、composer、footer 和 overlay 才参与重绘。
- 删除普通刷新路径中的 `ESC[2J`；仅首次启动、resize 后无法恢复以及 `Ctrl+L` 时允许完整重绘。
- 使用 synchronized output，按最高约 30 FPS 合并流式失效请求。
- 普通 delta 只使活动 assistant block 失效，不能重新排版所有历史消息。
- 实现 raw mode、光标、bracketed paste、Windows VT、resize 和进程信号的对称恢复。
- 终端不支持同步输出或 raw mode 时自动降级，不能直接崩溃。

验收：

- 200 个流式分块不产生普通 `ESC[2J`。
- 长对话可以使用终端原生滚动条回看，历史内容不会被活动区域覆盖。
- resize 后 transcript、composer 和光标位置正确。
- 正常退出、中止、Provider 异常和未捕获异常后终端状态均恢复。

### 阶段 C：输入系统成品化

目标：让中文、英文、emoji、多行、历史和补全在真实终端中稳定工作。

工作项：

- 光标移动、删除和选择统一按 grapheme cluster 处理。
- 中文、组合字符、emoji 和宽字符使用一致的逻辑位置与显示列换算。
- Up/Down 优先移动视觉行，到达首尾后才进入历史记录。
- 支持多行输入、撤销/重做、Home/End、Ctrl+A/E 和安全粘贴。
- Enter 提交，Shift+Enter/Ctrl+J 换行；无法识别 Shift+Enter 的终端显示可操作提示。
- 实现 bracketed paste；大段粘贴先进入受保护状态，避免其中的换行被直接执行。
- `/` 只在输入开头触发命令菜单；路径、普通正文中的 `/` 不触发。
- Tab 完成当前候选，Esc 只关闭最上层菜单或 Overlay，不意外清空正文。
- `Ctrl+C`：运行中中止；空闲且有草稿时清空；再次按下退出。
- `Ctrl+D`：空输入二次确认退出；有输入保持删除语义。
- `Ctrl+L` 强制重绘；`Ctrl+O` 切换详细模式。

验收：

- 中文、emoji、组合字符的插入、移动和删除没有半字符损坏。
- 多行输入在 60、80、120 列下光标位置正确。
- 粘贴多行命令不会自动逐行执行。
- 生成期间可以继续输入并进入 Follow-up 或 Steering 队列。

### 阶段 D：语义 Transcript 和视觉主题

目标：把“日志输出”变成克制、可扫描、可长期阅读的产品界面。

工作项：

- 定义 `user`、`assistant`、`tool`、`status`、`error`、`approval-result` 六类稳定语义块。
- 用户消息使用轻量背景或左侧强调；assistant 正文不使用大卡片和冗余标签。
- 工具默认折叠为一行，等待审批、运行中、成功、失败和取消使用不同符号与文字。
- 正常完成不显示独立 run result；usage 和 termination 默认进入详细模式。
- 启动页眉只显示一次：MingXu、模型、工作目录和信任状态。
- Footer 默认仅显示运行状态、当前模型和上下文余量。
- 空会话显示两到三条简短建议，不显示调试式占位文字。
- 建立 accent、text、muted、border、success、warning、error、user 和 tool 语义色。
- 支持 dark、light 和 no-color；所有状态不能只依靠颜色表达。
- Markdown 支持标题、列表、引用、代码块、行内代码、链接和基本表格。
- Diff 支持文件头、行号、增删高亮、折叠和超长行安全截断。
- CommandBlock 支持实时 stdout/stderr、运行状态、退出码、耗时、截断和折叠。
- Table、Tree、KeyValue 和 Progress 使用宽度感知布局。

验收：

- 同一个 assistant 最终正文只出现一次。
- 工具状态不会混入 assistant 正文。
- 60 列进入紧凑模式且输入框始终可见。
- `NO_COLOR`、`TERM=dumb` 和 `--plain` 不输出 ANSI。
- 模型或插件输出中的 ANSI、OSC 8、OSC 52、DCS 和控制字符不能操纵终端。

### 阶段 E：Overlay、命令和产品面板

目标：让全部面板共享同一套焦点、选择、滚动和关闭规则。

工作项：

- 在 `@mingxu/tui` 实现真正的 OverlayHost 和 Overlay 栈。
- 明确优先级：Approval > 阻塞错误 > 选择器/浏览面板 > 命令菜单。
- Overlay 支持 viewport 内滚动、窄终端布局、焦点恢复和 resize。
- 命令菜单、`/help` 和命令 dispatch 只读取同一个命令注册表。
- 命令菜单显示 usage 和一句说明，不把候选写入 transcript。
- 未知命令在 composer 附近显示临时错误，不污染会话正文。
- `/model` 和 `/sessions` 提供可过滤选择器。
- Approval 展示来源、权限、风险、规范化目标、参数摘要和 Policy 原因。
- Approval 支持允许一次、当前 Session 允许、拒绝；关闭后 transcript 只保留一行摘要。
- `/extensions` 展示版本、来源、Adapter、权限、完整性、健康和错误，并复用 Extension Service。
- `/context` 展示五层 Instructions、Memory、Resource、Skill、消息预算和 compaction，不显示 secret。
- `/agents` 展示父子任务树、Preset、模型、状态、耗时、预算、结果和错误，并支持取消节点或子树。
- `/audit`、`/trust`、`/preset` 和 `/status` 使用统一面板外壳。

验收：

- 任意时刻只有栈顶 Overlay 接收输入。
- Overlay 关闭后 composer 内容、光标和焦点恢复。
- 所有注册命令在菜单、help 和 dispatch 中完全一致。
- 高度不足时面板内部滚动，不能挤走 composer。

### 阶段 F：ConversationViewModel 和运行事件收口

目标：使所有显示成为运行时事件的幂等投影，彻底消除重复消息和日志式追加。

工作项：

- `CliTuiApp` 拆分为 RuntimeAdapter、ConversationViewModel、CommandController 和 ProductScreen。
- Agent 事件携带 eventId、sequence、sessionId、runId、messageId、toolCallId 和 source。
- `message_update` 采用累计内容更新同一个 block；短旧内容不能覆盖长新内容。
- `message_end` 只固化已有 block，不能重新追加最终消息。
- 用户提交和 runtime 回放只能有一个权威显示来源。
- ToolCall 按 ID 原位更新，PresentationBlock 按 `id + revision` 更新。
- 重复事件幂等忽略；允许的乱序事件短暂缓冲，无法恢复的事件记录诊断并拒绝投影。
- Follow-up、Steering、usage、termination 和运行状态进入独立状态模型。
- Session resume 从持久化记录重建同样的 ViewModel，不依赖屏幕输出反推状态。

验收：

- 重复、滞后和乱序事件不产生重复块。
- 中止、Provider 错误和工具错误后仍能继续下一轮。
- resume 后消息顺序、工具摘要和扩展快照一致。
- 正文投影和详细状态投影相互独立。

### 阶段 G：扩展闭环的真实样例

目标：证明 MingXu 的“通用大脑 + 可选择手脚”能够完整落地。

工作项：

- 完成 `@mingxu/coding-tools` 最小真实实现：read、list、search、write、edit、command。
- 该插件默认不安装、不启用，使用与第三方完全相同的 manifest、权限和生命周期。
- 所有文件操作限制在 workspace realpath 内，拒绝越界、符号链接目标和网络路径。
- write/edit 先生成 DiffBlock，经过 Policy 和 Approval 后才产生副作用。
- command 仅接受 argv、受限 cwd、env allowlist、timeout、输出上限和 AbortSignal。
- 完成从本地目录或 tarball 的 inspect、add、enable、healthCheck、disable 和 remove。
- 扩展安装后默认 disabled；enable 才允许执行插件入口。
- 扩展启停失败恢复 Registry、Session、配置和锁文件。
- `web-search` 可以继续作为后续独立插件，不阻塞本批成品 CLI，但文档必须明确其未实现状态。

验收：

- 无扩展时 ToolRegistry 中不存在文件、命令或网络工具。
- 安装并启用 coding-tools 后能力变化可见且进入 Audit。
- 文件修改能够展示 Diff、请求审批、执行并在 Session 中留下摘要。
- 停用或卸载后工具立即不可用且会话仍可继续。

### 阶段 H：Windows、纯文本和安装体验

目标：使真实用户不需要理解项目结构也能稳定安装和启动。

工作项：

- 固定 Node `>=22.19.0`、pnpm 和打包依赖版本。
- CLI tarball 必须自包含所需 JavaScript 和终端辅助文件。
- Windows 保留 `mingxu.cmd` 作为受限 PowerShell 环境下的正式入口。
- 从 `C:\Windows\System32` 启动时，配置、Session 和 Audit 相对路径仍相对配置目录解析。
- 直接启动时自动判断 TTY、raw mode、TERM 和 stdout 是否重定向。
- 非 TTY、管道和 `--prompt` 走纯文本模式；没有输入时不能永久等待。
- stdout 重定向时不输出欢迎页、状态栏、ANSI 或交互提示。
- stderr 重定向和管道破裂时给出稳定退出码，正确处理 EPIPE。
- `resume` 和 `--continue` 在非交互场景中支持 prompt，并自动定位当前 workspace 最近会话。
- `init --force` 修改旧配置前创建备份，不删除旧 Session。

验收：

- Windows 实际运行 `mingxu.cmd --help`、`--version`、`init`、`chat`、`resume` 和 `--continue`。
- Unix 实际运行打包后的 `mingxu` bin。
- 从非项目目录启动不会尝试写入系统目录。
- stdout 重定向得到纯净正文，stderr 保留可诊断信息。

### 阶段 I：发布级测试和性能门槛

目标：把“在开发机上可运行”升级为“发布产物可验证”。

工作项：

- 使用 `@xterm/headless` 建立 VirtualTerminal。
- 覆盖 60x20、80x24、120x40、resize、scrollback、Overlay、宽字符、emoji、IME 和粘贴。
- 建立正常退出、Ctrl+C、Ctrl+D、Provider 错误、插件错误和进程信号恢复测试。
- 覆盖 200 个及以上流式分块、多个并发工具、超长 Markdown、Diff 和 Command 输出。
- 覆盖恶意 ANSI/OSC、超长无空格文本、无效 Unicode 和二进制样式输出。
- 从临时目录打包并全局安装真实 CLI tarball，而不是直接调用源码。
- Windows、Linux 和 macOS CI 不允许静默跳过平台测试。
- 记录关键性能指标：首屏时间、delta 到显示延迟、重绘行数和长会话内存。

性能门槛：

- 普通流式更新合并到最多约 30 FPS。
- 95% 的 delta 在本地事件到达后 100 ms 内可见。
- 普通 delta 不触发整屏重绘。
- 1,000 条历史消息不要求全部保留为活动渲染组件。
- 终端 resize 和 Overlay 打开不造成可感知的长时间阻塞。

验收命令：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:dry-run
pnpm audit --prod
```

## 7. 测试矩阵

| 场景 | Windows | Linux | macOS | Fake TTY | xterm/headless | 真实安装 |
| --- | --- | --- | --- | --- | --- | --- |
| 交互聊天 | 必须 | 必须 | 必须 | 是 | 是 | 是 |
| 长流式响应 | 必须 | 必须 | 必须 | 是 | 是 | 是 |
| 中文/emoji/IME | 必须 | 必须 | 必须 | 部分 | 是 | 抽查 |
| resize/scrollback | 必须 | 必须 | 必须 | 否 | 是 | 是 |
| Approval/Overlay | 必须 | 必须 | 必须 | 是 | 是 | 抽查 |
| 非 TTY/管道 | 必须 | 必须 | 必须 | 是 | 否 | 是 |
| resume/continue | 必须 | 必须 | 必须 | 是 | 部分 | 是 |
| 异常终端恢复 | 必须 | 必须 | 必须 | 部分 | 是 | 是 |
| 扩展完整闭环 | 必须 | 必须 | 必须 | 是 | 部分 | 是 |

## 8. 交付顺序和依赖

```text
A 基线测试
  -> B 终端引擎
     -> C 输入系统
     -> D 语义 Transcript
        -> E Overlay 与产品面板
        -> F 事件投影收口
           -> G 真实扩展样例
           -> H 平台与安装收口
              -> I 发布验收
```

阶段 B 是后续所有视觉工作的前置条件。阶段 F 可以和 C/D 的后半段并行设计，但不能在事件身份未固定时提前完成。阶段 G 不改变 Core 的零工具原则。

## 9. 实施优先级

### P0：阻止称为成品的问题

- 真正的 inline scrollback 和差分活动区域。
- 流式消息幂等、禁止重复和稳定事件身份。
- Editor 的 grapheme、多行、粘贴和光标正确性。
- Overlay 栈和 Approval 焦点。
- Windows raw mode、退出恢复、非 TTY 和重定向。
- xterm/headless 与真实 tarball 验收。

### P1：决定日常使用体验的问题

- 语义主题、Markdown、Diff 和 CommandBlock。
- 命令菜单、模型和 Session 选择器。
- Extension Center、Context Inspector 和 Agent Tree。
- Follow-up、Steering、详细模式和状态栏。
- 一个真实可用的官方参考插件。

### P2：完成后可以继续增强

- 动态 prompt suggestions。
- 会话 recap。
- 图片粘贴和附件浏览。
- 外部编辑器集成。
- 第三方生态 Adapter 和插件市场。

## 10. 风险与控制

| 风险 | 影响 | 控制措施 |
| --- | --- | --- |
| inline scrollback 与 Overlay 冲突 | 历史覆盖、光标错位 | 先固定历史/活动区域协议，再做 Overlay |
| Windows 输入序列差异 | 快捷键失效、无法退出 | 真实 Windows 测试，不只依赖 mock |
| 流式事件没有稳定 ID | 重复消息和工具块 | 阶段 A/F 固定事件身份和幂等规则 |
| CLI 继续承担过多职责 | 修改一个面板影响整个界面 | 拆 RuntimeAdapter、ViewModel、Controller、Screen |
| 上游 TUI 升级破坏包装层 | 终端行为漂移 | 固定版本，只暴露 MingXu 自有接口 |
| 插件输出终端控制字符 | 标题、链接或剪贴板被操纵 | 所有外部文本在组件边界统一净化 |
| 文档提前宣称完成 | 用户预期与实际不符 | 只有发布门槛全部通过才更新状态 |

## 11. 完成定义

以下项目必须全部满足，roadmap 才能将“成品 CLI”标为已完成：

- [ ] `@mingxu/tui` 是唯一 TUI 实现，CLI 不再手写终端控制逻辑。
- [ ] Transcript 使用普通终端 scrollback，普通 delta 不清屏。
- [ ] 用户、assistant、工具、审批、状态和错误按稳定 ID 幂等投影。
- [ ] Editor 通过中文、emoji、IME、多行、历史、粘贴和 resize 测试。
- [ ] 命令菜单和全部产品面板使用统一 Overlay 栈。
- [ ] Approval 三种决定、会话复用和跨 principal 隔离通过。
- [ ] Extension Center、Context Inspector 和 Agent Tree 可浏览、可操作。
- [ ] 一个官方参考插件通过完整安装与治理闭环。
- [ ] 非 TTY、管道、stdout 重定向、resume 和 continue 契约稳定。
- [ ] Windows、Linux 和 macOS 的真实安装测试均通过。
- [ ] `typecheck`、`test`、`build`、`test:smoke`、`pack:dry-run` 和生产依赖审计通过。
- [ ] README、CHANGELOG、SECURITY 和 roadmap 与真实能力一致。

## 12. 发布口径

在完成定义全部通过之前，应使用以下表述：

> MingXu 已具备可运行的 Agent 核心、CLI 主链和 TUI 产品原型，正在完成终端渲染、输入、Overlay、真实扩展样例和跨平台发布验收。

全部通过以后，才可以使用：

> MingXu CLI 已达到可长期日常使用的本地 Agent 产品闭环，并具备稳定的扩展安装、治理和终端交互体验。


## 13. 阶段状态

- 阶段 A：已完成
- 阶段 B：已完成
- 阶段 C：已完成
- 阶段 D：已完成
- 阶段 E：已完成
- 阶段 F：已完成
- 阶段 G：已完成
- 阶段 H：已完成
- 阶段 I：已完成

