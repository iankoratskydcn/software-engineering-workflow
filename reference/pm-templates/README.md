# PM template references (projectmanagers.net)

Exploring whether House of Quality, Lessons Learned and RACI templates can inform
Decision HUD. Nothing here is wired into the product.

## Status

Page content **not yet downloaded**: `projectmanagers.net` was blocked by the cloud
environment's network policy when this folder was created. Run `./fetch.sh` once the
domain (and `docs.google.com`, for Sheets/Docs exports) is allowed. It saves the raw
pages to `pages/`, every outbound link to `links.txt`, and direct/Google files to
`files/`. The script has not been run against the live site yet.

## Sources

| Topic | Page | Advertised content |
|---|---|---|
| House of Quality | https://projectmanagers.net/house-of-quality-templates/ | Excel (basic + full QFD, 11+ columns), PDF, PowerPoint, plus an interactive HoQ builder |
| Lessons learned | https://projectmanagers.net/50-lessons-learned-templates-google-sheets-docs-pdf/ | 50 templates in Google Sheets, Docs, PDF |
| RACI | https://projectmanagers.net/free-raci-matrix-templates/ | 40+ templates: 27 Google Sheets, plus Excel, PDF, Word |

## Notes from search snippets only

Second-hand, not read from the pages themselves; verify after fetching.

- **HoQ builder:** weight each customer need; set each need-to-feature cell to
  strong/medium/weak; roof diamonds mark features that support or conflict; features are
  scored live and the top three highlighted.
- **Lessons log, typical columns** (from other sites, not this one): ID, date, phase, area,
  positive/negative, issue, impact, root cause, resolution, status, owner, lesson, action.
  Rule: write the lesson as an instruction; one named person owns it.
- **RACI:** tasks x roles, cell = R/A/C/I from a dropdown with colour-coding. Rule: at least
  one R, exactly one A per task. Variants: RASCI, DRASCI, RASI, RASIC, CAIRO.

## Where they could attach in this repo

- RACI -> gate escalation to the owner (`escalation_necessity_rate`, `db.py`); items are
  `spec_nodes` / roadmap / planning items; "one A" as a partial unique index.
- Lessons -> structured retro: extend the `note` in `mark_escalation_necessity`, or a
  `lessons` table patterned on `risks`.
- HoQ -> read-model score over `spec_nodes` (needs) x `architecture_diagrams` nodes
  (features); no existing card captures a needs x features grid.
