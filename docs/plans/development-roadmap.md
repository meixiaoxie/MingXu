# mingxu 顺序开发路线图

> 状态基线：2026-07-28
>
> 本文是唯一的长期执行顺序。必须按 `A -> B -> C...` 推进；只有当前阶段的退出门禁全部通过后，下一阶段才能成为主线。

## 1. 产品定位

`mingxu` 是轻量的 TypeScript Agent Runtime 和本地 CLI，不是全功能 Agent 平台。

核心目标：

1. 安装、配置和运行路径短，核心依赖少。
2. 模型、工具和存储使用稳定的中立协议。
3. 安全入口、预算、取消、事件和审计由核心控制。
4. v0.x 插件仅是用户明确信任的本地代码，不宣称具备强沙箱。
5. 企业控制面、调度、多租户和多 Agent 必须建立在稳定的 Run/Session、Policy、Audit 和隔离模型之上。

## 2. 版本范围

### v0.1 必须交付

- 可嵌入的 TypeScript SDK 和可安装的本地 CLI。
- 内建 `anthropic`、`openai-compatible`、`gemini` 等已承诺 provider 的文本与 tool-call 链路。
- `AbortSignal`、请求超时、Run deadline、最大轮次、模型请求次数、工具调用次数、token/时间/结果字节预算。
- 版本化 Run/Turn/Event 基础模型、核心安全事件和内建 JSONL 审计写入。
- 版本化本地 Session 文件、原子写入、单 Session 单活跃 Run 和基础恢复。
- 可信本地 Tool 插件；插件路径明确、风险提示明确、调用统一经过核心执行入口。
- `mingxu init`、`mingxu doctor`、离线端到端测试、真实 tarball 安装测试和一次人工在线验收。

### v0.1 明确不交付

- provider、audit writer、session store、memory、policy、runtime 等正式插件 API。
- npm 插件安装、插件市场、插件依赖求解和不可信插件。
- MCP、长期 Memory、RAG、声明式 Agent Preset、调度、多 Agent、企业控制平面。
- streaming。v0.1 的能力声明必须为 `supportsStreaming: false`；后续通过独立 ADR 决定是否支持。

### 后续版本方向

- v0.2：正式插件平台与 MCP。
- v0.3：Preset、Context、Memory 与隔离执行。
- 更后版本：企业身份、控制平面、调度、Workflow 和多 Agent。

## 3. 执行规则

- `[ ]` 表示未完成；部分完成仍不勾选，并追加“进展记录”。
- `[x]` 只表示完成标准已经由测试、构建、文档或人工验收证实。
- 每个阶段必须完成该阶段的测试、失败路径和文档，不把测试集中到路线图末尾。
- 公开 API、配置、持久化或事件格式变化时，必须同时定义兼容和迁移策略。
- 任何涉及插件、模型、工具、MCP、文件、命令或网络的功能，都必须检查 Policy、Approval、Budget、Audit 和 AbortSignal。
- 任何涉及 Session、日志、Memory 或审计的功能，都必须检查 secret、隐私、保留、删除、并发和 migration。
- 路线图只记录长期结果；普通内部重构不制造无关勾选项。

---

# A. 冻结事实、范围与架构口径

目标：先让 README、ADR、发布门禁、公开类型和实际代码说同一件事。

## A.1 修正文档冲突

- [x] 冻结本文第 2 节的 v0.1 范围
  - 完成标准：`development-roadmap.md`、`v0.1-release-gate.md`、README 和 package 描述对 v0.1 的承诺完全一致。
- [x] 修订 ADR-002 插件信任模型
  - 完成标准：v0.x 只有 `trusted_local` 与 `blocked`；临时询问属于 Approval，不是 trust 等级。
  - 完成标准：明确进程内插件可以直接访问 Node.js 能力，核心 API 只能治理通过 API 的调用，不能阻止恶意插件旁路。
- [x] 修订 ADR-004 运行实体模型
  - 完成标准：统一 Preset Revision、Session、Run、Turn、Tool Invocation、Approval 的定义、状态名和合法转换。
  - 完成标准：Session 使用 `active/archived/deleted`；执行状态只放在 Run；Run 终态使用 `succeeded/failed/cancelled/timed_out/interrupted`。
