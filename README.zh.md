# DSH FS Observation Bridge

[English](README.md) | 简体中文

将第三方代码读取工具接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 原生文件观察机制，使 Agent 读取源码后无需重复调用 `read` 即可编辑文件。

## 目录

- [功能特性](#功能特性)
- [设计理念](#设计理念)
- [配置](#配置)
- [安装](#安装)
- [新增 Source](#新增-source)
- [贡献](#贡献)
- [许可证](#许可证)

## 功能特性

- **多种读取来源**：内置支持 [CodeGraph CLI](https://github.com/colbymchenry/codegraph) 和 [CodeGraph MCP](https://github.com/CC19990113/dsh-plugin-codegraph)。
- **可扩展架构**：支持通过适配器接入其他代码读取工具及输入通道。
- **读取验证**：仅根据经过验证的源码读取证据建立文件观察记录。
- **原生安全机制**：保留 DSH 原有的文件版本检查、并发保护及编辑行为。

## 设计理念

**不替代文件编辑机制，只连接代码读取工具与 DSH 原生文件观察系统。**

插件采用三个独立层次：

- **Transport**：统一处理 MCP、CLI、DSH 原生工具等输入通道。
- **Source**：识别特定代码读取工具的调用及源码输出。
- **Observation Core**：验证读取证据，并通过 `fs/observed` 接入 DSH 原生观察机制。

各层独立扩展。新增代码读取工具无需修改核心逻辑，无法验证的读取结果不会获得编辑授权。

并发工具调用按完成顺序建立观察。如果同一文件较旧的观察最后到达，后续编辑会以 `FS_STALE_VERSION` 拒绝（fail-closed），而不是编辑模型未见过的内容。

## 配置

在 profile patch 的插件行 `config` 中设置：

```yaml
- id: fs-observation-bridge
  name: 'dsh-fs-observation-bridge'
  config:
    maxSourceBytes: 8388608
    maxEvidenceFiles: 200
    disabledSources: []
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxSourceBytes` | `8388608`（8 MiB） | 校验 snippet 时读取的文件上限；更大的文件跳过校验（不授权）。 |
| `maxEvidenceFiles` | `200` | 单次工具结果最多校验的文件数。 |
| `disabledSources` | `[]` | 要禁用的内置 source id，例如 `[codegraph]`；未知 id 会在激活时报错。 |

## 安装

在 DSH 插件管理器中以 bundle 方式安装本包（`plugin_manager` 的 `install_bundle`，target 指向本包的绝对路径）。bundle 通过 `dsh.bundle.patch` 插入一条 `fs-observation-bridge` 行，并保留原生 `fs-observation-policy` 启用。

## 新增 Source

Source 以代码形式内置在项目中，而不是运行时注册。新增一个 Source 是一次聚焦的贡献：

1. 新增 `lib/sources/<tool>.js`，导出 `{ id, accepts, extract, resolveRoot? }`。
2. `extract(invocation)` 返回 `[{ path, root?, snippets: [{ text, startLine?, endLine? }] }]`；snippets 必须是工具输出中真实出现过的源码。
3. 在 `lib/index.js` 的 `createSourceRegistry([...])` 中注册。
4. 补充解析与 evidence 测试；bridge core 和 transport 不需要改动。

无法提供可验证 snippets 的 Source 不会获得任何编辑授权。

## 贡献

欢迎提交 Issue 和 Pull Request，尤其欢迎为其他代码读取工具添加适配器。

- **Source Adapter**：支持新的代码读取工具，例如 Graphify、Serena 等。
- **Transport Adapter**：支持 MCP、CLI 和 DSH 原生工具之外的输入通道。
- **测试与改进**：完善兼容性、并发安全及读取验证。

所有贡献应保留 DSH 原生文件观察与编辑安全语义。

## 许可证

MIT。
