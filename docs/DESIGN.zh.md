---
description: "可组合的工作区约定行：按工作区持久化记忆，并在既有 WorkBuddy 体系存在时按原生语义兼容它的记忆、规则与技能，面向配置或调试 agent 工作区约定的使用者与维护者。"
kind: "package-reference"
---

# @jinngoo/dsh-workspace-conventions

[English](DESIGN.md) | 中文

## 概述

`dsh-workspace-conventions` 让 agent 在它正在工作的那个工作区里拥有持久记忆、行为规则与可复用技能。挂载作用域只需挂载这一行，其下每个会话都读写**自己**工作目录下的内容，因此换工作区就换全部约定，无需任何配置。

三层都遵循同一条原则：**工作区已经存在 WorkBuddy 体系时，按那个体系的原生形态与语义工作；否则退到 DSH 的默认位置与同一套模型。** 之所以必须这样做，是因为 DSH 自身不认识 `.workbuddy/`：

- DSH 唯一的「工作区指令」通道是 `@deepseek-ai/dsh-agent-instructions`，它只按**同目录文件名候选**加载 `AGENTS.md` / `CLAUDE.md`（外加 `AGENTS.local.md` / `CLAUDE.local.md`）。候选名不得含路径分隔符，所以 `.workbuddy/rules/` 这种目录式规则**无法用配置表达**；DSH 也没有 Cursor 那样的 `alwaysApply` / `paths` / glob 规则机制。
- DSH 的技能由 `@deepseek-ai/dsh-skill-filesystem` 扫描 `<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills`、`customSkillDirs`、`<dshHome>/skills`、`<agentsHome>/skills`。`.workbuddy/skills/` 不在其中。

| 层 | WorkBuddy 源 | DSH 回退 | 抵达模型的方式 |
|---|---|---|---|
| 记忆 | `.workbuddy/memory/` | `.dsh/memory/` | prompt 段落 + 6 个工具 |
| 规则 | `.workbuddy/rules/*.md` | —（无源即不注入） | prompt 段落 + 2 个工具 |
| 技能 | `.workbuddy/skills/` | —（无源即无候选） | 注册进 `ctx.skills` 的原生 provider |

本行不发布任何服务——它只消费 `fs`、`agents`、`systemPrompt`、`sandboxPolicy`、`tools`、`skills`——因此可直接挂在 preset 中，无需 `isolate` realm。

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

在 profile 里挂载本行（本包自带的 cordis patch 就是插在 profile 的层栈上），即可让该 profile 的会话获得工作区记忆、规则与技能。它需要 agent 作用域：它注册的每个工具都在调用时解析发起会话的工作目录，prompt 段落注册在挂载上下文的作用域内。把同一行挂在某个 preset 里也是合法的——那样生效范围就收窄到该 preset 的会话。

### 配置

