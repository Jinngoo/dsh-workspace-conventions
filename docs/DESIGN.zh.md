---
description: "可组合的工作区记忆行：按工作区持久化记忆，在既有 WorkBuddy 体系存在时保持兼容，面向配置或调试 agent 记忆的使用者与维护者。"
kind: "package-reference"
---

# @jinngoo/dsh-workspace-memory

[English](README.md) | 中文

## 概述

`dsh-workspace-memory` 让 agent 在它正在工作的那个工作区里拥有持久记忆。preset 只需挂载这一行，加入该作用域的每个会话都读写**自己**工作目录下的记忆，因此换工作区就换记忆，无需任何配置。支持两种后端且自动选择：工作区已存在 WorkBuddy 记忆体系（`.workbuddy/memory`）时，本行以该体系的原生形态读写并执行它自己的写入准则；否则使用 DSH 默认（`.dsh/memory`），两者共享「索引 + 日期分片」的同一形态，模型在两种模式下的行为完全一致。本行不发布任何服务——它只消费 `fs`、`agents`、`systemPrompt`、`sandboxPolicy`——因此可直接挂在 preset 中，无需 `isolate` realm。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 preset 组合中挂载本行，即可让该 preset 的会话获得工作区记忆。它需要 agent 作用域：它注册的每个工具都在调用时解析发起会话的工作目录，prompt 段落注册在挂载上下文的作用域内。

### 配置

```yaml
- id: workspace-memory
  name: '@jinngoo/dsh-workspace-memory'
  config:
    indexPromptBytes: 7000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `indexPromptBytes` | `7000` | 每轮注入 prompt 的索引文本字节上限；其余部分仍可通过 `memory_read` 读取。 |

### 它贡献的工具

| 工具 | 用途 |
|---|---|
| `memory_status` | 报告生效后端、解析出的路径、索引大小与可用的日期流水。 |
| `memory_read` | 读取索引（`layer=index`）或某一天的流水（`layer=ledger`）。 |
| `memory_search` | 在索引与所有流水中做大小写不敏感的字面子串检索。 |
| `memory_write` | 经准入审查后，向当日流水追加一条持久条目。 |
| `memory_promote` | 在指定章节下向索引加入一行，使其每轮都被注入。 |
| `memory_help` | 说明当前生效的写入准则与准入策略。 |

### 后端选择

按目录是否存在选择，且两者并存时 WorkBuddy 优先：

| 工作区包含 | 生效后端 | 存储根 |
|---|---|---|
| `.workbuddy/memory/` | `workbuddy`（兼容） | `.workbuddy/memory/` |
| 都没有，或只有 `.dsh/memory/` | `dsh-default` | `.dsh/memory/` |

<a id="understand-the-implementation"></a>
## 理解实现

### 三层

两种后端共用一套模型。索引是唯一常驻上下文的部分；流水是可检索的记录；证据留在本来就拥有它的文档与代码里。

| 层 | 文件 | 生命周期 | 内容 |
|---|---|---|---|
| 索引 | `MEMORY.md` | 每轮注入 | 硬约束、稳定偏好、长期约定、文档指针 |
| 流水 | `YYYY-MM-DD.md` | 追加式，按需读取 | 需要留档但不必常驻的持久事实 |
| 证据 | 它本来所在之处 | — | 文档与代码；索引只留指针，不复述内容 |

### 准入是一等步骤

记忆系统的主要失效模式不是「存得太少」，而是「存得太多」：无节制增长的索引会污染每一轮的上下文。因此每次写入流水前都会先跑 `evaluateEntry`。硬性拒绝——密钥、私钥材料、PII、空或近乎空的内容——无法被绕过。软性提醒（主要是「这读起来像一次性流水账」）会**拒绝一次**并要求显式 `force`，这正是调用方把该行改写成持久结论的机会。

### 两个承重约束

**prompt provider 必须是同步的。** `systemPrompt.context()` 注册的 provider 在组装期间计算文本，而 `assemble()` 调用它时不会 await。`async` provider 返回的是 Promise 而非字符串，会让每一轮都失败。因此本行把每个工作区的探测异步写进缓存，provider 再同步渲染该缓存。某个工作区的第一轮会显示一条预热提示；`agent/created` 会预先预热，所以正常会话立刻就能看到内容。

**写入必须带上会话的沙箱策略。** `fs.writeText` 调用时传入 `sandboxPolicy.resolve({ session })`。没有 session 时，沙箱会退回部署默认的 workspace root 而不是该会话自己的 cwd，从而拒绝写入它自己的那个工作区。

### 章节层级判定

`MEMORY.md` 的写法并不统一。WorkBuddy 的原生布局是孤立的一级文档标题加二级章节（`## 一、…`），而没有标题的文档会直接从最浅的标题开始。`detectSectionLevel` 把「只出现一次且比其余标题都浅」的那一层视为文档标题，因此 `memory_promote` 会插进预期的章节，而不会多出一个幽灵章节。