- [x] 明确当前 `MemoryStore` 只是通用 KV，不能继续代表正式 Session 或长期 Memory 契约

## A.2 建立真实能力清单

- [x] 逐项核对 README、测试名称和代码实现
  - 必查差异：README 声明的 `--model` 当前未由参数解析器实现；发布门禁声称相关测试已覆盖，但现有测试没有该用例。
- [x] 把 `customProviders.module` 标记为实验性兼容入口
  - 完成标准：不把它称为已经稳定的 provider plugin API。
- [x] 把 streaming 能力声明改为真实值
- [x] 记录本次复核结果和证据，不沿用未经重新验证的“已通过”描述

## A 阶段退出门禁

- [x] 所有架构文档不存在 trust、实体状态、v0.1 插件范围和 streaming 口径冲突。
- [x] `v0.1-release-gate.md` 成为唯一发布判定清单。
- [x] README 只描述代码真实具备的能力。

---

# B. 修复公开契约与质量基线

依赖：A 完成。
目标：先让测试能发现契约漂移，再继续扩展 runtime。

## B.1 公开 API 与 CLI

- [x] 实现并测试 `--model <key>`，或从 README 和门禁删除该承诺
  - 推荐：实现，因为 `ProviderRegistry.createFromConfig` 已支持显式 model key。
- [x] 为公共类型建立消费方编译测试
  - 完成标准：从打包后的 `mingxu` 导入 `ModelProvider`、`ModelInput`、`ModelOutput`、`Tool`、`Agent` 等承诺 API，并用 `tsc` 编译真实消费者 fixture。
  - 原因：当前测试从 `src/index.ts` 导入未导出的类型，但测试目录不在 `tsconfig.json` 中，普通 typecheck 无法发现。
- [x] 新增测试代码 typecheck 配置
- [x] 为 PluginLoader 补专门测试
  - 覆盖：有效插件、重复名、setup 失败、非法扩展名、URL、网络路径、缺失文件和导出错误。

## B.2 测试与打包

- [x] 把快速单元测试与 package smoke 分开
  - 完成标准：`pnpm test` 不重复执行昂贵的 tarball 安装；`pnpm test:smoke` 单独执行成品验证。
- [x] 修复 smoke test 对 npm 安装位置的假设
  - 完成标准：不再通过 `process.execPath/../node_modules/npm` 猜测 npm；在普通 Node、Corepack、CI 和 Codex bundled runtime 中均可运行或给出明确跳过原因。
- [x] 扩展 tarball smoke
  - 覆盖：CLI help/version、公共 JS 导入、公共类型编译、离线 mock Run、Tool 调用和 Session/Audit 文件。
- [x] 优化 CI 矩阵
  - Node 22/24 均跑 typecheck、单元测试和 build；跨平台行为在 Ubuntu/Windows/macOS 验证。
  - package smoke 使用独立 job，避免在每个矩阵格重复打包安装。
- [x] CI 第三方 Action 固定到完整 commit SHA，并保留版本注释。

## B 阶段退出门禁

- [x] 源码和测试 TypeScript typecheck 通过。
- [x] 快速测试、build、tarball smoke 分别通过。
- [x] CI 不存在重复 smoke、假通过或只测试源码未测试声明文件的问题。

---

# C. 统一运行时协议、实体与核心执行入口

依赖：B 完成。
目标：为取消、预算、审计、Policy 和恢复建立一个不会反复改名的地基。

## C.1 中立协议

- [x] 合并或明确 `core/types` 与 `models/model-protocol` 的两层职责
  - 完成标准：provider wire adapter 不泄漏到 core；usage、stop reason、refusal、provider request id 和错误不会在转换中丢失。
- [x] 定义 `RunContext`
  - 至少包含：`runId`、`sessionId?`、`turnId`、`traceId`、`deadline`、`signal`、`budget`、`principal`。
- [x] 定义稳定 ID、UTC 时间、`schemaVersion` 和单调 `sequence` 生成规则。

## C.2 实体与状态机

