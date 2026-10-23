---
description: "可组合的双层作用域约定行：在工作区与全局（$DSH_HOME）两级提供人格、情绪、记忆、规则与技能，并在既有 WorkBuddy 体系存在时按原生语义兼容它的记忆、规则与技能，面向配置或调试 agent 工作区约定的使用者与维护者。"
kind: "package-reference"
---

# @jinngoo/dsh-workspace-conventions

[English](DESIGN.md) | 中文

## 概述

`dsh-workspace-conventions` 让 agent 在它正在工作的那个工作区里拥有持久记忆、行为规则与可复用技能，**并把"我是谁"这一层放到跨工作区的全局作用域**。挂载作用域只需挂载这一行，其下每个会话都读写**自己**工作目录下的内容；而全局层（人格、情绪、长期记忆、跨项目规则）对所有工作区共享，每个工作区可以按层继承或屏蔽它。

两套作用域共用同一条原则：**工作区已经存在 WorkBuddy 体系时，按那个体系的原生形态与语义工作；否则退到 DSH 的默认位置与同一套模型。** 之所以必须这样做，是因为 DSH 自身不认识 `.workbuddy/`，也没有记忆与人格机制：

- DSH 唯一的「工作区指令」通道是 `@deepseek-ai/dsh-agent-instructions`，它只按**同目录文件名候选**加载 `AGENTS.md` / `CLAUDE.md`（外加 `AGENTS.local.md` / `CLAUDE.local.md`）。候选名不得含路径分隔符，所以 `.workbuddy/rules/` 这种目录式规则**无法用配置表达**；DSH 也没有 Cursor 那样的 `alwaysApply` / `paths` / glob 规则机制。
- DSH 的技能由 `@deepseek-ai/dsh-skill-filesystem` 扫描 `<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills`、`customSkillDirs`、`<dshHome>/skills`、`<agentsHome>/skills`。`.workbuddy/skills/` 不在其中。
- DSH 的全局注入只有 `$DSH_HOME/AGENTS.md` 一份静态文本；人格由 preset 的 `personaPrefix` 承载且会话首轮后锁定。"可写、可检索、会衰减"的东西 DSH 一律不提供。

| 层 | 工作区源 | 全局源（跨工作区） | 抵达模型的方式 |
|---|---|---|---|
| 人格 persona | `.dsh/persona/*.md` | `$DSH_HOME/persona/*.md` | prompt 段落 + 2 个工具（写入需审批） |
| 情绪 mood | `.dsh/mood/current.md` | `$DSH_HOME/mood/current.md` | prompt 段落（衰减 + 情绪维护）+ 2 个工具 |
| 记忆 memory | `.workbuddy/memory/` 或 `.dsh/memory/` | `$DSH_HOME/memory/` | 两个 prompt 段落 + 6 个工具（全局写入需审批） |
| 规则 rules | `.workbuddy/rules/*.md` | `$DSH_HOME/rules/*.md` | 两个 prompt 段落 + 2 个工具 |
| 技能 skills | `.workbuddy/skills/` | DSH 原生 `$DSH_HOME/skills`（本行不接管） | 注册进 `ctx.skills` 的原生 provider |

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
    personaPromptBytes: 3072
    personaFileBytes: 8192
    moodPromptBytes: 512
    moodHalfLifeHours: 6
    moodMaxAgeHours: 48
    globalIndexPromptBytes: 3072
    globalRulesPromptBytes: 12288
    globalRoot: ''          # 空 = 跟随 $DSH_HOME，再退 ~/.dsh
    # 0.6.0：写入审批与情绪维护（行配置，不能写进 .dsh/workspace.yml）
    approveGlobalMemory: true
    approvePersonaWrite: true
    moodProactive: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `indexPromptBytes` | `7000` | 每轮注入 prompt 的工作区索引文本字节上限；其余部分仍可通过 `memory_read` 读取。 |
