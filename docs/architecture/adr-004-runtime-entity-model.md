# ADR-004：Agent、Session、Run、Turn、Approval 数据模型

- 状态：已批准
- 日期：2026-07-28
- 决策范围：`mingxu` 运行实体命名、生命周期和最小关系模型

## 背景

随着 `mingxu` 从“能跑一次命令”往“可管理的 Agent Runtime”演进，很多后续能力都依赖同一套基础对象模型。比如：

- `mingxu resume`
- session 持久化
- 审批等待与恢复
- 审计日志
- 事件追踪
- agent preset 版本记录
- workflow / 多子代理扩展

如果这些基础名词没有先定下来，后面很容易混乱：

- 有时把一次 CLI 执行叫 session
- 有时又把整段长期对话叫 run
- 有时把一次模型调用叫 turn，有时又叫 step
- approval 到底是工具调用前的确认，还是整次任务暂停点，也会越写越乱

所以 v0.x 虽然实现还很轻，也应该先把最小数据模型定清楚。这样后续加功能时，大家说的是同一种对象。

## 决策目标

- 给核心运行时一套稳定、通俗、可扩展的命名
- 区分“长期容器”和“单次执行”
- 支持后续审批、恢复、审计、版本记录
- 不把当前实现过度复杂化

## 最终决策概览

采用下面这组核心概念：

- `Agent`：可复用的 agent 定义或 preset，描述“这类 agent 是什么”
- `Session`：持续的一段会话容器，描述“这段长期交互是什么”
- `Run`：在某个 session 中发起的一次执行，描述“这次实际运行发生了什么”
- `Turn`：run 里的一个轮次，通常对应一次模型请求以及其产生的工具执行回合
- `Approval`：需要人工或策略确认的暂停点，描述“这里卡住，等人决定”

可以用生活中的比喻理解：

- `Agent` 像岗位模板
- `Session` 像某个长期项目档案袋
- `Run` 像这次具体开工记录
- `Turn` 像开工过程中的一轮来回
- `Approval` 像某个需要主管签字的卡点

## 为什么这样拆

### 1. Agent 和 Session 不是一回事

很多系统容易把“agent 名字”和“对话历史”混在一起。

这里明确分开：

- `Agent` 负责定义默认模型、系统提示词、插件、权限策略等“模板信息”
- `Session` 负责承载实际对话历史、状态、引用的 agent 版本等“运行中的长期记录”

这样做的好处是：

- 同一个 Agent 可以产生很多 Session
- 一个 Session 能清楚知道自己当时使用的是哪个 Agent 版本
- 后期 agent preset 才能真正可复用、可版本化

### 2. Session 和 Run 不是一回事

Session 更像“长期容器”，Run 更像“某次具体执行”。

例如：

- 用户今天早上创建了一个 session
- 中午运行了一次任务
- 下午因为审批暂停后又恢复继续
- 晚上又追问一轮

这些都可以属于同一个 Session，但可能对应多个 Run。

这样做的好处是：

- 审计和 trace 更容易精确到某次执行
- 恢复运行不会污染“整个 session 只有一个 run”的假设
- 多次 CLI 进入同一 session 时，结构更自然

### 3. Turn 要小于 Run

`Turn` 用来表达 run 过程中的“轮次”。

在当前 `mingxu` 的 Agent Loop 语义里，一个 turn 通常包含：

1. 准备本轮输入上下文
2. 发起一次模型请求
3. 接收模型文本或 tool calls
4. 如有工具调用，则按规则执行工具
5. 把结果回填历史
6. 决定是否进入下一轮

这样定义的好处是：

- 能和 `maxIterations` 对齐
- 事件、指标、错误、工具调用都能挂到具体 turn 上
- 后期做上下文压缩或轮次审计时更清楚

### 4. Approval 要作为显式对象存在

审批不是一个临时布尔值，而是一个明确对象。因为后面它可能需要记录：

- 为什么要审批
- 由谁审批
- 审批的目标动作是什么
- 什么时候创建
- 当前状态是什么
- 最终是允许、拒绝还是过期

如果只用一个 `waiting_for_approval = true`，后期很难扩展。

## 逻辑数据模型

### 1. Agent

`Agent` 表示一个可复用定义。它不等于一次运行结果。

最小建议字段：

- `agentId`
- `name`
- `version`
- `description`
- `modelSelection`
- `systemPrompt`
- `pluginRefs`
- `toolPolicyRef`
- `memoryRef`
- `createdAt`
- `updatedAt`

说明：

- `version` 很关键，因为 session 应记录自己是基于哪个 agent 版本启动的
- `pluginRefs` 表示要装哪些插件，不直接等于插件运行结果
- `toolPolicyRef` 和 `memoryRef` 先作为引用概念，方便后续扩展

### 2. Session

`Session` 表示一段持续会话。

最小建议字段：

- `sessionId`
- `agentId`（可选，如果不是从 preset 启动）
- `agentVersion` 或 `presetRevision`（可选，但如果来自 preset，建议记录）
- `title`
- `status`
- `createdAt`
- `updatedAt`
- `lastRunId`
- `messageHistoryRef` 或内联历史
- `metadata`

推荐状态：

- `active`
- `archived`
- `deleted`

状态含义：

- `active`：这段 session 仍然可继续使用，后续可以继续输入、恢复或附着新的 run
- `archived`：归档保留，通常视为只读
- `deleted`：逻辑删除，不再参与正常运行

这里要特别统一一个边界：

- Session 只表达“这段长期会话容器现在处于什么管理状态”。
- `running`、`waiting_for_approval`、`failed`、`succeeded` 这类执行状态全部放到 Run。

### 3. Run

`Run` 表示在某个 session 中发起的一次执行。

