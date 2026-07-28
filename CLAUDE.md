# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

这是一个最小化的 TypeScript agent runtime 骨架，目标是把“模型调用、工具执行、配置加载、插件扩展、记忆存储”拆成清晰的层。

- 运行环境：Node.js 22+，包管理器：pnpm 10+
- 代码风格：ESM + 严格 TypeScript
- 对外入口：`src/index.ts` 统一导出公共 API，CLI 从这里之外单独走 `src/cli`

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

- `src/models/model-protocol.ts` / `model-events.ts` / `model-capabilities.ts`：定义通用模型协议
- `src/models/provider-registry.ts`：模型提供方注册表，当前代码里已经有扩展位
- `src/models/anthropic-provider.ts`：把内部消息格式转换成 Anthropic Messages API，再把响应转回来

当前 CLI 走的是 `anthropic` provider；如果未来加别的模型，优先在这里补适配器，而不是改 core。

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

流程是：解析参数 → 读取配置 → 创建模型 provider → 注册内置工具 → 加载插件 → 构建 `Agent` → 执行 prompt → 输出结果。

也就是说，CLI 不是另一套业务逻辑，只是把上面几层组装起来。

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
3. `src/core/agent-loop.ts`：核心执行循环
4. `src/models/anthropic-provider.ts`：模型适配方式
5. `src/tools/tool-registry.ts`：工具如何注册和执行

## 当前实现里值得注意的点

- tool call 是按模型给出的顺序串行执行的，不做并发
- 工具失败不会直接炸掉整轮，而是变成一条 tool 消息回给模型
- `readFile` 工具默认只允许读取根目录下的文件，并会再做一次 `realpath` 校验，防止符号链接把路径带出去
- `ToolRegistry` 和 `ProviderRegistry` 都会拒绝重名注册
- build 只编译 `src`，测试走 Vitest 单独跑
