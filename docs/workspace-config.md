# `.dsh/workspace.yml` —— 项目级工作区配置

DSH 的行配置（`cordis.patch.yml` 里的 `config:`）属于 **profile**：一个 profile 服务该进程里的每个工作区，所以它说不出"这个仓库里关掉记忆"。凡是由项目自己决定的事，就得随项目走。`.dsh/workspace.yml` 就是这份文件。

它属于 DSH 而不是 WorkBuddy：本插件是 DSH 专属插件，`.workbuddy/` 是它**读**的兼容面，不是它**拥有**的地方。

## 格式

```yaml
version: 1                     # 可选；本插件理解的版本是 1

layers:                        # 可选；便捷段，作用于每个插件段
  rules: false

workspace-conventions:         # 一个插件一段，键 = 该插件在组合里的行 id
  memory: read-only
  rules: true
  skills: false
  persona: true
  mood: true
  inherit:                     # 是否继承全局作用域（false = 屏蔽全局）
    persona: true
    memory: false
```

- 顶层是一个**块映射**：`version`、`layers`，以及若干个 **插件段**。
- **插件段以该插件在组合里携带的行 id 命名**。这样两个插件不可能撞名，各自的段也只由自己解释。本插件的行 id 是 `workspace-conventions`（见仓库根的 `cordis.patch.yml`）。
- 段是**可选**的：没有 `workspace-conventions` 段只表示"这个插件未被配置"，不是配错了。
- `layers` 是给"只想全局关掉某层、不想记插件名"的场景；插件段里的同名键**覆盖**它（嵌套的 `inherit` 同样按层覆盖）。

## 本插件的键

两条正交的轴：**这一层是否启用**，以及**是否继承全局作用域**。

| 键 | 取值 | 含义 |
|---|---|---|
| `memory` | `true` / `enabled` | 默认。注入索引段落，读写工具都可用 |
| | `read-only` | **不注入**记忆段落；写与提升被拒绝并说明原因；读工具照常 |
| | `false` / `disabled` | 整层关闭：段落不注入，全部记忆工具被拒绝（含全局作用域路径） |
| `rules` | `true`（默认）/ `false` | 段落、条件册触发、`rule_read` / `rule_status` 一起开关（工作区与全局两套） |
| `skills` | `true`（默认）/ `false` | `.workbuddy/skills` 是否发布进原生技能目录；关闭时该目录**不会**被扫描 |
| `persona` | `true`（默认）/ `false` | 人格片段是否注入；关闭时 `persona_read` / `persona_write` 被拒 |
| `mood` | `true`（默认）/ `false` | 情绪状态是否注入；关闭时 `mood_get` / `mood_set` 被拒 |
| `memoryLayout` | `auto`（默认） | 新流水沿用目录里已有的布局 |
| | `flat` | 新流水写在记忆目录下（`memory/YYYY-MM-DD.md`） |
| | `host` | 新流水写在按计算机名分的子目录里（`memory/<计算机名>/YYYY-MM-DD.md`） |
| `inherit` | 映射 | 四个键：`persona` / `mood` / `memory` / `rules`，默认全 `true`；`false` = 屏蔽该层的全局来源 |

`inherit` 的语义按层不同：人格与规则是**同名遮蔽**（工作区同名片段/册整体替换全局那份），情绪是**取最新一份**，记忆是**两段独立注入**（`inherit.memory: false` 时才消失）。屏蔽对工具同样生效：`memory_*` / `rule_read` 的 `scope="global"` 会被拒，`persona_write` / `mood_set` 的全局写入同样被拒——只掐注入不掐工具，等于让开关变成装饰。

`memory` 为什么只读时也不注入段落：该段落承载的就是索引正文本身。只读工作区仍可用读工具取到同样内容，每轮再注入一遍只是重复付费。

`memoryLayout` 只管**下一次写到哪里**：它不搬动、也不隐藏已经存在的流水，读取仍按目录实际形状进行。`auto` 保留原有行为——目录里已有按机器分放的流水或计算机名子目录，就继续那样写。

`memoryLayout` **只属于 memory**：persona / mood / rules 没有对应键。布局是「追加型、按日期分片」数据的分片策略，不是通用开关；人格/规则是可按名字 review 的低频整文件，情绪是覆盖写的短命状态，给它们分机器目录会换来身份/规则分裂或注入文本抖动。完整理由见 [DESIGN.zh.md](DESIGN.zh.md) 的「为什么只有 memory 有布局（persona / mood / rules 不做）」。

### 不属于这份文件的键（profile 行配置）

