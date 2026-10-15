# Keep incomplete SKU correspondences planning-only

The owner confirmed 26 Product SKU / Order SKU correspondences on 2026-10-15. Five named Product SKUs do not yet exist in the released product catalog. Their legacy Order SKUs have historical packaging, but this does not establish the missing products' Amazon unit conversion.

Until those product specifications are confirmed through the normal catalog release workflow, Supply keeps these explicit identity confirmations in a dated planning-only supplement (`shared/sku-correspondence.js`). This is a limited exception to ADR 0003's single-source identity rule: it can associate raw inventory and open-order facts and populate the reference dialog, but cannot authorize Order SKU selection, create products, or change packaging versions. Existing released catalog ownership takes precedence over the supplement, including after a later correction. Conflicts within the released catalog remain errors.

Demand and source facts aggregate under the confirmed Product SKU. Raw physical quantities and the original Order SKU remain available. Without the canonical product's unit specification, AMZ conversions and replenishment recommendations are unavailable; a known physical open order still counts as an existing order. The normal catalog update process can later resolve these incomplete identities without rewriting pinned work.

The separate Supply ordering policy distinguishes discontinued and Chewy items (blocked for manual and automatic ordering) from special products (excluded from automatic recommendations, but manually orderable with the released packaging). Both policies apply equally to public and Boss entrypoints.