| `rulesPromptBytes` | `49152` | 工作区规则段落（常驻册 + 已触发条件册 + 未触发清单 + 说明）的字节上限。这是防病态 rules 目录的护栏而非配额：册子本身更小时只按实际花费计。 |
| `ruleFileBytes` | `16384` | 单册字节上限，对齐 WorkBuddy 自己约 16 KB 的契约。 |
| `personaPromptBytes` | `3072` | 人格段落总预算（两作用域合并后）。 |
| `personaFileBytes` | `8192` | 单个人格片段上限；超出截断并留 `persona_read` 指针。 |
| `moodPromptBytes` | `512` | 情绪段落预算——故意很小，情绪只是一行状态。 |
| `moodHalfLifeHours` | `6` | 情绪衰减半衰期；一个半衰期后权重减半。 |
| `moodMaxAgeHours` | `48` | 超过该年龄的情绪视为「已平复」，不再注入具体状态。 |
| `globalIndexPromptBytes` | `3072` | 全局记忆索引段落预算，与工作区索引分开，互不挤占。 |
| `globalRulesPromptBytes` | `12288` | 全局规则段落预算，与工作区规则分开。 |
| `globalRoot` | `''` | 全局作用域根；空则跟随 `$DSH_HOME`，再退 `~/.dsh`。 |
| `approveGlobalMemory` | `true` | `scope="global"` 的 `memory_write` / `memory_promote` 在工具体执行前请求一次性审批；`false` 关闭该门。**行配置**，不能写进 `.dsh/workspace.yml`。 |
| `approvePersonaWrite` | `true` | `persona_write`（工作区与全局两个作用域）请求一次性审批；`false` 关闭该门。行配置。 |
| `moodProactive` | `true` | 是否注入 `workspace-mood-maintenance`（「情绪维护」）段落；还要求工作区 `mood` 层开着。行配置。 |

最后三行是 **0.6.0 新增**的布尔开关，默认全 `true`。它们和字节预算同一条边界：属于 profile 组合里的**行配置**，一旦写进项目级 `.dsh/workspace.yml` 就会命中未知键错误（报错并停用所有层）。项目级能决定的仍是各层是否启用（`layers.*`）与是否继承全局（`inherit.*`）。


### 它贡献的工具

| 工具 | 用途 |
|---|---|
| `self_status` | 两个作用域 × 全部层的全景：目录、条目数、字节、预算、继承开关、情绪衰减结果、阻塞原因。 |
| `memory_status` | 报告工作区后端与全局记忆的路径、索引大小、流水布局与继承开关。 |
| `memory_read` | 读取索引（`layer=index`）或某一天的流水（`layer=ledger`）；`scope` 选工作区或全局。 |
| `memory_search` | 在索引与所有流水中做大小写不敏感的字面子串检索；默认 `scope=both`。 |
| `memory_write` | 经准入审查后，向当日流水追加一条持久条目；全局只接受四类结论，且先要一次性审批（`approveGlobalMemory`）。 |
| `memory_promote` | 在指定章节下向索引加入一行，使其每轮都被注入；`scope="global"` 时先要一次性审批。 |
| `memory_help` | 说明当前生效的写入准则与准入策略（含全局 vs 工作区的判定）。 |
| `rule_status` | 报告工作区与全局两套规则册的清单、分类、触发 glob 与已触发状态。 |
| `rule_read` | 读取一册规则的完整正文（绕过 16 KB 注入上限）；`scope` 选作用域。 |
| `persona_read` | 列人格片段清单或读某一片段全文（工作区同名遮蔽全局）。 |
| `persona_write` | 写人格片段（`replace` / `append`）；密钥与 PII 硬拒，超预算硬拒；两个作用域都先要一次性审批（`approvePersonaWrite`）。 |
| `mood_get` | 读情绪原始状态与衰减后视图（年龄、权重、是否已平复、生效来源）。 |
| `mood_set` | 写情绪状态，自动记 `updated`；只覆盖当前状态，不写历史。 |

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

### 五个层、两个作用域

记忆两层后端共用一套模型。索引是唯一常驻上下文的部分；流水是可检索的记录；证据留在本来就拥有它的文档与代码里。人格与情绪是 0.5.0 新增的两层，与记忆/规则共用同一套作用域、预算与「同步 provider + 异步探测」机制；它们的完整设计（目录布局、遮蔽语义、情绪衰减、`inherit` 两轴开关、全局根命名冲突评估）见 [DESIGN-self-scopes.zh.md](DESIGN-self-scopes.zh.md)。

| 层 | 文件 | 生命周期 | 内容 |
|---|---|---|---|
| 索引 | `MEMORY.md` | 每轮注入 | 硬约束、稳定偏好、长期约定、文档指针 |
| 流水 | `YYYY-MM-DD.md` | 追加式，按需读取 | 需要留档但不必常驻的持久事实 |
| 证据 | 它本来所在之处 | — | 文档与代码；索引只留指针，不复述内容 |

### 准入是一等步骤

记忆系统的主要失效模式不是「存得太少」，而是「存得太多」：无节制增长的索引会污染每一轮的上下文。因此每次写入流水前都会先跑 `evaluateEntry`。硬性拒绝——密钥、私钥材料、PII、空或近乎空的内容——无法被绕过。软性提醒（主要是「这读起来像一次性流水账」）会**拒绝一次**并要求显式 `force`，这正是调用方把该行改写成持久结论的机会。

### 写入审批：一次性、可审计的同意

