# Supply

Static replenishment-planning workspace deployed to GitHub Pages.

## Verify a clean checkout

Run one command before committing or publishing:

```sh
npm run check
```

It installs the locked dependencies, runs the regression tests, builds the exact static deployment artifact in `dist/`, and verifies the artifact allowlist, references, revision, and file hashes.

Only `dist/` is deployable. Repository files, tests, documentation, credentials, and user input files must never be included in the Pages artifact.
