import type { CardCatalog, PlayerId } from "#core";

import type { LorcanaProjectedBoardView } from "../types";
import type { LorcanaServerAuthoritativeSnapshot } from "../serialization";
import type { StrategyInformationPolicy } from "./types";

export type LorcanaHiddenDefinitionPrior = Readonly<
  Partial<Record<PlayerId, readonly string[]>>
>;

export interface LorcanaDeterminizationOptions {
  cardCatalog: CardCatalog;
  hiddenDefinitionIdsByPlayer?: LorcanaHiddenDefinitionPrior;
  informationPolicy: StrategyInformationPolicy;
  observerBoard: LorcanaProjectedBoardView;
  observerId: PlayerId;
  rng: () => number;
  snapshot: LorcanaServerAuthoritativeSnapshot;
}

export interface LorcanaDeterminizationResult {
  preservedKnownCardIds: readonly string[];
  resampledCardIdsByPlayer: Readonly<Partial<Record<PlayerId, readonly string[]>>>;
  snapshot: LorcanaServerAuthoritativeSnapshot;
}

const RESAMPLEABLE_HIDDEN_ZONES = new Set(["deck", "hand", "inkwell", "limbo"]);

function cloneSnapshotForSearch(
  snapshot: LorcanaServerAuthoritativeSnapshot,
): LorcanaServerAuthoritativeSnapshot {
  return {
    state: structuredClone(snapshot.state),
    cardsMaps: {
      cardInstances: { ...snapshot.cardsMaps.cardInstances },
      owners: Object.fromEntries(
        Object.entries(snapshot.cardsMaps.owners).map(([playerId, cardIds]) => [
          playerId,
          [...cardIds],
        ]),
      ),
    },
  };
}

function zoneName(zoneKey: string): string {
  const separator = zoneKey.indexOf(":");
  return separator === -1 ? zoneKey : zoneKey.slice(0, separator);
}

function isRevealVisibleToObserver(
  visibleTo: "all" | string[],
  observerId: PlayerId,
): boolean {
  return visibleTo === "all" || visibleTo.includes(String(observerId));
}

function collectObserverKnownCardIds(
  snapshot: LorcanaServerAuthoritativeSnapshot,
  observerBoard: LorcanaProjectedBoardView,
  observerId: PlayerId,
): {
  knownCardIds: Set<string>;
  revealKnownCardIds: Set<string>;
} {
  const knownCardIds = new Set<string>();
  const revealKnownCardIds = new Set<string>();

  for (const card of Object.values(observerBoard.cards)) {
    const id = String(card.id);
    if (!card.hidden && !id.startsWith("hidden:")) {
      knownCardIds.add(id);
    }
  }

  for (const reveal of snapshot.state.ctx.zones.reveals.active) {
    if (!isRevealVisibleToObserver(reveal.visibleTo, observerId)) {
      continue;
    }

    for (const cardId of reveal.cardIDs) {
      const id = String(cardId);
      knownCardIds.add(id);
      revealKnownCardIds.add(id);
    }
  }

  return { knownCardIds, revealKnownCardIds };
}

function collectResampleableHiddenCardIdsByPlayer(args: {
  snapshot: LorcanaServerAuthoritativeSnapshot;
  knownCardIds: ReadonlySet<string>;
  revealKnownCardIds: ReadonlySet<string>;
}): Partial<Record<PlayerId, string[]>> {
  const { snapshot, knownCardIds, revealKnownCardIds } = args;
  const byPlayer: Partial<Record<PlayerId, Array<{ id: string; order: string }>>> = {};

  for (const [cardId, entry] of Object.entries(snapshot.state.ctx.zones.private.cardIndex)) {
    const zone = zoneName(String(entry.zoneKey));
    const meta = snapshot.state.ctx.zones.private.cardMeta[cardId];
    const isFaceDownInPlay = zone === "play" && meta?.publicFaceState === "faceDown";
    const hiddenZone = RESAMPLEABLE_HIDDEN_ZONES.has(zone) || isFaceDownInPlay;

    if (!hiddenZone) {
      continue;
    }

    const isKnown =
      isFaceDownInPlay ? revealKnownCardIds.has(cardId) : knownCardIds.has(cardId);
    if (isKnown) {
      continue;
    }

    const ownerId = entry.ownerID as PlayerId;
    const index = typeof entry.index === "number" ? entry.index : Number.MAX_SAFE_INTEGER;
    (byPlayer[ownerId] ||= []).push({
      id: cardId,
      order: `${String(entry.zoneKey)}:${String(index).padStart(8, "0")}:${cardId}`,
    });
  }

  return Object.fromEntries(
    Object.entries(byPlayer).map(([playerId, entries]) => [
      playerId,
      (entries ?? []).sort((left, right) => left.order.localeCompare(right.order)).map(({ id }) => id),
    ]),
  ) as Partial<Record<PlayerId, string[]>>;
}

