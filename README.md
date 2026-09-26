# dsh-workspace-memory

工作区记忆（Workspace Memory）——一个**独立于 deepseek-harness 源码树**的 DSH Bundle 插件。

给 agent 提供**按工作区**持久化的记忆，并自动兼容已有的 WorkBuddy 记忆体系：

| 工作区包含 | 生效后端 | 存储位置 | 行为 |
|---|---|---|---|
| `.workbuddy/memory/` | `workbuddy`（兼容） | `.workbuddy/memory/` | 以 WorkBuddy 原生形态读写，并执行它自己的写入准则 |
| 都没有 / 只有 `.dsh/memory/` | `dsh-default` | `.dsh/memory/` | DSH 默认规则，同样是「索引 + 日期流水」形态 |

**日期流水有两种真实布局**：平铺（`memory/YYYY-MM-DD.md`）与按计算机名分目录（`memory/<计算机名>/YYYY-MM-DD.md`）。本行不假定是哪种，而是按目录的实际形状探测：一旦目录里出现装着日期文件的计算机名子目录，新流水就写进本机 `hostname` 对应目录；检索覆盖全部机器的目录；读取某一天时依次取本机、记忆目录根，只在其他机器唯一命中时才采用它。

两者都提供六个工具：`memory_status` / `memory_read` / `memory_search` / `memory_write` / `memory_promote` / `memory_help`。

## 目录结构

```
package.json        # 包清单；dsh.bundle.patch 是「可被管理器安装的 Bundle」的入场券
cordis.patch.yml    # Bundle 载荷：把 workspace-memory 这一行插进 profile 的层栈
tsconfig.json       # 独立严格配置（对齐 harness 的 tsconfig.base.json 开关）
src/index.ts        # 插件实现（唯一源文件）
tests/              # vitest 单测（30 项）
docs/DESIGN.md      # 设计文档（来自 harness 仓库内的版本，文中相对链接指向 harness 仓库）
docs/DESIGN.zh.md   # 设计文档中文版
docs/legacy-preset/ # 历史留档：0.1.7 起被废弃的 $DSH_HOME/.agent-presets/memory/ 目录
```

## 构建

```powershell
pnpm install
pnpm build      # tsc -p tsconfig.json -> lib/index.js + lib/index.d.ts
pnpm test       # 30 passed
```

`lib/` 不入库（见 `.gitignore`），但**必须构建后才会被加载**——DSH 按 `main`/`exports` 加载。

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

改 `src/index.ts` → `pnpm build` → 重启 dsh。因为安装的是本地目录链接，不需要重装。

注意：Bundle 自己的 `cordis.patch.yml` **不在 HMR 监听范围内**（只监听 profile 的 `package.json`、profile 的 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`），所以改 patch 文件必须重启；改 `dsh.profile.bundles` 是热生效的。

## 升级注意

- dsh 升到 0.2.x 后，`peerDependencies` 里的 `^0.1.7-rc.2` 会失配，**整个 Bundle 会在启动时被静默跳过**（不会报错，只在日志里留一行）。届时把范围改到匹配的版本，或用 `dsh plugin --profile web allow-version` 授予精确版本豁免。
- `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 不是 dsh 包，不参与兼容门禁。
- DSH 的兼容门禁只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 这些 peer，范围写 `workspace:^` 会被当作「当前运行时」（但那套协议只在 harness 工作区内可用，本工程不能用）。

## 已知限制（当前版本）

- 仅工作区作用域，**没有全局/跨工作区记忆**（接口已预留，加 `global` 后端是纯增量的）。
- 写入是整文件读—改—写，**无锁**；同一工作区并发写可能丢一次写入。
- 工作区缓存冷启动会先渲染**一轮预热提示**（因为 prompt provider 契约要求同步返回）。
- 索引注入有 7000 字节上限（`indexPromptBytes`），超出部分需用 `memory_read` 读。
- 后端按目录**存在性**选择：中途创建 `.workbuddy/memory` 会切后端，已写入 `.dsh/memory` 的记忆**不会迁移**。
- 流水布局按**目录形状**探测：出现装着日期文件的计算机名子目录即切到「按本机目录读写」，子目录清空后回落平铺。计算机名取 `hostname` 输出；已有目录按「精确同名优先、其次忽略大小写」复用，因此同一台机器不同大小写的目录名不会被当成两台。
- 只能新增，**没有删除/过期**工具。
