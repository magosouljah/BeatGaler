const CONDITIONS = [
  "apertura_fria",
  "reapertura_caliente",
  "reload_caliente",
  "play_tras_biblioteca_autoritativa",
];
const ACCOUNT_LABELS = ["01", "02", "03", "04", "05"];

export function validateDirectPostgresPreflight(report) {
  const accounts = Object.entries(report?.accounts || {});
  const directIdentity = (report?.scenarios || []).find(item => item.name === "multi_account_direct_identity");
  const evidence = accounts.map(([label, account]) => {
    const starts = (account.auth_network || []).filter(entry =>
      entry.route === "/beatgaler-api/transport/session/start" && entry.state === "response",
    );
    return {
      label,
      vault_present: Boolean(account.vault_chat_id),
      transport_present: Boolean(account.transport_id),
      successful_session_starts: starts.filter(entry => Number(entry.status) >= 200 && Number(entry.status) < 300).length,
      failed_session_starts: starts.filter(entry => Number(entry.status) >= 400).length,
    };
  });
  const ok = report?.requested_account_count === 5 && report?.web_server_mode === "vite-preview" &&
    directIdentity?.status === "PASS" && evidence.length === 5 &&
    evidence.every(item => item.vault_present && item.transport_present && item.successful_session_starts > 0);
  return {
    ok,
    accounts: evidence,
    stage1_overall: report?.overall || null,
    stage1_failure_code: report?.failure?.code || null,
    direct_identity: directIdentity?.status || null,
  };
}

export function summarize(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return { samples: 0, p95_ms: null, max_ms: null, avg_ms: null };
  return {
    samples: sorted.length,
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max_ms: sorted.at(-1),
    avg_ms: Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 10) / 10,
  };
}

export function normalizePhase2Task0Run({ report, runId, identity }) {
  const raw = report?.phase2_task0?.samples || {};
  const samples = Object.fromEntries(CONDITIONS.map(condition => [condition, []]));
  const reasons = [];
  for (const condition of CONDITIONS) {
    for (const [index, item] of (raw[condition] || []).entries()) {
      const start = condition === "play_tras_biblioteca_autoritativa" ? item.clicked_at_ms : item.started_at_ms;
      const end = condition === "play_tras_biblioteca_autoritativa" ? item.first_playing_at_ms : item.ready_at_ms;
      const validTimestamps = Number.isFinite(start) && Number.isFinite(end) && end >= start;
      const authority = condition === "play_tras_biblioteca_autoritativa"
        ? Number.isFinite(item.library_ready_at_ms) && item.library_ready_at_ms <= start &&
          Number(item.progress_seconds) >= 0.5 && Boolean(item.beat_id)
        : Boolean(item.get_index?.operation_id);
      if (!validTimestamps || !authority || !ACCOUNT_LABELS.includes(item.account_label)) {
        reasons.push(`${condition}[${index}]: faltan timestamps o prueba autoritativa.`);
        continue;
      }
      samples[condition].push({
        account: item.account_label,
        round: item.round ?? null,
        started_at_ms: start,
        completed_at_ms: end,
        duration_ms: end - start,
        source: `phase2_task0.samples.${condition}[${index}]`,
      });
    }
  }
  const statistics = Object.fromEntries(CONDITIONS.map(condition => [condition, {
    ...summarize(samples[condition].map(item => item.duration_ms)),
    accounts: [...new Set(samples[condition].map(item => item.account))].sort(),
  }]));
  if (report?.workload_mode !== "phase2-task0-four-conditions") reasons.push("El reporte no es del modo exclusivo de Task 0.");
  if (report?.requested_account_count !== 5) reasons.push("La corrida requiere cinco cuentas.");
  if (report?.web_server_mode !== "vite-preview") reasons.push("Web no corrió sobre vite preview.");
  if (report?.overall !== "PASS" || report?.failure) reasons.push("El recorrido de las cuatro condiciones no terminó correctamente.");
  if (report?.baseline_sha !== identity.head ||
      report?.experiment_identity?.working_tree_fingerprint !== identity.source_sha256) {
    reasons.push("La revisión del reporte no coincide con Web y Cloud.");
  }
  if (!CONDITIONS.every(condition => report?.phase2_task0?.completed_conditions?.includes(condition))) {
    reasons.push("Falta la confirmación de una o más condiciones.");
  }
  for (const condition of CONDITIONS) {
    const expectedPerAccount = condition === "apertura_fria" || condition === "reapertura_caliente" ? 1 : 4;
    for (const account of ACCOUNT_LABELS) {
      const accountSamples = samples[condition].filter(item => item.account === account);
      if (accountSamples.length !== expectedPerAccount) {
        reasons.push(`${condition}: cuenta ${account} completó ${accountSamples.length}/${expectedPerAccount} muestras.`);
      }
      if (expectedPerAccount === 4 && new Set(accountSamples.map(item => item.round)).size !== 4) {
        reasons.push(`${condition}: cuenta ${account} no completó cuatro rondas distintas.`);
      }
    }
  }
  const errors = [
    ...(report?.failure ? [{ source: "e2e", code: report.failure.code }] : []),
    ...Object.entries(report?.accounts || {}).flatMap(([account, value]) =>
      (value.auth_network || []).filter(entry =>
        entry.state === "network-error" || entry.state === "aborted" ||
        (entry.state === "response" && Number(entry.status) >= 400)
      ).map(entry => ({ source: "auth_network", account, route: entry.route, state: entry.state, status: entry.status }))),
  ];
  return {
    schema_version: 2,
    run_id: runId,
    started_at: report?.started_at || null,
    finished_at: report?.finished_at || null,
    identity,
    account_count: 5,
    web_mode: "vite-preview",
    condition_definitions: {
      apertura_fria: "Desde apertura con perfil nuevo e inicio de sesión hasta biblioteca autoritativa utilizable.",
      reapertura_caliente: "Desde navegación de vuelta con sesión activa hasta biblioteca autoritativa utilizable.",
      reload_caliente: "Desde Reload con sesión activa hasta biblioteca autoritativa utilizable.",
      play_tras_biblioteca_autoritativa: "Desde clic en Play tras biblioteca autoritativa hasta audio sonando con progreso.",
    },
    samples,
    statistics,
    errors,
    validity: { status: reasons.length ? "INVALID" : "VALID", reasons },
    budgets_observational_only: {
      reload_caliente_p95_ms: 5000,
      play_tras_biblioteca_autoritativa_p95_ms: 2000,
    },
  };
}
