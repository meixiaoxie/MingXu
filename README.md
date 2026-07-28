# mingxu

一个最小化的 TypeScript Agent Runtime 骨架。它现在已经支持：

- 旧版单模型配置
- 新版多模型配置
- provider 默认参数
- provider 别名（alias）
- 自定义 provider 模块动态加载

这份文档重点讲**新配置结构怎么用**。

## 先理解这套配置在做什么

可以把新配置理解成三层：

1. **`models`**：你要用哪些“模型档案”
   - 比如：默认聊天模型、便宜模型、内部网关模型
2. **`providers`**：这些模型背后连的是哪些“厂家/连接方式”
   - 比如：Anthropic、OpenAI、公司内部别名
3. **`customProviders`**：要不要从你自己的模块里，动态注册新的 provider

而 **`defaultModel`** 就像“默认开哪辆车”。

---

## 最小可用样例

这是最小的新配置结构：

```json
{
  "defaultModel": "primary",
  "models": {
    "primary": {
      "provider": "anthropic",
      "model": "claude-sonnet-5",
      "apiKey": "test-key"
    }
  }
}
```

它的意思是：

- 默认模型叫 `primary`
- `primary` 这份档案使用 `anthropic`
- 实际模型名是 `claude-sonnet-5`

如果你只需要一个模型，这已经够用了。

---

## 旧版配置仍然兼容

旧版写法仍然可用：

```json
{
  "model": {
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "apiKey": "test-key"
  }
}
```

运行时会自动把它归一化成新版结构，大致等价于：

- `defaultModel = "default"`
- `models.default = model`

所以老配置不用立刻全改。

---

## 推荐的新配置结构

如果你以后要支持多个模型，推荐这样写：

```json
{
  "name": "mingxu",
  "systemPrompt": "You are a helpful agent.",
  "defaultModel": "primary",
  "models": {
    "primary": {
      "provider": "anthropic",
      "model": "claude-sonnet-5"
    },
    "cheap": {
      "provider": "openai",
      "model": "gpt-4.1-mini"
    }
  },
  "maxIterations": 10,
  "plugins": []
}
```

这表示：

- 默认用 `primary`
- `primary` 走 Anthropic
- `cheap` 走 OpenAI

---

## `providers`：给内建 provider 起别名

如果你不想直接把模型写成 `openai`，而想写成你自己的业务名字，可以用 `providers`。

```json
{
  "defaultModel": "assistant",
  "models": {
    "assistant": {
      "provider": "company-chat-2026",
      "model": "gpt-4.1"
    }
  },
  "providers": {
    "company-chat-2026": "openai"
  }
}
```

这表示：

- `company-chat-2026` 只是你自己起的别名
- 它最终会映射到内建的 `openai` adapter

### 这条规则目前要注意

- alias 会自动去掉首尾空格
- alias **区分大小写**
- alias 只能直接指向一个已注册的正式 provider
- 不支持 alias 再指向另一个 alias

---

## provider 默认参数：把公共连接配置放到 `providers`

如果多个模型共用同一套连接参数，可以把默认值放在 `providers` 里。

```json
{
  "defaultModel": "assistant",
  "models": {
    "assistant": {
      "provider": "openai",
      "model": "gpt-4.1"
    },
    "summarizer": {
      "provider": "openai",
      "model": "gpt-4.1-mini"
    }
  },
  "providers": {
    "openai": {
      "apiKey": "test-key",
      "baseUrl": "https://api.openai.com/v1/chat/completions"
    }
  }
}
```

这表示：

- 两个模型都走 `openai`
- 它们默认共用同一个 `apiKey` 和 `baseUrl`

### 覆盖规则

- `providers` 里的是**默认值**
- `models.<name>` 里的是**最终值**
- 如果同一个字段两边都写了，**模型级配置优先**

---

## `customProviders.module`：一次性加载一个自定义 provider 模块

如果你想在启动时动态注册自定义 provider，可以这样写：

```json
{
  "defaultModel": "gateway-model",
  "models": {
    "gateway-model": {
      "provider": "gateway",
      "model": "internal-chat"
    }
  },
  "customProviders": {
    "module": "./providers/register-gateway.mjs"
  }
}
```

这里的 `./providers/register-gateway.mjs` 是一个本地 ESM 文件。

### 模块最小格式

支持这两种写法：

#### 具名导出