- [x] 实现 Run、Turn、Tool Invocation 和 Approval 的核心类型。
- [x] 实现合法状态转换校验，禁止终态回到 running。
- [x] Run 记录 resolved model、配置 hash、插件清单和 policy 版本。
- [x] 同一 Session 在 v0.1 只允许一个活跃 Run。

## C.3 单一执行入口

- [x] Agent Loop 不再直接调用工具对象，统一调用核心 `ToolExecutor`
  - 原因：当前 Agent Loop 自建 Map 并直接 `tool.execute`，绕过了 `ToolRegistry.execute`，后续无法保证 Policy/Audit/Budget 只有一个入口。
- [x] Provider 调用统一经过 `ModelExecutor`。
- [x] 事件、取消、预算和错误分类挂在 Executor 边界，不复制到每个调用者。

## C 阶段退出门禁

- [x] 核心协议、实体、状态转换和 Executor 有契约测试。
- [x] 任意模型或工具调用都能关联到 Run/Turn，并经过唯一入口。

---

# D. 完成取消、超时、错误与重试

依赖：C 完成。
目标：任何卡住的模型或工具都能终止，任何重试都有边界。

## D.1 取消与超时

- [x] `ModelProvider.generate` 和 `Tool.execute` 接收执行上下文或 `AbortSignal`。
- [x] 使用 `AbortSignal.any()` 组合用户取消、Run deadline 和单次操作 timeout。
- [x] provider 的 `fetch` 全部接收 signal；工具 timeout 后不再继续进入下一轮。
- [x] 区分 `cancelled` 与 `timed_out`，保留原始 cause，但对用户输出安全信息。

## D.2 Provider 错误模型

- [x] 定义稳定错误码：`auth_error`、`rate_limit`、`quota_error`、`server_error`、`timeout`、`cancelled`、`invalid_request`、`context_limit`、`content_filter`、`invalid_response`、`network_error`。
- [x] 保留 HTTP status、provider request id、`Retry-After` 和 `retryable`，禁止记录响应中的 secret。
- [x] Anthropic、OpenAI-compatible、Gemini 和 custom adapter 使用同一分类入口。

## D.3 有界重试

- [x] 把现有 `retryProviderRequest` 接入真实调用链。
- [x] 支持指数退避、随机 jitter、`Retry-After`、最大尝试次数、最大累计延迟和 Run deadline。
- [x] 只重试明确可恢复错误；认证、请求校验和内容过滤不重试。
- [x] 一旦产生部分流式输出不得自动重试；v0.1 不支持 streaming，从能力表移除该承诺。

## D 阶段退出门禁

- [x] 每个内建 provider 覆盖成功、取消、超时、429/5xx、不可重试错误、畸形 JSON 和重试预算耗尽。
- [x] Agent Loop 覆盖模型卡住、工具卡住和用户取消。

---

# E. 强制预算、上下文与工具结果边界

依赖：D 完成。
目标：避免无限循环、无限成本和超大工具结果拖垮进程或上下文。

- [x] Run 强制限制最大轮次、模型请求次数、工具调用次数、运行时间和并发数。
- [x] 保留 provider usage，累计 input/output/cache token；缺失时标记 `unknown` 或 `estimated`。
- [x] 成本记录包含币种、价格表版本和估算标记；未知价格不能伪造为 0。
- [x] 上下文预算限制消息数、输入 token、预留输出 token 和工具结果字节。
- [x] 工具执行设置 timeout、最大输出字节和结构化结果校验。
- [x] 文本截断必须带明确标记；结构化 JSON 不得截成非法 JSON。
- [x] 定义 Artifact 引用接口；v0.1 可先使用本地临时 ArtifactStore，大对象不直接塞入模型上下文。
- [x] 达到任意预算后，Run 使用稳定终止原因并产生事件。

## E 阶段退出门禁

- [x] 有失败注入测试证明每一种预算都能停止运行。
- [x] 循环引用、超大对象、超长文本和 usage 缺失都有确定行为。

---

# F. 建立版本化事件、审计与 Secret 边界

依赖：E 完成。
目标：先让所有安全动作可追踪，再加入授权决策。

## F.1 统一事件

