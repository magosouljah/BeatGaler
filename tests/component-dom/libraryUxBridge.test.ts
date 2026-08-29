import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enhanceLibraryDom } from "../../src/features/library/LibraryUxBridge";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function libraryFixture() {
  document.body.innerHTML = `
    <div id="root">
      <div id="shell">
        <div id="header">
          <span>beat galer</span>
          <div id="header-controls">
            <div id="search-root">
              <button id="search-trigger"><svg aria-hidden="true"></svg></button>
              <input placeholder="Search beats…" />
            </div>
            <div id="sort-root">
              <button id="sort-trigger"><span>Name</span></button>
              <div id="sort-popup">
                <button>Name</button>
                <button>BPM</button>
              </div>
            </div>
            <button title="Settings"><span aria-hidden="true">⚙</span></button>
            <button title="Reload Library"><span aria-hidden="true">↻</span></button>
            <button>Select</button>
          </div>
        </div>
        <div id="selection-toolbar">
          <span>2 selected</span>
          <button>Edit all</button>
          <button>Upload to YouTube</button>
          <button>Remove all</button>
          <button>Cancel</button>
        </div>
        <div id="tags">
          <button style="color:#000;background:#e5e5e5">All</button>
          <button style="color:#fff;background:#845ef7">melodic</button>
          <button style="color:#f87171;text-decoration:line-through;background:rgba(248,113,113,.14)">old</button>
          <button style="color:#888;background:transparent">dark</button>
        </div>
        <div data-library-scroll="true">
          <div id="grid-shell">
            <div id="grid">
              <div data-beat-card-id="beat-1" style="width:160px;cursor:default">
                <div data-beat-artwork-id="beat-1" aria-disabled="false"></div>
                <div id="info">
                  <div id="title-row"><div id="beat-title">Midnight</div><div id="more">···</div></div>
                  <div data-beatgaler-status-row></div>
                  <div id="tag-row"><span>melodic</span></div>
                  <div id="meta-row"><span>120 · Am</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="portal-menu" style="position:fixed;z-index:9999">
      <div>Edit metadata</div>
      <div>View detail</div>
    </div>
  `;
}

beforeEach(() => {
  libraryFixture();
});

