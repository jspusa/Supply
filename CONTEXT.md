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
An order whose Order SKU does not begin with `7`, grouped under either Taiwan or Vietnam according to the Product SKU's standard factory.
_Avoid_: Main order, normal factory row

**Subcontract Order**:
An order whose Order SKU begins with `7`. All Subcontract Orders belong to the same subcontract vendor and retain the Product SKU's demand and packaging specifications.
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
