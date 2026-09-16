import './style.css';

import {
  BUILDING_3D_MIN_ZOOM,
  BUILDING_MIN_ZOOM,
  ensureOverlayLayers,
  syncClaimedBuildings,
} from './buildings.ts';
import type { BuildingInfo } from './buildings.ts';
import { createMap, isWebGL2Available } from './map.ts';
import type { MapController } from './map.ts';
import { searchPlaces } from './search.ts';
import type { GeocodeResult } from './search.ts';
import {
  CLAIM_COST,
  canAfford,
  claimBuilding,
  getClaimCount,
  getState,
  isClaimed,
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
  }
  ui.renderHud(state.cash, getClaimCount());
}

function renderStats(): void {
  ui.renderStats(selected, {
    claimed: selected ? isClaimed(selected.osmId) : false,
    affordable: canAfford(),
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
        : `Not enough cash — you need ${formatCurrency(CLAIM_COST)}.`,
      'error',
    );
    return;
  }

  ui.markClaimed(result.claim.osmId);
  ui.showToast(
    `Claimed ${result.claim.name} for ${formatCurrency(CLAIM_COST)}`,
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
    updateZoomHint();
    syncHud();
    renderStats();
  });

  mapController.map.on('moveend', updateZoomHint);

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