最小建议字段：

- `runId`
- `sessionId`
- `status`
- `trigger`
- `startedAt`
- `endedAt`
- `inputRef` 或输入快照
- `outputRef` 或输出快照
- `error`
- `usage`
- `approvalIds`
- `turnCount`
- `traceId`

推荐状态：

- `queued`
- `running`
- `waiting_for_approval`
- `succeeded`
- `failed`
- `cancelled`
- `timed_out`
- `interrupted`

说明：

- `trigger` 用来说明这次 run 是怎么开始的，比如用户输入、恢复运行、计划任务、workflow 子代理调用
- `usage` 用来承载 token、成本、耗时统计
- `traceId` 方便把事件、日志、审计串起来
- `timed_out` 用来表达超时终止，和用户主动取消的 `cancelled` 分开。
- `interrupted` 用来表达进程退出、崩溃恢复或外部中断后未正常收尾的情况。

### 4. Turn

`Turn` 表示 run 内的一轮执行。

最小建议字段：

- `turnId`
- `runId`
- `index`
- `startedAt`
- `endedAt`
- `modelRequest`
- `modelResponse`
- `toolCalls`
- `toolResults`
- `stopReason`
- `error`
- `usage`

推荐 `stopReason` 示例：

- `final_response`
- `tool_calls_requested`
- `max_iterations_reached`
- `approval_required`
- `cancelled`
- `error`

说明：

- 一个 run 里会有多个 turn
- 每个 turn 都可以独立记录模型请求、工具调用和错误
- `usage` 最好能细到 turn 级别，这样后期分析“哪一轮最贵、哪一轮最慢”更方便

### 5. Approval

`Approval` 表示一个等待决策的审批点。

最小建议字段：

- `approvalId`
- `sessionId`
- `runId`
- `turnId`
- `type`
- `status`
- `reason`
- `requestedAction`
- `requestedAt`
- `resolvedAt`
- `resolvedBy`
- `resolution`
- `expiresAt`

推荐 `type` 示例：

- `tool_call`
- `file_write`
- `command_execute`
- `network_access`
- `plugin_load`
- `mcp_call`

推荐 `status`：

- `pending`
- `approved`
- `denied`
- `expired`
- `cancelled`

说明：

- `requestedAction` 要能说明“当时到底想做什么”
- `resolution` 要能保存最终决定及理由
- `expiresAt` 方便后续做超时策略

## 实体关系

建议按下面关系理解：

```text
Agent 1 --- N Session
Session 1 --- N Run
Run 1 --- N Turn
Run 1 --- N Approval
Turn 0..1 --- N Approval
```

补充说明：

- 一个 Session 可以不绑定 Agent，例如完全临时配置启动
- 一个 Approval 通常归属于某个 Run，也常常能定位到某个 Turn
- Agent 本身不保存运行中的可变状态，运行状态应放在 Run / Turn / Approval；Session 只保存容器级状态和引用

## 生命周期建议

### Session 生命周期

```text
active -> archived
active -> deleted
archived -> deleted
```

规则建议：

- `active` 状态允许继续输入、resume 或附着新的 run
- `archived` 通常表示保留但只读
- `deleted` 表示这段容器已退出正常生命周期
- 审批等待、运行中、失败、超时等执行过程都不应再编码到 Session 状态里

### Run 生命周期

```text
queued -> running -> succeeded
queued -> running -> waiting_for_approval -> running -> succeeded
queued -> running -> failed
queued -> running -> cancelled
queued -> running -> timed_out
queued -> running -> interrupted
```

规则建议：

- 一个 session 同一时刻是否允许多个 run 并发，需要后续单独决策；v0.x 默认建议同一 session 单活跃 run
- 这样更简单，也更符合当前 CLI 心智模型
- `waiting_for_approval` 只是中间暂停态，不是终态

### Approval 生命周期

```text
pending -> approved
pending -> denied
pending -> expired
pending -> cancelled
```

## 对当前和后续实现的含义

### 对当前最小实现

即使当前代码还没有完整 `Agent`、`Run`、`Turn` 和 `Approval` 实体，也建议文档和命名开始向这套模型靠拢。

当前已存在或接近的部分：

- 一次 CLI 执行天然接近 `Run`
- agent loop 的迭代轮次天然接近 `Turn`
- `sessionFile` + `FileSessionStore` 只提供“把消息历史存进本地 JSON 文件”的轻量持久化能力
- 当前公开的 `MemoryStore` 仍只是通用 KV 接口，不能把它直接等同于正式 `SessionStore` 或长期 Memory 契约

### 对后续阶段

这套模型会直接支撑：

- `mingxu resume`
- session 列表与恢复
- agent preset 版本记录
- policy ask / human approval
- 审计与 trace 关联
- workflow 中父子 run 扩展

## trade-off

### 收益

- 名词统一，后续文档和代码不容易各说各话
- 审计、权限、恢复、版本化都更容易设计
- 既能覆盖当前 CLI 模式，也能支持后续企业增强

### 代价

- 对当前最小项目来说，概念会比现有实现稍微超前一点
- 后续实现需要克制，不要为了“符合模型”而过早把代码搞复杂

## 不做的事

本 ADR 不直接决定：

- session 文件 JSON 的最终落盘 schema
- trace event 的最终字段命名
- approval UI 或命令行交互细节
- 多 run 并发调度策略的全部细节

这些应在对应专题设计中继续细化。

## 复审触发条件

出现下面情况时应重新评审：

- 项目决定放弃 agent preset 概念
- session 与 run 被证明必须合并成单一对象
- workflow / 多子代理引入父子 run、子 session 等复杂层级
- 审批系统不再以显式对象形式存在
