/**
 * Procedural building recipes: claim → parts list.
 *
 * One recipe per size class (warehouse / office / tower). Each recipe is pure
 * and deterministic: the same claim key always yields the same building, so
 * nothing about the model needs to be persisted. All look-and-feel knobs come
 * from `palettes.ts`, which is the intended art-direction surface.
 */

import { classifyBuilding } from './classify.ts';
import type { BuildingClass } from './classify.ts';
import {
  AMBIENT_WAREHOUSE_STYLE,
  INTERIOR_STYLE,
  OFFICE_STYLE,
  TOWER_STYLE,
  WAREHOUSE_STYLE,
} from './palettes.ts';
import type { OfficeStyle, TowerStyle, WarehouseStyle } from './palettes.ts';
import {
  createRng,
  largestRing,
  orientedFrame,
  rngChance,
} from './parts.ts';
import type { BuildingModel, InteriorModel, InteriorZone, Part } from './parts.ts';
import type { Polygon, MultiPolygon } from 'geojson';

/** Everything a recipe needs; structural twin of the persisted ClaimRecord. */
export interface RecipeInput {
  /** Stable claim key — also the determinism seed. */
  osmId: string;
  name: string;
  type: string;
  /** Metres, from the tile `render_height` field. */
  height: number;
  /** Metres; extrusion base for building parts that float above ground. */
  minHeight?: number;
  areaM2: number;
  /** Centroid [lon, lat]; the latitude fixes the metres-per-degree scale. */
  centroid: [number, number];
  geometry: Polygon | MultiPolygon;
}

/**
 * Warehouse: one big hall with a gable roof, loading docks along a long wall,
 * an optional office annex on a corner, and rooftop HVAC units.
 */
function warehouseRecipe(
  width: number,
  depth: number,
  height: number,
  rng: () => number,
  style: WarehouseStyle,
): { exterior: Part[]; interior: InteriorModel } {
  const parts: Part[] = [];
  const long = Math.max(width, depth);
  const short = Math.min(width, depth);

  // Recipes author in "long axis = x" space; the caller swaps the frame if the
  // footprint's principal axis was the other one.
  const w = long;
  const d = short;
  const hallHeight = Math.max(4, Math.min(height, 14));

  parts.push({
    shape: 'box',
    size: [w, hallHeight, d],
    position: [0, hallHeight / 2, 0],
    material: 'siding',
    tag: 'structure',
  });

  const roofHeight = Math.max(0.5, style.roofPitch * d);
  parts.push({
    shape: 'gableRoof',
    width: w + 2 * style.roofOverhangM,
    depth: d + 2 * style.roofOverhangM,
    height: roofHeight,
    position: [0, hallHeight, 0],
    material: 'roof',
    tag: 'roof',
  });

  // Loading docks: accent panels set slightly into the +z wall.
  const dockCount =
    style.docks === 'auto' ? Math.max(1, Math.min(6, Math.floor(w / 8))) : style.docks;
  const dockWidth = Math.min(3.5, w / (dockCount + 1));
  const dockHeight = Math.min(3.2, hallHeight * 0.45);
  for (let i = 0; i < dockCount; i++) {
    const x = -w / 2 + ((i + 1) * w) / (dockCount + 1);
    parts.push({
      shape: 'box',
      size: [dockWidth, dockHeight, 0.3],
      position: [x, dockHeight / 2, d / 2],
      material: 'accent',
      tag: 'dock',
    });
  }

  // Office annex on a random corner, outside the hall volume.
  if (rngChance(rng, style.annexChance)) {
    const annexW = Math.min(10, w * 0.3);
    const annexD = Math.min(8, d * 0.6);
    const annexH = Math.min(3.6, hallHeight * 0.7);
    const cornerX = rngChance(rng, 0.5) ? -1 : 1;
    parts.push({
      shape: 'box',
      size: [annexW, annexH, annexD],
      position: [(cornerX * (w - annexW)) / 2, annexH / 2, -d / 2 - annexD / 2 + 0.2],
      material: 'trim',
      tag: 'annex',
    });
    parts.push({
      shape: 'box',
      size: [annexW * 0.6, 1.2, 0.2],
      position: [(cornerX * (w - annexW)) / 2, annexH + 0.6, -d / 2 - annexD + 0.15],
      material: 'glass',
      tag: 'window',
    });
  }

  // Rooftop HVAC units, deterministic count and placement.
  const hvacCount = Math.max(0, Math.round((w * d * style.hvacPer1000M2) / 1000));
  for (let i = 0; i < hvacCount; i++) {
    const hx = (rng() - 0.5) * (w * 0.7);
    const hz = (rng() - 0.5) * (d * 0.5);
    const unitH = 1 + rng() * 1.2;
    parts.push({
      shape: 'box',
      size: [2 + rng() * 2, unitH, 1.6 + rng() * 1.4],
      position: [hx, hallHeight + roofHeight + unitH / 2, hz],
      material: 'concrete',
      tag: 'hvac',
    });
  }

  if (style.skylight) {
    parts.push({
      shape: 'box',
      size: [w * 0.55, 0.3, 1.2],
      position: [0, hallHeight + roofHeight - 0.2, 0],
      material: 'glass',
      tag: 'skylight',
    });
  }

  const interior: InteriorModel = {
    storeys: 1,
    storeyHeightM: hallHeight,
    parts: [
      {
        shape: 'box',
        size: [w, INTERIOR_STYLE.slabThicknessM, d],
        position: [0, 0, 0],
        material: 'interiorFloor',
        tag: 'floor',
      },
    ],
    zones: [
      // Open machine bay fills most of the hall; the dock-adjacent strip is
      // storage, and the annex (if present) is offices — zones are gameplay
      // hooks, so keep them coarse for now.
      { kind: 'machineBay', rect: [-w / 2 + 1, -d / 2 + 1, w - 2, d * 0.55] },
      { kind: 'storage', rect: [-w / 2 + 1, d / 2 - d * 0.3, w - 2, d * 0.3 - 1] },
    ],
  };

  return { exterior: parts, interior };
}

