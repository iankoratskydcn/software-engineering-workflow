# PM template references (projectmanagers.net)

Exploring whether House of Quality, Lessons Learned and RACI templates can inform
Decision HUD. Nothing here is wired into the product.

## Status

Downloaded on October 2, 2026 from the three public article pages. The raw HTML is
in `pages/`, the 552 absolute links extracted by `fetch.sh` are in `links.txt`, and
the downloaded/validated files plus builder assets are in `files/`. See
[`MANIFEST.md`](MANIFEST.md) for one row per template or builder item, including
items that were not downloaded and why.

Run `./fetch.sh` from this directory to refresh the pages, link inventory, and the
supported direct/Google exports. The script exits nonzero when a page or supported
file download fails.

## What the pages actually contain

- **House of Quality:** the page links to three directly downloadable Excel/QFD
  files hosted by other sites. Its PowerPoint and PDF entries are landing pages,
  not direct files. The interactive builder is an inline page app backed by
  `files/house-of-quality-builder.min.js` and the extracted
  `files/house-of-quality-builder.css`. Its structure is **customer needs** with
  importance, user/competitor ratings; **technical features** with improvement
  direction and target values; a needs-to-features relationship grid; and a roof
  showing feature-to-feature correlations. Grid strengths are 9/3/1 (strong,
  medium, weak); roof values are 2/1/-1/-2 (strong synergy, synergy, trade-off,
  strong trade-off). Feature scores are the sum of need importance multiplied by
  relationship strength, then ranked with the top three highlighted.
- **Lessons learned:** the advertised 40 templates are exactly **30 Google Docs
  exports and 10 Google Sheets exports**, plus five linked PDF templates from
  external sites. The interactive builder's actual lesson fields are: ID, title,
  type (went well / needs improvement), phase, category, impact, what happened,
  why it happened, recommendation, follow-up action, owner, due date, status,
  raised by, and a computed “ready to reuse” result. Project metadata is separate
  (project name/type, department or client, manager, sponsor, dates, report date,
  prepared by, summary).
- **RACI:** the page lists **27 Google Sheets templates**, ten Excel links, PDF,
  Word, PowerPoint, ZIP, and online-tool links. The interactive matrix is a task
  by role grid with editable task and role names, cells using R/A/C/I plus A/R,
  A/C, and C/I combinations, and a check column. Its rules are at least one
  Responsible and exactly one Accountable per task; it can export Word or CSV.

A notable pattern is that these pages are indexes: most template links point to
Google or other third-party sites rather than files hosted on
`projectmanagers.net`.

## Sources

| Topic | Page | Advertised content |
|---|---|---|
| House of Quality | https://projectmanagers.net/house-of-quality-templates/ | Excel/QFD files, PDF and PowerPoint links, plus an interactive HoQ builder |
| Lessons learned | https://projectmanagers.net/50-lessons-learned-templates-google-sheets-docs-pdf/ | 40 Google Docs/Sheets templates and five PDF links |
| RACI | https://projectmanagers.net/free-raci-matrix-templates/ | 27 Google Sheets templates plus external Excel, PDF, Word, PowerPoint, ZIP and online-tool links |

## Offline artifacts

- `pages/` contains the three raw article pages.
- `links.txt` contains every absolute URL extracted from those pages, tagged by source slug.
- `files/` contains successful direct downloads and public Google exports. Builder JS/CSS is saved separately where needed for offline inspection.
- `MANIFEST.md` records provenance, usage notes shown on the pages, and every not-downloaded item.

## Where they could attach in this repo

- RACI -> gate escalation to the owner (`escalation_necessity_rate`, `db.py`); items are
  `spec_nodes` / roadmap / planning items; "one A" as a partial unique index.
- Lessons -> structured retro: extend the `note` in `mark_escalation_necessity`, or a
  `lessons` table patterned on `risks`.
- HoQ -> read-model score over `spec_nodes` (needs) x `architecture_diagrams` nodes
  (features); no existing card captures a needs x features grid.
