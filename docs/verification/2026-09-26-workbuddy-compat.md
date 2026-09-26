---
description: "本轮对 WorkBuddy 记忆/规则/技能兼容层的三组实测证据与一个已修复缺陷的记录，供后续改动规则渲染或预算准入时比对。"
kind: "package-reference"
---

# WorkBuddy 兼容性验证记录（2026-09-26）

本页归档一次完整验证的**证据**，不是规格：行为契约在 [DESIGN.zh.md](../DESIGN.zh.md)，本页只回答「这些契约在真实项目上被观测成了什么样」。改动规则渲染层或预算准入后，用文末的复现命令重新对照本页。

## 范围与方法

三组独立证据，覆盖三种不同的失效方向：

| 组 | 问题 | 工作区 | 方式 |
|---|---|---|---|
| 一 · 正向 | 既有 WorkBuddy 体系的项目，三层是否真的抵达模型 | `D:/Work/GameCatStudio/Escort/program` | 真实 DSH 会话内逐轮取证 |
| 二 · 降级 | 预算不足时，已触发的条件册会不会消失 | 同上 | `pnpm verify:workbuddy`（装配层，不重启 DSH） |
| 三 · 反向 | 没有 `.workbuddy/` 的工作区会不会出现任何 WorkBuddy 行为 | `D:/Work/GitHub/dsh-workspace-conventions` | 真实 DSH 会话内逐轮取证 |

环境：DSH web profile、`cordis` preset、主机 `JN_NB_HW`；插件版本见各节标注。正向与反向取证**全程只读**，未修改被测工作区内任何文件。

参考项目的规则分布（下文换算都基于这组数字）：

| 册 | 类别 | 字节 |
|---|---|---|
| `01-协作红线.md` | 常驻 | 6099 |
| `02-设计与编码原则.md` | 常驻 | 6570 |
| `03-提交与版本控制.md` | 常驻 | 3152 |
| `04-工作方式.md` | 常驻 | 6187 |
| `10-服务端铁律.md` | 条件 `server/**/*.cs` | 4452 |
| `11-客户端铁律.md` | 条件 `client/Escort/assets/**/*.ts` | 8128 |
| `12-错误码约定.md` | 条件 `**/*ErrCode*.{cs,ts}` 等三个 glob | 2850 |

## 证据一 · 正向（插件 0.3.1，`rulesPromptBytes = 49152`）

规则 `rule_status`：`total: 7`，常驻 4（`01/02/03/04`）+ 条件 3（`10/11/12`），`issue` 全空，触发前 `triggered` 全 `false`。

分组形状与触发逐个成立：

| 观测点 | 结果 |
|---|---|
| 常驻册正文 | 四册正文与各自 `##` 节全在；未触发时三册条件册**只在清单里**，正文标题不出现 |
| `glob` 不触发 | `glob` 之后 `10-服务端铁律` 仍 `triggered: false` |
| pwsh `Get-Content` 读 `.cs` | 不触发；该册仍 `triggered: false` |
| `read` 同一 `.cs` | 触发：新增 `## 已触发的条件册` 与 `### 10-服务端铁律.md（触发：server/**/*.cs）`，六节正文全在，清单里该行消失 |
| `read` `.ts` | 触发 `11-客户端铁律`（首次运行因预算溢出未注入正文，见「缺陷记录」） |
| `read` `ErrCode.cs` | 触发 `12-错误码约定`，三节正文全在 |
| 工作区外路径 | 无任何变化 |
| 单册上限 | 三册体积 4452 / 8128 / 2850 均远低于 `ruleFileBytes = 16384`，不具截断条件 |

三册条件册全部触发后（复验轮，插件 0.3.1、预算 49152）：注入 **38,360 字节**，7 册全部**整册**注入，**无**任何「注入预算已满」说明。

技能：`list()` 返回 **8 个候选**，rank 全为 `250`，`resourceBase.kind = "directory"` 且指向各自 bundle：

```
cocos-bundle-dep-audit  cocos-config-bundle  cocos-mcp-prefab-edit  comment-slimming
escort-client-ui        escort-design-docs   manage-frontend-check  run-dev-services
```

`skill("escort-design-docs")` 的 `<skill_resources>` 原文：

```
Base directory for this skill: D:\Work\GameCatStudio\Escort\program\.workbuddy\skills\escort-design-docs
```

块内**无** provider 名、**无** rank 数字。

记忆：`mode/activeBackend = workbuddy`、`detectedExisting = true`、`memoryDir` 指向 `.workbuddy/memory`、`ledgerLayout = host`、本机目录 `JN_NB_HW`、`ledgers` 32 项、`indexBytes 10788`；`memory_search("用户偏好")` 命中 5 处，首条为 `MEMORY.md:36`。`memory_write` 写入密钥样式内容被硬拒：`ok: false`，理由「疑似密钥或凭据，记忆文件不得存放秘密」，写入前后逐项枚举一致。

## 证据二 · 降级（插件 0.3.2）

同一参考项目、三类条件册全部触发，只改预算。**每一档都满足：每册至少在段落中被点名一次，且总长不超预算。**

| 预算 | 常驻册 | `10-服务端铁律` | `11-客户端铁律` | `12-错误码约定` | 实测注入 |
|---|---|---|---|---|---|
| 49152 | 4 册整册 | 整册 | 整册 | 整册 | 38,360 B |
| **32768** | 4 册整册 | 整册 | **指针**（标题 + 触发 glob + `rule_read` 提示 + 截断片段） | 整册 | 32,768 B |
| 20000 | `01/02/03` 整册，`04` 仅被说明点名 | **指针** | **指针** | 整册 | 20,000 B |