/**
 * Mid-rise office: a street-level plinth, a window-banded tower block, a
 * parapet lip and a rooftop mechanical penthouse. Storey plates + a column
 * grid make the interior.
 */
function officeRecipe(
  width: number,
  depth: number,
  height: number,
  rng: () => number,
  style: OfficeStyle,
): { exterior: Part[]; interior: InteriorModel } {
  const parts: Part[] = [];
  const w = width;
  const d = depth;
  const storeys = Math.max(2, Math.round(height / INTERIOR_STYLE.officeStoreyHeightM));
  const storeyH = height / storeys;

  const plinthH = Math.max(4, storeyH * 1.25);
  const pw = w * style.plinthFootprintFraction;
  const pd = d * style.plinthFootprintFraction;
  parts.push({
    shape: 'box',
    size: [pw, plinthH, pd],
    position: [0, plinthH / 2, 0],
    material: 'concrete',
    tag: 'structure',
  });

  const towerH = height - plinthH;
  const tw = w;
  const td = d;
  parts.push({
    shape: 'box',
    size: [tw, towerH, td],
    position: [0, plinthH + towerH / 2, 0],
    material: 'siding',
    tag: 'structure',
  });

  // Horizontal window bands wrapping the tower: thin glass boxes protruding
  // just past the wall, alternating with spandrel gaps.
  const bandPeriod = storeyH;
  const bandH = bandPeriod * style.windowBandCoverage;
  const bands = Math.max(1, Math.floor(towerH / bandPeriod));
  for (let i = 0; i < bands; i++) {
    const y = plinthH + i * bandPeriod + bandH / 2;
    parts.push({
      shape: 'box',
      size: [tw + style.windowBandDepthM, bandH, td + style.windowBandDepthM],
      position: [0, y, 0],
      material: 'glass',
      tag: 'window',
    });
  }

  if (style.parapet) {
    parts.push({
      shape: 'box',
      size: [tw + 0.3, 0.8, td + 0.3],
      position: [0, height + 0.4, 0],
      material: 'trim',
      tag: 'parapet',
    });
  }

  parts.push({
    shape: 'box',
    size: [tw * 0.4, style.penthouseHeightM, td * 0.4],
    position: [(rng() - 0.5) * tw * 0.3, height + style.penthouseHeightM / 2, (rng() - 0.5) * td * 0.3],
    material: 'roof',
    tag: 'hvac',
  });

  // Interior: floor plate per storey plus a coarse column grid, sized in whole
  // grid cells so columns land symmetrically.
  const interiorParts: Part[] = [];
  for (let s = 0; s < storeys; s++) {
    interiorParts.push({
      shape: 'box',
      size: [w, INTERIOR_STYLE.slabThicknessM, d],
      position: [0, s * storeyH, 0],
      material: 'interiorFloor',
      tag: 'floor',
    });
  }
  const cellsX = Math.max(1, Math.round(w / INTERIOR_STYLE.columnGridM));
  const cellsZ = Math.max(1, Math.round(d / INTERIOR_STYLE.columnGridM));
  for (let i = 0; i <= cellsX; i++) {
    for (let j = 0; j <= cellsZ; j++) {
      if (i > 0 && i < cellsX && j > 0 && j < cellsZ && (i + j) % 2 === 1) continue;
      interiorParts.push({
        shape: 'box',
        size: [0.5, storeys * storeyH, 0.5],
        position: [-w / 2 + (i * w) / cellsX, (storeys * storeyH) / 2, -d / 2 + (j * d) / cellsZ],
        material: 'concrete',
        tag: 'column',
      });
    }
  }

  const zones: InteriorZone[] = [{ kind: 'lobby', rect: [-w / 2 + 1, -d / 2 + 1, w - 2, d - 2] }];
  if (storeys > 1) {
    zones.push({ kind: 'office', rect: [-w / 2 + 1, -d / 2 + 1, w - 2, d - 2] });
  }

  return { exterior: parts, interior: { storeys, storeyHeightM: storeyH, parts: interiorParts, zones } };
}

