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

Supply and FBA are generated from one versioned Excel product master. The workbook contract, public-data boundary, validation rules, and two-site release flow are documented in [docs/product-catalog.md](docs/product-catalog.md).

```sh
npm run catalog:import -- --input <workbook.xlsx> --output catalog/product-catalog.json
npm run catalog:build
npm run catalog:check
```

`catalog/product-catalog.json` and `product-data.js` are generated release artifacts. Do not maintain either file by hand.