20000 档同时验证了两件事：常驻册是整册制（放不下的 `04` 让位并被点名，而不是半注入），以及小册不会被大册碎片饿死（8128 B 的 `11` 降级，2850 B 的 `12` 仍整册）。

`32768` 是生产配置（见 profile 的 `id: workspace-conventions` 覆盖层），选择它的依据是上表：这是能保住最多册整册的最小值。

## 证据三 · 反向（插件 0.3.1/0.3.2，两者行为一致）

本仓库工作区没有 `.workbuddy/`，期望「三层全部静默」。11 项断言全部符合：

| 检查项 | 观测 |
|---|---|
| `# 工作区规则` 段落 | 完全不存在（`.workbuddy/rules/` 不存在 → 段落渲染空串，零 token） |
| 技能清单 | 23 项，全部来自 preset 的 `customSkillDirs`；无任何 `cocos-`/`escort-`/`comment-`/`manage-`/`run-` 前缀 |
| 跨工作区泄漏 | 「协作红线」「服务端铁律」「客户端铁律」「错误码约定」在上下文与工具输出中出现 **0** 次 |
| `rule_status` | `exists: false`、`total: 0`、`books: []`，`budgets.rulesPromptBytes = 32768`（**覆盖层在活进程中生效的证据**） |
| `rule_read` 兜底 | `ok: false`，`available: []`，不抛错 |
| `memory_status` | `mode: dsh-default`、`detectedExisting: false`、`ledgerLayout: flat` |
| 索引 / 流水 | `indexBytes 229` 含「开发约束」章节；`2026-09-26.md` `exists: true`、29 行 |
| 夹具隔离 | `memory_search("夹具流水条目")` → `totalHits: 0`，未扫进 `tests/fixtures/workbuddy/.workbuddy/` |
| 密钥准入 | 默认模式下同样硬拒 |
| 触碰不凭空发现规则 | `read` 读 `tests/fixtures/workbuddy/.workbuddy/rules/01-协作红线.md` 后无新增段落，复核 `rule_status` 与触碰前逐字节相同 |

最后一项是本组最有价值的一条：规则只从**工作区根目录**的 `.workbuddy/rules/` 发现，读某个路径不会让规则长出来。

## 缺陷记录：预算按估算准入导致已触发册静默消失

**现象。** 首次正向验证中，`read` 一个 `.ts` 之后 `11-客户端铁律` 的 `triggered` 变为 `true`，但它的标题与正文**双双消失**：它同时从「尚未触发清单」里被移除，因此只在一句「注入预算（32768 字节）已满，以下册本轮未注入正文…」里留下一个文件名。

**两个根因，都在预算层。**

1. **估算 vs 实测。** 原实现累加各块字节数并预留清单与说明的空间，但 `parts.join('\n')` 会为每个分块再加 1 字节连接符，章节横幅（`## 常驻册\n`）也不在其中。漏算使某册被判「放得下」，拼装后真的超限，末尾的 `clipBytes` 再硬裁剪——而硬裁剪总是砍在尾部，也就是砍在未触发清单与截断说明上。该册其实**被准入过，然后被裁掉了**。
2. **贪心饿死后来者。** 即使改成实测，先准入的册会把额度吃光，后面的册连标题都拿不到。

**修复（0.3.1）。** 准入改为对**实际拼装出的字符串**测量——`renderRulesSection` 内部先 `assemble()` 再比长度，不再有任何估算；准入分两轮，先按优先级逐个整册准入，再给放不下的已触发条件册发指针，且发指针时为后面的兄弟预留各自的指针空间；渲染末尾保留硬裁剪，仅作为「连表头都放不下」的极端兜底。0.3.2 追加一处措辞修正：页脚标题由 `## 条件册（…）` 改为 `## 尚未触发的条件册（…）`，与同级的 `## 已触发的条件册` 构成明确的一对。

**回归覆盖。** `tests/rules.spec.ts` 的 `a triggered book that does not fit is never dropped` 一组，其中一项遍历 700 / 1000 / 1500 / 3000 / 4096 / 9000 / 40000 七档预算，断言每一册都至少被点名一次且总长不超预算。

## 复现

```powershell
# 装配层直测：不重启 DSH，对着真实项目跑一遍三层
pnpm verify:workbuddy "D:\Work\GameCatStudio\Escort\program"          # 默认 49152
pnpm verify:workbuddy "D:\Work\GameCatStudio\Escort\program" 32768    # 生产配置
pnpm verify:workbuddy "D:\Work\GameCatStudio\Escort\program" 20000    # 压出降级形态

# 单测（含上述预算回归）
pnpm test
```

脚本报告每册的 `FULL` / `PTR` / `NAME` / `LOST` 与实测注入字节数，其中 `LOST` 表示该册在所有位置都没被点名——出现即失败。

## 未覆盖的边界

- **`.codebuddy/` 未纳入兼容** —— 被验证项目下的该目录只有一个空的 `skills/`，没有可依据的内容；将来它有实际技能或规则时需要单独设计。
- **技能无 watcher** —— 只有模型自己的 `write` / `edit` 会同步失效 provider。外部编辑器或 Git 新增/改名技能要等目录缓存过期，本轮未实测该延迟。
- **记忆并发写无锁** —— 同工作区两会话同瞬写入可能丢一次写，本轮未构造并发场景。
- **frontmatter 子集的实际覆盖** —— 本轮样本只用到扁平标量、块状列表与引号字符串；嵌套映射、多行标量与锚点未被真实样本验证，只由单测覆盖「跳过而非猜测」的行为。
- **全局记忆未实现** —— 接口已预留，无全局存储。