这份文件只回答**按项目变化**的问题：层是否启用、是否继承全局、新流水写到哪。另一些写入审批与情绪维护的开关属于 **profile 的行配置**——`cordis.patch.yml` 里 `workspace-conventions` 那一行的 `config:`，随进程生效，对该 profile 的所有工作区一致：

| 键 | 默认 | 含义 |
|---|---|---|
| `approveGlobalMemory` | `true` | `memory_write` / `memory_promote` 的 `scope="global"` 先请求一次性审批；`false` 关闭该门 |
| `approvePersonaWrite` | `true` | `persona_write`（工作区与全局两个作用域）先请求一次性审批；`false` 关闭该门 |
| `moodProactive` | `true` | 是否注入「情绪维护」段落（还要求本文件的 `mood` 为真） |

把这些键写进 `.dsh/workspace.yml` 会命中下面的「未知键」错误：**报错并停用所有层**。这是刻意的——行配置是部署策略，不该被单个项目悄悄覆盖；反过来，项目级开关（`layers.*`、`inherit.*`）只由这份文件解释，不出现在 profile 里。

于是按项目能控制的只有 `mood` / `inherit.mood`：要关掉情绪维护只能整体关情绪层；想保留情绪层、只关主动提醒，只能改 profile 的行配置（对该 profile 的所有工作区生效）。

## 文件会被自动创建

工作区没有这份文件时，本插件写入一份**每一行都是注释**的起手模板（`WORKSPACE_CONFIG_TEMPLATE`），因此创建它不改变任何行为；它存在的意义是能被发现和编辑。已存在的文件**永不覆盖**，重复触发也不重写。

- 创建发生在**实际会话**里（工具调用或预热时），要求 host 文件系统具备写能力，且 `DSH_SEED_WORKSPACE_CONFIG` 不为 `0`。
- 只读检出、被沙箱拒绝的目录：跳过创建并记一条 warn，绝不因此让一轮对话失败。
- `pnpm verify:workbuddy` 是**只读检查**，默认不创建；要验证写入路径本身时加 `--seed`。

## 两类错误，两种后果

1. **未知键 / 类型不对**（如 `memroy: false`、`rules: sometimes`，或把属于行配置的 `approveGlobalMemory` 写在这里）——报错**并停用全部层**。
   只报错却继续跑默认值，等于让那个开关静默失效，而这正是这份文件要防的事。
2. **文件存在但读不了 / 解析不了**——同样停用全部层。

停用后，拒绝信息里会带出**逐条问题原文**（含行号）。这是刻意的：那种状态下提示段落是空的，拒绝信息是唯一能说明原因的地方。

## 写入准则

- 缩进相对读取：每个块以**它自己第一行**的缩进为起点，所以 2 空格或 4 空格都能读，混用不同深度也可以。不支持制表符缩进。
- 支持注释、空行、块映射、块序列、引号/非引号标量。
- **刻意拒绝**：流式集合（`{a: 1}`、`[1, 2]`）、锚点/别名（`&`/`*`）、标签（`!!`）、块标量（`|`、`>`）、重复键。读到这些会按行号报错而不是猜——一个会静默曲解输入的读取器，恰好会让校验报告出假的通过。

## 缓存与重载

探测是异步的，结果按工作区缓存；消费它的提示段落是同步的（`systemPrompt.context()` 的 `text()` 不被 await）。缓存条目记录文件的**大小与修改时间**，每次工具调用前重新校验，因此：

- 配置文件是**后加的**（本插件的行已经加载过了）也会生效——"文件不存在"是一个独立的戳记，不会与"曾经不存在"混同。
- 戳记在**读文件之前**取。同步提示段落会在后台触发读取，先读后取戳会把新文件的戳记记到旧内容上，让那份陈旧快照看起来是当前的。

提示段落那一侧最多陈旧一轮，这是同步契约的必然代价。

## 给其他插件的复用方式

这份文件是一个**容器**，不是一个插件的私有配置：

- 顶层非插件段只有 `version` 与 `layers`；插件各自认领自己的段，互不干扰。
- 读取器 `src/patch.ts` 的 `parseMapDocument(text, source)` 导出的是通用块映射解析（同一套受限 YAML 子集、同样的按行号报错），任何插件都可直接用它读自己的段，无须再引 YAML 依赖。
- 本插件的 `readWorkspaceConfig()` 会把整份文档放在 `sections` 字段里返回，因此调用方既能拿到自己解析过的开关，也能拿到别人段的原文。

约定建议：插件段键取**行 id**（`cordis.patch.yml` 里那行的 `id`），而不是包名——行 id 是组合里定址该行的键，也是 loader 覆盖补丁使用的键。
