# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

这是一个最小化的 TypeScript agent runtime 骨架，目标是把“模型调用、工具执行、配置加载、插件扩展、记忆存储”拆成清晰的层。

- 运行环境：Node.js 22+，包管理器：pnpm 10+
- 代码风格：ESM + 严格 TypeScript
- 对外入口：`src/index.ts` 统一导出公共 API，CLI 从这里之外单独走 `src/cli`
- 当前主线：`src/models` 已经开始承担统一模型协议、provider registry、runtime bridge 和 Anthropic 适配器的职责

## 常用命令

```bash
pnpm install
```
安装依赖。

```bash
pnpm build
```
把 `src` 编译到 `dist`。

```bash
pnpm typecheck
```
只做类型检查，不输出文件。

```bash
pnpm test
```
运行全部测试。

```bash
pnpm test:watch
```
以 watch 模式运行测试，适合边改边看结果。

```bash
pnpm vitest run tests/core.test.ts
```
只运行单个测试文件。

```bash
pnpm vitest run tests/core.test.ts -t "executes requested tools in order and feeds their results back"
```
只运行单个测试用例。

```bash
node dist/cli/entry.js --help
```
运行已经构建好的 CLI。

## 架构总览

### 1) `src/core`

这里是 agent 的“脑子”。

- `src/core/agent.ts`：很薄的一层包装，只负责把配置交给循环执行器
- `src/core/agent-loop.ts`：真正的主循环。它每轮调用一次模型，收集 tool call，按顺序执行工具，再把结果塞回历史消息里
- `src/core/types.ts`：核心消息、工具、模型输入输出的中间协议

这里最重要的约定是：**模型、工具、历史消息都使用一个中性的内部协议**，不要让某个模型 SDK 的格式直接渗透到其它层。

### 2) `src/models`

这里是“模型适配层”。

- `src/models/model-protocol.ts` / `model-events.ts` / `model-capabilities.ts`：定义通用模型协议和能力描述
- `src/models/provider-registry.ts`：模型提供方注册表，负责按配置创建 provider
- `src/models/model-runtime.ts` / `request-builder.ts`：把 core 的中立输入转成模型请求，再把模型响应转回 core 可用的输出
- `src/models/provider-catalog.ts`：注册内置 provider
- `src/models/anthropic-provider.ts`：Anthropic 的薄适配器，负责把内部协议映射到 Anthropic Messages API

当前 CLI 默认走的是 `anthropic` provider；如果未来加别的模型，优先在 registry 和模型层补适配器，不要把 provider 逻辑塞回 core。

### 3) `src/tools`

这里是“agent 能做什么”。

- `src/tools/tool.ts`、`tool-registry.ts`：定义工具契约和注册/执行入口
- `src/tools/builtin/echo-tool.ts`：最小的回显工具，适合作为联调和烟雾测试
- `src/tools/builtin/read-file-tool.ts`：受限文件读取工具，默认只在配置的根目录内读文件，并做路径逃逸检查

工具层的关键点是：**工具执行是 agent loop 的一部分，但工具本身不应该知道模型细节**。

### 4) `src/config`

这里负责把 JSON 配置变成可用的运行时配置。

- `load-config.ts`：从磁盘读取并校验 JSON
- `config-schema.ts`：用 zod 定义配置结构和默认值
- `define-agent-config.ts`：给代码里直接定义配置用

配置里当前支持的核心字段是：模型、系统提示词、最大迭代次数、插件列表。`sessionFile` 目前在 schema 里保留了，但 CLI 运行路径还没有真正用到它。

### 5) `src/plugins`

这里是本地插件加载机制。

- `plugin-loader.ts`：动态导入 ESM 插件模块，并把插件注册到同一个工具注册表里
- `plugin.ts`：插件接口定义

插件的作用不是另起一套执行链，而是**给同一个工具注册表加工具**，这样 agent loop 看到的是一份统一的工具列表。

### 6) `src/memory`

这里是通用记忆存储接口。

- `memory-store.ts`：异步 key-value 契约
- `in-memory-store.ts`：进程内存实现，进程退出就没了
- `file-session-store.ts`：JSON 文件实现，写入时会走临时文件 + rename，减少半写入风险

### 7) `src/cli`

这里把所有东西串起来。

流程是：解析参数 → 读取配置 → 通过 provider registry 创建模型适配器 → 用 `model-runtime` 包一层成 core 可用的 `ModelProvider` → 构建 `Agent` → 执行 prompt → 输出结果。

也就是说，CLI 不是另一套业务逻辑，只是把上面几层组装起来。`src/plugins` 继续只负责工具扩展，不承接模型 provider。

## 测试结构

`tests/*.test.ts` 基本和 `src` 目录一一对应：

