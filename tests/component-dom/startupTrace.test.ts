import { beforeEach, describe, expect, it } from "vitest";
import { readStartupSnapshot } from "../../src/features/perf/startupTrace";

describe("Issue #97 startup surface instrumentation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("detects the static startup loader before React owns the screen", () => {
    document.body.innerHTML = '<div id="beatgaler-startup-loader">Loading Beat Galer...</div><div id="root"></div>';

    expect(readStartupSnapshot()).toEqual({
      surface: "startup_loader",
      cardCount: 0,
    });
  });

  it("distinguishes auth restore from a real auth screen", () => {
    document.body.innerHTML = '<main class="bg-auth-shell"><section class="bg-auth-card bg-auth-card--loading"></section></main>';
    expect(readStartupSnapshot()).toEqual({ surface: "auth_restore", cardCount: 0 });

    document.body.innerHTML = '<main class="bg-auth-shell"><h1 id="beatgaler-auth-title">Welcome back</h1></main>';
    expect(readStartupSnapshot()).toEqual({
      surface: "auth_screen",
      cardCount: 0,
      detail: "Welcome back",
    });
  });

  it("detects the library loading surface without calling it empty", () => {
    document.body.innerHTML = '<main data-library-scroll="true"><section aria-label="Loading beat library">skeletons</section></main>';

    expect(readStartupSnapshot()).toEqual({
      surface: "library_loading",
      cardCount: 0,
    });
  });

  it("records card count as cards become visible", () => {
    document.body.innerHTML = `
      <main data-library-scroll="true">
        <article data-beat-card-id="beat-a"></article>
        <article data-beat-card-id="beat-b"></article>
        <article data-beat-card-id="beat-c"></article>
      </main>
    `;

    expect(readStartupSnapshot()).toEqual({
      surface: "library_cards",
      cardCount: 3,
    });
  });

  it("classifies Empty Gallery only when that terminal UI is actually rendered", () => {
    document.body.innerHTML = '<main data-library-scroll="true"><div>Empty Gallery</div></main>';
    expect(readStartupSnapshot()).toEqual({ surface: "empty_gallery", cardCount: 0 });

    document.body.innerHTML = '<main data-library-scroll="true"></main>';
    expect(readStartupSnapshot()).toEqual({ surface: "library_shell", cardCount: 0 });
  });

  it("prefers visible cards over stale Empty Gallery text if both exist during a transition", () => {
    document.body.innerHTML = `
      <main data-library-scroll="true">
        <div>Empty Gallery</div>
        <article data-beat-card-id="beat-a"></article>
      </main>
    `;

    expect(readStartupSnapshot()).toEqual({
      surface: "library_cards",
      cardCount: 1,
    });
  });
});
