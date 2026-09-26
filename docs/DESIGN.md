---
description: "The composable workspace-conventions row: per-workspace durable memory that stays WorkBuddy-compatible for memory, rules and skills when that system already exists, for users and maintainers configuring or debugging agent workspace conventions."
kind: "package-reference"
---

# @jinngoo/dsh-workspace-memory

English | [中文](DESIGN.zh.md)

## Summary

`dsh-workspace-memory` gives an agent durable memory, behavioural rules and reusable skills inside the workspace it is working in. A preset mounts this row once and every session joining that scope reads and writes under **its own** working directory, so switching workspaces switches every convention with no configuration.

All three layers follow one principle: **when the workspace already contains a WorkBuddy system, work in that system's native shape and semantics; otherwise fall back to a DSH-default location and the same model.** The compatibility exists because DSH itself does not know `.workbuddy/`:

- DSH's only workspace-instruction channel is `@deepseek-ai/dsh-agent-instructions`, which loads `AGENTS.md` / `CLAUDE.md` (plus `AGENTS.local.md` / `CLAUDE.local.md` overlays) as **same-directory file-name candidates**. A candidate may not contain a path separator, so a directory-shaped rule set such as `.workbuddy/rules/` cannot be expressed through configuration at all, and DSH has no `alwaysApply` / `paths` / glob rule mechanism of the Cursor kind.
- DSH's skills come from `@deepseek-ai/dsh-skill-filesystem`, which scans `<projectRoot>/.dsh/skills`, `<projectRoot>/.agents/skills`, `customSkillDirs`, `<dshHome>/skills` and `<agentsHome>/skills`. `.workbuddy/skills/` is not among them.

| Layer | WorkBuddy source | DSH fallback | How it reaches the model |
|---|---|---|---|
| memory | `.workbuddy/memory/` | `.dsh/memory/` | prompt section + 6 tools |
| rules | `.workbuddy/rules/*.md` | — (no source, nothing injected) | prompt section + 2 tools |
| skills | `.workbuddy/skills/` | — (no source, no candidates) | a provider registered on `ctx.skills` |

The row publishes no service — it consumes `fs`, `agents`, `systemPrompt`, `sandboxPolicy`, `tools` and `skills` — so it mounts directly in a preset without an `isolate` realm.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row inside a preset composition to give that preset's sessions workspace memory, rules and skills. It needs an agent scope: every tool it registers resolves the calling session's working directory at call time, and the prompt sections are registered in the mounting context's scope.

### Configuration

```yaml
- id: workspace-memory
  name: '@jinngoo/dsh-workspace-memory'
  config:
    indexPromptBytes: 7000
    rulesPromptBytes: 49152
    ruleFileBytes: 16384
```

| Field | Default | Meaning |
|---|---|---|
| `indexPromptBytes` | `7000` | Byte cap on the index text injected into the prompt every turn. The remainder stays reachable through `memory_read`. |
| `rulesPromptBytes` | `49152` | Byte cap on the whole rules section: always books, triggered books, the listings and the closing notice. A guard rail against a pathological rules directory rather than an allocation — a workspace whose books fit pays only for what they cost. |
| `ruleFileBytes` | `16384` | Per-book byte cap, matching WorkBuddy's own ~16 KB contract. |

### The tools it contributes

| Tool | Purpose |
|---|---|
| `memory_status` | Report the active backend, resolved paths, index size and available dated ledgers. |
| `memory_read` | Read the curated index (`layer=index`) or one dated ledger (`layer=ledger`). |
| `memory_search` | Literal case-insensitive substring search across the index and every ledger. |
| `memory_write` | Append one durable entry to the dated ledger, after an admission check. |
| `memory_promote` | Add one line to the curated index under a named section, so it is injected every turn. |
| `memory_help` | Explain the criteria and the admission policy currently in force. |
| `rule_status` | Report the `.workbuddy/rules/` inventory: classification, trigger globs, and which conditional books have fired. |
| `rule_read` | Read one rule book in full, past the 16 KB injection cap. |

Skills get **no** bespoke tool: they enter the ordinary skill catalog and load through the stock `skill` tool.

### Selecting a backend

Memory selection is by directory presence, and WorkBuddy wins when both exist:

