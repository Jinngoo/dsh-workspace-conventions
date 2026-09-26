# dsh-workspace-memory

工作区约定（Workspace Conventions）——一个**独立于 deepseek-harness 源码树**的 DSH Bundle 插件。

给 agent 提供**按工作区**持久化的记忆、规则与技能，并自动兼容已有的 WorkBuddy 体系：

| 层 | WorkBuddy 源 | DSH 回退 | 抵达模型的方式 |
|---|---|---|---|
| 记忆 | `.workbuddy/memory/` | `.dsh/memory/` | prompt 段落 + 6 个工具 |
| 规则 | `.workbuddy/rules/*.md` | —（无源即不注入） | prompt 段落 + 2 个工具 |
| 技能 | `.workbuddy/skills/` | —（无源即无候选） | 注册进 `ctx.skills` 的原生 provider |

## 为什么需要它

DSH 自身不认识 `.workbuddy/`：

- **DSH 没有 rules 机制。** 它唯一的工作区指令通道是 `@deepseek-ai/dsh-agent-instructions`，只按**同目录文件名候选**加载 `AGENTS.md` / `CLAUDE.md`（外加 `AGENTS.local.md` / `CLAUDE.local.md`）。候选名不得含路径分隔符，所以目录式规则（`.workbuddy/rules/`、`.claude/rules/`）**无法用配置表达**；`alwaysApply` / `paths` / glob 这类语义 DSH 一概不解释。
- **DSH 的技能根是固定的。** `@deepseek-ai/dsh-skill-filesystem` 只扫描 `<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills`、`customSkillDirs`、`<dshHome>/skills`、`<agentsHome>/skills`，`.workbuddy/skills/` 不在其中。

于是把带 `.workbuddy/` 的既有项目当工作区打开时，只有 `AGENTS.md` 会被加载，规则与技能完全不可见。本插件就是这中间的兼容层。

## 记忆

| 工作区包含 | 生效后端 | 存储位置 | 行为 |
|---|---|---|---|
| `.workbuddy/memory/` | `workbuddy`（兼容） | `.workbuddy/memory/` | 以 WorkBuddy 原生形态读写，并执行它自己的写入准则 |
| 都没有 / 只有 `.dsh/memory/` | `dsh-default` | `.dsh/memory/` | DSH 默认规则，同样是「索引 + 日期流水」形态 |

**日期流水有两种真实布局**：平铺（`memory/YYYY-MM-DD.md`）与按计算机名分目录（`memory/<计算机名>/YYYY-MM-DD.md`）。本行不假定是哪种，而是按目录的实际形状探测：一旦目录里出现装着日期文件的计算机名子目录，新流水就写进本机 `hostname` 对应目录；检索覆盖全部机器的目录；读取某一天时依次取本机、记忆目录根，只在其他机器唯一命中时才采用它。

## 规则

复刻 `.workbuddy/rules/*.md` 的原生语义：

| frontmatter | 册 | 生效时机 |
|---|---|---|
| `alwaysApply: true` | 常驻册 | 每轮注入 |
| `alwaysApply: false` + `paths: [...]` | 条件册 | 读或改到匹配文件后注入 |
| 两者都没有 | 按需规则 | 只列入清单，模型需要时用 `rule_read` 读 |

- 单册超过 16 KB（`ruleFileBytes`）就截断，并写明「完整内容用 `rule_read` 读」。
- 整段超过 `rulesPromptBytes`（默认 48 KB）时**常驻册优先**，而**已触发的条件册永不出局**：整册放不下就降级为「标题 + 触发路径 + `rule_read` 指针 + 尽量多的截断正文」，连指针都放不下的册会在段落末尾的说明里被点名。
- 准入按**实际拼装出的字符串长度**测量（含章节标题与连接符），不是估算；并且先逐个整册准入、再给剩下的发指针，每个指针都为后面的兄弟预留空间。所以既不会出现「被准入又被硬裁掉」，也不会为了塞一册大册的碎片而饿死一册小册——实测同一项目在 20 KB 预算下，8128 字节的客户端铁律降级为指针，2850 字节的错误码约定仍整册注入。
- 触发靠 `tools/result` 追踪 `read` / `write` / `edit` 的 `file_path`。**用 shell 改文件不触发**（DSH 自带的指令加载器划的是同一条边界）；兜底是 `rule_read`，新建文件前先读同类文件同样适用。
- frontmatter 取值读不动时**报出来，不悄悄降级**：那册不会被当成常驻册，也不会消失，而是以按需规则身份留在清单里并附一行提示。

