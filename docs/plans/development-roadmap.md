# mingxu 后续发展计划

> 这份文档用来长期管理 `mingxu` 的发展任务。  
> 每完成一项，AI 或开发者都要把 `[ ]` 改成 `[x]`，并在“完成记录”里写一句说明。

## 0. 怎么使用这份计划

- `[ ]` 表示还没完成。
- `[x]` 表示已经完成。
- 每做完一个任务，都要立刻勾选，避免后面忘记。
- 如果任务被拆小，可以在原任务下面继续加子任务。
- 如果发现任务不合适，不要直接删除，先改成“已取消”，并写明原因。
- 每次改完代码后，都要更新本文件的对应勾选状态和“完成记录”。

示例：

```md
- [x] 新增 mingxu init 命令
  - 完成记录：2026-07-28，已支持生成最小配置文件，并补充测试。
```

---

## 1. 项目目标

`mingxu` 的目标不是做一个又大又重的全功能 Agent，而是做一个：

1. **轻量**：安装简单，依赖少，核心代码清楚。
2. **插件化**：用户可以通过插件给 Agent 增加专属能力。
3. **可企业使用**：企业可以管权限、看审计、接内部模型和内部系统。
4. **适合初学者理解**：代码结构和文档要清楚，核心逻辑有通俗注释。

可以把 `mingxu` 理解成“Agent 的发动机和底盘”。核心包不要装太多东西，用户需要什么能力，就像装积木一样安装插件。

---

## 2. 本次重新审视后发现的逻辑问题

原计划方向是对的，但顺序上有几个问题：

1. **先讲插件，后讲安全，顺序不对。**  
   插件是第三方代码，后期还可能接模型、文件、网络、企业系统。应该先定义 trust boundary（信任边界，也就是“哪些代码可以碰哪些东西”），再设计插件能力。

2. **缺少 MCP 优先级判断。**  
   MCP 是 Model Context Protocol，可以理解成“Agent 连接外部工具的一种标准插座”。很多外部系统不一定要写成 mingxu 专属插件，可能应该优先用 MCP 接入。

3. **缺少 Agent / Session / Preset 的版本管理。**  
   后期如果用户创建“专属 agent”，不能每次运行都临时拼一个配置。应该有可复用、可版本化的 agent preset。

4. **缺少运行环境与沙箱规划。**  
   企业不只关心 Agent Loop，还关心工具在哪里执行、能不能访问网络、能不能读写文件、有没有隔离。

5. **缺少观测标准。**  
   原计划有 audit，但没有把 metrics、traces、token usage、cost、latency 这些放到统一 observability（可观测性）里。

6. **缺少质量评估体系。**  
   只跑测试不够。Agent 产品还需要 evals（评测集）、rubric（评分标准）、回归样例和插件兼容测试。

7. **缺少上下文和成本管理。**  
   Agent 跑久了会遇到上下文变长、缓存失效、工具结果过大、token 成本不可控等问题。

8. **缺少供应链安全。**  
   插件和 provider 插件后期可能来自 npm 或企业内部仓库，需要版本锁定、签名、allowlist、安装前检查。

所以新版路线图调整为：

> **先定边界 → 修 runtime 地基 → 建安全与观测 → 再做插件 → 再做体验 → 最后扩展企业能力和生态。**

---

## 3. 总体架构原则

### 3.1 核心与插件边界

核心只做这些事：

- Agent Loop 主循环
- 统一消息协议
- Tool Registry 工具注册表
- Provider Registry 模型供应商注册表
- Plugin Loader 插件加载器
- Policy 检查入口
- Audit / Event 事件入口
- AbortSignal 取消机制
- 基础配置加载
- 基础 session 接口

插件负责这些事：

- 具体工具
- 具体 provider
- 具体权限规则
- 具体审计写入器
- 具体上下文压缩策略
- 具体 memory 存储
- 具体 agent preset
- 具体 MCP server 适配或安装说明

核心原则：

> **核心只提供扩展点和安全兜底，具体能力尽量交给插件。插件可以扩展能力，但不能绕过核心安全。**

### 3.2 MCP 与插件的关系

MCP 可以理解成“标准外接插座”。插件可以理解成“mingxu 自己的扩展包”。

推荐优先级：

1. 如果外部系统已经有成熟 MCP server，优先接 MCP。
2. 如果能力是 mingxu 内部运行时能力，比如 provider、policy、audit、context compaction，再做 mingxu plugin。
3. 如果外部系统没有 MCP，而且需要本地工具逻辑，再做 tool plugin。

### 3.3 Provider 插件化原则

Provider 适合作为插件，但不要全部插件化。

建议内置 provider：

