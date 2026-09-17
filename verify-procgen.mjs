// Temporary verification: exercise the REAL procedural building pipeline
// (classify.ts, parts.ts, recipes.ts) against edge cases, determinism, and
// real footprint shapes. Pure logic — no DOM, no WebGL.
const { classifyBuilding } = await import('./src/procgen/classify.ts');
const { createRng, orientedFrame } = await import('./src/procgen/parts.ts');
const { generateBuildingModel } = await import('./src/procgen/recipes.ts');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

// --- classification ----------------------------------------------------------
console.log('classification:');
check('5 m shed -> low-rise', classifyBuilding({ height: 5, areaM2: 300, type: '' }) === 'low-rise');
check('20 m block -> mid-rise', classifyBuilding({ height: 20, areaM2: 600, type: '' }) === 'mid-rise');
check('40 m block -> high-rise', classifyBuilding({ height: 40, areaM2: 900, type: '' }) === 'high-rise');
check('warehouse tag forces low-rise', classifyBuilding({ height: 9, areaM2: 800, type: 'warehouse' }) === 'low-rise');
check('sprawling 5000 m2 stays low-rise', classifyBuilding({ height: 15, areaM2: 5000, type: '' }) === 'low-rise');
check('apartments tag at 20 m -> high-rise', classifyBuilding({ height: 20, areaM2: 700, type: 'apartments' }) === 'high-rise');
check('case-insensitive tags', classifyBuilding({ height: 8, areaM2: 200, type: 'WAREHOUSE' }) === 'low-rise');

// --- RNG determinism ----------------------------------------------------------
console.log('rng:');
const seqA = Array.from({ length: 8 }, () => createRng('way/123')());
const seqB = Array.from({ length: 8 }, () => createRng('way/123')());
const seqC = Array.from({ length: 8 }, () => createRng('way/124')());
check('same seed -> same sequence', JSON.stringify(seqA) === JSON.stringify(seqB));
check('different seed -> different sequence', JSON.stringify(seqA) !== JSON.stringify(seqC));
check('all draws in [0,1)', seqA.every((v) => v >= 0 && v < 1));

// --- oriented frame -----------------------------------------------------------
console.log('oriented frame (60 m x 25 m rectangle rotated 30 deg, lat 51.5):');
const cos30 = Math.cos(Math.PI / 6), sin30 = Math.sin(Math.PI / 6);
const ring = [];
for (let i = 0; i < 4; i++) {
  const u = i === 0 || i === 3 ? 30 : -30;   // along principal axis
  const v = i < 2 ? 12.5 : -12.5;            // across
  const east = u * cos30 - v * sin30;
  const north = u * sin30 + v * cos30;
  ring.push([-0.1278 + east / (111320 * Math.cos((51.5 * Math.PI) / 180)), 51.5074 + north / 110540]);
}
const frame = orientedFrame(ring, 51.5);
check('width ~= 60 m', Math.abs(frame.widthM - 60) < 1.5, frame.widthM.toFixed(2));
check('depth ~= 25 m', Math.abs(frame.depthM - 25) < 1.5, frame.depthM.toFixed(2));
// The principal axis is at math angle +30 deg (CCW from east), which is
// bearing 90 - 30 = 60 deg clockwise from north. The axis is unoriented, so
// 60 + 180 = 240 deg is the same axis.
const bearingDeg = (frame.headingRad * 180) / Math.PI;
check('heading ~= 60 or 240 deg (axis is unoriented)',
  Math.min(Math.abs(bearingDeg - 60), Math.abs(bearingDeg - 240)) < 1.5, bearingDeg.toFixed(2));

// --- recipes -------------------------------------------------------------------
console.log('recipes:');
const geometry = {
  type: 'Polygon',
  coordinates: [ring.map(([lon, lat]) => [lon, lat]).concat([ring[0]])],
};
const input = {
  osmId: 'way/123',
  name: 'Test Building',
  type: 'warehouse',
  height: 8,
  areaM2: 1500,
  centroid: [-0.1278, 51.5074],
  geometry,
};
const model = generateBuildingModel(input);
const model2 = generateBuildingModel(input);

check('model regenerates identically (exterior parts count)',
  JSON.stringify(model.exterior) === JSON.stringify(model2.exterior),
  `${model.exterior.length} parts`);
check('warehouse gets a gable roof', model.exterior.some((p) => p.shape === 'gableRoof'));
check('warehouse has docks', model.exterior.some((p) => p.tag === 'dock'));
check('parts within footprint + 1 m overhang', model.exterior.every((p) => {
  const halfW = p.shape === 'box' ? p.size[0] / 2 : p.width / 2;
  const halfD = p.shape === 'box' ? p.size[2] / 2 : p.depth / 2;
  return halfW <= model.widthM / 2 + 1 && halfD <= model.depthM / 2 + 1;
}));
check('interior has floor slab + zones', model.interior.parts.length >= 1 && model.interior.zones.length >= 1);

for (const [label, h, area, type] of [
  ['mid-rise office', 24, 900, 'office'],
  ['high-rise tower', 55, 1200, 'commercial'],
]) {
  const m = generateBuildingModel({
    osmId: `way/${h}`, name: label, type, height: h, areaM2: area,
    centroid: [-0.1278, 51.5074], geometry,
  });
  const maxHeight = Math.max(...m.exterior.map((p) =>
    p.shape === 'box' ? p.position[1] + p.size[1] / 2 : p.position[1] + p.height));
  check(`${label}: total height ~= claim height`, Math.abs(maxHeight - h) < h * 0.15,
    `${maxHeight.toFixed(1)} vs ${h}`);
  check(`${label}: has glass window bands`, m.exterior.some((p) => p.material === 'glass'));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