function shuffleInPlace<T>(values: T[], rng: () => number): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const sample = rng();
    if (!Number.isFinite(sample)) {
      throw new Error("LORCANA_DETERMINIZATION_INVALID_RNG: rng must return a finite number");
    }

    const normalized = Math.min(Math.max(sample, 0), 0.9999999999999999);
    const swapIndex = Math.floor(normalized * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex]!, values[index]!];
  }
}

function assignFairHiddenDefinitions(args: {
  cardCatalog: CardCatalog;
  hiddenCardIdsByPlayer: Partial<Record<PlayerId, string[]>>;
  prior: LorcanaHiddenDefinitionPrior | undefined;
  rng: () => number;
  sampled: LorcanaServerAuthoritativeSnapshot;
}): Partial<Record<PlayerId, readonly string[]>> {
  const { cardCatalog, hiddenCardIdsByPlayer, prior, rng, sampled } = args;
  const result: Partial<Record<PlayerId, readonly string[]>> = {};

  for (const [rawPlayerId, hiddenCardIds] of Object.entries(hiddenCardIdsByPlayer)) {
    if (!hiddenCardIds || hiddenCardIds.length === 0) {
      continue;
    }

    const playerId = rawPlayerId as PlayerId;
    const definitionIds = prior?.[playerId];
    if (!definitionIds) {
      throw new Error(
        `LORCANA_DETERMINIZATION_PRIOR_REQUIRED: fair determinization needs ${hiddenCardIds.length} hidden definitions for ${String(playerId)}`,
      );
    }
    if (definitionIds.length !== hiddenCardIds.length) {
      throw new Error(
        `LORCANA_DETERMINIZATION_PRIOR_SIZE_MISMATCH: ${String(playerId)} has ${hiddenCardIds.length} hidden slots but prior supplied ${definitionIds.length} definitions`,
      );
    }

    const sampledDefinitions = [...definitionIds];
    for (const definitionId of sampledDefinitions) {
      if (!cardCatalog.has(definitionId)) {
        throw new Error(
          `LORCANA_DETERMINIZATION_UNKNOWN_DEFINITION: prior references '${definitionId}'`,
        );
      }
    }

    shuffleInPlace(sampledDefinitions, rng);
    hiddenCardIds.forEach((cardId, index) => {
      sampled.cardsMaps.cardInstances[cardId] = sampledDefinitions[index]!;
    });
    result[playerId] = [...hiddenCardIds];
  }

  return result;
}

function shuffleUnknownDeckOrder(args: {
  knownCardIds: ReadonlySet<string>;
  rng: () => number;
  sampled: LorcanaServerAuthoritativeSnapshot;
}): void {
  const { knownCardIds, rng, sampled } = args;

  for (const playerId of sampled.state.ctx.playerIds) {
    const zoneKey = `deck:${String(playerId)}`;
    const deck = sampled.state.ctx.zones.private.zoneCards[zoneKey];
    if (!deck || deck.length < 2) {
      continue;
    }

    const movable = deck.filter((cardId) => !knownCardIds.has(String(cardId)));
    shuffleInPlace(movable, rng);

    let movableIndex = 0;
    for (let index = 0; index < deck.length; index += 1) {
      const current = String(deck[index]);
      if (knownCardIds.has(current)) {
        continue;
      }
      deck[index] = movable[movableIndex++]!;
    }

    for (let index = 0; index < deck.length; index += 1) {
      const cardId = String(deck[index]);
      const entry = sampled.state.ctx.zones.private.cardIndex[cardId];
      if (entry) {
        entry.index = index;
      }
    }
  }
}