/**
 * High-rise tower: stacked setback tiers, banded glazing, a service core and
 * a crown. Same interior treatment as the office but with a services core.
 */
function towerRecipe(
  width: number,
  depth: number,
  height: number,
  style: TowerStyle,
): { exterior: Part[]; interior: InteriorModel } {
  const parts: Part[] = [];
  const storeys = Math.max(4, Math.round(height / INTERIOR_STYLE.officeStoreyHeightM));
  const storeyH = height / storeys;

  const tierCount = Math.min(style.maxTiers, Math.max(1, Math.round(height / 25)));
  const baseH = (height - style.crownHeightM) / (tierCount * (1 + (1 - style.tierShrink) / 2));

  let y = 0;
  let tw = width;
  let td = depth;
  for (let t = 0; t < tierCount; t++) {
    const tierH = baseH * (1 - (t * (1 - style.tierShrink)) / 2);
    parts.push({
      shape: 'box',
      size: [tw, tierH, td],
      position: [0, y + tierH / 2, 0],
      material: 'siding',
      tag: 'structure',
    });

    const bands = Math.max(1, Math.floor(tierH / storeyH));
    for (let i = 0; i < bands; i++) {
      const by = y + i * storeyH + storeyH * 0.6;
      parts.push({
        shape: 'box',
        size: [tw + style.windowBandDepthM, storeyH * 0.5, td + style.windowBandDepthM],
        position: [0, by, 0],
        material: 'glass',
        tag: 'window',
      });
    }

    y += tierH;
    tw *= style.tierShrink;
    td *= style.tierShrink;
  }

  // Crown box, slightly inset from the top tier.
  parts.push({
    shape: 'box',
    size: [tw * 0.6, style.crownHeightM, td * 0.6],
    position: [0, y + style.crownHeightM / 2, 0],
    material: 'accent',
    tag: 'crown',
  });

  const interiorParts: Part[] = [];
  for (let s = 0; s < storeys; s++) {
    interiorParts.push({
      shape: 'box',
      size: [width, INTERIOR_STYLE.slabThicknessM, depth],
      position: [0, s * storeyH, 0],
      material: 'interiorFloor',
      tag: 'floor',
    });
  }
  // Central services core.
  interiorParts.push({
    shape: 'box',
    size: [width * 0.25, storeys * storeyH, depth * 0.25],
    position: [0, (storeys * storeyH) / 2, 0],
    material: 'concrete',
    tag: 'core',
  });

  const zones: InteriorZone[] = [
    { kind: 'lobby', rect: [-width / 2 + 1, -depth / 2 + 1, width - 2, depth - 2] },
    { kind: 'services', rect: [-(width * 0.125), -(depth * 0.125), width * 0.25, depth * 0.25] },
    { kind: 'office', rect: [-width / 2 + 1, -depth / 2 + 1, width - 2, depth - 2] },
  ];

  return { exterior: parts, interior: { storeys, storeyHeightM: storeyH, parts: interiorParts, zones } };
}