```js
export function register(registry) {
  registry.register({
    provider: "gateway",
    capabilities: {
      supportsTools: true,
      supportsStreaming: false,
      supportsImages: false,
      supportsStructuredOutput: true,
      supportsRefusal: true,
      supportsFallback: false,
      supportsEffort: false,
      supportsPromptCaching: false,
      supportsMidConversationSystem: false,
      maxContext: 128000,
      maxOutput: 8192
    },
    create(config) {
      return {
        provider: "gateway",
        capabilities: this.capabilities,
        async generate(request) {
          return {
            text: `custom:${request.modelId}`,
            toolCalls: []
          }
        }
      }
    }
  })
}
```

#### 默认导出

```js
export default function register(registry) {
  // 同上
}
```

### 这条路径怎么解析

- 相对路径是**相对于配置文件所在目录**解析的
- 不是相对于你运行命令时所在目录解析的

这点很重要，能避免“换个命令目录就找不到模块”的问题。

---

## `customProviders.<name>`：按名字声明自定义 provider 默认值

除了共享 `module`，你也可以按 provider 名写默认配置：

```json
{
  "defaultModel": "gateway-model",
  "models": {
    "gateway-model": {
      "provider": "gateway",
      "model": "internal-chat",
      "apiKey": "model-level-key"
    }
  },
  "customProviders": {
    "gateway": {
      "module": "./providers/register-gateway.mjs",
      "baseUrl": "https://gateway.example.com/v1/chat/completions",
      "apiKey": "provider-level-key"
    }
  }
}
```

这里表示：

- `gateway` 这个 provider 由本地模块注册
- `customProviders.gateway` 提供 provider 级默认参数
- `models.gateway-model` 可以继续覆盖其中某些字段

---

## 一份更完整的样例

下面这份样例同时展示：

- 新版命名模型
- provider 默认参数
- alias
- custom provider 模块

```json
{
  "name": "mingxu",
  "systemPrompt": "You are a helpful agent.",
  "defaultModel": "assistant",
  "models": {
    "assistant": {
      "provider": "work-openai",
      "model": "gpt-4.1"
    },
    "fallback": {
      "provider": "anthropic",
      "model": "claude-sonnet-5",
      "apiKey": "anthropic-key"
    },
    "gateway-model": {
      "provider": "gateway",
      "model": "internal-chat"
    }
  },
  "providers": {
    "work-openai": "openai",
    "openai": {
      "apiKey": "openai-key",
      "baseUrl": "https://api.openai.com/v1/chat/completions"
    }
  },
  "customProviders": {
    "module": "./providers/register-gateway.mjs",
    "gateway": {
      "module": "./providers/register-gateway.mjs",
      "baseUrl": "https://gateway.example.com/v1/chat/completions",
      "apiKey": "gateway-key"
    }
  },
  "maxIterations": 10,
  "plugins": []
}
```

---

## 运行方式

假设你的配置文件叫 `mingxu.config.json`：

```bash
pnpm build
```

```bash
node dist/cli/entry.js --config mingxu.config.json "Say hello"
```

如果你已经全局或本地通过 bin 运行：

```bash
mingxu --config mingxu.config.json "Say hello"
```

### 临时切换到另一个已配置模型

如果你的 `models` 里配置了多个模型条目，可以用 `--model <key>` 在这一次命令里临时切换。

例如配置里有：
- `primary`
- `backup`

那么可以这样运行：

```bash
node dist/cli/entry.js --config mingxu.config.json --model backup "Say hello"
```

这里的 `backup` 指的是 `models.backup` 这个**配置项名字**，不是底层真实模型 ID（例如 `claude-sonnet-5` 或 `gpt-4.1`）。

如果不传 `--model`，CLI 仍然会使用 `defaultModel`。

---

## 建议你怎么选写法

### 场景 1：只有一个模型
推荐先用最小新版结构：

```json
{
  "defaultModel": "primary",
  "models": {
    "primary": {
      "provider": "anthropic",
      "model": "claude-sonnet-5"
    }
  }
}
```

### 场景 2：多个模型，共享连接配置
用：
- `models`
- `providers`

### 场景 3：给内建 provider 起业务名字
用：
- `providers` 里的字符串 alias

### 场景 4：你自己写 provider 模块
用：
- `customProviders.module`
- 可选 `customProviders.<name>` 默认值

---

## 当前已知限制

这套结构现在已经可用，但仍有几条明确限制：

- alias **区分大小写**
- alias 不支持链式映射
- alias 只能指向已注册的正式 provider
- 动态模块只支持**本地 ESM 文件**
- 动态模块必须导出默认或具名 `register` 函数

这些是当前版本的明确边界，不是偶然行为。
