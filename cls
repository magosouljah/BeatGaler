[35morigin/galer-beta-v0.6.2:package.json[m[36m:[m    "test:unit:cloud": "node [1;31mcloud-server[m/tests/unit.test.cjs",
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  return path.join(root, '[1;31mtelegram[m-direct-client.txt');
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m    schema: 'beatgaler.[1;31mtelegram[m.library',
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m    add(beat.[1;31mtelegram[m_message_id);
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m    add(beat.master?.[1;31mtelegram[m_message_id);
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m    add(beat.artwork?.[1;31mtelegram[m_message_id);
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m      add(file?.[1;31mtelegram[m_message_id);
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m      for (const part of file?.manifest?.parts || file?.parts || []) add(part?.[1;31mtelegram[m_message_id);
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m    add(project?.[1;31mtelegram[m_message_id);
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m    for (const part of project?.parts || []) add(part?.[1;31mtelegram[m_message_id);
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  // [1;31mTelegram[m can rate-limit pin/send bursts. Critical Direct operations should
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  // still Desktop -> local Bot API -> [1;31mTelegram[m; no BeatGaler cloud relay.
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  if (parsed?.schema !== 'beatgaler.[1;31mtelegram[m.library') throw new Error('Pinned document is not a BeatGaler library index.');
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  // The control plane serializes INDEX operations per vault, but [1;31mTelegram[m can
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  // [1;31mtelegram[m-bot-api/TDLib can classify an MP3 sent through sendDocument as
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m    [1;31mtelegram[m_file_id: String(sent.document.file_id),
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  // server-side inside [1;31mTelegram[m to the private resolver channel returns a fresh
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  // SOURCE message still exists, so always ask [1;31mTelegram[m to forward that exact
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  if (nextManifest?.schema !== 'beatgaler.[1;31mtelegram[m.library') throw new Error('Library index has an unexpected schema.');
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  // Never create/pin/delete another [1;31mTelegram[m document when authoritative data
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m      [1;31mtelegram[m_file_id: existingFileId,
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m    [1;31mtelegram[m_file_id: String(sent.document.file_id),
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  // removes the race where getChat ran before [1;31mTelegram[m had applied membership.
[35morigin/galer-beta-v0.6.2:src-tauri/direct-transport/transport-helper.cjs[m[36m:[m  // [1;31mTelegram[m can acknowledge InviteToChannel/EditAdmin to MASTER a fraction of
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // ── [1;31mTelegram[m Cloud (Fase 12/17 del plan) ──
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // MP3/WAV lives in [1;31mTelegram[m. Kept intentionally simple for the first
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    pub [1;31mtelegram[m_file_id: Option<String>,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    pub [1;31mtelegram[m_message_id: Option<i64>,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    pub [1;31mtelegram[m_file_id: String,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    pub [1;31mtelegram[m_message_id: i64,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    pub [1;31mtelegram[m_metadata_message_id: i64,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    pub artwork_[1;31mtelegram[m_file_id: Option<String>,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    pub artwork_[1;31mtelegram[m_message_id: Option<i64>,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    pub [1;31mtelegram[m_file_id: Option<String>,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    pub [1;31mtelegram[m_message_id: Option<i64>,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// [1;31mTelegram[m Cloud (Fase 2-11 del plan)
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// BeatGaler nunca habla directo con [1;31mTelegram[m ni conoce el bot token.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// coordina la vinculación con [1;31mTelegram[m.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mpub struct [1;31mTelegram[mCloudStatus {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // Losing Wi-Fi must not erase the remembered [1;31mTelegram[m link.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// URL base del backend de [1;31mTelegram[m Cloud. Mientras desarrollamos, es el
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// servidor local ([1;31mcloud-server[m/). Cuando exista api.beatgaler.com, este es
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mfn [1;31mtelegram[m_cloud_api_base() -> String {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// instalación de BeatGaler ante el backend. No tiene relación con [1;31mTelegram[m.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// remote [1;31mcloud-server[m never receives or tries to open that local filesystem path.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// [1;31mTelegram[m Direct Prototype — Desktop data plane
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// in and transfers MP3/WAV/PROJECT bytes Desktop <-> [1;31mTelegram[m by MTProto.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// `[1;31mtelegram[m_file_id`, but direct media uses the internal locator
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .map(|settings| settings.[1;31mtelegram[m_cloud_connected)
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        candidates.push(cwd.join("src-tauri").join("[1;31mdirect-transport[m").join("transport-helper.cjs"));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        candidates.push(cwd.join("[1;31mdirect-transport[m").join("transport-helper.cjs"));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            candidates.push(dir.join("[1;31mdirect-transport[m").join("transport-helper.cjs"));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            candidates.push(dir.join("resources").join("[1;31mdirect-transport[m").join("transport-helper.cjs"));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m                candidates.push(parent.join("Resources").join("[1;31mdirect-transport[m").join("transport-helper.cjs"));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let url = format!("{}/transport/session/stop", [1;31mtelegram[m_cloud_api_base());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let url = format!("{}/transport/session/activate", [1;31mtelegram[m_cloud_api_base());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        "Direct transport helper is missing. Expected src-tauri/[1;31mdirect-transport[m/transport-helper.cjs.".to_string()
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // Two-phase activation with NO visible [1;31mTelegram[m handshake message.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // prevents a fast helper from racing [1;31mTelegram[m membership propagation.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            let url = format!("{}/transport/session/heartbeat", [1;31mtelegram[m_cloud_api_base());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m                    // must not destroy a healthy local [1;31mTelegram[m operation.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        return Err("[1;31mTelegram[m Direct transport is disabled. BeatGaler no longer falls back to the manager/service bot.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let url = format!("{}/transport/session/start", [1;31mtelegram[m_cloud_api_base());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    if response.get("mode").and_then(|v| v.as_str()) != Some("[1;31mtelegram[m-direct-botapi-local") {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        return Err("BeatGaler Cloud did not offer [1;31mTelegram[m Direct transport.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        let url = format!("{}/transport/operation/begin", [1;31mtelegram[m_cloud_api_base());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let url = format!("{}/transport/operation/end", [1;31mtelegram[m_cloud_api_base());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let mut last_error = "[1;31mTelegram[m INDEX is temporarily unavailable.".to_string();
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m                    Some(_) => last_error = "Pinned [1;31mTelegram[m document is not a BeatGaler library index.".to_string(),
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        return Err("Direct library index sync returned no [1;31mTelegram[m message id.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // Desktop -> local Bot API -> [1;31mTelegram[m and never traversed BeatGaler Cloud.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let commit_url = format!("{}/transport/index/commit", [1;31mtelegram[m_cloud_api_base());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let root = manifest.as_object_mut().ok_or_else(|| "[1;31mTelegram[m library index root is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        let rows = trash.as_array_mut().ok_or_else(|| "[1;31mTelegram[m library trash field is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let rows = beats.as_array_mut().ok_or_else(|| "[1;31mTelegram[m library beats field is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let root = manifest.as_object_mut().ok_or_else(|| "[1;31mTelegram[m library index root is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let beats_array = beats.as_array_mut().ok_or_else(|| "[1;31mTelegram[m library beats field is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let trash_array = trash.as_array_mut().ok_or_else(|| "[1;31mTelegram[m library trash field is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    add(entry.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64()));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    add(entry.get("master").and_then(|v| v.get("[1;31mtelegram[m_message_id")).and_then(|v| v.as_i64()));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    add(entry.get("artwork").and_then(|v| v.get("[1;31mtelegram[m_message_id")).and_then(|v| v.as_i64()));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            add(file.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64()));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m                for part in parts { add(part.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64())); }
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m                for part in parts { add(part.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64())); }
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        add(project.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64()));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            for part in parts { add(part.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64())); }
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let root = manifest.as_object_mut().ok_or_else(|| "[1;31mTelegram[m library index root is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        let beats_array = beats.as_array_mut().ok_or_else(|| "[1;31mTelegram[m library beats field is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        let trash_array = trash.as_array_mut().ok_or_else(|| "[1;31mTelegram[m library trash field is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let deleted_array = deleted.as_array_mut().ok_or_else(|| "[1;31mTelegram[m library deleted field is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let url = format!("{}/transport/topic/ensure", [1;31mtelegram[m_cloud_api_base());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        "[1;31mtelegram[m_file_id": locator,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        "[1;31mtelegram[m_message_id": message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "[1;31mtelegram[m_file_id": format!("direct:{}", message_id),
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "[1;31mtelegram[m_message_id": message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            // Only these [1;31mTelegram[m responses are treated as definitive physical loss.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    Err(format!("[1;31mTelegram[m Direct range retry exhausted: {}", last_error))
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// Fase 6/7: pide al backend un connect_token + deep link, y abre [1;31mTelegram[m
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// `poll_[1;31mtelegram[m_cloud_status` periódicamente hasta que `connected: true`.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mpub fn connect_[1;31mtelegram[m_cloud(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // [1;31mTelegram[m is infrastructure now, not an end-user login surface. The
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let base = [1;31mtelegram[m_cloud_api_base();
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let url = format!("{}/[1;31mtelegram[m/connect/status?beatgalerUserId={}", base, user_id);
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .or_else(|| response.get("[1;31mtelegram[m_username"))
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        settings.[1;31mtelegram[m_cloud_connected = true;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        settings.[1;31mtelegram[m_cloud_username = username;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// el usuario presione Start en [1;31mTelegram[m. Cuando `connected: true`, el
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mpub fn poll_[1;31mtelegram[m_cloud_status(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m) -> Result<[1;31mTelegram[mCloudStatus, String> {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let base = [1;31mtelegram[m_cloud_api_base();
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let url = format!("{}/[1;31mtelegram[m/connect/status?beatgalerUserId={}", base, user_id);
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .get("[1;31mtelegram[m_username")
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        settings.[1;31mtelegram[m_cloud_connected = true;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        settings.[1;31mtelegram[m_cloud_username = username.clone();
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    Ok([1;31mTelegram[mCloudStatus { connected, reachable, username })
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mpub fn get_[1;31mtelegram[m_cloud_status(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m) -> Result<[1;31mTelegram[mCloudStatus, String> {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let base = [1;31mtelegram[m_cloud_api_base();
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let url = format!("{}/[1;31mtelegram[m/connect/status?beatgalerUserId={}", base, user_id);
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .map_err(|e| format!("Could not verify [1;31mTelegram[m Cloud status. Is the BeatGaler Cloud server running? ({})", e))?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .get("[1;31mtelegram[m_username")
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // Reconcile persisted linkage only when [1;31mTelegram[m itself is reachable.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        settings.[1;31mtelegram[m_cloud_connected = true;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        settings.[1;31mtelegram[m_cloud_username = username.clone();
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        settings.[1;31mtelegram[m_cloud_connected = false;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        settings.[1;31mtelegram[m_cloud_username = None;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    Ok([1;31mTelegram[mCloudStatus { connected, reachable, username })
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// local. No borra ningún archivo ya subido a [1;31mTelegram[m — eso corresponde
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mpub fn disconnect_[1;31mtelegram[m_cloud(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let base = [1;31mtelegram[m_cloud_api_base();
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let url = format!("{}/[1;31mtelegram[m/disconnect", base);
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    settings.[1;31mtelegram[m_cloud_connected = false;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    settings.[1;31mtelegram[m_cloud_username = None;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// Fase 17: sube el MP3/WAV principal de un beat a [1;31mTelegram[m Cloud. Solo el
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// posteriores. Guarda [1;31mtelegram[m_file_id/message_id en el propio beat
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mpub fn upload_beat_to_[1;31mtelegram[m(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        if !settings.[1;31mtelegram[m_cloud_connected {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            return Err("[1;31mTelegram[m is not connected. Connect it in Settings first.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // Review -> Save is the commit boundary. Only NOW do we consult [1;31mTelegram[m
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // never talks to [1;31mTelegram[m and never invents _2 before the user finishes editing.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // [1;31mTelegram[m. Invalid embedded tags are dropped; BPM/key are strict.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // V7: preserve the [1;31mTelegram[m-authoritative duplicate-name gate, but it now
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let [1;31mtelegram[m_file_id = response.get("[1;31mtelegram[m_file_id").and_then(|v| v.as_str()).map(|s| s.to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let [1;31mtelegram[m_message_id = response.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    updated.[1;31mtelegram[m_file_id = [1;31mtelegram[m_file_id;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    updated.[1;31mtelegram[m_message_id = [1;31mtelegram[m_message_id;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// Writes ONE complete library manifest to a pinned [1;31mTelegram[m document.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// The manifest contains logical metadata and [1;31mTelegram[m IDs only; local source
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        "SELECT [1;31mtelegram[m_metadata_message_id, artwork_hash, artwork_[1;31mtelegram[m_file_id, artwork_[1;31mtelegram[m_message_id
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            // [1;31mTelegram[m library index: a beat can start as audio-only and receive
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let has_master = beat.[1;31mtelegram[m_file_id.as_deref().map(|v| !v.is_empty()).unwrap_or(false);
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "[1;31mtelegram[m_file_id": beat.[1;31mtelegram[m_file_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "[1;31mtelegram[m_message_id": beat.[1;31mtelegram[m_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "[1;31mtelegram[m_file_id": artwork_file_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "[1;31mtelegram[m_message_id": artwork_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        if !settings.[1;31mtelegram[m_cloud_connected {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            return Err("[1;31mTelegram[m is not connected.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // Trash is part of the [1;31mTelegram[m source of truth. Files stay in their
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // original [1;31mTelegram[m messages while trashed; only membership changes.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .map_err(|e| format!("Could not read [1;31mTelegram[m source-of-truth index before sync: {}", e))?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // SINGLE [1;31mTelegram[m index, written by the active transport bot directly
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .map_err(|e| format!("Could not sync [1;31mTelegram[m library index directly: {}", e))?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        [1;31mtelegram[m_file_id: format!("index:{}", library_message_id),
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        [1;31mtelegram[m_message_id: library_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    [1;31mtelegram[m_file_id: &str,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    hasher.update([1;31mtelegram[m_file_id.as_bytes());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        if let Some(message_id) = direct_message_id([1;31mtelegram[m_file_id) {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // call site. Sniff the actual [1;31mTelegram[m bytes so a JPEG stays image/jpeg
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// Rebuilds the local SQLite/cache view from the pinned [1;31mTelegram[m library index.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        // Never let an older/stale [1;31mTelegram[m index downgrade PROJECT capabilities
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let artwork_file_id = artwork.get("[1;31mtelegram[m_file_id").and_then(|v| v.as_str()).map(|v| v.to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let artwork_message_id = artwork.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m         (beat_id, [1;31mtelegram[m_metadata_message_id, artwork_hash, artwork_[1;31mtelegram[m_file_id, artwork_[1;31mtelegram[m_message_id, updated_at)
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m           [1;31mtelegram[m_metadata_message_id=excluded.[1;31mtelegram[m_metadata_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m           artwork_[1;31mtelegram[m_file_id=excluded.artwork_[1;31mtelegram[m_file_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m           artwork_[1;31mtelegram[m_message_id=excluded.artwork_[1;31mtelegram[m_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    if id.is_empty() { return Err("[1;31mTelegram[m library entry has no beat id.".to_string()); }
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let [1;31mtelegram[m_file_id = master.get("[1;31mtelegram[m_file_id").and_then(|v| v.as_str()).map(|v| v.to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let [1;31mtelegram[m_message_id = master.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // remaining library. This keeps hundreds of [1;31mTelegram[m artwork requests out
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        cloud_status: [1;31mtelegram[m_file_id.as_ref()
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        [1;31mtelegram[m_file_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        [1;31mtelegram[m_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        if !settings.[1;31mtelegram[m_cloud_connected { return Ok(0); }
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .map_err(|e| format!("Could not read [1;31mTelegram[m library for integrity repair: {}", e))?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            .and_then(|v| v.get("[1;31mtelegram[m_message_id"))
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m                .and_then(|v| v.get("[1;31mtelegram[m_file_id"))
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            // conservative and only removes media [1;31mTelegram[m explicitly proves missing.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let root = manifest.as_object_mut().ok_or_else(|| "[1;31mTelegram[m library index root is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let beats_array = beats.as_array_mut().ok_or_else(|| "[1;31mTelegram[m library beats field is invalid.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // missing by [1;31mTelegram[m itself. Existing delete_messages/cleanup behavior remains
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .map_err(|e| format!("Could not publish repaired [1;31mTelegram[m library INDEX: {}", e))?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mpub fn restore_library_from_[1;31mtelegram[m(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        if !settings.[1;31mtelegram[m_cloud_connected { return Err("[1;31mTelegram[m is not connected.".to_string()); }
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // Restore the authoritative index directly from [1;31mTelegram[m through the
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .map_err(|e| format!("Could not restore [1;31mTelegram[m library directly: {}", e))?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .ok_or_else(|| "[1;31mTelegram[m library index has no beats array.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // V7: [1;31mTelegram[m is the source of truth. An authoritative empty INDEX means
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        let had_cloud = meta.[1;31mtelegram[m_file_id.as_deref().map(|v| !v.is_empty()).unwrap_or(false)
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        // [1;31mTelegram[m's pinned library index is authoritative for cloud-backed beats.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        // that is absent from both the active list and [1;31mTelegram[m trash.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// Fetch one beat artwork lazily from [1;31mTelegram[m using the file id already saved
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "SELECT artwork_[1;31mtelegram[m_file_id FROM cloud_metadata WHERE beat_id=?1 LIMIT 1",
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m// a new [1;31mTelegram[m document before either one updates SQLite.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// Syncs lightweight LIVE BeatGaler metadata to [1;31mTelegram[m without re-uploading
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mpub fn sync_beat_metadata_to_[1;31mtelegram[m(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .map_err(|_| "[1;31mTelegram[m metadata sync lock was poisoned.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        if !settings.[1;31mtelegram[m_cloud_connected {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            return Err("[1;31mTelegram[m is not connected.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    if beat.[1;31mtelegram[m_file_id.as_deref().unwrap_or("").is_empty() {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        return Err("Upload the beat master to [1;31mTelegram[m before syncing its metadata.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let base = [1;31mtelegram[m_cloud_api_base();
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "SELECT [1;31mtelegram[m_metadata_message_id, artwork_hash, artwork_[1;31mtelegram[m_file_id, artwork_[1;31mtelegram[m_message_id
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        // Direct mode is copy-on-write: a changed cover gets a NEW [1;31mTelegram[m
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            artwork_file_id = response.get("[1;31mtelegram[m_file_id").and_then(|v| v.as_str()).map(|v| v.to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            artwork_message_id = response.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // [1;31mTelegram[m library index. Sending a raw BEATGALER_METADATA_V1 message for
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m             (beat_id, [1;31mtelegram[m_metadata_message_id, artwork_hash, artwork_[1;31mtelegram[m_file_id, artwork_[1;31mtelegram[m_message_id, updated_at)
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m               [1;31mtelegram[m_metadata_message_id=excluded.[1;31mtelegram[m_metadata_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m               artwork_[1;31mtelegram[m_file_id=excluded.artwork_[1;31mtelegram[m_file_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m               artwork_[1;31mtelegram[m_message_id=excluded.artwork_[1;31mtelegram[m_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        [1;31mtelegram[m_metadata_message_id: metadata_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        artwork_[1;31mtelegram[m_file_id: artwork_file_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        artwork_[1;31mtelegram[m_message_id: artwork_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// BeatGaler metadata into the bytes that are sent to [1;31mTelegram[m. The user's
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// source file is never modified. Because [1;31mTelegram[m receives the file as a
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// the beat's local folder first. [1;31mTelegram[m becomes the durable copy.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// MASTER keeps the legacy BeatMeta [1;31mTelegram[m IDs in sync for playback.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mpub fn upload_dropped_file_to_[1;31mtelegram[m(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        if !settings.[1;31mtelegram[m_cloud_connected {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            return Err("[1;31mTelegram[m is not connected. Connect it in Settings first.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    // are removed into a temporary filtered copy before any bytes are sent to [1;31mTelegram[m.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        let [1;31mtelegram[m_file_id = response.get("[1;31mtelegram[m_file_id")
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            .ok_or_else(|| "[1;31mTelegram[m did not return a file_id.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        let [1;31mtelegram[m_message_id = response.get("[1;31mtelegram[m_message_id").and_then(|v| v.as_i64());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        updated.[1;31mtelegram[m_file_id = Some([1;31mtelegram[m_file_id.clone());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        updated.[1;31mtelegram[m_message_id = [1;31mtelegram[m_message_id;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        // MASTER has exactly one logical home: BeatMeta.[1;31mtelegram[m_*.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            [1;31mtelegram[m_file_id: Some([1;31mtelegram[m_file_id),
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            [1;31mtelegram[m_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m                        .and_then(|p| p.get("[1;31mtelegram[m_message_id").and_then(|m| m.as_i64()));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m                        .and_then(|p| p.get("[1;31mtelegram[m_message_id").and_then(|m| m.as_i64()));
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        return Err("[1;31mTelegram[m did not return any uploaded file parts.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .and_then(|v| v.get("[1;31mtelegram[m_file_id"))
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .and_then(|v| v.get("[1;31mtelegram[m_message_id"))
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        [1;31mtelegram[m_file_id: first_file_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        [1;31mtelegram[m_message_id: first_message_id,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m/// Download a [1;31mTelegram[m-backed file into an exact destination path.
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mfn download_[1;31mtelegram[m_file_to_path(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    [1;31mtelegram[m_file_id: &str,
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    if let Some(message_id) = direct_message_id([1;31mtelegram[m_file_id) {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "This asset still uses a legacy Bot API file_id. 001BeatGaler is manager-only; migrate/re-upload it through [1;31mTelegram[m Direct."
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        return Err("[1;31mTelegram[m returned an empty file.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[mfn download_beat_from_[1;31mtelegram[m_inner(
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        if !settings.[1;31mtelegram[m_cloud_connected {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            return Err("[1;31mTelegram[m is not connected. Connect it in Settings first.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let [1;31mtelegram[m_file_id = beat.[1;31mtelegram[m_file_id.clone()
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .ok_or_else(|| "This beat has no [1;31mTelegram[m file_id. Upload it first.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    download_[1;31mtelegram[m_file_to_path(&[1;31mtelegram[m_file_id, &user_id, &destination)?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let master = beat.[1;31mtelegram[m_file_id.as_deref().unwrap_or("");
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        "SELECT artwork_[1;31mtelegram[m_file_id, artwork_hash FROM cloud_metadata WHERE beat_id=?1",
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        if !settings.[1;31mtelegram[m_cloud_connected {
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            return Err("BeatGaler is not connected to [1;31mTelegram[m Cloud.".to_string());
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "SELECT artwork_[1;31mtelegram[m_file_id FROM cloud_metadata WHERE beat_id=?1",
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m    let master_file_id = current.[1;31mtelegram[m_file_id.clone()
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        .ok_or_else(|| "This beat has no [1;31mTelegram[m MASTER.".to_string())?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m        download_[1;31mtelegram[m_file_to_path(&master_file_id, &user_id, &master_stage)?;
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            // MASTER has its own canonical [1;31mTelegram[m id and PROJECT has its own
[35morigin/galer-beta-v0.6.2:src-tauri/src/commands.rs[m[36m:[m            "INSERT INTO offline_beats (user_id, beat_id, root_path