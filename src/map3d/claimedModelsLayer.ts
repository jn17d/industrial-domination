/**
 * MapLibre custom layer that renders procedural three.js models for every
 * visible building: unclaimed buildings get generic muted warehouses (ambient
 * models), claims get the full classified model. This replaces the basemap's
 * blank fill-extrusion blocks, which `main.ts` blanks via paint opacity.
 *
 * Camera sync strategy: MapLibre hands `render()` the world→clip matrix each
 * frame (mercator world space: x east, y south, z up). Each building keeps a
 * precomputed mercator-space transform (translate to centroid, metres→mercator
 * scale, axis remap, footprint heading) and the per-frame work is one matrix
 * multiply per building. No three.js camera controls are involved at all.
 */

import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap } from 'maplibre-gl';
import * as THREE from 'three';

import { classifyBuilding } from '../procgen/classify.ts';
import { AMBIENT_WAREHOUSE_STYLE, OFFICE_STYLE, TOWER_STYLE, WAREHOUSE_STYLE } from '../procgen/palettes.ts';
import type { Palette } from '../procgen/palettes.ts';
import { generateAmbientWarehouseModel, generateBuildingModel } from '../procgen/recipes.ts';
import type { RecipeInput } from '../procgen/recipes.ts';
import type { BuildingModel, MaterialKey } from '../procgen/parts.ts';

export const CLAIMED_MODELS_LAYER_ID = 'procedural-buildings-3d';

/** Reusable scratch objects so the render loop allocates nothing. */
const scratchProjection = new THREE.Matrix4();
const scratchTransform = new THREE.Matrix4();
const scratchRotationX = new THREE.Matrix4().makeRotationAxis(
  new THREE.Vector3(1, 0, 0),
  Math.PI / 2,
);
const scratchRotationY = new THREE.Matrix4();

/** Palette lookup by building class; ambient warehouses get their own. */
const PALETTES: Record<string, Palette> = {
  'low-rise': WAREHOUSE_STYLE.palette,
  'mid-rise': OFFICE_STYLE.palette,
  'high-rise': TOWER_STYLE.palette,
  ambient: AMBIENT_WAREHOUSE_STYLE.palette,
};

/**
 * Gable roof as an extruded triangle: profile in the local z/y plane, ridge
 * along local x, centred on the origin in x.
 */
function gableRoofGeometry(width: number, depth: number, height: number): THREE.BufferGeometry {
  const shape = new THREE.Shape([
    new THREE.Vector2(-depth / 2, 0),
    new THREE.Vector2(depth / 2, 0),
    new THREE.Vector2(0, height),
  ]);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(-width / 2, 0, 0);
  return geometry;
}

/**
 * Unit geometries shared by EVERY part of EVERY building: meshes carry their
 * dimensions in `mesh.scale` instead of baked into geometry. With hundreds of
 * viewport buildings, per-part BufferGeometry allocations (the old scheme)
 * would drown the GC; this way a building costs only its meshes.
 */
const unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
const unitGableGeometry = gableRoofGeometry(1, 1, 1);

/**
 * Materials cached globally by `${paletteId}:${materialKey}`: the whole scene
 * shares a handful of Lambert materials, so adding a building allocates only
 * meshes. These live for the page lifetime and must never be disposed while
 * placements exist.
 */
const materialCache = new Map<string, THREE.MeshLambertMaterial>();

function sharedMaterial(
  paletteId: string,
  key: MaterialKey,
  colors: Record<MaterialKey, string>,
): THREE.MeshLambertMaterial {
  const cacheKey = `${paletteId}:${key}`;
  let material = materialCache.get(cacheKey);
  if (!material) {
    material = new THREE.MeshLambertMaterial({
      color: new THREE.Color(colors[key] ?? '#cccccc'),
      // Glass reads as glass without alpha sorting against the map: a
      // slightly emissive tint instead of transparency.
      emissive: new THREE.Color(key === 'glass' ? (colors[key] ?? '#cccccc') : '#000000'),
      emissiveIntensity: key === 'glass' ? 0.35 : 0,
    });
    materialCache.set(cacheKey, material);
  }
  return material;
}

