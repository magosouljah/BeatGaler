export const WEB_LIBRARY_PAGE_PARAM = "bgPage";
export const WEB_LIBRARY_NAVIGATION_EVENT = "beatgaler:web-library-navigation";

export interface WebLibraryNavigationState {
  offset: number;
  previousOffset: number | null;
  nextOffset: number | null;
  pageSize: number;
  materializedCount: number;
  totalVisible: number;
}

let currentState: WebLibraryNavigationState | null = null;

export function readRequestedWebLibraryOffset(search = typeof window !== "undefined" ? window.location.search : ""): number {
  const params = new URLSearchParams(search);
  const raw = Number(params.get(WEB_LIBRARY_PAGE_PARAM) || 0);
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

export function webLibraryPageUrl(offset: number, href = typeof window !== "undefined" ? window.location.href : "https://beatgaler.invalid/"): string {
  const url = new URL(href);
  const normalized = Math.max(0, Math.trunc(offset));
  if (normalized === 0) url.searchParams.delete(WEB_LIBRARY_PAGE_PARAM);
  else url.searchParams.set(WEB_LIBRARY_PAGE_PARAM, String(normalized));
  return url.toString();
}

export function publishWebLibraryNavigationState(state: WebLibraryNavigationState): void {
  currentState = { ...state };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<WebLibraryNavigationState>(WEB_LIBRARY_NAVIGATION_EVENT, { detail: currentState }));
  }
}

export function readWebLibraryNavigationState(): WebLibraryNavigationState | null {
  return currentState ? { ...currentState } : null;
}

export function clearWebLibraryNavigationState(): void {
  currentState = null;
}
