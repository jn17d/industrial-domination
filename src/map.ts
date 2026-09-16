import {
  AttributionControl,
  GeolocateControl,
  Map,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

import {
  ensureOverlayLayers,
  pickBuildingAt,
  resolveBuildingLayers,
  setHoveredBuilding,
} from './buildings.ts';
import type { BuildingInfo } from './buildings.ts';
import type { MapGeoJSONFeature, PointLike } from 'maplibre-gl';

/**
 * MapLibre GL JS v6 ships ESM-only, and its dist worker imports a sibling
 * `maplibre-gl-shared.mjs`. The worker must go through Vite's worker pipeline
 * (`?worker&url`) rather than plain `?url`: with `?url` a production build emits
 * the worker without its sibling, the worker then fails on its first import, and
 * no vector tiles load — while `vite dev` still works, hiding the problem.
 */
setWorkerUrl(workerUrl);

/** Keyless vector tiles including 3D building extrusions (OpenMapTiles schema). */
export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Attribution is required by both the tile provider and OpenStreetMap. */
const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
  '&middot; Data from ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

/** Dense, well-modelled buildings — a good showcase for 3D extrusions. */
const INITIAL_CENTER: [number, number] = [-0.1278, 51.5074]; // London
const INITIAL_ZOOM = 16.2;
const INITIAL_PITCH = 60;
const INITIAL_BEARING = -20;

export interface MapCallbacks {
  onSelect: (info: BuildingInfo | null) => void;
}

export interface MapController {
  readonly map: Map;
  /** Style layer ids currently drawing building footprints; empty until load. */
  getBuildingLayerIds: () => string[];
  refreshBuildingLayers: () => string[];
}

/**
 * maplibre-gl v6 requires WebGL2 and throws `GPUInitializationError` without it,
 * so check up front to show a real explanation instead of a broken canvas.
 */
export function isWebGL2Available(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export function createMap(container: HTMLElement, callbacks: MapCallbacks): MapController {
  const map = new Map({
    container,
    style: STYLE_URL,
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
    pitch: INITIAL_PITCH,
    bearing: INITIAL_BEARING,
    minZoom: 2,
    maxZoom: 19,
    maxPitch: 85,
    attributionControl: false,
  });

  map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(
    new GeolocateControl({ trackUserLocation: false, showAccuracyCircle: false }),
    'top-right',
  );
  map.addControl(
    new AttributionControl({ compact: true, customAttribution: ATTRIBUTION }),
    'bottom-right',
  );

  let buildingLayerIds: string[] = [];
  let hoveredId: string | null = null;
  let pendingQuery: { point: PointLike; cursor: [number, number] } | null = null;
  let hoverFrame = 0;
  let isDragging = false;

  function refreshBuildingLayers(): string[] {
    buildingLayerIds = resolveBuildingLayers(map);
    return buildingLayerIds;
  }

  function queryBuildingAt(
    point: PointLike,
    cursor: [number, number],
  ): BuildingInfo | null {
    if (buildingLayerIds.length === 0) return null;

    let features: MapGeoJSONFeature[];
    try {
      features = map.queryRenderedFeatures(point, { layers: buildingLayerIds });
    } catch (error) {
      // Happens if the style swapped beneath us and a layer id went stale.
      console.warn('[map] building query failed', error);
      return null;
    }

    return pickBuildingAt(features, cursor);
  }

  function clearHover(): void {
    pendingQuery = null;
    if (hoverFrame !== 0) {
      cancelAnimationFrame(hoverFrame);
      hoverFrame = 0;
    }
    if (hoveredId === null) return;

    hoveredId = null;
    map.getCanvas().style.cursor = '';
    setHoveredBuilding(map, null);
  }

  /**
   * Runs at most once per animation frame: queryRenderedFeatures is expensive
   * and mousemove fires far more often than the browser paints.
   */
  function evaluateHover(): void {
    hoverFrame = 0;
    if (!pendingQuery) return;

    const info = queryBuildingAt(pendingQuery.point, pendingQuery.cursor);
    map.getCanvas().style.cursor = info ? 'pointer' : '';

    const nextId = info?.osmId ?? null;
    if (nextId === hoveredId) return;

    hoveredId = nextId;
    setHoveredBuilding(map, info);
  }

  map.on('mousemove', (event) => {
    if (isDragging) return;
    pendingQuery = {
      point: event.point,
      cursor: [event.lngLat.lng, event.lngLat.lat],
    };
    if (hoverFrame !== 0) return;
    hoverFrame = requestAnimationFrame(evaluateHover);
  });

  map.on('mouseout', clearHover);

  map.on('dragstart', () => {
    isDragging = true;
    clearHover();
  });

  map.on('dragend', () => {
    isDragging = false;
  });

  // MapLibre suppresses `click` after a drag, so no extra guard is needed here.
  map.on('click', (event) => {
    callbacks.onSelect(
      queryBuildingAt(event.point, [event.lngLat.lng, event.lngLat.lat]),
    );
  });

  map.on('load', () => {
    refreshBuildingLayers();
    ensureOverlayLayers(map);
    console.info(
      `[map] building layers: ${buildingLayerIds.join(', ') || 'none found in style'}`,
    );
  });

  // Re-resolve if the style is replaced, since layer ids and the overlay
  // sources both disappear with it.
  map.on('style.load', () => {
    refreshBuildingLayers();
    ensureOverlayLayers(map);
  });

  map.on('error', (event) => {
    console.error('[map] MapLibre error', event.error);
  });

  return { map, getBuildingLayerIds: () => buildingLayerIds, refreshBuildingLayers };
}
