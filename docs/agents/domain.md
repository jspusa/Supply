# Domain Docs

How engineering skills consume this repository's domain documentation.

## Before exploring, read these

- `CONTEXT.md` at the repository root, or
- `CONTEXT-MAP.md` at the repository root if it exists, and
- ADRs under `docs/adr/` that apply to the area being changed.

If these files do not exist, proceed silently. `/domain-modeling`, reached through `/grill-with-docs` or `/improve-codebase-architecture`, creates them lazily when terminology or decisions are resolved.

## File structure

This repository uses a single context:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When an issue, proposal, test, or implementation names a domain concept, use the term defined in `CONTEXT.md`. Do not drift to synonyms that the glossary explicitly avoids.

If a needed term is missing, reconsider whether new language is necessary or record the gap for `/domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the decision.
