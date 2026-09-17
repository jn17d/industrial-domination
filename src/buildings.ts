import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import area from '@turf/area';
import buffer from '@turf/buffer';
import centroid from '@turf/centroid';
import intersect from '@turf/intersect';
import union from '@turf/union';
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Polygon,
  Position,
} from 'geojson';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  MapGeoJSONFeature,
} from 'maplibre-gl';

/** Domain model for a single building footprint, independent of MapLibre. */
export interface BuildingInfo {
  /**
   * Claim key for this specific footprint.
   *
   * Deliberately NOT the OSM feature id: OpenMapTiles merges OSM multipolygon
   * relations into one tile feature, so a relation and all of its constituent
   * buildings share a feature id. Keying claims on it would mark every
   * neighbouring building in that relation "already claimed" after the first
   * claim, so the key is derived from the resolved footprint instead.
   */
  osmId: string;
  /** The tile feature's OSM id (way/relation), for display and diagnostics. */
  osmFeatureId: string | null;
  name: string;
  type: string;
  /** Metres, from the vector tile `render_height` field. */
  height: number;
  /** Metres; non-zero for building parts that float above ground level. */
  minHeight: number;
  areaM2: number;
  centroid: [number, number];
  geometry: Polygon | MultiPolygon;
  /** True for OSM building outlines, which are not meaningful in 3D. */
  hide3d: boolean;
  /** Style layer the feature was queried from (diagnostics only). */
  layerId: string;
}

/**
 * Minimal shape `syncClaimedBuildings` needs. Declared structurally so this
 * module never imports `state.ts`, keeping the dependency graph acyclic
 * (`state.ts` imports the `BuildingInfo` type from here).
 */
export interface ClaimedFeatureInput {
  osmId: string;
  name: string;
  type: string;
  height: number;
  minHeight: number;
  areaM2: number;
  geometry: Polygon | MultiPolygon;
}

export const CLAIMED_SOURCE_ID = 'claimed-buildings';
const CLAIMED_FILL_LAYER_ID = 'claimed-buildings-fill';
/**
 * Exported: the three.js procedural model replaces the flat fill too, so
 * `main.ts` hides it by id (the neon ground square reads as a blank claim when
 * the model is what matters).
 */
export { CLAIMED_FILL_LAYER_ID };
const CLAIMED_OUTLINE_LAYER_ID = 'claimed-buildings-outline';
/**
 * Exported: the three.js procedural-models layer replaces this extrusion, so
 * `main.ts` hides it (and can restore it as a fallback) by id.
 */
export const CLAIMED_EXTRUSION_LAYER_ID = 'claimed-buildings-3d';

const HOVER_SOURCE_ID = 'building-hover';
const HOVER_LAYER_ID = 'building-hover-outline';
const HOVER_GLOW_LAYER_ID = 'building-hover-glow';

/** Neon green, per spec. */
export const CLAIMED_COLOR = '#00ff88';
export const HOVER_COLOR = '#ffd400';

/** OpenMapTiles names the building source layer `building`. */
const BUILDING_SOURCE_LAYER = 'building';

/** Fallback when a tile omits `render_height`. */
const DEFAULT_BUILDING_HEIGHT = 8;

/**
 * Footprints below this are tile-clip artifacts or degenerate rings rather than a
 * claimable building; claiming one would render as an invisible sliver.
 */
const MIN_CLAIMABLE_AREA_M2 = 5;

/**
 * When several parts contain the cursor, prefer the smallest that reaches this
 * size. The tile is littered with ~5 m2 clip fragments, and a plain smallest-part
 * rule resolves to one of those on every click instead of the building the player
 * is pointing at. Falls back to the smallest containing part when nothing reaches
 * this size, so genuinely tiny buildings stay claimable.
 */
const PREFERRED_MIN_CLAIM_AREA_M2 = 20;

/**
 * The claimed extrusion must fully enclose the basemap building rather than share
 * faces with it.
 *
 * Its walls would otherwise be coplanar with the basemap's (identical footprint,
 * identical render_min_height), and coincident depth values z-fight into
 * flickering patches that read as the green shape clipping through the building.
 * Merely lifting the roof (the original 0.5 m) only separates the top face and
 * leaves every wall fighting.
 *
 * Three separations make the enclosure exact:
 *  - walls pushed outward, by buffering the footprint (see syncClaimedBuildings)
 *  - roof raised above the basemap roof
 *  - base extended below the basemap base, clamped to ground level
 */
const CLAIMED_WALL_INFLATION_M = 0.25;
const CLAIMED_HEIGHT_EPSILON = 0.35;
const CLAIMED_BASE_EPSILON = 0.2;

/** Flat `building` fills are drawn from z13; `building-3d` extrusions from z14. */
export const BUILDING_MIN_ZOOM = 13;
export const BUILDING_3D_MIN_ZOOM = 14;

