const chains = [
  ["inicio_reload", "auth_session", "cloud_control_begin", "session_start_bootstrap_done"],
  ["session_start_bootstrap_done", "session_start_bind_done", "cloud_control_end"],
  ["session_start_bootstrap_done", "session_activate_http_done", "cloud_control_end"],
  ["cloud_control_end", "mtproto_connect_begin", "cliente_mtproto_listo", "direct_disponible"],
  ["direct_disponible", "get_chat_begin", "get_chat_rpc_enviada", "get_chat_respuesta_recibida", "get_chat_procesamiento_local_terminado", "get_chat_end"],
  ["direct_disponible", "get_index_begin", "pointer_lookup_begin", "get_messages_begin", "get_messages_rpc_enviada", "get_messages_rpc_respuesta_recibida", "get_messages_end", "pointer_lookup_end"],
  ["get_index_begin", "get_full_chat_begin", "get_full_chat_rpc_enviada", "get_full_chat_respuesta_recibida", "get_full_chat_procesamiento_local_terminado", "get_full_chat_end"],
  ["get_index_begin", "get_index_end", "procesamiento_index_web_begin", "procesamiento_index_web_end", "biblioteca_autoritativa_utilizable"],
];

// In Task 2 the Worker connects in parallel with Cloud bind/activate, and a
// reload may start Cloud renewal before auth/session finishes. The media gate
// still precedes the data-plane-ready event and INDEX dispatch.
const task2Chains = [
  ["inicio_reload", "auth_session"],
  ["inicio_reload", "cloud_control_begin", "session_start_bootstrap_done", "cloud_control_end", "direct_disponible"],
  ["inicio_reload", "mtproto_connect_begin", "cliente_mtproto_listo", "direct_disponible"],
  ["direct_disponible", "get_chat_begin", "get_chat_rpc_enviada", "get_chat_respuesta_recibida", "get_chat_procesamiento_local_terminado", "get_chat_end"],
  ["direct_disponible", "get_index_begin", "pointer_lookup_begin", "get_messages_begin", "get_messages_rpc_enviada", "get_messages_rpc_respuesta_recibida", "get_messages_end", "pointer_lookup_end"],
  ["get_index_begin", "get_index_end", "procesamiento_index_web_begin", "procesamiento_index_web_end", "biblioteca_autoritativa_utilizable"],
];

function parentsFor(selectedChains) {
  const parents = new Map();
  for (const chain of selectedChains) {
    for (let index = 1; index < chain.length; index += 1) {
      const parent = parents.get(chain[index]) || [];
      parent.push(chain[index - 1]);
      parents.set(chain[index], parent);
    }
  }
  return parents;
}

export function assessPhase2Task1Markers(points, { task2 = false, earlyGatedEvents = [] } = {}) {
  const selectedChains = task2 ? task2Chains : chains;
  const parents = parentsFor(selectedChains);
  const byEvent = new Map(points.map(point => [point.event, point.absolute_ms]));
  const required = points.filter(point => !task2 || !point.event.startsWith("get_full_chat_"));
  const absent = new Set(required.filter(point => point.absolute_ms === null).map(point => point.event));
  const primary = [];
  const blocked = [];
  const missingAncestor = (event, visited = new Set()) => {
    if (visited.has(event)) return null;
    visited.add(event);
    for (const parent of parents.get(event) || []) {
      if (absent.has(parent)) return parent;
      const ancestor = missingAncestor(parent, visited);
      if (ancestor) return ancestor;
    }
    return null;
  };
  for (const event of absent) {
    const blockedBy = missingAncestor(event);
    if (blockedBy) blocked.push({ event, blocked_by: blockedBy });
    else primary.push(event);
  }

  // Activate and bind may finish in either order. Both must follow bootstrap
  // and precede the controller's gate.
  const parallel = new Set(["session_start_bind_done", "session_activate_http_done"]);
  const outOfOrder = [];
  if (task2) {
    for (const chain of selectedChains) {
      let previous = null;
      for (const event of chain) {
        const time = byEvent.get(event);
        if (time === null || time === undefined) continue;
        if (previous && time < previous.time) {
          outOfOrder.push({ before: previous.event, after: event });
        }
        previous = { event, time };
      }
    }
  } else {
    const chronologicalPoints = points.filter(point => !parallel.has(point.event));
    let previous = null;
    for (const point of chronologicalPoints) {
      if (point.absolute_ms === null) continue;
      if (previous && point.absolute_ms < previous.absolute_ms) {
        outOfOrder.push({ before: previous.event, after: point.event });
      }
      previous = point;
    }
  }
  for (const event of parallel) {
    const time = byEvent.get(event);
    const bootstrap = byEvent.get("session_start_bootstrap_done");
    const gate = byEvent.get("cloud_control_end");
    if (time === null || time === undefined) continue;
    if (bootstrap !== null && bootstrap !== undefined && time < bootstrap) {
      outOfOrder.push({ before: "session_start_bootstrap_done", after: event });
    }
    if (gate !== null && gate !== undefined && gate < time) {
      outOfOrder.push({ before: event, after: "cloud_control_end" });
    }
  }
  outOfOrder.push(...earlyGatedEvents.map(event => ({ before: "cloud_control_end", after: event })));
  return { missing_markers: primary, blocked_markers: blocked, chronological: outOfOrder.length === 0, out_of_order: outOfOrder, complete: absent.size === 0 && outOfOrder.length === 0 };
}

export function persistPhase2Task1Samples(report, cold, reload) {
  report.phase2_task1.samples.apertura_fria = cold;
  report.phase2_task1.samples.reload_caliente = reload;
  const incomplete = [...cold, ...reload].filter(sample => !sample.complete);
  if (incomplete.length) {
    const error = new Error(`Task 1 attribution lacks ordered markers: ${incomplete.map(sample => `${sample.condition}/${sample.account_label}=${sample.missing_markers.join(",") || (sample.blocked_markers.length ? `blocked:${sample.blocked_markers.map(item => item.event).join(",")}` : "out-of-order")}`).join("; ")}`);
    error.code = "PHASE2_TASK1_INCOMPLETE_ATTRIBUTION";
    error.severity = "P1";
    throw error;
  }
}
