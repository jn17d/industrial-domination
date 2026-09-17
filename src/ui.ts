import type { BuildingInfo } from './buildings.ts';
import type { GeocodeResult } from './search.ts';
import { priceForBuilding } from './state.ts';

export interface ClaimAvailability {
  claimed: boolean;
  affordable: boolean;
}

export interface UiCallbacks {
  /** Raised on explicit submit only — never per keystroke (Nominatim policy). */
  onSearch: (query: string) => void;
  onPickResult: (result: GeocodeResult) => void;
  onClaim: () => void;
  onReset: () => void;
}

export interface UiController {
  setSearchBusy: (busy: boolean) => void;
  setSearchStatus: (text: string, kind?: 'info' | 'error' | 'ok') => void;
  renderSearchResults: (results: GeocodeResult[]) => void;
  renderStats: (info: BuildingInfo | null, availability: ClaimAvailability) => void;
  renderHud: (cash: number, claimCount: number) => void;
  appendLog: (info: BuildingInfo, claimed: boolean) => void;
  markClaimed: (osmId: string) => void;
  clearLog: () => void;
  showToast: (message: string, kind: 'success' | 'error' | 'info') => void;
  setZoomHint: (visible: boolean) => void;
  showFatal: (title: string, detail: string) => void;
}

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('en-US');

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

export function formatNumber(value: number): string {
  return numberFormatter.format(Math.round(value));
}

const MAX_LOG_ENTRIES = 60;
const TOAST_DURATION_MS = 2_600;

interface UiElements {
  searchForm: HTMLFormElement;
  searchInput: HTMLInputElement;
  searchSubmit: HTMLButtonElement;
  searchStatus: HTMLParagraphElement;
  searchResults: HTMLUListElement;
  hudCash: HTMLElement;
  hudClaimed: HTMLElement;
  hudReset: HTMLButtonElement;
  logList: HTMLUListElement;
  logClear: HTMLButtonElement;
  statsCard: HTMLElement;
  statName: HTMLElement;
  statOsmId: HTMLElement;
  statType: HTMLElement;
  statHeight: HTMLElement;
  statArea: HTMLElement;
  statPrice: HTMLElement;
  claimButton: HTMLButtonElement;
  toast: HTMLElement;
  zoomHint: HTMLElement;
  fatal: HTMLElement;
}

/**
 * The UI is a single-instance view over a single-instance game, so element
 * handles and callbacks live at module scope rather than being threaded through
 * every render call.
 */
let elements: UiElements | null = null;
let handlers: UiCallbacks | null = null;
let toastTimer: number | undefined;

function el(): UiElements {
  if (!elements) throw new Error('initUi() must be called before using the UI');
  return elements;
}

function must<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`UI element not found: ${selector}`);
  return element;
}

export function initUi(callbacks: UiCallbacks): UiController {
  handlers = callbacks;

  elements = {
    searchForm: must<HTMLFormElement>('#search-panel'),
    searchInput: must<HTMLInputElement>('#search-input'),
    searchSubmit: must<HTMLButtonElement>('#search-submit'),
    searchStatus: must<HTMLParagraphElement>('#search-status'),
    searchResults: must<HTMLUListElement>('#search-results'),
    hudCash: must<HTMLElement>('#hud-cash'),
    hudClaimed: must<HTMLElement>('#hud-claimed'),
    hudReset: must<HTMLButtonElement>('#hud-reset'),
    logList: must<HTMLUListElement>('#log-list'),
    logClear: must<HTMLButtonElement>('#log-clear'),
    statsCard: must<HTMLElement>('#stats-card'),
    statName: must<HTMLElement>('#stat-name'),
    statOsmId: must<HTMLElement>('#stat-osm-id'),
    statType: must<HTMLElement>('#stat-type'),
    statHeight: must<HTMLElement>('#stat-height'),
    statArea: must<HTMLElement>('#stat-area'),
    statPrice: must<HTMLElement>('#stat-price'),
    claimButton: must<HTMLButtonElement>('#claim-button'),
    toast: must<HTMLElement>('#toast'),
    zoomHint: must<HTMLElement>('#zoom-hint'),
    fatal: must<HTMLElement>('#fatal'),
  };

  const view = elements;

  // Explicit submit only. Nominatim forbids client-side autocomplete, so there
  // is deliberately no `input` event listener here.
  view.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = view.searchInput.value.trim();
    if (query === '') return;
    handlers?.onSearch(query);
  });

  view.claimButton.addEventListener('click', () => {
    handlers?.onClaim();
  });

  view.logClear.addEventListener('click', () => {
    clearLog();
  });

  view.hudReset.addEventListener('click', () => {
    const confirmed = window.confirm(
      'Reset the game? Every claim and all cash will be cleared.',
    );
    if (confirmed) handlers?.onReset();
  });

  return {
    setSearchBusy,
    setSearchStatus,
    renderSearchResults,
    renderStats,
    renderHud,
    appendLog,
    markClaimed,
    clearLog,
    showToast,
    setZoomHint,
    showFatal,
  };
}

