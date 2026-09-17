import type { MultiPolygon, Polygon } from 'geojson';
import type { BuildingInfo } from './buildings.ts';

/**
 * Economy tuning — the single place to rebalance the prototype.
 *
 * Buildings are priced by footprint: area x PRICE_PER_SQUARE_METRE, rounded up to
 * PRICE_ROUNDING and floored at MIN_CLAIM_PRICE. With the defaults a median
 * ~66 m2 building costs about $700, so STARTING_CASH buys roughly fifteen of
 * them — but a 5,000 m2 complex is $50,000 and stays out of reach early on.
 */
export const STARTING_CASH = 10_000;
/** Base land value in dollars per square metre of footprint. */
export const PRICE_PER_SQUARE_METRE = 10;
/** Floor price, so tiny footprints are still worth owning. */
export const MIN_CLAIM_PRICE = 100;
/** Prices are rounded up to this multiple to keep them readable. */
export const PRICE_ROUNDING = 10;

export interface ClaimRecord {
  /** OSM way id, also used as the claim key. */
  osmId: string;
  name: string;
  type: string;
  /** Metres. */
  height: number;
  /** Metres; extrusion base, non-zero for building parts. */
  minHeight: number;
  areaM2: number;
  centroid: [number, number];
  geometry: Polygon | MultiPolygon;
  hide3d: boolean;
  claimedAt: string;
  pricePaid: number;
}

export interface GameState {
  cash: number;
  claims: Record<string, ClaimRecord>;
}

export type ClaimFailure = 'already-claimed' | 'insufficient-funds';

export type ClaimResult =
  | { ok: true; claim: ClaimRecord }
  | { ok: false; reason: ClaimFailure };

export type StateListener = (state: GameState) => void;

/**
 * Bump the suffix when the persisted shape changes; unknown shapes are discarded
 * in favour of a fresh game rather than being migrated. v2 also deliberately
 * drops saves from before per-footprint claim keys existed, which could otherwise
 * resurrect pre-fix claims spanning a whole merged relation.
 */
const STORAGE_KEY = 'industrial-domination.game.v2';

const listeners = new Set<StateListener>();

function createInitialState(): GameState {
  return { cash: STARTING_CASH, claims: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPolygonGeometry(value: unknown): value is Polygon | MultiPolygon {
  if (!isRecord(value)) return false;
  if (value.type !== 'Polygon' && value.type !== 'MultiPolygon') return false;
  return Array.isArray(value.coordinates);
}

/**
 * Structural validation of a persisted claim. Anything that fails is dropped,
 * so a partially corrupt payload degrades instead of breaking the game.
 */
function isClaimRecord(value: unknown): value is ClaimRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.osmId === 'string' &&
    value.osmId.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    typeof value.height === 'number' &&
    typeof value.minHeight === 'number' &&
    typeof value.areaM2 === 'number' &&
    Array.isArray(value.centroid) &&
    value.centroid.length === 2 &&
    isPolygonGeometry(value.geometry)
  );
}

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies, sandboxed frame).
    return null;
  }
}

function writeStorage(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch (error) {
    console.warn('[state] could not persist game state', error);
  }
}

function loadState(): GameState {
  const raw = readStorage();
  if (!raw) return createInitialState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[state] discarding unreadable saved game');
    return createInitialState();
  }

  if (!isRecord(parsed)) return createInitialState();

  const cash =
    typeof parsed.cash === 'number' && Number.isFinite(parsed.cash)
      ? parsed.cash
      : STARTING_CASH;

  const claims: Record<string, ClaimRecord> = {};
  if (isRecord(parsed.claims)) {
    for (const [key, value] of Object.entries(parsed.claims)) {
      if (isClaimRecord(value)) claims[key] = value;
    }
  }

  return { cash, claims };
}

let state: GameState = loadState();

function persist(): void {
  writeStorage(JSON.stringify(state));
}

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch (error) {
      // One broken subscriber must not stop the others from updating.
      console.error('[state] listener failed', error);
    }
  }
}

/** Live state object — treat as read-only; mutate only through this module. */
export function getState(): GameState {
  return state;
}

export function subscribe(listener: StateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isClaimed(osmId: string): boolean {
  return Object.hasOwn(state.claims, osmId);
}

export function getClaim(osmId: string): ClaimRecord | undefined {
  return state.claims[osmId];
}

export function getClaimCount(): number {
  return Object.keys(state.claims).length;
}

export function canAfford(cost: number): boolean {
  return state.cash >= cost;
}

/**
 * Price a building from its footprint area.
 *
 * Rounded up (never down) so a price is always at least area x rate, and floored
 * so degenerate slivers are not free.
 */
export function priceForBuilding(info: BuildingInfo): number {
  const raw = info.areaM2 * PRICE_PER_SQUARE_METRE;
  const rounded = Math.ceil(raw / PRICE_ROUNDING) * PRICE_ROUNDING;
  return Math.max(MIN_CLAIM_PRICE, rounded);
}

export function claimBuilding(info: BuildingInfo): ClaimResult {
  if (Object.hasOwn(state.claims, info.osmId)) {
    return { ok: false, reason: 'already-claimed' };
  }
  const price = priceForBuilding(info);

  // Authoritative affordability check: the UI also disables the button, but a
  // stale render must never be able to spend cash the player does not have.
  if (state.cash < price) {
    return { ok: false, reason: 'insufficient-funds' };
  }

  const claim: ClaimRecord = {
    osmId: info.osmId,
    name: info.name,
    type: info.type,
    height: info.height,
    minHeight: info.minHeight,
    areaM2: info.areaM2,
    centroid: info.centroid,
    geometry: info.geometry,
    hide3d: info.hide3d,
    claimedAt: new Date().toISOString(),
    pricePaid: price,
  };

  state.claims[info.osmId] = claim;
  state.cash -= price;
  persist();
  emit();

  return { ok: true, claim };
}

/** Wipe the save and start over with a fresh balance. */
export function resetGame(): void {
  state = createInitialState();
  persist();
  emit();
}
