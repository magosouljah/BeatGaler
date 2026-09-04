export type BeatCardWarmPriority = "visible" | "nearby" | "far";

export const NEARBY_VIEWPORT_MARGIN = "100% 0px 100% 0px";

export function classifyBeatCardWarmPriority(visible: boolean, nearby: boolean): BeatCardWarmPriority {
  if (visible) return "visible";
  if (nearby) return "nearby";
  return "far";
}

type CardState = {
  beatId: string;
  visible: boolean;
  nearby: boolean;
  seenVisible: boolean;
  seenNearby: boolean;
  published: BeatCardWarmPriority | null;
};

/**
 * BeatCards that intersect the real viewport are VISIBLE. Cards within roughly
 * one viewport above/below are NEARBY. Everything else is FAR and consumes no
 * speculative data-plane work. Hover is intentionally not part of this policy.
 */
export function installBeatCardWarmObserver(
  onPriority: (beatId: string, priority: BeatCardWarmPriority) => void,
): () => void {
  if (
    typeof document === "undefined" ||
    typeof IntersectionObserver === "undefined" ||
    typeof MutationObserver === "undefined"
  ) return () => {};

  let stopped = false;
  let observedCards = new WeakSet<Element>();
  const states = new WeakMap<Element, CardState>();

  const stateFor = (node: Element): CardState | null => {
    const beatId = node.getAttribute("data-beat-card-id")?.trim();
    if (!beatId) return null;
    let state = states.get(node);
    if (!state || state.beatId !== beatId) {
      state = {
        beatId,
        visible: false,
        nearby: false,
        seenVisible: false,
        seenNearby: false,
        published: null,
      };
      states.set(node, state);
    }
    return state;
  };

  const publish = (node: Element) => {
    if (stopped) return;
    const state = stateFor(node);
    if (!state || !state.seenVisible || !state.seenNearby) return;
    const priority = classifyBeatCardWarmPriority(state.visible, state.nearby);
    if (priority === state.published) return;
    state.published = priority;
    onPriority(state.beatId, priority);
  };

  const visibleObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = stateFor(entry.target);
      if (!state) continue;
      state.visible = entry.isIntersecting && entry.intersectionRatio > 0;
      state.seenVisible = true;
      publish(entry.target);
    }
  }, { root: null, threshold: 0 });

  const nearbyObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = stateFor(entry.target);
      if (!state) continue;
      state.nearby = entry.isIntersecting && entry.intersectionRatio > 0;
      state.seenNearby = true;
      publish(entry.target);
    }
  }, { root: null, rootMargin: NEARBY_VIEWPORT_MARGIN, threshold: 0 });

  const observeCards = () => {
    if (stopped) return;
    for (const node of document.querySelectorAll("[data-beat-card-id]")) {
      if (observedCards.has(node)) continue;
      observedCards.add(node);
      stateFor(node);
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
    observedCards = new WeakSet<Element>();
  };
}
