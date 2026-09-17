// Temporary diagnostic: for probes at the centres of LARGE buildings, list every
// part Turf considers to contain the cursor, sorted by area. Reveals whether the
// big part is being seen at all by booleanPointInPolygon.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import area from '@turf/area';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

const TEMPLATE = 'https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf';
const LON = -0.1278;
const LAT = 51.5074;
const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const polysOf = (g) =>
  g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
const polyArea = (poly) =>
  area({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: {} });

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
  const geometry = f.toGeoJSON(lon2tile(LON, z), lat2tile(LAT, z), z).geometry;
  features.push({
    id: f.id,
    geometry,
    polys: polysOf(geometry),
    props: f.properties,
  });
}

// Probe the centres of the five largest single features.
const targets = [...features]
  .map((f) => ({ f, area: f.polys.reduce((n, p) => n + polyArea(p), 0) }))
  .sort((a, b) => b.area - a.area)
  .slice(0, 5);

for (const { f, area: featureArea } of targets) {
  const ring = f.polys[0][0];
  const cursor = [
    ring.reduce((s, p) => s + p[0], 0) / ring.length,
    ring.reduce((s, p) => s + p[1], 0) / ring.length,
  ];

  const containing = [];
  let partsScanned = 0;
  for (const candidate of features) {
    for (const poly of candidate.polys) {
      partsScanned += 1;
      const shape = { type: 'Polygon', coordinates: poly };
      if (booleanPointInPolygon(cursor, shape)) {
        containing.push({ id: candidate.id, area: polyArea(poly) });
      }
    }
  }
  containing.sort((a, b) => a.area - b.area);

  const own = containing.some((entry) => entry.id === f.id);
  console.log(
    `probe @ feature ${f.id} (${Math.round(featureArea)} m2, ${f.polys.length} parts): scanned ${partsScanned} parts`,
  );
  console.log(
    `  own part contains cursor per Turf: ${own ? 'YES' : 'NO'}  |  containing parts: ${containing.length}`,
  );
  console.log(
    `  smallest 6 containing areas: ${containing.slice(0, 6).map((e) => `${Math.round(e.area)}(id ${e.id})`).join(', ') || 'none'}`,
  );
  console.log('');
}