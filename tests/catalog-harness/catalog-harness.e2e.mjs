// T02 / V01-B — Harness de navegador: monta la Gallery LOCAL real con dobles (sin auth/Telegram reales)
// y registra navegador, viewport, DPR, zoom, fuentes y contadores. No es evidencia de transporte real.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const OUT = process.env.CATALOG_HARNESS_OUT;
const results = [];
const state = () => browser.execute(() => ({
  authForm: !!document.querySelector(".bg-auth-form"),
  cards: document.querySelectorAll("[aria-label^='Play '], [aria-label^='Pause ']").length,
  firstCard: document.querySelector("[aria-label^='Play ']")?.getAttribute("aria-label") || null,
  hosts: [...new Set(performance.getEntriesByType("resource").map((e) => new URL(e.name).host))],
  calls: window.__catalogHarnessCalls || [],
  counters: window.__catalogHarness || null,
}));
async function check(id, fn) {
  try { const detail = await fn(); results.push({ id, result: "PASS", detail }); }
  catch (e) { results.push({ id, result: "FAIL", error: String(e?.message || e) }); await browser.saveScreenshot(path.join(OUT, `FAIL-${id}.png`)); throw e; }
}

describe("V01-B harness de navegador (servicios simulados)", () => {
  it("H1 login simulado abre la Gallery LOCAL", () => check("H1-login-gallery", async () => {
    await browser.url("/gallery");
    await $("#auth-login-identifier").waitForDisplayed();
    await $("#auth-login-identifier").click(); await browser.keys("v01b@fake.invalid".split(""));
    await $("#auth-login-password").click(); await browser.keys("not-a-real-password".split(""));
    await browser.keys("Enter");
    await browser.waitUntil(async () => !(await state()).authForm, { timeout: 30000, timeoutMsg: "auth form sigue visible" });
  }));
  it("H2 la Gallery muestra BeatCards del fixture T01 c12-f02-search", () => check("H2-cards", async () => {
    await browser.waitUntil(async () => (await state()).cards >= 1, { timeout: 30000, timeoutMsg: "sin BeatCard" });
    const s = await state();
    assert.ok(s.calls.includes("transport.getLibraryIndex(legacy-metadata)"), "lectura legacy contada");
    assert.ok(!s.calls.some((c) => c.startsWith("UNSUPPORTED")), `contrato del doble incompleto: ${s.calls.filter((c) => c.startsWith("UNSUPPORTED"))}`);
    await browser.saveScreenshot(path.join(OUT, "gallery.png"));
    return { cards: s.cards, firstCard: s.firstCard };
  }));
  it("H3 registra navegador, viewport, DPR, zoom y fuentes", () => check("H3-environment", async () => {
    const env = await browser.execute(async () => {
      await document.fonts.ready;
      const fams = new Set(); document.fonts.forEach((f) => { if (f.status === "loaded") fams.add(f.family.replace(/["']/g, "")); });
      return { userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio,
        zoom: { visualViewportScale: window.visualViewport?.scale ?? null, outerOverInner: outerWidth / innerWidth },
        fonts: { status: document.fonts.status, loaded: [...fams].sort() }, languages: navigator.languages };
    });
    env.browserVersion = browser.capabilities.browserVersion;
    assert.equal(env.dpr, 1); assert.equal(env.zoom.visualViewportScale, 1);
    return env;
  }));
  it("H4 sin red fuera de 127.0.0.1 y contadores presentes", () => check("H4-isolation-counters", async () => {
    const s = await state();
    assert.ok(s.hosts.every((h) => h.startsWith("127.0.0.1:")), `hosts externos: ${s.hosts}`);
    assert.ok(s.counters, "instrumentación ausente");
    assert.ok(Object.keys(s.counters.fetch).some((k) => k.endsWith("/beatgaler-api/__catalog/fixtures/:id")));
    assert.ok(s.counters.cardsMounted >= s.cards);
    return { hosts: s.hosts, counters: s.counters };
  }));
  after(async () => {
    const final = await state().catch(() => null);
    fs.writeFileSync(path.join(OUT, "browser-harness-report.json"), JSON.stringify({ kind: "V01B_BROWSER_HARNESS_SIMULATED_SERVICES", note: "Gallery LOCAL con dobles; no es evidencia de transporte real ni de rendimiento", results, final }, null, 2));
  });
});