function emptyCollection(): FeatureCollection<Polygon | MultiPolygon> {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Collect the style layers that actually draw building footprints, extrusions
 * first, and only ids that exist in the live style.
 *
 * This matters: in the OpenFreeMap Liberty style the flat `building` layer is
 * `minzoom 13 / maxzoom 14` while `building-3d` is `minzoom 14`. Per the style
 * spec a layer is hidden at or above its maxzoom, so at the zoom levels where
 * you actually click buildings only `building-3d` is rendered — and
 * `queryRenderedFeatures` throws when handed an unknown layer id, so hardcoding
 * either name is unsafe.
 */
export function resolveBuildingLayers(map: MapLibreMap): string[] {
  const layers = map.getStyle()?.layers ?? [];
  const extruded: string[] = [];
  const flat: string[] = [];

  for (const layer of layers) {
    if (layer.type !== 'fill' && layer.type !== 'fill-extrusion') continue;

    const sourceLayer = (layer as { 'source-layer'?: string })['source-layer'];
    const isBuilding = sourceLayer === BUILDING_SOURCE_LAYER || /building/i.test(layer.id);
    if (!isBuilding) continue;

    if (layer.type === 'fill-extrusion') extruded.push(layer.id);
    else flat.push(layer.id);
  }

  return [...extruded, ...flat];
}

/**
 * Stable identity for a building footprint.
 *
 * OpenMapTiles exports the building layer with `key_field: osm_id` and
 * `key_field_as_attribute: no`, so the OSM way id arrives as the MVT feature id
 * and `properties.osm_id` is absent. The property and geometry-hash branches are
 * fallbacks for other providers/styles.
 */
export function getFeatureId(feature: MapGeoJSONFeature): string {
  if (feature.id !== undefined && feature.id !== null) return String(feature.id);

  const properties = feature.properties ?? {};
  const candidate = properties.osm_id ?? properties.id ?? properties['@id'];
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    return String(candidate);
  }

  return hashGeometry(feature.geometry);
}

/**
 * Geometry hash used only when no id survives. Coordinates are rounded before
 * hashing so the identity stays stable across sessions and tile variants —
 * otherwise a saved claim would be orphaned by sub-millimetre float drift.
 */
function hashGeometry(geometry: Geometry | null | undefined): string {
  if (!geometry) return 'unknown';

  const coordinates = 'coordinates' in geometry ? geometry.coordinates : [];
  const text = JSON.stringify(coordinates, (_key, value: unknown) =>
    typeof value === 'number' ? Number(value.toFixed(6)) : value,
  );

  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `geom-${(hash >>> 0).toString(36)}`;
}

/**
 * Claim key for a resolved footprint part.
 *
 * Hashed from the footprint itself rather than read off the feature id, because a
 * merged OSM relation carries one feature id for all of its buildings. Rounding
 * in `hashGeometry` keeps the key stable across sessions.
 *
 * Caveat: a footprint clipped at a tile edge hashes differently to the same
 * footprint seen from the neighbouring tile, so such a building could be claimed
 * twice from opposite sides of a boundary.
 */
function partClaimId(part: Polygon | MultiPolygon): string {
  return `part-${hashGeometry(part)}`;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

/**
 * The OpenMapTiles building layer exposes no building-type attribute (only
 * render_height / render_min_height / colour / hide_3d), so "type" is derived
 * from the height profile.
 */
export function classifyBuilding(height: number, hide3d: boolean): string {
  if (hide3d) return 'Building outline';
  if (height < 12) return 'Low-rise';
  if (height < 30) return 'Mid-rise';
  if (height < 60) return 'High-rise';
  if (height < 150) return 'Tower';
  return 'Skyscraper';
}

/** Wrap a bare polygon so Turf's parameter types are satisfied. */
function asFeature(geometry: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> {
  return { type: 'Feature', geometry, properties: {} };
}

/** Split a footprint into individually-claimable single-polygon parts. */
function splitIntoPolygons(geometry: Polygon | MultiPolygon): Polygon[] {
  if (geometry.type === 'Polygon') return [geometry];
  return geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }));
}

/**
 * Push a footprint outward so an overlay's walls/outline cannot be coplanar
 * with the basemap building's.
 *
 * The claimed extrusion needs this so its walls do not z-fight the basemap's
 * (identical footprint, identical render_min_height, coincident depth values
 * flickering into patches that read as the green shape clipping through the
 * building); the hover outline needs it so the line draws outside the building
 * silhouette instead of being half-buried by the extrusion wall at pitch.
 *
 * This runs on the render path only: stored claims keep their true footprint, so
 * claim identity and the reported area are unaffected by the inflation. Buffering
 * can fail on malformed geometry, so the original footprint is the fallback.
 */
function inflateFootprint(
  geometry: Polygon | MultiPolygon,
  meters: number = CLAIMED_WALL_INFLATION_M,
): Polygon | MultiPolygon {
  try {
    const buffered = buffer(asFeature(geometry), meters, {
      units: 'meters',
    });
    const out = buffered?.geometry;
    if (!out || (out.type !== 'Polygon' && out.type !== 'MultiPolygon')) return geometry;
    if (area(asFeature(out)) < MIN_CLAIMABLE_AREA_M2) return geometry;
    return out;
  } catch (error) {
    console.warn('[buildings] footprint inflation failed, using exact footprint', error);
    return geometry;
  }
}

