// Lightweight global store for background jobs (YouTube uploads, and any
// future long-running task). Lives outside React so a job's progress
// survives closing the modal that started it — only App-level UI
// (JobStatusBar) needs to be mounted to keep showing it.

export type JobStatus = "queued" | "uploading" | "processing" | "done" | "error" | "cancelling" | "cancelled";

export interface JobInfo {
  id: string;
  title: string;
  status: JobStatus;
  message?: string;
  url?: string;
  startedAt: number;
  progress?: number;
  kind?: "youtube" | "tag-rename";
}

type Listener = (jobs: JobInfo[]) => void;

let jobs: JobInfo[] = [];
let listeners: Listener[] = [];

function notify() {
  for (const l of listeners) l(jobs);
}

export function registerJob(id: string, title: string, kind: JobInfo["kind"] = "youtube") {
  // Avoid duplicate entries if something calls this twice for the same id.
  if (jobs.some(j => j.id === id)) return;
  jobs = [...jobs, { id, title, status: "queued", startedAt: Date.now(), kind }];
  notify();
}

export function updateJob(id: string, patch: Partial<JobInfo>) {
  if (!jobs.some(j => j.id === id)) return;
  jobs = jobs.map(j => (j.id === id ? { ...j, ...patch } : j));
  notify();
}

export function removeJob(id: string) {
  jobs = jobs.filter(j => j.id !== id);
  notify();
}

export function subscribeJobs(fn: Listener): () => void {
  listeners = [...listeners, fn];
  fn(jobs);
  return () => {
    listeners = listeners.filter(l => l !== fn);
  };
}