- `anthropic`
- `openai-compatible`
- `gemini`
- `custom`

建议插件化 provider：

- Azure
- Bedrock
- Ollama
- OpenRouter
- 企业内部模型网关
- 地区性模型平台
- 依赖较重或更新频繁的 provider

原因：provider 插件会接触用户输入、系统提示词、工具结果，权限高于普通 tool 插件，所以必须配合 manifest、network 权限、env 权限、allowlist 和 audit。

---

# 阶段 A：架构决策与边界文档

目标：先把“哪些放核心、哪些做插件、哪些走 MCP、哪些必须受管控”讲清楚。否则后面越做越乱。

## A.1 核心边界文档

- [ ] 新增核心边界文档
  - 建议文件：`docs/architecture/core-boundaries.md`
  - 完成标准：明确 core、models、tools、plugins、memory、config、cli 的职责。
  - 完成记录：

- [ ] 新增核心能力与插件能力对照表
  - 完成标准：说明哪些能力必须放核心，哪些能力只能通过插件扩展。
  - 完成记录：

- [ ] 明确插件不能绕过的安全机制
  - 完成标准：插件不能绕过 policy、audit、AbortSignal、上下文限制、secret 脱敏。
  - 完成记录：

## A.2 MCP 与插件策略

- [ ] 新增 MCP 与插件选择指南
  - 建议文件：`docs/architecture/mcp-vs-plugin.md`
  - 完成标准：用户知道什么时候写 MCP server，什么时候写 mingxu plugin。
  - 完成记录：

- [ ] 设计 MCP connector 配置结构
  - 完成标准：配置能声明 MCP server 名称、URL、工具启用策略、凭据来源。
  - 完成记录：

- [ ] 设计 MCP 工具权限接入 policy 的方式
  - 完成标准：MCP 工具调用和本地工具调用都走同一套授权入口。
  - 完成记录：

## A.3 Agent Preset 与 Session 模型

- [ ] 设计 Agent Preset 概念
  - 说明：Agent Preset 是“专属 agent 模板”，包括模型、系统提示词、插件、工具、权限和默认参数。
  - 完成标准：文档说明 preset 不是每次运行临时创建，而是可复用配置。
  - 完成记录：

- [ ] 设计 Agent Preset 版本策略
  - 完成标准：preset 修改后能记录版本，session 能知道自己用的是哪个版本。
  - 完成记录：

- [ ] 设计 Session 生命周期
  - 建议状态：`created`、`running`、`waiting_for_approval`、`idle`、`failed`、`completed`、`archived`
  - 完成标准：文档说明每种状态什么时候出现，哪些状态允许继续输入。
  - 完成记录：

---

# 阶段 B：修 runtime 地基，保证轻而稳

目标：先让当前 runtime 更稳定、更可信，不急着堆功能。

## B.1 Provider 请求稳定性

- [ ] 给所有内建 provider 增加统一 timeout 超时控制
  - 涉及文件：`src/models/anthropic-provider.ts`、`src/models/openai-compatible-provider.ts`、`src/models/gemini-provider.ts`、`src/models/custom-provider.ts`
  - 完成标准：模型请求不会无限等待，超时后返回清楚错误。
  - 完成记录：

- [ ] 接入统一 retry 重试策略
  - 涉及文件：`src/models/provider-retry.ts` 和各 provider 文件
  - 完成标准：429、5xx、临时网络错误可以按配置重试。
  - 完成记录：

- [ ] 统一 provider 错误分类
  - 建议分类：`auth_error`、`rate_limit`、`server_error`、`timeout`、`invalid_request`、`network_error`
  - 完成标准：CLI 和上层调用者能根据错误类型决定是否重试或提示用户修配置。
  - 完成记录：

- [ ] 为 provider timeout/retry/error 补测试
  - 涉及文件：`tests/*provider*.test.ts`
  - 完成标准：测试覆盖成功请求、超时、可重试错误、不可重试错误。
  - 完成记录：

## B.2 模型能力声明真实化

- [ ] 检查并修正 model capability 声明
  - 涉及文件：`src/models/model-capabilities.ts`
  - 完成标准：没有实现的能力不要声明支持，比如 streaming。
  - 完成记录：

- [ ] 建立 provider capability matrix
  - 说明：capability matrix 是“模型能力表”，记录每个 provider 是否支持 tools、streaming、structured output、vision、effort、prompt caching。
  - 完成标准：README 或 docs 中有清楚表格。
  - 完成记录：

- [ ] 如果决定支持 streaming，补完整 runtime 调用链
  - 涉及文件：`src/models/model-protocol.ts`、`src/models/request-builder.ts`、`src/core/agent-loop.ts`
  - 完成标准：不是只在类型里写 `stream`，而是真能被运行时使用。
  - 完成记录：

