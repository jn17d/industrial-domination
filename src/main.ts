import './style.css';

import {
  BUILDING_3D_MIN_ZOOM,
  BUILDING_MIN_ZOOM,
  CLAIMED_EXTRUSION_LAYER_ID,
  CLAIMED_FILL_LAYER_ID,
  collectViewportBuildings,
  ensureOverlayLayers,
  isCoveredByClaim,
  syncClaimedBuildings,
} from './buildings.ts';
import type { BuildingInfo } from './buildings.ts';
import { addProceduralModelsLayer } from './map3d/claimedModelsLayer.ts';
import type { ProceduralModelsLayer } from './map3d/claimedModelsLayer.ts';
import { createMap, isWebGL2Available } from './map.ts';
import type { MapController } from './map.ts';
import { searchPlaces } from './search.ts';
import type { GeocodeResult } from './search.ts';
import {
  canAfford,
  claimBuilding,
  getClaimCount,
  getState,
  isClaimed,
  priceForBuilding,
  resetGame,
  subscribe,
} from './state.ts';
import { formatCurrency, initUi } from './ui.ts';

const container = requireElement<HTMLElement>('#map');

/** Non-null element lookup, so the result stays narrowed inside callbacks. */
function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

let controller: MapController | null = null;

/** Procedural three.js models (ambient warehouses + claimed buildings). */
let modelsLayer: ProceduralModelsLayer | null = null;

/** Latest viewport scan, kept so claim changes can re-filter the ambient scene. */
let lastAmbient: BuildingInfo[] = [];

/** Currently selected building, i.e. whatever the stats card is showing. */
let selected: BuildingInfo | null = null;

/** Avoids stacking duplicate log entries when the same building is re-clicked. */
let lastLoggedId: string | null = null;

/**
 * Monotonic id for the in-flight search. `searchPlaces` aborts a superseded
 * request, whose catch resolves *after* the newer one started, so its UI updates
 * must be discarded or they would overwrite the newer search's status.
 */
let searchSequence = 0;

const ui = initUi({
  onSearch: (query) => {
    void runSearch(query);
  },
  onPickResult: flyToResult,
  onClaim: claimSelected,
  onReset: resetGame,
});

function syncHud(): void {
  const state = getState();
  if (controller) {
    syncClaimedBuildings(controller.map, Object.values(state.claims));
    modelsLayer?.updateClaims(Object.values(state.claims));
    // A new claim removes its ambient twin (or upgrades the footprint), so the
    // ambient scene must re-filter against the claim set even without a move.
    modelsLayer?.updateAmbient(
      lastAmbient.filter((building) => !isCoveredByClaim(building, Object.values(state.claims))),
    );
  }
  ui.renderHud(state.cash, getClaimCount());
}

/**
 * Refresh the ambient (unclaimed) warehouse models from the current viewport.
 * Called on `idle` — after movement settles and pending tiles finish loading —
 * never per frame; the layer diffs placements so unchanged buildings cost
 * nothing.
 */
function refreshAmbient(): void {
  if (!controller || !modelsLayer) return;

  if (controller.map.getZoom() < BUILDING_3D_MIN_ZOOM) {
    lastAmbient = [];
    modelsLayer.updateAmbient(lastAmbient);
    return;
  }

  const claims = Object.values(getState().claims);
  const raw = collectViewportBuildings(controller.map);
  lastAmbient = raw.filter((building) => !isCoveredByClaim(building, claims));
  modelsLayer.updateAmbient(lastAmbient);
}

function renderStats(): void {
  ui.renderStats(selected, {
    claimed: selected ? isClaimed(selected.osmId) : false,
    affordable: selected ? canAfford(priceForBuilding(selected)) : true,
  });
}

/** Map click handler: log metadata, then populate the docked stats card. */
function handleSelect(info: BuildingInfo | null): void {
  selected = info;

  if (info) {
    if (info.osmId !== lastLoggedId) {
      ui.appendLog(info, isClaimed(info.osmId));
      lastLoggedId = info.osmId;
    }
  } else {
    // Clicking empty space clears the card.
    lastLoggedId = null;
  }

  renderStats();
}

