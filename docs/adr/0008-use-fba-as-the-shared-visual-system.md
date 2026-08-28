# Use FBA as the shared visual system

FBA is the authoritative visual reference for both applications. Supply will adopt the complete FBA Visual System while retaining its existing single-page information architecture, five Supply-specific workspaces, calculations, local persistence, and no-reload workspace switching.

## Consequences

- Supply uses the FBA translucent sticky header, Jasper brand block, segmented navigation, light-gray page background, Apple-system typography, cards, controls, spacing, radii, shadows, focus states, and responsive behavior.
- Supply removes its current blue-purple background gradients and legacy hero treatment rather than merely recoloring them.
- The Supply header tabs remain Data, Today's Recommendations, Orders, SKU Decision Tree, and Data Analysis. They keep same-page switching so workspace inputs, H10 text, and Order Draft state are not discarded.
- Normal Supply content uses FBA spacing; data tables and the order generator use a Dense Workflow Variant to preserve operational row density.
- Coverage indicators retain their vivid yellow, green, and red business-status colors while their container, typography, and translucency follow the FBA Visual System.
- FBA's value-privacy night mode and door animation are not copied because Supply has no equivalent privacy workflow.
- Public Supply and Supply Boss use the same visual components. Boss differs only where its authentication layer requires it.
- FBA owns one versioned visual-system source. The release workflow generates a local Supply projection and verifies its version and content hash; Supply never loads CSS from the FBA site at runtime.
- Implementation follows an approved interactive prototype, then applies the system to all five Supply workspaces and Supply Boss in one visual release.
- The approved product-update composition uses the prototype's Variant C Catalog Risk Inbox as the primary view and Variant A Catalog Change Detail Table as the expandable evidence view. The guided stepper prototype is not adopted.
- Visual acceptance covers every Supply workspace plus the Boss sign-in layer at 1440 x 900 desktop and 390 x 844 mobile sizes, including keyboard focus and reduced-motion behavior.