## B.3 Agent Loop 增强

当前 Agent Loop 已经能跑通最小 agent：接收用户输入、调用模型、执行工具、继续下一轮。但如果后期要支持插件化专属 Agent 和企业使用，还需要补权限、审计、取消、上下文管理等能力。

- [ ] 增加 Agent Loop 事件机制
  - 说明：事件机制可以理解成“运行过程广播”。模型调用开始、模型调用结束、工具调用开始、工具调用结束、出错等关键节点都发出事件。
  - 涉及文件：`src/core/agent-loop.ts`、`src/core/types.ts`
  - 完成标准：至少支持 `loop_start`、`model_request_start`、`model_request_end`、`tool_call_start`、`tool_call_end`、`tool_call_error`、`loop_end`、`loop_error`。
  - 完成记录：

- [ ] 增加工具执行前 policy 检查点
  - 说明：policy 可以理解成“门卫”。模型想调用工具时，先问门卫允不允许。
  - 涉及文件：`src/core/agent-loop.ts`、后续 `src/policy/*`
  - 完成标准：每次 tool call 执行前都能得到 allow、deny 或 ask 类型的决策。
  - 完成记录：

- [ ] 给模型请求和工具执行增加 `AbortSignal`
  - 说明：`AbortSignal` 可以理解成“刹车线”。用户取消、请求超时、工具卡住时，可以让正在执行的任务停下来。
  - 涉及文件：`src/core/types.ts`、`src/core/agent-loop.ts`、`src/models/request-builder.ts`、`src/tools/*`
  - 完成标准：`model.generate` 和 `tool.execute` 都能接收取消信号。
  - 完成记录：

- [ ] 增加工具结果长度限制
  - 说明：防止某个工具一次返回太多内容，把模型上下文塞爆。
  - 涉及文件：`src/core/agent-loop.ts`
  - 完成标准：超长工具结果会被安全截断，并在结果里说明已截断。
  - 完成记录：

- [ ] 支持工具声明执行模式
  - 说明：默认工具继续串行执行；只有明确声明安全的工具，后期才允许并行执行。
  - 建议字段：`executionMode: "sequential" | "parallelSafe"`
  - 涉及文件：`src/core/types.ts`、`src/tools/tool.ts`、`src/core/agent-loop.ts`
  - 完成标准：工具可以声明自己是否适合并行，Agent Loop 能识别这个声明。
  - 完成记录：

- [ ] 为 Agent Loop 增强补测试
  - 涉及文件：`tests/core.test.ts`
  - 完成标准：覆盖事件触发、policy 拒绝、取消信号、工具结果截断、最大轮次错误。
  - 完成记录：

## B.4 上下文与成本管理

- [ ] 增加上下文预算配置
  - 说明：上下文预算用于限制一次模型请求最多带多少历史和工具结果。
  - 完成标准：配置能限制最大消息数、最大工具结果字符数、最大上下文 token 预算。
  - 完成记录：

- [ ] 增加上下文压缩入口
  - 说明：上下文压缩可以理解成“会议纪要”。旧消息太多时，不要每次都完整带入模型，而是整理成摘要。
  - 涉及文件：`src/core/agent-loop.ts`、`src/core/types.ts`、后续 `src/memory/*`
  - 完成标准：Agent Loop 预留 compaction 接口，后续可以接入摘要器或插件。
  - 完成记录：

- [ ] 设计 context editing 策略
  - 说明：context editing 是“清理旧工具结果”，不一定总结，只是把已经没用的大块内容移除或替换成占位说明。
  - 完成标准：文档说明 compaction 和 context editing 的区别。
  - 完成记录：

- [ ] 设计 token usage 统计
  - 完成标准：每次模型请求能记录 input tokens、output tokens、cache tokens、估算成本。
  - 完成记录：

## B.5 测试策略收紧

- [ ] 评估并移除 `passWithNoTests: true`
  - 涉及文件：`vitest.config.ts`
  - 完成标准：测试被误删时 CI 不会假通过。
  - 完成记录：

- [ ] 建立核心模块测试矩阵
  - 完成标准：core、models、config、tools、plugins、memory、cli 都有最小测试覆盖。
  - 完成记录：

---

# 阶段 C：安全、权限与可信插件地基

目标：在插件生态扩大之前，先把门卫、记录仪和保险丝装好。

## C.1 Threat Model 威胁模型