function bboxContains(ring: Position[], point: [number, number]): boolean {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const position of ring) {
    const x = position[0];
    const y = position[1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return (
    point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY
  );
}

/** Cheap ring average, used only to rank candidates when nothing contains them. */
function ringCenter(ring: Position[]): [number, number] {
  let sumX = 0;
  let sumY = 0;
  for (const position of ring) {
    sumX += position[0];
    sumY += position[1];
  }
  return [sumX / ring.length, sumY / ring.length];
}

function squaredDistance(a: [number, number], b: [number, number]): number {
  const metresPerLng = 111_320 * Math.cos((a[1] * Math.PI) / 180);
  const dx = (b[0] - a[0]) * metresPerLng;
  const dy = (b[1] - a[1]) * 110_540;
  return dx * dx + dy * dy;
}

/**
 * A group of footprint rings that belong to the same physical building.
 *
 * `dissolved` is the union of the members (null when the union failed on
 * malformed geometry), so a selection renders and claims as one shape.
 */
interface PartCluster {
  members: Polygon[];
  dissolved: Polygon | MultiPolygon | null;
}

/**
 * Above this ring count a multi-part feature is treated as a merged relation of
 * many separate buildings rather than one large building: clustering is skipped
 * and the smallest-ring rule applies. Pairwise adjacency on the pathological
 * ~1000-ring relation would cost ~500k comparisons per frame for no gain — its
 * members are streets apart, so every cluster would be a singleton anyway.
 */
const MAX_CLUSTERABLE_PARTS = 60;

/**
 * Bounding-box padding (degrees, ≈2 m) used to decide that two rings touch and
 * therefore belong to one building. Rings of a single large building share
 * walls, so their boxes abut; members of a merged neighbourhood relation are
 * separated by streets and yards far wider than this.
 */
const CLUSTER_BBOX_PAD_DEG = 0.00002;

/**
 * Clusters do not depend on the cursor, and this code runs every animation
 * frame while hovering, so results are cached per feature. The signature (total
 * outer-ring vertex count) catches the same feature id arriving from a
 * differently clipped neighbouring tile. Bounded, and simply emptied when full —
 * recomputation is cheap and correctness matters more than retention here.
 */
const CLUSTER_CACHE_MAX = 200;
const clusterCache = new Map<string, { signature: number; clusters: PartCluster[] }>();

type RingBox = { minX: number; minY: number; maxX: number; maxY: number };

function ringBox(ring: Position[]): RingBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const position of ring) {
    if (position[0] < minX) minX = position[0];
    if (position[0] > maxX) maxX = position[0];
    if (position[1] < minY) minY = position[1];
    if (position[1] > maxY) maxY = position[1];
  }
  return { minX, minY, maxX, maxY };
}

function boxesOverlap(a: RingBox, b: RingBox): boolean {
  return (
    a.minX - CLUSTER_BBOX_PAD_DEG <= b.maxX + CLUSTER_BBOX_PAD_DEG &&
    a.maxX + CLUSTER_BBOX_PAD_DEG >= b.minX - CLUSTER_BBOX_PAD_DEG &&
    a.minY - CLUSTER_BBOX_PAD_DEG <= b.maxY + CLUSTER_BBOX_PAD_DEG &&
    a.maxY + CLUSTER_BBOX_PAD_DEG >= b.minY - CLUSTER_BBOX_PAD_DEG
  );
}

/** Fuse a cluster's rings into one footprint; null when the union is unusable. */
function dissolveCluster(members: Polygon[]): Polygon | MultiPolygon | null {
  if (members.length === 1) return members[0];
  try {
    const merged = union({
      type: 'FeatureCollection',
      features: members.map(asFeature),
    });
    const out = merged?.geometry;
    if (!out || (out.type !== 'Polygon' && out.type !== 'MultiPolygon')) return null;
    if (area(asFeature(out)) < MIN_CLAIMABLE_AREA_M2) return null;
    return out;
  } catch (error) {
    console.warn('[buildings] cluster dissolve failed, using first ring', error);
    return null;
  }
}

function buildClusters(parts: Polygon[]): PartCluster[] {
  const boxes = parts.map((part) => ringBox(part.coordinates[0]));

  // Union-find over ring adjacency.
  const parent = parts.map((_, index) => index);
  function find(index: number): number {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      if (!boxesOverlap(boxes[i], boxes[j])) continue;
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) parent[rootJ] = rootI;
    }
  }

  const groups = new Map<number, Polygon[]>();
  parts.forEach((part, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(part);
    else groups.set(root, [part]);
  });

  return [...groups.values()].map((members) => ({
    members,
    dissolved: dissolveCluster(members),
  }));
}