```yaml
- id: workspace-conventions
  name: '@jinngoo/dsh-workspace-conventions'
  config:
    indexPromptBytes: 7000
    rulesPromptBytes: 49152
    ruleFileBytes: 16384
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `indexPromptBytes` | `7000` | 每轮注入 prompt 的索引文本字节上限；其余部分仍可通过 `memory_read` 读取。 |
| `rulesPromptBytes` | `49152` | 整个规则段落（常驻册 + 已触发条件册 + 未触发清单 + 说明）的字节上限。这是防病态 rules 目录的护栏而非配额：册子本身更小时只按实际花费计。 |
| `ruleFileBytes` | `16384` | 单册字节上限，对齐 WorkBuddy 自己约 16 KB 的契约。 |

### 它贡献的工具

| 工具 | 用途 |
|---|---|
| `memory_status` | 报告生效后端、解析出的路径、索引大小与可用的日期流水。 |
| `memory_read` | 读取索引（`layer=index`）或某一天的流水（`layer=ledger`）。 |
| `memory_search` | 在索引与所有流水中做大小写不敏感的字面子串检索。 |
| `memory_write` | 经准入审查后，向当日流水追加一条持久条目。 |
| `memory_promote` | 在指定章节下向索引加入一行，使其每轮都被注入。 |
| `memory_help` | 说明当前生效的写入准则与准入策略。 |
| `rule_status` | 报告 `.workbuddy/rules/` 的册子清单、分类、触发 glob 与已触发状态。 |
| `rule_read` | 读取一册规则的完整正文（绕过 16 KB 注入上限）。 |

技能**没有**专属工具：它们进入原生 skill 目录，由标准 `skill` 工具加载。

### 记忆后端选择

按目录是否存在选择，且两者并存时 WorkBuddy 优先：

| 工作区包含 | 生效后端 | 存储根 |
|---|---|---|
| `.workbuddy/memory/` | `workbuddy`（兼容） | `.workbuddy/memory/` |
| 都没有，或只有 `.dsh/memory/` | `dsh-default` | `.dsh/memory/` |

规则与技能只有 WorkBuddy 一源：没有 `.workbuddy/rules/` 就没有规则段落，没有 `.workbuddy/skills/` 就没有技能候选，不会退到别处去找。

<a id="understand-the-implementation"></a>
## 理解实现

### 三层

记忆两层后端共用一套模型。索引是唯一常驻上下文的部分；流水是可检索的记录；证据留在本来就拥有它的文档与代码里。

| 层 | 文件 | 生命周期 | 内容 |
|---|---|---|---|
| 索引 | `MEMORY.md` | 每轮注入 | 硬约束、稳定偏好、长期约定、文档指针 |
| 流水 | `YYYY-MM-DD.md` | 追加式，按需读取 | 需要留档但不必常驻的持久事实 |
| 证据 | 它本来所在之处 | — | 文档与代码；索引只留指针，不复述内容 |

### 准入是一等步骤

记忆系统的主要失效模式不是「存得太少」，而是「存得太多」：无节制增长的索引会污染每一轮的上下文。因此每次写入流水前都会先跑 `evaluateEntry`。硬性拒绝——密钥、私钥材料、PII、空或近乎空的内容——无法被绕过。软性提醒（主要是「这读起来像一次性流水账」）会**拒绝一次**并要求显式 `force`，这正是调用方把该行改写成持久结论的机会。

### 规则：复刻 WorkBuddy 的语义

`.workbuddy/rules/*.md` 的契约只有两个 frontmatter 键，本行逐条复刻：

| frontmatter | 册 | 生效时机 |
|---|---|---|
| `alwaysApply: true` | 常驻册 | 每轮注入 |
| `alwaysApply: false` + `paths: [...]` | 条件册 | 读或改到匹配文件后注入 |
| 两者都没有 | 按需规则 | 只列入清单，模型需要时用 `rule_read` 读 |

分类是**判定**而不是配置：`isAlwaysRule` / `isConditionalRule` / `isOnDemandRule` 三个谓词由解析结果直接决定。

**触发靠触碰追踪。** `tools/result` 监听器在成功的 `read` / `write` / `edit` 之后取出 `file_path`，解析成工作区相对路径，再逐条匹配条件册的 glob。shell 改文件**不会**触发——解析任意 shell 语法不是可靠的文件系统接缝，这与 DSH 自带的 `dsh-agent-instructions` 划的是同一条边界（该包 README 的 Known Limitations 明说了这一点）。

**触发状态按工作区记账**，不按会话。理由有两条：规则册描述的是工作区，一旦这个工作区里有人动过 `.cs`，那册对**正在进行的工作**就成立；而且这避开了在工具结果监听器与同步 prompt provider 之间依赖 agent 对象同一性的问题。代价是同一工作区的并发会话共享触发状态——属于多注入一册，远比漏注入安全。

**预算是双重且可观测的。** 单册超过 `ruleFileBytes` 就截断，并在原处写明「完整内容用 `rule_read` 读 <册名>」。

整段预算的准入**按实际拼装出的字符串测量**（`renderRulesSection` 内部先 `assemble()` 再比长度），不是估算——段落会加上章节横幅（`## 常驻册\n` / `## 已触发的条件册\n`）与 `join('\n')` 的连接符，任何漏算其中之一的估算都会让一册「被准入、又被末尾硬裁剪吃掉」，而裁剪总是砍在最后，也就是砍在清单与说明上。

准入分两轮：先按优先级逐个整册准入（常驻册在前），再给放不下的已触发条件册发指针。**常驻册是整册制**——它们是段落的恒定部分、数量少，半注入一条常驻规则比点名省略更糟；**已触发的条件册永不出局**——模型刚动过匹配文件，这一册此刻正是最相关的内容，放不下就降级为「标题 + 触发 glob + `rule_read` 指针 + 尽量多的截断正文」，连指针都放不下的册会被段落末尾的说明点名。发指针时还会为后面的兄弟预留各自的指针空间，因此不会为了塞一册大册的碎片而饿死一册小册。渲染的最后一步仍保留硬裁剪，作为极端小预算（连表头都放不下）的兜底。

触发是**单调**的：一旦触发就不再取消，所以已触发的册只会越来越多，降级状态在一段会话里通常单调加重，不会自己恢复。

**frontmatter 读不动时报出来，不悄悄降级。** `alwaysApply` 取值无法识别时，该册**不会**被当成常驻册（不会静默放宽一条红线），也不会消失：它以按需规则身份留在清单里，并带一行 `frontmatter 存在无法识别的取值`。

### 技能：走原生 skill 注册表

`.workbuddy/skills/` 下的目录包（`<name>/SKILL.md`）与平铺文件（`<name>.md`）由一个注册到 `ctx.skills` 的 provider 发布，因此它们出现在**原生 skill 目录**里，由标准 `skill` 工具加载，相对资源也由注册表按 `resourceBase` 解析。本行没有另造一套加载路径。

- **rank 取 250**：低于 `project-dsh`（100）与 `project-agents`（200），高于 `custom`（300）。真正为 DSH 编写的项目技能因此能在重名时压过 WorkBuddy 的副本。
- **provider 按 `cwd` 变化**：`list()` 从查找上下文的 `cwd` 推导根目录，所以一个注册实例服务所有工作区，且没有跨工作区串号。
- **调用开关走严格布尔语法**：`disable-model-invocation` / `user-invocable` 接受 `true/false`、`yes/no`、`on/off`、`1/0`（大小写不敏感）。拼错的值**整册丢弃**并写一条 warn 日志，而不是静默放行一个作者想关掉的入口——与 DSH 自带本地 provider 的行为一致。
- **失效靠触碰，没有 watcher**：模型自己 `write` / `edit` 到 `.workbuddy/skills/` 下会同步调用 provider 的 `invalidate()`。外部工具的改动要等下一次目录快照，本行不启动文件监听。

### 三个刻意的「小」选择

**frontmatter 只读一个子集。** 两种兼容层读的都是别的工具写的 frontmatter，所以只实现那个工具真正会写的子集：扁平的 `key: scalar`、块状列表、行内列表。嵌套映射、锚点、标签、多行标量一概不解释——嵌套结构的缩进子行会被**跳过**而不是猜。静默误读别人的规则，比忽略一个本读取器没有建模的键更糟。

**glob 只实现真实用到的那一套。** `**`、`*`、`?` 与 `{a,b}` 花括号取值，就是所支持规则册里出现的全部方言；匹配大小写不敏感，因为这些规则面向的平台（Windows、macOS）本来就按大小写不敏感解析路径。

**章节层级判定。** `MEMORY.md` 的写法并不统一。WorkBuddy 的原生布局是孤立的一级文档标题加二级章节（`## 一、…`），而没有标题的文档会直接从最浅的标题开始。`detectSectionLevel` 把「只出现一次且比其余标题都浅」的那一层视为文档标题，因此 `memory_promote` 会插进预期的章节，而不会多出一个幽灵章节。

### 日期流水的布局

WorkBuddy 的日期流水有两种真实布局：平铺在记忆目录下（`memory/YYYY-MM-DD.md`），或按计算机名分目录（`memory/<计算机名>/YYYY-MM-DD.md`）。没有配置项声明用的是哪一种，因此 `scanLedgers` 只依据目录自身的形状判断——子目录里出现日期文件即视为「按机器分目录」，与本机同名的子目录（精确同名优先，其次忽略大小写）即使还没写日期文件也算。写入位置由 `ledgerWritePath` 给出：分目录时新流水进本机目录，平铺时进记忆目录根。读取某一天由 `ledgerForDate` 定优先级——本机、记忆目录根，最后才是其他机器唯一命中的那一份，因此同一天在两台机器上都有记录时不会猜错机器。检索不受布局影响：索引与全部机器的流水都会被搜到。

### 两个承重约束

**prompt provider 必须是同步的。** `systemPrompt.context()` 注册的 provider 在组装期间计算文本，而 `assemble()` 调用它时不会 await。`async` provider 返回的是 Promise 而非字符串，会让每一轮都失败。因此本行把每个工作区的探测异步写进缓存，provider 再同步渲染该缓存。某个工作区的第一轮会显示一条预热提示；`agent/created` 会预先预热，所以正常会话立刻就能看到内容。

**写入必须带上会话的沙箱策略。** `fs.writeText` 调用时传入 `sandboxPolicy.resolve({ session })`。没有 session 时，沙箱会退回部署默认的 workspace root 而不是该会话自己的 cwd，从而拒绝写入它自己的那个工作区。

<a id="further-exploration"></a>
## 进一步探索

- [实测证据归档](verification/) —— 正向 / 降级 / 反向三组真实项目取证，含一个已修复缺陷的根因记录。改动规则渲染层或预算准入后请与它对照。

以下文档都在 DSH 源码树 `D:\Work\GitHub\deepseek-harness` 内：

- `packages/context/agent-instructions/README.md` —— DSH 的工作区指令加载器，以及它**故意不解释**的语义清单（目录式规则、小写候选名、`@path` 导入）。
- `packages/skill/skill/README.md` 与 `packages/skill/skill-filesystem/README.md` —— skill 注册表契约、provider 接口与本地发现优先级表。
- `docs/subsystems/skills.md` —— 分层注册表、rank 并列时的解析顺序与 `skills/change` 失效事件。
- `docs/subsystems/system-prompt.md` —— 运行时上下文 provider 如何注册与组装。
- `packages/preset/agent-preset/README.md` —— preset 如何挂载本行，会话如何加入其作用域。

-----

<a id="model-experience"></a>
## 模型体验

### workspace-rules 上下文段落（order 55）

#### 模型看到的内容

只有在工作区存在 `.workbuddy/rules/` 时才出现；否则该段落为空字符串，**不占任何 token**。存在时，它包含：解析出的规则目录、两句语义说明，然后是「常驻册」的全部正文，接着是「已触发的条件册」正文（带触发 glob），最后是未触发条件册与按需规则的清单，以及 frontmatter 异常提示。

#### Token 影响

每轮固定增加「说明块 + 全部常驻册 + 已触发条件册 + 清单」，上限为 `rulesPromptBytes`。参考项目（4 常驻 + 3 条件）实测：只注常驻册时 **22,832 字节**，三册条件册全部触发后 **38,360 字节**（均在默认 48 KB 内，7 册全部整册注入）。这是本行施加的最大一笔无条件成本。

#### KV Cache 影响

常驻册与说明稳定时前缀稳定。一次条件册触发会**改变该段落**，从而使该段落起往后的缓存前缀失效——这是复刻 WorkBuddy「条件册按需注入」语义的直接代价。工作区没有规则目录时该段落恒为空，不参与任何失效。

### workspace-memory 上下文段落（order 60）

#### 模型看到的内容

一条名为 `workspace-memory`、order 为 `60` 的运行时上下文条目，包含解析出的工作区路径、生效后端与模式、记忆目录与索引路径、最近三个流水日期、当前生效的写入准则，以及不超过 `indexPromptBytes` 的索引文本。工作区的第一轮只带一条预热提示。

#### Token 影响

每轮固定增加「准则块 + 至多 `indexPromptBytes` 字节索引文本」的开销，对挂载作用域内的每个会话、每个请求都生效。流水与工具 schema 是其余部分。

#### KV Cache 影响

当索引文本、准则与工具 schema 不变时前缀稳定。一次 `memory_promote` 写入会重写索引，因而使该段落起往后的缓存前缀失效；流水写入不改变该文本，前缀保持稳定。

### 记忆工具与规则工具

#### 模型看到的内容

八个工具 schema，无论是否使用都出现在每个请求里。`memory_write` 在其描述里写明准入准则，`rule_status` / `rule_read` 在描述里写明触发边界与「新建文件不一定触发条件册」的兜底办法，因此准则在两处各表述一次：一次作为上下文段落中的散文，一次在使用点上。

#### Token 影响

八个 schema 带来固定的每请求开销。结果以 JSON 文本返回：`memory_read` 读取大流水时默认截取尾部 200 行，`memory_search` 对命中条数设上限，`rule_read` 返回整册正文（不截断）。

#### KV Cache 影响

本行挂载期间 schema 稳定。工具调用历史与结果作为普通对话 token 累积。

### 技能目录

#### 模型看到的内容

`.workbuddy/skills/` 下的每个合法目录包/平铺文件各贡献一条目录项：名称与描述（`whenToUse` 可选）。**provider 名、rank 与绝对路径不出现在模型侧**——与 DSH 自带本地 provider 一致。选中某册后，`skill` 工具返回 `<skill_content>`，并在 `<skill_resources>` 里带上「Base directory for this skill: <bundle 目录>」，让相对资源（`scripts/`、`references/`）可解析。

#### Token 影响

目录项按名称排序后计入会话 skill 目录；正文只在加载时进入历史。资源子树的变化不改变目录。

#### KV Cache 影响

目录摘要在名称集合与描述不变时稳定。一次 provider 失效（模型自己写入了技能目录）可能追加一份替换目录。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了本行不适用的场景。它们是当前的包约束，不是任务清单。

- **仅限工作区作用域** —— 没有全局或跨工作区记忆。后端解析返回的是 `(scope, backend)` 条目列表，读写编排按该列表编写，这即为预留接缝：新增 `global` 后端是纯增量的，但目前不附带任何全局存储。
- **并发是尽力而为** —— 流水追加与索引插入都是整文件的读—改—写。两个会话在同一瞬间写同一工作区可能丢失一次写入。这里没有锁，本行也不声称原子追加。
- **一轮预热** —— prompt provider 无法 await，因此缓存未命中的工作区会先渲染一轮预热提示，之后才出现真实内容。规则段落更安静：缓存未命中时渲染空串，而不是提示。
- **索引注入是硬性字节上限** —— 过大的 `MEMORY.md` 在 prompt 中会被截断，模型必须调用 `memory_read` 才能看到其余部分。没有任何自动摘要。
- **按存在性选择后端** —— 生效后端取决于 `.workbuddy/memory` 是否存在。会话中途创建该目录会在下次探测时切换后端，而已写入 `.dsh/memory` 的记忆不会被迁移。
- **流水布局是探测出来的** —— 布局同样取决于目录当前形状：出现装着日期文件的计算机名子目录即切到「按本机目录读写」，子目录清空后回落平铺。计算机名取 `hostname` 输出，大小写不敏感地复用已有目录。
- **无删除与清理** —— 条目只能新增，无法通过工具移除或过期。流水按日期增长，且只会被追加。
- **规则只认 DSH 的结构化文件工具** —— 触碰追踪挂在 `read` / `write` / `edit` 的 `file_path` 上。用 shell（`cat`、`sed`、构建脚本）改文件不触发条件册，这与 DSH 自带的指令加载器同一边界。兜底办法是 `rule_read`；`AGENTS.md` 里的同类约定（新建文件先读一个同类文件）在 DSH 下同样适用。
- **规则触发状态在进程内累积、不落盘** —— 触发集合按工作区记在内存里，重启即清空，会话中途修改 rules 文件也不会重载（与 WorkBuddy 自身「rules 内容只在启动时读一次」的契约一致）。
- **规则降级会叠加，且被截断的正文不能当全文** —— 触发是单调的，一段会话里已触发的册只会变多，所以预算紧张时降级通常单调加重、不会自行恢复；降级块里的正文是截断的，判据必须以 `rule_read` 的全文为准。要避免降级，就把 `rulesPromptBytes` 调到能容下「常驻册 + 全部条件册」的大小（参考项目需要约 38.4 KB，默认 48 KB 已覆盖）。
- **技能没有 watcher** —— 只有模型自己的 `write` / `edit` 会同步失效 provider。外部编辑器、Git、shell 新增或改名技能要等目录缓存过期，本行不启动 Chokidar。
- **技能只认一层深度** —— `<name>/SKILL.md` 与 `<name>.md`；嵌套技能树与包清单被忽略。目录包内部的 `references/` / `scripts/` 作为资源可读，但不作为独立技能发现。
- **frontmatter 子集** —— 嵌套映射、多行标量、锚点与 YAML 标签不被解释。规则与技能都用得上它们时，本读取器需要同步扩展。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者背景信息 —— 点击展开</summary>

`@jinngoo/dsh-workspace-conventions` 作为挂载它的 profile 的依赖发布。它只消费 host 平面服务，因此**不得**包裹在 `isolate` realm 中：它需要的每一项能力——文件系统、agent 注册表、prompt 注册表、沙箱策略——都不属于某个单独会话。

`inject` 列表列出了全部六个服务，因此缺少任一项的组合会在挂载时直接报错，而不是静默地什么都不贡献。`skills` 之所以是硬依赖而不是可选依赖，是因为本项目遵循同一个取舍：DSH 的 web profile 里 `skill` 注册表恒在 host 平面（被禁用的只有各 preset 自己挂载的 `skill-filesystem` 行），缺注册表的组合本来就用不了技能，静默降级只会掩盖配置错误。

**命名分工是刻意的**：包名与 loader 行 id（`workspace-conventions`）命名**能力范围**，因此它们必须覆盖三层；而两个 prompt 段落仍叫 `workspace-rules` 与 `workspace-memory`，因为它们命名的是**自己的内容**——一个是规则段落，一个是记忆段落。同样地，`docs/legacy-preset/` 里保留旧包名是历史准确性，不是遗漏。改动命名时请维持这条分工，不要为了「grep 干净」把段落也改成前缀形式。

源码分工：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 装配层：配置 schema、六个记忆工具、两个规则工具、两个 prompt 段落、技能 provider 注册、触碰追踪 |
| `src/memory.ts` | 记忆模型（纯逻辑）：准入、条目渲染、索引编辑、流水盘点 |
| `src/rules.ts` | 规则册解析、分类、glob 触发判定、段落渲染与预算 |
| `src/skills.ts` | 技能包解析与 `ctx.skills` provider 工厂 |
| `src/frontmatter.ts` | 刻意收窄的 YAML frontmatter 读取器 |
| `src/glob.ts` | `**` / `*` / `?` / `{a,b}` 的 glob→正则编译 |
| `src/text.ts` | 文本归一化、路径显示、字节裁剪 |
| `src/layout.ts` | 三个兼容层共用的目录名常量 |

</details>
