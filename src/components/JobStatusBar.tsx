import React, { useEffect, useState } from "react";
import { subscribeJobs, updateJob, removeJob, type JobInfo } from "../lib/jobStore";
import { cancelYoutubeUpload } from "../lib/tauri";
import { sanitizeUserVisibleText } from "../lib/userVisibleError";

// Sets up ONE global listener for backend job events. Mounted once in
// App.tsx so it keeps running no matter which modal (if any) is open —
// this is what makes upload progress (and cancellation) survive closing
// UploadModal.
export default function JobStatusBar() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);

  useEffect(() => {
    const unsub = subscribeJobs(setJobs);

    const unlisteners: (() => void)[] = [];
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");

        const startedFn = await listen("youtube:started", (e: any) => {
          const payload = e.payload as any;
          if (!payload?.job_id) return;
          updateJob(payload.job_id, { status: "uploading" });
        });
        const doneFn = await listen("youtube:done", (e: any) => {
          const payload = e.payload as any;
          if (!payload?.job_id) return;
          updateJob(payload.job_id, { status: "done", url: payload.result?.url });
          setTimeout(() => removeJob(payload.job_id), 8000);
        });
        const errFn = await listen("youtube:error", (e: any) => {
          const payload = e.payload as any;
          if (!payload?.job_id) return;
          updateJob(payload.job_id, { status: "error", message: sanitizeUserVisibleText(payload.error ?? "Upload failed") });
        });
        const tagProgressFn = await listen("tag-rename:progress", (e: any) => {
          const payload = e.payload as any;
          if (!payload?.job_id) return;
          const progress = payload.total > 0 ? Math.round((payload.completed / payload.total) * 100) : 100;
          updateJob(payload.job_id, { status: "processing", progress, message: `${payload.completed}/${payload.total} files` });
        });
        const tagDoneFn = await listen("tag-rename:done", (e: any) => {
          const payload = e.payload as any;
          if (!payload?.job_id) return;
          updateJob(payload.job_id, { status: "done", progress: 100, message: `${payload.files_updated} files updated` });
          setTimeout(() => removeJob(payload.job_id), 8000);
        });
        const tagErrorFn = await listen("tag-rename:error", (e: any) => {
          const payload = e.payload as any;
          if (!payload?.job_id) return;
          updateJob(payload.job_id, { status: "error", message: sanitizeUserVisibleText(payload.error ?? "Tag rename failed") });
        });

        const cancelFn = await listen("youtube:cancelled", (e: any) => {
          const payload = e.payload as any;
          if (!payload?.job_id) return;
          updateJob(payload.job_id, { status: "cancelled", message: "Cancelado" });
          setTimeout(() => removeJob(payload.job_id), 4000);
        });

        if (cancelled) { startedFn(); doneFn(); errFn(); cancelFn(); tagProgressFn(); tagDoneFn(); tagErrorFn(); return; }
        unlisteners.push(startedFn, doneFn, errFn, cancelFn, tagProgressFn, tagDoneFn, tagErrorFn);
      } catch {
        // Not running under Tauri (dev/browser mode) — nothing to listen to.
      }
    })();

    return () => {
      cancelled = true;
      unsub();
      unlisteners.forEach(fn => fn());
    };
  }, []);

  if (jobs.length === 0) return null;

  const handleDismissOrCancel = (job: JobInfo) => {
    if (job.kind !== "tag-rename" && (job.status === "uploading" || job.status === "queued")) {
      updateJob(job.id, { status: "cancelling" });
      cancelYoutubeUpload(job.id).catch(() => {
        updateJob(job.id, { status: "error", message: "No se pudo cancelar" });
      });
    } else {
      removeJob(job.id);
    }
  };

  return (
    <div style={{
      position: "fixed", bottom: 18, right: 18, zIndex: 500,
      display: "flex", flexDirection: "column", gap: 8, maxWidth: 320,
    }}>
      {jobs.map(job => (
        <div key={job.id} style={{
          background: "#141414", border: "1px solid #262626", borderRadius: 10,
          padding: "12px 14px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {job.status === "queued" && (
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#888" }} />
            )}
            {(job.status === "uploading" || job.status === "processing" || job.status === "cancelling") && (
              <div style={{
                width: 16, height: 16, borderRadius: "50%",
                border: "2px solid #333", borderTopColor: job.status === "cancelling" ? "#f59e0b" : "#4ade80",
                animation: "spin 0.8s linear infinite",
              }} />
            )}
            {job.status === "done" && <span style={{ color: "#4ade80", fontSize: 16 }}></span>}
            {job.status === "error" && <span style={{ color: "#f87171", fontSize: 16 }}></span>}
            {job.status === "cancelled" && <span style={{ color: "#777", fontSize: 16 }}>–</span>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "#e0e0e0", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {job.title}
            </div>
            <div style={{ fontSize: 11, color: job.status === "error" ? "#f87171" : "#666", marginTop: 2 }}>
              {job.status === "queued" && "En cola…"}
              {job.status === "uploading" && "Subiendo a YouTube…"}
              {job.status === "processing" && (job.message || `Procesando… ${job.progress ?? 0}%`)}
              {job.status === "cancelling" && "Cancelando…"}
              {job.status === "cancelled" && "Cancelado"}
              {job.status === "done" && (
                job.url
                  ? <a href={job.url} target="_blank" rel="noreferrer" style={{ color: "#93c5fd" }}>Listo — ver en YouTube</a>
                  : "Listo"
              )}
              {job.status === "error" && (job.message || "Falló la subida")}
            </div>
            {job.kind === "tag-rename" && (job.status === "processing" || job.status === "queued") && (
              <div style={{ height: 3, background: "#292929", borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
                <div style={{ width: `${job.progress ?? 0}%`, height: "100%", background: "#a3a3a3", transition: "width 0.15s" }} />
              </div>
            )}
          </div>
          <button
            onClick={() => handleDismissOrCancel(job)}
            disabled={job.status === "cancelling"}
            title={job.kind !== "tag-rename" && job.status === "uploading" ? "Cancelar subida" : "Cerrar"}
            style={{
              background: "none", border: "none", color: "#555", fontSize: 14, flexShrink: 0,
              cursor: job.status === "cancelling" ? "default" : "pointer",
              opacity: job.status === "cancelling" ? 0.4 : 1,
            }}>
            
          </button>
        </div>
      ))}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
