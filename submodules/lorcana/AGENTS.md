# Lorcana Submodule

This submodule owns Lorcana cards, engine behavior, the legacy simulator,
server adapters, replay tooling, and Lorcana-specific agent skills.

Before rules-facing work, load
`.agents/skills/lorcana-rules/references/glossary.md` and then
`.agents/skills/lorcana-rules/SKILL.md`. For card work, also use the local
`lorcana-find-card`, `lorcana-cards`, and `lorcana-test-generation` skills.

## Ownership

- `packages/lorcana/lorcana-engine/src` - engine moves, resolutions, effects,
  prompts, automation, and tests.
- `packages/lorcana/lorcana-cards/src` - card definitions and generated exports.
- `packages/lorcana/lorcana-types/src` - shared Lorcana types.
- `packages/lorcana/lorcana-simulator/src` - Svelte simulator, devtools,
  fixtures, and local player flows.
- `packages/lorcana/lorcana-server-adapter/src` - platform runtime adapter.
- `packages/tools/replay-cli/src` - replay download and inspection tooling.

Shared platform and multi-game simulator exposure belongs in sibling
workspaces. Map Lorcana concepts through `../agnostic-simulator` contracts;
keep Lorcana rules and engine semantics here.

## AI Development

The canonical search-AI implementation plan, hidden-information model, source
authorities, and external reference list live in
`packages/lorcana/lorcana-engine/src/automation/README.md` under
**Planned search AI specification and authorities**. Read that section before
adding search, determinization, belief, rollout, or information-state code.

Use a missing-capability inventory before writing AI code. Do not broadly
re-audit the repository when the required gap is already known.

For each missing AI capability, search in this order:

1. existing Lorcana implementation in this repository;
2. existing implementation in another game workspace in this repository;
3. existing game-agnostic/shared implementation in this repository;
4. a mature public external implementation or specification with compatible
   licensing;
5. only then, the smallest custom implementation needed to bridge the gap.

Reuse existing legal-action generation, action execution, serialization,
deadlock handling, match harnesses, and rule resolution when they already
exist. Do not create parallel versions of those systems for AI experiments.

Keep adapters thin: translate existing state/action boundaries and delegate
behavior to existing engines or search implementations. Do not duplicate card
rules, targeting rules, game-state semantics, or heuristic logic inside an
adapter unless a verified missing capability requires it.

Do not move an AI abstraction into a shared package merely because it might be
reusable. Promote it only after more than one game path demonstrates the same
shared contract in practice.

When a custom AI component is unavoidable, keep it isolated, deterministic
where practical, and covered by the smallest focused test that proves the new
behavior without retesting existing engine rules.

## Triage

- Start player reports from the exact replay/game id and turn when available.
- Use `replay-debugging` for production evidence before changing behavior.
- For card-specific reports, locate the exact definition and similar cards
  before changing shared engine primitives.
- Treat unavailable or malformed replay data as an evidence limit; do not infer
  missing events.
- For simulator repros, reuse the registry at
  `packages/lorcana/lorcana-simulator/src/lib/features/simulator-devtools/fixtures/regressions/`
  and its `/tests/regressions` route instead of creating parallel fixtures.

## Validation

Run the narrow card, engine, adapter, or simulator check first. From this
workspace use `vp check`, `vp test`, or `pnpm run ci-check` as appropriate.
From the integration root use `bun run ci:lorcana:check`.
