# 双层作用域：全局 + 工作区的人格 / 情绪 / 记忆 / 规则

> 状态：**已实现（v0.5.0）**。本文保留原始设计，并在 §13 记录落地时的偏离；§3.1 是全局根命名冲突的评估。
> 本文回答三件事：为什么这么设计、文件放在哪、模型与工具看到什么。

## 1. 你的意图，我的理解

你提的三条约束合起来其实是在要一个**有"自我"的 agent**，而不是一个只会读项目文档的工具：

1. **"全局 + 工作空间级别"** —— 有些东西属于"我是谁"（语气、价值观、偏好、长期记忆），跨项目不变；有些属于"这个项目"（它的约定、它的进度），只在当前工作区成立。两者要能同时存在、能覆盖、能屏蔽。
2. **"不要都写进一个 AGENTS.md"** —— 单一聚合文件必然变成垃圾场：谁也说不清一段文字属于人格还是项目事实，改一处要读全文，超预算时整段被裁剪。所以**按语义分文件、分目录**，每类有自己的预算、自己的工具、自己的失效方式。
3. **"workspace.yml 里加开关控制屏蔽/继承"** —— 你要的是**每工作区可裁的视野**：在私人项目里继承全局人格，在公司项目里屏蔽它；某个项目只要它自己的记忆，不要看到其他项目的记忆。

DSH 本身只提供两样东西：全局 `AGENTS.md` 注入、preset 里的 persona 段落（首轮后锁定）。它们都是**静态文本**，没有写入、没有衰减、没有作用域覆盖。所以这些能力只能由本插件补，且必须沿用它已有的两条承重约束（同步 prompt provider、写入带沙箱策略）。

## 2. 设计原则

| 原则 | 落实 |
|---|---|
| **作用域正交** | 「层是否启用」与「是否继承全局」是两个独立开关，不揉成一个枚举 |
| **每类一个目录** | persona / mood / memory / rules 各自独立文件树，互不混写 |
| **全局空目录零开销** | 没建全局文件时，行为与今天完全一致（默认继承 = 继承空集） |
| **工作区可覆盖单条** | 同名文件/片段由工作区**整体遮蔽**全局那一份，而不是拼接成两段矛盾文本 |
| **预算按层独立** | 一个层超预算不挤占另一个层；都按"实际拼装出的字符串"计量（沿用 rules 的做法） |
| **不可读就报出来** | frontmatter 坏、目录不可读、开关拼错：报错/降级可观测，不静默猜 |

## 3. 目录布局

**工作区作用域**（沿用现有根，新增两类目录）：

```
<workspace>/.dsh/
  memory/MEMORY.md          # 工作区索引（既有）
  memory/YYYY-MM-DD.md      # 工作区流水（既有）
  persona/01-identity.md    # 新增：人格片段（多文件，按文件名排序）
  persona/02-voice.md
  mood/current.md           # 新增：情绪状态（单文件，可覆盖）
  rules/*.md                # 可选：与 .workbuddy/rules 同语义（新增工作区根）
```

**全局作用域**（新增，`$DSH_HOME` = `~/.dsh`，与工作区 `.dsh/` 对称）：

```
$DSH_HOME/
  memory/MEMORY.md          # 全局索引：跨工作区稳定的事实
  memory/YYYY-MM-DD.md      # 全局流水
  persona/01-identity.md    # 全局人格片段
  mood/current.md           # 全局情绪（跨工作区的整体状态）
  rules/*.md                # 全局规则（alwaysApply / paths 同语义）
```

**为什么是 `$DSH_HOME` 顶层而不是 `$DSH_HOME/self/`**：工作区侧的类比物是 `<ws>/.dsh/`，全局侧的类比物就是 `$DSH_HOME/`，父子关系一致（`profiles/`、`sessions/` 是 DSH 自己的目录，与本插件不冲突）。备选方案 `$DSH_HOME/self/` 更整洁但多一层无意义的层级——**这点可以改主意，实现成本为零**。

### 3.1 命名冲突评估（为什么这样是安全的）

在 DSH 0.2.1-rc.2 的源码里枚举 `$DSH_HOME` 下被占用的顶层名字，实际只有这些：

