# Automation in the Lorcana Engine

This folder contains the code that lets the engine play a turn by itself.

The short version:

- The bot does **not** "think" like a person.
- It does **not** learn by itself.
- It works by:
  1. figuring out who is supposed to act,
  2. listing the legal things that player can do,
  3. sorting those legal options with a strategy,
  4. trying the best option first.

If you are new here, that is the main idea to keep in mind.

## What "automation" means here

In this codebase, "automation" means "have the engine choose and perform a legal move without a human clicking through every step."

That includes small setup choices, like:

- choosing who goes first,
- deciding what to mulligan,

and also normal in-game choices, like:

- questing,
- challenging,
- putting a card into the inkwell,
- playing a card,
- activating an ability,
- resolving pending prompts.

## The basic flow

The core flow lives in [planner.ts](./planner.ts), with helper files around it.

### 1. Find the current actor

Before the bot can do anything, it has to know **which player is supposed to act right now**.

On a player-scoped engine, that is easy: the actor is the player attached to that engine surface.

On the server-scoped engine, [actor-resolution.ts](./actor-resolution.ts) checks a few things in order:

- an active pending effect chooser,
- the next bag resolver,
- the choose-first-player prompt,
- the mulligan order,
- the current priority holder.

If none of those tell us who should act, automation stops and reports that it could not resolve an actor.

### 2. Build legal candidates

Once the actor is known, the planner builds a list of **candidates**.

A candidate is just "one legal thing the bot could try next."

Examples:

- "choose player one to go first"
- "mulligan these two cards"
- "put this card into the inkwell"
- "quest with this character"
- "challenge with this attacker into that defender"
- "play this card using sing"
- "resolve this pending effect and choose target X"

The supported candidate families are defined in [types.ts](./types.ts), and the planner currently knows how to build candidates for:

- `chooseWhoGoesFirst`
- `alterHand`
- `resolveBag`
- `resolveEffect`
- `putCardIntoInkwell`
- `playCard`
- `activateAbility`
- `quest`
- `challenge`
- `moveCharacterToLocation`

Important detail: the planner does not blindly invent moves. It still runs each candidate through engine validation before keeping it.

### 3. Rank the candidates with a strategy

After that, the candidates are sorted by a **strategy**.

A strategy does not create new moves. It only says:

"Out of these already-legal moves, which one should come first?"

The registry for selectable strategies is in [strategy-registry.ts](./strategy-registry.ts).

The engine currently ships with these strategies:

| Strategy id                          | What it tries to do                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `deck-aware-lore-race` **(default)** | Uses deck color, matchup, and per-card weighting for mulligans, inking, and target selection.                              |
| `best-deck-aware-lore-race`          | Fair-information candidate that uses typed deck dossiers and card rules without hidden opponent deck access.               |
| `best-deck-aware-oracle-lore-race`   | Oracle variant that allows full opponent deck knowledge through the typed rule system.                                     |
| `board-control-lore-race`            | Still wants lore, but is more willing to trade tempo to remove opposing threats and spend ink on stable board development. |
| `aggressive-board-control-lore-race` | Pushes harder into value trades and mutual-banish challenges to break opposing boards.                                     |

The main ranking logic for the default strategy lives in [deck-aware-strategy.ts](./deck-aware-strategy.ts), with shared family heuristics in [strategy/](./strategy/). The board-control and aggressive-board-control variants use [default-strategy.ts](./default-strategy.ts).

### 4. Try the candidates in order

When you call `takeAutomatedAction`, the engine tries the sorted candidates one by one.

- If the first one succeeds, it stops there.
- If one fails during execution, it tries the next one.
- By default, it will stop after 3 failed execution attempts.
- If nothing succeeds, it falls back to `passTurn`.
- If even `passTurn` fails, it falls back to `concede`.

That execution behavior is also handled in [planner.ts](./planner.ts).

## What the current strategies actually prefer

The current strategies are simple and very code-driven. They are not hidden behind magic.

Here are the big ideas in the current default behavior:

### Setup choices

- When choosing who goes first, the bot prefers choosing itself.
- During mulligan, it builds three plans:
  - keep everything,
  - a "structural mulligan" that throws back expensive or non-inkable cards,
  - mulligan the full hand.