export function setSearchBusy(busy: boolean): void {
  const { searchSubmit } = el();
  searchSubmit.disabled = busy;
  searchSubmit.textContent = busy ? '…' : 'Search';
}

export function setSearchStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const { searchStatus } = el();
  searchStatus.textContent = text;
  searchStatus.dataset.kind = kind;
}

export function renderSearchResults(results: GeocodeResult[]): void {
  const { searchResults } = el();
  searchResults.replaceChildren();

  if (results.length === 0) {
    searchResults.hidden = true;
    return;
  }

  for (const result of results) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = result.displayName;
    button.addEventListener('click', () => {
      handlers?.onPickResult(result);
    });
    item.append(button);
    searchResults.append(item);
  }

  searchResults.hidden = false;
}

export function renderStats(
  info: BuildingInfo | null,
  availability: ClaimAvailability,
): void {
  const {
    statsCard,
    statName,
    statOsmId,
    statType,
    statHeight,
    statArea,
    statPrice,
    claimButton,
  } = el();

  if (!info) {
    statsCard.hidden = true;
    return;
  }

  const price = priceForBuilding(info);

  statsCard.hidden = false;
  statName.textContent = info.name;
  // Show the real OSM way/relation id; osmId is an internal per-footprint key.
  statOsmId.textContent = info.osmFeatureId ?? info.osmId;
  statType.textContent = info.type;
  statHeight.textContent = `${formatNumber(info.height)} m`;
  statArea.textContent = `${formatNumber(info.areaM2)} m²`;
  statPrice.textContent = formatCurrency(price);

  if (availability.claimed) {
    claimButton.disabled = true;
    claimButton.textContent = 'Already claimed';
    claimButton.dataset.state = 'claimed';
  } else if (!availability.affordable) {
    claimButton.disabled = true;
    claimButton.textContent = `Insufficient funds — need ${formatCurrency(price)}`;
    claimButton.dataset.state = 'blocked';
  } else {
    claimButton.disabled = false;
    claimButton.textContent = `Claim Building (${formatCurrency(price)})`;
    claimButton.dataset.state = 'available';
  }
}

export function renderHud(cash: number, claimCount: number): void {
  const { hudCash, hudClaimed } = el();
  hudCash.textContent = formatCurrency(cash);
  hudClaimed.textContent = formatNumber(claimCount);
}

/** Append a clicked building's metadata to the overlay log panel. */
export function appendLog(info: BuildingInfo, claimed: boolean): void {
  const { logList } = el();

  const item = document.createElement('li');
  item.dataset.osmId = info.osmId;
  item.dataset.claimed = claimed ? 'true' : 'false';

  const title = document.createElement('strong');
  title.textContent = info.name;

  const detail = document.createElement('span');
  detail.textContent = [
    `OSM ${info.osmFeatureId ?? info.osmId}`,
    info.type,
    `${formatNumber(info.height)} m tall`,
    `${formatNumber(info.areaM2)} m²`,
    `${info.centroid[0].toFixed(5)}, ${info.centroid[1].toFixed(5)}`,
  ].join(' · ');

  item.append(title, detail);
  logList.prepend(item);

  while (logList.children.length > MAX_LOG_ENTRIES) {
    logList.lastElementChild?.remove();
  }
}

/** Flag the log entry for a building once it has been paid for. */
export function markClaimed(osmId: string): void {
  const { logList } = el();
  const item = logList.querySelector<HTMLLIElement>(
    `li[data-osm-id="${CSS.escape(osmId)}"]`,
  );
  if (!item) return;
  item.dataset.claimed = 'true';
}

export function clearLog(): void {
  el().logList.replaceChildren();
}

export function showToast(message: string, kind: 'success' | 'error' | 'info'): void {
  const { toast } = el();
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;

  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
    toastTimer = undefined;
  }, TOAST_DURATION_MS);
}

export function setZoomHint(visible: boolean): void {
  el().zoomHint.hidden = !visible;
}

/** Replaces the whole UI with an explanation when the app cannot start. */
export function showFatal(title: string, detail: string): void {
  const { fatal } = el();

  const inner = document.createElement('div');
  inner.className = 'fatal__inner';

  const heading = document.createElement('h2');
  heading.textContent = title;

  const paragraph = document.createElement('p');
  paragraph.textContent = detail;

  inner.append(heading, paragraph);
  fatal.replaceChildren(inner);
  fatal.hidden = false;
}