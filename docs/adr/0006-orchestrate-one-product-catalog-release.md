# Orchestrate one product catalog release

A Product Catalog Release will start from the existing raw product-information workbook and fan out to Supply and FBA through one local release command. The command first produces a no-write old-to-new plan, then may apply the same catalog version to Supply's canonical catalog and generated product data plus FBA's generated snapshot and embedded HTML. A Codex skill coordinates the two repositories' branches, pull requests, deployments, and live verification when the user's request explicitly includes publishing.

Supply remains the canonical source repository and FBA remains an independently deployed projection. The release is one operator action but two checked artifacts and two Pages deployments. This preserves runtime independence while removing the repeated manual GitHub procedure. A version-only plan with no public product changes does not create a release.

## Consequences

- The raw workbook remains local and is never staged; only allowlisted generated product fields enter either repository.
- Planning must precede applying. Product or Order SKU removal, confirmed alias-owner changes, incomplete regressions, dirty worktrees, stale branches, or unrelated diffs stop the release.
- Both repository checks must pass before either pull request is merged. Supply's pull-request check reads a tracked peer lock and checks out the exact immutable FBA pull-request commit, validates its repository, catalog version, and expected public-content hash, then runs the cross-repository seams against that commit instead of FBA's possibly stale default branch. Completion requires both deployed sites to expose the same catalog version and their checked-in artifacts.
- The operation is not atomic across two repositories. A partial remote failure is reported as a version mismatch and repaired explicitly; it is never hidden or called complete.
