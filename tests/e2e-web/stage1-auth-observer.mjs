// Serialized by WebdriverIO and installed before any application script.
export function authPreload(emit) {
  const original = window.fetch;
  const documentId = crypto.randomUUID();
  let sequence = 0;

  const publish = value => {
    try {
      emit(value);
    } catch {
      // Observation must not affect auth.
    }
  };

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
          "/beatgaler-api/transport/session/start",
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

    requests.set(id, {
      id,
      url: requestUrl,
      start,
    });

    const started_at_ms = Date.now();
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
        abort_at_ms,
        observed_at_ms: Date.now(),
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

  // No late execute() fallback: without BiDi, fail before navigating unobserved.
  const script = await client.addInitScript(authPreload);

  script.on("data", data => {
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