- `tests/core.test.ts`：agent loop 和工具执行顺序
- `tests/anthropic-provider.test.ts`：消息格式转换和响应解析
- `tests/tool-registry.test.ts`：工具注册与执行
- `tests/config.test.ts`：配置校验和加载
- `tests/memory-store.test.ts`：内存存储行为
- `tests/provider-registry.test.ts`：模型提供方注册表
- `tests/cli.test.ts`：CLI 端到端联通

改某一层时，优先更新离它最近的测试文件。

## 读代码时的优先顺序

如果要快速理解项目，建议先看这几个文件：

1. `src/index.ts`：公共导出面
2. `src/cli/main.ts`：整条启动链路
3. `src/models/model-protocol.ts`：统一模型请求/响应/事件协议
4. `src/models/provider-registry.ts`：provider 注册与创建
5. `src/models/model-runtime.ts`：模型结果和 core 之间的桥接
6. `src/core/agent-loop.ts`：核心执行循环
7. `src/models/anthropic-provider.ts`：模型适配方式
8. `src/tools/tool-registry.ts`：工具如何注册和执行

## 当前实现里值得注意的点

- tool call 是按模型给出的顺序串行执行的，不做并发
- 工具失败不会直接炸掉整轮，而是变成一条 tool 消息回给模型
- `readFile` 工具默认只允许读取根目录下的文件，并会再做一次 `realpath` 校验，防止符号链接把路径带出去
- `ToolRegistry` 和 `ProviderRegistry` 都会拒绝重名注册
- build 只编译 `src`，测试走 Vitest 单独跑
## Workflow 多子代理并行开发规范

当用户要求使用 workflow / workflows，或者任务明显适合多子代理并行开发时，默认按“先拆分、再并行写代码、最后整合验证”的方式执行。

### 核心目标

本 workflow 的目标是多子代理并行开发代码，不是代码审核，不是纯研究，不是只做计划。
禁止把主流程设计成 review / audit / critique。
workflow 的产出必须是：可合并的代码修改、测试结果、以及最终整合后的工作成果。

### 标准流程

1. **Scout 侦察阶段**
   - 只读代码，找出相关文件、模块、入口、依赖关系和潜在冲突点。
   - 不写代码。
   - 输出给 planner 的内容必须足够具体：哪些文件会动、哪些地方会互相影响、哪些任务不能并行。

2. **Planner 拆分阶段**
   - 把需求拆成尽可能多的小任务。
   - 不要固定 3-5 个任务；拆分标准是：
     - 任务边界清楚
     - 文件范围明确
     - 尽量互不冲突
     - 每个任务都能独立完成并产出代码
   - planner 的目标不是“想法列表”，而是“可直接分配给 builder 的任务单”。

3. **Builders 并行开发阶段**
   - 启动多个 builder 并行写代码。
   - 只要任务能独立实现，就优先并行，不要刻意减少 builder 数量。
   - 每个 builder 必须明确：
     - 负责范围
     - 允许修改的文件
     - 禁止修改的文件
     - 目标功能
     - 完成标准
   - builder 的职责是**实际改代码**，不是只做分析。
   - 如果多个 builder 可能修改同一个文件，先重新拆分任务，避免并行冲突。
   - 如果多个 builder 都要写代码，优先使用独立 worktree 隔离。
   - builder 完成后应直接交付可合并的代码和相关测试修改。

4. **Integrator 整合阶段**
   - 由一个整合者统一合并各 builder 的结果。
   - 重点处理：
     - 接口对接
     - 命名统一
     - 文件冲突
     - 漏改补齐
   - integrator 不应该重新设计需求，只负责把已完成的代码拼成一个完整结果。

5. **Verifier 验证阶段**
   - 最后运行测试、构建或启动检查。
   - 验证重点是：
     - 代码能否通过类型检查/测试
     - 整合后功能是否连通
     - 是否有明显回归
   - 如果是 UI 改动，必须实际跑起来看，不要只看测试结果。

### 拆分原则

- 任务要小，但不能碎。
- 每个任务尽量只做一件事。
- 优先按模块、文件层、职责层拆分。
- 任务必须能并行；如果不能并行，就不要硬拆成并行任务。
- 不要让多个子代理同时改同一个文件。
- 如果拆分后还是会互相阻塞，先重新拆分，再开始写代码。
- 只要需求足够大，就优先使用更多 builder 并行开发，而不是让一个代理慢慢做完。

### Builder 任务卡要求

每个 builder 的任务卡必须包含：

- 任务名称
- 负责范围
- 允许修改的文件
- 禁止修改的文件
- 目标
- 完成标准
- 测试要求
- 备注

### 输出要求

workflow 结束时必须输出：

- 每个子代理做了什么
- 修改了哪些文件
- 哪些测试通过了
- 还有哪些风险或未完成事项

### 适用场景

适合：
- 新增完整功能
- 前后端一起改
- 多模块重构
- 多个独立问题一起修复
- 需要多人分工并行完成的开发任务

不适合：
- 单文件小改动
- typo 修复
- 两三行就能完成的任务
- 需求还不清楚的探索性问题