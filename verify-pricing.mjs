// Temporary verification: exercise the REAL priceForBuilding() from src/state.ts
// against edge cases and the real footprint distribution from an OpenFreeMap tile.
// `window` is stubbed because state.ts touches localStorage at module load.
globalThis.window = {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};

const { priceForBuilding, STARTING_CASH, PRICE_PER_SQUARE_METRE, MIN_CLAIM_PRICE } =
  await import('./src/state.ts');
const { pickBuildingAt } = await import('./src/buildings.ts');
const { default: booleanPointInPolygon } = await import('@turf/boolean-point-in-polygon');
const { VectorTile } = await import('@mapbox/vector-tile');
const { PbfReader } = await import('pbf');

console.log(`rate: $${PRICE_PER_SQUARE_METRE}/m2  floor: $${MIN_CLAIM_PRICE}  starting cash: $${STARTING_CASH}\n`);

// --- edge cases -----------------------------------------------------------
const edges = [0, 1, 5, 5.4, 10, 12.34, 25, 66, 66.7, 100, 2128, 14439, 365237];
let monotonic = true;
let previous = 0;
let allOk = true;
for (const area of edges) {
  const price = priceForBuilding({ areaM2: area });
  if (price < previous) monotonic = false;
  previous = price;
  const expectedMin = Math.max(MIN_CLAIM_PRICE, Math.ceil(area * PRICE_PER_SQUARE_METRE));
  if (price < expectedMin) allOk = false;
  console.log(
    `  ${String(area).padStart(7)} m2 -> $${String(price).padStart(7)}  (raw $${(area * PRICE_PER_SQUARE_METRE).toFixed(2)})`,
  );
}
console.log(
  `\nmonotonically non-decreasing: ${monotonic ? 'yes' : 'NO'}  |  never below area x rate or floor: ${allOk ? 'yes' : 'NO'}`,
);

// --- real distribution ----------------------------------------------------
const TEMPLATE = 'https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf';
const LON = -0.1278;
const LAT = 51.5074;
const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const z = 14;
const tile = new VectorTile(
  new PbfReader(
    new Uint8Array(
      await fetch(
        TEMPLATE.replace('{z}', z).replace('{x}', lon2tile(LON, z)).replace('{y}', lat2tile(LAT, z)),
      ).then((r) => r.arrayBuffer()),
    ),
  ),
);
const layer = tile.layers.building;
const features = [];
for (let i = 0; i < layer.length; i += 1) {
  const f = layer.feature(i);
  features.push({
    type: 'Feature',
    id: f.id,
    geometry: f.toGeoJSON(lon2tile(LON, z), lat2tile(LAT, z), z).geometry,
    properties: f.properties,
    layer: { id: 'building-3d' },
    source: 'openmaptiles',
    sourceLayer: 'building',
    state: {},
  });
}

// MapLibre's queryRenderedFeatures only returns features whose rendered geometry
// covers the cursor, so mimic that here: pre-filter by containment before
// ranking, otherwise every feature in the tile competes and the smallest sliver
// in the tile always wins for every probe.
const candidatesAt = (pt) =>
  features.filter((f) => {
    const parts =
      f.geometry.type === 'Polygon'
        ? [f.geometry]
        : f.geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }));
    return parts.some((part) => booleanPointInPolygon(pt, part));
  });

const prices = [];
const areas = [];
const samples = [];
for (const f of features) {
  const poly = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates[0];
  const ring = poly?.[0];
  if (!ring) continue;
  const center = [
    ring.reduce((s, p) => s + p[0], 0) / ring.length,
    ring.reduce((s, p) => s + p[1], 0) / ring.length,
  ];
  if (!pointInRing(center, ring)) continue;
  const candidates = candidatesAt(center);
  if (candidates.length === 0) continue;
  const info = pickBuildingAt(candidates, center);
  if (info) {
    prices.push(priceForBuilding(info));
    areas.push(info.areaM2);
    samples.push(info);
  }
}
prices.sort((a, b) => a - b);
areas.sort((a, b) => a - b);

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const affordable = prices.filter((p) => p <= STARTING_CASH).length;

console.log(`\nclaimable footprints sampled: ${prices.length}`);
console.log(
  `selected area m2  min=${pct(areas, 0).toFixed(1)}  p25=${pct(areas, 0.25).toFixed(1)}  median=${pct(areas, 0.5).toFixed(1)}  p75=${pct(areas, 0.75).toFixed(1)}  p90=${pct(areas, 0.9).toFixed(1)}  max=${pct(areas, 1).toFixed(1)}`,
);
console.log(`selected areas <= 10 m2: ${areas.filter((a) => a <= 10).length}/${areas.length}`);
console.log('\nsample selections:');
const metresPerLat = 110540;
for (const info of samples.slice(0, 5)) {
  const poly =
    info.geometry.type === 'Polygon'
      ? info.geometry.coordinates
      : [info.geometry.coordinates[0][0]];
  const ring = poly[0];
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const widthM = (Math.max(...lons) - Math.min(...lons)) * 111320 * Math.cos((LAT * Math.PI) / 180);
  const heightM = (Math.max(...lats) - Math.min(...lats)) * metresPerLat;
  const bboxArea = Math.round(widthM * heightM);
  const verts =
    info.geometry.type === 'Polygon'
      ? info.geometry.coordinates[0].length
      : info.geometry.coordinates.reduce((n, p) => n + p[0].length, 0);
  console.log(
    `  osm=${info.osmFeatureId} type=${info.type} height=${info.height} verts=${verts} turfArea=${info.areaM2.toFixed(1)} m2 bbox=${Math.round(widthM)}x${Math.round(heightM)} m (bbox area ${bboxArea} m2) price=$${priceForBuilding(info)}`,
  );
}
console.log(
  `price  min=$${pct(prices, 0)}  p25=$${pct(prices, 0.25)}  median=$${pct(prices, 0.5)}  p75=$${pct(prices, 0.75)}  p90=$${pct(prices, 0.9)}  max=$${pct(prices, 1)}`,
);
console.log(
  `affordable at $${STARTING_CASH} starting cash: ${affordable}/${prices.length} (${Math.round((affordable / prices.length) * 100)}%)`,
);