/** Cached cluster lookup; null means the feature is too multipart to cluster. */
function clustersFor(cacheKey: string, parts: Polygon[]): PartCluster[] | null {
  if (parts.length > MAX_CLUSTERABLE_PARTS) return null;

  const signature = parts.reduce((count, part) => count + part.coordinates[0].length, 0);
  const cached = clusterCache.get(cacheKey);
  if (cached && cached.signature === signature) return cached.clusters;

  const clusters = buildClusters(parts);
  if (clusterCache.size >= CLUSTER_CACHE_MAX) clusterCache.clear();
  clusterCache.set(cacheKey, { signature, clusters });
  return clusters;
}

/**
 * Old multi-part rule, kept for the >MAX_CLUSTERABLE_PARTS merged-relation case:
 * smallest ring containing the cursor (two-tiered against clip fragments),
 * falling back to the nearest ring by centre distance.
 */
function pickSmallestPart(parts: Polygon[], cursor: [number, number]): Polygon {
  const containing: { part: Polygon; areaM2: number }[] = [];
  for (const part of parts) {
    if (!bboxContains(part.coordinates[0], cursor)) continue;
    if (!booleanPointInPolygon(cursor, part)) continue;
    containing.push({ part, areaM2: area(asFeature(part)) });
  }

  if (containing.length > 0) {
    // Degenerate rings exist in OSM data; without this a claim could render as an
    // invisible sliver even though something contains the cursor.
    const usable = containing.filter((entry) => entry.areaM2 >= MIN_CLAIMABLE_AREA_M2);
    if (usable.length === 0) return containing[0].part;

    const preferred = usable.filter(
      (entry) => entry.areaM2 >= PREFERRED_MIN_CLAIM_AREA_M2,
    );
    const pool = preferred.length > 0 ? preferred : usable;
    return pool.reduce((best, entry) => (entry.areaM2 < best.areaM2 ? entry : best)).part;
  }

  let best = parts[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const part of parts) {
    const distance = squaredDistance(cursor, ringCenter(part.coordinates[0]));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = part;
    }
  }

  return best;
}

/**
 * Reduce a footprint to the building the cursor is actually over.
 *
 * OpenMapTiles merges large OSM `type=multipolygon` building relations into one
 * feature. In a central-London z14 tile, 285 of 510 building features are
 * multi-part and a single relation carries 994 polygons covering 365,237 m2 —
 * so claiming a feature wholesale paints a whole neighbourhood, and one small
 * building there resolves to *only* that giant relation.
 *
 * But a single large building is ALSO often multi-part (wings mapped as one
 * multipolygon relation), and treating each ring as its own claimable building
 * splits those big buildings into many small polygons. Rings of one building
 * share walls, while relation members sit streets apart — so rings are grouped
 * into touching clusters (see buildClusters) and the *dissolved cluster* under
 * the cursor is returned: one highlight, one claim, correct total area. Features
 * with too many rings to plausibly be one building fall back to pickSmallestPart.
 *
 * Containment is tested against the ground point under the cursor. Because a
 * pitched camera means a click on a tall building's roof unprojects slightly
 * behind its footprint, a cluster that fails containment falls back to the
 * nearest one by centre distance rather than producing no selection at all.
 */
function selectPartUnderCursor(
  geometry: Polygon | MultiPolygon,
  cursor: [number, number],
  cacheKey: string,
): Polygon | MultiPolygon {
  const parts = splitIntoPolygons(geometry);
  if (parts.length === 1) return parts[0];

  const clusters = clustersFor(cacheKey, parts);
  if (!clusters) return pickSmallestPart(parts, cursor);

  let containing: PartCluster | null = null;
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      if (!bboxContains(member.coordinates[0], cursor)) continue;
      if (!booleanPointInPolygon(cursor, member)) continue;
      containing = cluster;
      break;
    }
    if (containing) break;
  }

  if (!containing) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const cluster of clusters) {
      for (const member of cluster.members) {
        const distance = squaredDistance(cursor, ringCenter(member.coordinates[0]));
        if (distance < bestDistance) {
          bestDistance = distance;
          containing = cluster;
        }
      }
    }
  }

  if (!containing) return parts[0];
  return containing.dissolved ?? containing.members[0];
}

/**
 * Grow a mid/high-rise selection into its physically-attached neighbours.
 *
 * Ring clustering merges rings *within one tile feature*, but the remaining
 * splits come from buildings mappers drew as several *separate* OSM ways:
 * tower phases sharing a wall, towers on a common podium, wings of one
 * development. `queryRenderedFeatures` only returns features covering the
 * cursor, so those neighbours never even reach `pickBuildingAt` — hence the
 * caller passes a bbox query callback and this function grows outward from the
 * picked footprint until nothing more merges.
 *
 * Balanced merge tests (so terrace rows and touching-but-separate towers stay
 * separate): both footprints mid/high-rise; heights within a similar band or
 * one tier starting where the other ends (podium); and a genuine shared wall
 * (dilating the selection by 1 m must overlap the neighbour by >= 3 m2 — a
 * corner touch yields ~0, a party wall yields metres).
 *
 * Low-rise and hide_3d-outline picks bypass growth entirely, so dense
 * low-rise areas behave exactly as before.
 */