/** Build one three.js mesh per exterior part, geometry and materials shared. */
function buildPartMeshes(
  model: BuildingModel,
  paletteId: string,
  colors: Record<MaterialKey, string>,
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (const part of model.exterior) {
    const mesh =
      part.shape === 'box'
        ? new THREE.Mesh(unitBoxGeometry, sharedMaterial(paletteId, part.material, colors))
        : new THREE.Mesh(unitGableGeometry, sharedMaterial(paletteId, part.material, colors));
    if (part.shape === 'box') {
      mesh.scale.set(part.size[0], part.size[1], part.size[2]);
    } else {
      // Unit gable spans x∈[-½,½] (ridge axis), y∈[0,1] (height), z∈[-½,½]
      // (slope direction); scale maps it to the part's dimensions.
      mesh.scale.set(part.width, part.height, part.depth);
    }
    mesh.position.set(part.position[0], part.position[1], part.position[2]);
    if (part.shape === 'box' && part.rotationY) {
      mesh.rotation.y = part.rotationY;
    }
    // The projection-matrix trick below defeats three.js frustum culling, so
    // meshes must opt out or they vanish depending on camera angle.
    mesh.frustumCulled = false;
    meshes.push(mesh);
  }
  return meshes;
}

/** Per-building mercator-space transform, recomputed only when claims change. */
interface Placement {
  group: THREE.Group;
  /** MVP * (this matrix) = clip-space matrix for this building. */
  matrix: THREE.Matrix4;
}

export interface ProceduralModelsLayer {
  /** Rebuild the claimed buildings; call on any state change. */
  updateClaims: (claims: RecipeInput[]) => void;
  /**
   * Diff the ambient (unclaimed) warehouse models against the current viewport.
   * Call with the latest `collectViewportBuildings` result whenever the camera
   * settles or claims change; pass `[]` to empty the ambient scene (zoom gate).
   */
  updateAmbient: (buildings: RecipeInput[]) => void;
}

/**
 * Add the procedural-models layer to the map and return its update handles.
 * Call once per map — `onAdd` fires whether the map is loaded yet or not.
 */
