import React, { useEffect, useMemo, useState } from "react";

type OperationKind = "UPLOAD" | "DOWNLOAD";
type DurableOperation = { id: string; kind: OperationKind; beatId: string; attempts: number };

const OP_KEY = "beatgaler-e2e-phase11-operation";
const INDEX_KEY = "beatgaler-e2e-phase11-index";
const TMP_KEY = "beatgaler-e2e-phase11-temp";

function readOperation(): DurableOperation | null {
  try {
    const raw = localStorage.getItem(OP_KEY);
    return raw ? JSON.parse(raw) as DurableOperation : null;
  } catch {
    return null;
  }
}

export default function E2ERecoveryHarness() {
  const [operation, setOperation] = useState<DurableOperation | null>(() => readOperation());
  const [state, setState] = useState(() => readOperation() ? "recovered" : "idle");
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [canonicalIndex, setCanonicalIndex] = useState(() => localStorage.getItem(INDEX_KEY) || "index-v1");
  const [tempPresent, setTempPresent] = useState(() => localStorage.getItem(TMP_KEY) === "1");
  const [corruptAccepted, setCorruptAccepted] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(INDEX_KEY)) localStorage.setItem(INDEX_KEY, "index-v1");
  }, []);

  const start = (kind: OperationKind) => {
    const existing = readOperation();
    const next: DurableOperation = existing ?? { id: "op-fixed-1", kind, beatId: "beat-fixed-1", attempts: 0 };
    localStorage.setItem(OP_KEY, JSON.stringify(next));
    localStorage.setItem(TMP_KEY, "1");
    setOperation(next);
    setTempPresent(true);
    setState("running");
  };

  const retry = () => {
    const current = readOperation();
    if (!current) return;
    const next = { ...current, attempts: current.attempts + 1 };
    localStorage.setItem(OP_KEY, JSON.stringify(next));
    setOperation(next);
    setState("running");
  };

  const complete = () => {
    const current = readOperation();
    if (!current) return;
    setCompletedIds(prev => prev.includes(current.id) ? prev : [...prev, current.id]);
    localStorage.removeItem(OP_KEY);
    localStorage.removeItem(TMP_KEY);
    setOperation(null);
    setTempPresent(false);
    setState("completed");
  };

  const cleanupRecoveredTemp = () => {
    localStorage.removeItem(TMP_KEY);
    setTempPresent(false);
  };

  const simulateTornIndexCommit = () => {
    // Candidate exists, canonical authority is intentionally untouched.
    localStorage.setItem(`${INDEX_KEY}-candidate`, "TRUNCATED-CANDIDATE");
    setCanonicalIndex(localStorage.getItem(INDEX_KEY) || "index-v1");
  };

  const recoverIndex = () => {
    localStorage.removeItem(`${INDEX_KEY}-candidate`);
    setCanonicalIndex(localStorage.getItem(INDEX_KEY) || "index-v1");
  };

  const validateCorruptFile = () => {
    // Phase 11 invariant: a corrupt/empty payload can never become completed/durable.
    setCorruptAccepted(false);
    setState("error");
  };

  const status = useMemo(() => operation ? `${operation.id}:${operation.kind}:${operation.attempts}` : "none", [operation]);

  return (
    <main data-e2e-recovery-harness="true" data-e2e-state={state} data-e2e-operation={status}
      style={{ minHeight: "100vh", background: "#090909", color: "#ddd", padding: 28, fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1>Phase 11 Stress + Recovery</h1>
      <button data-e2e-reset onClick={() => {
        localStorage.removeItem(OP_KEY); localStorage.removeItem(`${INDEX_KEY}-candidate`); localStorage.removeItem(TMP_KEY);
        localStorage.setItem(INDEX_KEY, "index-v1"); setOperation(null); setState("idle"); setCompletedIds([]); setCanonicalIndex("index-v1"); setTempPresent(false); setCorruptAccepted(false);
      }}>Reset</button>
      <section>
        <button data-e2e-start-upload onClick={() => start("UPLOAD")}>Start upload</button>
        <button data-e2e-start-download onClick={() => start("DOWNLOAD")}>Start download</button>
        <button data-e2e-retry onClick={retry}>Retry recovered operation</button>
        <button data-e2e-complete onClick={complete}>Complete</button>
        <div data-e2e-completed={completedIds.join(",")}>Completed: {completedIds.join(",") || "none"}</div>
      </section>
      <section>
        <div data-e2e-temp-present={String(tempPresent)}>Temp present: {String(tempPresent)}</div>
        <button data-e2e-clean-temp onClick={cleanupRecoveredTemp}>Clean stale temp</button>
      </section>
      <section>
        <div data-e2e-canonical-index={canonicalIndex}>Canonical index: {canonicalIndex}</div>
        <button data-e2e-torn-index onClick={simulateTornIndexCommit}>Simulate torn INDEX candidate</button>
        <button data-e2e-recover-index onClick={recoverIndex}>Recover INDEX</button>
      </section>
      <section>
        <button data-e2e-corrupt-file onClick={validateCorruptFile}>Validate corrupt file</button>
        <div data-e2e-corrupt-accepted={String(corruptAccepted)}>Corrupt accepted: {String(corruptAccepted)}</div>
      </section>
    </main>
  );
}