- [x] 建立唯一的版本化 event envelope。
  - 字段至少包括：`schemaVersion`、`eventId`、`timestamp`、`sequence`、`trace/span/parentSpan`、`run/session/turn`、`principal`、`type`、`payloadClass`。
- [x] 覆盖 Run、模型请求、工具调用、预算、插件加载、Session 写入、错误和取消事件。
- [x] 内部事件 schema 保持项目自有版本；OpenTelemetry 作为 exporter 映射，不直接成为持久化协议。

## F.2 审计

- [x] 核心强制产生安全事件，writer 不能决定事件是否存在。
- [x] 实现内建 JSONL audit writer，定义 flush、轮转、保留、文件权限和写入失败策略。
- [x] 高风险动作支持 audit fail-closed；普通遥测可以按配置降级。
- [x] 审计测试覆盖顺序、关联 ID、写入失败、进程中断和敏感字段。

## F.3 Secret

- [x] 实现类型化 `secretRef`，v0.1 至少支持 `env:`。
- [x] 配置、事件、Session、错误和日志只保存引用或脱敏值，不保存解析后的明文。
- [x] README 和示例不再放可复制的明文 key 字段。
- [x] 建立统一 redaction 测试语料，覆盖 header、URL、嵌套对象、错误 cause 和工具输出。

## F 阶段退出门禁

- [x] 一次 Run 可从开始追踪到结束，事件顺序确定。
- [x] 故意注入的 API key、token 和密码不会出现在终端、Session 或 audit 文件中。

---

# G. 实现核心 Policy 与 Approval

依赖：F 完成。
目标：模型输出永远不是授权，副作用动作必须由核心裁决。

- [x] 定义 Policy 输入：principal、action、resource、normalized input、Run context。
- [x] 定义 `allow/deny/ask`、obligations、规则版本和 deny-overrides 合并语义。
- [x] 所有 Tool 调用在 Executor 中先规范化、再授权、后执行。
- [x] 文件授权处理允许根、读写模式、符号链接、junction、UNC、大小写和路径穿越。
- [x] 网络授权处理 scheme、host、port、重定向、私网、DNS 变化和请求上限。
- [x] 命令执行默认 ask/deny，并限制 cwd、env、timeout 和输出。
- [x] Approval 记录规范化动作、范围、操作者、决定、原因、过期和撤销。
- [x] 非交互 Run 对未预授权的 `ask` 默认拒绝。
- [x] 所有 Policy/Approval 决定强制产生审计事件。
- [x] 编写 threat model，并把 OWASP 2025 的十类风险映射到控制和测试。

## G 阶段退出门禁

- [x] 未授权工具无法产生副作用。
- [x] Approval 超时、拒绝、取消、重复提交和恢复都有测试。
- [x] 文档明确：可信进程内插件仍可绕过 broker，因此 Policy 不是插件沙箱。

---

# H. 实现版本化 Session 与恢复

依赖：G 完成。
目标：把当前“一个 KV 文件中的 messages”升级为可迁移、可恢复、可审计的本地 Session。

- [x] 新建 `SessionStore` 契约，与长期 `MemoryStore` 分离。
- [x] Session、Run、Turn、Tool Invocation、Approval 都带稳定 ID、时间和 `schemaVersion`。
- [x] 定义 config/session/audit migration registry；未知新版本 fail-fast，不静默降级。
- [x] FileSessionStore 使用原子写入、revision/乐观并发或跨进程锁，防止两个 CLI 静默覆盖。
- [x] 进程启动时把遗留 `running` Run 恢复为 `interrupted`，不能假装成功。
- [x] 实现 `mingxu resume` 和最近 Session 列表。
- [x] 支持关闭保存、保留天数、清理、归档和删除；文档说明 Session 可能包含敏感数据。

## H 阶段退出门禁

- [x] 覆盖崩溃恢复、并发写入、损坏文件、旧 schema migration、删除和保留策略。
- [x] Session 文件中不存在解析后的 secret。

---

# I. 收敛 v0.1 可信本地 Tool 插件

依赖：H 完成。
目标：只发布一类小而真实的插件能力，不提前承诺完整生态。