- [ ] 编写 threat model 文档
  - 建议文件：`docs/security/threat-model.md`
  - 说明：threat model 是“提前列出可能出事的地方”。
  - 完成标准：覆盖 prompt injection、恶意插件、越权工具调用、密钥泄露、路径穿越、供应链攻击、企业数据泄露。
  - 完成记录：

- [ ] 明确信任边界
  - 完成标准：区分用户输入、模型输出、插件代码、MCP server、provider、企业 secret、文件系统、网络。
  - 完成记录：

- [ ] 明确默认安全姿态
  - 建议：默认最小权限；写文件、命令执行、外部网络、安装插件都需要显式授权或配置。
  - 完成记录：

## C.2 Policy 权限系统

- [ ] 设计 Policy 接口
  - 建议位置：`src/policy/*`
  - 完成标准：工具执行、插件加载、文件访问、命令执行、MCP 调用都能进入授权流程。
  - 完成记录：

- [ ] 支持工具调用授权
  - 完成标准：每次 tool call 执行前可以 allow、deny 或 ask。
  - 完成记录：

- [ ] 支持文件路径授权
  - 完成标准：可以限制只读/可写目录，默认禁止读取 `.env`、`.git` 敏感内容。
  - 完成记录：

- [ ] 支持命令执行授权
  - 完成标准：危险命令默认询问或拒绝；命令执行有 timeout 和输出限制。
  - 完成记录：

- [ ] 支持网络访问授权
  - 完成标准：工具、插件、provider、MCP server 的网络目标可以被 allowlist 限制。
  - 完成记录：

- [ ] 设计 policy plugin 接口
  - 示例插件：`mingxu-plugin-policy-basic`、`mingxu-plugin-policy-enterprise`、`mingxu-plugin-policy-company`
  - 完成标准：多个 policy 插件可以组合执行，并且不能绕过核心授权流程。
  - 完成记录：

## C.3 Secret 管理

- [ ] 配置文件禁止推荐明文 key 写法
  - 完成标准：README 和模板都使用环境变量。
  - 完成记录：

- [ ] 支持 `${ENV_NAME}` 环境变量引用
  - 完成标准：配置里可以写环境变量占位符，由运行时读取。
  - 完成记录：

- [ ] 日志和错误信息自动脱敏 secret
  - 完成标准：密钥不会被完整打印到终端、session 或 audit 日志。
  - 完成记录：

- [ ] 设计 vault/secret provider 扩展点
  - 说明：vault 可以理解成“保险箱”。短期先支持 env，后期支持企业 secret manager。
  - 完成标准：企业可以接入自己的密钥系统。
  - 完成记录：

## C.4 插件安全策略

- [ ] 设计插件 trust 等级
  - 建议等级：`trusted`、`prompt`、`blocked`
  - 完成记录：

- [ ] 支持插件 allowlist 白名单
  - 完成标准：企业可以只允许加载指定插件。
  - 完成记录：

- [ ] 支持插件 blocklist 黑名单
  - 完成标准：明确禁止的插件不能加载。
  - 完成记录：

- [ ] 插件加载前显示权限摘要
  - 完成标准：用户能知道插件要访问什么能力。
  - 完成记录：

- [ ] 文档明确说明插件是本地代码执行
  - 完成标准：用户知道安装插件等于运行第三方代码。
  - 完成记录：

---

# 阶段 D：Observability 可观测性与 Audit 审计

目标：企业和开发者都能看清 Agent 到底做了什么、花了多少钱、哪里慢、哪里失败。

## D.1 事件与 trace 设计

- [ ] 设计统一运行事件格式
  - 建议位置：`src/events/*`
  - 完成标准：模型调用、工具调用、插件加载、session 写入、policy 决策都有统一事件。
  - 完成记录：

- [ ] 设计 trace id / run id / session id
  - 说明：这些 ID 用来把一次运行中的模型调用、工具调用、错误、日志串起来。
  - 完成标准：日志和审计能追踪一次完整运行。
  - 完成记录：

- [ ] 对齐 OpenTelemetry 风格字段
  - 说明：OpenTelemetry 是常见的可观测性标准。即使不直接依赖，也要让字段名容易接入企业系统。
  - 完成标准：事件里包含 provider、model、duration、token usage、error type、tool name。
  - 完成记录：

## D.2 Audit 审计日志

- [ ] 设计审计事件格式
  - 建议位置：`src/audit/*`
  - 完成标准：模型调用、工具调用、插件加载、session 写入都有统一事件。
  - 完成记录：

- [ ] 实现本地 JSONL audit writer
  - 完成标准：每一行是一条审计事件，方便后续处理。
  - 完成记录：

- [ ] 支持审计脱敏
  - 完成标准：API key、token、密码、敏感文件内容不会明文进入日志。
  - 完成记录：

