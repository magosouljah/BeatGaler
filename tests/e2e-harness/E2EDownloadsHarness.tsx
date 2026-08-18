import React, { useMemo, useState } from "react";

type Kind = "MP3" | "WAV" | "PROJECT" | "ALL";
type DownloadState = "idle" | "downloading" | "completed" | "error";

export default function E2EDownloadsHarness() {
  const [state, setState] = useState<DownloadState>("idle");
  const [kind, setKind] = useState<Kind | null>(null);
  const [downloaded, setDownloaded] = useState<Kind[]>([]);
  const [projectCached, setProjectCached] = useState(false);
  const [projectOpened, setProjectOpened] = useState(false);
  const [projectCorrupt, setProjectCorrupt] = useState(false);
  const [everythingFolders, setEverythingFolders] = useState<string[]>([]);

  const status = useMemo(() => `${kind ?? "NONE"}:${state}`, [kind, state]);

  const start = (nextKind: Kind) => {
    setKind(nextKind);
    setState("downloading");
  };

  const complete = () => {
    if (!kind) return;
    setState("completed");
    setDownloaded(prev => prev.includes(kind) ? prev : [...prev, kind]);
    if (kind === "PROJECT") setProjectCached(true);
    if (kind === "ALL") {
      setEverythingFolders(prev => [...prev, prev.length === 0 ? "E2E Beat" : `E2E Beat (${prev.length})`]);
    }
  };

  const fail = () => setState("error");
  const retry = () => setState("downloading");

  const openProject = () => {
    if (!projectCached || projectCorrupt) return;
    setProjectOpened(true);
  };

  return (
    <main
      data-e2e-downloads-harness="true"
      data-e2e-status={status}
      data-e2e-downloaded={downloaded.join(",")}
      style={{ minHeight: "100vh", background: "#090909", color: "#ddd", padding: 28, fontFamily: "Inter, system-ui, sans-serif" }}
    >
      <h1>Phase 10 Downloads + PROJECT</h1>

      <section style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button data-e2e-download-mp3 onClick={() => start("MP3")}>Download MP3</button>
        <button data-e2e-download-wav onClick={() => start("WAV")}>Download WAV</button>
        <button data-e2e-download-project onClick={() => start("PROJECT")}>Download PROJECT</button>
        <button data-e2e-download-all onClick={() => start("ALL")}>Download Everything</button>
      </section>

      <section style={{ marginTop: 16 }}>
        <div data-e2e-download-state>{state}</div>
        <div data-e2e-download-kind>{kind ?? "NONE"}</div>
        {state === "downloading" && <div data-e2e-progress="true">Downloading…</div>}
        {state === "completed" && <div data-e2e-complete="true">Completed</div>}
        {state === "error" && <div data-e2e-error="true">Download failed</div>}
        <button data-e2e-complete-action disabled={state !== "downloading"} onClick={complete}>Complete worker</button>
        <button data-e2e-fail-action disabled={state !== "downloading"} onClick={fail}>Fail worker</button>
        <button data-e2e-retry-action disabled={state !== "error"} onClick={retry}>Retry</button>
      </section>

      <section style={{ marginTop: 20 }} data-e2e-project-section="true">
        <div data-e2e-project-cached={String(projectCached)}>PROJECT cached: {String(projectCached)}</div>
        <div data-e2e-project-corrupt={String(projectCorrupt)}>PROJECT corrupt: {String(projectCorrupt)}</div>
        <div data-e2e-project-opened={String(projectOpened)}>PROJECT opened: {String(projectOpened)}</div>
        <button data-e2e-open-project onClick={openProject}>Open Project</button>
        <button data-e2e-toggle-corrupt onClick={() => setProjectCorrupt(value => !value)}>Toggle corrupt ZIP</button>
      </section>

      <section style={{ marginTop: 20 }}>
        <div data-e2e-everything-folders={everythingFolders.join("|")}>Everything folders: {everythingFolders.join(" | ") || "none"}</div>
      </section>
    </main>
  );
}
