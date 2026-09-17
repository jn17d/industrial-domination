/**
 * Building classification: maps a claim's metrics onto one of the three
 * procedural archetypes the game renders (warehouse / office / tower).
 *
 * Pure logic — no rendering, no MapLibre, no three.js — so it stays trivially
 * testable and reusable by both the map overlay and the interior scene.
 */

/** The three procedural archetypes, keyed by the claim's size class. */
export type BuildingClass = 'low-rise' | 'mid-rise' | 'high-rise';

/** Metres; below this a building is a hall/warehouse, not a stacked structure. */
const MID_RISE_MIN_HEIGHT_M = 12;
/** Metres; at/above this the procedural recipe switches to a setback tower. */
const HIGH_RISE_MIN_HEIGHT_M = 32;

/** OSM `building` / `building:part` tags that force a size class up front. */
const INDUSTRIAL_TYPES = new Set([
  'warehouse',
  'industrial',
  'factory',
  'barn',
  'shed',
  'hangar',
  'service',
  'garage',
  'garages',
  'hut',
  'retail',
  'kiosk',
]);

const OFFICE_TYPES = new Set([
  'office',
  'commercial',
  'public',
  'civic',
  'government',
  'train_station',
]);

const TOWER_TYPES = new Set(['tower', 'apartments', 'residential', 'hotel', 'dormitory']);

export interface ClassifyInput {
  /** Metres, from the tile `render_height` field. */
  height: number;
  /** Square metres of footprint. */
  areaM2: number;
  /** OSM building tag value, lowercase; may be '' or unknown. */
  type: string;
}

/**
 * Classify a claim. Height is the primary signal (it is what the player sees),
 * the OSM type nudges borderline cases, and area breaks ties so a sprawling
 * single-storey shed never comes out as an "office".
 */
export function classifyBuilding({ height, areaM2, type }: ClassifyInput): BuildingClass {
  const normalized = type.trim().toLowerCase();

  // Sprawling footprints are halls by construction: a 4,000 m2 slab that is
  // nominally 20 m tall is far more likely a mis-tagged complex than a tower.
  const isSprawling = areaM2 > 2_000 && height < MID_RISE_MIN_HEIGHT_M * 2;

  if (INDUSTRIAL_TYPES.has(normalized) || isSprawling) {
    return height >= HIGH_RISE_MIN_HEIGHT_M ? 'high-rise' : 'low-rise';
  }
  if (TOWER_TYPES.has(normalized)) {
    return height >= MID_RISE_MIN_HEIGHT_M ? 'high-rise' : 'mid-rise';
  }
  if (OFFICE_TYPES.has(normalized)) {
    if (height < MID_RISE_MIN_HEIGHT_M && !isSprawling) return 'low-rise';
    return height >= HIGH_RISE_MIN_HEIGHT_M ? 'high-rise' : 'mid-rise';
  }

  if (height >= HIGH_RISE_MIN_HEIGHT_M) return 'high-rise';
  if (height >= MID_RISE_MIN_HEIGHT_M) return 'mid-rise';
  return 'low-rise';
}