export function addProceduralModelsLayer(map: MapLibreMap): ProceduralModelsLayer {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#44505c', 1.1));
  const sun = new THREE.DirectionalLight('#fff4e0', 1.4);
  sun.position.set(-1, 2, 1); // Fixed artistic direction, not geographic.
  scene.add(sun);

  const camera = new THREE.Camera();
  camera.matrixAutoUpdate = false;

  const claimPlacements = new Map<string, Placement>();
  const ambientPlacements = new Map<string, Placement>();
  let renderer: THREE.WebGLRenderer | null = null;
  let reportedFirstRender = false;

  const layer: CustomLayerInterface = {
    id: CLAIMED_MODELS_LAYER_ID,
    type: 'custom',
    renderingMode: '3d',
    onAdd(_map: MapLibreMap, gl: WebGL2RenderingContext) {
      // Share MapLibre's GL context and canvas; autoClear must stay off or
      // every frame would wipe the already-drawn map.
      renderer = new THREE.WebGLRenderer({ canvas: _map.getCanvas(), context: gl });
      renderer.autoClear = false;
    },
    render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
      if (!renderer) return;
      // MapLibre v6: `defaultProjectionData.mainMatrix` maps mercator world
      // coordinates ([0,0]=top-left, [1,1]=bottom-right, z conformal) to clip
      // space — exactly the space the building placements live in. The older
      // `args.modelViewProjectionMatrix` field targets a different internal
      // space in v6 and yields a degenerate matrix here (models invisible).
      scratchProjection.fromArray(args.defaultProjectionData.mainMatrix);

      // Single projection application: MapLibre's world→clip matrix lives on
      // the camera; each building group carries only its mercator transform.
      // (Baking MVP into the group matrices AS WELL would apply the projection
      // twice and collapse every vertex into degenerate clip space.)
      camera.projectionMatrix.copy(scratchProjection);
      camera.projectionMatrixInverse.copy(scratchProjection).invert();

      renderer.resetState();
      renderer.render(scene, camera);
      renderer.resetState();

      // One-time sanity signal so "claimed but blank" is diagnosable in the
      // console instead of silent: models present and actually rasterized.
      if (
        !reportedFirstRender &&
        claimPlacements.size + ambientPlacements.size > 0
      ) {
        reportedFirstRender = true;
        const buildings = claimPlacements.size + ambientPlacements.size;
        const triangles = renderer.info.render.triangles;
        if (triangles > 0) {
          console.info(
            `[procedural-models] rendering ${buildings} building(s), ${triangles} triangles`,
          );
        } else {
          console.warn('[claimed-models] placements exist but 0 triangles drawn');
        }
      }
    },
  };

  map.addLayer(layer);

  /**
   * Build a building's group, place it in mercator space, and record it.
   * Shared geometry/materials mean removal must NOT dispose GPU resources.
   */
  const placeBuilding = (
    key: string,
    input: RecipeInput,
    paletteId: string,
    model: BuildingModel,
    into: Map<string, Placement>,
  ): void => {
    const colors = PALETTES[paletteId].colors;
    const group = new THREE.Group();
    for (const mesh of buildPartMeshes(model, paletteId, colors)) group.add(mesh);
    group.matrixAutoUpdate = false;
    scene.add(group);

    // Mercator transform: translate to the centroid, scale metres to mercator
    // units (y negated: mercator y grows south, model y is up), remap model
    // axes (Rx), then apply the footprint heading (Ry).
    const mercator = MercatorCoordinate.fromLngLat([input.centroid[0], input.centroid[1]], 0);
    const scale = mercator.meterInMercatorCoordinateUnits();
    scratchTransform.makeTranslation(mercator.x, mercator.y, mercator.z);
    scratchTransform.scale(new THREE.Vector3(scale, -scale, scale));
    // Building parts that float above ground (`render_min_height`) must be
    // lifted by that base; mercator z shares the metre→mercator scale.
    scratchTransform.elements[14] += (input.minHeight ?? 0) * scale;
    // -π/2 first aligns the authored x axis with north, then rotate by the
    // measured principal-axis bearing.
    scratchRotationY.makeRotationY(model.headingRad - Math.PI / 2);
    scratchTransform.multiply(scratchRotationX).multiply(scratchRotationY);

    // The projection lives on the camera (see render()); the group carries
    // only this mercator transform, assigned once — no per-frame work.
    group.matrix.copy(scratchTransform);
    // With matrixAutoUpdate=false, three.js copies matrix→matrixWorld only
    // when this flag is set; without it matrixWorld stays identity and the
    // model silently renders at mercator (0,0) — off-screen at any real
    // camera. updateMatrix() can't be used here because it recomposes
    // `matrix` from position/quaternion/scale, which would wipe the
    // transform we just copied.
    group.matrixWorldNeedsUpdate = true;
    into.set(key, { group, matrix: scratchTransform.clone() });
  };

  /** Drop placements absent from `keep`; nothing is disposed (all shared). Returns true if anything changed. */
  const removeMissing = (into: Map<string, Placement>, keep: Set<string>): boolean => {
    let changed = false;
    for (const [key, placement] of into) {
      if (keep.has(key)) continue;
      scene.remove(placement.group);
      into.delete(key);
      changed = true;
    }
    return changed;
  };

  return {
    updateClaims(claims: RecipeInput[]) {
      const seen = new Set<string>();
      let changed = false;
      for (const claim of claims) {
        seen.add(claim.osmId);
        if (claimPlacements.has(claim.osmId)) continue;
        placeBuilding(
          claim.osmId,
          claim,
          classifyBuilding(claim),
          generateBuildingModel(claim),
          claimPlacements,
        );
        changed = true;
      }
      // Only repaint when the scene actually changed: `refreshAmbient` runs on
      // every map `idle` event, and an unconditional triggerRepaint here would
      // loop idle → refresh → repaint → idle forever at full frame rate.
      changed = removeMissing(claimPlacements, seen) || changed;
      if (changed) map.triggerRepaint();
    },

    updateAmbient(buildings: RecipeInput[]) {
      const seen = new Set<string>();
      let changed = false;
      for (const building of buildings) {
        // Claimed buildings render their full model; never double up with an
        // ambient twin on the same footprint.
        if (claimPlacements.has(building.osmId)) continue;
        seen.add(building.osmId);
        if (ambientPlacements.has(building.osmId)) continue;
        placeBuilding(
          building.osmId,
          building,
          'ambient',
          generateAmbientWarehouseModel(building),
          ambientPlacements,
        );
        changed = true;
      }
      changed = removeMissing(ambientPlacements, seen) || changed;
      if (changed) map.triggerRepaint();
    },
  };
}
