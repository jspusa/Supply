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

Supply and FBA normally use product data compiled into each site. Jasper maintains only the existing raw product-information workbook; a release imports `AMZ 所有SKU`, `2026`, and `罐頭` directly, updates the canonical catalog, and generates both built-in snapshots. No extra `產品主檔` worksheet and no routine browser upload are required.

The browser upload remains available only as a temporary pre-release override and is invalidated when a newer built-in catalog ships. See [docs/product-catalog.md](docs/product-catalog.md).

Use `npm run catalog:release -- --input <raw.xlsx> --fba-repo ../FBA --report <report.json>` to create a no-write release plan. Add `--apply --verify` only after reviewing that plan. The installed `release-supply-fba-product-catalog` skill wraps the GitHub pull requests, deployments, and live checks when Jasper asks to publish.