/**
 * OpenSpiel-style information-state determinization for Lorcana.
 *
 * Fair mode never derives hidden identities from the authoritative definition map.
 * Callers must supply one policy-approved definition per hidden slot (for example,
 * from the tournament-meta prior). Oracle mode keeps authoritative hidden identities.
 *
 * Both modes resample unknown deck order while preserving card positions that are
 * currently known to the observer through the projected view or an active reveal.
 */
export function determinizeLorcanaSnapshot(
  options: LorcanaDeterminizationOptions,
): LorcanaDeterminizationResult {
  const { snapshot, observerBoard, observerId, informationPolicy, rng, cardCatalog } = options;
  const sampled = cloneSnapshotForSearch(snapshot);
  const { knownCardIds, revealKnownCardIds } = collectObserverKnownCardIds(
    snapshot,
    observerBoard,
    observerId,
  );
  const hiddenCardIdsByPlayer = collectResampleableHiddenCardIdsByPlayer({
    snapshot,
    knownCardIds,
    revealKnownCardIds,
  });

  const resampledCardIdsByPlayer =
    informationPolicy === "fair"
      ? assignFairHiddenDefinitions({
          cardCatalog,
          hiddenCardIdsByPlayer,
          prior: options.hiddenDefinitionIdsByPlayer,
          rng,
          sampled,
        })
      : {};

  shuffleUnknownDeckOrder({ knownCardIds, rng, sampled });

  return {
    preservedKnownCardIds: [...knownCardIds].sort(),
    resampledCardIdsByPlayer,
    snapshot: sampled,
  };
}

type CanonicalInformationCard =
  | {
      hidden: true;
      ownerId: PlayerId;
      zone: string;
      zoneIndex?: number;
      exerted?: boolean;
      publicFaceState?: "faceUp" | "faceDown";
    }
  | {
      hidden?: false;
      value: LorcanaProjectedBoardView["cards"][string];
    };

function canonicalizeProjectedCard(
  card: LorcanaProjectedBoardView["cards"][string],
): CanonicalInformationCard {
  if (!card.hidden) {
    return { hidden: false, value: card };
  }

  return {
    hidden: true,
    ownerId: card.ownerId,
    zone: card.zone,
    zoneIndex: card.zoneIndex,
    exerted: card.exerted,
    publicFaceState: card.publicFaceState,
  };
}

function canonicalizeZoneList(
  ids: readonly (string | number)[],
  board: LorcanaProjectedBoardView,
): string[] {
  return ids.map((rawId, index) => {
    const id = String(rawId);
    const card = board.cards[id];
    if (!card?.hidden) {
      return id;
    }
    return `hidden:${card.zone}:${String(card.ownerId)}:${String(card.zoneIndex ?? index)}`;
  });
}

/**
 * Canonical observer information state for determinization invariants.
 * Hidden card identity-derived fields are deliberately removed.
 */
export function createLorcanaInformationStateProjection(
  board: LorcanaProjectedBoardView,
): unknown {
  const players = Object.fromEntries(
    Object.entries(board.players).map(([playerId, player]) => [
      playerId,
      {
        ...player,
        hand: canonicalizeZoneList(player.hand, board),
        play: canonicalizeZoneList(player.play, board),
        inkwell: canonicalizeZoneList(player.inkwell, board),
        discard: canonicalizeZoneList(player.discard, board),
        playableFromUnderCardIds: player.playableFromUnderCardIds
          ? canonicalizeZoneList(player.playableFromUnderCardIds, board)
          : undefined,
      },
    ]),
  );

  const cards = Object.values(board.cards)
    .map((card) => canonicalizeProjectedCard(card))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  return {
    ...board,
    timerView: {
      ...board.timerView,
      serverTimestamp: 0,
    },
    players,
    cards,
  };
}

export function createLorcanaInformationStateKey(board: LorcanaProjectedBoardView): string {
  return JSON.stringify(createLorcanaInformationStateProjection(board));
}

export function assertSameLorcanaInformationState(
  before: LorcanaProjectedBoardView,
  after: LorcanaProjectedBoardView,
): void {
  const beforeKey = createLorcanaInformationStateKey(before);
  const afterKey = createLorcanaInformationStateKey(after);
  if (beforeKey !== afterKey) {
    throw new Error(
      "LORCANA_DETERMINIZATION_INFORMATION_STATE_MISMATCH: sampled world changed observer-visible information",
    );
  }
}