| Workspace contains | Active backend | Store root |
|---|---|---|
| `.workbuddy/memory/` | `workbuddy` (compatible) | `.workbuddy/memory/` |
| neither, or only `.dsh/memory/` | `dsh-default` | `.dsh/memory/` |

Rules and skills have a single source. No `.workbuddy/rules/` means no rules section; no `.workbuddy/skills/` means no skill candidates. Nothing is looked for elsewhere.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Three layers

Both memory backends share one model. The index is the only part always in context; the ledger is a record you can search; evidence stays in the documents and code that already own it.

| Layer | File | Lifetime | Contents |
|---|---|---|---|
| index | `MEMORY.md` | injected every turn | hard constraints, stable preferences, long-lived conventions, document pointers |
| ledger | `YYYY-MM-DD.md` | append-only, read on demand | durable facts that need a record but not permanent context |
| evidence | wherever it lives | — | documents and code; the index keeps pointers, not copies |

### Admission is a first-class step

The dominant failure mode of a memory system is not "too little stored" but "too much stored": an index that grows without bound poisons the context every turn. `evaluateEntry` therefore runs before every ledger write. Hard rejections — secrets, private key material, PII, empty or near-empty content — cannot be forced. Soft advisories, chiefly "this reads like a one-off play-by-play", refuse the write **once** and require an explicit `force`, which is the call site's opportunity to restate the line as a durable conclusion.

### Rules reproduce WorkBuddy's semantics

The `.workbuddy/rules/*.md` contract has exactly two frontmatter keys, and this row reproduces both:

| frontmatter | book | when it applies |
|---|---|---|
| `alwaysApply: true` | 常驻册 | injected on every turn |
| `alwaysApply: false` + `paths: [...]` | 条件册 | injected once a matching file is read or changed |
| neither | 按需规则 | listed only; the model reads it with `rule_read` |

Classification is a **derivation**, not configuration: `isAlwaysRule`, `isConditionalRule` and `isOnDemandRule` follow directly from the parse.

**Triggers come from touch tracking.** A `tools/result` listener takes the `file_path` of a successful `read` / `write` / `edit`, resolves it to a workspace-relative path, and matches it against each conditional book's globs. Changing a file through a shell does **not** trigger — parsing arbitrary shell syntax is not a reliable filesystem seam, the same boundary the shipped `dsh-agent-instructions` package draws and states in its own Known Limitations.

**Trigger state is accounted per workspace**, not per session, for two reasons: a rule book describes the workspace, so once something under it has been touched the book is relevant to the work in progress; and it removes any dependence on agent-object identity between the tool-result listener and the synchronous prompt provider. The cost is that concurrent sessions in one workspace share trigger state — over-injecting a book, which is far safer than never injecting it.

**Budgets are two-tier and observable.** A book past `ruleFileBytes` is truncated with an in-place note naming the tool that reads the rest.

The whole-section budget is enforced by **measuring the really assembled string** (`renderRulesSection` calls `assemble()` and compares lengths), never by estimate — the section also carries section banners (`## 常驻册\n`, `## 已触发的条件册\n`) and `join('\n')` separators, and an estimate that forgot either would admit a book only to have the closing hard clip eat it. That clip always cuts the tail, which is exactly where the listings and the notice live.

Admission runs in two passes: whole books in priority order (always books first), then a pointer for each triggered book that did not fit. **常驻册 are all-or-nothing** — they are the section's constant part, few in number, and a half-injected standing rule is worse than a named omission. **A triggered 条件册 never disappears** — the model just touched a matching file, so this book is the most relevant content at that moment; if it does not fit whole it degrades to its heading, its trigger glob, a `rule_read` pointer and as much of the body as still fits, and a book that cannot even hold a pointer is named in the closing notice. Each pointer also reserves room for its later siblings, so a large book's fragment never starves a small book out. A final hard clip remains as the backstop for a pathologically small budget that cannot hold even the header.

Triggering is **monotonic** — a fired book is never un-fired — so the triggered set only grows within a session and a degraded book normally stays degraded rather than recovering.

**An unreadable frontmatter value is reported, never silently downgraded.** When `alwaysApply` holds something unrecognised the book is not treated as always-apply (a red-line book is never quietly relaxed) and does not disappear either: it stays in the listing as an on-demand book with a `frontmatter 存在无法识别的取值` note.

