# Pin packaging versions to operational work

Supply will remain the canonical owner of the complete Product Catalog while product changes may originate from either Supply or FBA as sparse, reviewed updates. A confirmed FBA-first Packaging Specification Version becomes the New-Order Packaging Default, but each edited Supply Order Draft row and each FBA inbound or expiry row keeps an explicit Packaging Assignment so later catalog changes cannot silently recalculate existing work.

## Consequences

- Missing imported fields preserve complete catalog facts; clearing a fact requires an explicit action.
- Unpublished versions may be corrected, but released or assigned versions are immutable and corrections create a new version.
- Product Catalog changes require one reviewed old-to-new confirmation; conflicting complete source rows block publication instead of resolving by row order.
- Packaging belongs to the Order SKU actually used. Switching to an approved Order SKU Alias previews and confirms its quantity and pallet effects before replacing the assignment.
- A newer default or correction leaves pinned work unchanged. Reassignment is explicit and names every affected Order Draft or FBA inbound or expiry row.
- Origin and Standard Factory remain separate facts. A Standard Factory change affects new grouping, while existing pinned rows require review instead of moving silently.
- Retired products remain readable by historical work but are excluded from new suggestions and orders; released catalog identities and packaging versions are not physically deleted.
- Supply and FBA expose the same Product Update Entry. Its Catalog Change Plan allows per-SKU selection, starts safe changes selected, leaves conflicts and high-risk changes unselected, and requires one final confirmation.
- The confirmation view starts with a concise changed-SKU old-to-new summary and allows the user to expand full field details.
- Existing touched Supply draft rows retain their values and become review-required during migration; untouched suggestions may adopt the new default. Existing FBA inbound rows retain Historical Imported Packaging when no released version can be resolved.
- Publication uses an optimistic catalog-version lock. If another release changes the baseline, the stale plan is blocked and must be regenerated rather than overwriting newer facts.
- Public website uploads are preview-only in the first release. The existing local release workflow performs the authorized GitHub publication, and no browser GitHub credential is introduced.
- Every successful release retains a compact Catalog Change Record without the raw workbook, local source paths, or private data.
- Supply and FBA remain independent runtime projections; generated FBA catalog files are not a second writable source.
- A partial two-site deployment is a persistent Catalog Alignment failure shown in both sites and in the release result: retry the failed projection and block the next catalog release until both sites agree rather than rolling back automatically. The first release does not add email or messaging alerts.