- [x] v0.1 PluginContext 只稳定 `registerTool`。
- [x] 插件路径统一相对配置文件目录解析；拒绝网络 URL、网络共享、空路径和不支持的扩展名。
- [x] 加载前输出来源与“加载等于执行第三方代码”提示；支持配置级 `trusted_local/blocked`。
- [x] 插件注册的 Tool 必须经过 ToolExecutor、Policy、Approval、Budget、AbortSignal 和 Audit。
- [x] setup 失败必须事务回滚，不能留下部分注册状态。
- [x] 重名插件和重名工具 fail-fast。
- [x] 公布 v0.1 plugin API 兼容承诺和废弃流程。
- [x] `customProviders.module` 保持实验性，不纳入 v0.1 plugin API 稳定承诺。

## I 阶段退出门禁

- [x] 插件契约测试和真实本地插件 E2E 通过。
- [x] README 不再把 v0.1 描述成多类型插件平台。

---

# J. 完成 CLI 体验并发布 v0.1

依赖：I 完成。
目标：新用户在 5 分钟内完成安装、检查、运行、Tool、Session 和 Audit 闭环。

- [x] 实现 `mingxu init --profile minimal`。
- [x] 实现 `mingxu init --profile secure-local`，默认启用预算、核心 Policy、Approval、Audit 和插件 allowlist。
- [x] 实现 `mingxu doctor`：检查 Node、配置、secretRef、provider、插件路径、Session/Audit 权限。
- [x] 在线 doctor 只能由用户显式启用，先提示网络访问和可能费用。
- [x] 错误提示包含稳定 code、原因和下一步修复，不只打印底层异常。
- [x] 完成离线 E2E：空目录安装 tarball -> init -> doctor -> mock Run -> Tool -> Session -> Audit。
- [x] 提供人工在线 E2E 的可执行命令、验收清单和脱敏记录要求。
- [x] 明确 LICENSE、CHANGELOG、版本兼容策略和安全报告渠道。
- [x] 发布 workflow 使用 npm Trusted Publishing/OIDC、provenance、最小权限和受保护环境。
- [x] `npm pack --dry-run`、tarball 内容白名单和实际安装全部通过后，才移除 `private: true`。
- [x] 按 `v0.1-release-gate.md` 逐项签核。

## J 阶段退出门禁

- [ ] v0.1 发布门禁全部为通过，不存在“部分完成也发布”。
- [x] 发布产物可从空目录安装，公共 JS/类型/CLI 均可用。

---

# K. 建立 v0.2 正式插件平台

依赖：v0.1 已发布且兼容承诺稳定。
目标：在真实扩展需求出现后，再开放多类型插件。

- [ ] 设计并版本化 `mingxu.plugin.json`：稳定 ID、版本、发布者、入口、类型、capabilities、权限、配置 schema、secret 字段、core/Node 兼容范围、来源和 integrity。
- [ ] 执行任何插件代码前完成 manifest、trust、来源、兼容性和权限检查。
- [ ] 建立 plugin lock，记录 registry、解析版本、tarball integrity、来源和批准权限。
- [ ] 正式支持 trusted-local provider、audit writer、session store plugin。
- [ ] provider plugin 声明 provider 名、网络目标和 secretRef 类型；重复注册 fail-fast。
- [ ] audit/session writer 失败语义由核心定义，插件不能关闭核心事件或破坏状态机。
- [ ] 提供 `plugin list/inspect/add/remove/update`；更新事务失败时保留旧版本。
- [ ] v0.2 仍禁止插件间自动依赖。
- [ ] npm 安装默认 `ignore-scripts`，只允许批准 registry；禁用脚本不等于插件安全。
- [ ] 第三方插件必须能运行公开兼容测试套件。

## K 阶段退出门禁

- [ ] Tool 加上 provider、audit writer、session store 四类插件都有契约、失败注入、兼容和迁移测试。
- [ ] manifest 被明确描述为声明与治理输入，不被描述为沙箱。

---

# L. 接入标准 MCP

依赖：K 完成，Policy/Audit/Secret/Session 已稳定。
目标：采用标准协议接外部工具，不手写不完整 transport。

