use std::{env, fs, path::PathBuf, process::Command};

fn replace_once(source: &mut String, old: &str, new: &str, label: &str) {
    if !source.contains(old) {
        panic!("Task 5.1 Desktop temp-auth seam drifted at {label}");
    }
    *source = source.replacen(old, new, 1);
}

fn main() {
    println!("cargo:rerun-if-env-changed=BEATGALER_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-changed=src/commands.rs");
    println!("cargo:rerun-if-changed=direct-transport/transport-helper.source.mjs");
    println!("cargo:rerun-if-changed=../scripts/build-direct-temp-helper.mjs");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().expect("src-tauri parent");

    let helper_status = Command::new("node")
        .arg(repo_root.join("scripts/build-direct-temp-helper.mjs"))
        .current_dir(repo_root)
        .status()
        .expect("Task 5.1 requires Node to build the self-contained Desktop Direct helper");
    if !helper_status.success() {
        panic!("Task 5.1 Desktop temporary-auth helper bundle failed");
    }

    let commands_path = manifest_dir.join("src/commands.rs");
    let mut commands = fs::read_to_string(&commands_path).expect("read commands.rs");

    replace_once(
        &mut commands,
        "struct DirectTransportRuntime {\n    child: Child,\n    stdin: ChildStdin,\n    stdout: BufReader<ChildStdout>,\n    user_id: String,\n    session_id: String,\n    transport_id: String,\n    generation: i64,\n    credential_version: i64,\n}",
        "struct DirectTransportRuntime {\n    child: Child,\n    stdin: ChildStdin,\n    stdout: BufReader<ChildStdout>,\n    user_id: String,\n    session_id: String,\n    transport_id: String,\n    generation: i64,\n    credential_version: i64,\n    temp_mode: bool,\n}",
        "runtime temp-mode field",
    );

    replace_once(
        &mut commands,
        "        let value: Value = serde_json::from_str(raw)\n            .map_err(|e| format!(\"Direct transport helper returned invalid JSON: {}\", e))?;\n        if let Some(expected) = expected_request_id {",
        "        let value: Value = serde_json::from_str(raw)\n            .map_err(|e| format!(\"Direct transport helper returned invalid JSON: {}\", e))?;\n        if value.get(\"op\").and_then(|v| v.as_str()) == Some(\"temp_auth_metadata\") {\n            let metadata = value.get(\"temp_auth_metadata\").cloned()\n                .ok_or_else(|| \"Desktop temporary-auth helper returned no binding metadata.\".to_string())?;\n            let url = format!(\"{}/transport/session/start\", telegram_cloud_api_base());\n            let body = json!({\n                \"beatgalerUserId\": runtime.user_id.as_str(),\n                \"tempAuthMetadata\": metadata,\n            });\n            let bound = post_json_cloud_auth_timeout(&url, &body, 45)\n                .map_err(|e| format!(\"Galer Cloud temporary-auth bind unavailable: {}\", e))?;\n            if bound.get(\"mode\").and_then(|v| v.as_str()) != Some(\"galer-direct-temp-mtproto\")\n                || bound.get(\"session_id\").and_then(|v| v.as_str()) != Some(runtime.session_id.as_str())\n                || bound.get(\"generation\").and_then(|v| v.as_i64()) != Some(runtime.generation)\n            {\n                return Err(\"Galer Cloud returned a mismatched Desktop temporary-auth lease.\".to_string());\n            }\n            if let Some(version) = bound.get(\"credential_version\").and_then(|v| v.as_i64()) {\n                runtime.credential_version = version;\n            }\n            let reply = json!({ \"op\": \"temp_auth_binding\", \"session\": bound });\n            writeln!(runtime.stdin, \"{}\", reply)\n                .map_err(|e| format!(\"Direct temporary-auth binding write failed: {}\", e))?;\n            runtime.stdin.flush()\n                .map_err(|e| format!(\"Direct temporary-auth binding flush failed: {}\", e))?;\n            continue;\n        }\n        if let Some(expected) = expected_request_id {",
        "helper temp-auth metadata bridge",
    );

    replace_once(
        &mut commands,
        "    // The Bot API server MUST run on the same machine as the file paths used by\n    // this helper. BeatGaler owns the exact child and passes its dynamic loopback\n    // endpoint explicitly; the helper never guesses or trusts a fixed port.\n    let bot_api_base = ensure_local_bot_api(session)?;",
        "    // Productive Direct uses a client-owned temporary MTProto auth key.\n    // Legacy Bot API startup remains available only for non-temp compatibility paths.\n    let temp_mode = session.get(\"mode\").and_then(|v| v.as_str()) == Some(\"galer-direct-temp-mtproto\");\n    let bot_api_base = if temp_mode { None } else { Some(ensure_local_bot_api(session)?) };",
        "Bot API bypass for temp mode",
    );

    replace_once(
        &mut commands,
        "    let mut helper_session = session.clone();\n    if let Some(object) = helper_session.as_object_mut() {\n        object.insert(\"bot_api_base\".to_string(), Value::String(bot_api_base));\n    }",
        "    let mut helper_session = session.clone();\n    if let (Some(object), Some(bot_api_base)) = (helper_session.as_object_mut(), bot_api_base) {\n        object.insert(\"bot_api_base\".to_string(), Value::String(bot_api_base));\n    }",
        "helper payload without Bot API base",
    );

    replace_once(
        &mut commands,
        "        generation,\n        credential_version,\n    };",
        "        generation,\n        credential_version,\n        temp_mode,\n    };",
        "runtime temp-mode initialization",
    );

    replace_once(
        &mut commands,
        "    if response.get(\"mode\").and_then(|v| v.as_str()) != Some(\"telegram-direct-botapi-local\") {\n        return Err(\"Galer Cloud did not offer the required local storage transport.\".to_string());\n    }",
        "    if response.get(\"mode\").and_then(|v| v.as_str()) != Some(\"galer-direct-temp-mtproto\") {\n        return Err(\"Galer Cloud did not offer the required temporary storage transport.\".to_string());\n    }",
        "temporary transport mode gate",
    );

    replace_once(
        &mut commands,
        "    let same_user_helper_alive = matches!(runtime_state, Some((true, None)));\n    if same_user_helper_alive && owned_local_bot_api_is_healthy() { return Ok(true); }\n    if same_user_helper_alive {\n        eprintln!(\"[direct] LOCAL_DATA_PLANE_UNHEALTHY helper_alive=true bot_api_healthy=false; rebuilding_same_lease=true\");\n    }",
        "    let same_user_helper_alive = matches!(runtime_state, Some((true, None)));\n    let temp_mode = direct_runtime_slot().lock().ok()\n        .and_then(|guard| guard.as_ref().map(|runtime| runtime.temp_mode))\n        .unwrap_or(false);\n    if same_user_helper_alive && (temp_mode || owned_local_bot_api_is_healthy()) { return Ok(true); }\n    if same_user_helper_alive {\n        eprintln!(\"[direct] LOCAL_DATA_PLANE_UNHEALTHY helper_alive=true bot_api_healthy=false; rebuilding_same_lease=true\");\n    }",
        "temp-mode health check",
    );

    replace_once(
        &mut commands,
        "                    if let Some(refresh) = response.get(\"credential_refresh\") {\n                        if let Err(error) = replace_direct_runtime_from_session(&user_id, refresh) {\n                            eprintln!(\"[direct] HEARTBEAT_REFRESH_FAILED reason={}\", error);\n                        } else {\n                            eprintln!(\"[direct] HEARTBEAT_CREDENTIAL_REFRESHED\");\n                        }\n                    }",
        "                    if response.get(\"temp_auth_required\").and_then(|v| v.as_bool()) == Some(true) {\n                        let start_url = format!(\"{}/transport/session/start\", telegram_cloud_api_base());\n                        if let Ok(fresh) = post_json_cloud_auth_timeout(&start_url, &json!({ \"beatgalerUserId\": user_id }), 8) {\n                            if fresh.get(\"session_id\").and_then(|v| v.as_str()) == Some(session_id.as_str())\n                                && fresh.get(\"generation\").and_then(|v| v.as_i64()) == Some(generation)\n                            {\n                                if let Some(version) = fresh.get(\"credential_version\").and_then(|v| v.as_i64()) {\n                                    if let Ok(mut guard) = direct_runtime_slot().lock() {\n                                        if let Some(runtime) = guard.as_mut() {\n                                            if runtime.session_id == session_id { runtime.credential_version = version; }\n                                        }\n                                    }\n                                    if let Ok(mut guard) = direct_lease_meta_slot().lock() {\n                                        if let Some(meta) = guard.as_mut() {\n                                            if meta.session_id == session_id { meta.credential_version = version; }\n                                        }\n                                    }\n                                }\n                            }\n                        }\n                    } else if let Some(refresh) = response.get(\"credential_refresh\").filter(|v| v.is_object()) {\n                        if let Err(error) = replace_direct_runtime_from_session(&user_id, refresh) {\n                            eprintln!(\"[direct] HEARTBEAT_REFRESH_FAILED reason={}\", error);\n                        } else {\n                            eprintln!(\"[direct] HEARTBEAT_CREDENTIAL_REFRESHED\");\n                        }\n                    }",
        "heartbeat safe credential-version refresh",
    );

    replace_once(
        &mut commands,
        "enum DirectBeginDisposition {\n    Ready(String),\n    Expired,\n    Refresh(Value),\n    Wait(u64),\n}",
        "enum DirectBeginDisposition {\n    Ready(String),\n    Expired,\n    Refresh(Value),\n    TempRefresh,\n    Wait(u64),\n}",
        "begin temp-refresh disposition",
    );

    replace_once(
        &mut commands,
        "    if response.get(\"refresh_required\").and_then(|v| v.as_bool()) == Some(true) {\n        let refresh = response.get(\"credential_refresh\")\n            .cloned()\n            .ok_or_else(|| \"Galer Cloud returned incomplete refreshed session information.\".to_string())?;\n        return Ok(DirectBeginDisposition::Refresh(refresh));\n    }",
        "    if response.get(\"refresh_required\").and_then(|v| v.as_bool()) == Some(true) {\n        if response.get(\"temp_auth_required\").and_then(|v| v.as_bool()) == Some(true) {\n            return Ok(DirectBeginDisposition::TempRefresh);\n        }\n        let refresh = response.get(\"credential_refresh\")\n            .filter(|value| value.is_object())\n            .cloned()\n            .ok_or_else(|| \"Galer Cloud returned incomplete refreshed session information.\".to_string())?;\n        return Ok(DirectBeginDisposition::Refresh(refresh));\n    }",
        "classify temp credential refresh",
    );

    replace_once(
        &mut commands,
        "            DirectBeginDisposition::Refresh(refresh) => {\n                replace_direct_runtime_from_session(user_id, &refresh)?;\n                continue;\n            }\n            DirectBeginDisposition::Wait(wait_ms) => {",
        "            DirectBeginDisposition::Refresh(refresh) => {\n                replace_direct_runtime_from_session(user_id, &refresh)?;\n                continue;\n            }\n            DirectBeginDisposition::TempRefresh => {\n                let start_url = format!(\"{}/transport/session/start\", telegram_cloud_api_base());\n                let fresh = post_json_cloud_auth_timeout(&start_url, &json!({ \"beatgalerUserId\": user_id }), 15)?;\n                if fresh.get(\"mode\").and_then(|v| v.as_str()) != Some(\"galer-direct-temp-mtproto\")\n                    || fresh.get(\"session_id\").and_then(|v| v.as_str()) != Some(session_id.as_str())\n                    || fresh.get(\"generation\").and_then(|v| v.as_i64()) != Some(generation)\n                {\n                    return Err(\"Galer Cloud returned a mismatched temporary credential refresh.\".to_string());\n                }\n                let version = fresh.get(\"credential_version\").and_then(|v| v.as_i64())\n                    .ok_or_else(|| \"Galer Cloud returned no temporary credential version.\".to_string())?;\n                if let Ok(mut guard) = direct_runtime_slot().lock() {\n                    if let Some(runtime) = guard.as_mut() {\n                        if runtime.session_id == session_id { runtime.credential_version = version; }\n                    }\n                }\n                if let Ok(mut guard) = direct_lease_meta_slot().lock() {\n                    if let Some(meta) = guard.as_mut() {\n                        if meta.session_id == session_id { meta.credential_version = version; }\n                    }\n                }\n                continue;\n            }\n            DirectBeginDisposition::Wait(wait_ms) => {",
        "apply safe temp credential refresh",
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out_dir.join("commands_task_5_1.rs"), commands).expect("write generated commands module");

    tauri_build::build();
}
