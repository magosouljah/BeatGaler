export const FULL_CARD_INTERSECTION_RATIO = 0.999;
export const NEARBY_VIEWPORT_ROOT_MARGIN = "100% 0px";
const PIXEL_TOLERANCE = 0.5;

export type BeatCardPrefetchZone = "visible" | "nearby";
export interface BeatCardPrefetchSnapshot {
  visible: string[];
  nearby: string[];
}

export function isFullyVisibleBeatCardIntersection(entry: IntersectionObserverEntry): boolean {
  if (!entry.isIntersecting || entry.intersectionRatio < FULL_CARD_INTERSECTION_RATIO) return false;
  const rect = entry.boundingClientRect;
  if (rect.width <= 0 || rect.height <= 0) return false;
  const root = entry.rootBounds ?? {
    top: 0,
    left: 0,
    right: typeof window === "undefined" ? 0 : window.innerWidth,
    bottom: typeof window === "undefined" ? 0 : window.innerHeight,
  };
  return (
    rect.top >= root.top - PIXEL_TOLERANCE &&
    rect.left >= root.left - PIXEL_TOLERANCE &&
    rect.right <= root.right + PIXEL_TOLERANCE &&
    rect.bottom <= root.bottom + PIXEL_TOLERANCE
  );
}

export function classifyBeatCardPrefetchZone(
  entry: IntersectionObserverEntry,
  viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth,
  viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight,
): BeatCardPrefetchZone | null {
  if (!entry.isIntersecting) return null;
  const rect = entry.boundingClientRect;
  if (rect.width <= 0 || rect.height <= 0) return null;
  const intersectsViewport = (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < viewportHeight &&
    rect.left < viewportWidth
  );
  return intersectsViewport ? "visible" : "nearby";
}

function beatIdFor(node: Element): string | null {
  return node.getAttribute("data-beat-card-id")?.trim() || null;
}

/**
 * Tracks two independent zones: any pixel intersecting the real viewport is
 * VISIBLE; cards outside it but within one viewport above/below are NEARBY.
 * Two observers are intentional so moving from nearby into the real viewport
 * produces a callback even while the card stays inside the expanded root.
 */
export function installVisibleAndNearbyBeatCardObserver(
  onSnapshot: (snapshot: BeatCardPrefetchSnapshot) => void,
): () => void {
  if (
    typeof document === "undefined" ||
    typeof IntersectionObserver === "undefined" ||
    typeof MutationObserver === "undefined"
  ) return () => {};

  let observedCards = new WeakSet<Element>();
  let stopped = false;
  const visibleNodes = new Set<Element>();
  const nearbyNodes = new Set<Element>();

  const emit = () => {
    if (stopped) return;
    const visible = Array.from(visibleNodes).map(beatIdFor).filter((value): value is string => Boolean(value));
    const visibleSet = new Set(visible);
    const nearby = Array.from(nearbyNodes)
      .map(beatIdFor)
      .filter((value): value is string => Boolean(value) && !visibleSet.has(value));
    onSnapshot({ visible, nearby });
  };

  const visibleObserver = new IntersectionObserver(entries => {
    if (stopped) return;
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio > 0) visibleNodes.add(entry.target);
      else visibleNodes.delete(entry.target);
    }
    emit();
  }, { root: null, threshold: [0, Number.MIN_VALUE] });

  const nearbyObserver = new IntersectionObserver(entries => {
    if (stopped) return;
    for (const entry of entries) {
      if (entry.isIntersecting) nearbyNodes.add(entry.target);
      else nearbyNodes.delete(entry.target);
    }
    emit();
  }, { root: null, rootMargin: NEARBY_VIEWPORT_ROOT_MARGIN, threshold: [0] });

  const observeCards = () => {
    if (stopped) return;
    for (const node of document.querySelectorAll("[data-beat-card-id]")) {
      if (observedCards.has(node)) continue;
      observedCards.add(node);
      visibleObserver.observe(node);
      nearbyObserver.observe(node);
    }
  };

  observeCards();
  const mutations = new MutationObserver(observeCards);
  const root = document.body || document.documentElement;
  if (root) mutations.observe(root, { childList: true, subtree: true });
  queueMicrotask(observeCards);

  return () => {
    stopped = true;
    visibleObserver.disconnect();
    nearbyObserver.disconnect();
    mutations.disconnect();
    visibleNodes.clear();
    nearbyNodes.clear();
    observedCards = new WeakSet<Element>();
  };
}

/** Legacy helper retained for exact full-card visibility tests/callers. */
export function installFullyVisibleBeatCardObserver(
  onFullyVisible: (beatId: string) => void,
): () => void {
  if (
    typeof document === "undefined" ||
    typeof IntersectionObserver === "undefined" ||
    typeof MutationObserver === "undefined"
  ) return () => {};

  let observedCards = new WeakSet<Element>();
  let stopped = false;
  const intersection = new IntersectionObserver(entries => {
    if (stopped) return;
    for (const entry of entries) {
      if (!isFullyVisibleBeatCardIntersection(entry)) continue;
      const beatId = beatIdFor(entry.target);
      if (beatId) onFullyVisible(beatId);
    }
  }, { root: null, threshold: [FULL_CARD_INTERSECTION_RATIO, 1] });

  const observeCards = () => {
    if (stopped) return;
    for (const node of document.querySelectorAll("[data-beat-card-id]")) {
      if (observedCards.has(node)) continue;
      observedCards.add(node);
      intersection.observe(node);
    }
  };
  observeCards();
  const mutations = new MutationObserver(observeCards);
  const root = document.body || document.documentElement;
  if (root) mutations.observe(root, { childList: true, subtree: true });
  queueMicrotask(observeCards);
  return () => {
    stopped = true;
    intersection.disconnect();
    mutations.disconnect();
    observedCards = new WeakSet<Element>();
  };
}