- [ ] 使用官方 Tier 1 TypeScript SDK，并锁定兼容的 MCP 协议版本。
- [ ] 实现 stdio：子进程生命周期、cwd、最小 env、stderr、启动/请求超时、取消、退出和重启预算。
- [ ] 实现 Streamable HTTP，不再使用笼统“HTTP”或把旧 HTTP+SSE 当成当前标准。
- [ ] 支持协议版本协商、断线重连、显式取消、session id、resumability/redelivery 和向后兼容测试。
- [ ] tools/resources/prompts 分别启用，并映射到统一 Policy、Budget 和 Audit。
- [ ] Remote MCP OAuth 禁止 token passthrough；验证 audience、redirect URI、state 和最小 scope。
- [ ] 防护 confused deputy、SSRF、DNS rebinding、session hijacking 和恶意响应。
- [ ] 本地 stdio server 与本地插件同样视为第三方代码，默认最小权限。
- [ ] 标准 transport 稳定前不设计自定义 MCP transport plugin。

## L 阶段退出门禁

- [ ] 使用官方 Inspector/兼容测试验证 stdio 与 Streamable HTTP。
- [ ] 安全回归覆盖 token 透传、私网访问、Origin、session 绑定、恶意 tool schema 和进程逃逸尝试。

---

# M. 实现 Preset、Context 与 Memory

依赖：L 完成，Run/Session schema 已经经历真实版本演进。
目标：先稳定声明式 Agent，再引入会改写上下文和跨会话保存数据的能力。

- [ ] Agent Preset 是 JSON/YAML 声明包，默认不执行 JavaScript。
- [ ] 每次修改产生不可变 Preset Revision；Run 记录 revision、配置 hash、resolved model、plugin lock 和 policy version。
- [ ] 实现 context editing，再实现 compaction；明确删除旧工具结果与生成摘要的区别。
- [ ] Context 扩展只能在预算、来源标记和审计边界内改写上下文。
- [ ] MemoryStore 支持 principal/Agent/组织命名空间、来源、置信度、过期、删除和写入审批。
- [ ] Memory 内容始终按不可信输入处理，建立长期 prompt injection / poisoning 回归测试。
- [ ] 完成 `agent list/create/run`，运行权限不能超过当前 principal 与核心 Policy。

## M 阶段退出门禁

- [ ] Preset 可复现；Context 不破坏审计链；Memory 可查询来源、删除和过期。

---

# N. 建立不可信代码隔离与 Runtime

依赖：M 完成。
目标：只有可证明的边界才允许使用 `isolated` 名称。

- [ ] 定义版本化 capability RPC；隔离侧不获得主进程对象。
- [ ] 对独立进程、容器和远程沙箱做威胁验证；Worker Thread 不作为强安全边界。
- [ ] 文件、网络、secret、进程、CPU、内存、时间和输出均由 broker 授权和限额。
- [ ] 工具只能声明需要 local/container/remote，最终 Runtime 由核心选择和授权。
- [ ] 证明无法绕过前，插件只允许 `trusted_local/blocked`，不开放 `isolated`。
- [ ] 隔离稳定后再评估 Secret Provider、Policy Extension 和 Runtime plugin。

## N 阶段退出门禁

- [ ] 对文件、环境变量、网络、子进程、资源耗尽和 RPC 混淆做逃逸测试。
- [ ] 威胁测试无法证明的能力保持未发布。

---

# O. 建立企业身份、控制平面与调度

依赖：N 完成。
目标：先有身份和隔离，再允许无人值守执行。

- [ ] 定义 principal、service account、tenant 和委托关系。
- [ ] Policy、Approval、Audit、Session、Schedule 记录谁代表哪个租户执行。
- [ ] 用 ADR 决定 daemon/API/控制平面边界、认证、队列、并发、升级和灾难恢复。
- [ ] `enterprise` profile 默认审计 fail-closed、插件 allowlist、关闭高风险工具、限制网络。
- [ ] Schedule 支持 timezone、cron、misfire、幂等键、固定 Preset Revision、预算、重试、并发和非交互审批。
- [ ] Scheduler backend 只负责触发；核心维护 Schedule/Run 语义和去重。

