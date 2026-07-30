# MingXu

> 当前版本：0.4.0

MingXu 现在的定位是一个通用 Agent 大脑，不是内置编码能力的 Coding Agent。
核心负责模型运行、指令、Context、Memory、Session、policy/approval/audit/budget/abort、MCP、Subagent 和扩展协议；文件、命令、浏览器、联网搜索、PDF、数据库、Git 这类“手脚”应当通过插件或 MCP 接入。

默认安装不带任何文件或命令工具。

## 现在能做什么

- 直接聊天：`mingxu`、`mingxu chat`
- 单轮执行：`mingxu --prompt "..."` 或直接传位置参数
- 会话恢复：`mingxu resume <session-id>`、`mingxu --continue`、`mingxu sessions`
- 配置管理：`mingxu init --global`、`mingxu init --project`、`mingxu doctor`
- 交互面板：`/context`、`/extensions`、`/agents`、`/audit`、`/trust`、`/preset`
- 命令菜单：`/help`、`/status`、`/model`、`/tools`、`/session`、`/sessions`、`/resume`、`/new`、`/clear`、`/exit`、`/compact`、`/steer`
- 扩展边界：本地插件、MCP、Skills、Presets、Resources、Subagent 已进入治理链

## 安装

先在仓库里构建，再全局安装：

```powershell
pnpm install --frozen-lockfile
pnpm build
npm install -g .
```

Windows 上通常会得到 `mingxu.cmd`。
如果 PowerShell 禁止执行脚本，请直接运行 `mingxu.cmd`。
如果脚本允许执行，也可以直接运行 `mingxu`。

## 怎么接 AI

MingXu 支持这些内建 provider：

- `anthropic`
- `openai`
- `openai-compatible`
- `deepseek`
- `gemini`

最常见的方式是把 API Key 放到环境变量里，再在配置里用 `env:NAME` 引用。

### DeepSeek

```powershell
$env:DEEPSEEK_API_KEY = "你的 key"
```

```json
{
  "defaultModel": "chat",
  "models": {
    "chat": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "apiKey": "env:DEEPSEEK_API_KEY"
    }
  }
}
```

### OpenAI

```powershell
$env:OPENAI_API_KEY = "你的 key"
```

```json
{
  "defaultModel": "chat",
  "models": {
    "chat": {
      "provider": "openai",
      "model": "gpt-4.1",
      "apiKey": "env:OPENAI_API_KEY"
    }
  }
}
```

### Anthropic

```powershell
$env:ANTHROPIC_API_KEY = "你的 key"
```

```json
{
  "defaultModel": "chat",
  "models": {
    "chat": {
      "provider": "anthropic",
      "model": "claude-sonnet-5",
      "apiKey": "env:ANTHROPIC_API_KEY"
    }
  }
}
```

如果你接的是兼容 OpenAI 格式的中转服务，就用 `openai-compatible` 并配置 `baseUrl`。

## 怎么聊天

交互聊天：

```powershell
mingxu
```

或者：

```powershell
mingxu chat
```

单轮执行：

```powershell
mingxu --prompt "帮我总结这个仓库"
```

也可以直接传位置参数：

```powershell
mingxu "帮我总结这个仓库"
```

恢复会话：

```powershell
mingxu sessions
mingxu resume <session-id> --prompt "继续这个会话"
mingxu --continue
```

## 常用命令

- `/help`：帮助
- `/status`：当前会话和模型状态
- `/model`：查看或切换模型
- `/tools`：查看当前可用工具
- `/session`：显示当前会话 ID
- `/sessions`：列出最近会话
- `/resume [id]`：恢复会话
- `/new`：新开会话
- `/clear`：清屏
- `/context`：查看指令、Memory、资源和上下文概况
- `/extensions`：查看已加载的扩展
- `/agents`：查看 Subagent 任务树
- `/audit`：查看审计状态
- `/trust`：查看项目信任状态
- `/preset`：查看可用 preset
- `/compact`：查看压缩状态
- `/steer`：加入 steering 指令
- `/exit`、`/quit`：退出

## 配置发现

CLI 会按层加载配置：

1. 全局配置
2. 当前项目配置
3. 显式命令行参数

默认全局配置位置：

- Windows：`%APPDATA%\mingxu\config.json`
- Unix：`${XDG_CONFIG_HOME:-~/.config}/mingxu/config.json`

项目配置会从当前目录向上查找最近的 `mingxu.config.json`。
`MINGXU_USER_CONFIG_DIR` 可以覆盖全局配置目录。
配置里的 `env:NAME` 会先解析成真实环境变量，再进入 provider、MCP header 和 runtime 配置。

## doctor

```powershell
mingxu doctor
```

`doctor` 主要检查：

- 配置来源和合并结果
- 路径是否真实存在
- `env:` 引用是否可解析
- 项目是否受信
- 插件、资源和会话路径是否合理

如果要做真实连通性检查，再加：

```powershell
mingxu doctor --online
```

## 当前边界

现在的 MingXu 已经可以作为本地可安装的受治理 Agent CLI 使用，但还不是完整的扩展平台。

已经具备的部分：

- 统一运行链
- TTY 聊天和流式输出
- 会话恢复和 `--continue`
- 审批 overlay
- context / extensions / agents 面板
- Instruction / Memory / Resource / MCP / Skill / Preset / Subagent 的本地 MVP 边界
- 默认零内建工具

还没有完全补完的部分：

- 本地插件安装器和完整扩展中心闭环
- 插件市场
- 自动安装插件
- 远程 registry
- OS / 容器级沙箱
- 分布式 Subagent
- 像完整 IDE 一样的全屏工作台

本地插件和 provider 模块仍然属于可信代码；MingXu 提供的是治理链，不是沙箱隔离。

## 开发与验证

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:dry-run
pnpm audit --prod
```

如果你想快速看阶段状态，建议一起看：

- [docs/plans/development-roadmap.md](docs/plans/development-roadmap.md)
- [CHANGELOG.md](CHANGELOG.md)
