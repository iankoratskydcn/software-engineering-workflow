#!/usr/bin/env bash
# Download the three projectmanagers.net template pages, list every outbound
# link, and fetch directly-downloadable files. Needs projectmanagers.net (and
# docs.google.com / drive.google.com for Google files) allowed by the network
# policy. Re-runnable; existing files are overwritten.
set -u
cd "$(dirname "$0")"
mkdir -p pages files

pages=(
  house-of-quality-templates
  50-lessons-learned-templates-google-sheets-docs-pdf
  free-raci-matrix-templates
)

: > links.txt
for slug in "${pages[@]}"; do
  curl -fsSL -m 60 "https://projectmanagers.net/$slug/" -o "pages/$slug.html" \
    || { echo "FAILED page: $slug" >&2; continue; }
  # every absolute link on the page, tagged with its source page
  grep -oE 'https?://[^"'"'"' <>)]+' "pages/$slug.html" | sort -u \
    | sed "s|^|$slug\t|" >> links.txt
done

# Direct files
grep -oE '[^	]+$' links.txt | sort -u | grep -iE '\.(xlsx?|docx?|pptx?|pdf|csv)(\?|$)' \
  | while read -r url; do
      curl -fsSL -m 120 "$url" -o "files/$(basename "${url%%\?*}")" || echo "FAILED file: $url" >&2
    done

# Public Google Sheets / Docs -> export as xlsx / docx
grep -oE '[^	]+$' links.txt | sort -u | grep -E 'docs.google.com/(spreadsheets|document)/d/[A-Za-z0-9_-]+' \
  | while read -r url; do
      id=$(echo "$url" | sed -E 's|.*/d/([A-Za-z0-9_-]+).*|\1|')
      case "$url" in
        *spreadsheets*) curl -fsSL -m 120 "https://docs.google.com/spreadsheets/d/$id/export?format=xlsx" -o "files/gsheet-$id.xlsx" || echo "FAILED sheet: $id" >&2 ;;
        *document*)     curl -fsSL -m 120 "https://docs.google.com/document/d/$id/export?format=docx"     -o "files/gdoc-$id.docx"   || echo "FAILED doc: $id" >&2 ;;
      esac
    done

echo "pages: $(ls pages | wc -l)  links: $(wc -l < links.txt)  files: $(ls files | wc -l)"
