# tangOS

A unified brand and toolkit for reverse-engineering / decompilation projects.

Everything reads **one file per repo** - `tangos.json` - a descriptor that normalizes any
decomp repo (whatever its layout) into a single vocabulary. Point a tangOS app at a repo, and
it knows the repo's tools, compiler, data source, and rules.

## Apps

| App | What it is | Status |
|---|---|---|
| **tangOS Console** | Downloadable desktop app. Exposes a repo's tools as an **MCP server** an AI connects to, with a **live viewer** to watch the AI drive them in real time. | in progress (`console/`) |
| **tangOS Docs** | Browsable catalog of a repo's tools, generated from `tangos.json`. | planned (`docs/`) |
| **tangOS Atlas** | Progress atlas / treemap (formerly Chaos Viewer). | planned rebrand |

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
prompts do — **once per batch**, with shared provenance defaults. Classic repos omit the block.

## Layout

```
tangOS/
├── schema/            tangos.json JSON schema
├── packages/ui/       shared aero theme tokens + glass components
├── console/           the Electron Console app (MCP + live viewer)
└── docs/              the tool catalog site (planned)
```

## Develop

```
npm install            # from the repo root (workspaces)
npm run console        # start Console in dev (electron-vite)
```

Built with Claude Code.