| 已被占用 | 占用者 | 与本插件的关系 |
|---|---|---|
| `profiles/`、`sessions/`、`storages/`、`attachments/`、`cache/` | DSH 核心 | 不冲突 |
| `skills/` | `dsh-skill-filesystem`（全局技能根） | **本插件刻意不接管**，避免双重注册 |
| `cordis.patch.yml`、`cordis.yml`、`settings.yaml`、`.credentials.yaml`、`.anonymous-user-id`、`.env` | DSH 配置/凭据/遥测 | 不冲突 |
| `persona/`、`mood/`、`memory/`、`rules/` | 无人占用 | 本插件使用 |

风险与对策：

- **未来被 DSH 或别的插件征用**：`globalRoot` 行配置可把四层整体搬到任意目录（`globalRoot: ~/.dsh/self` 之类），无需改代码；`resolveGlobalRoot` 的优先级是 `globalRoot` > `$DSH_HOME` > `~/.dsh`。
- **目录被别的东西占了**：本插件的探测只认目录；若同名路径是一个文件，会被当作「不存在」而不是覆盖写入；`self_status` 会报告实际路径，便于发现异常。
- **为什么不加命名空间**：`$DSH_HOME/{persona,mood,memory,rules}` 与工作区 `<ws>/.dsh/{...}` 完全对称，可发现性与「手写一个文件就生效」的体验最好；命名空间会牺牲这一点换取一个当前不存在的风险。真出现冲突时，一次配置迁移即可。

**技能不重复造轮子**：`$DSH_HOME/skills` 已经是 DSH 原生的全局技能根（`skill-filesystem`），本插件**不碰**；工作区的 `.workbuddy/skills` 维持现状。所以 `skills` 这一层没有"全局继承"开关——它本来就全局生效。

**WorkBuddy 兼容**：`.workbuddy/memory`、`.workbuddy/rules`、`.workbuddy/skills` 维持既有优先级；全局侧不引入 WorkBuddy 形态（WorkBuddy 没有全局概念）。

## 4. 五类内容的语义

### 4.1 persona（人格）— 每轮注入，order 50

- **文件**：`persona/*.md`，可多片段；按文件名自然排序（`01-`、`02-`），frontmatter 可选 `title`、`order`（覆盖文件名排序）。
- **合并**：先全局片段（升序），再工作区片段；**同名文件遮蔽**（工作区的 `01-identity.md` 整体替换全局同名片段）。
- **注入**：`## 人格` 章节，每片段一个 `### <title 或文件名>`；整段受 `personaPromptBytes` 限制，单片段受 `personaFileBytes` 限制；超限片段截断并在原处留 `persona_read` 指针。
- **内容纪律**：身份、语气、价值观、禁忌、协作偏好。**项目事实属于 memory，不属于 persona**——这条会写进模板注释，因为混淆是这套系统最常见的腐化方式。
- **写入**：`persona_write`，默认拒绝密钥/PII（复用记忆的准入判定），单片段上限硬性拒绝。

### 4.2 mood（情绪）— 每轮注入，order 52，**带衰减**

情绪和人格的区别是**有时效**。设计成一个很小的状态文件：

```markdown
---
label: 专注
valence: 0.4        # -1 消极 … +1 积极
arousal: 0.3        # 0 平静 … 1 亢奋
updated: 2026-10-23T00:12:00+08:00
---
正在收尾一个插件设计，节奏紧凑但不急躁。
```

- **渲染**（每轮重算，不落盘）：`age = now - updated`，`weight = 0.5 ** (age / halfLife)`；
  - `weight ≥ 0.05` 且未超过 `moodMaxAgeHours` → 注入一行：`当前情绪：专注（偏积极、平静，强度 0.72，3 小时前）` + 正文；
  - 过期或权重过低 → 注入一行 `当前情绪：已平复`（可选，见开关），而不是假装还激动。
- **衰减参数**：`moodHalfLifeHours`（默认 6）、`moodMaxAgeHours`（默认 48）。
- **合并**：不混合打分（混合没有客观依据）。规则是**取最新一份**：工作区与全局都有时，谁的 `updated` 新用谁；`inherit.mood = false` 时只看工作区。
- **写入**：`mood_set`（`label`/`valence`/`arousal`/`note`/`scope`），自动写 `updated`；正文上限 1024 字节。**不写历史流水**（避免又一处无限增长）；需要留档时模型自己写 memory。
- **为什么不给情绪单独的工具去"表达"**：它只是 prompt 里的一个小状态；工具只负责读写状态本身。

