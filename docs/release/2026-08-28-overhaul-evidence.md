# Supply workspace overhaul release evidence

Date: 2026-08-28

Parent specification: [#53 — Rebuild Supply as a persistent, risk-aware three-group workspace](https://github.com/jspusa/Supply/issues/53)

Release revision: **PENDING — fill with the deployed full `main` commit SHA**
Production verification: **PENDING — no live result is claimed by this document**

## Purpose and evidence rules

This document maps every user story in #53 to an inspectable proof location. It distinguishes implemented local proof from release proof:

- `LOCAL-COVERED`: a deterministic unit, contract, browser, or artifact test contains a direct assertion for the story. Stories 1–95 have this local acceptance evidence; it does not by itself mean the final release command has passed.
- `PENDING-LIVE`: the verifier exists, but the exact deployed revision has not yet been observed on GitHub Pages.
- Proof locators use `path:line`; each numbered line identifies the relevant test declaration or shared browser-helper section in this release candidate.
- The final release is successful only after the commands and live checklist below are completed against the final revision.

## Release scope

| Child issue | Scope |
| --- | --- |
| [#54](https://github.com/jspusa/Supply/issues/54) | Deterministic build and release safety spine |
| [#55](https://github.com/jspusa/Supply/issues/55) | Shared replenishment and coverage planner |
| [#56](https://github.com/jspusa/Supply/issues/56) | Planning Velocity and Velocity Risk |
| [#57](https://github.com/jspusa/Supply/issues/57) | Whole-Pallet Suggestions and compact quantities |
| [#58](https://github.com/jspusa/Supply/issues/58) | Product/Order SKU identity, three Order Groups, and workbook export |
| [#59](https://github.com/jspusa/Supply/issues/59) | Versioned local Workspace Snapshot and Boss persistence adapter |
| [#60](https://github.com/jspusa/Supply/issues/60) | Focused five-workspace public and Boss interface |
| [#61](https://github.com/jspusa/Supply/issues/61) | Full acceptance, deployment, exact-revision, and live verification |

The release retains the static GitHub Pages architecture. Product SKU owns demand and catalog truth; Order SKU is the purchasing identity. Orders have exactly three operational groups: Taiwan, Vietnam, and one Subcontract vendor. The normal quantity policy is the smallest whole pallet that reaches 180 days without exceeding 365 days, with the specified narrow fractional exception.

## Privacy boundary

- The public workspace stores raw files and H10 text only in this browser through IndexedDB; preferences remain in local storage. It does not add a public upload service. See `docs/adr/0002-keep-public-workspace-local.md` and `tests/workspace-snapshot-page.test.mjs:42`.
- Boss retains its authenticated cloud adapter and session boundary. The browser acceptance test uses a mock service and fixture token; it does not use real credentials or mutate production. See `tests/browser/boss-acceptance.spec.mjs:79` and `tests/browser/boss-security.spec.mjs:11`.
- Committed browser inputs are synthetic/sanitized. Desktop inventory, order, and H10 source contents are not committed, copied into fixtures, or included in the Pages artifact.
- The site artifact verifier rejects repository-only files, unexpected files, symlinks, and high-confidence credential material. See `tests/site-artifact.test.mjs:119`, `tests/site-artifact.test.mjs:238`, and `tests/site-artifact.test.mjs:254`.

## Exact verification commands

Run from the repository root with Node.js selected by `.node-version`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
npm run verify
npm audit
git diff --check
```

`npm run verify` is the required local gate. It runs unit/contract tests, builds the allowlisted `dist`, verifies its manifest and references, and exercises that exact artifact in deterministic Chromium.

Working-tree verification observed before the release commit:

- Node unit/contract suite: 207 passing.
- Deterministic build and distribution manifest: 14 of 14 runtime files verified.
- Deterministic Chromium suite: 9 passing.
- Locked vendor and local live-browser contract checks: passing.

These results describe the final shared working tree at documentation time. The checklist remains `PENDING` until the same gate is tied to the final full commit SHA and the deployed artifact.

Coverage summary: **95 of 96 stories have direct local acceptance evidence.** Story 96 has local verifier implementation and deterministic verifier tests, but its exact production evidence remains `PENDING-LIVE` until deployment.

After the Pages workflow deploys the final `main` revision, download the matching `supply-release-manifest-<FULL_MAIN_SHA>` workflow artifact and run:

```sh
SUPPLY_LIVE_BASE_URL=https://jspusa.github.io/Supply/ \
SUPPLY_EXPECTED_REVISION=<FULL_MAIN_SHA> \
SUPPLY_RELEASE_MANIFEST=<PATH_TO_DOWNLOADED_RELEASE_JSON> \
npm run verify:live

SUPPLY_LIVE_BASE_URL=https://jspusa.github.io/Supply/ \
SUPPLY_EXPECTED_REVISION=<FULL_MAIN_SHA> \
npm run verify:live:browser
```

The first live command compares the exact manifest schema, revision, allowlisted runtime set, and SHA-256 hash of every deployed file. The second opens revision-tagged public, legacy-hash, and unauthenticated Boss entrypoints in Chromium; it is read-only and rejects any Boss mutation request.

## User-story evidence map

| # | Domain | Child | Expected | Proof kind | Proof locator | Observed assertion | Status |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | Snapshot | #59 | Uploaded sources survive refresh. | Browser | `tests/browser/public-acceptance.spec.mjs:30` | Three sanitized source blobs restore after reload and produce the same draft/planning state. | LOCAL-COVERED |
| 2 | Snapshot | #59 | Pasted H10 text survives refresh. | Browser | `tests/browser/public-acceptance.spec.mjs:30` | H10 text is saved, restored, and remains until confirmed Clear. | LOCAL-COVERED |
| 3 | Snapshot | #59 | Restored sources parse automatically. | Contract + browser | `tests/workspace-snapshot-page.test.mjs:138`; `tests/browser/public-acceptance.spec.mjs:30` | Restore calls the same classifier once; planning is re-created without another build action. | LOCAL-COVERED |
| 4 | Snapshot | #59 | Show honest filenames/times while native pickers stay empty. | Browser | `tests/browser/public-acceptance.spec.mjs:30` | Chromium asserts the exact saved timestamp, localized restored-time text, all three restored filenames, browser-security explanation, and empty native file inputs. | LOCAL-COVERED |
| 5 | Snapshot | #59 | Replace one source without erasing others. | Unit + browser | `tests/workspace-snapshot.test.mjs:222`; `tests/browser/public-acceptance.spec.mjs:30` | Replacing JSP retains JAM, Amazon inventory, H10 text, history, and draft. | LOCAL-COVERED |
| 6 | Snapshot | #59 | Restore all valid parts of a partial snapshot. | Unit | `tests/workspace-snapshot.test.mjs:490` | Valid files and inputs are returned while missing/unreadable roles become issues. | LOCAL-COVERED |
| 7 | Snapshot | #59 | Identify the unreadable source to replace. | Unit + contract | `tests/workspace-snapshot.test.mjs:533`; `tests/workspace-snapshot-page.test.mjs:195` | Issue includes exact role and filename; UI message names the replacement. | LOCAL-COVERED |
| 8 | Snapshot | #59 | Report storage failure and preserve current memory state. | Unit + contract | `tests/workspace-snapshot.test.mjs:401`; `tests/planning-velocity-page.test.mjs:110` | Quota, denied, and unavailable outcomes are explicit and never reported as saved. | LOCAL-COVERED |
| 9 | Snapshot | #59 | Corrupt/future data fails safely and app still opens. | Unit + contract | `tests/workspace-snapshot.test.mjs:401`; `tests/workspace-snapshot-page.test.mjs:171` | Corrupt/future records are preserved, not overwritten, and yield safe status. | LOCAL-COVERED |
| 10 | Snapshot | #59 | Migrate valid legacy Order Draft data. | Unit | `tests/order-draft-state.test.mjs:240` | Legacy VN/TW/Others rows migrate without rounding fractions or dropping repair rows. | LOCAL-COVERED |
| 11 | Snapshot | #59 | One confirmed Clear removes the exact workspace state. | Unit + browser | `tests/workspace-snapshot.test.mjs:560`; `tests/browser/public-acceptance.spec.mjs:30`; `tests/browser/boss-acceptance.spec.mjs:79` | Cancel is non-destructive; confirm clears inputs, draft, history, preferences, and reload state while preserving Boss auth. | LOCAL-COVERED |
| 12 | Privacy | #59 | Public raw Workspace Snapshot remains local-only. | ADR + contract + browser | `docs/adr/0002-keep-public-workspace-local.md`; `tests/workspace-snapshot-page.test.mjs:42`; `tests/browser/public-acceptance.spec.mjs:30` | Public adapter uses IndexedDB/localStorage and sanitized acceptance sees no unexpected network requests. | LOCAL-COVERED |
| 13 | Snapshot | #59 | Repeated restore is idempotent. | Unit + browser | `tests/workspace-snapshot.test.mjs:490`; `tests/browser/public-acceptance.spec.mjs:30` | Repeated restore does not write another record or duplicate rows/history. | LOCAL-COVERED |
| 14 | Velocity history | #59/#56 | Keep one sample/SKU/day for latest 28 days. | Unit + browser | `tests/planning-velocity.test.mjs:205`; `tests/planning-velocity.test.mjs:294`; `tests/browser/public-acceptance.spec.mjs:30` | Same-day sample is replaced, retention is exactly 28 dates, and reload leaves history unchanged. | LOCAL-COVERED |
| 15 | Boss persistence | #59 | Preserve authenticated Boss persistence/authorization. | Contract + browser | `tests/workspace-snapshot-page.test.mjs:42`; `tests/browser/boss-acceptance.spec.mjs:79`; `tests/browser/boss-security.spec.mjs:11` | Mocked login, Bearer authorization, cloud GET/POST/DELETE, reload, and auth-preserving Clear are exercised without production mutation. | LOCAL-COVERED |
| 16 | Velocity | #56 | Show H10 Source separately from Planning Velocity. | Contract | `tests/planning-velocity-page.test.mjs:36` | Both labels/fields are required and downstream calculations use Planning Velocity. | LOCAL-COVERED |
| 17 | Velocity | #56 | Preserve conflicting H10 values as a range. | Unit | `tests/planning-velocity.test.mjs:31` | Sanitized conflicting evidence retains the full range, min/max, and ordered observations. | LOCAL-COVERED |
| 18 | Velocity | #56 | Highest valid H10 duplicate is a candidate. | Unit | `tests/planning-velocity.test.mjs:66` | Duplicate observations remain; candidate is the highest valid value. | LOCAL-COVERED |
| 19 | Velocity | #56 | Sellable/DOS is a candidate. | Unit | `tests/planning-velocity.test.mjs:159` | A valid 60/10 signal raises Planning Velocity to 6. | LOCAL-COVERED |
| 20 | Velocity | #56 | Hot SKU below 10 receives floor 10. | Unit | `tests/planning-velocity.test.mjs:129` | Hot 9.99 becomes 10 while non-hot 5 remains 5, with explicit reason. | LOCAL-COVERED |
| 21 | Velocity | #56 | Latest-28-day median is a candidate. | Unit | `tests/planning-velocity.test.mjs:205`; `tests/planning-velocity.test.mjs:229` | Median 10 can win and uses the source observation date. | LOCAL-COVERED |
| 22 | Velocity | #56 | Planning Velocity equals highest valid candidate. | Unit | `tests/planning-velocity.test.mjs:31`; `tests/planning-velocity.test.mjs:159`; `tests/planning-velocity.test.mjs:205` | H10, inventory/DOS, floor, and history winners are asserted independently. | LOCAL-COVERED |
| 23 | Velocity risk | #56 | Difference greater than 20% is a risk. | Unit | `tests/planning-velocity.test.mjs:252` | Exactly 20% is not flagged; 20.1% is flagged. | LOCAL-COVERED |
| 24 | Velocity risk | #56 | Zero sellable or DOS at most 7 is a risk. | Unit | `tests/planning-velocity.test.mjs:31`; `tests/planning-velocity.test.mjs:252` | Zero sellable and the 7/7.01-day boundary are asserted. | LOCAL-COVERED |
| 25 | Velocity risk | #56 | More than 40% below median is a risk. | Unit | `tests/planning-velocity.test.mjs:252` | Exactly 40% is not flagged; a 40.1% decline is flagged. | LOCAL-COVERED |
| 26 | Velocity evidence | #56 | Show every increase reason and value. | Unit + contract | `tests/planning-velocity.test.mjs:129`; `tests/planning-velocity-page.test.mjs:195` | Winning evidence and all adjustment messages/values are exposed for rendering/export. | LOCAL-COVERED |
| 27 | Velocity evidence | #56 | Show multiple simultaneous risk reasons. | Unit + contract | `tests/planning-velocity.test.mjs:31`; `tests/planning-velocity-page.test.mjs:195` | Sanitized conflicting evidence carries every applicable reason together; export joins every risk. | LOCAL-COVERED |
| 28 | Velocity wording | #56 | Describe possible underestimation, not proven stockout. | Contract + browser | `tests/planning-velocity-page.test.mjs:36`; `tests/browser/browser-helpers.mjs:404` | Public/Boss copy includes “不代表已證實斷貨”. | LOCAL-COVERED |
| 29 | Velocity validation | #56 | Exclude and report invalid/negative/infinite/nonnumeric candidates. | Unit + contract | `tests/planning-velocity.test.mjs:174`; `tests/planning-velocity-page.test.mjs:49` | Invalid evidence cannot create zero/infinite demand and appears in `ignoredEvidence`. | LOCAL-COVERED |
| 30 | Velocity validation | #56 | No valid evidence means unable to recommend. | Unit + contract | `tests/planning-velocity.test.mjs:174`; `tests/lead-time-plan.test.mjs:263` | Status is `no-valid-candidate`; recommendation and coverage remain unavailable. | LOCAL-COVERED |
| 31 | Planning consistency | #56/#55 | Use Planning Velocity for every downstream decision. | Contract + parity | `tests/planning-velocity-page.test.mjs:36`; `tests/legacy-planning-adapter.test.mjs:55` | Obsolete speed fields are rejected; shared planner receives only Planning Velocity. | LOCAL-COVERED |
| 32 | Velocity workflow | #56/#60 | Surface risks in Today and filter Recommendations. | Unit + contract | `tests/workspace-navigation.test.mjs:113`; `tests/planning-velocity-page.test.mjs:172` | Today selects highest risk; one shared toggle controls table, export, and generator selection. | LOCAL-COVERED |
| 33 | Velocity export | #56 | Export source, planning value, and reasons. | Contract | `tests/planning-velocity-page.test.mjs:195` | Export projection contains source range, Planning Velocity, winner, all reasons, and risks. | LOCAL-COVERED |
| 34 | Velocity identity | #56 | Normalize equivalent SKUs to Product SKU before comparison. | Unit | `tests/planning-velocity.test.mjs:84` | Approved Order SKU evidence from H10, inventory, and history converges into one canonical Product SKU assessment and history stream. | LOCAL-COVERED |
| 35 | Pallet policy | #57 | Smallest whole pallet reaches 180 without exceeding 365. | Unit | `tests/supply-planner.test.mjs:243` | Two pallets is selected as the smallest valid whole-pallet outcome. | LOCAL-COVERED |
| 36 | Pallet controls | #57 | Arrows step exactly 1 and clamp at zero. | Unit + browser | `tests/order-draft-quantity.test.mjs:6`; `tests/order-draft-quantity.test.mjs:17`; `tests/browser/browser-helpers.mjs:404` | Fractional input moves by one full pallet; decrement never becomes negative. | LOCAL-COVERED |
| 37 | Pallet policy | #57 | Existing 180-day coverage suggests zero. | Unit | `tests/supply-planner.test.mjs:274` | At target or already excess, strategy is none and quantity/pallets are zero. | LOCAL-COVERED |
| 38 | Pallet policy | #57 | Fraction only when no whole pallet fits 180–365. | Unit | `tests/supply-planner.test.mjs:259`; `tests/supply-planner.test.mjs:368` | Straddling case uses fractional exception; a whole pallet exactly at 365 remains preferred. | LOCAL-COVERED |
| 39 | Executable quantity | #57 | Fraction derives from smallest physical executable quantity. | Unit | `tests/supply-planner.test.mjs:259`; `tests/supply-planner.test.mjs:343` | Executable increment determines exact quantity before pallet display. | LOCAL-COVERED |
| 40 | Pallet precision | #57 | Display at most two decimals; retain precise calculation. | Unit + browser | `tests/supply-planner.test.mjs:343`; `tests/browser/order-repair.spec.mjs:39` | UI shows 0.33 while stored/exported `1/3` remains exact. | LOCAL-COVERED |
| 41 | Pallet controls | #57 | Manual fractions remain editable; arrows add/subtract 1. | Unit + browser | `tests/order-draft-quantity.test.mjs:6`; `tests/browser/browser-helpers.mjs:404` | Manual 0.5 becomes 1.5; internal authoritative mode remains manual pallets. | LOCAL-COVERED |
| 42 | Catalog repair | #57 | Bad pallet specs disable auto pallets but retain unit guidance. | Unit + adapter | `tests/supply-planner.test.mjs:314`; `tests/lead-time-plan.test.mjs:378` | Quantity guidance remains; pallet value is unavailable and repair warning is visible. | LOCAL-COVERED |
| 43 | Quantity synchronization | #57 | Keep package/secondary/carton/pallet/coverage synchronized. | Unit + browser | `tests/lead-time-plan.test.mjs:424`; `tests/browser/browser-helpers.mjs:404` | Exact fractional metrics recalculate together; pallet and quantity edits update draft/coverage state. | LOCAL-COVERED |
| 44 | Coverage boundary | #57 | Exactly 365 is healthy; only above is red. | Unit + browser | `tests/supply-planner.test.mjs:296`; `tests/browser/browser-helpers.mjs:404` | 365 renders healthy; 366-equivalent renders excess. | LOCAL-COVERED |
| 45 | Coverage color | #57 | Above recommendation is non-red through 365. | Contract | `tests/lead-time-plan.test.mjs:465` | Color derives from displayed coverage boundary, not recommendation comparison. | LOCAL-COVERED |
| 46 | Compact quantity UI | #57/#60 | Stack package and bag/box in one column. | Contract + browser | `tests/lead-time-plan.test.mjs:58`; `tests/browser/browser-helpers.mjs:404` | One vertical quantity group renders labels `包` and `袋`. | LOCAL-COVERED |
| 47 | Compact quantity UI | #57/#60 | Show both stacked values only when both apply. | Contract | `tests/lead-time-plan.test.mjs:70` | Semantic compact markup supports combined and single-value rows without empty controls. | LOCAL-COVERED |
| 48 | Draft controls | #57/#58 | Preserve lock, removal, drag, and group totals. | Unit + browser | `tests/order-draft-state.test.mjs:148`; `tests/lead-time-plan.test.mjs:481`; `tests/browser/browser-helpers.mjs:404` | Lock, remove, independent reorder, persisted order, and three group counts are asserted. | LOCAL-COVERED |
| 49 | SKU identity | #58 | Product SKU owns demand/catalog/coverage. | Unit + artifact | `tests/order-draft-state.test.mjs:61`; `tests/order-workbook-artifact.test.mjs:55` | Row identity stays Product SKU while catalog-derived packaging survives Order SKU changes. | LOCAL-COVERED |
| 50 | SKU identity | #58 | Order SKU is the purchasing code. | Unit + artifact | `tests/order-draft-state.test.mjs:61`; `tests/order-workbook-artifact.test.mjs:55` | Alternate Order SKU is stored and printed in the workbook SKU column. | LOCAL-COVERED |
| 51 | SKU approval | #58 | Only approved equivalents may be selected. | Unit | `tests/order-draft-state.test.mjs:148`; `tests/order-draft-state.test.mjs:337` | Unapproved switches/save/export are rejected or retained as repair-required. | LOCAL-COVERED |
| 52 | Group routing | #58 | Approved 7-prefix switch moves row to Subcontract. | Unit + browser | `tests/order-draft-state.test.mjs:61`; `tests/browser/browser-helpers.mjs:281` | Same row moves immediately and its selected group changes to Subcontract. | LOCAL-COVERED |
| 53 | Group routing | #58 | 7AT/7GT/7VT all share one Subcontract group. | Unit + browser + artifact | `tests/order-draft-state.test.mjs:87`; `tests/browser/browser-helpers.mjs:404`; `tests/order-workbook-artifact.test.mjs:55` | All three prefixes route together and export only to `代工`. | LOCAL-COVERED |
| 54 | Group routing | #58 | Switching back returns to catalog Taiwan/Vietnam. | Unit | `tests/order-draft-state.test.mjs:87` | Product SKU switch restores the catalog standard factory group. | LOCAL-COVERED |
| 55 | Draft preservation | #58 | SKU switch preserves quantity, coverage, lock, specs. | Unit + browser | `tests/order-draft-state.test.mjs:61`; `tests/browser/browser-helpers.mjs:281` | Quantity/lock survive browser movement; Product SKU catalog identity remains unchanged. | LOCAL-COVERED |
| 56 | Draft uniqueness | #58 | One Product SKU exists once across all groups. | Unit | `tests/order-draft-state.test.mjs:61` | State is keyed by Product SKU and atomic switch relocates rather than duplicates. | LOCAL-COVERED |
| 57 | Draft restoration | #58/#59 | Restore identity, quantity, lock, and order exactly. | Browser | `tests/browser/public-acceptance.spec.mjs:30`; `tests/browser/boss-acceptance.spec.mjs:79` | Reloaded draft deep-equals saved state and retains independent group row order. | LOCAL-COVERED |
| 58 | Draft repair | #58 | Preserve invalid saved rows with visible repair warning. | Unit + browser | `tests/order-draft-state.test.mjs:278`; `tests/order-draft-state.test.mjs:337`; `tests/browser/order-repair.spec.mjs:39` | Missing catalog/unapproved identity stays visible, blocks export, and can be removed. | LOCAL-COVERED |
| 59 | Draft ordering | #58 | Keep independent order per group. | Unit + browser | `tests/order-draft-state.test.mjs:115`; `tests/browser/browser-helpers.mjs:404` | Reorder changes only the requested group and survives persistence. | LOCAL-COVERED |
| 60 | Workbook | #58 | Exactly `台灣`, `越南`, `代工` sheets. | Artifact | `tests/order-workbook-artifact.test.mjs:55`; `tests/browser/browser-helpers.mjs:470` | Reopened generated XLSX has exactly those three sheets in order. | LOCAL-COVERED |
| 61 | Workbook routing | #58 | Every 7-prefix exports only to `代工`. | Artifact | `tests/order-workbook-artifact.test.mjs:55`; `tests/browser/browser-helpers.mjs:470` | 7AT, 7GT, and 7VT rows are present only on the Subcontract sheet. | LOCAL-COVERED |
| 62 | Workbook routing | #58 | Standard rows export by Product SKU factory. | Artifact | `tests/order-workbook-artifact.test.mjs:55` | Standard Taiwan and Vietnam rows appear on their catalog factory sheets. | LOCAL-COVERED |
| 63 | Workbook schema | #58 | All sheets and stable headers exist when empty. | Unit + artifact | `tests/order-draft-state.test.mjs:413`; `tests/order-workbook-artifact.test.mjs:55` | Empty projection still emits all sheets/headers; reopened artifact headers match exactly. | LOCAL-COVERED |
| 64 | Workbook truth | #58 | Use Order SKU, but Product SKU description/conversion. | Artifact | `tests/order-workbook-artifact.test.mjs:55`; `tests/browser/browser-helpers.mjs:470` | Alternate codes print while product descriptions, pack types, cartons, and pallets derive from Product SKU. | LOCAL-COVERED |
| 65 | Workbook order | #58 | Worksheet order follows saved within-group order. | Artifact | `tests/order-workbook-artifact.test.mjs:55` | Reordered Subcontract sequence reopens as 7VT, 7AT, 7GT. | LOCAL-COVERED |
| 66 | Focused UI | #60 | Remove the left sidebar. | Contract + browser | `tests/workspace-navigation-page.test.mjs:87`; `tests/browser/browser-helpers.mjs:329` | No sidebar markup remains in public or Boss; real browser count is zero. | LOCAL-COVERED |
| 67 | Focused UI | #60 | Sticky centered five-workspace top navigation. | Contract + browser | `tests/workspace-navigation-page.test.mjs:59`; `tests/browser/browser-helpers.mjs:329` | 資料、今日建議、訂單、SKU 決策樹、資料分析 are shared and all activate. | LOCAL-COVERED |
| 68 | Focused UI | #60 | Show one major workspace at a time. | Unit + browser | `tests/workspace-navigation-page.test.mjs:144`; `tests/browser/browser-helpers.mjs:272` | Exactly one selected tab and one visible workspace panel group are asserted. | LOCAL-COVERED |
| 69 | Focused UI | #60 | Default to Data; keep readiness/risk/next action in 今日建議. | Unit + browser | `tests/workspace-navigation.test.mjs:21`; `tests/browser/public-smoke.spec.mjs:12` | Invalid/empty state resolves to 資料; 今日建議 retains the summary and one action. | LOCAL-COVERED |
| 70 | Navigation | #60 | URL, refresh, Back, and Forward preserve workspace. | Unit + browser | `tests/workspace-navigation.test.mjs:12`; `tests/browser/browser-helpers.mjs:329`; `tests/browser/public-acceptance.spec.mjs:30` | Canonical hashes, browser history, and restored active workspace are asserted. | LOCAL-COVERED |
| 71 | Navigation | #60 | Legacy hashes map to the new workspace. | Unit + browser | `tests/workspace-navigation.test.mjs:29`; `tests/browser/browser-helpers.mjs:329` | `#decisionDashboard` canonicalizes to `#recommendations`. | LOCAL-COVERED |
| 72 | Layout | #60 | Bound long tables and keep headers sticky. | Contract + browser | `tests/workspace-navigation-page.test.mjs:131`; `tests/browser/browser-helpers.mjs:329` | Tables have finite max-height/contained overflow and sticky header CSS. | LOCAL-COVERED |
| 73 | Layout | #60 | Eliminate page horizontal overflow. | Contract + browser | `tests/workspace-navigation-page.test.mjs:87`; `tests/browser/browser-helpers.mjs:329` | Desktop and 390px viewport page width never exceeds viewport. | LOCAL-COVERED |
| 74 | Orders UI | #60/#58 | Use one three-group segmented control. | Contract + browser | `tests/workspace-navigation-page.test.mjs:131`; `tests/browser/browser-helpers.mjs:404` | One radiogroup exposes 越南、台灣、委外 in that order; only the selected table is shown. | LOCAL-COVERED |
| 75 | UI states | #60 | One primary action and concise states in each workspace. | Unit + browser | `tests/workspace-ui.test.mjs:143`; `tests/workspace-ui.test.mjs:187`; `tests/workspace-ui.test.mjs:203`; `tests/browser/public-smoke.spec.mjs:12` | Today has one next action; every other workspace has one designated primary task; public/Boss lifecycle surfaces assert concise loading, restored, empty, warning, success, and storage-error language. | LOCAL-COVERED |
| 76 | Accessibility | #60 | Visible focus and keyboard-operable navigation/controls. | Browser | `tests/browser/workspace-accessibility.spec.mjs:45`; `tests/browser/workspace-accessibility.spec.mjs:89` | Chromium uses only Tab, arrows, Home, End, Enter, and Space to operate workspace navigation, Today action, Order Group radios, and pallet controls while asserting visible focus and saved quantity truth. | LOCAL-COVERED |
| 77 | Responsive UI | #60 | Narrow layout works without a left drawer. | Contract + browser | `tests/workspace-navigation-page.test.mjs:131`; `tests/browser/browser-helpers.mjs:329` | 390px viewport retains navigation and no page-level overflow/sidebar. | LOCAL-COVERED |
| 78 | Motion | #60 | Respect reduced-motion preference. | Browser | `tests/browser/workspace-accessibility.spec.mjs:136` | Chromium emulates reduced motion and asserts matching media state, auto scrolling, collapsed transition/animation timing, and non-smooth workspace scroll behavior. | LOCAL-COVERED |
| 79 | Navigation safety | #60 | Workspace switching never destroys data/draft. | Browser | `tests/browser/public-acceptance.spec.mjs:30`; `tests/browser/boss-acceptance.spec.mjs:79` | Navigation precedes draft creation, export, save, refresh, and exact restored draft comparisons without loss. | LOCAL-COVERED |
| 80 | Entrypoint parity | #60 | Public and Boss share visual language/domain terms. | Shared UI + browser | `tests/workspace-navigation-page.test.mjs:59`; `tests/workspace-navigation-page.test.mjs:160`; `tests/browser/boss-acceptance.spec.mjs:79` | Both load one shared rendered UI and Boss runs the same sanitized planning/order scenario. | LOCAL-COVERED |
| 81 | Architecture | #55 | One shared planner serves public and Boss. | ADR + contract | `docs/adr/0001-share-one-planning-core.md`; `tests/lead-time-plan.test.mjs:168` | Both entrypoints import the same planner module and keep thin adapters. | LOCAL-COVERED |
| 82 | Architecture | #55 | Keep raw parsing outside pure planning. | Unit + contract | `tests/supply-planner.test.mjs:52`; `tests/legacy-planning-adapter.test.mjs:17` | Planner accepts normalized values/as-of date and has no DOM/file parser dependency. | LOCAL-COVERED |
| 83 | Architecture | #56 | One explicit Velocity/Risk interface. | Unit | `tests/planning-velocity.test.mjs:361` | Browser and ESM consumers receive the same frozen Planning Velocity interface. | LOCAL-COVERED |
| 84 | Architecture | #58 | One state model owns switching/grouping/sort/totals/export. | Unit | `tests/order-draft-state.test.mjs:468` | One frozen Order Draft interface exposes commands, group rows, persistence, and workbook projection. | LOCAL-COVERED |
| 85 | Schema safety | #58/#59 | Version and validate Snapshot and Draft schemas. | Unit | `tests/order-draft-state.test.mjs:376`; `tests/workspace-snapshot.test.mjs:401`; `tests/workspace-snapshot-page.test.mjs:290` | Draft v2 and Snapshot v1 reject corrupt/incomplete/future data without unsafe overwrite. | LOCAL-COVERED |
| 86 | Determinism | #55/#59/#61 | Inject storage, clock, and entrypoint adapters. | Unit + browser config | `tests/supply-planner.test.mjs:52`; `tests/workspace-snapshot.test.mjs:635`; `tests/browser/browser-helpers.mjs:22` | As-of date, IndexedDB adapter, and fixed browser clock are explicit; Boss behavior is mocked separately. | LOCAL-COVERED |
| 87 | Product truth | #58 | Preserve catalog and approved mappings. | Contract | `tests/product-data.test.mjs:16`; `tests/order-draft-state.test.mjs:337` | Approved pairs have one source of truth and save/export revalidate them. | LOCAL-COVERED |
| 88 | Static architecture | #54 | Remain native static modules on GitHub Pages. | Artifact | `tests/site-artifact.test.mjs:42`; `tests/site-artifact.test.mjs:146` | Allowlisted build emits static runtime files and verifies every local import/reference. | LOCAL-COVERED |
| 89 | Shared tests | #55/#61 | Assert shared behavior, not copied function equality. | Observable parity | `tests/planning-velocity-page.test.mjs:220`; `tests/workspace-snapshot-page.test.mjs:290`; `tests/workspace-navigation-page.test.mjs:160` | Same inputs produce equal observable planning and both pages consume shared frozen modules/adapters. | LOCAL-COVERED |
| 90 | Acceptance | #61 | Sanitized inputs reach recommendations and workbook rows. | Browser + artifact | `tests/browser/public-acceptance.spec.mjs:30`; `tests/order-workbook-artifact.test.mjs:55` | Sanitized workbooks/text produce five recommendations, three groups, and reopened XLSX rows. | LOCAL-COVERED |
| 91 | Acceptance | #61 | Test refresh in real browser storage. | Browser | `tests/browser/public-acceptance.spec.mjs:30` | Chromium restores IndexedDB blobs, empty native file inputs, exact draft, active workspace, and unchanged history. | LOCAL-COVERED |
| 92 | Acceptance | #61 | Test 7-prefix movement, reload, and `代工`. | Browser | `tests/browser/browser-helpers.mjs:404`; `tests/browser/public-acceptance.spec.mjs:30`; `tests/browser/browser-helpers.mjs:470` | 7AT/7GT/7VT move, drag, persist through reload, and appear in the `代工` worksheet. | LOCAL-COVERED |
| 93 | Acceptance | #61 | Open workbook and verify schema/routing/order/quantity. | Actual artifact | `tests/order-workbook-artifact.test.mjs:55`; `tests/browser/browser-helpers.mjs:470` | Both generated artifacts are reopened with SheetJS and inspected cell-by-cell. | LOCAL-COVERED |
| 94 | Acceptance | #61 | Exercise public/Boss with the same sanitized fixture. | Browser | `tests/browser/public-acceptance.spec.mjs:30`; `tests/browser/boss-acceptance.spec.mjs:79`; `tests/fixtures/sanitized-supply-browser.mjs` | Both scenarios call `createSanitizedSupplyFixture` and assert the same planning/order/workbook outcomes. | LOCAL-COVERED |
| 95 | Release gate | #54/#61 | Required tests block publication. | Workflow + contract | `.github/workflows/deploy-pages.yml`; `tests/deploy-workflow.test.mjs:9`; `tests/browser-gate.test.mjs:13` | PR/main verify uses the exact built artifact; deploy depends on successful verify and then runs post-deploy checks. | LOCAL-COVERED |
| 96 | Live release | #61 | Verify public/Boss against exact deployed revision. | Live verifier | `tests/live-release.test.mjs:57`; `tests/live-browser-smoke.test.mjs:113`; `scripts/verify-live.mjs`; `scripts/verify-live-browser.mjs` | Hash/revision and read-only Chromium verifiers are implemented and bounded; exact production result/revision is not yet recorded. | PENDING-LIVE |

## Private local-file acceptance

Private local files were validated locally and no raw or derived operating data is committed.

## Evidence completeness

Stories 1–95 have direct local acceptance evidence. Story 96 has local verifier implementation and deterministic verifier tests, but exact production evidence remains `PENDING-LIVE` until the exact `main` revision is deployed and both post-deploy verifiers succeed.

## Final release checklist

- [ ] `PENDING` — final clean revision recorded: `<FULL_MAIN_SHA>`.
- [ ] `PENDING` — `npm run verify` passed on that exact revision.
- [ ] `PENDING` — `npm audit` and `git diff --check` passed on that exact revision.
- [ ] `PENDING` — Pages workflow uploaded and deployed the exact verified `dist` artifact.
- [ ] `PENDING` — live `release.json` reports `<FULL_MAIN_SHA>` and matches the downloaded manifest schema/file list.
- [ ] `PENDING` — every live runtime SHA-256 matches the verified artifact.
- [ ] `PENDING` — public URL `https://jspusa.github.io/Supply/#today` opens the canonical focused workspace.
- [ ] `PENDING` — legacy URL `https://jspusa.github.io/Supply/#decisionDashboard` canonicalizes to `#recommendations`.
- [ ] `PENDING` — Boss URL `https://jspusa.github.io/Supply/Boss/#today` shows the unauthenticated gate without a mutation request or credential exposure.
- [ ] `PENDING` — live public/Boss contain no left sidebar, half-pallet control, or copied planner implementation.
- [ ] `PENDING` — post-deploy command output and workflow run URL are attached to #61; the final summary is attached to #53.
