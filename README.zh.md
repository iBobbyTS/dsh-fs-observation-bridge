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

- **多种读取来源**：内置支持 [CodeGraph CLI](https://github.com/colbymchenry/codegraph)、[CodeGraph MCP](https://github.com/CC19990113/dsh-plugin-codegraph)、保守的 Bash shell-read 语法，以及 Windows `pwsh` 上保守的 PowerShell shell-read 语法。
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

`shell-read` transport 识别两套小型确定性语法：POSIX 主机上的 Bash，以及 Windows 主机上的 PowerShell（`pwsh`）。它与 CodeGraph 的 `cli` transport 互斥：一条命令只会被其中一个归一化。

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

### PowerShell 读取（Windows，W0/W1）

只有带 session owner 的普通 foreground `pwsh` 调用才会被观察。persistent PowerShell、后台任务、promoted/timeout 调用以及 PTC 内部调用一律不观察。

| 形式 | 示例 | 输出重建规则 |
| --- | --- | --- |
| `Get-Content file`，`gc`/`cat`/`type` 别名 | `Get-Content .\src\app.ts` | 逐行对象完全一致 |
| `Get-Content file -Raw` | `Get-Content .\app.ts -Raw` | 整个文件字符串，外加宿主的末尾换行 |
| `Get-Content file -TotalCount N` / `-Head N` | `Get-Content .\app.ts -TotalCount 120` | 前 N 个行对象 |
| `Get-Content file -Tail N` | `Get-Content .\app.ts -Tail 50` | 后 N 个行对象 |
| `Get-Content file \| Select-Object -First N` | `... \| Select-Object -First 100` | 前 N 个行对象 |
| `Get-Content file \| Select-Object -Last N` | `... \| Select-Object -Last 50` | 后 N 个行对象 |
| `Get-Content file \| Select-Object -Skip N -First M` | `... \| Select-Object -Skip 200 -First 100` | 第 N+1 至 N+M 个行对象 |
| `Get-Content file \| Select-Object -Index I` | `... \| Select-Object -Index 42` | 单个行对象，0-based |

PowerShell 不是 Bash，使用独立的严格语法解析：

- 只接受 `Get-Content`（或内置别名 `gc`、`cat`、`type`）读取单个字面文件，后接最多一个 `Select-Object` 阶段。
- `-LiteralPath` 会把 `[id]` 等字符视为字面量；位置参数与 `-Path` 保留 PowerShell 通配符语义，因此其中的 `*`、`?`、`[`、`]` 即使加引号也会被拒绝。
- 拒绝：provider 路径（`Env:`、`HKLM:`）、盘符相对路径（`C:file`）、NTFS 备用数据流（`file:stream`）、设备命名空间（`\\?\`、`\\.\`）、`~`、变量与子表达式、数组与逗号、splatting、脚本块、重定向、`;`/`&&`、注释、反引号转义、换行以及参数缩写。
- 拒绝的选项：`-Encoding`、`-Stream`、`-Wait`、`-AsByteStream`、`-Delimiter`、`-ReadCount`、`-Filter`、`-Include`、`-Exclude`、`-Force` 及任何未知参数；`-Raw` 不能与 `-TotalCount`/`-Tail` 或管道组合；`Select-Object` 只接受 `-First`、`-Last`、`-Skip`（需与 `-First` 同用）与 `-Index`，拒绝 `-Property`、`-ExpandProperty`、`-Unique`。

### 为什么 PowerShell 需要重放 stdout

`Get-Content` 每行输出一个字符串对象（行终止符被消费），控制台宿主再为每个格式化对象追加自己的换行；`-Raw` 输出一个完整字符串，宿主再追加一个换行。因此桥接器会用 DSH 自己的 `ctx.fs.readText` 重建预期 stdout，并与结构化 `stdout.text` 比较，只归一化 CRLF/LF。行内容、空行、Tab、行尾空格以及缺失的末尾换行都必须完全一致。Windows PowerShell 5.1 若以传统 ANSI 代码页解码 UTF-8 文件，文本会不同，因此失败关闭（不授权）；空文件只有完整 `Get-Content`/`-Raw` 读取才可观察。

### 授权条件

只有**全部**满足时才会发出 shell-read 观察：

1. 是普通 **foreground** `bash` 或 `pwsh` 调用，且有 session owner。persistent shell、后台、promoted、`job_output`、PTC 内部调用均不支持。
2. `exitCode === 0`，没有 signal/timeout/abort/stopped，没有 sandbox denial 或 runner failure，stderr 为空，stdout/stderr 均未截断；spill 文件不算模型已读。
3. 命令必须是上述形式之一：唯一字面目标文件；除列出的 `|` 外没有 shell 操作符；没有重定向、变量/命令替换、glob、brace expansion 或未引用的 `~`。带引号的 `'[id]/+page.svelte'` 在 Bash 中是合法字面路径；PowerShell 遵循上面的方言规则。
4. Bash 的有效工作目录来自调用的 `workdir`（或 session 目录），并与 Bash 结果的 `cwd` 一致；PowerShell 直接使用结果自身的 `cwd`，因为那是进程真实运行目录。路径始终通过 `ctx.fs` 解析。
5. 目标是普通文本文件且在 `maxSourceBytes` 内；`before = stat`、`readText`、`after = stat` 必须得到同一个 opaque version。
6. 将解析出的 plan 重放到当前文件，结果必须与结构化 stdout **完全相等**，仅允许 CRLF→LF 归一化；禁止 `trim()`、空白压缩或自由片段包含。
7. 最终冻结的工具结果仍包含完整预期 stdout；后续 listener 改写或截断则不发观察。
8. 空输出只允许“完整 `cat`”或“完整 `Get-Content`/`-Raw`”一个空文件。

默认拒绝的例子包括（Bash）`cat f1 f2`、`cat -`、`cat -A`、`head -c`、`tail -f`、复杂 sed 或 `sed -i`、`npx cat`、`ssh host cat f`、`docker exec ... cat f`、`git show HEAD:f`、`rg --files`、任意 Python/Node/awk 脚本、重定向、命令列表和超过两个管道选择阶段；以及（PowerShell）`Get-Content -Wait`、`Get-Content -AsByteStream`、`Get-Content -Raw | Select-Object ...`、`Select-String`、`rg`、`cmd /c type`、路径数组、provider 路径和动态路径。这些刻意不属于低复杂度可信白名单。

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
| `disabledSources` | `[]` | 要禁用的内置 source id，例如 `[codegraph]`、`[shell-read]` 或 `[powershell-read]`；未知 id 会在激活时报错。 |

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