### 4.3 memory（记忆）— 每轮注入，order 58（全局）/ 60（工作区）

- 结构、准入、索引+流水模型**完全复用现有实现**，只是把「后端解析」从单作用域扩展到 `(scope, backend)` 列表——这正是 `docs/DESIGN.zh.md:236` 预留的接缝。
- **注入**：两段独立章节，各用各的预算（`globalIndexPromptBytes` / `indexPromptBytes`）：
  ```
  ## 全局记忆
  <全局 MEMORY.md 的章节，超出预算截断并留 memory_read(scope=global) 指针>
  ## 工作区记忆
  <现有内容>
  ```
- **工具**：`memory_read` / `memory_search` / `memory_write` / `memory_promote` 增加 `scope: workspace | global | both`（默认 `workspace`；`search` 默认 `both`，因为跨作用区检索正是它存在的理由）。
- **写准入**：全局写入走同一套 `evaluateEntry`（密钥/PII 硬拒、流水账软拒）。**全局记忆该比工作区更严格**：写全局流水时要求 `kind` 属于 `preference|constraint|convention|decision`（事实/环境类默认留在工作区），防止"这个项目的一次性发现"污染全局——这条是新增的定向护栏。
- **布局探测**：全局记忆同样支持平铺与按计算机名分目录（`memory/<host>/`），复用 `scanLedgers` / `ledgerWritePath`。

### 4.4 rules（规则）— 每轮注入，order 55（沿用）

- 新增全局根 `$DSH_HOME/rules/*.md`，语义与 `.workbuddy/rules` 完全一致（`alwaysApply`、`paths`、按需）。
- **合并**：全局常驻册 + 工作区常驻册都注入（同名文件工作区遮蔽全局）；条件册的 glob 对**工作区相对路径**匹配——全局规则可以写"动到 `**/*.cs` 时提醒"，对任何工作区都成立。
- **预算**：两段共享一个总预算会互相饿死，所以拆成 `rulesPromptBytes`（工作区）与 `globalRulesPromptBytes`（全局），各自独立准入、独立降级（FULL/PTR/NAME 逻辑复用）。
- **触发状态**：按 (工作区, 册) 记账，全局册与工作区册同表，互不影响。

### 4.5 skills — 不新增

`$DSH_HOME/skills` 由 DSH 原生加载，本插件不注册、不管理、不注入。`workspace.yml` 的 `skills` 开关仍只作用于 `.workbuddy/skills`。

## 5. workspace.yml 开关（两轴正交）

```yaml
version: 1
layers:                     # 便捷段：作用于每个插件段，支持同样这些键
  persona: true

workspace-conventions:
  # 第一轴：这一层是否启用（沿用既有风格）
  memory: enabled           # enabled | read-only | disabled
  rules: true               # true | false
  skills: true              # true | false
  persona: true             # 新增
  mood: true                # 新增

  # 第二轴：是否继承全局作用域（新增，全部默认 true）
  inherit:
    persona: true
    mood: true
    memory: true
    rules: true

  memoryLayout: auto        # 既有：auto | flat | host（只影响工作区后端探测）
```

语义：

| 开关 | `inherit: true`（默认） | `inherit: false` |
|---|---|---|
| `persona: true` | 全局片段 + 工作区片段，同名遮蔽 | 只注入工作区片段（全局人格被屏蔽） |
| `mood: true` | 取最新一份状态 | 只看工作区状态 |
| `memory: enabled` | 两段索引都注入；写入按 scope | 只注入工作区索引；`memory_*` 的 `scope=global` 被拒 |
| `rules: true` | 全局册 + 工作区册 | 只注入工作区册 |

- **层关闭优先于继承**：`persona: false` 时无论 `inherit` 与否都不注入。
- **继承是"注入侧"的开关，也是"工具默认作用域"的开关**：屏蔽全局记忆后，`memory_*` 显式传 `scope: global` 也会被拒（屏蔽要彻底，否则等于没屏蔽）；但 `self_status` 仍报告全局文件存在，便于你知道"有被屏蔽的东西"。
- **拼错的处理**：未知键/非法取值 → 全层 fail-closed（沿用现有防御），并在 `self_status` 的 `config.issues` 里给出可读原因。

## 6. 工具面（新增 5 个，共 13 个）

