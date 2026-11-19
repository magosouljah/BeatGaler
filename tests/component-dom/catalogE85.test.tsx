// E85 — el rating elegido en la revisión de un beat nuevo llega íntegro al guardar, aunque la hidratación del ID3 (que reemplaza `beat` por
// otro con el mismo id) llegue antes o después de marcar las estrellas.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

vi.mock("../../src/platform", () => ({
  platform: {
    kind: "web",
    capabilities: { reviewBeatCloudCommit: true, directGalerCloudTransport: false },
    importer: { slotFilesForBeat: () => ({ MASTER: { name: "Review Beat.mp3" } }), pickSlotFile: vi.fn(async () => null) },
  },
}));
import Drawer from "../../src/components/Drawer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const beat = (over: Partial<Beat> = {}): Beat => ({ id: "review-1", name: "Review Beat", folder_path: "web-file://review-1", mp3_path: "Review Beat.mp3", wav_path: null, playback_path: "blob:review", bpm: "", key: "", needs_resolution: false, tags: [], rating: 0, image_base64: null, has_wav: false, has_stems: false, has_samples: false, samples_path: null, has_flp: false, has_als: false, stems_path: null, flp_path: null, als_path: null, other_files: [], color: "#777777", color2: "#999999", has_loop: false, loop_path: null, ...over }) as Beat;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; document.body.innerHTML = ""; });

async function setup() {
  const onSaved = vi.fn(async () => undefined);
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); cleanup = async () => act(async () => root.unmount());
  const render = (b: Beat) => act(async () => { root.render(<Drawer beat={b} mode="edit" reviewInfo={{ current: 1, total: 1 }} closeAfterSave={false} mutationAllowed onClose={() => undefined} onSaved={onSaved} onReleaseAudio={() => undefined} />); });
  await render(beat());
  const stars = () => [...host.querySelectorAll("[data-star-filled]")].map((x) => x.textContent).join("");
  const star = (n: number) => act(async () => { (host.querySelectorAll("[data-star-filled]")[n - 1] as HTMLElement).click(); });
  const save = () => act(async () => { (Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Save and finish") as HTMLButtonElement).click(); });
  return { host, onSaved, render, stars, star, save };
}

describe("E85 rating en la revisión de un beat nuevo", () => {
  it("estrellas marcadas y guardado inmediato: onSaved recibe rating 3", async () => {
    const t = await setup(); await t.star(3); expect(t.stars()).toBe("★★★☆☆"); await t.save();
    expect((t.onSaved.mock.calls[0] as unknown as [Beat])[0].rating).toBe(3);
  });
  it("la hidratación del ID3 llega DESPUÉS de marcar las estrellas (mismo id, rating 0): se conservan", async () => {
    const t = await setup(); await t.star(4);
    await t.render(beat({ bpm: "140", key: "Am", tags: ["trap"], image_base64: "data:image/png;base64,iVBORw==" }));
    expect(t.stars()).toBe("★★★★☆"); await t.save();
    const saved = (t.onSaved.mock.calls[0] as unknown as [Beat])[0]; expect([saved.rating, saved.bpm]).toEqual([4, "140"]);
  });
  it("la hidratación llega ANTES: las estrellas marcadas después también se guardan", async () => {
    const t = await setup(); await t.render(beat({ bpm: "140", tags: ["trap"] })); await t.star(5); await t.save();
    expect((t.onSaved.mock.calls[0] as unknown as [Beat])[0].rating).toBe(5);
  });
});

describe("E86 estrellas del ID3 en la revisión", () => {
  it("la hidratación trae rating 4 y el usuario no tocó nada: se ven y se guardan 4", async () => {
    const t = await setup(); await t.render(beat({ rating: 4, bpm: "159" }));
    expect(t.stars()).toBe("★★★★☆"); await t.save();
    expect((t.onSaved.mock.calls[0] as unknown as [Beat])[0].rating).toBe(4);
  });
  it("si el usuario cambia las estrellas ANTES de que llegue la hidratación, prevalece su elección", async () => {
    const t = await setup(); await t.star(2); await t.render(beat({ rating: 4, bpm: "159" }));
    expect(t.stars()).toBe("★★☆☆☆"); await t.save();
    expect((t.onSaved.mock.calls[0] as unknown as [Beat])[0].rating).toBe(2);
  });
  it("si cambia las estrellas DESPUÉS de la hidratación, también prevalece su elección", async () => {
    const t = await setup(); await t.render(beat({ rating: 4 })); await t.star(1); await t.save();
    expect((t.onSaved.mock.calls[0] as unknown as [Beat])[0].rating).toBe(1);
  });
});
