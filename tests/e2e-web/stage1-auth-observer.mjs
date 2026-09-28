// Serialized by WebdriverIO and installed before any application script.
export function authPreload(emit) {
  const original = window.fetch;
  const originalConsole = {
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const diagnosticLogs = [];
  window.__stage1DiagnosticLogs = diagnosticLogs;

  const stage1TraceContext = () => {
    try {
      const correlationId = String(
        localStorage.getItem("beatgaler:stage1-trace:correlation") ||
        localStorage.getItem("beatgaler:stage1-focused-final-reload:correlation") ||
        "",
      ).trim();
      const accountLabel = String(
        localStorage.getItem("beatgaler:stage1-trace:account") ||
        localStorage.getItem("beatgaler:stage1-focused-final-reload:account") ||
        "",
      ).trim();
      if (!correlationId || !accountLabel) return null;
      const task2PassivePingTrace = localStorage.getItem("beatgaler:stage1-trace:task2-passive-ping") === "1";
      const context = {
        correlation_id: correlationId,
        account_label: accountLabel,
        ...(task2PassivePingTrace ? { task2_passive_ping_trace: true } : {}),
      };
      window.__stage1TraceContext = context;
      return context;
    } catch {
      return null;
    }
  };

  stage1TraceContext();

  const diagnosticText = value => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const shouldCaptureDiagnostic = text =>
    /\[web\/library\]|Telegram vault startup check failed|Telegram startup connectivity check failed|\[library-refresh\]|Reconnect attempt|\[library-tx\]|TRANSPORT_GET_INDEX|WORKER_(?:INITIALIZE|REQUEST|RESPONSE|INDEX)|CONTROLLER_SESSION|CONTROLLER_BACKGROUND_VERIFY|DIRECT_BACKGROUND_GET_(?:ME|CHAT)|INDEX_(?:BEGIN|RESUMED|DONE|PREEMPTED)|AUTH_RESTORE|APP_ENTRY/i.test(text);

  for (const level of ["info", "warn", "error"]) {
    console[level] = (...args) => {
      try {
        const text = args.map(diagnosticText).join(" ");
        if (shouldCaptureDiagnostic(text)) {
          diagnosticLogs.push({
            level,
            at: Date.now(),
            text: text
              .replace(/\b[A-Za-z0-9_+\/-]{32,}={0,2}\b/g, "[REDACTED]")
              .slice(0, 1600),
          });
          if (diagnosticLogs.length > 100) diagnosticLogs.shift();
        }
        if (text.startsWith("[play-trace]")) {
          const parsed = JSON.parse(text.slice("[play-trace]".length).trim());
          const context = stage1TraceContext();
          if (context && parsed && typeof parsed.stage === "string") {
            publish({ kind: "play-trace", timestamp_wall_clock: new Date().toISOString(), ...context, trace: parsed });
          }
        }
      } catch {}
      return originalConsole[level](...args);
    };
  }

  const documentId = crypto.randomUUID();
  let sequence = 0;

  const publish = value => {
    try {
      emit(value);
    } catch {
      // Observation must not affect auth.
    }
  };

  const publishDocumentMilestone = event => {
    const traceContext = stage1TraceContext();
    publish({
      kind: "document-milestone",
      event,
      document_id: documentId,
      timestamp_wall_clock: new Date().toISOString(),
      monotonic_ms: Math.round(performance.now() * 10) / 10,
      ...(traceContext || {}),
    });
  };

  publishDocumentMilestone("document_start");
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("DOMContentLoaded", () => publishDocumentMilestone("dom_content_loaded"), { once: true });
  }
  if (typeof window.addEventListener === "function") window.addEventListener("load", () => {
    publishDocumentMilestone("window_load");
    const entry = performance.getEntriesByType("navigation").at(-1);
    if (!entry) return;
    const traceContext = stage1TraceContext();
    publish({
      kind: "navigation-timing",
      document_id: documentId,
      timestamp_wall_clock: new Date().toISOString(),
      ...(traceContext || {}),
      navigation: Object.fromEntries([
        "fetchStart", "connectStart", "connectEnd", "requestStart", "responseStart", "responseEnd",
        "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd", "loadEventStart", "loadEventEnd",
      ].map(key => [key, entry[key]])),
    });
  }, { once: true });

  const requests = new Map();

  const resourceObserver =
    typeof PerformanceObserver === "function"
      ? new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            const candidates = [...requests.values()].filter(
              value => value.url === entry.name && value.start <= entry.startTime + 1,
            );

            const match = candidates.sort((a, b) => b.start - a.start)[0];
            if (!match) continue;

            const timing = {};
            for (const key of [
              "startTime",
              "fetchStart",
              "domainLookupStart",
              "domainLookupEnd",
              "connectStart",
              "connectEnd",
              "requestStart",
              "responseStart",
              "responseEnd",
              "duration",
            ]) {
              timing[key] = entry[key];
            }

            publish({ id: match.id, resource_timing: timing });
          }
        })
      : null;

  resourceObserver?.observe({ type: "resource", buffered: true });

  window.__stage1RestoreFetch = () => {
    window.fetch = original;
    for (const level of ["info", "warn", "error"]) {
      console[level] = originalConsole[level];
    }
    resourceObserver?.disconnect();
  };

  window.fetch = async function (...args) {
    let route;
    let requestUrl;

    try {
      const input = args[0];
      const url = new URL(
        typeof input === "string" ? input : input.url || String(input),
        location.href,
      );

      if (
        url.origin === location.origin &&
        [
          "/beatgaler-api/auth/health",
          "/beatgaler-api/auth/session",
          "/beatgaler-api/auth/account",
          "/beatgaler-api/auth/login",
          "/beatgaler-api/auth/logout",
          "/beatgaler-api/transport/session/start",
          "/beatgaler-api/transport/session/activate",
          "/beatgaler-api/transport/session/stop",
          "/beatgaler-api/transport/operation/begin",
          "/beatgaler-api/transport/capability/authorize",
          "/beatgaler-api/transport/operation/renew",
          "/beatgaler-api/transport/operation/end",
        ].includes(url.pathname)
      ) {
        route = url.pathname;
        requestUrl = url.href;
      }
    } catch {
      // Let native fetch handle invalid inputs.
    }

    if (!route) return original.apply(this, args);

    const id = `${documentId}:${++sequence}`;
    const start = performance.now();

    let operationRequest = null;
    let transportStage = null;
    if (
      route.endsWith("/transport/operation/begin") ||
      route.endsWith("/transport/operation/end")
    ) {
      try {
        const rawBody = args[1]?.body;
        const payload =
          typeof rawBody === "string"
            ? JSON.parse(rawBody)
            : null;
        operationRequest = route.endsWith("/transport/operation/begin")
          ? {
              kind: typeof payload?.kind === "string" ? payload.kind : null,
            }
          : {
              operation_id:
                typeof payload?.operationId === "string"
                  ? payload.operationId
                  : null,
            };
      } catch {
        // Observation must not affect the real request.
      }
    }

    if (route?.endsWith("/transport/session/start")) {
      try {
        const rawBody = args[1]?.body;
        const payload = typeof rawBody === "string" ? JSON.parse(rawBody) : null;
        transportStage = payload?.tempAuthMetadata && typeof payload.tempAuthMetadata === "object"
          ? "bind"
          : "reserve";
      } catch {
        // Observation must not affect the real request.
      }
    }

    requests.set(id, {
      id,
      url: requestUrl,
      start,
    });

    const started_at_ms = Date.now();
    const monotonic_started_ms = Math.round(performance.now() * 10) / 10;
    const traceContext = stage1TraceContext();
    if (traceContext) {
      const headers = new Headers(args[1]?.headers || args[0]?.headers);
      headers.set("X-Stage1-Critical-Path", traceContext.correlation_id);
      args[1] = { ...(args[1] || {}), headers };
    }
    let abort_at_ms = null;

    if (route.endsWith("/auth/health")) {
      const headers = new Headers(args[1]?.headers || args[0]?.headers);
      headers.set("x-stage1-trace", id);
      args[1] = { ...args[1], headers };
    }

    const signal = args[1]?.signal || args[0]?.signal;
    const onAbort = () => {
      abort_at_ms = Date.now();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    const send = value =>
      publish({
        ...value,
        started_at_ms,
        monotonic_started_ms,
        monotonic_observed_ms: Math.round(performance.now() * 10) / 10,
        time_origin_ms: performance.timeOrigin,
        abort_at_ms,
        observed_at_ms: Date.now(),
        document_id: documentId,
        ...(traceContext || {}),
        ...(operationRequest ? { operation_request: operationRequest } : {}),
        ...(transportStage ? { transport_stage: transportStage } : {}),
      });

    send({
      id,
      route,
      status: null,
      state: "pending",
      duration_ms: 0,
    });

    try {
      const response = await original.apply(this, args);

      let transport = null;
      let operationResponse = null;
      let startupTrace = null;

      if (route.endsWith("/transport/session/start")) {
        try {
          const rawTrace = response.headers.get("X-BeatGaler-Startup-Trace");
          if (rawTrace && rawTrace.length <= 12_000) {
            const parsed = JSON.parse(rawTrace);
            startupTrace = {
              request_id:
                typeof parsed?.request_id === "string"
                  ? parsed.request_id
                  : null,
              outcome:
                parsed?.outcome === "done" || parsed?.outcome === "error"
                  ? parsed.outcome
                  : null,
              elapsed_ms:
                Number.isFinite(Number(parsed?.elapsed_ms))
                  ? Number(parsed.elapsed_ms)
                  : null,
              dropped_events:
                Number.isFinite(Number(parsed?.dropped_events))
                  ? Number(parsed.dropped_events)
                  : null,
              events: Array.isArray(parsed?.events)
                ? parsed.events.slice(0, 32).map(event => ({
                    stage:
                      typeof event?.stage === "string"
                        ? event.stage
                        : null,
                    t_ms:
                      Number.isFinite(Number(event?.t_ms))
                        ? Number(event.t_ms)
                        : null,
                    elapsed_ms:
                      Number.isFinite(Number(event?.elapsed_ms))
                        ? Number(event.elapsed_ms)
                        : null,
                    server_lease:
                      typeof event?.server_lease === "string"
                        ? event.server_lease
                        : null,
                    lease_state:
                      typeof event?.lease_state === "string"
                        ? event.lease_state
                        : null,
                  }))
                : [],
            };
          }
        } catch {
          // Observation must not affect the real response.
        }
      }

      if (
        route.endsWith("/transport/operation/begin") ||
        route.endsWith("/transport/operation/end")
      ) {
        try {
          const payload = await response.clone().json();
          operationResponse = route.endsWith("/transport/operation/begin")
            ? {
                operation_id:
                  typeof payload?.operation_id === "string"
                    ? payload.operation_id
                    : null,
                wait: payload?.wait === true,
                reason:
                  typeof payload?.reason === "string"
                    ? payload.reason
                    : null,
                retry_after_ms:
                  Number.isFinite(Number(payload?.retry_after_ms))
                    ? Number(payload.retry_after_ms)
                    : null,
              }
            : {
                ok: payload?.ok === true,
              };
        } catch {
          // Observation must not affect the real response.
        }
      }

      if (route.endsWith("/transport/session/start") && response.ok) {
        try {
          const payload = await response.clone().json();

          transport = {
            mode: payload.mode || null,
            session_id: payload.session_id || null,
            transport_id: payload.transport_id || null,
            transport_user_id: payload.transport_user_id || null,
            chat_id: payload.chat_id || null,
            generation: payload.generation ?? null,
            credential_version: payload.credential_version ?? null,
            expected_bot_id: payload.temp_auth?.expected_bot_id || null,
          };
        } catch {
          // Observation must not affect the real response.
        }
      }

      send({
        id,
        route,
        status: response.status,
        state: "response",
        duration_ms: Math.round(performance.now() - start),
        ...(transport ? { transport } : {}),
        ...(startupTrace ? { startup_trace: startupTrace } : {}),
        ...(operationResponse ? { operation_response: operationResponse } : {}),
      });

      return response;
    } catch (error) {
      send({
        id,
        route,
        status: null,
        state: error?.name === "AbortError" ? "aborted" : "network-error",
        duration_ms: Math.round(performance.now() - start),
      });

      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

export async function observeAuth(client) {
  let phase = "initial-navigation";
  const records = new Map();
  const documentMilestones = [];
  const navigationTimings = [];
  const playTraces = [];

  // No late execute() fallback: without BiDi, fail before navigating unobserved.
  const script = await client.addInitScript(authPreload);

  script.on("data", data => {
    if (data.kind === "document-milestone") {
      documentMilestones.push({
        event: data.event,
        document_id: data.document_id,
        timestamp_wall_clock: data.timestamp_wall_clock,
        monotonic_ms: data.monotonic_ms,
        ...(data.correlation_id ? { correlation_id: data.correlation_id } : {}),
        ...(data.account_label ? { account_label: data.account_label } : {}),
      });
      if (documentMilestones.length > 80) documentMilestones.shift();
      return;
    }
    if (data.kind === "navigation-timing") {
      navigationTimings.push({ ...data });
      if (navigationTimings.length > 20) navigationTimings.shift();
      return;
    }
    if (data.kind === "play-trace") {
      playTraces.push({ ...data });
      if (playTraces.length > 400) playTraces.shift();
      return;
    }
    const previous = records.get(data.id);

    if (data.resource_timing) {
      if (previous) previous.entry.resource_timing = data.resource_timing;
      return;
    }

    records.set(data.id, {
      startedAt: previous?.startedAt ?? Date.now(),
      entry: {
        route: data.route,
        status: data.status,
        state: data.state,
        duration_ms: data.duration_ms,
        harness_phase: previous?.entry.harness_phase ?? phase,
        trace_id: data.id,
        started_at_ms: data.started_at_ms,
        observed_at_ms: data.observed_at_ms,
        abort_at_ms: data.abort_at_ms,
        ...(previous?.entry.resource_timing
          ? { resource_timing: previous.entry.resource_timing }
          : {}),
        ...(data.transport ? { transport: data.transport } : {}),
        ...(data.startup_trace ? { startup_trace: data.startup_trace } : {}),
        ...(data.document_id ? { document_id: data.document_id } : {}),
        ...(data.correlation_id ? { correlation_id: data.correlation_id } : {}),
        ...(data.account_label ? { account_label: data.account_label } : {}),
        ...(Number.isFinite(Number(data.monotonic_started_ms)) ? { monotonic_started_ms: data.monotonic_started_ms } : {}),
        ...(Number.isFinite(Number(data.monotonic_observed_ms)) ? { monotonic_observed_ms: data.monotonic_observed_ms } : {}),
        ...(Number.isFinite(Number(data.time_origin_ms)) ? { time_origin_ms: data.time_origin_ms } : {}),
        ...(data.operation_request ? { operation_request: data.operation_request } : {}),
        ...(data.operation_response ? { operation_response: data.operation_response } : {}),
        ...(data.transport_stage ? { transport_stage: data.transport_stage } : {}),
      },
    });
  });

  return {
    setPhase(value) {
      phase = value;
    },

    snapshot() {
      return [...records.values()].map(({ startedAt, entry }) => ({
        ...entry,
        duration_ms:
          entry.state === "pending"
            ? Date.now() - startedAt
            : entry.duration_ms,
      }));
    },

    documentSnapshot() {
      return documentMilestones.map(entry => ({ ...entry }));
    },

    navigationSnapshot() {
      return navigationTimings.map(entry => ({ ...entry }));
    },

    playTraceSnapshot() {
      return playTraces.map(entry => ({ ...entry }));
    },

    async diagnosticSnapshot() {
      try {
        return await client.execute(() =>
          Array.isArray(window.__stage1DiagnosticLogs)
            ? window.__stage1DiagnosticLogs.slice(-100)
            : [],
        );
      } catch {
        return [];
      }
    },

    async remove() {
      try {
        await client.execute(() => {
          window.__stage1RestoreFetch?.();
          delete window.__stage1RestoreFetch;
        });
      } finally {
        await script.remove();
      }
    },
  };
}