| 工具 | 参数 | 作用 |
|---|---|---|
| `self_status` | `{}` | 一张全景表：每个作用域 × 每层的根目录/文件数/字节/是否注入/预算/被开关屏蔽的原因；mood 的 `updated`/衰减后强度/是否过期 |
| `persona_read` | `scope?`, `name?` | 读某片段全文（绕过 `personaFileBytes` 截断）；`name` 省略时返回清单 |
| `persona_write` | `scope`, `name`, `content`, `mode: replace\|append`, `force?` | 写人格片段；`replace` 为默认；准入拒绝密钥/PII、单片段超 `personaFileBytes` 硬拒 |
| `mood_get` | `scope?` | 读原始状态 + 衰减后视图（含"已过期"判定） |
| `mood_set` | `scope`, `label`, `valence?`, `arousal?`, `note?` | 写情绪状态，自动 `updated: now`，正文上限 1024B |

既有工具改动：

- `memory_read` / `memory_search` / `memory_write` / `memory_promote`：加 `scope`（默认 `workspace`，`search` 默认 `both`）。
- `rule_status` / `rule_read`：加 `scope`，`rule_status` 同时报告全局与工作区两套册子。
- `memory_status`：保留（兼容），内部改为委托 `self_status` 的一部分。
- `memory_help`：扩展为说明"全局 vs 工作区该怎么选"的判定规则。

## 7. prompt 段落与顺序

| order | 段落 | 预算字段 |
|---|---|---|
| 50 | `persona`（人格） | `personaPromptBytes`（默认 3072） |
| 52 | `mood`（情绪） | `moodPromptBytes`（默认 512） |
| 55 | `workspace-rules`（既有，内含全局册段） | `rulesPromptBytes` / `globalRulesPromptBytes` |
| 58 | `global-memory`（全局记忆索引） | `globalIndexPromptBytes`（默认 3072） |
| 60 | `workspace-memory`（既有） | `indexPromptBytes`（既有 7000） |

- 全部沿用 `systemPrompt.context()`（**同步 provider**）：每作用域每层的文本异步探测进缓存，渲染时同步读缓存；`agent/created` 预热两套作用域。
- 空目录 → 段落不出现（返回空串），零 token 开销。

## 8. 全局写入的三个现实约束

1. **沙箱策略**：全局文件在工作区之外，`workspace-write` 模式下写入必须被拒绝。实现上所有写入都过 `sandboxPolicy.resolve({ session })`：被拒时工具返回可执行的原因（"当前策略不允许写 `$DSH_HOME`，可改用 `scope: workspace` 或把该目录加入允许列表"），而不是静默失败或越过策略。
2. **并发**：多个工作区的会话共享同一份全局文件。写入用「临时文件 + rename」原子替换；追加用 `appendFile`；索引的读—改—写加一个 `memory/.lock`（`open('wx')` + 过期判定），拿不到锁时返回"稍后重试"而不是丢写入。
3. **可见性**：全局写入成功后，下一个请求就会出现在所有工作区的注入里——这是特性，也是风险。所以 `memory_write scope=global` 的返回体会明确写"此条将对所有工作区可见"，并且准入门槛更高（见 4.3）。

## 9. 兼容与迁移

| 场景 | 行为 |
|---|---|
| 升级到 v0.5.0 | 全局目录不存在 = 空集，**行为与 v0.4.1 完全一致**；工作区布局不变 |
| 已有 `.dsh/workspace.yml` | 缺 `persona`/`mood`/`inherit` 键时取默认（启用 + 继承），无需改文件 |
| 新的起手模板 | 生成时带上带注释的新键（全注释 = 三层全开 + 两作用域继承） |
| 回退到 v0.4.x | 旧版本遇到新键会 fail-closed（既有防御）→ 需要把新键删掉才能回退；README 会写明 |
| 数据迁移 | **不做**。已有工作区记忆留在原位；全局记忆从空开始，由模型/人按需写入 |
| 记忆后端优先级 | 全局侧只有一种形态（Markdown）；工作区侧维持 workbuddy > dsh-default |

## 10. 配置项汇总（新增 6 个，均有默认值）

