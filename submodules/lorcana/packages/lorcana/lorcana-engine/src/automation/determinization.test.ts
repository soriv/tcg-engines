import { describe, expect, it } from "bun:test";
import type { CardCatalog, PlayerId } from "#core";

import type { LorcanaProjectedBoardView } from "../types";
import type { LorcanaServerAuthoritativeSnapshot } from "../serialization";
import {
  assertSameLorcanaInformationState,
  createLorcanaInformationStateKey,
  determinizeLorcanaSnapshot,
} from "./determinization";

const P1 = "player_one" as PlayerId;
const P2 = "player_two" as PlayerId;

function createCatalog(ids: readonly string[]): CardCatalog {
  const known = new Set(ids);
  return {
    ref: "test-catalog",
    get: () => undefined,
    has: (definitionId) => known.has(definitionId),
  };
}

function createSnapshot(): LorcanaServerAuthoritativeSnapshot {
  const zoneCards = {
    ["hand:" + P1]: ["p1-hand"],
    ["deck:" + P1]: ["p1-deck-a", "p1-deck-b"],
    ["inkwell:" + P1]: ["p1-ink"],
    ["play:" + P1]: [],
    ["discard:" + P1]: [],
    ["limbo:" + P1]: [],
    ["hand:" + P2]: ["p2-hand"],
    ["deck:" + P2]: ["p2-deck-a", "p2-deck-b"],
    ["inkwell:" + P2]: ["p2-ink"],
    ["play:" + P2]: [],
    ["discard:" + P2]: [],
    ["limbo:" + P2]: [],
  };

  const cardIndex = Object.fromEntries(
    Object.entries(zoneCards).flatMap(([zoneKey, cardIds]) =>
      cardIds.map((cardId, index) => [
        cardId,
        {
          zoneKey,
          index,
          ownerID: zoneKey.endsWith(String(P1)) ? P1 : P2,
          controllerID: zoneKey.endsWith(String(P1)) ? P1 : P2,
        },
      ]),
    ),
  );

  return {
    state: {
      G: {},
      ctx: {
        _stateID: 7,
        gameID: "game",
        matchID: "match",
        playerIds: [P1, P2],
        zones: {
          public: { zoneSummaries: {} },
          reveals: { active: [] },
          private: {
            zoneCards,
            cardIndex,
            cardMeta: {
              "p1-ink": { state: "exerted" },
              "p2-ink": { state: "ready" },
            },
          },
        },
      },
    } as unknown as LorcanaServerAuthoritativeSnapshot["state"],
    cardsMaps: {
      cardInstances: {
        "p1-hand": "visible-p1-hand",
        "p1-deck-a": "real-p1-deck-a",
        "p1-deck-b": "real-p1-deck-b",
        "p1-ink": "real-p1-ink",
        "p2-hand": "real-p2-hand",
        "p2-deck-a": "real-p2-deck-a",
        "p2-deck-b": "real-p2-deck-b",
        "p2-ink": "real-p2-ink",
      },
      owners: {
        [P1]: ["p1-hand", "p1-deck-a", "p1-deck-b", "p1-ink"],
        [P2]: ["p2-hand", "p2-deck-a", "p2-deck-b", "p2-ink"],
      },
    },
  };
}

function createObserverBoard(): LorcanaProjectedBoardView {
  return {
    gameID: "game",
    matchID: "match",
    stateID: 7,
    playerOrder: [P1, P2],
    turnPlayer: P1,
    priorityPlayer: P1,
    turnNumber: 1,
    pendingMulligan: [],
    status: "playing",
    winner: null,
    reason: null,
    timerView: { serverTimestamp: 123 },
    players: {
      [P1]: {
        lore: 0,
        canAddCardToInkwell: true,
        handCount: 1,
        deckCount: 2,
        hand: ["p1-hand"],
        play: [],
        inkwell: ["p1-ink"],
        discard: [],
      },
      [P2]: {
        lore: 0,
        canAddCardToInkwell: false,
        handCount: 1,
        deckCount: 2,
        hand: ["hidden:hand:player_two:0"],
        play: [],
        inkwell: ["p2-ink"],
        discard: [],
      },
    },
    cards: {
      "p1-hand": {
        id: "p1-hand",
        ownerId: P1,
        zone: "hand",
        zoneIndex: 0,
        definitionId: "visible-p1-hand",
        fullName: "Visible card",
      },
      "p1-ink": {
        id: "p1-ink",
        ownerId: P1,
        zone: "inkwell",
        zoneIndex: 0,
        hidden: true,
        exerted: true,
      },
      "hidden:hand:player_two:0": {
        id: "hidden:hand:player_two:0",
        ownerId: P2,
        zone: "hand",
        zoneIndex: 0,
        hidden: true,
      },
      "p2-ink": {
        id: "p2-ink",
        ownerId: P2,
        zone: "inkwell",
        zoneIndex: 0,
        hidden: true,
      },
    },
    activeEffects: [],
    pendingEffects: [],
    bagEffects: [],
  };
}