- If the opening hand already looks playable enough, the default strategy leans toward keeping it.

### Questing

- Quest candidates are ranked higher when the character has more lore.

### Playing cards

- Simpler plays are preferred over more complicated plays.
- The default lore-race strategy tends to like stronger card development that still pushes tempo.
- The board-control strategy is more willing to spend current ink on a clean permanent play instead of just inking and passing.

### Inking

- The bot prefers inking duplicate cards first.
- After that, it usually prefers lower-cost cards.
- If cost is tied, it tends to prefer inking lower-lore cards.

### Challenging

- The bot likes challenges more when they remove an opposing lore threat.
- It likes them even more when the defender is banished and the attacker survives.
- The board-control strategy is more willing than the default strategy to challenge before questing when the opponent's board is becoming dangerous.

### Activated abilities

- Simpler ability uses are preferred over more complicated ones.
- The planner can also build legal cost combinations for abilities that ask you to exert, banish, or discard cards.

## What the planner can and cannot handle today

The planner is intentionally bounded. That is a good thing.

Without limits, some effects would explode into too many target combinations and become slow or impossible to reason about.

### Things it handles well today

- regular legal move listing,
- target selection when the target pool is still reasonably small,
- optional yes/no choices,
- single choice branches,
- card play modes like standard play, free play, shift, sing, and sing together,
- ability costs that require specific cards to be exerted, banished, or discarded.

### Things it currently skips or limits

Today the planner will skip some shapes on purpose and record a diagnostic instead of guessing.

Examples include:

- "name a card" prompts when no named-card candidates can be built,
- ordered destination choices that are outside the scry planner,
- very large target pools or too many combinations,
- simultaneous multi-choice branching on a single residual surface (`choiceCount > 1`),
- some unusually complex multi-step play patterns.

**Nested "you may" trees** (optional inside optional / sequence of mays, e.g. Pocahontas & Meeko WELCOME RETURN, Julieta SIGNATURE RECIPE) are **supported** by planning only the **immediate** decision surface. The engine peels later mays into subsequent bag/pending items; the next automated action resolves them separately. The planner does **not** require one candidate to encode the entire multi-may tree.

**Dual-arm conditionals** (`then` + `else`, e.g. Buzz/Woody "choose both if another Toy") are **not** peeled into the true branch up front. The residual stays a conditional so the engine can evaluate the live arm at resolve time.

There is another practical limit too: search caps.

Those caps live in [types.ts](./types.ts) and are used by the planner to keep target pools, target combinations, choice counts, singer combinations, and pending items inside a safe search budget.

So if a move is technically legal but creates too many combinations, the planner may skip it for now instead of trying to brute-force everything.

## Planned search AI specification and authorities

This section is the canonical implementation plan for adding search-based Lorcana AI.
It records both the planned behavior and the authority for that behavior so future work
does not invent a parallel hidden-information model.

No search AI implementation should bypass the existing planner, rule engine, validation,
serialization, deadlock handling, strategy registry, or match harness.

### Authority order

When sources disagree, use this order:

1. **Current official Disney Lorcana Comprehensive Rules** for Lorcana game rules,
   zone visibility, revealed information, and card-state semantics.
2. **Existing Lorcana engine behavior** for legal actions, resolution, serialization,
   stable candidate identity, and execution.
3. **Existing TCG search implementations in this repository**, especially Cyberpunk,
   for Monte Carlo, MCTS, rollout, search budgets, pruning, and tree reuse.
4. **OpenSpiel imperfect-information contracts** for information-state resampling and
   IS-MCTS semantics.
5. **Mature external card-game implementations** only for implementation patterns that
   are still missing locally.
6. Write custom behavior only for the smallest Lorcana-specific adapter that remains.