准入审查是**模型侧的自律**：它能挡住密钥与流水账，却挡不住"一条技术上合规、但你不希望它跨工作区即时可见"的条目。0.6.0 把这一层交还给用户——`memory_write` / `memory_promote` 的 `scope="global"`，以及 `persona_write`（两个作用域），在工具体执行之前经 DSH 的 approval seam 请求一次同意。

- **为什么是审批，而不是继续加提示词。** 提示词只能"建议模型谨慎"，无法证明用户真的看过；审批是 DSH 提供给插件的**唯一**可审计、可拒绝、且只授予一次执行的同意机制——`tools/pre-execute` 瀑布返回 `{kind:'ask', reason, displayReason}`，由 DSH 解析成回答，答复只覆盖这一次调用。拒绝、取消、或部署里没有应答方时，DSH 直接拒绝该调用，工具体从未执行，什么都不会写。不存在"问是问了，改还是改了"。
- **只有一次，没有"总是允许"。** 每一次全局写入都是一次单独批准，也不提供本会话内放行。这道门本来就该让人稍微嫌烦：跨工作区可见的内容，不值得为省一次点击而放开。
- **审批提示是有界摘要。** 内容前约 60 个字符（空白折叠为一行；人格则同时给出片段名），够判断"这是不是我刚写的那条结论"，又不把整段流水铺进审批 UI。
- **人格两个作用域都设门。** 人格是每轮注入的身份层，改它不是"多一条记录"，而是这个工作区（或整个 profile）此后每次回答的语气与价值观。工作区人格的影响面比全局小，但同样每轮出现，所以 `persona_write` 不区分作用域。
- **工作区记忆不设门。** 它按项目隔离、影响面局限在单个工作区，写错了下一轮就能改；加审批只会把"随手记一条"变成摩擦，反而促使模型不记。全局记忆则相反：一次写入立刻出现在**所有**工作区的注入里。
- **已被工作区关掉的层不会被先问审批。** `memory` 为 `read-only` / `disabled`、`inherit.memory: false`、`persona` 层关闭、或全局人格被 `inherit.persona: false` 屏蔽时，门保持安静、把调用交给后续链路，由工具自己的拒绝作答——让用户批准一个必然失败的操作只是噪音。
- **失败是关闭的。** 会话审批策略 `never`、或部署没有任何应答方时，这道门确定性拒绝而不是放行，模型看到可读的拒绝原因。宁可写不进去，也不在无人确认时静默写入。
- **这道门只管本插件自己的工具。** 模型仍可用通用 `write` / `edit` 直接改人格或情绪文件，那两条工具没有接审批。把通用文件工具纳入统一门禁是 phase 2 的工作；0.6.0 只保证"经本插件写入"这条路可审计，不假装它是完整边界。

### 情绪维护：为什么只能"鼓励"

情绪层只是两个工具：模型不调用 `mood_set`，就没有任何状态。0.6.0 新增同步 provider `workspace-mood-maintenance`（order 53）：工作区 `mood` 层开着、且行配置 `moodProactive` 为真时，注入一段 `## 情绪维护`，点名值得写状态的时刻（任务阶段切换、被纠正、卡住后突破、长任务收尾），同时明确"无变化不必每轮写入"与"情绪不是记忆"。

- **它不能强制。** prompt provider 输出的是上下文文字，没有任何机制要求模型下一次必须调用工具；本行也不替模型往情绪文件里写——那等于伪造情绪。真正的自动维护（按事件或定时驱动模型自己更新）需要一个 daemon-loop 形态的插件，本行是装配层，不长出常驻循环。
- **这个限制可以接受。** 情绪的价值在于"记录模型对处境的判断"；强制每轮写入只会得到一份没有信息量的流水，还会让情绪段落每轮抖动、拖累前缀缓存。鼓励写入 + 模型自己挑时机，既保留状态变化时的表达，又不把情绪层变成第二份日志。`moodProactive: false` 是一个干净的出口（行配置，对该 profile 的所有工作区生效）：想要情绪层但不要这段提醒，关掉它即可。
- **成本可控。** 段落只有三行固定文字；`layers.mood: false` 或 `moodProactive: false` 时返回空串、**0 token**。存储里还没有任何情绪记录时多一行"第一次写入"的邀请，写过一次后它自己消失；文本不含时间、只在"有/无记录"之间切换一次，因此不会每轮追加 runtime-context 快照。衰减与半衰期逻辑完全没变。

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

### workspace-mood-maintenance 上下文段落（order 53）

#### 模型看到的内容

