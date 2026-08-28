# Publish both catalog projections

Read this reference only when the user explicitly asked to publish or go live.

1. Confirm both local diffs contain only the four generated release artifacts named in `SKILL.md`. Stage exact paths; never use broad Git add commands.
2. Commit Supply and FBA separately with the same catalog version in their messages. Push both feature branches.
3. Reuse matching open pull requests or create two draft pull requests, each with one base/head pair. Include the shared catalog version and local verification in both bodies.
4. Wait for both pull-request check suites. Keep both draft and stop if either fails. After both pass, mark both ready and merge using the repositories' normal squash policy.
5. Wait for both main-branch Pages deployments. A merge or Actions success alone is not live proof.
6. From the updated default branches, verify Supply with its exact live file and browser verifiers. Verify FBA with `npm run verify:live:catalog -- --version <catalog-version>`.
7. Confirm both public pages expose the same catalog version. If one side fails after the other is live, keep working within the authorized release to repair the failed side; avoid rollback or destructive Git operations unless the user separately authorizes them.
