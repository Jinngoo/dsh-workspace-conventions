---
description: "The composable workspace-memory row: per-workspace durable memory that stays WorkBuddy-compatible when that system already exists, for users and maintainers configuring or debugging agent memory."
kind: "package-reference"
---

# @jinngoo/dsh-workspace-memory

English | [中文](README.zh.md)

## Summary

`dsh-workspace-memory` gives an agent durable memory inside the workspace it is working in. A preset mounts this row once and every session joining that scope reads and writes memory under **its own** working directory, so switching workspaces switches memory with no configuration. Two backends are supported and the selection is automatic: when the workspace already contains a WorkBuddy memory system (`.workbuddy/memory`), the row reads and writes that system in its native shape and enforces its own writing criteria; otherwise it uses the DSH default (`.dsh/memory`), which shares the same index-plus-dated-ledger shape so a model behaves identically in either mode. The row publishes no service — it consumes `fs`, `agents`, `systemPrompt` and `sandboxPolicy` — so it mounts directly in a preset without an `isolate` realm.

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

Mount the row inside a preset composition to give that preset's sessions workspace memory. It needs an agent scope: every tool it registers resolves the calling session's working directory at call time, and the prompt section is registered in the mounting context's scope.

### Configuration

```yaml
- id: workspace-memory
  name: '@jinngoo/dsh-workspace-memory'
  config:
    indexPromptBytes: 7000
```

| Field | Default | Meaning |
|---|---|---|
| `indexPromptBytes` | `7000` | Byte cap on the index text injected into the prompt every turn. The remainder stays reachable through `memory_read`. |

### The tools it contributes

| Tool | Purpose |
|---|---|
| `memory_status` | Report the active backend, resolved paths, index size and available dated ledgers. |
| `memory_read` | Read the curated index (`layer=index`) or one dated ledger (`layer=ledger`). |
| `memory_search` | Literal case-insensitive substring search across the index and every ledger. |
| `memory_write` | Append one durable entry to the dated ledger, after an admission check. |
| `memory_promote` | Add one line to the curated index under a named section, so it is injected every turn. |
| `memory_help` | Explain the criteria and the admission policy currently in force. |

### Selecting a backend

Selection is by directory presence, and WorkBuddy wins when both exist:

| Workspace contains | Active backend | Store root |
|---|---|---|
| `.workbuddy/memory/` | `workbuddy` (compatible) | `.workbuddy/memory/` |
| neither, or only `.dsh/memory/` | `dsh-default` | `.dsh/memory/` |

<a id="understand-the-implementation"></a>
## Understand the implementation

### Three layers

Both backends share one model. The index is the only part always in context; the ledger is a record you can search; evidence stays in the documents and code that already own it.

| Layer | File | Lifetime | Contents |
|---|---|---|---|
| index | `MEMORY.md` | injected every turn | hard constraints, stable preferences, long-lived conventions, document pointers |
| ledger | `YYYY-MM-DD.md` | append-only, read on demand | durable facts that need a record but not permanent context |
| evidence | wherever it lives | — | documents and code; the index keeps pointers, not copies |

### Admission is a first-class step

The dominant failure mode of a memory system is not "too little stored" but "too much stored": an index that grows without bound poisons the context every turn. `evaluateEntry` therefore runs before every ledger write. Hard rejections — secrets, private key material, PII, empty or near-empty content — cannot be forced. Soft advisories, chiefly "this reads like a one-off play-by-play", refuse the write **once** and require an explicit `force`, which is the call site's opportunity to restate the line as a durable conclusion.

### Two load-bearing constraints

**The prompt provider is synchronous.** `systemPrompt.context()` registers a provider whose text is computed during assembly, and `assemble()` calls it without awaiting. An `async` provider returns a Promise rather than a string, which fails every turn. The row therefore probes each workspace asynchronously into a cache, and the provider renders that cache synchronously. The first turn for a workspace reports a one-turn warm-up notice; `agent/created` prewarms so a normal session sees content immediately.

**Writes carry the session's sandbox policy.** `fs.writeText` is called with `sandboxPolicy.resolve({ session })`. Without a session the sandbox falls back to the deployment's default workspace root rather than the session's own cwd, and refuses writes inside that very workspace.

### Detecting the section level

`MEMORY.md` files are not uniform. WorkBuddy's native layout is a lone level-1 document title followed by level-2 sections (`## 一、…`), while a document with no title starts straight at its shallowest heading. `detectSectionLevel` treats a heading level that occurs exactly once and is shallower than everything else as the document title, so `memory_promote` inserts into the intended section instead of creating a phantom one.