const MID_RISE_MIN_HEIGHT_M = 12;
const GROWTH_DILATION_M = 1;
const MIN_SHARED_WALL_M2 = 3;
const HEIGHT_BAND_RATIO = 0.4;
const PODIUM_TOLERANCE_M = 5;
const MAX_GROWTH_ROUNDS = 5;
const GROWTH_CACHE_MAX = 200;
const growthCache = new Map<string, BuildingInfo>();

type GeomBox = [number, number, number, number];

function geomBBox(geometry: Polygon | MultiPolygon): GeomBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const polygon of splitIntoPolygons(geometry)) {
    for (const ring of polygon.coordinates) {
      for (const position of ring) {
        if (position[0] < minX) minX = position[0];
        if (position[0] > maxX) maxX = position[0];
        if (position[1] < minY) minY = position[1];
        if (position[1] > maxY) maxY = position[1];
      }
    }
  }
  return [minX, minY, maxX, maxY];
}

function boxCenter(box: GeomBox): [number, number] {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

/** Height test: similar band, or one tier starts where the other ends. */
function heightsMergeable(hA: number, mhA: number, hB: number, mhB: number): boolean {
  const similarBand =
    Math.abs(hA - hB) <= HEIGHT_BAND_RATIO * Math.max(hA, hB);
  if (similarBand) return true;
  // Podium: the taller footprint's base sits at (roughly) the shorter one's top.
  return hB >= hA
    ? Math.abs(mhB - hA) <= PODIUM_TOLERANCE_M
    : Math.abs(mhA - hB) <= PODIUM_TOLERANCE_M;
}

export function growSelection(
  primary: BuildingInfo,
  queryNeighbours: (bbox: GeomBox) => MapGeoJSONFeature[],
): BuildingInfo {
  if (primary.hide3d) return primary;
  if (primary.height < MID_RISE_MIN_HEIGHT_M) return primary;

  const cached = growthCache.get(primary.osmId);
  if (cached) return cached;

  const mergedIds = new Set<string>([primary.osmFeatureId ?? primary.osmId]);
  let current = primary.geometry;
  let maxHeight = primary.height;
  let minHeight = primary.minHeight;
  let mergedAny = false;

  for (let round = 0; round < MAX_GROWTH_ROUNDS; round += 1) {
    let dilated: Feature<Polygon | MultiPolygon> | null = null;
    try {
      const result = buffer(asFeature(current), GROWTH_DILATION_M, { units: 'meters' });
      if (
        result?.geometry &&
        (result.geometry.type === 'Polygon' || result.geometry.type === 'MultiPolygon')
      ) {
        dilated = result as Feature<Polygon | MultiPolygon>;
      }
    } catch {
      break;
    }
    if (!dilated) break;

    const toMerge: (Polygon | MultiPolygon)[] = [];
    for (const feature of queryNeighbours(geomBBox(dilated.geometry))) {
      const geometry = feature.geometry;
      if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
      // Outlines are already whole buildings; growth only fuses real extrusions.
      if (isTruthy(feature.properties?.hide_3d)) continue;

      const id = getFeatureId(feature);
      if (mergedIds.has(id)) continue;
      mergedIds.add(id);

      const part = selectPartUnderCursor(geometry, boxCenter(geomBBox(geometry)), id);
      if (area(asFeature(part)) < MIN_CLAIMABLE_AREA_M2) continue;

      const properties = feature.properties ?? {};
      const height = toFiniteNumber(properties.render_height, DEFAULT_BUILDING_HEIGHT);
      const baseHeight = toFiniteNumber(properties.render_min_height, 0);
      if (height < MID_RISE_MIN_HEIGHT_M) continue;
      if (!heightsMergeable(maxHeight, minHeight, height, baseHeight)) continue;

      let overlapArea = 0;
      try {
        const overlap = intersect({
          type: 'FeatureCollection',
          features: [asFeature(part), dilated],
        });
        if (overlap?.geometry) overlapArea = area(overlap);
      } catch {
        overlapArea = 0;
      }
      if (overlapArea < MIN_SHARED_WALL_M2) continue;

      toMerge.push(part);
      maxHeight = Math.max(maxHeight, height);
      minHeight = Math.min(minHeight, baseHeight);
    }

    if (toMerge.length === 0) break;

    try {
      const merged = union({
        type: 'FeatureCollection',
        features: [asFeature(current), ...toMerge.map(asFeature)],
      });
      if (!merged?.geometry) break;
      current = merged.geometry;
      mergedAny = true;
    } catch (error) {
      console.warn('[buildings] selection growth union failed', error);
      break;
    }
  }

  const result: BuildingInfo = mergedAny
    ? {
        ...primary,
        geometry: current,
        height: maxHeight,
        minHeight,
        type: classifyBuilding(maxHeight, false),
        areaM2: area(asFeature(current)),
        centroid: centroid(asFeature(current)).geometry.coordinates as [number, number],
        osmId: partClaimId(current),
      }
    : primary;

  if (growthCache.size >= GROWTH_CACHE_MAX) growthCache.clear();
  growthCache.set(primary.osmId, result);
  return result;
}

/**
 * True when any polygon of `part` has its centroid inside `outline`, i.e. the
 * part belongs to the building that outline encloses. Centroid testing is
 * deliberately cheap: this only aggregates part heights for a selection, and a
 * part straddling two buildings is rare enough that either parent's height is a
 * fine answer.
 */
function partLiesWithin(
  part: Polygon | MultiPolygon,
  outline: Polygon | MultiPolygon,
): boolean {
  return splitIntoPolygons(part).some((polygon) =>
    booleanPointInPolygon(centroid(asFeature(polygon)), outline),
  );
}

/**
 * Choose the building under the cursor from raw query results.
 *
 * Candidates overlap often (a merged relation plus standalone footprints beneath
 * it), so a plain smallest-area race is wrong twice over: it can hand the claim to
 * a ~5 m2 clip fragment even when a real building also contains the cursor, and it
 * never rewards the building the player actually pointed at.
 *
 * So candidates are ranked in two tiers, both smallest-first: anything at or above
 * PREFERRED_MIN_CLAIM_AREA_M2 wins over anything below it, and within a tier the
 * smallest (most specific) footprint wins. MapLibre only returns features whose
 * rendered geometry covers the cursor, so every candidate is genuinely under the
 * pointer; the tiers just decide which of those is the building, not the fragment.
 *
 * The one override: a `hide_3d` candidate is the OSM *outline* of a building that
 * mappers decomposed into `building:part` polygons (a tower rendered as many small
 * extrusions inside it). The Liberty style does not filter those out, so they reach
 * this query — and selecting one of the tiny parts instead of the outline is what
 * makes a high-rise claim as a sliver. An outline therefore wins outright over any
 * part-sized candidate, with its height/min-height summarised from the parts inside
 * it so pricing, classification and the claimed extrusion describe the whole tower.
 * Smallest outline wins when several nest, guarding against a giant merged
 * relation that also carries hide_3d.
 *
 * The same footprint can appear twice, once per resolved layer, hence the id dedupe.
 */
export function pickBuildingAt(
  features: MapGeoJSONFeature[],
  cursor: [number, number],
): BuildingInfo | null {
  const seen = new Set<string>();
  let preferred: BuildingInfo | null = null;
  let preferredArea = Number.POSITIVE_INFINITY;
  let fallback: BuildingInfo | null = null;
  let fallbackArea = Number.POSITIVE_INFINITY;
  let outline: BuildingInfo | null = null;
  let outlineArea = Number.POSITIVE_INFINITY;
  const parts: { geometry: Polygon | MultiPolygon; height: number; minHeight: number }[] = [];

  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') continue;

    const id = getFeatureId(feature);
    if (seen.has(id)) continue;
    seen.add(id);

    const part = selectPartUnderCursor(geometry, cursor, id);
    const partArea = area(asFeature(part));
    // A claim that cannot be seen is worse than no claim: skip degenerate
    // geometry rather than painting an invisible sliver.
    if (partArea < MIN_CLAIMABLE_AREA_M2) continue;

    const info = toBuildingInfo(feature, part, partClaimId(part));

    if (info.hide3d) {
      if (partArea < outlineArea) {
        outlineArea = partArea;
        outline = info;
      }
      continue;
    }

    parts.push({ geometry: part, height: info.height, minHeight: info.minHeight });

    if (partArea >= PREFERRED_MIN_CLAIM_AREA_M2) {
      if (partArea < preferredArea) {
        preferredArea = partArea;
        preferred = info;
      }
    } else if (partArea < fallbackArea) {
      fallbackArea = partArea;
      fallback = info;
    }
  }

  if (outline) {
    const inside = parts.filter((entry) => partLiesWithin(entry.geometry, outline.geometry));
    if (inside.length > 0) {
      outline.height = Math.max(...inside.map((entry) => entry.height));
      outline.minHeight = Math.min(...inside.map((entry) => entry.minHeight));
      outline.type = classifyBuilding(outline.height, false);
    }
    return outline;
  }

  return preferred ?? fallback;
}