The current Lorcana rules document at the time this plan was recorded is
**Comprehensive Rules 2.2.0, effective July 9, 2026**. The
[official Lorcana Resources page](https://www.disneylorcana.com/en-US/play) remains
the update authority; do not permanently treat version 2.2.0 as immutable.

Pinned rules reference:
[Disney Lorcana Comprehensive Rules 2.2.0](https://files.disneylorcana.com/Comprehensive-Rules_2.2.0-EN.pdf).

### 1. Visibility and information-state mapping

Do not invent a new Lorcana public/private-zone model. Map the engine to the official
rules in section 7.

| Lorcana information | Search-AI treatment | Rules authority |
| --- | --- | --- |
| Play zone, faceup cards | Public and fixed during determinization | 7.1.2.1, 7.4.2 |
| Facedown cards in Play | Private identity; count remains observable | 7.4.2.1 |
| Discard | Public and fixed | 7.1.2.1, 7.6.2 |
| Bag / triggered abilities | Public game state; preserve current resolution state | 7.1.2.1, 7.7 |
| Own hand | Private to its owner but visible to that owner; identity fixed for that observer | 7.3.2 |
| Opponent hand | Identity hidden; hand count observable | 7.3.2 |
| Deck | Identity/order hidden except information explicitly made known by rules/effects; deck count observable | 7.2.2-7.2.3 |
| Inkwell | Identity hidden, including from its owner; count and card status remain observable | 7.5.4 |
| Temporarily revealed part of a private zone | Treat only the revealed portion as public for as long as the rules/effect reveal it | 7.1.3 |
| Known top/bottom ordering created from faceup cards | Preserve the known ordering constraint | 7.2.3 |

The information projection must represent **identity visibility separately from zone
membership and public status**. A card may be in a normally public zone while facedown
and therefore private, or in a private zone while temporarily revealed.

Do not infer remembered card identities unless that knowledge is already represented by
the engine's public/reveal history or information surface. The adapter translates
existing knowledge; it does not create a new memory system.

### 2. Fair and oracle information policies

Keep the existing Lorcana strategy information-policy boundary authoritative.

- **Fair/public search** must not inspect the actual hidden opponent hand, hidden
  opponent deck order, or hidden opponent deck composition merely because the
  authoritative engine stores those values.
- **Oracle search** may use hidden opponent information only where the existing
  strategy policy explicitly grants that access.
- The determinizer must receive its candidate hidden-card universe through the
  information policy. It must not silently read raw authoritative opponent zones.
- If fair mode lacks a lawful candidate universe for a hidden identity, the search
  layer must surface that limitation or use a policy-approved unknown-card model.
  It must not fall back to peeking at the true hidden state.

This boundary takes precedence over search strength.

### 3. Determinization adapter

The Lorcana-specific adapter should implement the semantics of OpenSpiel
`resample_from_infostate(player_id, rng)`: produce another complete game state that is
consistent with everything the observing player is allowed to know.

Primary specification:
[OpenSpiel resample_from_infostate](https://openspiel.readthedocs.io/en/stable/api_reference/state_resample_from_infostate.html).

Reference implementation:
[OpenSpiel IS-MCTS](https://github.com/google-deepmind/open_spiel/blob/master/open_spiel/python/algorithms/ismcts.py).

Planned adapter behavior:

1. Clone the authoritative Lorcana state using the existing Lorcana
   serialization/snapshot path.
2. Freeze public state and the observer's legally visible private information.
3. Freeze engine-tracked reveal/known-order constraints.
4. Collect only policy-approved, observer-unknown card identities into hidden pools.
5. Preserve every hidden zone's observable size and every publicly observable card
   status.
6. Resample hidden identities and unknown deck order with the supplied seeded RNG.
7. Restore a valid complete Lorcana server/state using existing engine loaders.
8. Run the normal Lorcana planner and rule engine on that sampled world. Do not create
   search-only move legality or resolution rules.

The first implementation should use uniform sampling unless evidence shows a belief
model is necessary.

### 4. Determinization invariants

Every sampled world must pass all of these checks:

- the observer's information projection before and after sampling is identical;
- all public zones and public game state are unchanged;
- own legally visible cards are unchanged;
- observable hand/deck/inkwell/facedown counts are unchanged;
- known top/bottom ordering constraints are preserved;
- public ready/exerted and similar visible status is unchanged;
- the sampled state loads through the normal Lorcana engine;
- normal engine validation remains the only authority for legal actions;
- repeated sampling with the same seed is deterministic;
- different seeds may produce different hidden worlds while preserving the same
  information state.

The key acceptance invariant follows the OpenSpiel pattern:

`informationState(original, observer) === informationState(sampled, observer)`

The exact Lorcana representation of `informationState` should reuse an existing
filtered/projected view if one already provides the required visibility. Do not create
a second information model without first proving the existing one is insufficient.

### 5. Search algorithms: reuse, do not rewrite

Search algorithms are not Lorcana-specific work.

Reuse or extract the existing implementations under:

- `submodules/cyberpunk/packages/engine/src/automation/search/monte-carlo.ts`
- `submodules/cyberpunk/packages/engine/src/automation/search/mcts.ts`
- `submodules/cyberpunk/packages/engine/src/automation/search/shared.ts`
- `submodules/cyberpunk/packages/engine/src/automation/search/tactical.ts`
- `submodules/cyberpunk/packages/engine/src/automation/strategies/random.ts`
- `submodules/agnostic-simulator/packages/bot-core/src/deadlock.ts`
- `submodules/agnostic-simulator/packages/bot-core/src/hash.ts`
- `submodules/agnostic-simulator/packages/bot-core/src/statistics.ts`

Existing Cyberpunk mechanics already cover:

- flat Monte Carlo;
- UCB1 MCTS;
- seeded rollout streams;
- random and greedy rollout policies;
- max rollout steps;
- depth/node/branch budgets;
- branch ranking and cutoff;
- repeated-state detection;
- tree/subtree reuse.

Do not implement Lorcana-specific versions of these algorithms unless a concrete
interface incompatibility cannot be solved by a thin adapter.

### 6. Initial search path

The smallest planned search AI is:

1. existing Lorcana planner enumerates legal candidates;
2. determinization adapter samples a policy-legal hidden world;
3. existing Monte Carlo/MCTS logic evaluates candidates by simulation;
4. rollout actions go back through the normal Lorcana planner/engine;
5. terminal winner/draw determines the rollout result;
6. the chosen search action maps back to the live planner candidate through existing
   stable candidate identity.

The first version should prefer terminal rollout outcomes over a new Lorcana board
evaluation function. A Lorcana-specific evaluator is not required until measured
runtime or rollout quality demonstrates that terminal rollouts are inadequate.

### 7. Opponent belief model

A learned or heuristic opponent-hand belief model is **not an MVP requirement**.

Start with hard facts plus uniform sampling. Only add weighted beliefs if benchmark
evidence shows a useful gain.

Reference pattern:
[Tartaluca21/scopa-engine-ai - determinize.py](https://github.com/Tartaluca21/scopa-engine-ai/blob/main/search/determinize.py)
and
[belief.py](https://github.com/Tartaluca21/scopa-engine-ai/blob/main/cognitive/belief.py).

That project keeps hard facts exact and optionally uses a probability vector to weight
opponent-hand sampling. The belief layer must remain optional and must never turn
private authoritative state into fair-AI knowledge.

### 8. CCG implementation references

These are implementation references, not Lorcana rule authorities.

| Source | Useful pattern | License / copying rule |
| --- | --- | --- |
| [OpenSpiel](https://github.com/google-deepmind/open_spiel) | Information-state resampling, IS-MCTS, chance sampling | Apache-2.0. Copy only with required attribution/license handling; prefer adapting the contract. |
| [scopa-engine-ai](https://github.com/Tartaluca21/scopa-engine-ai) | Small determinizer, optional belief-weighted hidden-hand sampling | MIT |
| [EXEC_MAGICA](https://github.com/kuzmenkoff/exec_magica_engine) | CCG IS-MCTS, per-iteration hidden hand/deck re-determinization, stable public action keys | MIT |
| [peter1591/hearthstone-ai](https://github.com/peter1591/hearthstone-ai) | Player-scoped board view, opponent hand identities hidden, unknown-card sets restored into complete simulation states | Repository license was not verified during this audit. Use as a design reference only unless licensing is verified before copying code. |
| [AlphaStone](https://github.com/sirmammingtonham/alphastone) | Simple Hearthstone `opponent hand + deck -> shuffle -> split` determinization | Repository-level license was not verified during this audit. Use as a design reference only unless licensing is verified before copying code. |

Useful Hearthstone design-reference files:

- `peter1591/hearthstone-ai/engine/include/engine/view/BoardRefView.h`
- `peter1591/hearthstone-ai/engine/include/engine/view/ReducedBoardView-impl.h`
- `peter1591/hearthstone-ai/engine/include/engine/view/board_view/Player.h`
- `peter1591/hearthstone-ai/engine/include/engine/view/board_view/StateRestorer.h`
- `sirmammingtonham/alphastone/alphabot/ISMCTS.py`

### 9. Explicit non-goals for the first implementation

Do not add these merely because a stronger AI might eventually use them:

- a new Lorcana legal-action generator;
- a new Lorcana action executor;
- a second serialization format;
- a second deadlock/cycle system;
- a new generic MCTS implementation;
- a Lorcana board-value formula with hand-tuned weights;
- a learned opponent model;
- reinforcement learning;
- neural-network policy/value models;
- hidden-state access in fair mode;
- speculative shared abstractions before reuse is demonstrated.

Any later addition to this list requires benchmark evidence for why the existing path is
insufficient and a source audit before custom implementation.

## Search AI implementation correspondence table

This table maps the planned search-AI specification to existing code and records the
smallest remaining implementation seam. Treat it as the implementation checklist.
Do not replace an existing row with a parallel subsystem.

| Planned capability | Existing Lorcana / shared implementation | Reuse authority | Remaining work | Status |
| --- | --- | --- | --- | --- |
| Player-scoped visible board | `LorcanaServer.getAutomatedPlanningBoardForPlayer()` delegates to runtime `getProjectedBoardView({ role: "player", playerID })`; `types/projected-board.ts` already carries hidden cards, zone membership, counts, public face state, winner/status and pending work | Lorcana engine + official Lorcana visibility rules | Verify the current projection exactly covers search invariants for hand, deck, inkwell, facedown Play cards and temporary reveals. Extend the existing projection only if a concrete rule case is missing | **Reuse / verify** |
| Zone visibility rules | Existing projected-card model has `hidden?`, `definitionId?`, `publicFaceState?`, zone IDs and observable counts | Lorcana Comprehensive Rules section 7 | No second zone model. Map official visibility into the existing projection | **Reuse** |
| Fair vs oracle access boundary | `StrategyInformationPolicy`, `AutomatedActionOpponentKnowledgeSource`, strategy registry `informationPolicy: "public" | Lorcana automation types + registry | Search entry point must propagate the selected policy into determinization; fair mode must never read raw hidden opponent zones | **Reuse + thin wiring** |
| Legal action enumeration | `automation/planner.ts` and `enumerateAutomatedActionsForCurrentActor()` | Lorcana planner | None for search. Search consumes planner candidates | **Reuse** |
| Candidate validation | Planner adapter `validateCandidate()` delegates to normal engine validation | Lorcana engine | None | **Reuse** |
| Candidate execution | `takeAutomatedActionWithAdapter()`, `executeAutomatedActionCandidate()`, normal server move execution | Lorcana engine | Search-selected candidate must be sent back through this path | **Reuse** |
| Stable action identity | `AutomatedActionCandidateSummary.stableKey` plus planner candidate keying/deduplication | Lorcana automation | Verify that the same public action receives the same stable identity across determinizations; add only a thin canonical-key adapter if sampled instance IDs make this fail | **Reuse / verify** |
| Authoritative state snapshot | `getLorcanaServerAuthoritativeSnapshot()` and authoritative state helpers in `serialization.ts` | Lorcana serialization | None | **Reuse** |
| State restoration / search fork primitive | `loadLorcanaServerAuthoritativeSnapshot()`, `loadLorcanaServerAuthoritativeState()` | Lorcana serialization | Add a small search-facing fork helper only if no existing caller already packages snapshot + card catalog restoration | **Thin adapter** |
| Current actor resolution | `resolveServerCurrentActor()`, `getCurrentActorId()` | Lorcana automation | None | **Reuse** |
| Terminal state / winner / draw | `LorcanaProjectedBoardView.status`, `winner`, `reason`; normal engine state is authoritative | Lorcana engine | Search adapter converts terminal state into rollout outcome only | **Thin adapter** |
| Repeated-state / deadlock detection | `createAutomatedActionRepeatedStateTracker()`; shared `createSemanticCycleDetector()` in bot-core; existing state fingerprints | Lorcana automation + bot-core | Use one of the existing detectors inside rollouts. Do not create a local Map-based duplicate | **Reuse** |
| Seeded search randomness | Cyberpunk Monte Carlo uses `createSeededBotRandom()`; deterministic seed streams already exist in bot-core | bot-core + Cyberpunk search | Pass Lorcana/search seeds through the same mechanism | **Reuse + thin wiring** |
| Flat Monte Carlo | `cyberpunk/.../search/monte-carlo.ts` | Existing repository implementation | Adapt engine/candidate/fork interfaces. Do not rewrite the algorithm | **Reuse + adapter** |
| UCB1 MCTS | `cyberpunk/.../search/mcts.ts` | Existing repository implementation | Adapt engine/candidate/fork interfaces. Preserve existing budget and rollout semantics | **Reuse + adapter** |
| Rollout loop | `cyberpunk/.../search/shared.ts::runRollout()` | Existing repository implementation | Route each Lorcana rollout step through the existing current-actor planner | **Reuse + adapter** |
| Rollout policy | Cyberpunk `randomStrategy` / `greedyStrategy`; Lorcana registered strategies already provide deterministic baseline play | Existing repository implementation | Prefer an existing Lorcana strategy first; if stochastic diversity is required, adapt the existing random-policy pattern rather than inventing a new policy | **Reuse / adapt** |
| Search budgets | Cyberpunk MC/MCTS rollout limits and tactical depth/node/branch budgets; Lorcana planner already has candidate search caps | Existing repository implementation | Expose only the relevant existing knobs at the Lorcana search boundary | **Reuse** |
| Tree/subtree reuse | Cyberpunk MCTS persistent `WeakMap` cache and resume logic | Existing repository implementation | Reuse only after Lorcana state identity is verified suitable; otherwise disable cache initially rather than inventing another cache | **Reuse / verify** |
| Hidden-state determinization contract | No Lorcana implementation yet | OpenSpiel `resample_from_infostate`; OpenSpiel card-game implementations; EXEC_MAGICA; Scopa | Implement the smallest Lorcana-specific adapter that freezes observer-known information and resamples only policy-approved unknown information | **Missing thin adapter** |
| Hidden-zone redistribution mechanics | No Lorcana search adapter yet | OpenSpiel Gin Rummy; EXEC_MAGICA; AlphaStone design pattern | Preserve observable zone counts, shuffle only permitted hidden identities/order, then restore via normal Lorcana state loaders | **Missing thin adapter** |
| Information-state equality check | Existing projected player board is the likely comparison surface; state fingerprint tooling already exists | OpenSpiel post-resample information-state invariant | Define a canonical comparison from the existing player projection and assert original == sampled for the observer | **Small verification helper** |
| Fair hidden-card candidate universe | Current fair strategy deliberately avoids hidden opponent deck access; no lawful generic hidden-card universe is currently exposed | Existing information policy takes precedence; OpenSpiel requires a valid information-state sampler | **Do not use the true opponent deck as a fallback.** Determine whether the match format supplies an open decklist or an existing public prior/model. If neither exists, fair search must report/limit this capability until a policy-approved model is selected | **Unresolved specification dependency** |
| Oracle hidden-card universe | Authoritative state and full opponent deck data already exist and oracle strategies explicitly permit hidden opponent knowledge | Existing oracle information policy | Feed authoritative hidden identities only when oracle mode is selected | **Reuse + thin wiring** |
| Opponent belief weighting | No MVP implementation required | Scopa belief/determinizer pattern | Start uniform. Add only after benchmark evidence; never derive fair beliefs from raw authoritative hidden state | **Deferred** |
| Chance / unknown deck order | Authoritative engine already resolves draws from deck state; sampled world can carry a sampled order | OpenSpiel chance sampling + EXEC_MAGICA per-world deck shuffle | Sample unknown order during determinization and let the normal Lorcana engine execute draws/effects | **Missing only in determinizer** |
| Board-value evaluator | No generic Lorcana search evaluator required for MVP | Terminal-rollout plan; Cyberpunk evaluator is game-specific and must not be copied | None initially. Add only if terminal rollout is too slow/noisy and after a separate source audit | **Deferred** |
| AI-vs-AI evaluation harness | Existing simulator strategy suite, deterministic seeds, traces, benchmark artifacts, promotion gates | Lorcana simulator | Add search strategies to the existing harness when implementation exists | **Reuse** |
| Decision diagnostics / traces | Existing `AutomatedActionDecisionTrace`, board snapshots, ordered candidates, execution attempts and diagnostics | Lorcana automation | Add search-specific statistics only if required; keep existing trace as the primary decision record | **Reuse** |
| Unsupported planner decision shapes | Existing diagnostics explicitly surface unsupported/overflow shapes | Lorcana planner | Search must not bypass these with a second resolver. Improve planner separately when a concrete unsupported shape blocks search | **Existing limitation, separate track** |

### Minimal new-code boundary

If the table above remains valid after implementation-time verification, the first
search-AI version should add only these Lorcana-specific seams:

1. **Information-state determinizer**: authoritative snapshot in, observer + information
   policy + seeded RNG in, valid sampled Lorcana state/server out.
2. **Search engine adapter**: exposes the existing Lorcana planner/server through the
   engine operations required by the reused Monte Carlo/MCTS implementation
   (fork, enumerate, apply, terminal outcome).
3. **Information-state invariant helper**: compares the existing player-scoped
   projection before and after determinization.
4. **Candidate-key bridge only if necessary**: only if existing `stableKey` identity
   is not stable across sampled worlds.

Everything else in the first search AI should come from existing Lorcana, Cyberpunk,
bot-core, or cited external specifications.

### Implementation stop conditions

Stop and re-audit instead of inventing behavior if any of these occurs:

- the existing projected player view leaks a hidden identity or omits a legally known
  identity needed by the information-state invariant;
- fair mode has no policy-approved candidate universe for hidden cards;
- sampled instance IDs make existing stable candidate identity unreliable;
- the current snapshot/load path cannot produce an isolated search world;
- a reused Cyberpunk search assumption does not hold for Lorcana prompts/effects.

A stop condition is a specification gap to research, not permission to add an
unreferenced workaround.

## The most useful files in this folder

If you want to understand or change automation, these are the best starting points:

| File                                                     | Why it matters                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [types.ts](./types.ts)                                   | Shared types for candidates, strategies, traces, diagnostics, and limits.               |
| [planner.ts](./planner.ts)                               | The main planner and executor. This is where legal candidates are built and tried.      |
| [deck-aware-strategy.ts](./deck-aware-strategy.ts)       | The current default strategy. 5-axis scoring with deck profiles and card rules.         |
| [deck-profile.ts](./deck-profile.ts)                     | Color pair profiles, role weights, opening plans, and matchup modifiers.                |
| [strategy-data/](./strategy-data/)                       | Card-level rules and matchup plans that feed into the deck-aware strategy.              |
| [default-strategy.ts](./default-strategy.ts)             | Legacy ranking rules for board-control and aggressive-board-control variants.           |
| [strategy-registry.ts](./strategy-registry.ts)           | The list of strategies that can be selected by id.                                      |
| [strategy/](./strategy/)                                 | Shared family evaluators (challenge, quest, play-card, etc.) and the strategy composer. |
| [actor-resolution.ts](./actor-resolution.ts)             | How the server figures out which player should act.                                     |
| [target-priority.ts](./target-priority.ts)               | Scores card targets for effects based on role weights and board state.                  |
| [move-adapter.ts](./move-adapter.ts)                     | Turns a chosen candidate into a real engine move request.                               |
| [decision-trace.ts](./decision-trace.ts)                 | Builds stable snapshots and fingerprints for debugging and analysis.                    |
| [automated-actions.test.ts](./automated-actions.test.ts) | Best place to see concrete examples of current behavior.                                |
| [REFINEMENT_PROMPT.md](./REFINEMENT_PROMPT.md)           | Complete guide for improving strategy quality with tests and simulations.               |

## How to improve an existing strategy

If you want to make a strategy better, the safest path is:

1. Read [deck-aware-strategy.ts](./deck-aware-strategy.ts) and the [strategy/](./strategy/) family evaluators to understand the current ordering.
2. Add or update focused tests in [automated-actions.test.ts](./automated-actions.test.ts).
3. Use decision traces to see what the bot considered, what it picked, and what failed.
4. Make a small, explainable change.
5. Compare the result in deterministic AI-vs-AI simulations.

The most common improvement is adding card-level rules in [strategy-data/cards.ts](./strategy-data/cards.ts) or matchup plans in [strategy-data/matchups.ts](./strategy-data/matchups.ts). These tune the deck-aware strategy without touching evaluator code. See [REFINEMENT_PROMPT.md](./REFINEMENT_PROMPT.md) Section 7 for a guide.

There is already project guidance pointing in that direction:

- [REFINEMENT_PROMPT.md](./REFINEMENT_PROMPT.md)
- [strategy-iteration.ts](../../lorcana-simulator/src/testing/ai-strategy/strategy-iteration.ts)
- [strategy-suite.ts](../../lorcana-simulator/src/testing/ai-strategy/strategy-suite.ts)
- [simulate-game.test.ts](../../lorcana-simulator/src/testing/ai-strategy/simulate-game.test.ts)

Good improvements are usually:

- small,
- easy to explain,
- covered by tests,
- measured against a baseline.

Less good improvements are usually:

- giant rewrites,
- "it feels smarter now" changes with no tests,
- changes that make traces harder to read,
- changes that only help one flashy case but make many normal turns worse.

## How to create your own strategy

The nice part is that you do **not** need to rewrite the planner.

Most of the time, you only need a new strategy that reorders the candidates differently.

At the type level, a strategy looks like this:

```ts
import type { AutomatedActionStrategy } from "./types";

export const myStrategy: AutomatedActionStrategy = {
  name: "my-strategy",
  summarizeCandidates(_context, candidates) {
    return candidates.map((candidate, index) => ({
      candidate,
      family: candidate.family,
      heuristics: [],
      stableKey: `${candidate.family}-${index}`,
    }));
  },
};
```

That example does nothing yet. It just returns the candidates unchanged with empty heuristics.

To make it useful:

1. Copy the candidate array.
2. Sort it in a deterministic way.
3. Return ordered candidate summaries with stable keys and heuristics.

Practical tips:

- Start small. Reorder one family of moves first.
- Keep tie-breakers deterministic so tests stay stable.
- Do not create illegal moves in the strategy. The planner already gave you legal candidates.
- Use the `context` object when you need board state, phase, turn number, or actor information.
- If you want rich trace output like the default strategy has, mirror the summary pattern used in [default-strategy.ts](./default-strategy.ts).

After you create the strategy:

1. export it,
2. register it in [strategy-registry.ts](./strategy-registry.ts),
3. add tests,
4. run simulation comparisons before treating it as better.

## How to debug "why did the bot do that?"

The best answer is usually the decision trace.

The trace system records things like:

- who the actor was,
- a board snapshot,
- the ordered candidate list,
- ranking hints for the default strategy,
- execution attempts,
- fallback behavior,
- diagnostics for skipped or rejected options.

That trace support is described in [types.ts](./types.ts) and built in [decision-trace.ts](./decision-trace.ts) and [planner.ts](./planner.ts).

If a bot choice looks strange, check:

1. whether the move you expected was even enumerated,
2. whether it was rejected by validation,
3. whether it was skipped because the shape is unsupported,
4. where it landed in the sorted list,
5. whether a higher-ranked move failed and forced fallback behavior.

## A simple mental model

If you remember nothing else, remember this:

> The bot is a legal move lister plus a sorter.

That is the system.

It first finds legal options, then a strategy decides the order.

## Glossary

### Actor

The player who is supposed to make the next choice right now.

### Bag

A queue-like place where triggered ability work can wait until it is ready to resolve.

### Candidate

One legal action the bot could try next.

### Diagnostic

A note explaining why something was skipped, rejected, or resolved a certain way.

### Fallback

What the engine does if none of the planned candidates succeed. Right now that means trying `passTurn`, then `concede`.

### Heuristic

A simple ranking rule. Example: "prefer a challenge that banishes a high-lore defender."

### Lore race

A strategy style that mainly tries to win by pushing lore quickly instead of spending many turns trading pieces.

### Mulligan

The opening-hand step where you choose which cards to throw back and redraw.

### Pending effect

A game effect that is waiting for a player choice before it can finish.

### Priority

The game's current right to act. In simple terms: which player gets to do something next when no earlier prompt is blocking.

### Search cap

A safety limit that stops automation from trying too many targets or combinations at once.

### Strategy

The code that sorts legal candidates from "try this first" to "try this later."

### Trace

A debugging record of what the bot saw, what it ranked, what it tried, and what happened.