只有当工作区情绪层开着（`layers.mood`，默认 true）、且行配置 `moodProactive` 为 true 时才出现，紧跟在 `workspace-mood`（order 52）之后。它是一段固定的 `## 情绪维护`：请模型在明确的状态变化（任务阶段切换、被纠正、卡住后突破、长任务收尾）时顺手调用 `mood_set`，无变化不必每轮写；并说明情绪只描述此刻倾向，不是记忆。已探测到的情绪存储都没有记录时（继承全局时要求两处都探测完成，屏蔽全局时只看工作区），多一行"第一次写入"的条件邀请；记录一经存在（包括已平复的状态）它就不再出现——"已平复"不算空缺，否则每次衰减后都会冒出一句误导性提示。冷缓存/尚未探测时不猜"没有记录"，以免在预热轮邀请一次重复的第一次写入。段落不重复衰减参数，那部分仍由 `## 情绪` 段落与 `mood_get` 承担。

#### Token 影响

三行固定文字，量很小；`layers.mood: false` 或 `moodProactive: false` 时返回空串、**0 token**。它不随情绪强度变化，也不含时间。

#### KV Cache 影响

文本只在"有/无情绪记录"之间切换一次，之后与情绪更新无关；同开关下逐字节稳定。这与 0.5.1 对 `## 情绪` 段落的粗粒度化是同一个方向：控制的是**变化频率**，不是"每轮都发"。

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

- **全局作用域是进程内缓存** —— 全局层（persona/mood/memory/rules）在工作区之外、跨会话共享，但只在挂载后与新会话（`agent/created`）、以及本进程的工具写入时重读。外部直接编辑 `$DSH_HOME` 下的文件不会实时生效，要等下一次这些时机。
- **全局写入受沙箱策略约束** —— `$DSH_HOME` 在工作区之外，`workspace-write` 策略会拒绝写入；工具返回可执行的原因（改 `scope="workspace"` 或放宽策略），而不是静默失败。审批是另一道正交的门：沙箱放行不等于用户同意。
- **写入审批只覆盖本插件的工具** —— 通用 `write` / `edit` 仍可直接改 `$DSH_HOME/persona` 与情绪文件，不经审批。0.6.0 明确把这一点留给 phase 2：本版承诺的是"经本插件写入可审计"，不是一个完整边界。
- **没有 allow-always** —— 每笔全局记忆写入与人格写入（两个作用域）都要单独批准；会话审批策略 `never`、或部署没有任何应答方时一律确定性拒绝（fail-closed）。这是刻意的：审批的意义在于每一次都有可见的选择。
- **`moodProactive` 是行配置** —— 单个项目无法只关「情绪维护」而保留情绪层；项目级只有 `mood` / `inherit.mood`，要按项目控制只能整体关情绪层。行配置随 profile 对该 profile 的所有工作区生效。
- **情绪维护不是自动化** —— 段落只能鼓励模型在状态变化时调用 `mood_set`；没有每轮自动写入，也不该有（那需要 daemon-loop 形态的插件）。
- **并发是尽力而为** —— 流水追加与索引插入都是整文件的读—改—写。两个会话在同一瞬间写同一工作区可能丢失一次写入。这里没有锁，本行也不声称原子追加。全局层跨工作区共享同一份文件，该风险更高。
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

**命名分工是刻意的**：包名与 loader 行 id（`workspace-conventions`）命名**能力范围**，因此它们必须覆盖全部层；而 prompt 段落仍叫 `workspace-rules`、`workspace-memory`，因为早期版本里它们只服务工作区，现在多了同名的 `global-rules` / `global-memory` 段落——按内容命名仍是这条分工的延续。同样地，`docs/legacy-preset/` 里保留旧包名是历史准确性，不是遗漏。改动命名时请维持这条分工，不要为了「grep 干净」把段落也改成前缀形式。

源码分工：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 装配层：配置 schema、十三个工具、七个 prompt 段落、技能 provider 注册、触碰追踪、写入审批、预热 |
| `src/scope.ts` | 双层作用域：全局根解析、各层目录、路径包含判断 |
| `src/persona.ts` | 人格片段（纯逻辑）：解析、排序、遮蔽合并、预算渲染 |
| `src/mood.ts` | 情绪状态（纯逻辑）：解析/生成、半衰期衰减、确定性渲染、「情绪维护」段落文本 |
| `src/approval.ts` | 写入审批（纯逻辑）：哪些调用要问、摘要裁剪与审批提示文本；层开关与沙箱策略由调用方传入 |
| `src/memory.ts` | 记忆模型（纯逻辑）：准入、条目渲染、索引编辑、流水盘点 |
| `src/rules.ts` | 规则册解析、分类、glob 触发判定、段落渲染与预算 |
| `src/skills.ts` | 技能包解析与 `ctx.skills` provider 工厂 |
| `src/frontmatter.ts` | 刻意收窄的 YAML frontmatter 读取器 |
| `src/glob.ts` | `**` / `*` / `?` / `{a,b}` 的 glob→正则编译 |
| `src/text.ts` | 文本归一化、路径显示、字节裁剪 |
| `src/layout.ts` | 各层共用的目录名常量 |

</details>