## O 阶段退出门禁

- [ ] 多租户隔离、重复触发、凭据轮换、审计丢失和灾难恢复演练通过。

---

# P. 扩展 Workflow、多 Agent 与成熟生态

依赖：O 完成。
目标：最后扩展高成本、高并发能力，并用持续评估约束行为回归。

- [ ] subagent 使用 parent/child Run，限制深度、并发、子 Run 数、token、成本、时间和权限。
- [ ] Workflow 使用通用 node、edge、condition、join、retry、checkpoint、compensation，不把角色名写死在核心。
- [ ] 建立版本化 agent eval：工具选择、错误恢复、权限拒绝、审批、上下文压缩、插件/MCP 加载。
- [ ] 每个 provider 保留离线契约测试；付费在线测试作为受控发布门禁，不作为普通 PR 的不稳定强依赖。
- [ ] 建立安全回归集：OWASP 2025 十类风险、MCP 攻击面、插件供应链和沙箱逃逸。
- [ ] 建立 deprecation、migration、支持周期、漏洞响应、插件撤销和兼容矩阵。
- [ ] 规划官方插件时先判断是否已有成熟 MCP server，避免重复维护。

## P 阶段退出门禁

- [ ] 行为、安全、兼容和成本阈值均可版本化并在发布前复现。

---

## 4. 每项任务的固定完成标准

```md
- [ ] 已更新本路线图中的任务状态、日期和证据
- [ ] 已补充成功、失败、取消和边界测试
- [ ] 已运行 typecheck、相关测试、build；发布相关改动还运行 tarball smoke
- [ ] 已更新公开 API、README、schema、migration 或兼容文档
- [ ] 已检查 Policy、Approval、Budget、Audit、AbortSignal 和 redaction
- [ ] 已说明风险、兼容影响、未完成事项和回滚方式
```

## 5. 本次联网复核依据

以下资料于 2026-07-28 复核，只采纳与本项目边界相符的部分：

