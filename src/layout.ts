/**
 * Directory names shared by the three compatibility layers.
 *
 * WorkBuddy keeps memory, rules and skills under one `.workbuddy/` root, and DSH
 * keeps its own default memory under `.dsh/`. Naming every directory once keeps
 * the layers from drifting apart when a store's shape is probed or written.
 *
 * @module @jinngoo/dsh-workspace-conventions/layout
 */

/** Directory name of the WorkBuddy-compatible store root. */
export const WORKBUDDY_DIR = '.workbuddy'

/** Directory name of the DSH default store root. */
export const DEFAULT_DIR = '.dsh'

/** Memory subdirectory under either store root. */
export const MEMORY_SUBDIR = 'memory'

/** Rules subdirectory under the WorkBuddy store root. */
export const RULES_SUBDIR = 'rules'

/** Skills subdirectory under the WorkBuddy store root. */
export const SKILLS_SUBDIR = 'skills'

/** Persona subdirectory: `<workspace>/.dsh/persona` or `$DSH_HOME/persona`. */
export const PERSONA_SUBDIR = 'persona'

/** Mood subdirectory: `<workspace>/.dsh/mood` or `$DSH_HOME/mood`. */
export const MOOD_SUBDIR = 'mood'

/** Index file name used by both memory backends. */
export const INDEX_FILE = 'MEMORY.md'
