# Supply Planning

This context turns local inventory, open-order, and Helium 10 inputs into replenishment decisions and purchase-order drafts. It keeps demand ownership, purchasing identity, planning risk, and order grouping explicit.

## Products and orders

**Product SKU**:
The canonical SKU that owns demand, inventory, catalog specifications, and coverage calculations.
_Avoid_: Order SKU, alias SKU

**Order SKU**:
The SKU printed on the purchase order for a Product SKU. It may be the Product SKU itself or an approved 7-prefixed Order SKU Alias.
_Avoid_: Product SKU, display SKU

**Order SKU Alias**:
A 7-prefixed purchasing identity with its own versioned carton packaging. An approved alias names one canonical Product SKU; an unmapped legacy alias preserves known historical packaging with no guessed Product SKU owner. It never owns demand, inventory, or coverage.
_Avoid_: Product SKU, duplicate product, inferred owner

**Standard Order**:
An order whose Order SKU does not begin with `7`, grouped under either Taiwan or Vietnam according to the Product SKU's standard factory.
_Avoid_: Main order, normal factory row

**Subcontract Order**:
An order whose Order SKU begins with `7`. All Subcontract Orders belong to the same subcontract vendor and retain the Product SKU's demand ownership; FBA carton specifications may come from the Order SKU Alias.
_Avoid_: Standard Order, alias-only display

**Order Group**:
One of the three operational destinations for an order row: Taiwan, Vietnam, or Subcontract. Each group is displayed separately and exported as its own worksheet in one workbook.
_Avoid_: 7AT factory, 7GT factory, 7VT factory, country tab

## Demand and coverage

**Hot SKU**:
A Product SKU identified by the existing hot-product business rule and therefore protected by a minimum Planning Velocity of 10 units per day when its H10 Source Velocity is lower.
_Avoid_: Proven bestseller, high-velocity SKU

**H10 Source Velocity**:
The daily sales velocity value or value range read from the Helium 10 pasted source, preserved without silently discarding conflicting duplicate rows.
_Avoid_: Planning Velocity, true velocity

**Planning Velocity**:
The visible conservative daily sales velocity used for demand, coverage, and suggested-order calculations. It may be higher than H10 Source Velocity when an explicit risk rule applies, and its reason must be shown.
_Avoid_: H10 Source Velocity, hidden adjustment

**Velocity Risk**:
Evidence that H10 Source Velocity may be conflicting or underestimated, including duplicate disagreement, low or zero stock, very low Days of Supply, a hot SKU below the configured floor, or a material decline from locally retained snapshots.
_Avoid_: Proven stockout, confirmed lost sales

**Arrival Coverage**:
The projected sellable days remaining when the new order arrives, after accounting for inventory consumption and earlier open orders expected to arrive first.
_Avoid_: Current Days of Supply, Book Coverage

**Post-Order Coverage**:
The projected total sellable days after the new order arrives and becomes available, including earlier open orders and the new order.
_Avoid_: Suggested units, current coverage

## Draft quantities and local data

**Supply Snapshot**:
A source-attributed, as-of representation of inventory, open orders, velocities, and readiness after raw inputs have been normalized into planning units.
_Avoid_: Workspace Snapshot, raw upload

**Order Draft**:
The user-controlled order rows, quantities, Order SKUs, Order Groups, locks, and within-group ordering that have not yet been exported as a purchase order.
_Avoid_: Supply Snapshot, submitted order

**Whole-Pallet Suggestion**:
The normal suggested pallet quantity expressed as a whole number. When no whole number can satisfy both the 180-day target and 365-day ceiling, the suggestion may use a fractional pallet instead.
_Avoid_: Half-pallet rule, arbitrary decimal

**Workspace Snapshot**:
The raw uploaded source files, pasted H10 text, metadata, and small workspace preferences retained in the current browser so the workspace can be reconstructed after refresh.
_Avoid_: Cloud backup, exported order

**Packaging Specification Version**:
An immutable, source-attributed set of carton, pallet, weight, dimension, and order-unit facts for one Product SKU or Order SKU Alias. An unpublished version may be corrected; once released or assigned to work, a correction creates another version instead of rewriting history.
_Avoid_: Current box spec, overwritten carton data

**Packaging Assignment**:
The explicit choice of one Packaging Specification Version for an Order Draft row or an FBA inbound or expiry row. The assignment stays pinned when a later version becomes the default.
_Avoid_: Global current packaging, latest-SKU lookup

**Pinned Order Draft Row**:
An Order Draft row whose Packaging Assignment is frozen because the user changed its quantity, pallet count, Order SKU, lock state, or exported it. An untouched suggested row is not pinned and may adopt a newer New-Order Packaging Default.
_Avoid_: Existing order, every displayed suggestion

