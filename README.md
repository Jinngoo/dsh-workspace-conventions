# dsh-workspace-conventions

> 给 agent 提供**双层作用域**（工作区 + 全局）的**人格、情绪、记忆、规则与技能**，并自动兼容已有的 WorkBuddy（`.workbuddy/`）体系。
>
> DSH Bundle 插件，独立于 deepseek-harness 源码树。

| 层 | 工作区来源 | 全局来源（跨工作区） | 抵达模型的方式 |
|---|---|---|---|
| 人格 persona | `.dsh/persona/*.md` | `$DSH_HOME/persona/*.md` | prompt 段落 + 2 个工具（`persona_write` 需一次性审批） |
| 情绪 mood | `.dsh/mood/current.md` | `$DSH_HOME/mood/current.md` | prompt 段落（衰减；`moodProactive` 时另注入情绪维护）+ 2 个工具 |
| 记忆 memory | `.workbuddy/memory/` 或 `.dsh/memory/` | `$DSH_HOME/memory/` | prompt 段落（两段）+ 6 个工具（全局写入需一次性审批） |
| 规则 rules | `.workbuddy/rules/*.md` | `$DSH_HOME/rules/*.md` | prompt 段落（两段）+ 2 个工具 |
| 技能 skills | `.workbuddy/skills/` | 由 DSH 原生 `$DSH_HOME/skills` 提供（本插件不接管） | 注册进 `ctx.skills` 的原生 provider |

**两条正交的开关**（`.dsh/workspace.yml`，文件会在首次使用时自动创建）：这一层是否启用，以及是否继承全局作用域。

```yaml
workspace-conventions:
  memory: read-only     # enabled | read-only | disabled
  persona: true         # 是否注入人格片段
  mood: true            # 是否注入情绪状态
  rules: true
  skills: false
  memoryLayout: auto    # auto（默认）| flat | host
  inherit:              # false = 屏蔽全局，只看本工作区
    persona: true
    mood: true
    memory: true
    rules: true
```

<details>
<summary><b>目录</b></summary>

