import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import area from '@turf/area';
import buffer from '@turf/buffer';
import centroid from '@turf/centroid';
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
const CLAIMED_OUTLINE_LAYER_ID = 'claimed-buildings-outline';
const CLAIMED_EXTRUSION_LAYER_ID = 'claimed-buildings-3d';

const HOVER_SOURCE_ID = 'building-hover';
const HOVER_LAYER_ID = 'building-hover-outline';

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
const CLAIMED_WALL_INFLATION_M = 0.6;
const CLAIMED_HEIGHT_EPSILON = 1.2;
const CLAIMED_BASE_EPSILON = 0.4;

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
function partClaimId(part: Polygon): string {
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
 * Push a footprint outward so the claimed extrusion's walls cannot be coplanar
 * with the basemap building's.
 *
 * This runs on the render path only: stored claims keep their true footprint, so
 * claim identity and the reported area are unaffected by the inflation. Buffering
 * can fail on malformed geometry, so the original footprint is the fallback.
 */
function inflateFootprint(geometry: Polygon | MultiPolygon): Polygon | MultiPolygon {
  try {
    const buffered = buffer(asFeature(geometry), CLAIMED_WALL_INFLATION_M, {
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
 * Reduce a footprint to the single part the cursor is actually over.
 *
 * OpenMapTiles merges large OSM `type=multipolygon` building relations into one
 * feature. In a central-London z14 tile, 285 of 510 building features are
 * multi-part and a single relation carries 994 polygons covering 365,237 m2 —
 * so claiming a feature wholesale paints a whole neighbourhood, and one small
 * building there resolves to *only* that giant relation.
 *
 * Containment is tested against the ground point under the cursor. Because a
 * pitched camera means a click on a tall building's roof unprojects slightly
 * behind its footprint, a part that fails containment falls back to the nearest
 * one by centre distance rather than producing no selection at all.
 */
function selectPartUnderCursor(
  geometry: Polygon | MultiPolygon,
  cursor: [number, number],
): Polygon {
  const parts = splitIntoPolygons(geometry);
  if (parts.length === 1) return parts[0];

  // Bounding-box prefilter: a merged relation can hold ~1000 parts, and this
  // runs per animation frame while hovering. The area is taken once here rather
  // than recomputed during ranking.
  const containing: { part: Polygon; areaM2: number }[] = [];
  for (const part of parts) {
    if (!bboxContains(part.coordinates[0], cursor)) continue;
    if (!booleanPointInPolygon(cursor, part)) continue;
    containing.push({ part, areaM2: area(asFeature(part)) });
  }

  // Degenerate rings exist in OSM data; without this a claim could render as an
  // invisible sliver even though something contains the cursor.
  const usable = containing.filter((entry) => entry.areaM2 >= MIN_CLAIMABLE_AREA_M2);
  if (usable.length > 0) {
    return usable.reduce((best, entry) => (entry.areaM2 < best.areaM2 ? entry : best)).part;
  }

  if (containing.length > 0) return containing[0].part;

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
 * Choose the building under the cursor from raw query results.
 *
 * Candidates overlap often (a merged relation plus standalone footprints beneath
 * it), so render order is not trustworthy here: the smallest resolved part wins.
 * MapLibre orders results by render order, which for fill-extrusions accounts for
 * 3D depth, so the first candidate still wins ties. The same footprint can appear
 * twice, once per resolved layer, hence the id dedupe.
 */
export function pickBuildingAt(
  features: MapGeoJSONFeature[],
  cursor: [number, number],
): BuildingInfo | null {
  const seen = new Set<string>();
  let best: BuildingInfo | null = null;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') continue;

    const id = getFeatureId(feature);
    if (seen.has(id)) continue;
    seen.add(id);

    const part = selectPartUnderCursor(geometry, cursor);
    const partArea = area(asFeature(part));
    // A claim that cannot be seen is worse than no claim: skip degenerate
    // geometry rather than painting an invisible sliver.
    if (partArea < MIN_CLAIMABLE_AREA_M2) continue;
    if (partArea >= bestArea && best !== null) continue;

    bestArea = partArea;
    best = toBuildingInfo(feature, part, partClaimId(part));
  }

  return best;
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

  if (!map.getLayer(HOVER_LAYER_ID)) {
    map.addLayer(
      {
        id: HOVER_LAYER_ID,
        type: 'line',
        source: HOVER_SOURCE_ID,
        paint: {
          'line-color': HOVER_COLOR,
          'line-width': 2,
          'line-opacity': 0.95,
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
        geometry: info.geometry,
        properties: { osmId: info.osmId },
      },
    ],
  });
}