- [ ] 设计 audit writer plugin 接口
  - 示例插件：`mingxu-plugin-audit-jsonl`、`mingxu-plugin-audit-http`、`mingxu-plugin-audit-enterprise`
  - 完成标准：本地 JSONL、HTTP 上报、企业日志系统都能通过插件接入。
  - 完成记录：

## D.3 Metrics 指标

- [ ] 记录模型调用耗时
  - 完成标准：能看到每次模型请求开始、结束、耗时。
  - 完成记录：

- [ ] 记录工具调用耗时
  - 完成标准：能看到每个工具调用是否成功、耗时多少、是否被 policy 拦截。
  - 完成记录：

- [ ] 记录 token 和成本
  - 完成标准：能按 session、provider、model 汇总 token 使用和成本估算。
  - 完成记录：

---

# 阶段 E：插件系统与扩展生态

目标：用户可以像装积木一样安装专属能力，但企业可以控制风险。

## E.1 插件 manifest

- [ ] 设计 `mingxu.plugin.json` 插件说明文件
  - 完成标准：定义插件名称、版本、入口、权限、配置 schema、兼容的 mingxu 版本。
  - 完成记录：

- [ ] 实现插件 manifest 读取和校验
  - 涉及文件：`src/plugins/*`
  - 完成标准：加载插件前先读 manifest，格式错误时给出清楚提示。
  - 完成记录：

- [ ] 支持插件依赖和冲突声明
  - 完成标准：插件能声明依赖其他插件，也能声明和哪些插件冲突。
  - 完成记录：

- [ ] 支持插件配置 schema
  - 完成标准：插件能声明自己的配置格式，配置错误时启动前报错。
  - 完成记录：

## E.2 插件类型分层

- [ ] 支持 tool plugin
  - 说明：给 Agent 增加工具。
  - 完成记录：

- [ ] 支持 provider plugin
  - 说明：给 Agent 增加模型供应商。Provider 可以理解成“模型插头”。
  - 完成记录：

- [ ] 支持 memory plugin
  - 说明：给 Agent 增加会话或长期记忆存储。
  - 完成记录：

- [ ] 支持 policy plugin
  - 说明：给 Agent 增加权限规则。
  - 完成记录：

- [ ] 支持 audit plugin
  - 说明：给 Agent 增加审计写入器。
  - 完成记录：

- [ ] 支持 context compactor plugin
  - 说明：给 Agent 增加上下文压缩策略。
  - 完成记录：

- [ ] 支持 agent preset plugin
  - 说明：一键创建某种专属 Agent。
  - 完成记录：

## E.3 Provider 插件化

- [ ] 明确内置 provider 与插件 provider 的边界
  - 建议内置：`anthropic`、`openai-compatible`、`gemini`、`custom`
  - 建议插件化：Azure、Bedrock、Ollama、OpenRouter、企业内部模型网关、地区性模型平台、依赖较重或更新频繁的 provider。
  - 完成标准：README 或架构文档里明确说明哪些 provider 放核心，哪些走插件。
  - 完成记录：

- [ ] 设计 provider plugin manifest
  - 说明：provider 插件的 manifest 必须声明插件会注册哪些 provider、要访问哪些网络域名、要读取哪些环境变量。
  - 示例字段：`type: "provider"`、`providers`、`permissions.network`、`permissions.env`。
  - 完成标准：manifest schema 能区分普通工具插件和 provider 插件。
  - 完成记录：

- [ ] 给 PluginContext 增加 `registerProvider` 能力
  - 涉及文件：`src/plugins/plugin.ts`、`src/models/provider-registry.ts`
  - 完成标准：插件不需要修改核心代码，就能向 ProviderRegistry 注册新的 provider。
  - 完成记录：

- [ ] 调整 CLI 加载顺序：先加载 provider 插件，再创建 model adapter
  - 涉及文件：`src/cli/main.ts`
  - 推荐顺序：读取配置 → 注册内置 provider → 读取插件 manifest → 加载 provider 插件 → 创建当前模型 adapter → 加载 tool/memory/policy 等普通插件 → 创建 Agent。
  - 完成标准：配置里的默认模型可以使用 provider 插件注册出来的 provider。
  - 完成记录：

- [ ] 为 provider 插件增加更严格的权限声明
  - 说明：provider 插件会接触用户输入、系统提示词、工具结果，权限高于普通 tool 插件。
  - 完成标准：provider 插件至少声明 `network`、`env`、`providers`，企业模式下必须经过 allowlist 或明确 trust。
  - 完成记录：