## 技能

`.workbuddy/skills/` 下的目录包（`<name>/SKILL.md`）与平铺文件（`<name>.md`）由注册到 `ctx.skills` 的 provider 发布，进入**原生 skill 目录**，由标准 `skill` 工具加载，相对资源（`scripts/`、`references/`）按 `resourceBase` 解析。

- rank 取 **250**：低于 `project-dsh`（100）与 `project-agents`（200），高于 `custom`（300）——真正为 DSH 编写的项目技能在重名时压过 WorkBuddy 副本。
- `disable-model-invocation` / `user-invocable` 走严格布尔语法；拼错的值**整册丢弃**并记 warn，而不是静默放行。
- 只有模型自己的 `write` / `edit` 会同步失效 provider；**没有 watcher**。

## 目录结构

```
package.json          # 包清单；dsh.bundle.patch 是「可被管理器安装的 Bundle」的入场券
cordis.patch.yml      # Bundle 载荷：把 workspace-memory 这一行插进 profile 的层栈
tsconfig.json         # 独立严格配置（对齐 harness 的 tsconfig.base.json 开关）
src/index.ts          # 装配层：配置、8 个工具、2 个 prompt 段落、技能 provider、触碰追踪
src/memory.ts         # 记忆模型（纯逻辑）：准入、条目渲染、索引编辑、流水盘点
src/rules.ts          # 规则册解析、分类、触发判定、段落渲染与预算
src/skills.ts         # 技能包解析与 ctx.skills provider 工厂
src/frontmatter.ts    # 刻意收窄的 YAML frontmatter 读取器
src/glob.ts           # ** / * / ? / {a,b} 的 glob→正则编译
src/text.ts           # 文本归一化、路径显示、字节裁剪
src/layout.ts         # 三层共用的目录名常量
scripts/verify-workbuddy.mjs  # 对着一个真实 WorkBuddy 项目跑一遍装配层，不重启 DSH 也能验证
tests/                # vitest 单测（95 项，含对真实 apply() 装配的端到端用例）
docs/DESIGN.md        # 设计文档（英文）
docs/DESIGN.zh.md     # 设计文档中文版
docs/verification/    # 实测证据归档（正向 / 降级 / 反向三组，含一个已修复缺陷的记录）
docs/legacy-preset/   # 历史留档：0.1.7 起被废弃的 $DSH_HOME/.agent-presets/memory/ 目录
```

## 构建与测试

```powershell
pnpm install
pnpm build      # tsc -p tsconfig.json -> lib/*.js + lib/*.d.ts
pnpm test       # 95 passed
pnpm typecheck  # tsc --noEmit
```

`lib/` 不入库（见 `.gitignore`），但**必须构建后才会被加载**——DSH 按 `main`/`exports` 加载。

## 对着真实项目验证

无需重启 DSH，直接拿一个已有 `.workbuddy/` 的项目跑一遍装配层。第二个参数是 `rulesPromptBytes`，用来压出预算降级形态：

```powershell
pnpm verify:workbuddy "D:\Work\GameCatStudio\Escort\program"          # 默认 49152
pnpm verify:workbuddy "D:\Work\GameCatStudio\Escort\program" 32768    # 生产配置
pnpm verify:workbuddy "D:\Work\GameCatStudio\Escort\program" 20000    # 压出降级形态
```

它会报告该工作区各层的实际贡献（记忆后端、每册规则的分类与注入字节数、全部技能候选），逐个触碰每册条件册的触发 glob，并把每册判为 `FULL` / `PTR` / `NAME` / `LOST`——`LOST` 表示该册在所有位置都没被点名，出现即失败；同时报告实测注入字节数是否超预算。