function sequenceRng(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

describe("determinizeLorcanaSnapshot", () => {
  it("uses only supplied fair priors for hidden identities and leaves the source untouched", () => {
    const source = createSnapshot();
    const sourceBefore = structuredClone(source);
    const result = determinizeLorcanaSnapshot({
      snapshot: source,
      observerBoard: createObserverBoard(),
      observerId: P1,
      informationPolicy: "fair",
      cardCatalog: createCatalog([
        "p1-a",
        "p1-b",
        "p1-c",
        "p2-a",
        "p2-b",
        "p2-c",
        "p2-d",
      ]),
      hiddenDefinitionIdsByPlayer: {
        [P1]: ["p1-a", "p1-b", "p1-c"],
        [P2]: ["p2-a", "p2-b", "p2-c", "p2-d"],
      },
      rng: sequenceRng([0.2, 0.8, 0.4, 0.6, 0.1, 0.9]),
    });

    expect(source).toEqual(sourceBefore);
    expect(source.cardsMaps.cardInstances["p2-hand"]).toBe("real-p2-hand");
    expect(result.snapshot.cardsMaps.cardInstances["p2-hand"]).toMatch(/^p2-/);
    expect(result.snapshot.cardsMaps.cardInstances["p2-hand"]).not.toBe("real-p2-hand");
    expect(result.snapshot.cardsMaps.cardInstances["p1-hand"]).toBe("visible-p1-hand");
    expect(result.resampledCardIdsByPlayer[P1]).toHaveLength(3);
    expect(result.resampledCardIdsByPlayer[P2]).toHaveLength(4);
  });

  it("preserves revealed deck positions while shuffling unknown deck cards", () => {
    const source = createSnapshot();
    source.state.ctx.zones.reveals.active.push({
      revealID: "reveal-top",
      cardIDs: ["p2-deck-b"],
      visibleTo: [P1],
    });
    const board = createObserverBoard();
    board.players[P2]!.deckTop = "p2-deck-b";
    board.cards["p2-deck-b"] = {
      id: "p2-deck-b",
      ownerId: P2,
      zone: "deck",
      zoneIndex: 1,
      definitionId: "known-top",
      fullName: "Known top",
    };

    const result = determinizeLorcanaSnapshot({
      snapshot: source,
      observerBoard: board,
      observerId: P1,
      informationPolicy: "fair",
      cardCatalog: createCatalog([
        "p1-a",
        "p1-b",
        "p1-c",
        "p2-a",
        "p2-b",
        "p2-c",
      ]),
      hiddenDefinitionIdsByPlayer: {
        [P1]: ["p1-a", "p1-b", "p1-c"],
        [P2]: ["p2-a", "p2-b", "p2-c"],
      },
      rng: sequenceRng([0, 0, 0, 0]),
    });

    expect(result.snapshot.state.ctx.zones.private.zoneCards["deck:" + P2]?.at(-1)).toBe(
      "p2-deck-b",
    );
    expect(result.snapshot.cardsMaps.cardInstances["p2-deck-b"]).toBe("real-p2-deck-b");
    expect(result.preservedKnownCardIds).toContain("p2-deck-b");
  });

  it("is deterministic for the same random stream and can vary across different streams", () => {
    const options = {
      snapshot: createSnapshot(),
      observerBoard: createObserverBoard(),
      observerId: P1,
      informationPolicy: "fair" as const,
      cardCatalog: createCatalog([
        "p1-a",
        "p1-b",
        "p1-c",
        "p2-a",
        "p2-b",
        "p2-c",
        "p2-d",
      ]),
      hiddenDefinitionIdsByPlayer: {
        [P1]: ["p1-a", "p1-b", "p1-c"],
        [P2]: ["p2-a", "p2-b", "p2-c", "p2-d"],
      },
    };

    const first = determinizeLorcanaSnapshot({
      ...options,
      rng: sequenceRng([0, 0, 0, 0, 0, 0, 0]),
    });
    const repeated = determinizeLorcanaSnapshot({
      ...options,
      rng: sequenceRng([0, 0, 0, 0, 0, 0, 0]),
    });
    const different = determinizeLorcanaSnapshot({
      ...options,
      rng: sequenceRng([0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99]),
    });

    expect(repeated.snapshot).toEqual(first.snapshot);
    expect(different.snapshot).not.toEqual(first.snapshot);
  });

  it("requires an exact policy-approved prior in fair mode", () => {
    expect(() =>
      determinizeLorcanaSnapshot({
        snapshot: createSnapshot(),
        observerBoard: createObserverBoard(),
        observerId: P1,
        informationPolicy: "fair",
        cardCatalog: createCatalog(["only-one"]),
        hiddenDefinitionIdsByPlayer: {
          [P1]: ["only-one"],
          [P2]: ["only-one"],
        },
        rng: () => 0.5,
      }),
    ).toThrow("LORCANA_DETERMINIZATION_PRIOR_SIZE_MISMATCH");
  });

  it("keeps authoritative identities in oracle mode while still resampling unknown deck order", () => {
    const source = createSnapshot();
    const result = determinizeLorcanaSnapshot({
      snapshot: source,
      observerBoard: createObserverBoard(),
      observerId: P1,
      informationPolicy: "oracle",
      cardCatalog: createCatalog([]),
      rng: () => 0,
    });

    expect(result.snapshot.cardsMaps.cardInstances).toEqual(source.cardsMaps.cardInstances);
    expect(result.resampledCardIdsByPlayer).toEqual({});
    expect(result.snapshot.state.ctx.zones.private.zoneCards["deck:" + P1]).not.toEqual(
      source.state.ctx.zones.private.zoneCards["deck:" + P1],
    );
  });
});

describe("Lorcana determinization information-state invariant", () => {
  it("ignores hidden identity-derived fields but preserves public hidden-card state", () => {
    const before = createObserverBoard();
    const after = structuredClone(before);

    Object.assign(after.cards["p1-ink"]!, {
      definitionId: "different-hidden-definition",
      fullName: "Different hidden card",
      cardType: "character",
      strength: 9,
      lore: 3,
    });

    expect(createLorcanaInformationStateKey(after)).toBe(
      createLorcanaInformationStateKey(before),
    );
    expect(() => assertSameLorcanaInformationState(before, after)).not.toThrow();

    after.cards["p1-ink"]!.exerted = false;
    expect(() => assertSameLorcanaInformationState(before, after)).toThrow(
      "LORCANA_DETERMINIZATION_INFORMATION_STATE_MISMATCH",
    );
  });
});
