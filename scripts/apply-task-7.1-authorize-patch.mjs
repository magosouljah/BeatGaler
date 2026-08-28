import fs from 'node:fs';

function replaceIfMissing(file, marker, from, to, label) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(marker)) {
    console.log(`SKIP ${label}: already applied`);
    return false;
  }
  const first = source.indexOf(from);
  const second = first < 0 ? -1 : source.indexOf(from, first + from.length);
  if (first < 0) throw new Error(`${label}: expected source block not found in ${file}`);
  if (second >= 0) throw new Error(`${label}: source block is not unique in ${file}`);
  fs.writeFileSync(file, source.slice(0, first) + to + source.slice(first + from.length), 'utf8');
  console.log(`APPLY ${label}`);
  return true;
}

replaceIfMissing(
  'cloud-server/http-containment.js',
  '"/transport/capability/authorize"',
  '  "/transport/session/stop", "/transport/operation/begin", "/transport/operation/end",\n',
  '  "/transport/session/stop", "/transport/operation/begin", "/transport/capability/authorize", "/transport/operation/end",\n',
  'D6 containment for capability authorize',
);

replaceIfMissing(
  'cloud-server/direct-capability-boundary.js',
  '__beatgalerDirectCapabilityAuthorizeRouteInstalled',
  `  express.application.post = function patchedDirectCapabilityPost(routePath, ...handlers) {\n    if (routePath === "/transport/operation/begin") return originalPost.call(this, routePath, beginCapability, ...handlers);\n`,
  `  async function authorizeCapability(req, res) {\n    try {\n      return res.json(await authorizePresentedCapability(req));\n    } catch (error) {\n      return responseError(res, error);\n    }\n  }\n\n  express.application.post = function patchedDirectCapabilityPost(routePath, ...handlers) {\n    if (routePath === "/transport/operation/begin") {\n      if (!this.__beatgalerDirectCapabilityAuthorizeRouteInstalled) {\n        this.__beatgalerDirectCapabilityAuthorizeRouteInstalled = true;\n        originalPost.call(this, "/transport/capability/authorize", authorizeCapability);\n      }\n      return originalPost.call(this, routePath, beginCapability, ...handlers);\n    }\n`,
  'capability authorize endpoint',
);

replaceIfMissing(
  'cloud-server/direct-capability-boundary.js',
  'replay: true, record: { ...record }',
  `      if (record.status !== "AUTHORIZED") return { ok: false, reason: record.status.toLowerCase(), record: { ...record } };\n`,
  `      if (record.status === "CONSUMED") return { ok: true, authorized: true, replay: true, record: { ...record } };\n      if (record.status !== "AUTHORIZED") return { ok: false, reason: record.status.toLowerCase(), record: { ...record } };\n`,
  'idempotent memory cleanup after consume',
);

replaceIfMissing(
  'cloud-server/direct-capability-boundary.js',
  'replay: true, record };',
  `      const sameIdentity = String(record.user_id) === input.userId && String(record.tenant_id) === input.tenantId &&\n        String(record.installation_id) === input.installationId && String(record.auth_session_hash) === input.authSessionHash &&\n        String(record.session_id) === input.sessionId && Number(record.generation) === Number(input.generation);\n      return { ok: false, reason: sameIdentity ? String(record.status || "denied").toLowerCase() : "scope", record };\n`,
  `      const sameIdentity = String(record.user_id) === input.userId && String(record.tenant_id) === input.tenantId &&\n        String(record.installation_id) === input.installationId && String(record.auth_session_hash) === input.authSessionHash &&\n        String(record.session_id) === input.sessionId && Number(record.generation) === Number(input.generation);\n      if (sameIdentity && String(record.status) === "CONSUMED") return { ok: true, authorized: true, replay: true, record };\n      return { ok: false, reason: sameIdentity ? String(record.status || "denied").toLowerCase() : "scope", record };\n`,
  'idempotent PostgreSQL cleanup after consume',
);