### Skills go through the native skill registry

Directory bundles (`<name>/SKILL.md`) and flat files (`<name>.md`) under `.workbuddy/skills/` are published by a provider registered on `ctx.skills`, so they appear in the **ordinary skill catalog**, load through the stock `skill` tool, and get their relative resources resolved by the registry through `resourceBase`. No parallel loading path is invented.

- **Rank 250** sits below `project-dsh` (100) and `project-agents` (200) and above `custom` (300), so a skill genuinely authored for DSH wins a name collision against the WorkBuddy copy.
- **The provider is `cwd`-sensitive**: `list()` derives its root from the lookup context's `cwd`, so one registered instance serves every workspace with no cross-talk.
- **Invocation flags use the strict boolean grammar**: `disable-model-invocation` / `user-invocable` accept `true/false`, `yes/no`, `on/off`, `1/0`, case-insensitively. A rejected spelling **drops the whole bundle** with a warn log rather than quietly permitting a surface the author tried to close — the same behaviour as DSH's shipped local provider.
- **Invalidation is touch-driven, with no watcher**: the model's own `write` / `edit` under `.workbuddy/skills/` calls the provider's `invalidate()` synchronously. Changes made by external tools wait for the next catalog snapshot; this row starts no file watcher.

### Three deliberate smallness choices

**Frontmatter reads one subset.** Both compatibility layers read frontmatter another tool wrote, so only the subset that tool actually emits is implemented: flat `key: scalar` pairs, block lists and inline lists. Nested maps, anchors, tags and multi-line scalars are not interpreted — a nested structure's indented children are **skipped** rather than guessed at. Silently misreading somebody else's rule is worse than ignoring a key this reader does not model.

**Glob implements only the dialect in use.** `**`, `*`, `?` and `{a,b}` alternation are the whole dialect the supported rule books are written in. Matching is case-insensitive because the platforms these rules target (Windows, macOS) resolve paths case-insensitively.

**Section-level detection.** `MEMORY.md` files are not uniform. WorkBuddy's native layout is a lone level-1 document title followed by level-2 sections (`## 一、…`), while a document with no title starts straight at its shallowest heading. `detectSectionLevel` treats a heading level that occurs exactly once and is shallower than everything else as the document title, so `memory_promote` inserts into the intended section instead of creating a phantom one.

### Ledger layout

WorkBuddy keeps dated ledgers in either of two real layouts: flat under the memory directory (`memory/YYYY-MM-DD.md`), or one subdirectory per computer (`memory/<computer>/YYYY-MM-DD.md`). Nothing declares which one a store uses, so `scanLedgers` reads the store's own shape — a dated file inside a subdirectory marks the store as per-computer, and so does a subdirectory already named for this machine (an exact name wins over a case-insensitive one) even before it holds a ledger. `ledgerWritePath` then sends a new ledger into this machine's directory, or into the store root when the store is flat, and `ledgerForDate` orders reads: this machine, the store root, and only then another computer's file when it is the single ledger for that date — so a day recorded on two machines never resolves to the wrong one. Search is layout-agnostic: the index plus every machine's ledgers.

### Two load-bearing constraints

**The prompt providers are synchronous.** `systemPrompt.context()` registers a provider whose text is computed during assembly, and `assemble()` calls it without awaiting. An `async` provider returns a Promise rather than a string, which fails every turn. The row therefore probes each workspace asynchronously into a cache, and the providers render that cache synchronously. The first turn for a workspace reports a one-turn warm-up notice; `agent/created` prewarms so a normal session sees content immediately.

**Writes carry the session's sandbox policy.** `fs.writeText` is called with `sandboxPolicy.resolve({ session })`. Without a session the sandbox falls back to the deployment's default workspace root rather than the session's own cwd, and refuses writes inside that very workspace.

<a id="further-exploration"></a>
## Further Exploration

- [Archived verification evidence](verification/) — three real-project evidence sets (forward, degraded, reverse) plus the root-cause record of one fixed defect. Re-check against it after changing rule rendering or budget admission.

These documents all live in the DSH source tree at `D:\Work\GitHub\deepseek-harness`:

