# MingXu

> 版本：0.4.0

MingXu 是一个通用 Agent 大脑。
它负责模型运行、上下文、Memory、Session、policy / approval / audit / budget / abort、MCP、Subagent 和扩展治理。
默认安装不带文件读取、命令执行、联网搜索、PDF、浏览器、数据库这些“手脚”，这些能力需要通过插件或 MCP 按需接入。

## 现在能做什么

- 交互聊天：`mingxu`、`mingxu chat`
- 单轮执行：`mingxu --prompt "..."` 或直接传位置参数
- 恢复会话：`mingxu resume <session-id>`、`mingxu --continue`
- 配置与诊断：`mingxu init --global`、`mingxu init --project`、`mingxu doctor`
- 扩展管理：`mingxu extensions inspect/add/update/enable/disable/remove/list/doctor/init`
- 面板入口：`/context`、`/extensions`、`/agents`、`/audit`、`/trust`、`/preset`、`/compact`、`/steer`

## 怎么安装

先在仓库里构建，再做全局安装：

```powershell
pnpm install --frozen-lockfile
pnpm build
npm install -g .
```

Windows 上有两种启动方式：

- PowerShell 允许脚本时：直接用 `mingxu`
- PowerShell 脚本被策略拦截时：用 `mingxu.cmd`

如果你看到 “无法加载 mingxu.ps1，因为在此系统上禁止运行脚本”，那就直接切到 `mingxu.cmd`，不用改 ExecutionPolicy。

## 怎么接 AI

MingXu 支持这些 provider：

- `anthropic`
- `openai`
- `openai-compatible`
- `deepseek`
- `gemini`

最常见的方式是把 API Key 放到环境变量，再在配置里用 `env:NAME` 引用它。

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
      "apiKey": "env:DEEPSEEK_API_KEY",
      "baseUrl": "https://api.deepseek.com"
    }
  }
}
```

如果你要走 OpenAI 兼容接口，可以把 provider 设为 `openai-compatible`，再改 `baseUrl`。

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

## 怎么启动

如果你已经安装到全局：

```powershell
mingxu.cmd
```

或者显式进入聊天模式：

```powershell
mingxu.cmd chat
```

单轮执行：

```powershell
mingxu.cmd --prompt "帮我总结这个仓库"
```

恢复会话：

```powershell
mingxu.cmd sessions
mingxu.cmd resume <session-id> --prompt "继续这个会话"
mingxu.cmd --continue
```

## 怎么用 extensions

`extensions` 是当前版本的本地扩展管理入口。
它负责检查、安装、更新、启用、停用和删除本地插件包。

常用命令：

```powershell
mingxu.cmd extensions inspect .\packages\coding-tools
mingxu.cmd extensions add .\packages\coding-tools --scope user --yes
mingxu.cmd extensions update mingxu-coding-tools .\packages\coding-tools --yes
mingxu.cmd extensions list
mingxu.cmd extensions enable mingxu-coding-tools
mingxu.cmd extensions disable mingxu-coding-tools
mingxu.cmd extensions remove mingxu-coding-tools
mingxu.cmd extensions doctor
mingxu.cmd extensions init .\my-extension
```

如果是在非 TTY 或 CI 场景里安装，通常要加 `--yes`，避免交互确认卡住流程。

安装后可以进交互界面再输入：

```powershell
mingxu.cmd
```

然后在聊天里输入：

```text
/extensions
```

这样就能看到当前已加载的扩展。

## 当前边界

现在的 0.4 目标是“扩展安装与治理闭环”。
已经完成的主要部分有：

- `@mingxu/plugin-sdk` 独立协议包骨架
- `@mingxu/coding-tools` 独立官方编码插件骨架
- `@mingxu/web-search` 独立联网搜索插件骨架
- CLI 的 `extensions` 命令树
- `extensions` 的本地安装、更新、启用、停用、删除和诊断流
- Windows `mingxu.cmd` 的真实安装与启动说明

还没完成的部分有：

- 插件市场
- 远程 registry
- 自动安装
- 第三方生态 adapter 的完整接入
- 更完整的搜索后端和官方编码工具执行器

MingXu 提供的是治理层，不是沙箱。
本地插件和 provider 模块仍然属于可信代码，真正的能力边界要靠 manifest、权限、policy、approval 和 audit 共同约束。

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

- [CHANGELOG.md](CHANGELOG.md)