replaceIfMissing(
  'src/features/cloud/webTransportSession.ts',
  'export async function authorizeWebTransportOperation',
  `export async function endWebTransportOperation(\n`,
  `export async function authorizeWebTransportOperation(\n  session: Pick<WebTransportSession, "session_id" | "generation">,\n  operationId: string,\n  kind: string,\n  scope: WebTransportCapabilityScope,\n): Promise<void> {\n  const response = await transportRequest<{ authorized?: boolean; operation_id?: string }>("/transport/capability/authorize", {\n    sessionId: session.session_id,\n    generation: session.generation,\n    operationId,\n    kind,\n    scope,\n  });\n  assertNoPermanentCredentials(response);\n  if (response.authorized !== true || response.operation_id !== operationId) {\n    throw new Error("Galer Cloud refused the scoped Direct capability.");\n  }\n}\n\nexport async function endWebTransportOperation(\n`,
  'Web capability authorize request',
);

replaceIfMissing(
  'src/features/cloud/webTransportController.ts',
  'authorizeWebTransportOperation,',
  `  activateWebTransportSession,\n  beginWebTransportOperation,\n`,
  `  activateWebTransportSession,\n  authorizeWebTransportOperation,\n  beginWebTransportOperation,\n`,
  'Web controller authorize import',
);
replaceIfMissing(
  'src/features/cloud/webTransportController.ts',
  'authorize(session: WebTransportSession, operationId: string, kind: string, scope: WebTransportCapabilityScope)',
  `  begin(session: WebTransportSession, kind: string, scope: WebTransportCapabilityScope): Promise<{\n`,
  `  authorize(session: WebTransportSession, operationId: string, kind: string, scope: WebTransportCapabilityScope): Promise<void>;\n  begin(session: WebTransportSession, kind: string, scope: WebTransportCapabilityScope): Promise<{\n`,
  'Web controller authorize API contract',
);
replaceIfMissing(
  'src/features/cloud/webTransportController.ts',
  'authorize: authorizeWebTransportOperation,',
  `  activate: activateWebTransportSession,\n  heartbeat: heartbeatWebTransportSession,\n`,
  `  activate: activateWebTransportSession,\n  authorize: authorizeWebTransportOperation,\n  heartbeat: heartbeatWebTransportSession,\n`,
  'Web controller authorize default API',
);
replaceIfMissing(
  'src/features/cloud/webTransportController.ts',
  'await this.api.authorize(session, response.operationId, kind, scope);',
  `      if (response.operationId) {\n        return {\n`,
  `      if (response.operationId) {\n        try {\n          await this.api.authorize(session, response.operationId, kind, scope);\n        } catch (error) {\n          await this.api.end({ session_id: session.session_id, generation: session.generation }, response.operationId).catch(() => {});\n          throw error;\n        }\n        return {\n`,
  'Web authorize before data-plane operation',
);