| 字段 | 默认 | 含义 |
|---|---|---|
| `personaPromptBytes` | `3072` | 人格段落总预算 |
| `personaFileBytes` | `8192` | 单人片段上限（超出截断 + `persona_read` 指针） |
| `moodPromptBytes` | `512` | 情绪段落预算（很紧，故意） |
| `moodHalfLifeHours` | `6` | 情绪半衰期 |
| `moodMaxAgeHours` | `48` | 超过即视为平复，不再注入具体情绪 |
| `globalIndexPromptBytes` | `3072` | 全局记忆索引预算 |
| `globalRulesPromptBytes` | `12288` | 全局规则预算 |

既有 `indexPromptBytes` / `rulesPromptBytes` / `ruleFileBytes` 含义不变（只作用于工作区）。

## 11. 分阶段实现计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| S1 | 作用域抽象：`(scope, root, backend)` 解析、`inherit` 开关、memory/rules 接全局、既有工具加 `scope` | 单测：空全局无行为变化；开关矩阵；工作区遮蔽全局 |
| S2 | persona 层：多片段扫描/合并/预算/注入、`persona_*` 工具 | 单测：遮蔽、超预算降级、准入拒绝 |
| S3 | mood 层：状态读写、衰减渲染、`mood_*` 工具 | 单测：半衰期边界、过期不注入、取最新作用域 |
| S4 | `self_status`、`workspace.yml` 模板、README/DESIGN 更新、`verify:workbuddy` 扩展 | 既有 158 测试全绿；新增用例覆盖每层 |

每个阶段独立可编译、可测；S4 结束跑一次真实工作区验收（全局 persona + 工作区遮蔽 + 全局记忆跨两个临时工作区可见）。

## 12. 明确不做

- 不做向量检索/embedding（记忆是 Markdown + 字面检索，DSH 的哲学是"证据留在原地"）。
- 不做自动遗忘/摘要（流水永不删；索引靠准入与预算控制）。
- 不做"会话内可演化人格"——preset 首轮后锁定是 DSH 的既定语义，人格变更是显式写入。
- 不做 GUI 配置页（写不了项目文件，与既有结论一致）。
- 不接管 `$DSH_HOME/skills`、不接管 `AGENTS.md`（两者是 DSH 原生通道，避免双重注入）。

## 13. 落地时的偏离（v0.5.0 实现记录）

| 设计 | 落地 | 原因 |
|---|---|---|
| 情绪过期「可选地」注入「已平复」 | 固定注入一行「已平复」（`renderQuiet: true`）；**从未写过状态文件时返回空串** | 有状态但过期，与从未有过状态是两件事：前者说明「它曾经在、现在平了」，后者没有任何可说的 |
| 全局记忆段总是渲染 | 全局库为空（无索引、无流水）时**不注入** | 一段只会说「这里还没有东西」的 prompt 是纯 token 成本 |
| 规则新增工作区 `.dsh/rules` 可选根 | 未加；工作区规则仍只有 `.workbuddy/rules` | DSH 不读 `.dsh/rules`，本插件再加一个只给自己读的根只会制造「放这里为什么不生效」的歧义；全局规则根仍新增 |
| 全局写入「要求 kind 属于四类」 | 实现为**硬拒**（不可 `force`） | 一次性项目事实写进全局是错误分类，不是需要确认的风险 |
| `globalRoot` 默认 `$DSH_HOME` 字面量 | 默认空字符串，表示「跟随 `$DSH_HOME`，再退 `~/.dsh`」 | 让测试与多 home 场景无需硬编码；与 DSH 自己的 home 解析同一顺序 |
| 每层一份预算 | 工作区与全局的 rules / memory 各自独立预算 | 共享预算会让一个作用域的膨胀饿死另一个，且两个作用域的内容相关度不同 |
| 情绪合并「取最新一份」 | 实现为「年龄最小者胜」，不可解析 `updated` 的一律不赢 | 语义等价，但避免对 NaN 排序 |
| 起手模板 ≤ 20 行 | 放宽到 ≤ 32 行 | 第二轴（`inherit`）需要可发现的位置；仍全注释、仍惰性创建、仍可读回默认值 |
| 全局层「进程内缓存」 | `agent/created` 与工具写入时重读 | 没有 watcher；新会话是外部编辑唯一确定可见的时机 |

**验证**：`pnpm typecheck` 0；`pnpm test` 258 passed + 1 skipped（persona 34、mood 47、scope 8、全局装配层 7、inherit 配置 5、其余为既有用例）；`pnpm build` 产出 `lib/`。**未做**浏览器侧验证与真实 DSH 重启后的实机验证（本次会话无法重启宿主）。
