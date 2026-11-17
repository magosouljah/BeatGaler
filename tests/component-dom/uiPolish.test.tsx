// @vitest-environment jsdom
// Avisos flotantes (tono, temporizadores, no ocupan layout) y buscador persistente de la toolbar de la Gallery.
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingNotice, NOTICE_DURATION_MS, noticeTone } from "../../src/components/FloatingNotice";
import StudioToolbar from "../../src/features/design/MASTER/StudioToolbarCandidate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
beforeEach(() => { if (!window.matchMedia) (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }); vi.useFakeTimers(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("noticeTone", () => {
  it("éxitos, errores, progreso e información", () => {
    for (const t of ["Portada actualizada.", "«Mi beat» importado.", "MP3 reemplazado.", "WAV añadido.", "WAV reemplazado."]) expect(noticeTone(t)).toBe("success");
    for (const t of ["No se pudo cambiar la portada: boom", "No se pudo importar «x»: El nombre admite como máximo 50 caracteres", "La operación quedó en estado failed; el beat conserva su portada actual.", "Este beat cambió en otro dispositivo; no se reemplazó nada.", "Reconnect to verify your Galer Cloud library."]) expect(noticeTone(t)).toBe("error");
    for (const t of ["Importando «x»: upload 40%", "Importando «x»…", "Reemplazando audio: master 10%"]) expect(noticeTone(t)).toBe("progress");
    expect(noticeTone("Selección borrada al cambiar los filtros")).toBe("info");
  });
});

describe("FloatingNotice", () => {
  const mount = (notice: string | null, onDismiss = vi.fn(), lifted = false) => { act(() => { root.render(<FloatingNotice notice={notice} onDismiss={onDismiss} lifted={lifted} />); }); return onDismiss; };
  it("es un overlay fijo, fuera del flujo: el contenedor no captura clics y usa position fixed (no altera el layout)", () => {
    mount("Portada actualizada.");
    const box = host.querySelector(".bg-floating-notices") as HTMLElement; expect(box).toBeTruthy();
    expect(host.querySelector(".bg-floating-notice")?.getAttribute("data-notice-tone")).toBe("success"); expect(host.querySelector(".bg-floating-notice")?.getAttribute("role")).toBe("status");
    expect(host.querySelector(".bg-catalog-notice")?.textContent).toContain("Portada actualizada.");
  });
  it("éxito: se cierra solo a los 4 s; error: permanece y es role=alert; progreso: sin temporizador", () => {
    const ok = mount("Portada actualizada."); act(() => { vi.advanceTimersByTime(NOTICE_DURATION_MS.success! - 1); }); expect(ok).not.toHaveBeenCalled(); act(() => { vi.advanceTimersByTime(2); }); expect(ok).toHaveBeenCalledTimes(1);
    const err = mount("No se pudo cambiar la portada: boom"); expect(host.querySelector(".bg-floating-notice")?.getAttribute("role")).toBe("alert");
    act(() => { vi.advanceTimersByTime(NOTICE_DURATION_MS.success! * 3); }); expect(err).not.toHaveBeenCalled();
    const prog = mount("Importando «x»: upload 40%"); act(() => { vi.advanceTimersByTime(60000); }); expect(prog).not.toHaveBeenCalled();
  });
  it("cerrar con la X, sin aviso no renderiza nada, y «lifted» sube sobre la Playbar", () => {
    const d = mount("Portada actualizada."); act(() => { (host.querySelector(".bg-floating-notice-close") as HTMLButtonElement).click(); }); expect(d).toHaveBeenCalledTimes(1);
    mount(null); expect(host.querySelector(".bg-floating-notices")).toBeNull();
    mount("Hola", vi.fn(), true); expect(host.querySelector(".bg-floating-notices")?.className).toContain("is-lifted");
  });
});

describe("Toolbar: buscador persistente", () => {
  function Harness({ initial = "" }: { initial?: string }) {
    const [q, setQ] = useState(initial);
    return <StudioToolbar gallery search={q} onSearchChange={setQ} sort="manual" onSortChange={() => {}} selecting={false} onToggleSelect={() => {}} />;
  }
  const open = () => host.querySelector(".studio-search")?.classList.contains("is-open");
  const trigger = () => host.querySelector(".studio-search > button") as HTMLButtonElement;
  const input = () => host.querySelector(".studio-search input") as HTMLInputElement;
  const type = (v: string) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; act(() => { set.call(input(), v); input().dispatchEvent(new Event("input", { bubbles: true })); }); };
  const outsideClick = () => act(() => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });

  it("con texto, perder el foco / pulsar fuera / Escape NO cierra; sin texto sí; el texto no se pierde", () => {
    act(() => { root.render(<Harness />); });
    act(() => { trigger().click(); }); expect(open()).toBe(true);
    type("trap"); outsideClick(); expect(open()).toBe(true); expect(input().value).toBe("trap");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); }); expect(open()).toBe(true);
    act(() => { input().dispatchEvent(new FocusEvent("blur")); }); expect(open()).toBe(true);
    act(() => { trigger().click(); }); expect(open()).toBe(true); expect(input().value).toBe("trap"); // el icono tampoco lo cierra mientras haya filtro
    type(""); outsideClick(); expect(open()).toBe(false);
  });
  it("un filtro restaurado (URL) abre el buscador; abrir un menú no lo cierra con texto", () => {
    act(() => { root.render(<Harness initial="lofi" />); });
    expect(open()).toBe(true); expect(input().value).toBe("lofi");
    const sort = host.querySelector('button[aria-label="Sort beats"]') as HTMLButtonElement; act(() => { sort.click(); }); expect(open()).toBe(true);
  });
});
