# Import the existing raw product workbook

The normal operator workflow will accept the existing product-information Excel directly. Supply and FBA recognize `AMZ 所有SKU`, `2026`, and `罐頭`, normalize their public packaging fields into one versioned same-origin browser payload, and keep that payload after refresh. The first complete duplicate row wins so a stale alternate carton row cannot overwrite the current row.

This supersedes ADR 0003's requirement that the operator maintain added `產品主檔` and `下單品號箱規` worksheets. The canonical schema, Product SKU versus Order SKU Alias distinction, public-field allowlist, and checked-in per-site fallbacks remain. The extra workbook sheets and compiler may remain as release/migration tooling, but they are not the maintenance interface.

## Consequences

- Jasper maintains the original workbook only and can upload it from either website.
- Both pages share `jspusa:shared-product-catalog:v1` because they are served from the same `jspusa.github.io` origin.
- The raw file itself is never uploaded to GitHub Pages or another server; only the normalized public packaging payload stays in that browser.
- Missing raw values do not erase complete built-in values. New non-7 SKU rows enter Supply only when origin, carton quantity, carton dimensions, and cartons per pallet are usable; FBA may still use partial rows and its existing repair flow.
- 7-prefixed rows update FBA packaging only. Existing confirmed alias ownership remains in the checked-in canonical fallback and is never guessed from the raw SKU spelling.
- Removing browser data or choosing “restore built-in” returns both tools to their checked-in snapshots.