- `packages/context/agent-instructions/README.md` — DSH's workspace-instruction loader and the list of semantics it **deliberately does not interpret** (directory-shaped rules, lowercase candidates, `@path` imports).
- `packages/skill/skill/README.md` and `packages/skill/skill-filesystem/README.md` — the registry contract, the provider interface and the local discovery priority table.
- `docs/subsystems/skills.md` — the layered registry, rank tie-breaking, and the `skills/change` invalidation event.
- `docs/subsystems/system-prompt.md` — how a runtime-context provider is registered and assembled.
- `packages/preset/agent-preset/README.md` — how a preset mounts this row and how a session joins its scope.

-----

<a id="model-experience"></a>
## Model Experience

### The workspace-rules context section (order 55)

#### What the model sees

It appears only when the workspace has a `.workbuddy/rules/` directory; otherwise the section is the empty string and costs **no tokens at all**. When present it carries the resolved rules directory, two sentences of semantics, the full body of every always book, then the bodies of the triggered conditional books with the glob that fired each one, and finally the listings of not-yet-triggered and on-demand books plus any frontmatter diagnostics.

#### Token effect

Adds a fixed per-turn cost of the explanatory block, every always book, the triggered books and the listings, capped at `rulesPromptBytes`. On the reference project (four always books, three conditional ones) it measures **22,832 bytes** with no conditional book fired and **38,360 bytes** once all three have — both inside the 48 KB default, with all seven books injected whole. That is the largest unconditional cost this row imposes.

#### KV Cache effect

Prefix-stable while the always books and the explanatory block are unchanged. A conditional book firing **changes the section** and therefore invalidates the cached prefix from that section onward — the direct price of reproducing WorkBuddy's on-demand injection. A workspace with no rules directory keeps the section permanently empty and participates in no invalidation.

### The workspace-memory context section (order 60)

#### What the model sees

One runtime-context entry named `workspace-memory` at order `60`, holding the resolved workspace path, the active backend and mode, the memory directory and index paths, the last three ledger dates, the writing criteria in force, and the index text up to `indexPromptBytes`. On a workspace's first turn the section carries only a warm-up notice.

#### Token effect

Adds a fixed per-turn cost of the criteria block plus up to `indexPromptBytes` bytes of index text, on every request, for every session in the mounting scope. The ledger and the tool schemas are the remainder.

#### KV Cache effect

Prefix-stable while the index text, the criteria and the tool schemas are unchanged. A `memory_promote` write rewrites the index and therefore invalidates the cached prefix from this section onward; ledger writes do not change the text and leave the prefix stable.

### The memory and rules tools

#### What the model sees

Eight tool schemas, present on every request whether or not they are used. `memory_write` documents the admission criteria in its description, and `rule_status` / `rule_read` state the trigger boundary plus the fallback for new files, so the criteria are stated twice: once as prose in the context sections and once at the point of use.

#### Token effect

The eight schemas cost a fixed per-request amount. Results are returned as JSON text: `memory_read` of a large ledger is tail-limited to 200 lines by default, `memory_search` caps its hits, and `rule_read` returns a whole book untruncated.

#### KV Cache effect

Schemas are stable while the row is mounted. Tool-call history and results accumulate as ordinary conversation tokens.

### The skill catalog

#### What the model sees

Each valid bundle or flat file under `.workbuddy/skills/` contributes one catalog entry: name and description, with optional `whenToUse`. **The provider name, rank and absolute path never reach the model**, matching DSH's shipped local provider. Once a skill is selected, the `skill` tool returns a `<skill_content>` block whose `<skill_resources>` carries `Base directory for this skill: <bundle directory>`, so relative resources (`scripts/`, `references/`) resolve.

#### Token effect

Catalog entries count toward the session skill catalog, sorted by name; bodies enter history only when loaded. Changes below a bundle's resource subtree do not change the catalog.

#### KV Cache effect

The catalog digest is stable while the set of names and descriptions is unchanged. A provider invalidation — the model writing into the skills directory itself — may append a replacement catalog.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the row is a poor fit. They are current package constraints, not a task backlog.

