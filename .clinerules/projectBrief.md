# Project Brief — Industrial Domination

> Standing context for every session. Read this before touching the code.

## What this project is

A web-based industrial tycoon game played on **real-world map data**. Players search
for a place, inspect real building footprints (from OpenStreetMap), buy/claim them,
and build an industrial empire on top of the real world. Claimed buildings get
procedurally generated 3D models rendered over the map.

## Core loop (founding scope)

1. Search a location (geocoding), fly the camera there.
2. Hover/click real building footprints; a stats card shows metadata + price.
3. Claim (buy) buildings with cash; claimed buildings are persisted to localStorage.
4. Claimed buildings render as procedural three.js models instead of the basemap
   extrusion (see `src/map3d/claimedModelsLayer.ts`).

## Planned features (scope will grow; do NOT build these yet unless asked)

- **Interacting with 3D models on the map** — the flagship long-term feature:
  - Build and operate **factories** on claimed plots
  - Run **mines**
  - Build **farms**
  - **Expand plots** around owned land
- Production chains, resources, economy, upgrades — follow naturally from the above.

## Rendering & provider decision record

**Decision (2026-09): Option 1 — push through with MapLibre + OpenFreeMap + three.js.**

- The tile **provider (OpenFreeMap) is NOT the 3D bottleneck** — it only serves
  vector tiles (footprints + `render_height`). All 3D compositing happens in
  MapLibre via a custom layer, which already works. Do not churn providers.
- Stack: **MapLibre GL JS v6** (engine) + **OpenFreeMap/OpenMapTiles** (tiles,
  keyless, free) + **three.js** (models via `CustomLayerInterface`, camera synced
  from MapLibre's mercator world→clip matrix each frame).
- Known gaps to engineer around as 3D interaction grows (engine issues, not
  provider issues):
  - `queryRenderedFeatures` cannot see custom-layer geometry — 3D model picking
    must be done by raycasting three.js meshes using the synced projection matrix.
  - No shared depth buffer with the basemap — occlusion/z-fighting vs basemap
    building extrusions must be managed (currently mitigated by hiding the
    claimed extrusion/fill layers).
  - No dynamic lighting/shadows on the basemap; camera constrained to MapLibre
    (max pitch 85°).
- Escape hatches if this becomes painful, in order:
  1. MapLibre v6's native 3D model layer (glTF) for static models.
  2. deck.gl `ScenegraphLayer` on top of MapLibre (built-in picking).
  3. Long-term only: CesiumJS or a full game engine — revisit after the core
     claim → build → produce loop is fun.

## Tech stack

- Vite + TypeScript (strict), no UI framework.
- `maplibre-gl` v6 (ESM-only; worker MUST go through Vite's `?worker&url`
  pipeline — see the comment atop `src/map.ts` or production builds load no tiles).
- `three` for procedural 3D models.
- `@turf/*` for footprint geometry math (area, centroid, buffer, union, intersect,
  point-in-polygon).
- WebGL2 required (MapLibre v6 throws `GPUInitializationError` without it).

## File map

| Path | Role |
|---|---|
| `src/main.ts` | Wiring: map lifecycle, search, selection, claim flow, HUD sync |
| `src/map.ts` | MapLibre setup, style, camera, hover/click picking of buildings |
| `src/buildings.ts` | Building domain model, overlay layers (claimed/hover), footprint growth & inflation |
| `src/map3d/claimedModelsLayer.ts` | three.js custom layer rendering procedural models for claims |
| `src/procgen/` | Procedural building models: `classify.ts`, `recipes.ts`, `parts.ts`, `palettes.ts` |
| `src/state.ts` | Game state: cash, claims, pricing, localStorage persistence (versioned) |
| `src/ui.ts` | DOM UI: HUD, stats card, search, toasts |
| `src/search.ts` | Geocoding search |

## Conventions & gotchas

- **Attribution is mandatory**: OpenFreeMap + OpenMapTiles + OpenStreetMap links
  (see `ATTRIBUTION` in `src/map.ts`).
- **Claim keys are NOT raw OSM feature ids** — OpenMapTiles merges multipolygon
  relations, so keys are derived from the resolved footprint
  (see `BuildingInfo.osmId` docs in `src/buildings.ts`).
- Save-game persistence: bump the version suffix in `STORAGE_KEY`
  (`src/state.ts`) when the persisted shape changes; unknown shapes are
  discarded, not migrated.
- Economy tuning constants live only in `src/state.ts`.
- All game state mutation goes through `state.ts`; views subscribe via
  `subscribe()` so overlay/HUD/stats can never disagree.
- The map click pipeline throttles `queryRenderedFeatures` to one call per
  animation frame (mousemove fires far more often than paint).

