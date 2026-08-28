import fs from 'node:fs';

const file = 'src-tauri/src/commands.rs';
const source = fs.readFileSync(file, 'utf8');
const marker = 'let result: Result<Value, String> = (|| {';
if (source.includes(marker)) {
  console.log('Rust post-authorize cleanup patch already applied.');
  process.exit(0);
}
const from = `    let result = {\n        let slot = direct_runtime_slot();\n        let mut guard = slot.lock().map_err(|e| e.to_string())?;\n        let runtime = guard.as_mut().ok_or_else(|| "Galer Storage local runtime is unavailable.".to_string())?;\n        if runtime.session_id != session_id || runtime.generation != generation {\n            None\n        } else {\n            Some(direct_send_helper_command(runtime, command))\n        }\n    };\n    let result = match result {\n        Some(result) => result,\n        None => {\n            direct_end_operation(user_id, &session_id, generation, &operation_id);\n            return Err("Galer Storage session changed before the authorized operation could execute.".to_string());\n        }\n    };\n    direct_end_operation(user_id, &session_id, generation, &operation_id);\n    result\n`;
const to = `    let result: Result<Value, String> = (|| {\n        let slot = direct_runtime_slot();\n        let mut guard = slot.lock().map_err(|e| e.to_string())?;\n        let runtime = guard.as_mut().ok_or_else(|| "Galer Storage local runtime is unavailable.".to_string())?;\n        if runtime.session_id != session_id || runtime.generation != generation {\n            return Err("Galer Storage session changed before the authorized operation could execute.".to_string());\n        }\n        direct_send_helper_command(runtime, command)\n    })();\n    // Once a capability reaches AUTHORIZED, every local outcome must close the\n    // server-side operation. This includes poisoned locks, vanished runtimes and\n    // helper failures; operation/end is idempotent for retry safety.\n    direct_end_operation(user_id, &session_id, generation, &operation_id);\n    result\n`;
const first = source.indexOf(from);
const second = first < 0 ? -1 : source.indexOf(from, first + from.length);
if (first < 0) throw new Error('Expected Desktop post-authorize block not found.');
if (second >= 0) throw new Error('Desktop post-authorize block is not unique.');
fs.writeFileSync(file, source.slice(0, first) + to + source.slice(first + from.length), 'utf8');
console.log('Applied Rust post-authorize cleanup patch.');
