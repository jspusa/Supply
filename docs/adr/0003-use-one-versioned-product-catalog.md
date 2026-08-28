# Use one versioned product catalog

Operator-maintenance portion superseded by ADR 0004. The canonical schema and per-site fallback design remain in force.

Supply and FBA will treat the same Excel workbook and its `ProductMasterTable` plus `OrderSkuPackagingTable` as the only manually maintained product source, validate them into one versioned canonical catalog, and fan out project-specific snapshots at build time. The canonical JSON and site-specific JavaScript are generated release artifacts, not additional manual sources. This keeps runtime callers synchronous and independent of network, cache, and cross-repository availability while making `schemaVersion` and `catalogVersion` explicit release contracts.

## Consequences

Packaging changes for one Product SKU are retained as dated versions with exactly one current version; overlapping versions are invalid. Country of origin and standard factory are separate facts, so an unknown origin remains `null` instead of being inferred from Supply's TW/VN order grouping, and a `7`-prefixed Order SKU is always routed as a Subcontract Order.

Schema v2 keeps a `7`-prefixed Order SKU out of the Product SKU collection and models it as an Order SKU Alias. The alias owns only its versioned carton packaging; the canonical Product SKU continues to own demand, inventory, coverage, and Supply pallet planning. An approved alias must point to an existing Product SKU that explicitly approves it. A legacy alias with no confirmed owner is retained as `unmapped-legacy` with a `null` owner instead of being guessed or discarded.

Only allowlisted public catalog fields may be released. Cost, supplier, inventory, credentials, and other operational data remain outside the canonical public artifact. Supply and FBA each own a small adapter that projects the validated catalog into their existing synchronous runtime interface; neither site fetches the other repository at runtime.
