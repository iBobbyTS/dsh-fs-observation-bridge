# DSH FS Observation Bridge

[English](README.md) | 简体中文

将第三方代码读取工具接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 原生文件观察机制，使 Agent 读取源码后无需重复调用 `read` 即可编辑文件。

## 目录

- [功能特性](#功能特性)
- [设计理念](#设计理念)
- [支持的 Shell 读取](#支持的-shell-读取)
- [配置](#配置)
- [安装](#安装)
- [新增 Source](#新增-source)
- [贡献](#贡献)
- [许可证](#许可证)

## 功能特性

- **多种读取来源**：内置支持 [CodeGraph CLI](https://github.com/colbymchenry/codegraph)、[CodeGraph MCP](https://github.com/CC19990113/dsh-plugin-codegraph)，以及一个保守的 Bash shell-read 语法。
- **可扩展架构**：支持通过适配器接入其他代码读取工具及输入通道。
- **读取验证**：仅根据经过验证、且模型真实可见的源码读取证据建立文件观察记录。
- **原生安全机制**：保留 DSH 原有的文件版本检查、并发保护及编辑行为。

## 设计理念

**不替代文件编辑机制，只连接代码读取工具与 DSH 原生文件观察系统。**

插件采用三个独立层次：

- **Transport**：统一处理 MCP、CLI、shell-read、DSH 原生工具等输入通道。
- **Source**：识别特定代码读取工具的调用，提取或重放源码证据。
- **Observation Core**：验证读取证据，并通过 `fs/observed` 接入 DSH 原生观察机制。

各层独立扩展。新增代码读取工具无需修改核心逻辑，无法验证的读取结果不会获得编辑授权。

并发工具调用按完成顺序建立观察。如果同一文件较旧的观察最后到达，后续编辑会以 `FS_STALE_VERSION` 拒绝（fail-closed），而不是编辑模型未见过的内容。

`fs/observed` 是**整文件级、带版本的观察**，与 DSH 原生 `read offset/limit` 一致：受信的局部视图在版本未变时也授权后续全文件编辑。本插件不新增覆盖范围策略，只向原生 policy 提供受信观察。

## 支持的 Shell 读取

`shell-read` transport 只识别一小套确定性的 Bash 语法，并与 CodeGraph 的 `cli` transport 互斥：一条命令只会被其中一个归一化。

### 默认启用（P0）

| 形式 | 示例 | 输出重建规则 |
| --- | --- | --- |
| `cat file` / `cat -- file` | `cat src/app.ts` | 逐字全文比较 |
| `head file` / `head -n N file` / `head -N file` | `head -n 80 src/app.ts` | 前 N 行（默认 10） |
| `tail file` / `tail -n N file` | `tail -n 50 src/app.ts` | 末尾 N 行（默认 10） |
| `tail -n +N file` | `tail -n +522 README.md` | 从第 N 行到文件结尾 |
| `sed -n 'Np' file` | `sed -n '42p' src/app.ts` | 单行 |
| `sed -n 'N,Mp' file` | `sed -n '40,120p' src/app.ts` | 包含端点的闭区间 |
| `sed -n 'N,$p' file` | `sed -n '40,$p' src/app.ts` | 从第 N 行到文件结尾 |

### 行号与管道（P1）

管道由一个 reader（不带编号的 `cat`、`nl -ba` 或 `sed`）后接**最多两个** `head`/`tail`/`sed`/`nl` 阶段组成。`nl` 最多出现一次，四段及以上拒绝。

| 形式 | 示例 |
| --- | --- |
| `cat -n file` / `cat -b file` | 编号全部行 / 仅编号非空行 |
| `nl -ba file` | 编号全部行 |
| `cat file \| head -n N` | `cat app.ts \| head -n 80` |
| `cat file \| tail -n N` | `cat app.ts \| tail -n 80` |
| `cat file \| sed -n 'N,Mp'` | `cat app.ts \| sed -n '20,80p'` |
| `cat file \| nl -ba` | 为整个文件编号 |
| `cat file \| head -n N \| tail -n M` | 在前缀中再取窗口 |
| `cat file \| sed -n 'N,Mp' \| nl -ba` | 先选取，再从 1 编号 |
| `cat file \| nl -ba \| sed -n 'N,Mp'` | 先编号，再选取 |
| `nl -ba file \| sed -n 'N,Mp'` | 先编号，再选取 |
| `sed -n 'N,Mp' file \| nl -ba` | 先选取，再从 1 编号 |

### 授权条件

只有**全部**满足时才会发出 shell-read 观察：

1. 是普通 **foreground** `bash` 调用，且有 session owner。persistent shell、后台、promoted、`job_output`、PTC 内部调用均不支持。
2. `exitCode === 0`，没有 signal/timeout/abort/stopped，没有 sandbox denial 或 runner failure，stderr 为空，stdout/stderr 均未截断；spill 文件不算模型已读。
3. 命令必须是上述形式之一：唯一字面目标文件；除列出的 `|` 外没有 shell 操作符；没有重定向、变量/命令替换、glob、brace expansion 或未引用的 `~`。带引号的 `'[id]/+page.svelte'` 是合法字面路径；未引用的 `[id]/+page.svelte` 会被拒绝。
4. 有效工作目录来自调用的 `workdir`（或 session 目录），并与 Bash 结果的 `cwd` 一致；路径通过 `ctx.fs` 解析。
5. 目标是普通文本文件且在 `maxSourceBytes` 内；`before = stat`、`readText`、`after = stat` 必须得到同一个 opaque version。
6. 将解析出的 plan 重放到当前文件，结果必须与结构化 stdout **完全相等**，仅允许 CRLF→LF 归一化；禁止 `trim()`、空白压缩或自由片段包含。
7. 最终冻结的工具结果仍包含完整预期 stdout；后续 listener 改写或截断则不发观察。
8. 空输出只允许“完整 `cat` 一个空文件”。

默认拒绝的例子包括 `cat f1 f2`、`cat -`、`cat -A`、`head -c`、`tail -f`、复杂 sed 或 `sed -i`、`npx cat`、`ssh host cat f`、`docker exec ... cat f`、`git show HEAD:f`、`rg --files`、任意 Python/Node/awk 脚本、重定向、命令列表和超过两个管道选择阶段。这些刻意不属于低复杂度可信白名单。

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
| `maxSourceBytes` | `8388608`（8 MiB） | 校验证据时读取的文件上限；更大的文件跳过校验（不授权）。 |
| `maxEvidenceFiles` | `200` | 单次工具结果最多校验的文件数。 |
| `disabledSources` | `[]` | 要禁用的内置 source id，例如 `[codegraph]` 或 `[shell-read]`；未知 id 会在激活时报错。 |

## 安装

在 DSH 插件管理器中以 bundle 方式安装本包（`plugin_manager` 的 `install_bundle`，target 指向本包的绝对路径）。bundle 通过 `dsh.bundle.patch` 插入一条 `fs-observation-bridge` 行，并保留原生 `fs-observation-policy` 启用。

## 新增 Source

Source 以代码形式内置在项目中，而不是运行时注册。新增一个 Source 是一次聚焦的贡献：

1. 新增 `lib/sources/<tool>.js`，导出 `{ id, accepts, extract, resolveRoot? }`。
2. `extract(invocation)` 返回 evidence 数组。基于 snippet 的项为 `{ path, root?, snippets: [{ text, startLine?, endLine? }] }`；精确输出型的项为 `{ path, expectedStdout, verify(content), stable, permitEmpty }`，其中 `verify` 必须能从当前文件内容重放出可见输出。
3. 在 `lib/index.js` 的 `createSourceRegistry([...])` 中注册。
4. 补充解析与 evidence 测试；同一 transport 下新增 source 不需要改动 bridge core。

无法提供可验证输出的 Source 不会获得任何编辑授权。

## 贡献

欢迎提交 Issue 和 Pull Request，尤其欢迎为其他代码读取工具添加适配器。

- **Source Adapter**：支持新的代码读取工具，例如 Graphify、Serena 等。
- **Transport Adapter**：支持 MCP、CLI、shell-read 和 DSH 原生工具之外的输入通道。
- **测试与改进**：完善兼容性、并发安全及读取验证。

所有贡献应保留 DSH 原生文件观察与编辑安全语义。

## 许可证

MIT。
