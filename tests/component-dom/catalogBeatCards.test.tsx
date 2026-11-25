// C11: los envoltorios de BeatCard del catalogo producen el MISMO DOM que BeatCard con todas las props inertes explicitas (como estaba en CatalogAppShell).
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import BeatCard from "../../src/components/BeatCard";
import { CatalogBeatCard, ProvisionalBeatCard } from "../../src/features/library/catalog/CatalogBeatCards";
import type { Beat } from "../../src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class FakeIO { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
let host: HTMLElement | null = null;
let root: Root | null = null;
afterEach(async () => { await act(async () => { root?.unmount(); }); host?.remove(); host = null; root = null; });
async function html(el: React.ReactElement): Promise<string> {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(el); });
  const out = host.innerHTML;
  await act(async () => { root!.unmount(); }); host.remove(); host = null; root = null;
  return out;
}
const beat = { id: "beat-1", name: "Mi Beat", bpm: "120", key: "Cm", tags: ["trap", "dark"], rating: 3, cloud_status: "SYNCED", path: "", added_at: 1 } as unknown as Beat;
const tagFrequency = new Map<string, number>([["trap", 2]]);
const fn = () => undefined;
type Extra = { playing: boolean; selected: boolean; selectedCount: number; selectMode: boolean; online: boolean; playbackInteractive: boolean };

// Props explicitas, copiadas tal cual de CatalogAppShell antes de C11.
const liveExplicit = (x: Extra) => (
  <BeatCard beat={beat} visible interactive playbackInteractive={x.playbackInteractive} openableProject={false} tagFrequency={tagFrequency} showIncompleteWarnings
    playing={x.playing} selected={x.selected} selectedCount={x.selectedCount} selectMode={x.selectMode}
    dragEnabled={false} networkOnline={x.online} offlineBusy={false} canUseOfflinePackage={false} canUseLocalHelper={false} canInspectNativeProject={false}
    onToggleOffline={fn} onRetryUpload={fn} onBulkEdit={fn} onBulkUpload={fn} onBulkDelete={fn} onPlay={fn} onWarm={fn} onDetail={fn} onEdit={fn} onDelete={fn} onAddToQueue={fn}
    onUpload={fn} onUploadTelegram={fn} onDownloadTelegram={fn} onUploadProjectTelegram={fn} onOpenProject={fn} onUpdateProject={fn} onCloudFiles={fn} onToggleSelect={fn} animDelay={0} />);
const liveWrapped = (x: Extra) => (
  <CatalogBeatCard beat={beat} playbackInteractive={x.playbackInteractive} tagFrequency={tagFrequency} showIncompleteWarnings
    playing={x.playing} selected={x.selected} selectedCount={x.selectedCount} selectMode={x.selectMode} networkOnline={x.online}
    onBulkEdit={fn} onBulkDelete={fn} onPlay={fn} onWarm={fn} onDetail={fn} onEdit={fn} onDelete={fn} onAddToQueue={fn} onCloudFiles={fn} onToggleSelect={fn} />);

describe("CatalogBeatCard / ProvisionalBeatCard: DOM identico a las props explicitas", () => {
  const cases: Extra[] = [
    { playing: false, selected: false, selectedCount: 0, selectMode: false, online: true, playbackInteractive: true },
    { playing: true, selected: true, selectedCount: 2, selectMode: true, online: true, playbackInteractive: true },
    { playing: false, selected: false, selectedCount: 0, selectMode: false, online: false, playbackInteractive: false },
  ];
  for (const [i, c] of cases.entries()) {
    it(`viva, caso ${i + 1}`, async () => {
      const a = await html(liveExplicit(c));
      const b = await html(liveWrapped(c));
      expect(a).toContain('data-beat-card-id="beat-1"');
      expect(b).toBe(a);
    });
  }
  it("provisional (E83)", async () => {
    const a = await html(
      <BeatCard beat={beat} visible interactive={false} playbackInteractive={false} openableProject={false} tagFrequency={tagFrequency} showIncompleteWarnings={false}
        playing={false} selected={false} selectedCount={0} selectMode={false}
        dragEnabled={false} networkOnline offlineBusy={false} canUseOfflinePackage={false} canUseLocalHelper={false} canInspectNativeProject={false}
        onToggleOffline={fn} onRetryUpload={fn} onBulkEdit={fn} onBulkUpload={fn} onBulkDelete={fn}
        onPlay={fn} onWarm={fn} onDetail={fn} onEdit={fn} onDelete={fn} onAddToQueue={fn}
        onUpload={fn} onUploadTelegram={fn} onDownloadTelegram={fn} onUploadProjectTelegram={fn} onOpenProject={fn} onUpdateProject={fn} onCloudFiles={fn}
        onToggleSelect={fn} animDelay={0} />);
    const b = await html(<ProvisionalBeatCard beat={beat} tagFrequency={tagFrequency} networkOnline />);
    expect(a.length).toBeGreaterThan(200);
    expect(b).toBe(a);
  });
  it("las acciones vivas siguen llegando a la tarjeta", async () => {
    const onPlay = vi.fn();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<CatalogBeatCard beat={beat} playbackInteractive tagFrequency={tagFrequency} showIncompleteWarnings playing={false} selected={false} selectedCount={0} selectMode={false} networkOnline
      onBulkEdit={fn} onBulkDelete={fn} onPlay={onPlay} onWarm={fn} onDetail={fn} onEdit={fn} onDelete={fn} onAddToQueue={fn} onCloudFiles={fn} onToggleSelect={fn} />); });
    await act(async () => { (host!.querySelector('[data-beat-artwork-id="beat-1"]') as HTMLElement).click(); });
    expect(onPlay).toHaveBeenCalledExactlyOnceWith(beat);
  });
});
