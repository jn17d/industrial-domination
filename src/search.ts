/**
 * Nominatim forward geocoding.
 *
 * Usage-policy constraints that shape this module
 * (https://operations.osmfoundation.org/policies/nominatim/):
 *  - "an absolute maximum of 1 request per second" -> MIN_REQUEST_INTERVAL_MS
 *  - "Auto-complete search ... you must not implement such a service on the
 *    client side" -> search is submit-triggered only, never per-keystroke
 *  - "Results must be cached on your side" -> in-memory cache
 *  - the provider must be swappable without a software update -> the endpoint
 *    is overridable through VITE_NOMINATIM_URL at build time
 *  - attribution is rendered in the search panel (index.html)
 */

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lon: number;
  category: string;
  type: string;
  /** [west, south, east, north] */
  boundingBox: [number, number, number, number] | null;
}

export type SearchOutcome =
  | { ok: true; results: GeocodeResult[] }
  | { ok: false; error: string };

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

function resolveEndpoint(): string {
  const configured: unknown = import.meta.env.VITE_NOMINATIM_URL;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim();
  }
  return DEFAULT_ENDPOINT;
}

export const NOMINATIM_ENDPOINT = resolveEndpoint();

/** Policy cap is 1 request/second; a small margin avoids clock-drift 429s. */
const MIN_REQUEST_INTERVAL_MS = 1_100;
const RESULT_LIMIT = 5;
const MIN_QUERY_LENGTH = 2;

const cache = new Map<string, GeocodeResult[]>();
let lastRequestAt = 0;
let inFlight: AbortController | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Serialise access to the shared 1 req/s budget. */
async function awaitRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await delay(MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Nominatim returns `boundingbox` as [minLat, maxLat, minLon, maxLon] strings. */
function parseBoundingBox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;

  const numbers = value.map((entry) => toNumberOrNull(entry));
  if (numbers.some((entry) => entry === null)) return null;

  const [south, north, west, east] = numbers as number[];
  return [west, south, east, north];
}

function parseResults(payload: unknown): GeocodeResult[] {
  if (!Array.isArray(payload)) return [];

  const results: GeocodeResult[] = [];
  for (const entry of payload) {
    if (!isRecord(entry)) continue;

    const lat = toNumberOrNull(entry.lat);
    const lon = toNumberOrNull(entry.lon);
    const displayName = typeof entry.display_name === 'string' ? entry.display_name : '';
    if (lat === null || lon === null || displayName === '') continue;

    results.push({
      displayName,
      lat,
      lon,
      category: typeof entry.category === 'string' ? entry.category : '',
      type: typeof entry.type === 'string' ? entry.type : '',
      boundingBox: parseBoundingBox(entry.boundingbox),
    });
  }
  return results;
}

export async function searchPlaces(rawQuery: string): Promise<SearchOutcome> {
  const query = rawQuery.trim();
  if (query.length < MIN_QUERY_LENGTH) {
    return { ok: false, error: `Type at least ${MIN_QUERY_LENGTH} characters.` };
  }

  const cacheKey = query.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) return { ok: true, results: cached };

  // Only one request may be outstanding; a newer search supersedes an older one.
  inFlight?.abort();
  const request = new AbortController();
  inFlight = request;

  await awaitRateLimit();

  try {
    const url = new URL(NOMINATIM_ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(RESULT_LIMIT));
    url.searchParams.set('addressdetails', '0');

    const response = await fetch(url, {
      signal: request.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return { ok: false, error: `Geocoder responded with HTTP ${response.status}.` };
    }

    const results = parseResults(await response.json());
    if (results.length === 0) {
      return { ok: false, error: `No matches for "${query}".` };
    }

    cache.set(cacheKey, results);
    return { ok: true, results };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, error: 'Search cancelled.' };
    }
    console.error('[search] geocoding failed', error);
    return { ok: false, error: 'Could not reach the geocoder. Check your connection.' };
  } finally {
    if (inFlight === request) inFlight = null;
  }
}