- **Workspace scope only** — there is no global or cross-workspace memory. The backend resolution returns a list of `(scope, backend)` entries and the orchestration is written against that list, which is the reserved seam: adding a `global` backend is additive, but no global store ships today.
- **Best-effort concurrency** — ledger appends and index insertions are read-modify-write over whole files. Two sessions writing the same workspace at the same instant can lose one write. There is no lock, and the row does not claim atomic append.
- **One-turn warm-up** — the prompt providers cannot await, so a workspace whose cache is cold renders a warm-up notice for one turn before real content appears. The rules section is quieter: a cold cache renders the empty string rather than a notice.
- **Index injection is a hard byte cap** — a very large `MEMORY.md` is truncated in the prompt, and the model must call `memory_read` to see the rest. Nothing summarises it automatically.
- **Presence-based backend selection** — the active memory backend is chosen by whether `.workbuddy/memory` exists. Creating that directory mid-session switches the backend on the next probe, and memory already written to `.dsh/memory` is not migrated.
- **Probed ledger layout** — the layout is likewise read from the store's current shape: a computer-name subdirectory holding dated files switches writes to this machine's own directory, and emptying that subdirectory falls back to flat. The computer name comes from `hostname`, and an existing directory is reused case-insensitively.
- **No deletion or pruning** — entries can be added but not removed or expired through a tool. Ledgers grow by date and are only ever appended.
- **Rules only see DSH's structured filesystem tools** — touch tracking hangs off the `file_path` of `read` / `write` / `edit`. Changing a file through a shell (`cat`, `sed`, a build script) does not trigger a conditional book; this is the same boundary DSH's own instruction loader draws. `rule_read` is the fallback, and the equivalent convention from the reference project ("read a sibling before creating a new file") applies here too.
- **Rule trigger state is in-process and not persisted** — the fired set is held in memory per workspace, cleared on restart, and a rules file edited mid-session is not reloaded, matching WorkBuddy's own "rules are read once at startup" contract.
- **Rule degradation compounds, and a truncated body is not the whole book** — triggering is monotonic, so within one session the fired set only grows and degradation normally gets worse rather than recovering; a degraded block's body is cut short, so `rule_read` remains the authority. To avoid degradation entirely, size `rulesPromptBytes` for "every always book plus every conditional book" (the reference project needs ~38.4 KB; the 48 KB default covers it).
- **Skills have no watcher** — only the model's own `write` / `edit` invalidates the provider synchronously. A skill added or renamed by an external editor, Git or a shell waits for the catalog cache to expire; this row starts no Chokidar.
- **Skills are discovered one level deep** — `<name>/SKILL.md` and `<name>.md`; nested skill trees and package manifests are ignored. A bundle's `references/` and `scripts/` are readable as resources but are not discovered as skills.
- **Frontmatter is a subset** — nested maps, multi-line scalars, anchors and YAML tags are not interpreted. When rules or skills start using them, this reader has to grow with them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The pinned `@jinngoo/dsh-workspace-memory` is published as a dependency of the preset that mounts it. It consumes host-plane services only and must not be wrapped in an `isolate` realm, because none of the capabilities it needs — the filesystem, the agent registry, the prompt registry, the sandbox policy — belongs to a single session.

The `inject` list names all six services, so a composition missing any of them fails loud at mount rather than silently contributing nothing. `skills` is a hard dependency rather than an optional one deliberately: the skill registry stays on the host plane in DSH's web profile (only each preset's own `skill-filesystem` row is disabled there), a composition without it could not use skills at all, and a silent downgrade would only hide a configuration mistake.

Source map:

| File | Role |
|---|---|
| `src/index.ts` | Wiring: config schema, six memory tools, two rules tools, two prompt sections, skill-provider registration, touch tracking |
| `src/memory.ts` | The memory model (pure logic): admission, entry rendering, index editing, ledger inventory |
| `src/rules.ts` | Rule-book parsing, classification, glob trigger matching, section rendering and budgeting |
| `src/skills.ts` | Skill-bundle parsing and the `ctx.skills` provider factory |
| `src/frontmatter.ts` | The deliberately narrow YAML frontmatter reader |
| `src/glob.ts` | `**` / `*` / `?` / `{a,b}` glob-to-regexp compilation |
| `src/text.ts` | Text normalization, path display, byte clipping |
| `src/layout.ts` | Directory-name constants shared by the three layers |

</details>
