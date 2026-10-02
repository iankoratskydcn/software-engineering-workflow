# MindMap open-source inspiration

## Decision

Do not add a runtime dependency or copy a third-party package wholesale. Reimplement only narrowly selected interaction and presentation ideas inside `plugin.js`, while keeping `spec_nodes`, project scoping, and the existing Hermes plugin surface authoritative.

Any copied implementation code must be traceable to a permissive license, preserve the required copyright/license notice, and be isolated in a small helper with a source note. When the source or license is unclear, use the behavior as design inspiration only.

## Candidates reviewed

### React Arborist

Source: https://github.com/jameskerr/react-arborist

The project documents a complete React tree view with open/close folders, inline renaming, keyboard navigation, ARIA attributes, filtering, selection synchronization, controlled data, custom row/node renderers, and drag/drop callbacks. The repository exposes an MIT license.

Useful ideas to reimplement:

- Separate row layout from node rendering.
- Make open/closed state explicit and keyed by node id.
- Keep selection controlled by the owning surface.
- Add keyboard navigation and ARIA tree semantics before adding drag/drop.
- Treat rename/create/move/delete as explicit mutation callbacks rather than local-only edits.
- Add filtering that preserves matching ancestors.

Do not copy the virtualization or drag-and-drop implementation yet; our tree is small and the plugin has no runtime dependency budget for it.

### Mind Elixir

Source: https://github.com/SSShooter/mind-elixir-core

The project describes a framework-agnostic mind-map core with node editing, drag/drop, operation events, selection events, expand events, import/export, and operation guards.

Useful ideas to reimplement:

- A small operation-event vocabulary (`select`, `expand`, `begin edit`, `finish edit`, `move`).
- Mutation guards that can reject an operation before persistence.
- Keep import/export separate from the live editing model.

Do not copy its data model directly: our project-scoped `spec_nodes` schema and decision/Kanban links are the authority.

### AntV G6

Source: https://github.com/antvis/G6
Source: https://github.com/antvis/G6/blob/v5/packages/g6/src/registry/build-in.ts
Source: https://github.com/antvis/G6/blob/v5/LICENSE

G6 is a broader graph visualization framework. Its source exposes a mindmap layout plus collapse/expand behaviors, minimap, tooltip, toolbar, and related interaction plugins. The v5 license is MIT.

Useful ideas to reimplement later:

- A separate layout phase that computes positions from the hierarchy.
- Collapse/expand as a first-class transition.
- Optional overview/minimap only when the tree becomes large enough to justify it.
- Keep visual layout separate from persistence and node mutation.

Do not import G6 or recreate its full graph engine. The first useful milestone is a readable project tree with reliable editing and selection, not free-form graph editing.

## Planned implementation order

1. Seed and verify a canonical seven-node project tree.
2. Add controlled selection/open-state and keyboard/ARIA behavior to the existing tree.
3. Add inline rename/create flows backed by the existing project-scoped CLI.
4. Add search/filtering with ancestor preservation.
5. Only then evaluate a layout mode or minimap using a small, local implementation.

## License hygiene

- Keep source URLs and license notes in this file when borrowing a concrete implementation pattern.
- Preserve copyright/license notices for any copied MIT code.
- Do not copy code from repositories whose license is absent, unclear, or incompatible with this repository's distribution terms.
- Prefer a clean-room reimplementation of behavior when the needed idea is simple.