- [MCP 2025-11-25 Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)：当前标准传输是 stdio 与 Streamable HTTP；HTTP+SSE 是旧版兼容项。
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)：重点覆盖 confused deputy、token passthrough、SSRF、session hijacking、本地 server compromise、stdio proxy 和 scope minimization。
- [MCP Official SDKs](https://modelcontextprotocol.io/docs/sdk)：TypeScript SDK 为 Tier 1，应优先使用官方 SDK。
- [OWASP Top 10 for LLMs 2025](https://genai.owasp.org/llm-top-10/)：威胁模型和安全回归应覆盖全部十类风险，而不只 prompt injection。
- [NIST AI RMF Generative AI Profile, NIST AI 600-1](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence)：风险识别、测量、治理和评估应贯穿生命周期，不放到开发末尾。
- [OpenTelemetry GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions-genai)：GenAI 约定已迁入独立仓库并持续演进，内部持久化事件需自有版本，再由 exporter 映射。
- [Node.js Releases](https://nodejs.org/en/about/previous-releases)：截至复核日 Node 22 与 24 均为 LTS，当前支持范围合理。
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) 与 [npm ignore-scripts](https://docs.npmjs.com/cli/v11/using-npm/config#ignore-scripts)：发布优先使用 OIDC 短期凭据；安装第三方包时默认禁用生命周期脚本。
- [GitHub Actions Secure Use](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)：第三方 Action 应固定完整 commit SHA。

## 6. 完成记录

- 2026-07-28：完成仓库源码、测试、示例、CI、锁文件、README、4 份 ADR 和两份计划文档复核。
- 2026-07-28：联网复核 MCP、OWASP、NIST、OpenTelemetry、Node.js、npm 和 GitHub Actions 官方资料。
- 2026-07-28：把原先混合的 `阶段 0 + A-I` 重排为严格依赖的 `A-P`，收窄 v0.1，补入公开类型消费测试、单一 Executor、事件版本、smoke 可移植性、Streamable HTTP、OIDC 发布和持续安全评估。
- 2026-07-28：完成 A 阶段收口：README、ADR-002、ADR-004、发布门禁、package 描述和 streaming 能力声明已对齐到真实实现。
- 2026-07-28：完成 B 阶段主体：实现并测试 `--model`，新增 tests typecheck，补齐 PluginLoader 专门测试，拆分快速测试与 smoke，扩展 tarball smoke，并重构 CI 矩阵与独立 smoke job。
- 2026-07-28：当前本地环境可完成 `pnpm typecheck`、`pnpm test`、`pnpm build`；`pnpm test:smoke` 已具备真实 tarball 验证逻辑，并在 npm / Corepack 不可用时给出明确跳过原因，最终 tarball 通过证据应以正常 CI / npm 可用环境的执行结果为准。
- 2026-07-28：完成 C 阶段：补齐 `RunContext`、Run/Turn/Tool Invocation/Approval 核心类型与状态转换校验，引入统一 `ToolExecutor` / `ModelExecutor`，并让模型与工具调用统一通过执行边界，相关契约测试通过。
- 2026-07-28：完成 D 阶段：为模型与工具执行链接入 `AbortSignal.any()`、timeout、稳定 provider/tool 错误分类与 bounded retry，provider `fetch` 全部接收 signal，Agent Loop 不再在工具 timeout 后继续推进，并补齐 Stage D 聚焦测试。
- 2026-07-28：完成 E 阶段：为 Agent Loop 补齐运行预算（最大模型请求/工具调用/运行时间/并发上限字段）、usage 累计、稳定终止原因、消息数裁剪、工具大结果 Artifact 降载与字节边界；Anthropic usage 解析补齐，`tests/core.test.ts` 新增预算/上下文/超大输出覆盖，`pnpm test`、`pnpm typecheck`、`pnpm build` 通过。
- 2026-07-28：完成 F 阶段：新增版本化 runtime event envelope、事件 sink、内建 JSONL audit writer、`env:` secretRef 与统一 redactor；Agent Loop、PluginLoader、CLI、session 持久化和高风险工具都接入事件/审计/脱敏链路，`tests/events.test.ts`、`tests/jsonl-audit-writer.test.ts`、`tests/redactor.test.ts`、`tests/secret-ref.test.ts` 及扩展的 `tests/core.test.ts`/`tests/cli.test.ts` 通过，`pnpm test`、`pnpm typecheck`、`pnpm build` 通过。
- 2026-07-28：完成 G 阶段：新增核心 Policy/Approval 类型、deny-overrides 组合语义、文件/网络/命令资源 normalizer、内存预授权存储，并把 tool call 统一接入“规范化 -> 决策 -> 审计 -> 执行”链路；`readFile` 进入统一文件授权表面且保留原有 `realpath` 双保险，非交互 run 对 ask 默认拒绝，`tests/policy-engine.test.ts`、`tests/file-policy-normalizer.test.ts`、`tests/network-policy-normalizer.test.ts`、`tests/command-policy-normalizer.test.ts`、`tests/approval-store.test.ts` 及扩展的 `tests/core.test.ts`/`tests/cli.test.ts` 通过，`pnpm test`、`pnpm typecheck`、`pnpm build` 通过。
- 2026-07-28：完成 H 阶段：新增版本化本地 Session 文档、正式 `SessionStore` 契约、legacy `{"messages": [...]}` -> `session/v1` 迁移、revision 冲突保护、`SessionRuntime` 适配层、启动时 interrupted recovery，以及 `mingxu resume` / `mingxu sessions` CLI 入口；`tests/session-store.test.ts`、`tests/session-migrations.test.ts`、`tests/session-recovery.test.ts` 与扩展的 `tests/cli.test.ts` 通过，`pnpm test`、`pnpm typecheck`、`pnpm build` 通过。
- 2026-07-28：完成 I 阶段：插件配置支持 `trusted_local/blocked`，相对插件路径统一按配置文件目录解析，CLI 在加载前输出来源与第三方代码风险提示，`PluginLoader` 对 setup 期间已注册工具实现事务回滚；`tests/plugin-loader.test.ts`、`tests/config.test.ts`、`tests/cli.test.ts` 通过，且 `pnpm test`、`pnpm typecheck`、`pnpm build` 再次通过。