replaceIfMissing(
  'src-tauri/src/commands.rs',
  'Result<(String, String, i64), String>',
  'fn direct_begin_operation(user_id: &str, kind: &str, scope: &Value) -> Result<String, String> {',
  'fn direct_begin_operation(user_id: &str, kind: &str, scope: &Value) -> Result<(String, String, i64), String> {',
  'Desktop begin returns exact capability session identity',
);
replaceIfMissing(
  'src-tauri/src/commands.rs',
  'DirectBeginDisposition::Ready(operation_id) => return Ok((operation_id, session_id, generation)),',
  '            DirectBeginDisposition::Ready(operation_id) => return Ok(operation_id),\n',
  '            DirectBeginDisposition::Ready(operation_id) => return Ok((operation_id, session_id, generation)),\n',
  'Desktop retain begin session identity',
);
replaceIfMissing(
  'src-tauri/src/commands.rs',
  'fn direct_authorize_operation(',
  `fn direct_end_operation(user_id: &str, session_id: &str, generation: i64, operation_id: &str) {\n`,
  `fn direct_authorize_operation(\n    user_id: &str,\n    session_id: &str,\n    generation: i64,\n    operation_id: &str,\n    kind: &str,\n    scope: &Value,\n) -> Result<(), String> {\n    let url = format!("{}/transport/capability/authorize", telegram_cloud_api_base());\n    let response = post_json_cloud_auth_timeout(&url, &json!({\n        "beatgalerUserId": user_id,\n        "sessionId": session_id,\n        "generation": generation,\n        "operationId": operation_id,\n        "kind": kind,\n        "scope": scope,\n    }), 10)?;\n    if response.get("authorized").and_then(|v| v.as_bool()) != Some(true)\n        || response.get("operation_id").and_then(|v| v.as_str()) != Some(operation_id)\n    {\n        return Err("Galer Cloud refused the scoped Direct capability.".to_string());\n    }\n    Ok(())\n}\n\nfn direct_end_operation(user_id: &str, session_id: &str, generation: i64, operation_id: &str) {\n`,
  'Desktop capability authorize helper',
);
replaceIfMissing(
  'src-tauri/src/commands.rs',
  'direct_authorize_operation(user_id, &session_id, generation, &operation_id, &kind, &scope)',
  `fn direct_request(user_id: &str, command: Value) -> Result<Value, String> {\n    let kind = command.get("op").and_then(|v| v.as_str()).unwrap_or("data").to_string();\n    let scope = direct_capability_scope(&command)?;\n    let operation_id = direct_begin_operation(user_id, &kind, &scope)?;\n    let (session_id, generation, result) = {\n        let slot = direct_runtime_slot();\n        let mut guard = slot.lock().map_err(|e| e.to_string())?;\n        let runtime = guard.as_mut().ok_or_else(|| "Galer Storage local runtime is unavailable.".to_string())?;\n        let session_id = runtime.session_id.clone();\n        let generation = runtime.generation;\n        let result = direct_send_helper_command(runtime, command);\n        (session_id, generation, result)\n    };\n    direct_end_operation(user_id, &session_id, generation, &operation_id);\n    result\n}\n`,
  `fn direct_request(user_id: &str, command: Value) -> Result<Value, String> {\n    let kind = command.get("op").and_then(|v| v.as_str()).unwrap_or("data").to_string();\n    let scope = direct_capability_scope(&command)?;\n    let (operation_id, session_id, generation) = direct_begin_operation(user_id, &kind, &scope)?;\n    if let Err(error) = direct_authorize_operation(user_id, &session_id, generation, &operation_id, &kind, &scope) {\n        direct_end_operation(user_id, &session_id, generation, &operation_id);\n        return Err(error);\n    }\n    let result = {\n        let slot = direct_runtime_slot();\n        let mut guard = slot.lock().map_err(|e| e.to_string())?;\n        let runtime = guard.as_mut().ok_or_else(|| "Galer Storage local runtime is unavailable.".to_string())?;\n        if runtime.session_id != session_id || runtime.generation != generation {\n            None\n        } else {\n            Some(direct_send_helper_command(runtime, command))\n        }\n    };\n    let result = match result {\n        Some(result) => result,\n        None => {\n            direct_end_operation(user_id, &session_id, generation, &operation_id);\n            return Err("Galer Storage session changed before the authorized operation could execute.".to_string());\n        }\n    };\n    direct_end_operation(user_id, &session_id, generation, &operation_id);\n    result\n}\n`,
  'Desktop authorize before helper execution',
);

replaceIfMissing(
  'cloud-server/tests/direct-capability-boundary.test.cjs',
  'assert.equal(endReplay.replay, true);',
  `  const endReplay = await store.finish(request());\n  assert.equal(endReplay.ok, false);\n  assert.equal(endReplay.reason, "consumed");\n`,
  `  const endReplay = await store.finish(request());\n  assert.equal(endReplay.ok, true);\n  assert.equal(endReplay.authorized, true);\n  assert.equal(endReplay.replay, true);\n  assert.equal(endReplay.record.status, "CONSUMED");\n`,
  'idempotent operation-end retry regression',
);

console.log('Applied Task 7.1 authorize-before-data-plane patches.');