### 日期流水的布局

WorkBuddy 的日期流水有两种真实布局：平铺在记忆目录下（`memory/YYYY-MM-DD.md`），或按计算机名分目录（`memory/<计算机名>/YYYY-MM-DD.md`）。没有配置项声明用的是哪一种，因此 `scanLedgers` 只依据目录自身的形状判断——子目录里出现日期文件即视为「按机器分目录」，与本机同名的子目录（精确同名优先，其次忽略大小写）即使还没写日期文件也算。写入位置由 `ledgerWritePath` 给出：分目录时新流水进本机目录，平铺时进记忆目录根。读取某一天由 `ledgerForDate` 定优先级——本机、记忆目录根，最后才是其他机器唯一命中的那一份，因此同一天在两台机器上都有记录时不会猜错机器。检索不受布局影响：索引与全部机器的流水都会被搜到。

<a id="further-exploration"></a>
## 进一步探索

- [System prompt 子系统](../../../docs/subsystems/system-prompt.zh.md) —— 运行时上下文 provider 如何注册与组装。
- [Agent presets 子系统](../../../packages/preset/agent-preset/README.zh.md) —— preset 如何挂载本行，会话如何加入其作用域。
- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md) —— `FsTarget` 解析与沙箱策略接缝。

-----

<a id="model-experience"></a>
## 模型体验

### workspace-memory 上下文段落

#### 模型看到的内容

一条名为 `workspace-memory`、order 为 `60` 的运行时上下文条目，包含解析出的工作区路径、生效后端与模式、记忆目录与索引路径、最近三个流水日期、当前生效的写入准则，以及不超过 `indexPromptBytes` 的索引文本。工作区的第一轮只带一条预热提示。

#### Token 影响

每轮固定增加「准则块 + 至多 `indexPromptBytes` 字节索引文本」的开销，对挂载作用域内的每个会话、每个请求都生效。这是本行唯一无条件施加的成本；流水与工具 schema 是其余部分。

#### KV Cache 影响

当索引文本、准则与工具 schema 不变时前缀稳定。一次 `memory_promote` 写入会重写索引，因而使该段落起往后的缓存前缀失效；流水写入不改变该文本，前缀保持稳定。

### 记忆工具

#### 模型看到的内容

六个工具 schema，无论是否使用记忆，每个请求都会出现。`memory_write` 在其描述里写明准入准则，因此准则被表述两次：一次作为上下文段落中的散文，一次在使用点上。

#### Token 影响

六个 schema 带来固定的每请求开销。结果以 JSON 文本返回：`memory_read` 读取大流水时默认截取尾部 200 行，`memory_search` 对命中条数设上限。

#### KV Cache 影响

本行挂载期间 schema 稳定。工具调用历史与结果作为普通对话 token 累积。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了本行不适用的场景。它们是当前的包约束，不是任务清单。

- **仅限工作区作用域** —— 没有全局或跨工作区记忆。后端解析返回的是 `(scope, backend)` 条目列表，读写编排按该列表编写，这即为预留接缝：新增 `global` 后端是纯增量的，但目前不附带任何全局存储。
- **并发是尽力而为** —— 流水追加与索引插入都是整文件的读—改—写。两个会话在同一瞬间写同一工作区可能丢失一次写入。这里没有锁，本行也不声称原子追加。
- **一轮预热** —— prompt provider 无法 await，因此缓存未命中的工作区会先渲染一轮预热提示，之后才出现真实内容。
- **索引注入是硬性字节上限** —— 过大的 `MEMORY.md` 在 prompt 中会被截断，模型必须调用 `memory_read` 才能看到其余部分。没有任何自动摘要。
- **按存在性选择后端** —— 生效后端取决于 `.workbuddy/memory` 是否存在。会话中途创建该目录会在下次探测时切换后端，而已写入 `.dsh/memory` 的记忆不会被迁移。
- **流水布局是探测出来的** —— 布局同样取决于目录当前形状：出现装着日期文件的计算机名子目录即切到「按本机目录读写」，子目录清空后回落平铺。计算机名取 `hostname` 输出，大小写不敏感地复用已有目录。
- **无删除与清理** —— 条目只能新增，无法通过工具移除或过期。流水按日期增长，且只会被追加。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者背景信息 —— 点击展开</summary>

`@jinngoo/dsh-workspace-memory` 作为挂载它的 preset 的依赖发布。它只消费 host 平面服务，因此**不得**包裹在 `isolate` realm 中：它需要的每一项能力——文件系统、agent 注册表、prompt 注册表、沙箱策略——都不属于某个单独会话。

`inject` 列表列出了全部五个服务，因此缺少任一项的组合会在挂载时直接报错，而不是静默地什么都不贡献。

</details>