- [ ] 为 provider 插件补测试
  - 涉及文件：`tests/plugin-loader.test.ts`、`tests/cli.test.ts`、`tests/provider-registry.test.ts`
  - 完成标准：覆盖 provider 插件注册成功、未加载时找不到 provider、权限声明缺失、重复 provider 名、加载顺序错误。
  - 完成记录：

## E.4 插件管理命令

- [ ] 新增 `mingxu plugin list`
  - 完成标准：列出当前配置启用的插件。
  - 完成记录：

- [ ] 新增 `mingxu plugin inspect <plugin>`
  - 完成标准：显示插件说明、入口文件、权限声明、版本、来源。
  - 完成记录：

- [ ] 新增 `mingxu plugin add <path>`
  - 完成标准：先支持本地路径插件安装。
  - 完成记录：

- [ ] 新增 `mingxu plugin remove <name>`
  - 完成标准：从配置里移除插件。
  - 完成记录：

- [ ] 新增 `mingxu plugin update <name>`
  - 完成标准：能更新插件，并保留旧版本回滚信息。
  - 完成记录：

- [ ] 中期支持从 npm 安装插件
  - 完成标准：可以安装 `mingxu-plugin-*` 包，并写入配置。
  - 完成记录：

## E.5 插件路径规则统一

- [ ] 插件路径改为相对配置文件目录解析
  - 涉及文件：`src/plugins/plugin-loader.ts`、`src/cli/main.ts`、`src/config/load-config.ts`
  - 完成标准：从不同工作目录运行命令时，同一个配置文件加载到同一个插件。
  - 完成记录：

- [ ] 为插件路径解析补 CLI 测试
  - 涉及文件：`tests/plugin-loader.test.ts`、`tests/cli.test.ts`
  - 完成标准：覆盖相对路径、绝对路径、非法 URL、网络路径、错误扩展名。
  - 完成记录：

---

# 阶段 F：安装、配置与用户体验

目标：用户 5 分钟内能安装、配置、跑起来。初学者也能看懂报错。

## F.1 初始化命令

- [ ] 新增 `mingxu init`
  - 涉及文件：`src/cli/parse-args.ts`、`src/cli/main.ts`
  - 完成标准：可以生成最小 `mingxu.config.json`。
  - 完成记录：

- [ ] 支持 `mingxu init --profile minimal`
  - 完成标准：生成个人开发用的最小配置。
  - 完成记录：

- [ ] 支持 `mingxu init --profile enterprise`
  - 完成标准：生成更保守的企业配置模板，默认启用权限和审计占位配置。
  - 完成记录：

- [ ] 支持 `mingxu init --preset <name>`
  - 完成标准：可以基于 agent preset 生成配置。
  - 完成记录：

## F.2 环境检查命令

- [ ] 新增 `mingxu doctor`
  - 涉及文件：`src/cli/parse-args.ts`、`src/cli/main.ts`
  - 完成标准：能检查 Node 版本、配置文件、API key、provider、插件路径、MCP server、session 文件权限。
  - 完成记录：

- [ ] 为 `mingxu doctor` 输出初学者能看懂的错误提示
  - 完成标准：错误提示不只说 technical error，还要告诉用户怎么修。
  - 完成记录：

- [ ] 新增 provider 连通性检查
  - 完成标准：能用极小请求验证当前 provider 是否可用。
  - 完成记录：

- [ ] 新增插件健康检查
  - 完成标准：检查插件 manifest、入口文件、权限声明、兼容版本。
  - 完成记录：

## F.3 README 与教程

- [ ] README 增加 5 分钟快速开始
  - 涉及文件：`README.md`
  - 完成标准：新用户能照着完成安装、配置、第一次运行。
  - 完成记录：

- [ ] README 增加最小配置示例
  - 完成标准：说明每个字段是做什么的。
  - 完成记录：

- [ ] README 增加常见错误排查
  - 完成标准：覆盖 API key 缺失、配置格式错误、插件路径错误、provider 不存在、权限拒绝。
  - 完成记录：

- [ ] 编写“第一个插件”教程
  - 完成记录：

- [ ] 编写“第一个 provider 插件”教程
  - 完成记录：

- [ ] 编写“MCP 接入指南”
  - 完成记录：

---

# 阶段 G：会话、记忆与专属 Agent

目标：用户可以真正创建和管理自己的自动专属 Agent。

## G.1 Session 存储增强

- [ ] 支持 `mingxu resume`
  - 完成标准：可以继续最近一次 session。
  - 完成记录：

- [ ] 支持列出最近 session
  - 完成标准：用户能选择要恢复的会话。
  - 完成记录：

- [ ] 支持简单 fork session
  - 完成标准：可以从已有 session 复制出一个新任务。
  - 完成记录：

