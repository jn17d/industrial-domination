/**
 * Geometry vocabulary for procedural buildings.
 *
 * Recipes emit a plain-data "parts list"; a separate builder (three.js today,
 * anything else tomorrow) turns parts into meshes. Keeping this data-only is
 * deliberate: it is unit-testable, serializable, and engine-agnostic, so the
 * same model drives both the map overlay and the interior scene.
 */

/** Local metres: x = width (east), z = depth, y = up, origin at ground centre. */
export type Vec3 = [number, number, number];

/** Material keys resolved against the palette in `palettes.ts`. */
export type MaterialKey =
  | 'siding'
  | 'roof'
  | 'accent'
  | 'glass'
  | 'concrete'
  | 'trim'
  | 'interiorFloor';

/** How a part participates in culling/interaction later; purely informational now. */
export type PartTag =
  | 'structure'
  | 'roof'
  | 'dock'
  | 'annex'
  | 'hvac'
  | 'skylight'
  | 'window'
  | 'parapet'
  | 'crown'
  | 'floor'
  | 'column'
  | 'core';

export interface BoxPart {
  shape: 'box';
  size: Vec3;
  position: Vec3;
  /** Radians, about the up axis. */
  rotationY?: number;
  material: MaterialKey;
  tag?: PartTag;
}

/**
 * Symmetric gable roof sitting on a rectangular footprint. `position` is the
 * centre of its base; the ridge runs along the local x axis and rises by
 * `height` above the eaves, with `overhang` already included in width/depth.
 */
export interface GableRoofPart {
  shape: 'gableRoof';
  /** Full width the roof covers, including overhang. */
  width: number;
  /** Full depth the roof covers, including overhang. */
  depth: number;
  /** Ridge height above the eave line, in metres. */
  height: number;
  position: Vec3;
  material: MaterialKey;
  tag?: PartTag;
}

export type Part = BoxPart | GableRoofPart;

/** A functional area inside the building, for later interior gameplay. */
export interface InteriorZone {
  kind: 'machineBay' | 'storage' | 'office' | 'lobby' | 'services';
  /** Rect in local metres: [minX, minZ, width, depth], ground plane. */
  rect: [number, number, number, number];
}

export interface InteriorModel {
  storeys: number;
  storeyHeightM: number;
  /** Floor slab per storey (thin boxes), ground floor included. */
  parts: Part[];
  zones: InteriorZone[];
}

/**
 * The full procedural model for one claim: the exterior parts, the interior
 * layout, and the oriented frame the parts are defined in.
 */
export interface BuildingModel {
  /** Local footprint frame: width/depth along the principal axes, in metres. */
  widthM: number;
  depthM: number;
  /**
   * Bearing of the frame's x (width) axis, radians clockwise from north.
   * Models are authored axis-aligned; the renderer rotates by this to match
   * the actual footprint orientation on the map.
   */
  headingRad: number;
  exterior: Part[];
  interior: InteriorModel;
}

// --- deterministic RNG ------------------------------------------------------

/** FNV-1a, for turning the claim key into a stable 32-bit seed. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Mulberry32 PRNG in a tiny closure. A given seed always produces the same
 * sequence, so a claim's building looks identical across sessions, saves and
 * machines — no stored model needed, just re-run the recipe.
 */
export function createRng(seed: string): () => number {
  let state = hashString(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Random integer in [min, max], inclusive. */
export function rngInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Random pick from a list. */
export function rngPick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** Random boolean, true `probability` of the time. */
export function rngChance(rng: () => number, probability: number): boolean {
  return rng() < probability;
}

// --- oriented footprint frame ------------------------------------------------

/** Outer ring of the largest polygon in the geometry, as [lon, lat] pairs. */
export function largestRing(geometry: {
  type: string;
  coordinates: unknown;
}): [number, number][] {
  const polys =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as number[][][]]
      : (geometry.coordinates as number[][][][]).map((p) => p);
  let best: number[][] | null = null;
  let bestArea = -1;
  for (const poly of polys) {
    const ring = poly[0];
    if (!ring) continue;
    let area2 = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    if (Math.abs(area2) / 2 > bestArea) {
      bestArea = Math.abs(area2) / 2;
      best = ring;
    }
  }
  return (best ?? []).map((p) => [p[0], p[1]]);
}

export interface OrientedFrame {
  /** Extent along the principal axis (metres). */
  widthM: number;
  /** Extent perpendicular to it (metres). */
  depthM: number;
  /** Bearing of the principal axis, radians clockwise from north. */
  headingRad: number;
}

/**
 * Principal-axis bounding rectangle of a footprint (2D PCA).
 *
 * Cheaper and stabler than a full rotating-calipers minimum rectangle, and
 * plenty accurate for snapping a procedural hall onto a real footprint: the
 * principal axis of a building ring is its long wall direction.
 */
export function orientedFrame(
  ring: readonly [number, number][],
  latitude: number,
): OrientedFrame {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const metresPerLon = 111_320 * Math.cos((latitude * Math.PI) / 180);
  const metresPerLat = 110_540;

  // Covariance of the ring in local metres, origin at its mean.
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const [lon, lat] of ring) {
    const x = (lon - cx) * metresPerLon;
    const z = (lat - cy) * metresPerLat;
    xx += x * x;
    zz += z * z;
    xz += x * z;
  }
  const n = Math.max(1, ring.length);

  // Eigenvector of the 2x2 covariance with the larger eigenvalue. When xz is
  // ~0 the axes are already aligned; the closed form still handles that.
  const angle = 0.5 * Math.atan2(2 * (xz / n), xx / n - zz / n);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [lon, lat] of ring) {
    const x = (lon - cx) * metresPerLon;
    const z = (lat - cy) * metresPerLat;
    const u = x * cos + z * sin;
    const v = -x * sin + z * cos;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }

  return {
    widthM: Math.max(1, maxU - minU),
    depthM: Math.max(1, maxV - minV),
    // u axis in local metres is (cos east, sin north); bearing is atan2(east, north).
    headingRad: Math.atan2(cos, sin),
  };
}


