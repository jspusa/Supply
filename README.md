# Supply

Static replenishment-planning workspace deployed to GitHub Pages.

## Verify a clean checkout

Run one command before committing or publishing:

```sh
npm run check
```

It installs the locked dependencies, runs the regression tests, builds the exact static deployment artifact in `dist/`, and verifies the artifact allowlist, references, revision, and file hashes.

Only `dist/` is deployable. Repository files, tests, documentation, credentials, and user input files must never be included in the Pages artifact.

## Shared product catalog

The normal maintenance path is the existing raw product-information workbook. Drop it into Supply's main upload area or FBA's product-database updater; the browser reads `AMZ 所有SKU`, `2026`, and `罐頭`, stores one same-origin catalog locally, and both tools use it after refresh. No extra `產品主檔` worksheet is required.

The checked-in canonical catalog and site-specific snapshots remain release-time fallbacks. They are generated artifacts, not another workbook the operator must maintain. See [docs/product-catalog.md](docs/product-catalog.md).
