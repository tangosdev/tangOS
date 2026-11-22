# tangOS

A unified brand and toolkit for reverse-engineering / decompilation projects.

Everything reads **one file per repo** - `tangos.json` - a descriptor that normalizes any
decomp repo (whatever its layout) into a single vocabulary. Point a tangOS app at a repo, and
it knows the repo's tools, compiler, data source, and rules.

## Apps

| App | What it is | Status |
|---|---|---|
| **tangOS Console** | Downloadable desktop app. Exposes a repo's tools as an **MCP server** an AI connects to, with a **live viewer** to watch the AI drive them in real time. | released (`console/`), see [Releases](https://github.com/tangosdev/tangOS/releases) |
| **tangOS Docs** | Browsable catalog of a repo's tools, generated from `tangos.json`. | planned (`docs/`) |
| **tangOS Atlas** | Progress atlas / treemap (formerly Chaos Viewer). | built into Console as the Chaos Viewer; rebrand planned |

## Download

**tangOS Console** ships as a desktop app that auto-updates from this repo's [Releases](https://github.com/tangosdev/tangOS/releases).

- **Windows** - download and run the installer; it self-updates from here. Not code-signed yet, so Windows warns once: click *More info*, then *Run anyway*.
- **macOS** - download the `.dmg` (Intel or Apple Silicon). Unsigned, so right-click the app and choose *Open* (or run `xattr -cr "/Applications/tangOS Console.app"`).

## The descriptor: `tangos.json`

- Schema: [`schema/tangos.schema.json`](schema/tangos.schema.json)
- Reference example: [`sm64ds-decomp/tangos.json`](https://github.com/tangosdev/sm64ds-decomp/blob/main/tangos.json)
- A repo that has no `tangos.json` yet gets one **generated** by Console (heuristic scan + optional AI refine).

The descriptor declares a `tools[]` registry; Console turns each entry into an MCP tool generically,
so tangOS itself stays repo-agnostic while your repo's own tools do the work.

Optional **`project.matchConventions`** (attempt tree, near-miss DB, Ghidra drafts) lets
Console / `next_batch` surface MATCH_RESULT logging the same way experimental Chaos Viewer
prompts do, **once per batch**, with shared provenance defaults. Classic repos omit the block.

### Projects that are not one function per file

`project.workUnit` says what one piece of work is. With `"function"` (the default) a batch is a
list of functions. With `"class"` or `"tu"` a batch is a list of whole units (one source file
each): the `unitScheduler` role lists the open units, the `unitVerify` role checks one, and a
unit is ticked off only when that check prints the tool's `successPattern`. The `verify` role and
`successPattern` also decide what counts as a match for a single function, so a project with its
own gate tools does not need to print another project's wording.

### Local-only projects

Any folder with a valid `tangos.json` can be opened from the project picker; it does not have to
be in the built-in list or the public registry. A descriptor that sets `"project": { "localOnly":
true }` goes further: Console makes no network request about that project. Fetch, pull, push,
pull requests, claims, the live stream, hosted data, GitHub lookups and API drives are refused
with a plain message, the Push toggle is locked off, and bug reports and debug snapshots leave
the project's name, folder, branch, tool names and tool output out. Its tools still run on the
files in the folder, and an agent connected over MCP still talks to its own provider. The schema
rejects a local-only descriptor that also names a GitHub repo or a hosted data address.

## Layout

```
tangOS/
├── schema/            tangos.json JSON schema
├── packages/ui/       shared aero theme tokens + glass components
├── console/           the Electron Console app (MCP + live viewer)
└── docs/              the tool catalog site (planned)
```

## Develop

Needs Node 22.12 or newer, which Electron 40 and later ask for. The first
`npm run console` downloads the Electron binary; `npm install` no longer does.

```
npm install                      # from the repo root (workspaces)
npm run console                  # start Console in dev (electron-vite)
npm run console:build            # production build into console/out (no installer, no publish)
npm run typecheck -w console     # typecheck the main and renderer halves
node schema/validate.mjs <tangos.json path or URL> [...]   # schema check, plus the schema/types drift check
```

The scripts in `console/scripts/verify-*.mts` are the checks for single areas (model table, MCP
bridge, local-only projects, unit batches and so on). Run one with `npx tsx scripts/<name>.mts`
from `console/`.

A dev run shares the installed app's data folder (settings, key vault, resume state). Set
`TANGOS_USER_DATA` to an empty folder to give a dev or test run its own. Debug snapshots
(Ctrl+Shift+D) go to a `tangos-debug` folder inside whichever data folder the run uses.
