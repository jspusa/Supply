# Supply Planning

This context turns local inventory, open-order, and Helium 10 inputs into replenishment decisions and purchase-order drafts. It keeps demand ownership, purchasing identity, planning risk, and order grouping explicit.

## Products and orders

**Product SKU**:
The canonical SKU that owns demand, inventory, catalog specifications, and coverage calculations.
_Avoid_: Order SKU, alias SKU

**Order SKU**:
The SKU printed on the purchase order for a Product SKU. It may be the Product SKU itself or an approved 7-prefixed equivalent.
_Avoid_: Product SKU, display SKU

**Standard Order**:
An order whose Order SKU does not begin with `7`.
_Avoid_: Main order, normal factory row

**Subcontract Order**:
An order whose Order SKU begins with `7`. It is displayed separately from Standard Orders and grouped by the Order SKU prefix while retaining the Product SKU's demand and packaging specifications.
_Avoid_: Standard Order, alias-only display

## Demand and coverage

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

**Whole-Pallet Suggestion**:
The normal suggested pallet quantity expressed as a whole number. When no whole number can satisfy both the 180-day target and 365-day ceiling, the suggestion may use a fractional pallet instead.
_Avoid_: Half-pallet rule, arbitrary decimal

**Workspace Snapshot**:
The raw uploaded source files, pasted H10 text, metadata, and small workspace preferences retained in the current browser so the workspace can be reconstructed after refresh.
_Avoid_: Cloud backup, exported order
