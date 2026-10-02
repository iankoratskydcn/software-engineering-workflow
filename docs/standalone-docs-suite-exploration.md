# Standalone Docs & Planning Suite — Exploration

Status: exploration, no code changes. Branch: `claude/sleepy-edison-90dd5y`.

## Goal

Use the SWE workflow surfaces (MindMap, Roadmap, Risk & Tradeoffs, Flowcharts,
Architecture, Spec Digest, Scrum Planning) as a **documentation and planning
suite**, not a code-control tool, usable two ways:

1. as a local HTML file, independent of Hermes;
2. inside Hermes, on the same data.

Target loop:

```
open repo folder in swe.html -> edit docs/plans -> git push -> open Hermes -> git pull -> same data
```

## Where things stand

| Piece | Today | Problem for the target loop |
|---|---|---|
| UI | `plugin.js`, 5.3k lines, React + `@hermes/plugin-sdk`, loaded as blob URL | Not runnable as a plain HTML file |
| Data authority | SQLite `queue.db` in `~/.hermes` (`spec_nodes`, `flows`, `risks`, `tradeoffs`, `architecture_diagrams`, `roadmap_*`, `planning_items`) | Not in the repo, so not pushable or pullable |
| Data access | `cli.exec` -> `hermes decision ...` | Needs Hermes running |
| Visual reference | `swe.html` prototype (path in the 2026-09-28 plan, **not in this repo**) | Cannot build on it until it is committed |

Core finding: **the blocker is data location, not UI.** The UI can be made
standalone in a few ways. But as long as the source of truth is a SQLite file
outside the repo, git cannot carry it between the two apps.

## Requirement questions (step 1 of the algorithm)

- **Decision cards / agent dashboard / telemetry / kanban scripts / usage
  plans** (root-level `*_PLAN.md`, `backend/`, `scripts/kanban_*`): not part of
  a docs suite. Candidates to keep out of the standalone entirely.
- **`decision_id` links** on `spec_nodes`, `risks`, `tradeoffs`: tie docs to the
  decision queue. Drop in standalone mode, or keep as an opaque string?
- **MindMap choice/rank/scalar controls**: these are decision-card widgets
  inside the mindmap. Keep, or reduce to plain nodes with notes?
- **Project scoping** (`project_id`, boards): a repo is already a project. Can
  the repo root *be* the project?

## Idea 1 (recommended): repo files are the source of truth

Put suite data in the repo as plain files. Both apps read and write them.
SQLite becomes a cache/import target in Hermes, not the authority.

```
<repo>/
  .swe/                      (name TBD: docs-suite/, planning/)
    project.json             id, title, schema_version
    spec/<node-id>.json      one file per node (parent_id, kind, title, body, criteria)
    flows/<id>.json
    architecture/<id>.json
    risks/<id>.json
    tradeoffs/<id>.json
    roadmap/lanes.json  roadmap/items/<id>.json
    planning/<id>.json
```

Design rules:

- **One file per entity**, stable ids, sorted keys, 2-space indent -> small
  diffs, rare merge conflicts.
- Long prose (node body, flow descriptions) as sibling `.md` so it reads and
  diffs as documentation, with JSON holding structure only.
- `schema_version` in `project.json`; migrations are file transforms.
- Existing closed-schema / resource-limit rules from the stage 2 contract
  manifest apply unchanged to file validation.

Standalone HTML:

- Folder access via the File System Access API (`showDirectoryPicker`). Works in
  Chromium/Edge; **not Firefox or Safari**. Fallback: import/export a zip.
- Cannot run `git`. Push/pull stays in a terminal, GitHub Desktop, or the IDE.
  (In-browser git via isomorphic-git needs a token and a CORS proxy; skip for
  v1.)
- Remember directory handle in IndexedDB so reopening is one click.

Hermes side:

- Plugins have no filesystem access, so add CLI verbs behind `cli.exec`, e.g.
  `hermes decision suite import --repo <path>` / `suite export --repo <path>`,
  or have the suite pane read files straight through a new read/write verb and
  skip SQLite for these tables.
- "Open Hermes and pull" becomes: `git pull`, then Hermes re-reads (or
  re-imports) the folder.

Cost: migrating 8 tables' worth of Hermes read/write paths. Biggest change, but
only option that makes the loop real.

## Idea 2: export/import snapshot (cheapest)

Keep SQLite authority. Add `suite export` -> one `suite.json` (or the folder
above) and `suite import`. Standalone HTML edits the snapshot. Manual sync.

- Pro: almost no Hermes change.
- Con: two copies of truth, last-writer-wins, no merge story. Fine for a
  stopgap, wrong for the stated loop.

## Idea 3: Hermes-only, sync folder in the background

Keep one app. Hermes mirrors DB to repo files on change and ingests on pull.

- Con: does not meet "distinct local HTML". Hidden sync = hidden bugs.

## UI delivery options (independent of data choice)

| Option | How | Tradeoff |
|---|---|---|
| A. Rewrite as vanilla JS single file | Start from `swe.html` prototype | Truest "just open it"; two UIs to maintain unless Hermes also drops React |
| B. Shared source, two bundles | Extract suite panes from `plugin.js`; esbuild emits `swe.html` (React inlined) and a Hermes plugin entry | One UI. Breaks "no build step" for `plugin.js`, but `.js` output can still be committed |
| C. Hermes plugin loads `swe.html` in an iframe/webview | Reuse as-is | Needs host support; storage + file access bridging unclear |

Recommendation: **Idea 1 data + Option B UI**. Reason: one codebase, the 7 panes
already exist and are tested; the only new surface is a storage adapter.

## Key seam: storage adapter

Both apps talk to one interface; panes never know which backend:

```
Storage {
  list(kind, filter) / get(kind, id) / put(kind, entity) / delete(kind, id)
}
```

- `FsStorage` — File System Access API against the repo folder (standalone).
- `HermesStorage` — `cli.exec` verbs (Hermes).

Today panes call `host.request('cli.exec', ...)` directly in about 8 places in
`plugin.js` (lines ~4369, 4387, 4571, 5090, 5160, plus the workflow hooks). The
adapter is the one refactor that unlocks everything else.

## Suggested path

1. Commit `swe.html` prototype into the repo (needed as visual reference either way).
2. Freeze the file layout + schema (small contract doc, reuse stage 2 limits).
3. Spike: standalone read-only viewer — open folder, render MindMap + Spec Digest from files.
4. Add write path + validation; add remaining panes.
5. Hermes: `suite` CLI verbs + `HermesStorage`; verify round trip
   standalone -> push -> pull -> Hermes -> push -> pull -> standalone.
6. Only then decide what to prune from this repo.

## Open questions for you

1. Is `swe.html` available to commit? Where does it live now?
2. Browser support: is Chromium-only acceptable for the standalone file?
3. Should the suite data live in the *same* repo as the code being documented
   (`.swe/` folder), or a separate docs-only repo?
4. Decision links and MindMap choice/rank/scalar widgets: keep or drop in standalone?
5. Should Hermes keep SQLite as a cache, or read files directly?