**New-Order Packaging Default**:
The confirmed Packaging Specification Version automatically assigned to new or untouched Order Draft rows. It may originate from an FBA-first update without changing Pinned Order Draft Rows.
_Avoid_: Supply-only packaging, global current packaging

**Catalog Change Plan**:
The complete old-to-new preview of sparse Product SKU and Order SKU changes proposed through the same Product Update Entry in either Supply or FBA before one confirmation publishes them. Each SKU may be selected independently; safe changes start selected, while conflicts and high-risk ownership, factory, lifecycle, or alias changes require review. Missing imported fields preserve existing facts, while conflicting complete source rows block confirmation until resolved.
_Avoid_: Immediate upload, whole-row overwrite, silent sync

**Product Update Entry**:
The matching update action exposed by Supply and FBA. Both entries create the same Catalog Change Plan against Supply's canonical catalog; neither site creates a second writable master.
_Avoid_: Supply-only updater, FBA master, browser-side direct publish

**Packaging Reassignment**:
An explicit replacement of the Packaging Assignment on already pinned work after its quantity and pallet effects are shown. A later default or correction never reassigns existing work silently.
_Avoid_: Automatic recalculation, global version switch

**Catalog Alignment**:
The state in which the independently deployed Supply and FBA projections expose the same confirmed Product Catalog version and expected content. A mismatch is an incomplete release that blocks the next Product Catalog Release.
_Avoid_: One-site success, eventual silent repair

**Historical Imported Packaging**:
The original carton, quantity, and packaging facts retained on a legacy FBA inbound row when no released Packaging Specification Version can be resolved. The row remains readable and reviewable, but those facts do not become a New-Order Packaging Default automatically.
_Avoid_: Guessed packaging version, current catalog fallback, discarded legacy facts

**Catalog Change Record**:
The compact old-to-new summary retained for each released catalog version, including the changed SKUs and public fields but excluding the raw workbook, local file paths, and private source data.
_Avoid_: Raw upload archive, private audit log, browser history

**Catalog Risk Inbox**:
The primary Catalog Change Plan view that separates proposed changes into Safe, Review Required, and Blocking Conflict lanes. Safe changes begin selected, high-risk changes wait for explicit selection, and blocking conflicts cannot be selected or bypassed.
_Avoid_: Unsorted change list, all-selected import, hidden conflict

**Catalog Change Detail Table**:
The expandable dense old-to-new table behind the Catalog Risk Inbox. It shows Product SKU or Order SKU, risk state, changed field, source, previous value, proposed value, and affected work without replacing the risk-first entry view.
_Avoid_: Primary spreadsheet-like screen, raw workbook rows, summary without field evidence

**Built-in Product Catalog**:
The released SKU, origin, carton, pallet, weight, and confirmed Order SKU Alias facts compiled from the existing raw product-information workbook and embedded independently in Supply and FBA. It is the normal product source and requires neither an extra maintenance worksheet nor a routine browser upload.
_Avoid_: Browser product database, ProductMasterTable, cross-site fetch

**Temporary Product Override**:
A same-origin browser copy of raw public packaging facts used only to test an unpublished product-data change. It never becomes the maintained source and expires when the Built-in Product Catalog version changes.
_Avoid_: Shared Product Catalog, daily product upload, master data

**Product Catalog Release**:
One versioned operation that plans public old-to-new product changes, generates the Supply and FBA Built-in Product Catalog artifacts, verifies both repositories, and—when publishing is explicitly requested—coordinates both deployments and live checks. The first version keeps website uploads preview-only and performs publication through the existing local release workflow without storing GitHub credentials in either public site. The two sites remain independently embedded at runtime.
_Avoid_: Two manual catalog updates, runtime cross-site synchronization, workbook upload

## Shared visual system

**FBA Visual System**:
The authoritative visual language for both FBA and Supply: Apple-system typography, clean light-gray page background, translucent sticky header, Jasper brand block, segmented navigation, white cards, controls, spacing, radii, shadows, focus states, and responsive behavior. FBA owns the versioned source; Supply receives a generated, hash-checked local projection and never fetches runtime styles across sites.
_Avoid_: Similar colors, manually synchronized CSS, runtime FBA stylesheet dependency

**Supply Workspace Shell**:
The FBA Visual System applied to Supply's existing single-page workflow. Its header uses the FBA brand and shell while its tabs remain Data, Today's Recommendations, Orders, SKU Decision Tree, and Data Analysis; changing tabs does not reload the page or discard workspace state.
_Avoid_: FBA multi-page navigation, shared cross-product menu, Supply legacy hero

**Dense Workflow Variant**:
The compact table and order-generator expression of the FBA Visual System. It uses the same typography, surfaces, controls, colors, and interaction states with reduced row spacing so operational SKU density remains usable.
_Avoid_: Unstyled legacy table, oversized FBA upload-card spacing, separate design language