/**
 * Convert a queried MapLibre feature into the game's domain model.
 *
 * `geometry` is passed explicitly because a merged multi-part feature must first
 * be narrowed to the single footprint under the cursor (see `pickBuildingAt`), and
 * `claimId` alongside it because the OSM feature id is shared by every part of a
 * merged relation and therefore cannot serve as a per-building claim key.
 */
export function toBuildingInfo(
  feature: MapGeoJSONFeature,
  geometry: Polygon | MultiPolygon,
  claimId: string,
): BuildingInfo {
  const properties = feature.properties ?? {};
  const osmFeatureId = getFeatureId(feature);
  const height = toFiniteNumber(properties.render_height, DEFAULT_BUILDING_HEIGHT);
  const minHeight = toFiniteNumber(properties.render_min_height, 0);
  const hide3d = isTruthy(properties.hide_3d);

  // Re-wrap as a plain GeoJSON Feature so Turf's parameter types are satisfied
  // without casting the MapLibre feature.
  const shape: Feature<Polygon | MultiPolygon> = {
    type: 'Feature',
    geometry,
    properties: {},
  };

  const areaM2 = area(shape);
  const center = centroid(shape);
  const [lng, lat] = center.geometry.coordinates;

  const name =
    typeof properties.name === 'string' && properties.name.length > 0
      ? properties.name
      : `Building #${osmFeatureId ?? claimId}`;

  return {
    osmId: claimId,
    osmFeatureId,
    name,
    type: classifyBuilding(height, hide3d),
    height,
    minHeight,
    areaM2,
    centroid: [lng, lat],
    geometry,
    hide3d,
    layerId: feature.layer?.id ?? 'unknown',
  };
}