async function runSearch(query: string): Promise<void> {
  const sequence = (searchSequence += 1);

  ui.setSearchBusy(true);
  ui.setSearchStatus('Searching…');

  const outcome = await searchPlaces(query);

  // A newer search has taken over; it owns the UI from here.
  if (sequence !== searchSequence) return;

  ui.setSearchBusy(false);

  if (!outcome.ok) {
    ui.setSearchStatus(outcome.error, 'error');
    ui.renderSearchResults([]);
    return;
  }

  const { results } = outcome;
  ui.setSearchStatus(
    `${results.length} result${results.length === 1 ? '' : 's'} — pick one to fly there`,
    'ok',
  );
  ui.renderSearchResults(results);
}

function flyToResult(result: GeocodeResult): void {
  if (!controller) return;

  ui.setSearchStatus(`Flying to ${result.displayName}`, 'ok');

  controller.map.flyTo({
    center: [result.lon, result.lat],
    // Buildings only exist from z13 (flat fills) / z14 (3D extrusions), so land
    // at a zoom that actually has footprints to hover and claim.
    zoom: BUILDING_3D_MIN_ZOOM + 2.5,
    pitch: 60,
    bearing: -20,
    duration: 2_600,
  });
}

function claimSelected(): void {
  if (!selected) return;

  const result = claimBuilding(selected);

  if (!result.ok) {
    ui.showToast(
      result.reason === 'already-claimed'
        ? 'You already own this building.'
        : `Not enough cash — this costs ${formatCurrency(priceForBuilding(selected))}.`,
      'error',
    );
    return;
  }

  ui.markClaimed(result.claim.osmId);
  ui.showToast(
    `Claimed ${result.claim.name} for ${formatCurrency(result.claim.pricePaid)}`,
    'success',
  );
}

function updateZoomHint(): void {
  if (!controller) return;
  const hasBuildingLayers = controller.getBuildingLayerIds().length > 0;
  ui.setZoomHint(hasBuildingLayers && controller.map.getZoom() < BUILDING_MIN_ZOOM);
}

function start(): void {
  const mapController = createMap(container, { onSelect: handleSelect });
  controller = mapController;
  // Dev-only debug handle for live diagnosis in browser DevTools / automation.
  (window as unknown as Record<string, unknown>).__map = mapController.map;

  // One subscription drives every state-derived view, so a claim or reset can
  // never leave the overlay, HUD and stats card disagreeing.
  subscribe(() => {
    syncHud();
    renderStats();
  });

  mapController.map.on('load', () => {
    // Called explicitly (rather than relying on createMap's own load listener)
    // so the overlay source exists before the first sync.
    ensureOverlayLayers(mapController.map);
    // Procedural three.js models replace the neon-green extrusion block and the
    // flat green fill for claimed buildings. Keep the outline layer (hover +
    // minimap-read); the extrusion and fill would render as a blank green
    // square sitting inside/under the model.
    modelsLayer = addProceduralModelsLayer(mapController.map);
    // Dev-only debug handle for live diagnosis in browser DevTools / automation.
    (window as unknown as Record<string, unknown>).__models = modelsLayer;
    mapController.map.setLayoutProperty(CLAIMED_EXTRUSION_LAYER_ID, 'visibility', 'none');
    mapController.map.setLayoutProperty(CLAIMED_FILL_LAYER_ID, 'visibility', 'none');
    updateZoomHint();
    refreshAmbient();
    syncHud();
    renderStats();
  });

  mapController.map.on('moveend', updateZoomHint);
  // `idle` fires once movement settles AND pending tiles have loaded — the
  // right moment to rescan the viewport for ambient warehouse models.
  mapController.map.on('idle', refreshAmbient);

  syncHud();
  renderStats();
}

if (!isWebGL2Available()) {
  ui.showFatal(
    'WebGL2 is required',
    'MapLibre GL JS v6 renders the 3D building extrusions with WebGL2 only. ' +
      'Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration enabled.',
  );
} else {
  start();
}