| | |
|---|---|
| **是什么** | [为什么需要它](#为什么需要它) · [人格](#人格persona) · [情绪](#情绪mood) · [记忆](#记忆) · [规则](#规则) · [技能](#技能) · [全局作用域](#全局作用域dsh_home) |
| **怎么用** | [项目级开关](#项目级开关dshworkspaceyml) · [行配置（profile）](#行配置profile审批与情绪维护的开关) · [开关 × 目录](#开关--目录一张对照表) · [状态矩阵](#各层的状态矩阵) · [安装](#安装作为-bundle-装进某个-profile) |
| **怎么验证** | [对真实项目](#对着真实项目验证) · [校验覆盖命中](#校验-profile-覆盖真的命中了) · [实测归档](docs/verification/) |
| **怎么开发** | [构建与测试](#构建与测试) · [目录结构](#目录结构) · [开发循环](#开发循环) · [升级注意](#升级注意) · [已知限制](#已知限制当前版本) |
| **背景细节** | [设计文档](docs/DESIGN.zh.md)（[English](docs/DESIGN.md)） · [双层作用域设计](docs/DESIGN-self-scopes.zh.md) · [配置格式规格](docs/workspace-config.md) · [历史留档](docs/legacy-preset/) |

</details>

## 为什么需要它

DSH 自身不认识 `.workbuddy/`，也没有任何"记忆"或"人格"机制：

- **DSH 没有 rules 机制。** 它唯一的工作区指令通道是 `@deepseek-ai/dsh-agent-instructions`，只按**同目录文件名候选**加载 `AGENTS.md` / `CLAUDE.md`（外加 `AGENTS.local.md` / `CLAUDE.local.md`）。候选名不得含路径分隔符，所以目录式规则（`.workbuddy/rules/`、`.claude/rules/`）**无法用配置表达**；`alwaysApply` / `paths` / glob 这类语义 DSH 一概不解释。
- **DSH 的技能根是固定的。** `@deepseek-ai/dsh-skill-filesystem` 只扫描 `<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills`、`customSkillDirs`、`<dshHome>/skills`、`<agentsHome>/skills`，`.workbuddy/skills/` 不在其中。
- **DSH 没有跨工作区记忆，也没有 soul/persona 的持久机制。** 它的全局注入只有 `$DSH_HOME/AGENTS.md` 这一份静态文本；人格由 preset 的 `personaPrefix` 承载，且会话首轮后锁定。凡是"可写、可检索、会演化"的东西都留给插件——本插件就补这一块。

于是把带 `.workbuddy/` 的既有项目当工作区打开时，只有 `AGENTS.md` 会被加载，规则与技能完全不可见；而跨项目的偏好、人格与情绪无处安放。本插件同时补这两个缺口。

## 记忆

| 工作区包含 | 生效后端 | 存储位置 | 行为 |
|---|---|---|---|
| `.workbuddy/memory/` | `workbuddy`（兼容） | `.workbuddy/memory/` | 以 WorkBuddy 原生形态读写，并执行它自己的写入准则 |
| 都没有 / 只有 `.dsh/memory/` | `dsh-default` | `.dsh/memory/` | DSH 默认规则，同样是「索引 + 日期流水」形态 |

**日期流水有两种真实布局**：平铺（`memory/YYYY-MM-DD.md`）与按计算机名分目录（`memory/<计算机名>/YYYY-MM-DD.md`）。本行不假定是哪种，而是按目录的实际形状探测：一旦目录里出现装着日期文件的计算机名子目录，新流水就写进本机 `hostname` 对应目录；检索覆盖全部机器的目录；读取某一天时依次取本机、记忆目录根，只在其他机器唯一命中时才采用它。

### 写入审批（全局作用域）

工作区记忆写入是普通工具调用；**全局记忆写入要先经一次审批**：`memory_write(scope="global")` 与 `memory_promote(scope="global")` 在工具体执行前，经 DSH 的 approval seam 向用户要一次同意（行配置 `approveGlobalMemory` 默认 `true`）。

- **只有「允许这一次」**：拒绝、取消、或部署里没有应答方时，DSH 直接拒绝该调用，**工具体从未执行、什么都不会写**；会话审批策略 `never` 同样是确定性拒绝，模型会看到可读的拒绝原因。没有"总是允许"——跨工作区即时可见的内容，每笔都单独批准。
- 审批提示里是**有界摘要**：内容前约 60 个字符，够判断"这是不是我刚写的那条"，又不把整段流水铺进审批界面。
- **不受影响**：工作区作用域的写入、`mood_set`、以及全部读取工具。
- 已经被项目开关挡住的情况**不会先问审批**：`memory` 为 `read-only` / `disabled`、或 `inherit.memory: false` 时，工具自己的拒绝就是答案。
- **要关掉这道门**：把行配置 `approveGlobalMemory` 设为 `false` 即可——但它对该 profile 的所有工作区生效，属于部署策略，**不能写进 `.dsh/workspace.yml`**（见[行配置（profile）](#行配置profile审批与情绪维护的开关)）。

## 人格（persona）

身份、语气、价值观与禁忌——**跨项目不变**的东西，和"这个项目的事实"分开存放。

| 作用域 | 目录 | 说明 |
|---|---|---|
| 工作区 | `.dsh/persona/*.md` | 只对该项目生效；同名文件**整体遮蔽**全局那一份 |
| 全局 | `$DSH_HOME/persona/*.md` | 跨工作区共享；工作区可整层继承或屏蔽 |

- 每片段一个文件：`01-identity.md`、`02-voice.md`……按文件名排序，frontmatter 可写 `title` / `order` 覆盖排序与标题。
- 注入为 `## 人格` 段落，整段预算 `personaPromptBytes`（默认 3 KB），单片段上限 `personaFileBytes`（默认 8 KB）；超限片段截断并留 `persona_read` 指针。
- 工具：`persona_read`（列清单/读全文）、`persona_write`（写片段，密钥/PII 硬拒）、`self_status`（全景）。
- 项目事实写进记忆，不写进人格——两者混淆是这套系统最常见的腐化方式。

### 写入审批（两个作用域）

`persona_write` 在**工作区与全局两个作用域都要一次性审批**（行配置 `approvePersonaWrite` 默认 `true`）：人格是每轮注入的身份层，改它不是"多一条记录"，而是换掉此后每次回答的语气与价值观，工作区人格也只影响一个项目但同样每轮出现。

- 审批提示显示的是片段名和内容摘要；拒绝/取消/无应答方时调用被 DSH 拒绝、工具体从未执行。
- 已经被挡住的写入**不会先问审批**：整个人格层被 `persona: false` 关掉，或全局写入被 `inherit.persona: false` 屏蔽时，工具的拒绝本身就是答案。
- 语义与记忆侧相同（一次性、无"总是允许"、失败即拒绝），见上文「写入审批（全局作用域）」。
- 这道门只管本插件自己的工具：通用 `write` / `edit` 直接改人格文件不经过审批，见[已知限制](#已知限制当前版本)。

## 情绪（mood）

一个**有时效**的小状态，不是记忆：它只回答"此刻是什么状态"，并随时间衰减。

```markdown
---
label: 专注
valence: 0.4        # -1 消极 … +1 积极
arousal: 0.3        # 0 平静 … 1 亢奋
updated: 2026-10-23T00:12:00+08:00
---
正在收尾一个插件设计，节奏紧凑但不急躁。
```

- 文件：`.dsh/mood/current.md`（工作区）与 `$DSH_HOME/mood/current.md`（全局）。
- 渲染时按 `weight = 0.5 ** (age / halfLifeHours)` 衰减（`moodHalfLifeHours` 默认 6）；超过 `moodMaxAgeHours`（默认 48）或权重低于 0.05 → 视为**已平复**，只注入一行 `当前情绪：已平复`。
- 两份状态**取最新一份**，不混合打分（混合会凭空造出没人写过的状态）。
- 工具：`mood_set`（写状态，自动记 `updated`）、`mood_get`（原始状态 + 衰减后视图）、`self_status`。
- 不写历史流水；需要留档的结论请用 `memory_write`。

### 情绪维护

情绪层默认还会注入一小段 `## 情绪维护`（order 53，prompt 段落 `workspace-mood-maintenance`）：它请模型在**明确的状态变化**时顺手调用 `mood_set`——任务阶段切换、被纠正、卡住之后的突破、长任务收尾——同时写明"不要每轮都写一次""情绪不是记忆"。

- **显示条件**：工作区 `mood` 层开着（默认开），且行配置 `moodProactive` 为 `true`（默认）。任一为假 → 段落为空串、**零 token**。
- 存储里还没有情绪记录时（已探测且为空），多一行邀请"第一次写入"的条件提示；写过一次后它自己消失。
- 衰减、半衰期与"取最新一份"的逻辑**完全没变**；这段文字只在"第一次写入"前后各有一个稳定形态，不随情绪强度变化。
- 它只能**鼓励**，不能强制：prompt 段落没有"必须调用工具"的表达力，真正的自动维护需要另一个常驻循环插件。项目级无法只关这段而保留情绪层，见[已知限制](#已知限制当前版本)。

## 全局作用域（`$DSH_HOME`）

| 层 | 全局目录 | 工作区同名遮蔽 |
|---|---|---|
| 人格 | `$DSH_HOME/persona/*.md` | ✅ 按片段名 |
| 情绪 | `$DSH_HOME/mood/current.md` | ✅ 取最新一份（不是遮蔽） |
| 记忆 | `$DSH_HOME/memory/`（索引 + 日期流水，布局探测同工作区） | ❌ 两段独立注入 |
| 规则 | `$DSH_HOME/rules/*.md`（`alwaysApply` / `paths` 同语义） | ✅ 按文件名 |

- 全局根默认就是 `$DSH_HOME`（`~/.dsh`），可用行配置 `globalRoot` 整体搬家——`$DSH_HOME/{persona,mood,memory,rules}` 目前没有其它机制占用，但记忆/人格这类名字未来被 DSH 或别的插件征用并非不可能，这个配置就是为此留的逃生门。
- 全局写入落在工作区之外：`workspace-write` 策略会拒绝，工具会返回原因与替代方案（改 `scope="workspace"`，或放宽策略）。`danger-full-access` 下可写。
- 即便沙箱放行，全局记忆与人格写入仍各有一道**一次性审批**（见上文「写入审批」）——审批不是许可，而是同意；无应答方时按拒绝处理。
- 全局记忆的准入比工作区更严：只接受 `preference` / `constraint` / `convention` / `decision` 四类，项目一次性发现留在工作区。

## 规则

复刻 `.workbuddy/rules/*.md` 的原生语义：

| frontmatter | 册 | 生效时机 |
|---|---|---|
| `alwaysApply: true` | 常驻册 | 每轮注入 |
| `alwaysApply: false` + `paths: [...]` | 条件册 | 读或改到匹配文件后注入 |
| 两者都没有 | 按需规则 | 只列入清单，模型需要时用 `rule_read` 读 |

- 单册超过 16 KB（`ruleFileBytes`）就截断，并写明「完整内容用 `rule_read` 读」。
- 整段超过 `rulesPromptBytes`（默认 48 KB）时**常驻册优先**，而**已触发的条件册永不出局**：整册放不下就降级为「标题 + 触发路径 + `rule_read` 指针 + 尽量多的截断正文」，连指针都放不下的册会在段落末尾的说明里被点名。
- 准入按**实际拼装出的字符串长度**测量（含章节标题与连接符），不是估算；并且先逐个整册准入、再给剩下的发指针，每个指针都为后面的兄弟预留空间。所以既不会出现「被准入又被硬裁掉」，也不会为了塞一册大册的碎片而饿死一册小册—实测同一项目在 20 KB 预算下，8128 字节的客户端铁律降级为指针，2850 字节的错误码约定仍整册注入。
- 触发靠 `tools/result` 追踪 `read` / `write` / `edit` 的 `file_path`。**用 shell 改文件不触发**（DSH 自带的指令加载器划的是同一条边界）；兜底是 `rule_read`，新建文件前先读同类文件同样适用。
- frontmatter 取值读不动时**报出来，不悄悄降级**：那册不会被当成常驻册，也不会消失，而是以按需规则身份留在清单里并附一行提示。

## 技能

`.workbuddy/skills/` 下的目录包（`<name>/SKILL.md`）与平铺文件（`<name>.md`）由注册到 `ctx.skills` 的 provider 发布，进入**原生 skill 目录**，由标准 `skill` 工具加载，相对资源（`scripts/`、`references/`）按 `resourceBase` 解析。

- rank 取 **250**：低于 `project-dsh`（100）与 `project-agents`（200），高于 `custom`（300）—真正为 DSH 编写的项目技能在重名时压过 WorkBuddy 副本。
- `disable-model-invocation` / `user-invocable` 走严格布尔语法；拼错的值**整册丢弃**并记 warn，而不是静默放行。
- 只有模型自己的 `write` / `edit` 会同步失效 provider；**没有 watcher**。

## 目录结构

```
package.json          # 包清单；dsh.bundle.patch 是「可被管理器安装的 Bundle」的入场券
cordis.patch.yml      # Bundle 载荷：把 workspace-conventions 这一行插进 profile 的层栈
tsconfig.json         # 独立严格配置（对齐 harness 的 tsconfig.base.json 开关）
src/index.ts          # 装配层：配置、13 个工具、7 个 prompt 段落、技能 provider、触碰追踪
src/scope.ts          # 双层作用域：全局根解析、各层目录、路径包含判断
src/persona.ts        # 人格片段（纯逻辑）：解析、排序、遮蔽合并、预算渲染
src/mood.ts           # 情绪状态（纯逻辑）：解析/生成、半衰期衰减、确定性渲染、「情绪维护」段落文本
src/approval.ts       # 写入审批（纯逻辑）：哪些调用要问、摘要裁剪与审批提示文本
src/memory.ts         # 记忆模型（纯逻辑）：准入、条目渲染、索引编辑、流水盘点
src/rules.ts          # 规则册解析、分类、触发判定、段落渲染与预算
src/skills.ts         # 技能包解析与 ctx.skills provider 工厂
src/frontmatter.ts    # 刻意收窄的 YAML frontmatter 读取器
src/workspace-config.ts  # `.dsh/workspace.yml`：两轴开关、记忆布局、严格报错、惰性起手模板
src/patch.ts          # 同样刻意收窄的 Cordis patch 读取器（校验脚本与配置文件共用）
src/glob.ts           # ** / * / ? / {a,b} 的 glob→正则编译
src/text.ts           # 文本归一化、路径显示、字节裁剪
src/layout.ts         # 各层共用的目录名常量
scripts/verify-profile.mjs    # 校验 profile 的覆盖补丁真的命中了本包的行 id（见下）
scripts/verify-workbuddy.mjs  # 对着一个真实 WorkBuddy 项目跑一遍装配层，不重启 DSH 也能验证
tests/                # vitest 单测（含对真实 apply() 装配的端到端用例，以及对本仓库自身 patch 文件的断言）
docs/DESIGN.md        # 设计文档（英文）
docs/DESIGN.zh.md     # 设计文档中文版
docs/DESIGN-self-scopes.zh.md  # 双层作用域与 persona/mood 的设计（含全局根命名冲突评估）
docs/workspace-config.md  # 项目级配置文件的格式规格（含供其他插件复用的约定）
docs/verification/    # 实测证据归档（正向 / 降级 / 反向三组，含一个已修复缺陷的记录）
docs/legacy-preset/   # 历史留档：0.1.7 起被废弃的 $DSH_HOME/.agent-presets/memory/ 目录（其中保留旧包名属历史准确性）
```

## 项目级开关（`.dsh/workspace.yml`）

一个 profile 的一行服务所有工作区，所以"这个仓库关掉某层、或不看全局"只能由项目自己的文件说。开关分成**两条正交的轴**：

```yaml
# <项目>/.dsh/workspace.yml
workspace-conventions:
  # 第一轴：这一层是否启用
  memory: read-only     # enabled（默认）| read-only | disabled
  rules: false
  skills: false
  persona: true
  mood: true
  memoryLayout: auto    # auto（默认）| flat | host — 新流水写到哪里

  # 第二轴：是否继承全局作用域（false = 屏蔽全局，只看本工作区）
  inherit:
    persona: true
    mood: true
    memory: true
    rules: true
```

文件**不存在时会被自动创建**成一份全部注释掉的起手模板（不改变任何行为，只为可发现、可编辑）；已存在的文件永不覆盖。

- `memory: read-only` 不注入记忆段落、拒绝写入与提升，但读工具照常，只读不等于失明。
- `inherit.memory: false` 会让 `global-memory` 段落消失，并**连工具都拒绝** `scope="global"`——屏蔽要是能绕过的，就等于没屏蔽。
- `inherit.persona/mood/rules: false` 屏蔽该层的**全局来源**：注入与对全局的读写工具一起失效（全局写入会被拒），工作区自己的层照常。
- 未知键（包括 `inherit` 里拼错层名）或类型不对会**报错并停用所有层**：只报错却照跑默认值，等于让那个开关静默失效。
- `memoryLayout` 默认 `auto`：沿用目录里已有的布局（全新目录即平铺在 `memory/` 下）；它只决定**新流水写到哪里**，不搬动也不隐藏已有流水。只有 memory 有布局键——persona / mood / rules 没有，理由见 [DESIGN.zh.md](docs/DESIGN.zh.md) 的「为什么只有 memory 有布局」小节。
- 格式、错误语义、自动创建与重载规则、以及**供其他插件复用的约定**见 [docs/workspace-config.md](docs/workspace-config.md)。

`pnpm verify:workbuddy <工作区>` 会在报告开头列出该工作区生效的层开关，因此它不会对着一份已被关掉的工作区报告其实看不到的贡献。它是只读检查，不会替你创建配置文件（要验证创建路径本身时加 `--seed`）。

### 行配置（profile）：审批与情绪维护的开关

0.6.0 新增的三个键是**行配置**（profile 组合里 `workspace-conventions` 那一行的 `config:`），**不是这份项目文件里的键**：

| 键 | 默认 | 作用 |
|---|---|---|
| `approveGlobalMemory` | `true` | `scope="global"` 的 `memory_write` / `memory_promote` 是否先要一次性审批 |
| `approvePersonaWrite` | `true` | `persona_write`（工作区与全局两个作用域）是否先要一次性审批 |
| `moodProactive` | `true` | 是否注入「情绪维护」段落（还要求本文件的 `mood` 为真） |

边界是刻意的：行配置随 profile 生效、对该 profile 的所有工作区一致，属于**部署策略**；`.dsh/workspace.yml` 只说"这个项目里层开不开、是否继承全局"（`layers.*` / `inherit.*`）。把上面三个键写进 `.dsh/workspace.yml` 会命中**未知键**错误——报错并停用所有层，正是为了让"以为按项目关了审批"不可能悄悄发生。

于是项目级能控制的只有 `mood` / `inherit.mood`：要关掉情绪维护只能整体关情绪层；想保留情绪层、只关主动提醒，只能改 profile 的行配置（对所有工作区生效）。

### 开关 × 目录：一张对照表

先记住一条分界：**本插件的开关只管「本插件读的那些目录」**。DSH 自己还读另外几处目录，它们不受任何开关影响。最容易搞混的正是这一类，所以下表把它们一并列出并标明归属。

| 目录 | 谁读 | 启用开关 | 继承开关（`inherit.*`） |
|---|---|---|---|
| `.workbuddy/memory/` | 本插件（工作区记忆后端①） | `memory` | — |
| `.dsh/memory/` | 本插件（工作区记忆后端②） | `memory` | — |
| `.dsh/persona/` | 本插件（工作区人格） | `persona` | — |
| `.dsh/mood/` | 本插件（工作区情绪） | `mood` | — |
| `.workbuddy/rules/` | 本插件（工作区规则唯一来源） | `rules` | — |
| `.workbuddy/skills/` | 本插件 → 原生技能目录 | `skills` | — |
| `$DSH_HOME/memory/` | 本插件（全局记忆） | `memory` | `memory` |
| `$DSH_HOME/persona/` | 本插件（全局人格） | `persona` | `persona` |
| `$DSH_HOME/mood/` | 本插件（全局情绪） | `mood` | `mood` |
| `$DSH_HOME/rules/` | 本插件（全局规则） | `rules` | `rules` |
| `$DSH_HOME/skills/` | **DSH 原生** | ❌ 不受本插件影响，恒生效 | — |
| `.dsh/skills/` | **DSH 原生**（rank 100） | ❌ 不受影响，恒生效 | — |
| `.agents/skills/` | **DSH 原生**（rank 200） | ❌ 不受影响，恒生效 | — |
| `AGENTS.md` / `CLAUDE.md` | **DSH 原生**指令通道 | ❌ 与本插件无关 | — |
| **`.dsh/rules/`** | **无人读**（见下） | — | — |

图例：✅ 该开关控制它；❌ 与它无关；— 该开关不涉及这一列。

**`.dsh/rules/` 是死路径。** DSH 没有"规则"机制，它唯一的工作区指令通道是 `AGENTS.md` / `CLAUDE.md`（按同目录文件名候选加载，`.local.md` 叠加）。本插件只把 `.workbuddy/rules/` 当作规则来源，**从不读 `.dsh/rules/`**。把规则册放进 `.dsh/rules/` 不会有任何效果—这是最容易踩的一处歧义。

**`skills: false` 不等于"这个项目没有技能"。** 它只掐掉 `.workbuddy/skills/` → 原生技能目录这一条通道。`.dsh/skills/` 与 `.agents/skills/` 由 DSH 原生 provider 直接读取，开关管不到，也正因为这样关掉它不会影响你为 DSH 自己写的技能。

### 各层的状态矩阵

上一张表回答"哪里会被读"，这一张回答"各开关下**这一层本身**是什么状态"。

| 开关 | 提示段落 | 工具调用 | 实际效果 |
|---|---|---|---|
| `memory` 缺省（`enabled`） | 注入工作区索引（有全局内容时另注入全局索引） | 六个工具全部可用，`scope` 可选 | 读写都走探测到的后端 |
| `memory: read-only` | **不注入** | 读与诊断可用；`memory_write` / `memory_promote` 被拒并说明原因 | 只读 |
| `memory: false` / `disabled` | 不注入 | 六个工具**全部**被拒 | 不读不写 |
| `inherit.memory: false` | 全局索引不注入 | `scope="global"` 被拒；工作区记忆照常 | 屏蔽全局 |
| `persona` 缺省 | 注入 `## 人格`（全局 + 工作区，同名遮蔽） | `persona_read` / `persona_write` 可用 | 多片段合并 |
| `persona: false` | 不注入 | 两个工具被拒 | 不读不写 |
| `inherit.persona: false` | 只注入工作区片段 | 可写全局人格被拒 | 屏蔽全局人格 |
| `mood` 缺省 | 注入 `## 情绪`（衰减后，过期显示已平复） | `mood_get` / `mood_set` 可用 | 取最新一份 |
| `mood: false` | 不注入 | 两个工具被拒 | 不读不写 |
| `inherit.mood: false` | 只看工作区状态 | 写全局情绪被拒 | 屏蔽全局情绪 |
| `rules` 缺省 | 注入工作区常驻册 + 全局常驻册，条件册按触发 | `rule_read` / `rule_status` 可用 | 两套预算独立 |
| `rules: false` | 不注入 | 两者都被拒 | 不读，也不再记录触发 |
| `inherit.rules: false` | 只注入工作区常驻册 | `rule_read(scope=global)` 被拒 | 屏蔽全局规则 |
| `skills` 缺省 | —（技能不是提示段落） | 由标准 `skill` 工具加载 | 扫描 `.workbuddy/skills/` 并发布 |
| `skills: false` | — | 那批技能在目录里不存在 | **不扫描**该目录 |

几条需要解释的取舍：

- **工具是进程级注册的**（`ctx.tools.register` 在加载时跑一次，那时还不知道任何工作区），Cordis 也无法按工作区注销。所以"关层"的等价物是**调用被拒**，且拒绝信息指明是哪个文件里的哪个开关—而不是返回空结果让模型误以为"这个工作区什么都没有"。
- **只读时不注入记忆段落**：该段落承载的就是索引正文。只读工作区仍可用 `memory_read` / `memory_search` 取到同样内容，每轮再注入一遍只是重复付费。
- **屏蔽是彻底的**：`inherit.memory: false` 同时掐掉注入与工具的 `scope="global"` 路径。只掐一半会让开关变成装饰。
- **诊断工具随层一起被拒**：`memory: read-only` / `disabled` 下 `memory_status` 也被拒；要查生效开关与配置错误，用恒可用的 `rule_status`（带 `config` 字段）、`self_status`（带全部层与继承状态），或看 `pnpm verify:workbuddy` 报告的开头。
- **本插件不提供 GUI**：配置来源只有两处—层的开关与继承在项目级 `.dsh/workspace.yml`（唯一来源），字节预算、全局根、以及 0.6.0 的审批/情绪维护开关在 profile 的 `cordis.patch.yml`（面向整个 profile 的策略）。DSH 的 Client 侧没有通用文件写入服务，浏览器页面无法写项目文件，因此没有"在插件页里改项目开关"这条路。

### 记忆后端的选取与开关无关

后端是按**目录存在与否**选定的，与上面的开关相互独立：

| 项目里有什么 | 生效后端（`memory_status` 的 `mode`） |
|---|---|
| `.workbuddy/memory/` | `workbuddy`（兼容模式，按 WorkBuddy 原生准则注入写入准则） |
| 只有 `.dsh/memory/`，或两者都没有 | `dsh-default`（默认模式） |

`memory` 开关只决定**是否使用**探测到的后端，不改变探测结果。同一条"存在即优先"的分界也适用于 `.workbuddy/skills/`（对 `.dsh/skills/` 无影响，见上表）。

---

# 验证与开发

## 构建与测试

```powershell
pnpm install
pnpm build      # clean + tsc -p tsconfig.json -> lib/*.js + lib/*.d.ts
pnpm test       # vitest run
pnpm typecheck  # tsc -p tsconfig.json --noEmit
```

`lib/` 不入库（见 `.gitignore`），但**必须构建后才会被加载**，因为 DSH 按 `main`/`exports` 加载。`build` 会先清空 `lib/`：`tsc` 不会删除输出目录里已存在的陈旧文件，而校验脚本按固定路径 import 构建产物，留着旧副本会静默加载过期代码。

## 校验 profile 覆盖真的命中了

profile 用 `id` 定址来覆盖本包的行（见 `cordis.patch.yml` 与 profile 里的同名条目）。**行 id 一旦对不上，loader 只会警告并跳过该覆盖**，插件静默回落到本 bundle 自带的默认值，而 typecheck、单测、装配层直测都不会报错，因为它们都不读 profile。

```powershell
pnpm build
pnpm verify:profile
```

它按 loader 的两步（先取 bundle 插入行的 `config` 作基线，再用同 `id` 的 profile 条目**整体替换**）解出本机真正生效的配置，并与期望值比对；期望值默认 `rulesPromptBytes=32768`，可用 `--expect rulesPromptBytes=<n>` 覆盖，也可用 `--profile-dir <dir>` 指定别的 profile。id 漂移、profile 缺失、期望不符都会非零退出并指明原因。

## 对着真实项目验证

无需重启 DSH，直接拿一个已有 `.workbuddy/` 的项目跑一遍装配层：

```powershell
# 显式预算：用来压出降级形态，唯一能给「磁盘上并非当前配置」的预算做体检的方式
pnpm verify:workbuddy "D:\Work\GameCatStudio\Escort\program" 32768
pnpm verify:workbuddy "D:\Work\GameCatStudio\Escort\program" 20000

# 用本机 profile 真正生效的预算（缺省 49152 只在 --profile 之外出现）
pnpm verify:workbuddy "D:\Work\GameCatStudio\Escort\program" --profile
```

不传预算时默认 49152（bundle 基线）；`--profile` 则从 bundle patch + profile patch 解出本机实际预算再跑，因此它在报告里给出的结论对应你真正运行的那份配置。

它会报告该工作区各层的实际贡献（记忆后端、每册规则的分类与注入字节数、全部技能候选），逐个触碰每册条件册的触发 glob，并把每册判为 `FULL` / `PTR` / `NAME` / `LOST`。触发用的样本路径由 `src/glob.ts` 的同一个匹配器反向校验，globs 无法反推时会明确报告而不是静默跳过；`LOST`、未点名、或超预算都会让脚本**非零退出**。

改动规则渲染层或预算准入后，请用同一命令与 [docs/verification/](docs/verification/) 里归档的形态对照。

## 安装（作为 Bundle 装进某个 profile）

本地开发用绝对路径安装：

```powershell
# 1) 装进 profile（CLI 转发给 pnpm，cwd = profile 目录）
dsh plugin --profile web add <本仓库所在目录的绝对路径>

# 2) 把包名加进 profile 的 bundle 列表（这一步决定它是否真的被当作层加载）
#    文件：%USERPROFILE%\.dsh\profiles\web\package.json
#      "dsh": { "profile": { "bundles": [ "...", "@jinngoo/dsh-workspace-conventions" ] } }
#    或用 Web GUI：设置 → 插件 → 安装 Bundle（会同时完成 1 和 2）

# 3) 校验组合结果里出现了这一行
dsh --profile web --dump-config | Select-String workspace-conventions

# 4) 重启 dsh（ESM 模块在进程内缓存）
```

发布到 registry 后就可以只写包名：`dsh plugin --profile web add @jinngoo/dsh-workspace-conventions`。

## 开发循环

改 `src/*.ts` → `pnpm build` → 重启 dsh。因为安装的是本地目录链接，不需要重装。

注意：Bundle 自己的 `cordis.patch.yml` **不在 HMR 监听范围内**（只监听 profile 的 `package.json`、profile 的 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`），所以改 patch 文件必须重启；改 `dsh.profile.bundles` 是热生效的。

## 升级注意

- 兼容门禁在 dsh 0.2.1-alpha.3 起**先看 `engines.dsh`**；声明了它，dsh peer 范围就不再参与判定。本包声明 `engines.dsh: ^0.2.0-rc.1`，peer 也收窄到 `^0.2.0-rc.1`（0.1.x 不再承诺：构建用的静态类型已对齐到 0.2.1-rc.2，和 0.1.x 的运行时不再保证一致）。升到 dsh 0.3 时先改这两处，或用 `dsh plugin --profile web allow-version` 授予精确版本豁免；否则**整个 Bundle 会在启动时被静默跳过**（不报错，只在日志里留一行）。
- 门禁的 semver 判定带 `includePrerelease: true`（`packages/boot/app-boot/src/plugin-compatibility.ts`），所以 `^0.2.0-rc.1` 能接受 `0.2.1-rc.2`；但同一范围在**不带该选项**的普通 `semver.satisfies` 里会判 false——自己写校验脚本时别用默认选项，否则会得到与 DSH 相反的结论。
- `devDependencies` 里的 `@deepseek-ai/dsh-*` 必须与**正在跑的运行时**同一个版本：它是构建时的类型来源，也是 `link:` 安装后插件自己 `node_modules` 里的运行时副本来源。两者错版时 typecheck 全绿也说明不了运行时契约。
- `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 不是 dsh 包，不参与兼容门禁；但版本要和 harness 的 vendored 副本对齐（当前 4.0.5 / 3.18.5），否则 `Config` 会被当成非原生 schema。
- `skills` 是**硬依赖**：DSH 的 web profile 里 skill 注册表恒在 host 平面（被禁用的只有各 preset 自己挂载的 `skill-filesystem` 行），缺注册表的组合本来就用不了技能。本行选择在挂载时直接报错，而不是静默降级。

## 已知限制（当前版本）

- **全局写入受沙箱策略约束**：`$DSH_HOME` 在工作区之外，`workspace-write` 下写入被拒（工具会说明并建议 `scope="workspace"`）；`danger-full-access` 或把该路径纳入允许范围时才能写。
- **写入审批只覆盖本插件的工具**：模型仍可用通用 `write` / `edit` 直接改 `$DSH_HOME/persona`、mood 文件——那两条工具没有接审批。把通用文件工具纳入统一门禁是 phase 2 的工作；0.6.0 只保证"经本插件写入"这条路可审计，不假装它是完整边界。
- **审批没有"总是允许"**：每笔全局记忆/人格写入都要单独批准；会话审批策略 `never`、或部署没有任何应答方时，一律确定性拒绝（fail-closed），模型看到可读的拒绝原因。
- **`moodProactive` 是行配置**：单个项目无法只关「情绪维护」而保留情绪层——`.dsh/workspace.yml` 里只有 `mood` / `inherit.mood`；按项目控制只能整体关 `mood`。
- **情绪维护只是鼓励**：prompt 段落表达不了"必须调用工具"，也没有每轮自动写入；真自动化需要一个常驻循环（daemon-loop）插件，本行不做。
- **全局层在本进程内缓存**：外部直接改 `$DSH_HOME/{persona,mood,memory,rules}` 不会实时生效，要等下一个新会话（`agent/created` 会重读）、经工具的一次写入，或重启进程。
- 写入是整文件读—改—写，**无锁**；同一工作区并发写可能丢一次写入（全局层同此，且跨工作区共享，风险更高）。
- 工作区缓存冷启动会先渲染**一轮预热提示**（因为 prompt provider 契约要求同步返回）；规则段落在冷却时渲染空串而非提示。
- 索引注入有 7000 字节上限（`indexPromptBytes`），全局索引用 `globalIndexPromptBytes`（默认 3 KB），超出部分需用 `memory_read` 读。
- 人格/情绪/规则都**没有 watcher**：外部编辑在下一个新会话或下一次工具写入时才被看到。
- 情绪的衰减在**渲染时**计算，不落盘；`current.md` 只有一个当前状态，不保留历史。
- 后端按目录**存在性**选择：中途创建 `.workbuddy/memory` 会切后端，已写入 `.dsh/memory` 的记忆**不会迁移**。
- 流水布局按**目录形状**探测：出现装着日期文件的计算机名子目录即切到「按本机目录读写」，子目录清空后回落平铺。计算机名取 `hostname` 输出；已有目录按「精确同名优先、其次忽略大小写」复用，因此同一台机器不同大小写的目录名不会被当成两台。
- 只能新增，**没有删除/过期**工具（记忆与人格都是；情绪可覆盖）。
- 规则**只认 DSH 的结构化文件工具**（`read` / `write` / `edit` 的 `file_path`）；shell 改文件不触发条件册。
- 规则触发状态**在进程内累积、不落盘**；会话中途改 rules 文件不重载。
- 技能**没有 watcher**，且只认**一层深度**（`<name>/SKILL.md`、`<name>.md`）。
- frontmatter 只读一个子集：扁平 `key: scalar`、块状列表、行内列表；嵌套映射、多行标量、锚点不解释。

设计细节与逐层取舍见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md)（[English](docs/DESIGN.md)）。

## 变更记录

### 0.6.0 — 写入审批与情绪维护

- **写入审批**：`memory_write` / `memory_promote` 的 `scope="global"`、以及 `persona_write`（工作区与全局两个作用域）在工具体执行前，经 DSH approval seam 请求**一次性**同意（`tools/pre-execute` → `{kind:'ask'}`，只接受 `allowed-once`）。拒绝/取消/无应答方 = DSH 拒绝调用、工具体从未执行；会话策略 `never` 确定性拒绝。工作区记忆写入、`mood_set`、全部读取不受影响。没有"总是允许"。
- **三个行配置**：`approveGlobalMemory` / `approvePersonaWrite` / `moodProactive`，全部布尔、默认 `true`。属于 profile 的行配置，**不能**写进 `.dsh/workspace.yml`；项目级开关仍是 `layers.*` / `inherit.*`。
- **情绪维护段落**：新增同步 provider `workspace-mood-maintenance`（order 53），在情绪层开着且 `moodProactive` 为真时注入 `## 情绪维护`，鼓励在明确状态变化时顺手 `mood_set`（阶段切换、被纠正、卡住后突破、长任务收尾），并说明不要每轮写、情绪不是记忆；没有情绪记录时多一行第一次写入的邀请，有状态后消失。任一开关关闭 = 0 token，衰减逻辑不变。
- **明确留给 phase 2**：通用 `write` / `edit` 仍可绕过审批直接改人格/情绪文件；本版只门本插件自己的工具。
- prompt 段落 6 → 7 个；工具仍为 13 个。

### 0.5.1 — 缓存与上下文优化

- **mood 注入文本改为缓存友好**：去掉精确强度（连续变化，会每几分钟改一次文本），年龄改为粗桶（`刚刚` / `约半小时前` / `约 N 小时前`）。同一份状态在 2 小时窗口内渲染出的不同文本从 **71 种降到 4 种**，runtime-context 快照的追加频率从「每分钟」降到「每小时」量级。精确 `weight` 仍可从 `mood_get` / `self_status` 取。
- **工作区记忆段落瘦身**：去掉与工具 schema 重复的工具清单行，以及已被 runtime context 覆盖的工作区路径行（每次会话约省 140 字节；这是每会话固定的上下文）。
- **工具描述精简**：`memory_write` / `memory_read` 去掉与 `memory_help`、`memory_status` 输出重复的布局说明，13 个工具 schema 从 5409 → 5293 字节。
- 背景（实测于本会话日志）：插件内容作为 **user 角色 runtime-context 快照**追加在历史末尾，只在文本变化时追加（`runtime-context.ts` 的 `project()` 比对），因此不破坏前缀缓存；378 次请求的缓存命中率为 **97.1%**（111.5M 命中 / 3.3M 未缓存输入），重启后的首个 turn 掉到 76% 再回升。真正需要控制的是**变化频率**，而不是「每轮都发」——LLM API 无状态，完整上下文本来就每轮重发。

### 0.5.0 — 双层作用域与「自我层」

- **新增全局作用域**：`$DSH_HOME/{persona,mood,memory,rules}`，与工作区 `<project>/.dsh/` 对称；全局根可用 `globalRoot` 覆盖（`$DSH_HOME` 下这些名字目前无人占用，但未来被其他机制征用时这是逃生门）。
- **新增 persona（人格）层**：`.dsh/persona/*.md` + `$DSH_HOME/persona/*.md`，按片段合并、同名工作区遮蔽全局、独立预算（`personaPromptBytes` / `personaFileBytes`），段落 order 50；工具 `persona_read` / `persona_write`。
- **新增 mood（情绪）层**：`.dsh/mood/current.md` + 全局同名文件，按半衰期衰减（`moodHalfLifeHours` 默认 6、`moodMaxAgeHours` 默认 48），过期渲染为「已平复」，段落 order 52；工具 `mood_get` / `mood_set`。
- **记忆与规则接入全局**：全局记忆索引（order 58，独立预算 `globalIndexPromptBytes`）与全局规则段（order 54，独立预算 `globalRulesPromptBytes`）；`memory_*` 与 `rule_read` 增加 `scope` 参数，`memory_search` 默认 `both`；全局记忆写入只接受 `preference`/`constraint`/`convention`/`decision` 四类。
- **workspace.yml 增加第二轴**：`persona` / `mood` 启用开关与嵌套 `inherit.{persona,mood,memory,rules}` 继承开关；未知键与 `inherit` 里拼错的层名仍按既有防御停用所有层。起手模板同步更新（仍全注释、仍惰性创建）。
- **新增 `self_status` 工具**：一张全景表（两作用域 × 各层的目录/条目/字节/预算/继承/情绪衰减/阻塞原因），`memory_status` 增加 `global` 段并删除 `globalScope: 未实现` 占位。
- **全局写入的错误可读**：写入 `$DSH_HOME` 被策略拒绝时返回原因与替代方案，而不是抛裸错。
- 测试：239 → 258 个用例（persona 34、mood 47、scope 8、全局装配层 7、inherit 配置 5），`pnpm typecheck` 与 `pnpm test` 全绿；起手模板惰性由测试保证（全注释、可读回默认值）。
- 修复：`ensureWorkspaceConfig` 现在在写入前**再检查一次**文件是否已存在，避免与刚创建该文件的进程/编辑器竞态而覆盖用户内容。

### 0.4.1 — 对齐 DSH 0.2.1-rc.2

- **构建与运行时版本对齐**：`devDependencies` 的 8 个 `@deepseek-ai/dsh-*` 从 `0.1.7-rc.2` 升到 `0.2.1-rc.2`，`@deepseek-ai/cordis` → `^4.0.5`、`@deepseek-ai/schemastery` → `^3.18.5`。之前是拿 0.1.7 的类型构建、在 0.2.1 的运行时里跑；`link:` 安装下插件自身的 `node_modules` 就是运行时解析目标，错版会让 `Config` 识别、tool/skill 注册这些契约在"类型绿、运行时未知"的状态里。
- **声明 `engines.dsh: ^0.2.0-rc.1`**（dsh 0.2.1-alpha.3 起先看 `engines.dsh`，声明后 peer 范围不再参与判定），peer 同步收窄到 `^0.2.0-rc.1`，去掉 0.1.x 承诺。
- **不兼容的测试改为按机器条件跳过**：`tests/patch.spec.ts` 里那条「本机 profile 覆盖了基线」断言原本只判断 profile patch 文件**存在**就要求它有本行覆盖，因此任何没手写 profile 覆盖的机器（含 CI）都会红。现在改为解析 profile patch、确认真的含 `workspace-conventions` 行才断言。这是测试的环境依赖缺陷，不是插件行为变更。
- 用 0.2.1-rc.2 的类型重跑 `pnpm typecheck` 无改动通过，`ctx.tools.register` / `defineTool`、`ctx.skills.registerProvider`、`ctx.systemPrompt.context`、`ctx.agents`、`ctx.sandboxPolicy.resolve`、`ctx.fs`、事件 `tools/result` 与 `agent/created` 均未发生签名漂移。
