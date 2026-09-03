export const FULL_CARD_INTERSECTION_RATIO = 0.999;
const PIXEL_TOLERANCE = 0.5;

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

/**
 * Observes the BeatCard root node, not its artwork. A beat becomes a prefetch
 * candidate only while the entire rendered card is inside the viewport.
 */
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
      const beatId = entry.target.getAttribute("data-beat-card-id")?.trim();
      if (beatId) onFullyVisible(beatId);
    }
  }, {
    root: null,
    threshold: [FULL_CARD_INTERSECTION_RATIO, 1],
  });

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
