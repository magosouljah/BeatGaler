import fs from 'node:fs';

function replaceOnce(file, from, to, label) {
  const source = fs.readFileSync(file, 'utf8');
  const first = source.indexOf(from);
  const second = first < 0 ? -1 : source.indexOf(from, first + from.length);
  if (first < 0) throw new Error(`${label}: expected source block not found in ${file}`);
  if (second >= 0) throw new Error(`${label}: source block is not unique in ${file}`);
  fs.writeFileSync(file, source.slice(0, first) + to + source.slice(first + from.length), 'utf8');
}

const directFile = 'cloud-server/direct-transport-control.js';
replaceOnce(
  directFile,
  "const DATA_OPERATION_TTL_MS = Math.max(15 * 60_000, Number(process.env.DIRECT_DATA_OPERATION_TTL_MS || 4 * 60 * 60_000));\n",
  "const DATA_OPERATION_TTL_MS = Math.max(15 * 60_000, Number(process.env.DIRECT_DATA_OPERATION_TTL_MS || 4 * 60 * 60_000));\nconst MAX_ACTIVE_VAULTS_PER_BOT = Math.max(1, Math.min(4, Number(process.env.DIRECT_MAX_ACTIVE_VAULTS_PER_BOT || 4)));\n",
  'Direct bot ceiling constant',
);
replaceOnce(
  directFile,
  `    const eligible = pool.filter(bot => !state.bots[bot.id].quarantined && !state.bots[bot.id].rotation_pending);\n    if (!eligible.length) {\n      const error = new Error('Every transport bot is temporarily unavailable while token rotation drains or recovery is required.');\n      error.code = 'NO_ASSIGNABLE_TRANSPORT';\n      throw error;\n    }\n    const loads = new Map(eligible.map(bot => [bot.id, leasesForBot(state, bot.id).length]));\n`,
  `    const assignable = pool.filter(bot => !state.bots[bot.id].quarantined && !state.bots[bot.id].rotation_pending);\n    const eligible = assignable.filter(bot => leasesForBot(state, bot.id).length < MAX_ACTIVE_VAULTS_PER_BOT);\n    if (!eligible.length) {\n      const atCapacity = assignable.length > 0;\n      const error = new Error(atCapacity\n        ? \`Every transport bot is at the \${MAX_ACTIVE_VAULTS_PER_BOT}-vault active ceiling.\`\n        : 'Every transport bot is temporarily unavailable while token rotation drains or recovery is required.');\n      error.code = atCapacity ? 'TRANSPORT_CAPACITY_REACHED' : 'NO_ASSIGNABLE_TRANSPORT';\n      throw error;\n    }\n    const loads = new Map(eligible.map(bot => [bot.id, leasesForBot(state, bot.id).length]));\n`,
  'Direct bot ceiling admission',
);

const rustFile = 'src-tauri/src/commands.rs';
replaceOnce(
  rustFile,
  'fn direct_begin_operation(user_id: &str, kind: &str) -> Result<String, String> {',
  'fn direct_begin_operation(user_id: &str, kind: &str, scope: &Value) -> Result<String, String> {',
  'Desktop begin capability signature',
);
replaceOnce(
  rustFile,
  '            "credentialVersion": credential_version,\n            "kind": kind,\n',
  '            "credentialVersion": credential_version,\n            "kind": kind,\n            "scope": scope,\n',
  'Desktop begin capability body',
);
replaceOnce(
  rustFile,
  `fn direct_request(user_id: &str, command: Value) -> Result<Value, String> {\n    let kind = command.get(\"op\").and_then(|v| v.as_str()).unwrap_or(\"data\").to_string();\n    let operation_id = direct_begin_operation(user_id, &kind)?;\n`,
  `fn direct_capability_scope(command: &Value) -> Result<Value, String> {\n    let op = command.get(\"op\").and_then(|v| v.as_str()).unwrap_or(\"\");\n    if op == \"get_index\" || op == \"replace_index\" {\n        return Ok(json!({ \"objectType\": \"index\", \"objectIds\": [\"pinned\"] }));\n    }\n    if let Some(message_id) = command.get(\"message_id\").and_then(|v| v.as_i64()) {\n        if message_id > 0 {\n            return Ok(json!({ \"objectType\": \"message\", \"objectIds\": [message_id.to_string()] }));\n        }\n    }\n    if let Some(message_ids) = command.get(\"message_ids\").and_then(|v| v.as_array()) {\n        let ids: Vec<String> = message_ids.iter().filter_map(|value| value.as_i64()).filter(|value| *value > 0).map(|value| value.to_string()).collect();\n        if !ids.is_empty() && ids.len() == message_ids.len() {\n            return Ok(json!({ \"objectType\": \"message\", \"objectIds\": ids }));\n        }\n    }\n    if op == \"upload\" {\n        if let Some(topic_id) = command.get(\"reply_to\").and_then(|v| v.as_i64()) {\n            if topic_id > 0 {\n                return Ok(json!({ \"objectType\": \"topic\", \"objectIds\": [topic_id.to_string()] }));\n            }\n        }\n    }\n    Err(format!(\"Galer Storage operation {} has no explicit capability object scope.\", op))\n}\n\nfn direct_request(user_id: &str, command: Value) -> Result<Value, String> {\n    let kind = command.get(\"op\").and_then(|v| v.as_str()).unwrap_or(\"data\").to_string();\n    let scope = direct_capability_scope(&command)?;\n    let operation_id = direct_begin_operation(user_id, &kind, &scope)?;\n`,
  'Desktop capability scope',
);

console.log('Applied Task 7.1 Direct capability patches.');