改动规则渲染层或预算准入后，请用同一命令与 [docs/verification/](docs/verification/) 里归档的形态对照。

## 安装（作为 Bundle 装进某个 profile）

本地开发用绝对路径安装：

```powershell
# 1) 装进 profile（CLI 转发给 pnpm，cwd = profile 目录）
dsh plugin --profile web add <本仓库所在目录的绝对路径>

# 2) 把包名加进 profile 的 bundle 列表（这一步决定它是否真的被当作层加载）
#    文件：%USERPROFILE%\.dsh\profiles\web\package.json
#      "dsh": { "profile": { "bundles": [ "...", "@jinngoo/dsh-workspace-memory" ] } }
#    或用 Web GUI：设置 → 插件 → 安装 Bundle（会同时完成 1 和 2）

# 3) 校验组合结果里出现了这一行
dsh --profile web --dump-config | Select-String workspace-memory

# 4) 重启 dsh（ESM 模块在进程内缓存）
```

发布到 registry 后就可以只写包名：`dsh plugin --profile web add @jinngoo/dsh-workspace-memory`。

## 开发循环

改 `src/*.ts` → `pnpm build` → 重启 dsh。因为安装的是本地目录链接，不需要重装。

注意：Bundle 自己的 `cordis.patch.yml` **不在 HMR 监听范围内**（只监听 profile 的 `package.json`、profile 的 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`），所以改 patch 文件必须重启；改 `dsh.profile.bundles` 是热生效的。

## 升级注意

- dsh 升到 0.2.x 后，`peerDependencies` 里的 `^0.1.7-rc.2` 会失配，**整个 Bundle 会在启动时被静默跳过**（不会报错，只在日志里留一行）。届时把范围改到匹配的版本，或用 `dsh plugin --profile web allow-version` 授予精确版本豁免。
- `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 不是 dsh 包，不参与兼容门禁。
- DSH 的兼容门禁只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 这些 peer，范围写 `workspace:^` 会被当作「当前运行时」（但那套协议只在 harness 工作区内可用，本工程不能用）。
- `skills` 是**硬依赖**：DSH 的 web profile 里 skill 注册表恒在 host 平面（被禁用的只有各 preset 自己挂载的 `skill-filesystem` 行），缺注册表的组合本来就用不了技能。本行选择在挂载时直接报错，而不是静默降级。

## 已知限制（当前版本）

- 仅工作区作用域，**没有全局/跨工作区记忆**（接口已预留，加 `global` 后端是纯增量的）。
- 写入是整文件读—改—写，**无锁**；同一工作区并发写可能丢一次写入。
- 工作区缓存冷启动会先渲染**一轮预热提示**（因为 prompt provider 契约要求同步返回）；规则段落在冷却时渲染空串而非提示。
- 索引注入有 7000 字节上限（`indexPromptBytes`），超出部分需用 `memory_read` 读。
- 后端按目录**存在性**选择：中途创建 `.workbuddy/memory` 会切后端，已写入 `.dsh/memory` 的记忆**不会迁移**。
- 流水布局按**目录形状**探测：出现装着日期文件的计算机名子目录即切到「按本机目录读写」，子目录清空后回落平铺。计算机名取 `hostname` 输出；已有目录按「精确同名优先、其次忽略大小写」复用，因此同一台机器不同大小写的目录名不会被当成两台。
- 只能新增，**没有删除/过期**工具。
- 规则**只认 DSH 的结构化文件工具**（`read` / `write` / `edit` 的 `file_path`）；shell 改文件不触发条件册。
- 规则触发状态**在进程内累积、不落盘**；会话中途改 rules 文件不重载。
- 技能**没有 watcher**，且只认**一层深度**（`<name>/SKILL.md`、`<name>.md`）。
- frontmatter 只读一个子集：扁平 `key: scalar`、块状列表、行内列表；嵌套映射、多行标量、锚点不解释。

设计细节与逐层取舍见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md)（[English](docs/DESIGN.md)）。
