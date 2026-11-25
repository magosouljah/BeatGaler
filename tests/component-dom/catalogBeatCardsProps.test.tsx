// C11: valores exactos de las props que los envoltorios pasan a BeatCard (cubre las props inertes que no cambian el DOM en este escenario).
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

const seen: Array<Record<string, unknown>> = [];
vi.mock("../../src/components/BeatCard", () => ({ default: (props: Record<string, unknown>) => { seen.push(props); return null; } }));
const { CatalogBeatCard, ProvisionalBeatCard } = await import("../../src/features/library/catalog/CatalogBeatCards");

const beat = { id: "b" } as unknown as Beat;
const tf = new Map<string, number>();
const fn = () => undefined;
const INERT_VALUES = {
  visible: true, openableProject: false, dragEnabled: false, offlineBusy: false,
  canUseOfflinePackage: false, canUseLocalHelper: false, canInspectNativeProject: false, animDelay: 0,
};
const INERT_FNS = ["onToggleOffline", "onRetryUpload", "onBulkUpload", "onUpload", "onUploadTelegram", "onDownloadTelegram", "onUploadProjectTelegram", "onOpenProject", "onUpdateProject"];

describe("props exactas de los envoltorios de BeatCard", () => {
  it("CatalogBeatCard: inertes fijas, vivas tal cual, interactive true", () => {
    seen.length = 0;
    const live = { onPlay: vi.fn(), onEdit: vi.fn() };
    renderToStaticMarkup(<CatalogBeatCard beat={beat} playbackInteractive tagFrequency={tf} showIncompleteWarnings playing selected selectedCount={3} selectMode networkOnline={false}
      onBulkEdit={fn} onBulkDelete={fn} onPlay={live.onPlay} onWarm={fn} onDetail={fn} onEdit={live.onEdit} onDelete={fn} onAddToQueue={fn} onCloudFiles={fn} onToggleSelect={fn} />);
    const p = seen[0];
    expect(p).toMatchObject({ ...INERT_VALUES, interactive: true, playbackInteractive: true, showIncompleteWarnings: true, playing: true, selected: true, selectedCount: 3, selectMode: true, networkOnline: false });
    for (const k of INERT_FNS) expect(typeof p[k]).toBe("function");
    expect(p.onPlay).toBe(live.onPlay);
    expect(p.onEdit).toBe(live.onEdit);
    expect(p.beat).toBe(beat);
  });
  it("ProvisionalBeatCard: sin interaccion ni reproduccion", () => {
    seen.length = 0;
    renderToStaticMarkup(<ProvisionalBeatCard beat={beat} tagFrequency={tf} networkOnline />);
    const p = seen[0];
    expect(p).toMatchObject({ ...INERT_VALUES, interactive: false, playbackInteractive: false, showIncompleteWarnings: false, playing: false, selected: false, selectedCount: 0, selectMode: false, networkOnline: true });
    for (const k of [...INERT_FNS, "onBulkEdit", "onBulkDelete", "onPlay", "onWarm", "onDetail", "onEdit", "onDelete", "onAddToQueue", "onCloudFiles", "onToggleSelect"]) expect(typeof p[k]).toBe("function");
  });
});
