# Allow explicit duplicate resolution and narrow history replacement

Status: Accepted on 2026-09-02. This narrows ADR 0007 only for an explicitly approved conflict cleanup.

## Decision

Conflicting complete raw rows remain blocking by default. A local Product Catalog Release may accept a checked JSON policy that matches normalized public carton fields and adds per-SKU overrides. A conflict is resolved only when the combined criteria identify exactly one source row; zero or multiple matches remain blocking.

The same policy must explicitly state whether packaging history is replaced. When replacement is true, only SKUs successfully resolved by that policy may drop their prior Packaging Specification Versions. The signed Catalog Change Plan lists the old and new version IDs as a review-risk field, and apply requires those exact SKU entries to be selected. All other product identities and packaging histories remain immutable.

## Consequences

- Row order never resolves a conflict.
- The policy is reread during apply; its candidate hash, source row evidence, and signed plan must match the reviewed plan.
- Historical work that names a removed version can no longer resolve that catalog version and must rely on its retained Historical Imported Packaging facts.
- Browser Product Update Entry imports remain conflict-blocking because they do not provide this local release policy.