describe("F2 / 12.2 library accessibility bridge", () => {
  it("adds accessible header, search, sort, tags and selection semantics without replacing existing controls", () => {
    expect(enhanceLibraryDom(document)).toBe(true);

    const header = document.querySelector<HTMLElement>("#header")!;
    expect(header.getAttribute("role")).toBe("banner");
    expect(header.getAttribute("aria-label")).toBe("BeatGaler library header");

    const searchTrigger = document.querySelector<HTMLButtonElement>("#search-trigger")!;
    const search = document.querySelector<HTMLInputElement>('input[placeholder="Search beats…"]')!;
    expect(searchTrigger.getAttribute("aria-label")).toBe("Search library");
    expect(searchTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(search.type).toBe("search");
    expect(search.getAttribute("aria-label")).toBe("Search library");
    expect(search.classList.contains("bg-field")).toBe(true);

    const sortTrigger = document.querySelector<HTMLButtonElement>("#sort-trigger")!;
    expect(sortTrigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(sortTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("#sort-popup")?.getAttribute("role")).toBe("listbox");
    expect(document.querySelector('#sort-popup button[aria-selected="true"]')?.textContent).toBe("Name");

    const tagGroup = document.querySelector<HTMLElement>("#tags")!;
    expect(tagGroup.getAttribute("role")).toBe("group");
    expect(tagGroup.getAttribute("aria-label")).toBe("Tag filters");
    expect(tagGroup.querySelector<HTMLButtonElement>("button:nth-of-type(2)")?.dataset.filterState).toBe("included");
    expect(tagGroup.querySelector<HTMLButtonElement>("button:nth-of-type(3)")?.dataset.filterState).toBe("excluded");
    expect(tagGroup.querySelector<HTMLButtonElement>("button:nth-of-type(4)")?.dataset.filterState).toBe("idle");

    const toolbar = document.querySelector<HTMLElement>("#selection-toolbar")!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    expect(toolbar.querySelector("span")?.getAttribute("aria-live")).toBe("polite");
    expect(toolbar.querySelector("button")?.classList.contains("bg-button")).toBe(true);
  });

  it("turns existing card affordances into keyboard/touch controls without bubbling key activation to the card", () => {
    const card = document.querySelector<HTMLElement>('[data-beat-card-id="beat-1"]')!;
    const artwork = document.querySelector<HTMLElement>('[data-beat-artwork-id="beat-1"]')!;
    const title = document.querySelector<HTMLElement>("#beat-title")!;
    const more = document.querySelector<HTMLElement>("#more")!;
    const artworkClick = vi.fn();
    const moreClick = vi.fn();
    const cardKeydown = vi.fn();
    artwork.addEventListener("click", artworkClick);
    more.addEventListener("click", moreClick);
    card.addEventListener("keydown", cardKeydown);

    enhanceLibraryDom(document);

    expect(artwork.getAttribute("role")).toBe("button");
    expect(artwork.getAttribute("aria-label")).toBe("Play Midnight");
    expect(artwork.tabIndex).toBe(0);
    expect(title.getAttribute("role")).toBe("button");
    expect(title.getAttribute("aria-label")).toBe("Open details for Midnight");
    expect(more.getAttribute("role")).toBe("button");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");

    artwork.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    more.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(artworkClick).toHaveBeenCalledTimes(1);
    expect(moreClick).toHaveBeenCalledTimes(1);
    expect(cardKeydown).not.toHaveBeenCalled();
  });

  it("does not rewrite a stable playback-disabled attribute while enhancing its accessible label", async () => {
    const artwork = document.querySelector<HTMLElement>('[data-beat-artwork-id="beat-1"]')!;
    artwork.setAttribute("aria-disabled", "true");
    const writes: MutationRecord[] = [];
    const observer = new MutationObserver(records => writes.push(...records));
    observer.observe(artwork, { attributes: true, attributeFilter: ["aria-disabled"] });

    enhanceLibraryDom(document);
    await Promise.resolve();
    observer.disconnect();

    expect(writes).toHaveLength(0);
    expect(artwork.getAttribute("aria-disabled")).toBe("true");
    expect(artwork.getAttribute("aria-label")).toBe("Midnight playback unavailable");
  });

  it("keeps list semantics normally and exposes multi-selection state when selection mode is active", () => {
    enhanceLibraryDom(document);
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const card = document.querySelector<HTMLElement>('[data-beat-card-id="beat-1"]')!;
    expect(grid.getAttribute("role")).toBe("list");
    expect(card.getAttribute("role")).toBe("listitem");

    card.style.cursor = "pointer";
    const checkbox = document.createElement("div");
    checkbox.style.position = "absolute";
    checkbox.style.top = "6px";
    checkbox.style.left = "6px";
    checkbox.style.background = "#fff";
    card.insertBefore(checkbox, card.firstChild);

    enhanceLibraryDom(document);
    expect(grid.getAttribute("role")).toBe("listbox");
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    expect(card.getAttribute("role")).toBe("option");
    expect(card.getAttribute("aria-selected")).toBe("true");
    expect(card.getAttribute("aria-label")).toContain("Midnight, selected");
  });

  it("upgrades the existing portal context menu to keyboard menu semantics", () => {
    const firstItem = document.querySelector<HTMLElement>("#portal-menu > div")!;
    const click = vi.fn();
    firstItem.addEventListener("click", click);

    enhanceLibraryDom(document);
    const menu = document.querySelector<HTMLElement>("#portal-menu")!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(firstItem.getAttribute("role")).toBe("menuitem");
    expect(firstItem.tabIndex).toBe(0);

    firstItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("defines explicit responsive breakpoints, fixed card rows and coarse-pointer affordances using foundation tokens", () => {
    const css = readFileSync(path.join(rootDir, "src/styles/library-ux.css"), "utf8");
    expect(css).toContain("grid-auto-rows: 276px");
    expect(css).toContain("height: 276px !important");
    expect(css).toContain("grid-template-rows: 22px 16px 50px 19px");
    expect(css).toContain("@media (hover: none), (pointer: coarse)");
    expect(css).toContain("@media (min-width: 768px)");
    expect(css).toContain("@media (min-width: 1024px)");
    expect(css).toContain("@media (min-width: 1280px)");
    expect(css).toContain("grid-template-columns: repeat(2, 160px)");
    expect(css).toContain("gap: 28px 18px !important");
    expect(css).not.toContain("gap-left");
    expect(css).not.toContain("gap-right");
    expect(css).toContain("var(--focus-ring)");
    expect(css).toContain("var(--border-default)");
    expect(css).not.toMatch(/--bg-canvas\s*:/);
    expect(css).not.toMatch(/--focus-ring\s*:/);
  });
});