- [ ] 设计 session 数据保留策略
  - 完成标准：支持关闭保存、设置保留天数、清理旧 session。
  - 完成记录：

- [ ] session 存储增加隐私说明
  - 完成标准：用户知道 session 里可能包含提示词、文件内容、工具结果。
  - 完成记录：

## G.2 Memory 长期记忆

- [ ] 区分 session 与 memory
  - 说明：session 是一次对话历史；memory 是跨会话保存的长期知识。
  - 完成标准：文档明确二者区别。
  - 完成记录：

- [ ] 设计 MemoryStore 权限模型
  - 完成标准：支持 read-only、read-write，企业可以限制哪些 agent 能写 memory。
  - 完成记录：

- [ ] 设计 memory plugin 接口
  - 示例插件：`mingxu-plugin-memory-jsonl`、`mingxu-plugin-memory-sqlite`、`mingxu-plugin-memory-postgres`
  - 完成标准：不同存储后端可以通过插件接入。
  - 完成记录：

- [ ] 增加 memory 版本与删除策略
  - 完成标准：记忆被修改和删除时有记录，支持清理错误或敏感记忆。
  - 完成记录：

## G.3 Agent Preset

- [ ] 设计 agent preset 配置格式
  - 完成标准：能定义名称、说明、模型、插件、MCP server、系统提示词、权限策略。
  - 完成记录：

- [ ] 新增 `mingxu agent list`
  - 完成记录：

- [ ] 新增 `mingxu agent run <name>`
  - 完成记录：

- [ ] 新增 `mingxu agent create <name>`
  - 完成记录：

- [ ] 支持 agent preset 版本记录
  - 完成标准：运行 session 时能记录使用的 preset 版本。
  - 完成记录：

---

# 阶段 H：企业运行环境与自动化

目标：让企业能安全地把 agent 放进真实流程里。

## H.1 执行环境与沙箱

- [ ] 设计本地执行环境策略
  - 完成标准：说明工具默认在当前进程/本机执行，风险是什么。
  - 完成记录：

- [ ] 设计 container/sandbox 扩展点
  - 完成标准：后期可以把 bash、文件操作、代码执行放进 Docker、VM 或企业自有沙箱。
  - 完成记录：

- [ ] 支持工具级 runtime 配置
  - 说明：不同工具可以声明自己需要 local、container、remote。
  - 完成标准：文档和类型预留该能力。
  - 完成记录：

## H.2 企业模板

- [ ] `mingxu init --profile enterprise` 默认启用审计配置
  - 完成记录：

- [ ] `mingxu init --profile enterprise` 默认启用插件 allowlist
  - 完成记录：

- [ ] `mingxu init --profile enterprise` 默认关闭高风险工具
  - 完成记录：

- [ ] `mingxu init --profile enterprise` 默认限制网络访问
  - 完成记录：

## H.3 自动任务与调度

- [ ] 设计 schedule 配置格式
  - 完成标准：支持每天、每周、cron 等基本计划任务表达。
  - 完成记录：

- [ ] 新增 `mingxu schedule add`
  - 完成记录：

- [ ] 新增 `mingxu schedule list`
  - 完成记录：

- [ ] 新增 `mingxu schedule remove`
  - 完成记录：

- [ ] 为自动任务增加审计和失败记录
  - 完成标准：每次自动运行都有 run record，失败原因可查询。
  - 完成记录：

## H.4 多 Agent 与 Workflow

- [ ] 设计轻量 subagent 接口
  - 完成标准：主 agent 可以把独立任务交给子 agent，但不强制内置复杂调度器。
  - 完成记录：

- [ ] 设计 workflow 配置格式
  - 完成标准：支持 scout、planner、builder、integrator、verifier 这种多子代理流程。
  - 完成记录：

- [ ] 多 agent 默认受 policy 和成本限制
  - 完成标准：不能无限启动子 agent；企业可以限制最大数量、最大 token、最大运行时间。
  - 完成记录：

---

# 阶段 I：质量评估、发布与生态

目标：让别人容易安装、升级、写插件、贡献，同时保证每次发布不破坏已有能力。

## I.1 Evals 与回归测试

- [ ] 建立 agent 行为 evals
  - 说明：evals 是“给 agent 的考试题”。
  - 完成标准：覆盖工具选择、错误恢复、权限拒绝、上下文压缩、插件加载。
  - 完成记录：

- [ ] 建立 provider 兼容 evals
  - 完成标准：每个 provider 都有最小 tool call、普通文本、错误处理测试。
  - 完成记录：

- [ ] 建立插件兼容测试套件
  - 完成标准：第三方插件可以运行一组标准测试确认自己兼容当前 mingxu。
  - 完成记录：