### Ledger layout

WorkBuddy keeps dated ledgers in either of two real layouts: flat under the memory directory (`memory/YYYY-MM-DD.md`), or one subdirectory per computer (`memory/<computer>/YYYY-MM-DD.md`). Nothing declares which one a store uses, so `scanLedgers` reads the store's own shape — a dated file inside a subdirectory marks the store as per-computer, and so does a subdirectory already named for this machine (an exact name wins over a case-insensitive one) even before it holds a ledger. `ledgerWritePath` then sends a new ledger into this machine's directory, or into the store root when the store is flat, and `ledgerForDate` orders reads: this machine, the store root, and only then another computer's file when it is the single ledger for that date — so a day recorded on two machines never resolves to the wrong one. Search is layout-agnostic: the index plus every machine's ledgers.

<a id="further-exploration"></a>
## Further Exploration

- [System prompt subsystem](../../../docs/subsystems/system-prompt.md) — how a runtime-context provider is registered and assembled.
- [Agent presets subsystem](../../../packages/preset/agent-preset/README.md) — how a preset mounts this row and how a session joins its scope.
- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — `FsTarget` resolution and the sandbox policy seam.

-----

<a id="model-experience"></a>
## Model Experience

### The workspace-memory context section

#### What the model sees

One runtime-context entry named `workspace-memory` at order `60`, holding the resolved workspace path, the active backend and mode, the memory directory and index paths, the last three ledger dates, the writing criteria in force, and the index text up to `indexPromptBytes`. On a workspace's first turn the section carries only a warm-up notice.

#### Token effect

Adds a fixed per-turn cost of the criteria block plus up to `indexPromptBytes` bytes of index text, on every request, for every session in the mounting scope. It is the only unconditional cost this row imposes; the ledger and the tool schemas are the remainder.

#### KV Cache effect

Prefix-stable while the index text, the criteria and the tool schemas are unchanged. A `memory_promote` write rewrites the index and therefore invalidates the cached prefix from this section onward; ledger writes do not change the text and leave the prefix stable.

### The memory tools

#### What the model sees

Six tool schemas, present on every request whether or not memory is used. `memory_write` documents the admission criteria in its description, so the criteria are stated twice: once as prose in the context section and once at the point of use.

#### Token effect

The six schemas cost a fixed per-request amount. Results are returned as JSON text: `memory_read` of a large ledger is tail-limited to 200 lines by default, and `memory_search` caps its hits.

#### KV Cache effect

Schemas are stable while the row is mounted. Tool-call history and results accumulate as ordinary conversation tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the row is a poor fit. They are current package constraints, not a task backlog.

- **Workspace scope only** — there is no global or cross-workspace memory. The backend resolution returns a list of `(scope, backend)` entries and the orchestration is written against that list, which is the reserved seam: adding a `global` backend is additive, but no global store ships today.
- **Best-effort concurrency** — ledger appends and index insertions are read-modify-write over whole files. Two sessions writing the same workspace at the same instant can lose one write. There is no lock, and the row does not claim atomic append.
- **One-turn warm-up** — the prompt provider cannot await, so a workspace whose cache is cold renders a warm-up notice for one turn before real content appears.
- **Index injection is a hard byte cap** — a very large `MEMORY.md` is truncated in the prompt, and the model must call `memory_read` to see the rest. Nothing summarises it automatically.
- **Presence-based backend selection** — the active backend is chosen by whether `.workbuddy/memory` exists. Creating that directory mid-session switches the backend on the next probe, and memory already written to `.dsh/memory` is not migrated.
- **Probed ledger layout** — the layout is likewise read from the store's current shape: a computer-name subdirectory holding dated files switches writes to this machine's own directory, and emptying that subdirectory falls back to flat. The computer name comes from `hostname`, and an existing directory is reused case-insensitively.
- **No deletion or pruning** — entries can be added but not removed or expired through a tool. Ledgers grow by date and are only ever appended.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The pinned `@jinngoo/dsh-workspace-memory` is published as a dependency of the preset that mounts it. It consumes host-plane services only and must not be wrapped in an `isolate` realm, because none of the capabilities it needs — the filesystem, the agent registry, the prompt registry, the sandbox policy — belongs to a single session.

The `inject` list names all four services, so a composition missing any of them fails loud at mount rather than silently contributing nothing.

</details>