/**
 * Generate the procedural model for a claim.
 *
 * Deterministic: the claim's `osmId` seeds every random decision, so the same
 * building is regenerated identically on every load.
 */
export function generateBuildingModel(input: RecipeInput): BuildingModel {
  const ring = largestRing(input.geometry);
  const frame = orientedFrame(ring, input.centroid[1]);
  const rng = createRng(input.osmId);
  const buildingClass = classifyBuilding(input);

  // Recipes author with the long axis on x; swap the frame to match.
  const longOnX = frame.widthM >= frame.depthM;
  const width = Math.max(4, longOnX ? frame.widthM : frame.depthM);
  const depth = Math.max(4, longOnX ? frame.depthM : frame.widthM);
  const headingRad = longOnX ? frame.headingRad : frame.headingRad + Math.PI / 2;

  let built: { exterior: Part[]; interior: InteriorModel };
  switch (buildingClass) {
    case 'low-rise':
      built = warehouseRecipe(width, depth, input.height, rng, WAREHOUSE_STYLE);
      break;
    case 'mid-rise':
      built = officeRecipe(width, depth, input.height, rng, OFFICE_STYLE);
      break;
    case 'high-rise':
      built = towerRecipe(width, depth, input.height, TOWER_STYLE);
      break;
  }

  return {
    widthM: width,
    depthM: depth,
    headingRad: ((headingRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
    exterior: built.exterior,
    interior: built.interior,
  };
}

/**
 * Generic warehouse for an UNCLAIMED viewport building. Always the warehouse
 * recipe with the muted `AMBIENT_WAREHOUSE_STYLE` — claiming swaps the building
 * to the full classified model via `generateBuildingModel`. Same determinism
 * contract (seeded by `osmId`).
 */
export function generateAmbientWarehouseModel(input: RecipeInput): BuildingModel {
  const ring = largestRing(input.geometry);
  const frame = orientedFrame(ring, input.centroid[1]);
  const rng = createRng(input.osmId);

  const longOnX = frame.widthM >= frame.depthM;
  const width = Math.max(4, longOnX ? frame.widthM : frame.depthM);
  const depth = Math.max(4, longOnX ? frame.depthM : frame.widthM);
  const headingRad = longOnX ? frame.headingRad : frame.headingRad + Math.PI / 2;

  const built = warehouseRecipe(width, depth, input.height, rng, AMBIENT_WAREHOUSE_STYLE);

  return {
    widthM: width,
    depthM: depth,
    headingRad: ((headingRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
    exterior: built.exterior,
    interior: built.interior,
  };
}

/** Size class for a claim, re-exported for callers that only need the label. */
export function buildingClassFor(input: RecipeInput): BuildingClass {
  return classifyBuilding(input);
}