/**
 * Ambient-model tuning: how many unclaimed buildings the three.js layer renders
 * per viewport, the smallest footprint worth a model, and the zoom below which
 * the scene is emptied (ambient models exist only where extrusions would).
 */
export const AMBIENT_MAX_MODELS = 600;
export const AMBIENT_MIN_AREA_M2 = 20;

/**
 * Collect every unclaimed-worthy building currently rendered in the viewport,
 * for the ambient three.js warehouse layer.
 *
 * Uses `queryRenderedFeatures` over the whole viewport (the basemap building
 * layers stay queryable because they are hidden via paint opacity, not
 * `visibility: none` — the query filters on visibility, not paint). Dedupes
 * across resolved layers and across tile-clip duplicates of one feature,
 * skips `hide_3d` outlines and sliver fragments, and keeps the
 * `AMBIENT_MAX_MODELS` buildings nearest the viewport centre.
 */
export function collectViewportBuildings(map: MapLibreMap): BuildingInfo[] {
  const layers = resolveBuildingLayers(map);
  if (layers.length === 0) return [];

  let features: MapGeoJSONFeature[];
  try {
    features = map.queryRenderedFeatures({ layers });
  } catch (error) {
    console.warn('[buildings] viewport query failed', error);
    return [];
  }

  const seen = new Set<string>();
  const center = map.getCenter();
  const cursor: [number, number] = [center.lng, center.lat];
  const ranked: { info: BuildingInfo; dist2: number }[] = [];

  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
    if (isTruthy(feature.properties?.hide_3d)) continue;

    // Feature id (the OSM way id in OpenMapTiles) is stable across tile clips;
    // the geometry hash covers providers without ids.
    const dedupeKey =
      feature.id !== undefined && feature.id !== null
        ? `f-${feature.id}`
        : `g-${hashGeometry(geometry)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const info = toBuildingInfo(feature, geometry, partClaimId(geometry));
    if (info.areaM2 < AMBIENT_MIN_AREA_M2) continue;

    ranked.push({ info, dist2: squaredDistance(cursor, info.centroid) });
  }

  ranked.sort((a, b) => a.dist2 - b.dist2);
  return ranked.slice(0, AMBIENT_MAX_MODELS).map((entry) => entry.info);
}

/**
 * Blank the basemap's own building fills/extrusions (paint opacity 0, NOT
 * `visibility: none`) so the procedural three.js models replace them while
 * hover/click picking via `queryRenderedFeatures` keeps working.
 *
 * Paint properties reset when the style reloads, so call this on every
 * `style.load` as well as once after the initial load.
 */
export function hideBasemapBuildingShapes(map: MapLibreMap): void {
  for (const layerId of resolveBuildingLayers(map)) {
    const layer = map.getLayer(layerId);
    if (!layer) continue;
    try {
      if (layer.type === 'fill-extrusion') {
        map.setPaintProperty(layerId, 'fill-extrusion-opacity', 0);
      } else if (layer.type === 'fill') {
        map.setPaintProperty(layerId, 'fill-opacity', 0);
      }
    } catch (error) {
      console.warn(`[buildings] failed to blank building layer ${layerId}`, error);
    }
  }
}

/**
 * True when a viewport building is already covered by a claim — either the
 * claim keys match exactly, or the footprints overlap via centroid containment
 * (the click path may resolve a merged relation to a sub-part, giving the claim
 * a different key than the ambient whole-feature model).
 */
export function isCoveredByClaim(
  building: BuildingInfo,
  claims: { osmId: string; centroid: [number, number]; geometry: Polygon | MultiPolygon }[],
): boolean {
  for (const claim of claims) {
    if (claim.osmId === building.osmId) return true;
    try {
      if (booleanPointInPolygon({ type: 'Point', coordinates: building.centroid }, claim.geometry)) {
        return true;
      }
      if (
        booleanPointInPolygon({ type: 'Point', coordinates: claim.centroid }, building.geometry)
      ) {
        return true;
      }
    } catch {
      // Malformed footprint: treat as not covered, the exact-key check above
      // still catches the common case.
    }
  }
  return false;
}

/** Insert point that keeps overlay geometry beneath map labels. */
function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.type === 'symbol') return layer.id;
  }
  return undefined;
}

/**
 * Create the overlay sources/layers if absent. Idempotent, so it is safe to call
 * on every style load.
 */
export function ensureOverlayLayers(map: MapLibreMap): void {
  if (!map.getSource(CLAIMED_SOURCE_ID)) {
    map.addSource(CLAIMED_SOURCE_ID, {
      type: 'geojson',
      data: emptyCollection(),
      // Enables feature-state lookups against claimed buildings later.
      promoteId: 'osmId',
    });
  }

  if (!map.getSource(HOVER_SOURCE_ID)) {
    map.addSource(HOVER_SOURCE_ID, { type: 'geojson', data: emptyCollection() });
  }

  const beforeId = firstSymbolLayerId(map);

  if (!map.getLayer(CLAIMED_FILL_LAYER_ID)) {
    map.addLayer(
      {
        id: CLAIMED_FILL_LAYER_ID,
        type: 'fill',
        source: CLAIMED_SOURCE_ID,
        paint: {
          'fill-color': CLAIMED_COLOR,
          'fill-opacity': 0.45,
        },
      },
      beforeId,
    );
  }

  if (!map.getLayer(CLAIMED_OUTLINE_LAYER_ID)) {
    map.addLayer(
      {
        id: CLAIMED_OUTLINE_LAYER_ID,
        type: 'line',
        source: CLAIMED_SOURCE_ID,
        paint: {
          'line-color': CLAIMED_COLOR,
          'line-width': 1.5,
          'line-opacity': 0.9,
        },
      },
      beforeId,
    );
  }

  if (!map.getLayer(CLAIMED_EXTRUSION_LAYER_ID)) {
    const height: ExpressionSpecification = [
      '+',
      ['coalesce', ['get', 'render_height'], DEFAULT_BUILDING_HEIGHT],
      CLAIMED_HEIGHT_EPSILON,
    ];
    // Clamped to ground so a floating building part cannot push the claimed box
    // below the surface it sits on.
    const base: ExpressionSpecification = [
      'max',
      0,
      ['-', ['coalesce', ['get', 'render_min_height'], 0], CLAIMED_BASE_EPSILON],
    ];

    map.addLayer(
      {
        id: CLAIMED_EXTRUSION_LAYER_ID,
        type: 'fill-extrusion',
        source: CLAIMED_SOURCE_ID,
        paint: {
          'fill-extrusion-color': CLAIMED_COLOR,
          'fill-extrusion-height': height,
          'fill-extrusion-base': base,
          'fill-extrusion-opacity': 0.9,
        },
      },
      beforeId,
    );
  }

  if (!map.getLayer(HOVER_GLOW_LAYER_ID)) {
    map.addLayer(
      {
        id: HOVER_GLOW_LAYER_ID,
        type: 'line',
        source: HOVER_SOURCE_ID,
        paint: {
          'line-color': HOVER_COLOR,
          'line-width': 12,
          'line-blur': 6,
          'line-opacity': 0.4,
        },
      },
      beforeId,
    );
  }

  if (!map.getLayer(HOVER_LAYER_ID)) {
    const width: ExpressionSpecification = [
      'interpolate',
      ['linear'],
      ['zoom'],
      14,
      3,
      18,
      5,
    ];

    map.addLayer(
      {
        id: HOVER_LAYER_ID,
        type: 'line',
        source: HOVER_SOURCE_ID,
        paint: {
          'line-color': HOVER_COLOR,
          'line-width': width,
          'line-opacity': 1,
        },
      },
      beforeId,
    );
  }
}

/**
 * Push the full claim set into the `claimed-buildings` overlay.
 *
 * Each footprint is inflated (see `inflateFootprint`) so the claimed extrusion
 * encloses the basemap building instead of sharing faces with it.
 */
export function syncClaimedBuildings(
  map: MapLibreMap,
  claims: ClaimedFeatureInput[],
): void {
  const source = map.getSource(CLAIMED_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;

  const features: Feature<Polygon | MultiPolygon>[] = claims.map((claim) => ({
    type: 'Feature',
    geometry: inflateFootprint(claim.geometry),
    properties: {
      osmId: claim.osmId,
      name: claim.name,
      type: claim.type,
      areaM2: claim.areaM2,
      // Numeric height fields drive the extrusion paint expressions above.
      render_height: claim.height,
      render_min_height: claim.minHeight,
    },
  }));

  source.setData({ type: 'FeatureCollection', features });
}

/** Hover outline offset, so the line clears the building wall instead of sharing its edge. */
const HOVER_WALL_INFLATION_M = 0.6;

/** Show (or clear) the hover outline for the building under the cursor. */
export function setHoveredBuilding(map: MapLibreMap, info: BuildingInfo | null): void {
  const source = map.getSource(HOVER_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;

  if (!info) {
    source.setData(emptyCollection());
    return;
  }

  source.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        // Inflated so the crisp line and its glow draw just outside the
        // extrusion silhouette; a line exactly on the footprint edge is half
        // hidden by the building wall itself under a pitched camera.
        geometry: inflateFootprint(info.geometry, HOVER_WALL_INFLATION_M),
        properties: { osmId: info.osmId },
      },
    ],
  });
}