- [ ] 建立安全回归样例
  - 完成标准：覆盖 prompt injection、恶意工具参数、路径穿越、secret 泄露、插件权限缺失。
  - 完成记录：

## I.2 CI 与质量保障

- [ ] 新增 GitHub Actions：typecheck + test
  - 完成记录：

- [ ] 新增 coverage 覆盖率统计
  - 完成记录：

- [ ] 新增 format 或 lint 策略
  - 完成记录：

- [ ] 新增安全扫描
  - 完成标准：依赖漏洞和危险脚本能被发现。
  - 完成记录：

## I.3 npm 发布准备

- [ ] 移除或调整 `private: true`
  - 涉及文件：`package.json`
  - 完成标准：项目可以准备发布 npm。
  - 完成记录：

- [ ] 新增 LICENSE
  - 完成记录：

- [ ] 新增 CHANGELOG
  - 完成记录：

- [ ] 配置 npm files 白名单
  - 完成标准：发布包只包含必要文件。
  - 完成记录：

- [ ] 新增发布前 smoke test
  - 完成标准：打包后在临时目录安装并运行 `mingxu --help`。
  - 完成记录：

- [ ] 建立版本兼容策略
  - 完成标准：说明 core API、plugin API、config schema 的 semver 规则。
  - 完成记录：

## I.4 供应链安全

- [ ] 锁定直接依赖版本
  - 完成标准：依赖升级需要明确 review。
  - 完成记录：

- [ ] 插件安装默认禁止 install scripts
  - 完成标准：从 npm 安装插件时，默认避免生命周期脚本风险，或明确提示风险。
  - 完成记录：

- [ ] 支持插件签名或校验摘要
  - 完成标准：企业能校验插件来源和完整性。
  - 完成记录：

- [ ] 支持企业插件 registry
  - 完成标准：企业可以只从内部插件源安装。
  - 完成记录：

## I.5 官方插件路线

- [ ] 规划 `mingxu-plugin-files`
  - 完成记录：

- [ ] 规划 `mingxu-plugin-git`
  - 完成记录：

- [ ] 规划 `mingxu-plugin-github` 或 GitHub MCP 接入方案
  - 完成记录：

- [ ] 规划 `mingxu-plugin-http`
  - 完成记录：

- [ ] 规划 `mingxu-plugin-sqlite-memory`
  - 完成记录：

- [ ] 规划 `mingxu-plugin-policy-basic`
  - 完成记录：

- [ ] 规划 `mingxu-plugin-audit-jsonl`
  - 完成记录：

- [ ] 规划 `mingxu-plugin-compact-basic`
  - 完成记录：

---

## 每次开发完成后的固定检查清单

每完成一个开发任务，AI 都必须检查并勾选：

- [ ] 已更新本计划文档中的对应任务勾选状态
- [ ] 已补充或更新相关测试
- [ ] 已运行必要测试或说明为什么没运行
- [ ] 已更新 README 或相关文档，如果用户使用方式发生变化
- [ ] 已说明本次修改还有哪些风险或未完成事项
- [ ] 如果涉及插件、工具、provider、MCP、命令执行、文件写入、网络访问，已检查 policy 和 audit 是否接入
- [ ] 如果涉及长期会话、memory、日志、审计，已检查 secret 和隐私脱敏

> 注意：上面这组是“每次开发后的提醒清单”。每次任务结束后可以临时勾选；下次新任务开始前再恢复为未勾选，或者复制一份到对应任务下面。

---

## 外部参考方向

后续实现时建议持续参考这些方向，不要盲目照搬：

- MCP 安全最佳实践：关注用户同意、最小权限、token 不透传、confused deputy（混淆代理）风险。
- OWASP LLM Top 10：重点关注 prompt injection、sensitive information disclosure、supply chain、excessive agency、insecure output handling。
- OpenTelemetry GenAI semantic conventions：参考模型请求、token、工具调用、错误、耗时等字段命名。
- NIST AI RMF / Generative AI Profile：参考企业治理、风险识别、监控和责任划分。
- Anthropic agent/tool 文档：参考 tool surface 设计、tool runner、上下文管理、MCP、permissions、vaults、events、managed agents 的 agent/session 分离思想。

---

## 完成记录汇总

后续每完成一个任务，在这里追加一行：

- 2026-07-28：创建本发展计划文档，作为后续 AI 勾选和项目管理入口。
- 2026-07-28：根据重新审视结果重构路线图，补充 MCP、威胁模型、Agent Preset 版本、运行环境、可观测性、上下文成本管理、evals、供应链安全等遗漏内容。
