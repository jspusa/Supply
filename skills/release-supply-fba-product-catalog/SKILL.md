---
name: release-supply-fba-product-catalog
description: Prepare, synchronize, publish, or verify Jasper's built-in product catalog across jspusa/Supply and jspusa/FBA from the existing raw product-information Excel. Use for requests to update the shared product database, release product packaging changes, or run the one-step Supply/FBA catalog publication. Do not use for daily JAM, H10, Inventory, or Amazon shipment uploads.
---

# Release the Supply and FBA product catalog

Run one **Product Catalog Release** while preserving two independently deployed sites.

## Resolve the release inputs

1. Use an exact workbook path supplied by the user. Otherwise inspect only likely product-information `.xlsx` files in Downloads and choose the uniquely newest file whose workbook contains `AMZ 所有SKU`, `2026`, or `罐頭`; ask when the candidate is ambiguous.
2. Locate the `jspusa/Supply` and `jspusa/FBA` clones. Prefer `/Users/jasper/Desktop/Codex用/Supply` and its sibling `FBA`, but validate `package.json` and Git remotes instead of trusting the path.
3. Read Supply's `AGENTS.md`, `CONTEXT.md`, and applicable catalog ADRs. Read the available GitHub publication skill before remote operations.

The existing raw workbook is the maintained input. Keep it local, add no maintenance worksheets, and stage only allowlisted generated catalog artifacts.

## Plan before writing

Require clean worktrees and current default branches. From Supply run:

```bash
npm run catalog:release -- --input <raw.xlsx> --fba-repo <FBA-path> --report <temporary-report.json>
```

Read the report and account for every changed Product SKU and Order SKU Alias. Report box count, dimensions in inches, carton weight in pounds, cartons per pallet, lifecycle, and confirmed owner as old → new. Stop before applying when:

- there are no public product changes;
- any entry is removed;
- an approved alias owner changes;
- an active product becomes incomplete;
- either worktree is dirty, behind its remote default branch, or contains unrelated changes.

The first complete raw duplicate remains authoritative; later complete conflicts are evidence, not overwrite permission. Never infer a 7-prefixed alias owner.

## Apply and verify

Create the same versioned feature branch in both repositories, then run:

```bash
npm run catalog:release -- --input <raw.xlsx> --fba-repo <FBA-path> --version <planned-version> --apply --verify --report <temporary-report.json>
```

Completion requires exactly these ordinary release diffs:

- Supply: `catalog/product-catalog.json`, `product-data.js`.
- FBA: `catalog/fba-product-catalog.snapshot.json`, `inbound-plan.html`.

Review and stop on any additional path. Run Supply's browser suite separately when the environment needs permission to bind its local test server.

If the user explicitly requested publication or going live, read [references/publish.md](references/publish.md) and continue. Otherwise stop after the verified local plan or apply result without remote writes.

## Completion

Report the raw workbook basename, catalog version, every old → new SKU change, both test results, both pull requests when created, and both live verification results. A green workflow without matching public content is incomplete. A partial two-repository release is a version mismatch to repair, never a successful release.
