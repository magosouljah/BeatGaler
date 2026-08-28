use tauri::Manager;
use base64::{engine::general_purpose, Engine};
// BeatGaler storage rules v2: canonical MASTER/WAV/PROJECT/METADATA/ARTWORK/TRASH slots.
use id3::{Tag, TagLike, Version, frame};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write, Seek, SeekFrom, BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Child, ChildStdin, ChildStdout, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::collections::{HashMap, VecDeque};
use url::Url;
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;
use tauri::Emitter;
use crate::matcher;
use crate::versioning::{
    GALER_T_LIBRARY_SCHEMA, GALER_T_LIBRARY_SCHEMA_VERSION,
    normalize_galer_t_library_manifest, migrate_sqlite_schema,
};

fn background_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: child CLI helpers must never flash a console window
        // in the installed GUI app. stdout/stderr behavior remains unchanged.
        command.creation_flags(0x08000000);
    }
    command
}

// ─────────────────────────────────────────────────────────────
//  Logging — plain-text rotating log file, no extra crates needed.
//  Written to {app_data_dir}/logs/beatvault.log. Rotates once it
//  passes ~5MB so it never grows unbounded.
// ─────────────────────────────────────────────────────────────

pub fn log_line(data_dir: &Path, level: &str, msg: &str) {
    let dir = data_dir.join("logs");
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let path = dir.join("beatvault.log");

    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5_000_000 {
            let _ = std::fs::rename(&path, dir.join("beatvault.log.old"));
        }
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{}] {:<5} {}\n", ts, level, msg);

    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write as _;
        let _ = f.write_all(line.as_bytes());
    }
}

fn log_info(data_dir: &Path, msg: &str) { log_line(data_dir, "INFO", msg); }
fn log_warn(data_dir: &Path, msg: &str) { log_line(data_dir, "WARN", msg); }
fn log_error(data_dir: &Path, msg: &str) { log_line(data_dir, "ERROR", msg); }

#[tauri::command]
pub fn get_log_dir(state: tauri::State<SettingsState>) -> String {
    state.data_dir.join("logs").to_string_lossy().to_string()
}

/// Diagnostic-only bridge used by the Review performance probe. Frontend marks
/// are mirrored to stderr so a complete DROP -> PAINT timeline is visible in
/// the same PowerShell window as Rust timings.
#[tauri::command]
pub fn review_perf_log(message: String) {
    let safe = message.replace('\r', " " ).replace('\n', " " );
    eprintln!("[review-diag] {}", safe);
}

/// General desktop diagnostic bridge. Keep each record single-line and bounded
/// so Terminal and the rotating application log show the same useful timeline
/// without accepting arbitrary multi-line renderer output.
#[tauri::command]
pub fn diagnostic_log(
    scope: String,
    event: String,
    detail: Option<String>,
    state: tauri::State<SettingsState>,
) {
    let clean = |value: &str, max: usize| -> String {
        value
            .replace(['\r', '\n'], " ")
            .chars()
            .take(max)
            .collect::<String>()
    };
    let scope = clean(&scope, 48);
    let event = clean(&event, 80);
    let detail = clean(detail.as_deref().unwrap_or(""), 900);
    let line = if detail.is_empty() {
        format!("[{}] {}", scope, event)
    } else {
        format!("[{}] {} {}", scope, event, detail)
    };
    eprintln!("[diag] {}", line);
    log_info(&state.data_dir, &line);
}

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BeatMeta {
    pub id: String,
    pub name: String,           // clean display name, no [BPM Key]
    pub folder_path: String,
    pub mp3_path: String,       // main mp3 (may be empty string if wav-only)
    pub wav_path: Option<String>,
    pub playback_path: String,  // what we actually play: MASTER MP3 only
    pub bpm: String,
    pub key: String,
    pub needs_resolution: bool,
    pub tags: Vec<String>,
    pub rating: u8,
    pub image_base64: Option<String>,
    pub has_wav: bool,
    pub has_stems: bool,
    #[serde(default)]
    pub has_samples: bool,
    #[serde(default)]
    pub samples_path: Option<String>,
    pub has_flp: bool,
    pub has_als: bool,
    pub stems_path: Option<String>,
    pub flp_path: Option<String>,
    pub als_path: Option<String>,
    pub other_files: Vec<String>, // mp3/wav that don't match the beat name
    pub color: String,
    pub color2: String,
    #[serde(default)]
    pub has_loop: bool,
    #[serde(default)]
    pub loop_path: Option<String>,
    // ── Telegram Cloud (Fase 12/17 del plan) ──
    // None/omitted == LOCAL (never uploaded). "SYNCED" once the main
    // MP3/WAV lives in Telegram. Kept intentionally simple for the first
    // version — more granular file-level status (Fase 13) comes later.
    #[serde(default)]
    pub cloud_status: Option<String>,
    #[serde(default)]
    pub telegram_file_id: Option<String>,
    #[serde(default)]
    pub telegram_message_id: Option<i64>,
    // Local-only pin. Never serialized into the Galer T-Library manifest.
    // A pinned beat owns a durable copy under app_data/offline and is allowed
    // to appear on a cold start with no network.
    #[serde(default)]
    pub offline_available: bool,
}


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CloudLibrarySyncResult {
    pub telegram_file_id: String,
    pub telegram_message_id: i64,
    pub updated: bool,
    pub beat_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CloudMetadataSyncResult {
    pub beat_id: String,
    pub telegram_metadata_message_id: i64,
    pub artwork_telegram_file_id: Option<String>,
    pub artwork_telegram_message_id: Option<i64>,
}

fn artwork_hash(value: Option<&str>) -> Option<String> {
    use std::hash::{Hash, Hasher};
    let value = value?.trim();
    if value.is_empty() { return None; }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    Some(format!("{:016x}", hasher.finish()))
}

fn write_cloud_artwork_temp(data_dir: &Path, image_base64: &str, beat_id: &str) -> Result<PathBuf, String> {
    let (header, encoded) = image_base64
        .split_once(',')
        .map(|(h, b)| (Some(h), b))
        .unwrap_or((None, image_base64));
    let header_lc = header.unwrap_or("").to_ascii_lowercase();
    let ext = if header_lc.contains("image/jpeg") || header_lc.contains("image/jpg") {
        "jpg"
    } else if header_lc.contains("image/webp") {
        "webp"
    } else if header_lc.contains("image/gif") {
        "gif"
    } else {
        "png"
    };
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Invalid artwork data: {}", e))?;
    let dir = beatgaler_temp_dir().join("cloud-upload-tmp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe_id: String = beat_id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let path = dir.join(format!(
        "artwork-{}-{}.{}",
        if safe_id.is_empty() { "beat" } else { &safe_id },
        now_epoch(),
        ext
    ));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CloudFileUploadResult {
    pub cloud_file_id: String,
    pub beat_id: String,
    pub file_type: String,
    pub filename: String,
    pub original_size: u64,
    pub part_count: usize,
    pub telegram_file_id: Option<String>,
    pub telegram_message_id: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CloudFileRecord {
    pub cloud_file_id: String,
    pub beat_id: String,
    pub file_type: String,
    pub filename: String,
    pub original_size: u64,
    pub part_count: usize,
    pub status: String,
}

#[tauri::command(async)]
pub fn list_cloud_files_for_beat(
    beat_id: String,
    db: tauri::State<DbState>,
) -> Result<Vec<CloudFileRecord>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT cloud_file_id, beat_id, file_type, filename, COALESCE(source_size,0), manifest_json, status
         FROM cloud_files
         WHERE beat_id=?1 AND file_type NOT IN ('MASTER','PROJECT')
         ORDER BY created_at ASC"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![beat_id.clone()], |r| {
        let manifest_raw: String = r.get(5)?;
        let manifest: Value = serde_json::from_str(&manifest_raw).unwrap_or(Value::Null);
        let part_count = manifest.get("parts")
            .and_then(|v| v.as_array())
            .map(|v| v.len())
            .unwrap_or(0);
        let size_i64: i64 = r.get(4)?;
        Ok(CloudFileRecord {
            cloud_file_id: r.get(0)?,
            beat_id: r.get(1)?,
            file_type: r.get(2)?,
            filename: r.get(3)?,
            original_size: size_i64.max(0) as u64,
            part_count,
            status: r.get(6)?,
        })
    }).map_err(|e| e.to_string())?;

    out.extend(rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?);

    // PROJECT has one canonical logical slot in cloud_projects. Expose a
    // synthetic CloudFileRecord for the existing UI/download API instead of
    // storing a second independent PROJECT record in cloud_files.
    let project = conn.query_row(
        "SELECT manifest_json, COALESCE(source_size,0) FROM cloud_projects WHERE beat_id=?1",
        params![beat_id.clone()],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
    );
    match project {
        Ok((manifest_raw, size_i64)) => {
            let manifest: Value = serde_json::from_str(&manifest_raw).unwrap_or(Value::Null);
            let part_count = manifest.get("parts")
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .unwrap_or(0);
            out.push(CloudFileRecord {
                cloud_file_id: format!("PROJECT:{}", beat_id),
                beat_id: beat_id.clone(),
                file_type: "PROJECT".to_string(),
                filename: "project.zip".to_string(),
                original_size: size_i64.max(0) as u64,
                part_count,
                status: "SYNCED".to_string(),
            });
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(e) => return Err(e.to_string()),
    }

    Ok(out)
}


// Return true if filename contains multiple bracket groups that look like BPM/key markers
fn has_multiple_bpm_key_brackets(filename: &str) -> bool {
    let re_bracket = regex_lite::Regex::new(r"\[([^\]]+)\]").unwrap();
    let mut count = 0;
    for cap in re_bracket.captures_iter(filename) {
        let inner = cap[1].trim();
        // consider it a BPM/key bracket if it contains a 2-3 digit number or a possible key token
        let re_bpm = regex_lite::Regex::new(r"\d{2,3}").unwrap();
        let re_key = regex_lite::Regex::new(r"[ABCDEFGabcdefg][#b]?m?").unwrap();
        if re_bpm.is_match(inner) || re_key.is_match(inner) { count += 1; }
        if count > 1 { return true; }
    }
    false
}

#[tauri::command]
pub fn disconnect_youtube(state: tauri::State<SettingsState>) -> Result<(), String> {
    let tokens_path = youtube_tokens_path(&state.data_dir);
    if tokens_path.exists() {
        std::fs::remove_file(&tokens_path).map_err(|e| format!("Could not remove youtube tokens: {}", e))?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Telegram Cloud (Fase 2-11 del plan)
//
// BeatGaler nunca habla directo con Telegram ni conoce el bot token.
// Solo habla con nuestro propio backend (por ahora local, en desarrollo:
// https://desktop-7l93a0j.tailabe8ff.ts.net mediante Tailscale Funnel). El backend es quien conoce el bot token y quien
// coordina la vinculación con Telegram.
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TelegramCloudStatus {
    // Account linkage and runtime reachability are intentionally separate.
    // Losing Wi-Fi must not erase the remembered Telegram link.
    pub connected: bool,
    pub reachable: bool,
    pub username: Option<String>,
}

const DEFAULT_GALER_CLOUD_API: &str = "https://desktop-7l93a0j.tailabe8ff.ts.net";
static CLOUD_API_BASE: OnceLock<Mutex<String>> = OnceLock::new();

fn normalize_cloud_api_base(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed).map_err(|_| "BeatGaler Cloud API URL is invalid.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("BeatGaler Cloud API URL must use http or https.".to_string());
    }
    Ok(trimmed.to_string())
}

fn cloud_api_base_slot() -> &'static Mutex<String> {
    CLOUD_API_BASE.get_or_init(|| {
        let initial = std::env::var("BEATGALER_CLOUD_API")
            .ok()
            .and_then(|value| normalize_cloud_api_base(&value).ok())
            .unwrap_or_else(|| DEFAULT_GALER_CLOUD_API.to_string());
        Mutex::new(initial)
    })
}

// Rust and React must talk to the exact same Galer Cloud origin. React resolves
// local/remote reachability during authentication and sends that chosen base to
// Rust together with the account token before Direct warmup begins.
fn telegram_cloud_api_base() -> String {
    cloud_api_base_slot()
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| DEFAULT_GALER_CLOUD_API.to_string())
}

fn beatgaler_temp_dir() -> PathBuf {
    let p = std::env::temp_dir().join("BeatGaler");
    let _ = std::fs::create_dir_all(&p);
    p
}

// Genera (una sola vez) y persiste el id local que identifica esta
// instalación de BeatGaler ante el backend. No tiene relación con Telegram.
fn ensure_beatgaler_user_id(state: &tauri::State<SettingsState>) -> Result<String, String> {
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if let Some(ref id) = settings.beatgaler_user_id {
            return Ok(id.clone());
        }
    }
    let new_id = random_urlsafe(20);
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.beatgaler_user_id = Some(new_id.clone());
    save_settings_file(&state.data_dir, &*settings)?;
    Ok(new_id)
}

fn post_json_simple_timeout(url: &str, body: &Value, max_time_seconds: u64) -> Result<Value, String> {
    let mut args = vec![
        "-sS".to_string(),
        "--connect-timeout".to_string(),
        "2".to_string(),
        "--max-time".to_string(),
        max_time_seconds.max(1).to_string(),
        "-X".to_string(),
        "POST".to_string(),
        "-H".to_string(),
        "Content-Type: application/json".to_string(),
    ];
    if let Some(token) = cloud_auth_token() {
        args.push("-H".to_string());
        args.push(format!("Authorization: Bearer {}", token));
    }
    args.push("--data-binary".to_string());
    args.push(body.to_string());
    args.push(url.to_string());
    let raw = run_curl(&args)?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid JSON from BeatGaler Cloud: {} ({})", e, raw))
}

fn post_json_simple(url: &str, body: &Value) -> Result<Value, String> {
    post_json_simple_timeout(url, body, 5)
}

fn get_json_simple(url: &str) -> Result<Value, String> {
    let mut args = vec![
        "-sS".to_string(),
        "--connect-timeout".to_string(),
        "2".to_string(),
        "--max-time".to_string(),
        "5".to_string(),
    ];
    if let Some(token) = cloud_auth_token() {
        args.push("-H".to_string());
        args.push(format!("Authorization: Bearer {}", token));
    }
    args.push(url.to_string());
    let raw = run_curl(&args)?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid JSON from BeatGaler Cloud: {} ({})", e, raw))
}


/// Sends the ACTUAL file bytes as multipart/form-data.
/// `file_path` is read on the desktop running BeatGaler (Mac/Windows); the
/// remote cloud-server never receives or tries to open that local filesystem path.
fn post_multipart_file_json(
    url: &str,
    fields: &[(&str, String)],
    file_field: &str,
    file_path: &Path,
) -> Result<Value, String> {
    let meta = std::fs::metadata(file_path)
        .map_err(|e| format!("Could not read upload source '{}': {}", file_path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("Upload source is not a file: {}", file_path.display()));
    }
    if meta.len() == 0 {
        return Err(format!("Upload source is empty: {}", file_path.display()));
    }

    let mut args = vec![
        "-sS".to_string(),
        "--connect-timeout".to_string(),
        "5".to_string(),
        "--max-time".to_string(),
        "3600".to_string(),
        "-X".to_string(),
        "POST".to_string(),
    ];
    if let Some(token) = cloud_auth_token() {
        args.push("-H".to_string());
        args.push(format!("Authorization: Bearer {}", token));
    }

    // --form-string prevents user-controlled text (beat names, IDs) from being
    // interpreted as curl form directives.
    for (key, value) in fields {
        args.push("--form-string".to_string());
        args.push(format!("{}={}", key, value));
    }

    // This @ is intentional: curl opens the LOCAL file and streams its bytes
    // into the HTTP request body. Only the bytes cross the network.
    args.push("-F".to_string());
    args.push(format!("{}=@{}", file_field, file_path.to_string_lossy()));
    args.push("-w".to_string());
    args.push("\n__BEATGALER_HTTP_STATUS__:%{http_code}".to_string());
    args.push(url.to_string());

    let raw = run_curl(&args)?;
    let (body, status_text) = raw
        .rsplit_once("\n__BEATGALER_HTTP_STATUS__:")
        .ok_or_else(|| format!("BeatGaler Cloud response had no HTTP status marker. Raw response: {}", raw))?;
    let status = status_text.trim().parse::<u16>().unwrap_or(0);

    let parsed: Value = serde_json::from_str(body).map_err(|e| {
        let preview: String = body.chars().take(1200).collect();
        format!(
            "Invalid JSON from BeatGaler Cloud (HTTP {}): {}. Response: {}",
            status, e, preview
        )
    })?;

    if !(200..300).contains(&status) {
        let server_error = parsed.get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Server returned an error without an 'error' message.");
        return Err(format!("BeatGaler Cloud HTTP {}: {}", status, server_error));
    }

    Ok(parsed)
}


// ─────────────────────────────────────────────────────────────────────────
// Telegram Direct Prototype — Desktop data plane
//
// Large media is no longer required to cross BeatGaler Cloud's HTTP server.
// The control plane leases one Managed Bot for this app session and returns an
// ephemeral credential. A tiny persistent GramJS helper keeps that bot logged
// in and transfers MP3/WAV/PROJECT bytes Desktop <-> Telegram by MTProto.
//
// Compatibility: existing SQLite/React code continues to use
// `telegram_file_id`, but direct media uses the internal locator
// `direct:<message_id>`. No Managed Bot token is written to disk.
// ─────────────────────────────────────────────────────────────────────────

static CLOUD_AUTH_TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn cloud_auth_slot() -> &'static Mutex<Option<String>> {
    CLOUD_AUTH_TOKEN.get_or_init(|| Mutex::new(None))
}

fn cloud_auth_token() -> Option<String> {
    cloud_auth_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().cloned())
        .filter(|value| !value.trim().is_empty())
}

fn post_json_cloud_auth_timeout(url: &str, body: &Value, max_time_seconds: u64) -> Result<Value, String> {
    let token = cloud_auth_token().ok_or_else(|| "BeatGaler account session is not ready.".to_string())?;
    let args = vec![
        "-sS".to_string(),
        "--connect-timeout".to_string(),
        "2".to_string(),
        "--max-time".to_string(),
        max_time_seconds.max(1).to_string(),
        "-X".to_string(),
        "POST".to_string(),
        "-H".to_string(),
        "Content-Type: application/json".to_string(),
        "-H".to_string(),
        format!("Authorization: Bearer {}", token),
        "--data-binary".to_string(),
        body.to_string(),
        url.to_string(),
    ];
    let raw = run_curl(&args)?;
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid response from BeatGaler Cloud: {} ({})", e, raw))?;
    if let Some(error) = parsed.get("error").and_then(|value| value.as_str()) {
        return Err(error.to_string());
    }
    Ok(parsed)
}

#[tauri::command]
pub fn set_cloud_auth_token(
    token: Option<String>,
    cloud_api_base: Option<String>,
    state: tauri::State<SettingsState>,
) -> Result<(), String> {
    if let Some(base) = cloud_api_base.as_deref() {
        let normalized_base = normalize_cloud_api_base(base)?;
        let mut guard = cloud_api_base_slot().lock().map_err(|e| e.to_string())?;
        *guard = normalized_base;
    }
    let normalized = token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    // On sign-out, release the Direct session while the old BeatGaler auth
    // token is still available. The stop endpoint is authenticated.
    if normalized.is_none() {
        shutdown_direct_transport_runtime();
        let mut guard = cloud_auth_slot().lock().map_err(|e| e.to_string())?;
        *guard = None;
        return Ok(());
    }
    {
        let mut guard = cloud_auth_slot().lock().map_err(|e| e.to_string())?;
        *guard = normalized.clone();
    }

    let should_warm = state
        .settings
        .lock()
        .map(|settings| settings.telegram_cloud_connected)
        .unwrap_or(false);
    if should_warm {
        let user_id = ensure_beatgaler_user_id(&state)?;
        schedule_direct_warmup(user_id, "auth-token");
    }
    Ok(())
}

const DIRECT_JSON_PREFIX: &str = "__BEATGALER_DIRECT_JSON__";
const DIRECT_HEARTBEAT_SECONDS: u64 = 60;

struct DirectTransportRuntime {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    user_id: String,
    session_id: String,
    transport_id: String,
    generation: i64,
    credential_version: i64,
}

#[derive(Clone)]
struct DirectTransportLeaseMeta {
    user_id: String,
    session_id: String,
    generation: i64,
    credential_version: i64,
}

static DIRECT_TRANSPORT_RUNTIME: OnceLock<Mutex<Option<DirectTransportRuntime>>> = OnceLock::new();
static DIRECT_TRANSPORT_LEASE_META: OnceLock<Mutex<Option<DirectTransportLeaseMeta>>> = OnceLock::new();
static DIRECT_HEARTBEAT_STARTED: OnceLock<()> = OnceLock::new();
// Serializes Direct runtime startup. React can issue several warmup/status calls
// at once during startup; without this lock each caller could reserve the same
// lease and spawn its own helper. Only one helper may exist per desktop session.
static DIRECT_RUNTIME_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static DIRECT_WARMUP_ACTIVE: AtomicBool = AtomicBool::new(false);
static DIRECT_WARMUP_BACKOFF_UNTIL: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
const DIRECT_WARMUP_CONFIGURATION_BACKOFF_SECONDS: u64 = 60;

fn is_direct_warmup_configuration_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("required local data-plane credential")
        || normalized.contains("telegram application id")
        || normalized.contains("telegram_api_id")
        || normalized.contains("telegram_api_hash")
}

fn schedule_direct_warmup(user_id: String, trigger: &'static str) {
    let now = Instant::now();
    let backoff = DIRECT_WARMUP_BACKOFF_UNTIL.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = backoff.lock() {
        if let Some(until) = *guard {
            if until > now {
                eprintln!(
                    "[direct] WARMUP_SKIPPED trigger={} reason=configuration-backoff remaining_ms={}",
                    trigger,
                    until.saturating_duration_since(now).as_millis(),
                );
                return;
            }
            *guard = None;
        }
    }

    if DIRECT_WARMUP_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        eprintln!("[direct] WARMUP_SKIPPED trigger={} reason=already-in-flight", trigger);
        return;
    }

    std::thread::spawn(move || {
        match ensure_direct_runtime(&user_id) {
            Ok(_) => eprintln!("[direct] WARMUP_OK trigger={}", trigger),
            Err(error) => {
                if is_direct_warmup_configuration_error(&error) {
                    if let Ok(mut guard) = DIRECT_WARMUP_BACKOFF_UNTIL
                        .get_or_init(|| Mutex::new(None))
                        .lock()
                    {
                        *guard = Some(
                            Instant::now()
                                + Duration::from_secs(DIRECT_WARMUP_CONFIGURATION_BACKOFF_SECONDS),
                        );
                    }
                }
                eprintln!("[direct] WARMUP_FAILED trigger={} reason={}", trigger, error);
            }
        }
        DIRECT_WARMUP_ACTIVE.store(false, Ordering::Release);
    });
}

fn direct_runtime_slot() -> &'static Mutex<Option<DirectTransportRuntime>> {
    DIRECT_TRANSPORT_RUNTIME.get_or_init(|| Mutex::new(None))
}

fn direct_lease_meta_slot() -> &'static Mutex<Option<DirectTransportLeaseMeta>> {
    DIRECT_TRANSPORT_LEASE_META.get_or_init(|| Mutex::new(None))
}

fn publish_direct_lease_meta(runtime: &DirectTransportRuntime) {
    if let Ok(mut guard) = direct_lease_meta_slot().lock() {
        *guard = Some(DirectTransportLeaseMeta {
            user_id: runtime.user_id.clone(),
            session_id: runtime.session_id.clone(),
            generation: runtime.generation,
            credential_version: runtime.credential_version,
        });
    }
}

fn clear_direct_lease_meta(session_id: Option<&str>) {
    if let Ok(mut guard) = direct_lease_meta_slot().lock() {
        let matches = session_id
            .map(|wanted| guard.as_ref().map(|meta| meta.session_id.as_str()) == Some(wanted))
            .unwrap_or(true);
        if matches { *guard = None; }
    }
}

fn direct_transport_enabled() -> bool {
    !matches!(
        std::env::var("BEATGALER_DIRECT_TRANSPORT")
            .unwrap_or_else(|_| "true".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "0" | "false" | "off" | "no"
    )
}

fn direct_message_id(locator: &str) -> Option<i64> {
    locator.trim().strip_prefix("direct:")?.parse::<i64>().ok().filter(|v| *v > 0)
}

fn direct_node_runtime_filename() -> &'static str {
    if cfg!(target_os = "windows") { "node.exe" } else { "node" }
}

fn direct_bot_api_runtime_filename() -> &'static str {
    if cfg!(target_os = "windows") { "telegram-bot-api.exe" } else { "telegram-bot-api" }
}

fn direct_node_runtime_path() -> String {
    if let Ok(value) = std::env::var("BEATGALER_NODE_RUNTIME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() { return trimmed.to_string(); }
    }

    let filename = direct_node_runtime_filename();
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("resources").join("windows").join(filename));
        candidates.push(cwd.join("src-tauri").join("resources").join(filename));
        candidates.push(cwd.join("resources").join(filename));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(filename));
            candidates.push(dir.join("resources").join(filename));
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("Resources").join(filename));
            }
        }
    }

    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.to_string())
}

fn direct_bot_api_runtime_path() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("BEATGALER_BOT_API_RUNTIME") {
        let p = PathBuf::from(value);
        if p.is_file() { return Some(p); }
    }
    let filename = direct_bot_api_runtime_filename();
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("resources").join("windows").join(filename));
        candidates.push(cwd.join("src-tauri").join("resources").join(filename));
        candidates.push(cwd.join("resources").join(filename));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(filename));
            candidates.push(dir.join("resources").join(filename));
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("Resources").join(filename));
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn direct_runtime_watchdog_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("direct-transport").join("runtime-watchdog.cjs"));
        candidates.push(cwd.join("direct-transport").join("runtime-watchdog.cjs"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("direct-transport").join("runtime-watchdog.cjs"));
            candidates.push(dir.join("resources").join("direct-transport").join("runtime-watchdog.cjs"));
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("Resources").join("direct-transport").join("runtime-watchdog.cjs"));
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn spawn_local_bot_api_watchdog(bot_pid: u32) -> Result<Child, String> {
    let watchdog = direct_runtime_watchdog_path()
        .ok_or_else(|| "BeatGaler local data-plane watchdog is missing from this installation.".to_string())?;
    let node = direct_node_runtime_path();
    let mut command = Command::new(&node);
    command
        .arg(&watchdog)
        .arg(std::process::id().to_string())
        .arg(bot_pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map_err(|e| format!("Could not start BeatGaler local data-plane watchdog: {}", e))
}

struct LocalBotApiRuntime {
    child: Child,
    watchdog: Child,
    port: u16,
    base_url: String,
    work_dir: PathBuf,
}

static DIRECT_BOT_API_RUNTIME: OnceLock<Mutex<Option<LocalBotApiRuntime>>> = OnceLock::new();
static DIRECT_BOT_API_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static DIRECT_RUNTIME_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_direct_runtime_data_dir(path: &Path) {
    let _ = DIRECT_RUNTIME_DATA_DIR.set(path.to_path_buf());
}

fn direct_bot_api_slot() -> &'static Mutex<Option<LocalBotApiRuntime>> {
    DIRECT_BOT_API_RUNTIME.get_or_init(|| Mutex::new(None))
}

fn direct_diagnostics_dir() -> PathBuf {
    let dir = DIRECT_RUNTIME_DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| beatgaler_temp_dir())
        .join("diagnostics");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn direct_bot_api_diag(event: &str, fields: &str) {
    let path = direct_diagnostics_dir().join("local-data-plane.log");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {} {}", ts, event, fields);
    }
}

fn local_bot_api_reachable(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port).parse().expect("valid loopback address");
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn reserve_local_bot_api_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Could not reserve a local BeatGaler data-plane port: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

fn owned_local_bot_api_is_healthy() -> bool {
    let Ok(mut guard) = direct_bot_api_slot().lock() else { return false; };
    let Some(runtime) = guard.as_mut() else { return false; };
    matches!(runtime.child.try_wait(), Ok(None)) && local_bot_api_reachable(runtime.port)
}

fn stop_local_bot_api_runtime() {
    if let Ok(mut guard) = direct_bot_api_slot().lock() {
        if let Some(mut runtime) = guard.take() {
            let pid = runtime.child.id();
            let watchdog_pid = runtime.watchdog.id();
            let _ = runtime.child.kill();
            let status = runtime.child.wait().ok();
            let _ = runtime.watchdog.kill();
            let _ = runtime.watchdog.wait();
            let _ = std::fs::remove_dir_all(&runtime.work_dir);
            direct_bot_api_diag(
                "BOT_API_STOP",
                &format!("pid={} watchdog_pid={} port={} status={:?}", pid, watchdog_pid, runtime.port, status),
            );
            eprintln!("[direct] LOCAL_BOT_API_STOPPED pid={} port={}", pid, runtime.port);
        }
    }
}

fn ensure_local_bot_api(session: &Value) -> Result<String, String> {
    let lock = DIRECT_BOT_API_START_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|e| e.to_string())?;

    // Reuse only the exact child process owned by this BeatGaler process. An
    // arbitrary listener on localhost can never satisfy this readiness check.
    if let Ok(mut slot) = direct_bot_api_slot().lock() {
        if let Some(runtime) = slot.as_mut() {
            match runtime.child.try_wait().map_err(|e| e.to_string())? {
                None if local_bot_api_reachable(runtime.port) => return Ok(runtime.base_url.clone()),
                Some(status) => {
                    let _ = runtime.watchdog.kill();
                    let _ = runtime.watchdog.wait();
                    direct_bot_api_diag(
                        "BOT_API_EXIT",
                        &format!("pid={} port={} status={}", runtime.child.id(), runtime.port, status),
                    );
                    let _ = std::fs::remove_dir_all(&runtime.work_dir);
                    *slot = None;
                }
                None => {
                    let pid = runtime.child.id();
                    let port = runtime.port;
                    let _ = runtime.child.kill();
                    let _ = runtime.child.wait();
                    let _ = runtime.watchdog.kill();
                    let _ = runtime.watchdog.wait();
                    direct_bot_api_diag("BOT_API_UNREADY", &format!("pid={} port={}", pid, port));
                    let _ = std::fs::remove_dir_all(&runtime.work_dir);
                    *slot = None;
                }
            }
        }
    }

    let api_id = session.get("telegram_api_id").and_then(|v| v.as_i64())
        .filter(|v| *v > 0)
        .ok_or_else(|| "Galer Cloud did not provide a required local data-plane credential.".to_string())?;
    let api_hash = session.get("telegram_api_hash").and_then(|v| v.as_str())
        .map(str::trim).filter(|v| !v.is_empty())
        .ok_or_else(|| "Galer Cloud did not provide a required local data-plane credential.".to_string())?;
    let binary = direct_bot_api_runtime_path()
        .ok_or_else(|| "BeatGaler local data-plane runtime is missing from this installation.".to_string())?;
    // A PID can eventually be reused after a Force Quit. Give every local
    // runtime a unique directory so a new app instance can never inherit stale
    // local data-plane state from an older process with the same PID.
    let work_dir = beatgaler_temp_dir().join(format!(
        "direct-bot-api-{}-{}",
        std::process::id(),
        random_urlsafe(8)
    ));
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Could not prepare BeatGaler local data-plane directory: {}", e))?;

    let log_path = direct_diagnostics_dir().join("local-data-plane-process.log");
    let overall_started = Instant::now();
    let mut last_error = String::new();

    for _attempt in 0..3 {
        let port = reserve_local_bot_api_port()?;
        let base_url = format!("http://127.0.0.1:{}", port);
        let stdout_file = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)
            .map_err(|e| format!("Could not open BeatGaler diagnostics log: {}", e))?;
        let stderr_file = stdout_file.try_clone()
            .map_err(|e| format!("Could not prepare BeatGaler diagnostics log: {}", e))?;

        let mut command = Command::new(&binary);
        command
            .arg("--local")
            .arg(format!("--api-id={}", api_id))
            .arg(format!("--api-hash={}", api_hash))
            .arg("--http-ip-address=127.0.0.1")
            .arg(format!("--http-port={}", port))
            .arg(format!("--dir={}", work_dir.to_string_lossy()))
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout_file))
            .stderr(Stdio::from(stderr_file));
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn()
            .map_err(|e| format!("Could not start BeatGaler local data plane '{}': {}", binary.display(), e))?;
        let pid = child.id();
        let mut watchdog = match spawn_local_bot_api_watchdog(pid) {
            Ok(child) => child,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let watchdog_pid = watchdog.id();
        direct_bot_api_diag(
            "BOT_API_START",
            &format!(
                "path={} pid={} watchdog_pid={} port={} os={} arch={} log={}",
                binary.display(), pid, watchdog_pid, port, std::env::consts::OS, std::env::consts::ARCH, log_path.display()
            ),
        );

        loop {
            if local_bot_api_reachable(port) {
                direct_bot_api_diag("BOT_API_READY", &format!("pid={} port={}", pid, port));
                eprintln!("[direct] LOCAL_BOT_API_READY pid={} address=127.0.0.1:{}", pid, port);
                let mut slot = direct_bot_api_slot().lock().map_err(|e| e.to_string())?;
                *slot = Some(LocalBotApiRuntime { child, watchdog, port, base_url: base_url.clone(), work_dir: work_dir.clone() });
                return Ok(base_url);
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                let _ = watchdog.kill();
                let _ = watchdog.wait();
                last_error = format!("BeatGaler local data plane exited during startup ({}).", status);
                direct_bot_api_diag("BOT_API_EXIT", &format!("pid={} port={} status={}", pid, port, status));
                break;
            }
            if overall_started.elapsed() >= Duration::from_secs(20) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = watchdog.kill();
                let _ = watchdog.wait();
                last_error = "BeatGaler local data plane did not become ready before the startup deadline.".to_string();
                direct_bot_api_diag("BOT_API_TIMEOUT", &format!("pid={} port={}", pid, port));
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if overall_started.elapsed() >= Duration::from_secs(20) { break; }
    }

    let error = if last_error.is_empty() {
        format!("BeatGaler local data plane could not start. See {}.", log_path.display())
    } else {
        format!("{} See {}.", last_error, log_path.display())
    };
    let _ = std::fs::remove_dir_all(&work_dir);
    Err(error)
}

fn direct_helper_path() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("BEATGALER_DIRECT_HELPER") {
        let p = PathBuf::from(value);
        if p.is_file() { return Some(p); }
    }
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("direct-transport").join("transport-helper.cjs"));
        candidates.push(cwd.join("direct-transport").join("transport-helper.cjs"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("direct-transport").join("transport-helper.cjs"));
            candidates.push(dir.join("resources").join("direct-transport").join("transport-helper.cjs"));
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("Resources").join("direct-transport").join("transport-helper.cjs"));
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn direct_stop_server_session(user_id: &str, session_id: &str, generation: i64) {
    let url = format!("{}/transport/session/stop", telegram_cloud_api_base());
    let body = json!({
        "beatgalerUserId": user_id,
        "sessionId": session_id,
        "generation": generation,
    });
    eprintln!("[direct] SESSION_STOP_REQUEST session={}", session_id);
    match post_json_cloud_auth_timeout(&url, &body, 8) {
        Ok(response) => eprintln!(
            "[direct] SESSION_STOP_OK session={} released={}",
            session_id,
            response.get("released").and_then(|v| v.as_bool()).unwrap_or(false)
        ),
        Err(error) => eprintln!("[direct] SESSION_STOP_FAILED session={} reason={}", session_id, error),
    }
}

fn direct_activate_server_session(user_id: &str, session_id: &str, generation: i64) -> Result<(), String> {
    let url = format!("{}/transport/session/activate", telegram_cloud_api_base());
    let body = json!({
        "beatgalerUserId": user_id,
        "sessionId": session_id,
        "generation": generation,
    });
    let response = post_json_cloud_auth_timeout(&url, &body, 15)?;
    if response.get("activated").and_then(|v| v.as_bool()) != Some(true) {
        return Err("Galer Cloud could not activate the assigned storage session.".to_string());
    }
    Ok(())
}

fn direct_read_helper_message(runtime: &mut DirectTransportRuntime, expected_request_id: Option<&str>) -> Result<Value, String> {
    loop {
        let mut line = String::new();
        let read = runtime.stdout.read_line(&mut line)
            .map_err(|e| format!("Direct transport helper output failed: {}", e))?;
        if read == 0 {
            let status = runtime.child.try_wait().ok().flatten();
            return Err(format!(
                "Direct transport helper exited unexpectedly{}.",
                status.map(|s| format!(" ({})", s)).unwrap_or_default()
            ));
        }
        let Some(raw) = line.trim().strip_prefix(DIRECT_JSON_PREFIX) else { continue; };
        let value: Value = serde_json::from_str(raw)
            .map_err(|e| format!("Direct transport helper returned invalid JSON: {}", e))?;
        if let Some(expected) = expected_request_id {
            let got = value.get("request_id").and_then(|v| v.as_str()).unwrap_or("");
            if got != expected { continue; }
        }
        if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            return Err(value.get("error").and_then(|v| v.as_str()).unwrap_or("Direct transport failed.").to_string());
        }
        return Ok(value);
    }
}

fn direct_send_helper_command(runtime: &mut DirectTransportRuntime, mut command: Value) -> Result<Value, String> {
    let request_id = random_urlsafe(12);
    if let Some(obj) = command.as_object_mut() {
        obj.insert("request_id".to_string(), Value::String(request_id.clone()));
    }
    let mut encoded = serde_json::to_string(&command).map_err(|e| e.to_string())?;
    encoded.push('\n');
    runtime.stdin.write_all(encoded.as_bytes())
        .map_err(|e| format!("Direct transport helper command failed: {}", e))?;
    runtime.stdin.flush().map_err(|e| format!("Direct transport helper flush failed: {}", e))?;
    direct_read_helper_message(runtime, Some(&request_id))
}

fn spawn_direct_helper(user_id: &str, session: &Value) -> Result<DirectTransportRuntime, String> {
    // The Bot API server MUST run on the same machine as the file paths used by
    // this helper. BeatGaler owns the exact child and passes its dynamic loopback
    // endpoint explicitly; the helper never guesses or trusts a fixed port.
    let bot_api_base = ensure_local_bot_api(session)?;
    let helper = direct_helper_path().ok_or_else(|| {
        "Direct transport helper is missing. Expected src-tauri/direct-transport/transport-helper.cjs.".to_string()
    })?;
    let node = direct_node_runtime_path();
    let session_id = session.get("session_id").and_then(|v| v.as_str())
        .ok_or_else(|| "Galer Cloud returned incomplete session information.".to_string())?.to_string();
    let transport_id = session.get("transport_id").and_then(|v| v.as_str()).unwrap_or("transport").to_string();
    let generation = session.get("generation").and_then(|v| v.as_i64()).unwrap_or(0);
    let credential_version = session.get("credential_version").and_then(|v| v.as_i64()).unwrap_or(1);
    let mut helper_session = session.clone();
    if let Some(object) = helper_session.as_object_mut() {
        object.insert("bot_api_base".to_string(), Value::String(bot_api_base));
    }
    let payload = general_purpose::STANDARD.encode(
        serde_json::to_vec(&helper_session).map_err(|e| format!("Could not encode direct session: {}", e))?
    );

    let mut command = Command::new(&node);
    command.arg(&helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()
        .map_err(|e| format!("Could not start Direct transport runtime '{}': {}", node, e))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "Galer Storage local helper could not start correctly.".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Galer Storage local helper could not start correctly.".to_string())?;
    let bootstrap = format!("__BEATGALER_DIRECT_BOOTSTRAP__{}\n", payload);
    stdin.write_all(bootstrap.as_bytes())
        .map_err(|e| format!("Could not bootstrap Direct transport helper: {}", e))?;
    stdin.flush().map_err(|e| format!("Could not flush Direct transport bootstrap: {}", e))?;
    let mut runtime = DirectTransportRuntime {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        user_id: user_id.to_string(),
        session_id,
        transport_id,
        generation,
        credential_version,
    };

    // Two-phase activation with NO visible Telegram handshake message.
    // The helper is an HTTP client for the Bot API server on localhost. It
    // becomes "listening", MASTER adds/promotes the transport bot, and only
    // then the helper verifies getMe/getChat and loads the pinned INDEX.
    let listening = direct_read_helper_message(&mut runtime, None)?;
    if listening.get("op").and_then(|v| v.as_str()) != Some("listening") {
        let _ = runtime.child.kill();
        return Err("Galer Storage local helper did not start.".to_string());
    }
    if let Err(error) = direct_activate_server_session(user_id, &runtime.session_id, runtime.generation) {
        let _ = runtime.child.kill();
        let _ = runtime.child.wait();
        return Err(error);
    }

    // MASTER has now added/promoted and confirmed the assigned bot. Only now
    // allow the local Bot API helper to call getChat. This explicit barrier
    // prevents a fast helper from racing Telegram membership propagation.
    let activation = serde_json::to_string(&json!({ "op": "activate_ready" }))
        .map_err(|e| e.to_string())? + "\n";
    runtime.stdin.write_all(activation.as_bytes())
        .map_err(|e| format!("Could not release Direct helper activation barrier: {}", e))?;
    runtime.stdin.flush()
        .map_err(|e| format!("Could not flush Direct helper activation barrier: {}", e))?;

    let ready = direct_read_helper_message(&mut runtime, None)?;
    if ready.get("op").and_then(|v| v.as_str()) != Some("ready") {
        let _ = runtime.child.kill();
        return Err("Galer Storage local helper did not become ready.".to_string());
    }
    eprintln!(
        "[direct] DATA_PLANE_READY transport={} generation={} credential_version={}",
        runtime.transport_id, runtime.generation, runtime.credential_version
    );
    Ok(runtime)
}

fn kill_direct_runtime_without_releasing(mut runtime: DirectTransportRuntime) {
    let _ = direct_send_helper_command(&mut runtime, json!({ "op": "shutdown" }));
    let _ = runtime.child.kill();
    let _ = runtime.child.wait();
}

fn replace_direct_runtime_from_session(user_id: &str, session: &Value) -> Result<(), String> {
    let slot = direct_runtime_slot();
    let old = {
        let mut guard = slot.lock().map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(runtime) = old {
        kill_direct_runtime_without_releasing(runtime);
    }
    let runtime = spawn_direct_helper(user_id, session)?;
    publish_direct_lease_meta(&runtime);
    let mut guard = slot.lock().map_err(|e| e.to_string())?;
    *guard = Some(runtime);
    Ok(())
}

fn start_direct_heartbeat_thread() {
    DIRECT_HEARTBEAT_STARTED.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(DIRECT_HEARTBEAT_SECONDS));

            // Heartbeat metadata lives in a separate tiny lock. Upload/download
            // commands intentionally hold the helper I/O lock for their whole
            // transfer, so using that lock here would suppress heartbeats during
            // a long (>5 min) operation and could expire a healthy lease.
            let snapshot = direct_lease_meta_slot()
                .lock()
                .ok()
                .and_then(|guard| guard.clone());
            let Some(meta) = snapshot else { continue; };
            let user_id = meta.user_id;
            let session_id = meta.session_id;
            let generation = meta.generation;
            let credential_version = meta.credential_version;

            let url = format!("{}/transport/session/heartbeat", telegram_cloud_api_base());
            let body = json!({
                "beatgalerUserId": user_id,
                "sessionId": session_id,
                "generation": generation,
                "credentialVersion": credential_version,
            });
            match post_json_cloud_auth_timeout(&url, &body, 8) {
                Ok(response) => {
                    if response.get("expired").and_then(|v| v.as_bool()) == Some(true) {
                        clear_direct_lease_meta(Some(&session_id));
                        let expired = direct_runtime_slot().lock().ok().and_then(|mut guard| {
                            if guard.as_ref().map(|r| r.session_id.as_str()) == Some(session_id.as_str()) {
                                guard.take()
                            } else { None }
                        });
                        if let Some(runtime) = expired { kill_direct_runtime_without_releasing(runtime); }
                        eprintln!("[direct] HEARTBEAT_SESSION_EXPIRED session={}", session_id);
                        continue;
                    }
                    if let Some(refresh) = response.get("credential_refresh") {
                        if let Err(error) = replace_direct_runtime_from_session(&user_id, refresh) {
                            eprintln!("[direct] HEARTBEAT_REFRESH_FAILED reason={}", error);
                        } else {
                            eprintln!("[direct] HEARTBEAT_CREDENTIAL_REFRESHED");
                        }
                    }
                }
                Err(error) => {
                    // The server owns the 5-minute timeout. A short network outage
                    // must not destroy a healthy local Telegram operation.
                    eprintln!("[direct] HEARTBEAT_MISSED reason={}", error);
                }
            }
        });
    });
}

fn ensure_direct_runtime(user_id: &str) -> Result<bool, String> {
    if !direct_transport_enabled() {
        return Err("Galer local storage transport is unavailable.".to_string());
    }
    start_direct_heartbeat_thread();

    // Singleflight: startup/warmup can be requested concurrently by several
    // frontend paths. Hold a dedicated startup lock until the helper is ready,
    // then every waiting caller re-checks and reuses that same runtime.
    let start_lock = DIRECT_RUNTIME_START_LOCK.get_or_init(|| Mutex::new(()));
    let _startup_guard = start_lock.lock().map_err(|e| e.to_string())?;

    let runtime_state = {
        let slot = direct_runtime_slot();
        let mut guard = slot.lock().map_err(|e| e.to_string())?;
        if let Some(runtime) = guard.as_mut() {
            let exit_status = runtime.child.try_wait().map_err(|e| e.to_string())?;
            Some((runtime.user_id == user_id, exit_status))
        } else { None }
    };
    // A healthy helper is not enough: the localhost server it talks to is a
    // separate owned child. If that Bot API process crashed while Node stayed
    // alive, reusing the helper would make every future operation fail forever.
    // Rebuild both local pieces through the SAME server-side lease instead.
    let same_user_helper_alive = matches!(runtime_state, Some((true, None)));
    if same_user_helper_alive && owned_local_bot_api_is_healthy() { return Ok(true); }
    if same_user_helper_alive {
        eprintln!("[direct] LOCAL_DATA_PLANE_UNHEALTHY helper_alive=true bot_api_healthy=false; rebuilding_same_lease=true");
    }

    let old = {
        let mut guard = direct_runtime_slot().lock().map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(mut runtime) = old {
        let same_user = runtime.user_id == user_id;
        let user = runtime.user_id.clone();
        let session = runtime.session_id.clone();
        let generation = runtime.generation;
        let exit_status = runtime.child.try_wait().ok().flatten();
        clear_direct_lease_meta(Some(&session));
        if let Some(status) = exit_status {
            eprintln!(
                "[direct] HELPER_EXITED session={} transport={} status={} reconnecting_same_lease={}",
                session, runtime.transport_id, status, same_user
            );
        }
        kill_direct_runtime_without_releasing(runtime);

        // A helper-process crash is not a BeatGaler logout. Keep the server-side
        // lease alive for the same installation and let /session/start return the
        // existing lease/token. This prevents a macOS helper failure from cycling
        // Bot01 -> Bot02 -> Bot03 and preserves the session-token lifetime rule.
        // Only release here when the runtime belongs to a different BeatGaler user.
        if !same_user {
            direct_stop_server_session(&user, &session, generation);
        }
    }

    let url = format!("{}/transport/session/start", telegram_cloud_api_base());
    let body = json!({ "beatgalerUserId": user_id });
    let response = post_json_cloud_auth_timeout(&url, &body, 45)
        .map_err(|error| format!("BeatGaler Direct control plane unavailable: {}", error))?;
    if response.get("mode").and_then(|v| v.as_str()) != Some("telegram-direct-botapi-local") {
        return Err("Galer Cloud did not offer the required local storage transport.".to_string());
    }

    let session_id = response.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let generation = response.get("generation").and_then(|v| v.as_i64()).unwrap_or(0);
    match spawn_direct_helper(user_id, &response) {
        Ok(runtime) => {
            publish_direct_lease_meta(&runtime);
            let mut guard = direct_runtime_slot().lock().map_err(|e| e.to_string())?;
            *guard = Some(runtime);
            Ok(true)
        }
        Err(error) => {
            if !session_id.is_empty() { direct_stop_server_session(user_id, &session_id, generation); }
            Err(format!("Galer Storage is unavailable: {}", error))
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum DirectBeginDisposition {
    Ready(String),
    Expired,
    Refresh(Value),
    Wait(u64),
}

fn classify_direct_begin_response(response: &Value) -> Result<DirectBeginDisposition, String> {
    if response.get("expired").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(DirectBeginDisposition::Expired);
    }
    if response.get("refresh_required").and_then(|v| v.as_bool()) == Some(true) {
        let refresh = response.get("credential_refresh")
            .cloned()
            .ok_or_else(|| "Galer Cloud returned incomplete refreshed session information.".to_string())?;
        return Ok(DirectBeginDisposition::Refresh(refresh));
    }
    if response.get("wait").and_then(|v| v.as_bool()) == Some(true) {
        let wait_ms = response.get("retry_after_ms").and_then(|v| v.as_u64()).unwrap_or(250).clamp(100, 1000);
        return Ok(DirectBeginDisposition::Wait(wait_ms));
    }
    response.get("operation_id").and_then(|v| v.as_str())
        .map(|value| DirectBeginDisposition::Ready(value.to_string()))
        .ok_or_else(|| "Galer Cloud returned incomplete operation information.".to_string())
}

fn direct_begin_operation(user_id: &str, kind: &str, scope: &Value) -> Result<String, String> {
    let started = Instant::now();
    loop {
        ensure_direct_runtime(user_id)?;
        let (session_id, generation, credential_version) = {
            let guard = direct_runtime_slot().lock().map_err(|e| e.to_string())?;
            let runtime = guard.as_ref().ok_or_else(|| "Galer Storage local runtime is unavailable.".to_string())?;
            (runtime.session_id.clone(), runtime.generation, runtime.credential_version)
        };
        let url = format!("{}/transport/operation/begin", telegram_cloud_api_base());
        let response = post_json_cloud_auth_timeout(&url, &json!({
            "beatgalerUserId": user_id,
            "sessionId": session_id,
            "generation": generation,
            "credentialVersion": credential_version,
            "kind": kind,
            "scope": scope,
        }), 10)?;

        match classify_direct_begin_response(&response)? {
            DirectBeginDisposition::Expired => {
                // A Mac can wake after the 5-minute lease timeout. Discard only
                // the stale local helper and loop through session/start again.
                // Never turn wake-up into an account logout or explicit token rotation.
                clear_direct_lease_meta(Some(&session_id));
                let expired = direct_runtime_slot().lock().ok().and_then(|mut guard| guard.take());
                if let Some(runtime) = expired { kill_direct_runtime_without_releasing(runtime); }
                if started.elapsed() > Duration::from_secs(45) {
                    return Err("Galer Cloud session expired and could not be renewed.".to_string());
                }
                continue;
            }
            DirectBeginDisposition::Refresh(refresh) => {
                replace_direct_runtime_from_session(user_id, &refresh)?;
                continue;
            }
            DirectBeginDisposition::Wait(wait_ms) => {
                if started.elapsed() > Duration::from_secs(120) {
                    return Err("Galer Cloud is still waiting for another active transfer to finish.".to_string());
                }
                std::thread::sleep(Duration::from_millis(wait_ms));
                continue;
            }
            DirectBeginDisposition::Ready(operation_id) => return Ok(operation_id),
        }
    }
}

fn direct_end_operation(user_id: &str, session_id: &str, generation: i64, operation_id: &str) {
    let url = format!("{}/transport/operation/end", telegram_cloud_api_base());
    let body = json!({
        "beatgalerUserId": user_id,
        "sessionId": session_id,
        "generation": generation,
        "operationId": operation_id,
    });
    for attempt in 1..=3 {
        match post_json_cloud_auth_timeout(&url, &body, 8) {
            Ok(_) => return,
            Err(error) if attempt < 3 => {
                eprintln!("[direct] OPERATION_END_RETRY operation={} attempt={} reason={}", operation_id, attempt, error);
                std::thread::sleep(Duration::from_millis(150 * attempt));
            }
            Err(error) => {
                eprintln!("[direct] OPERATION_END_DEFERRED operation={} reason={}", operation_id, error);
            }
        }
    }
}

fn direct_capability_scope(command: &Value) -> Result<Value, String> {
    let op = command.get("op").and_then(|v| v.as_str()).unwrap_or("");
    if op == "get_index" || op == "replace_index" {
        return Ok(json!({ "objectType": "index", "objectIds": ["pinned"] }));
    }
    if let Some(message_id) = command.get("message_id").and_then(|v| v.as_i64()) {
        if message_id > 0 {
            return Ok(json!({ "objectType": "message", "objectIds": [message_id.to_string()] }));
        }
    }
    if let Some(message_ids) = command.get("message_ids").and_then(|v| v.as_array()) {
        let ids: Vec<String> = message_ids.iter().filter_map(|value| value.as_i64()).filter(|value| *value > 0).map(|value| value.to_string()).collect();
        if !ids.is_empty() && ids.len() == message_ids.len() {
            return Ok(json!({ "objectType": "message", "objectIds": ids }));
        }
    }
    if op == "upload" {
        if let Some(topic_id) = command.get("reply_to").and_then(|v| v.as_i64()) {
            if topic_id > 0 {
                return Ok(json!({ "objectType": "topic", "objectIds": [topic_id.to_string()] }));
            }
        }
    }
    Err(format!("Galer Storage operation {} has no explicit capability object scope.", op))
}

fn direct_request(user_id: &str, command: Value) -> Result<Value, String> {
    let kind = command.get("op").and_then(|v| v.as_str()).unwrap_or("data").to_string();
    let scope = direct_capability_scope(&command)?;
    let operation_id = direct_begin_operation(user_id, &kind, &scope)?;
    let (session_id, generation, result) = {
        let slot = direct_runtime_slot();
        let mut guard = slot.lock().map_err(|e| e.to_string())?;
        let runtime = guard.as_mut().ok_or_else(|| "Galer Storage local runtime is unavailable.".to_string())?;
        let session_id = runtime.session_id.clone();
        let generation = runtime.generation;
        let result = direct_send_helper_command(runtime, command);
        (session_id, generation, result)
    };
    direct_end_operation(user_id, &session_id, generation, &operation_id);
    result
}


static DIRECT_LIBRARY_MANIFEST_CACHE: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);

fn cached_direct_library_manifest() -> Option<Value> {
    DIRECT_LIBRARY_MANIFEST_CACHE.lock().ok().and_then(|guard| guard.clone())
}

fn cache_direct_library_manifest(manifest: &Value) {
    if let Ok(mut guard) = DIRECT_LIBRARY_MANIFEST_CACHE.lock() {
        *guard = Some(manifest.clone());
    }
}

fn direct_get_library_manifest(user_id: &str) -> Result<Value, String> {
    // INDEX reads are on the critical path for refresh/import/metadata. A
    // transient helper/control-plane miss must not become an Upload Failed.
    let started = std::time::Instant::now();
    let op = random_urlsafe(6);
    let mut attempt: u32 = 0;
    let mut last_error = "Galer Library INDEX is temporarily unavailable.".to_string();
    eprintln!("[index] READ_BEGIN op={}", op);
    loop {
        attempt += 1;
        match ensure_direct_runtime(user_id)
            .and_then(|_| direct_request(user_id, json!({ "op": "get_index" })))
        {
            Ok(response) => {
                match response.get("manifest").cloned() {
                    Some(manifest) if manifest.get("schema").and_then(|v| v.as_str()) == Some(GALER_T_LIBRARY_SCHEMA) => {
                        let manifest = normalize_galer_t_library_manifest(manifest)?;
                        eprintln!(
                            "[index] READ_OK op={} attempt={} message_id={} beats={} elapsed_ms={}",
                            op,
                            attempt,
                            response.get("message_id").and_then(|v| v.as_i64()).unwrap_or(0),
                            manifest.get("beats").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
                            started.elapsed().as_millis(),
                        );
                        cache_direct_library_manifest(&manifest);
                        return Ok(manifest);
                    }
                    Some(_) => last_error = "Pinned Galer Library document is not a valid BeatGaler library index.".to_string(),
                    None => last_error = "Galer Library index response had no manifest.".to_string(),
                }
            }
            Err(error) => last_error = error,
        }

        eprintln!("[index] READ_RETRY op={} attempt={} reason={}", op, attempt, last_error);

        if attempt >= 8 || started.elapsed() >= Duration::from_secs(12) {
            eprintln!("[index] READ_FAILED op={} attempts={} elapsed_ms={} reason={}", op, attempt, started.elapsed().as_millis(), last_error);
            return Err(format!("{} (after {} attempt(s))", last_error, attempt));
        }
        let shift = attempt.saturating_sub(1).min(4);
        let wait_ms = (120_u64.saturating_mul(1_u64 << shift)).min(1200);
        std::thread::sleep(Duration::from_millis(wait_ms));
    }
}

fn direct_replace_library_manifest_with_options(
    user_id: &str,
    manifest: &Value,
    source_id: Option<&str>,
    allow_destructive: bool,
) -> Result<Value, String> {
    let op = random_urlsafe(6);
    let started = Instant::now();
    ensure_direct_runtime(user_id)?;
    if manifest.get("schema").and_then(|v| v.as_str()) != Some(GALER_T_LIBRARY_SCHEMA) {
        return Err("Refusing to publish a non-BeatGaler cloud index.".to_string());
    }
    let manifest_version = manifest.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
    if manifest_version != GALER_T_LIBRARY_SCHEMA_VERSION {
        return Err(format!(
            "Refusing to publish Galer T-Library Schema v{}; this build writes v{}.",
            manifest_version, GALER_T_LIBRARY_SCHEMA_VERSION
        ));
    }
    let expected_beats = manifest.get("beats").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0);
    let expected_projects: std::collections::HashSet<String> = manifest.get("beats")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("project").map(|project| !project.is_null()).unwrap_or(false))
        .filter_map(|entry| entry.get("id").and_then(|v| v.as_str()).map(|v| v.to_string()))
        .collect();
    let identity_ids = |value: &Value| -> std::collections::HashSet<String> {
        let mut out = std::collections::HashSet::new();
        if let Some(rows) = value.get("beats").and_then(|v| v.as_array()) {
            for row in rows {
                if let Some(id) = row.get("id").and_then(|v| v.as_str()).filter(|id| !id.is_empty()) {
                    out.insert(id.to_string());
                }
            }
        }
        if let Some(rows) = value.get("trash").and_then(|v| v.as_array()) {
            for row in rows {
                let beat = row.get("beat").unwrap_or(row);
                if let Some(id) = beat.get("id").and_then(|v| v.as_str()).filter(|id| !id.is_empty()) {
                    out.insert(id.to_string());
                }
            }
        }
        out
    };
    let expected_ids = identity_ids(manifest);
    eprintln!(
        "[index] WRITE_BEGIN op={} beats={} identities={} projects={} destructive={}",
        op,
        expected_beats,
        expected_ids.len(),
        expected_projects.len(),
        allow_destructive,
    );
    let temp_dir = beatgaler_temp_dir().join("cloud-upload-tmp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_path = temp_dir.join(format!("beatgaler-library-{}.json", random_urlsafe(8)));
    std::fs::write(
        &temp_path,
        serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?,
    ).map_err(|e| e.to_string())?;

    let result = direct_request(user_id, json!({
        "op": "replace_index",
        "path": temp_path.to_string_lossy().to_string(),
        "allow_destructive": allow_destructive,
    }));
    let _ = std::fs::remove_file(&temp_path);
    let response = result?;
    let message_id = response.get("message_id").and_then(|v| v.as_i64()).unwrap_or(0);
    if message_id <= 0 {
        eprintln!("[index] WRITE_FAILED op={} stage=helper-response reason=missing-message-id", op);
        return Err("Galer Library index sync returned no storage message id.".to_string());
    }
    let index_file_id = response.get("file_id").and_then(|v| v.as_str()).unwrap_or("");

    // Read-after-write verification closes the exact hole where media upload
    // succeeds but the new PROJECT/artwork reference never becomes durable in
    // the pinned source-of-truth INDEX. Telegram pin visibility can be briefly
    // eventual, so retry before reporting a precise commit failure.
    let mut verified_manifest: Option<Value> = None;
    let mut verify_error = "Pinned INDEX could not be read back.".to_string();
    for attempt in 1..=4 {
        match direct_request(user_id, json!({ "op": "get_index" })) {
            Ok(readback) => {
                let readback_message_id = readback.get("message_id").and_then(|v| v.as_i64()).unwrap_or(0);
                let candidate = readback.get("manifest").cloned().unwrap_or(Value::Null);
                let readback_ids = identity_ids(&candidate);
                let missing_ids = expected_ids.iter().filter(|id| !readback_ids.contains(*id)).count();
                let missing_projects = expected_projects.iter().filter(|id| {
                    !candidate.get("beats").and_then(|v| v.as_array()).into_iter().flatten().any(|entry| {
                        entry.get("id").and_then(|v| v.as_str()) == Some(id.as_str())
                            && entry.get("project").map(|project| !project.is_null()).unwrap_or(false)
                    })
                }).count();
                if readback_message_id == message_id && missing_ids == 0 && missing_projects == 0 {
                    verified_manifest = Some(normalize_galer_t_library_manifest(candidate)?);
                    eprintln!(
                        "[index] VERIFY_OK op={} attempt={} message_id={} identities={} projects={} elapsed_ms={}",
                        op,
                        attempt,
                        message_id,
                        readback_ids.len(),
                        expected_projects.len(),
                        started.elapsed().as_millis(),
                    );
                    break;
                }
                verify_error = format!(
                    "Pinned INDEX verification mismatch (message {} expected {}, missing identities {}, missing projects {}).",
                    readback_message_id, message_id, missing_ids, missing_projects
                );
            }
            Err(error) => verify_error = error,
        }
        eprintln!("[index] VERIFY_RETRY op={} attempt={} reason={}", op, attempt, verify_error);
        std::thread::sleep(Duration::from_millis(150 * attempt));
    }
    let verified_manifest = verified_manifest.ok_or_else(|| {
        eprintln!("[index] WRITE_FAILED op={} stage=read-after-write reason={}", op, verify_error);
        format!("INDEX was uploaded but could not be verified as active: {}", verify_error)
    })?;
    cache_direct_library_manifest(&verified_manifest);

    // Tiny control-plane pointer only. The INDEX bytes themselves traveled
    // Desktop -> local Bot API -> Telegram and never traversed BeatGaler Cloud.
    let commit_url = format!("{}/transport/index/commit", telegram_cloud_api_base());
    let pointer_body = json!({
        "beatgalerUserId": user_id,
        "messageId": message_id,
        "fileId": index_file_id,
        "sourceId": source_id.unwrap_or_default(),
        "beatCount": manifest.get("beats").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
    });
    let mut pointer_committed = false;
    for attempt in 1..=3 {
        match post_json_cloud_auth_timeout(&commit_url, &pointer_body, 8) {
            Ok(_) => {
                pointer_committed = true;
                eprintln!("[index] POINTER_OK op={} attempt={} message_id={}", op, attempt, message_id);
                break;
            }
            Err(error) => {
                eprintln!("[index] POINTER_RETRY op={} attempt={} reason={}", op, attempt, error);
                if attempt < 3 { std::thread::sleep(Duration::from_millis(150 * attempt)); }
            }
        }
    }
    if !pointer_committed {
        // The pinned Telegram document is authoritative and already verified.
        // This pointer is recovery/diagnostic metadata only, so keep the commit
        // successful but make the degraded control-plane state unmistakable.
        eprintln!("[index] POINTER_DEFERRED op={} message_id={} authoritative_pin_verified=true", op, message_id);
    }
    eprintln!(
        "[index] WRITE_OK op={} message_id={} beats={} projects={} elapsed_ms={}",
        op,
        message_id,
        expected_beats,
        expected_projects.len(),
        started.elapsed().as_millis(),
    );
    Ok(response)
}

fn direct_replace_library_manifest(
    user_id: &str,
    manifest: &Value,
    source_id: Option<&str>,
) -> Result<Value, String> {
    direct_replace_library_manifest_with_options(user_id, manifest, source_id, false)
}

fn apply_restore_from_trash_to_manifest(manifest: &mut Value, beat_id: &str) -> Result<bool, String> {
    if beat_id.trim().is_empty() { return Err("Cannot restore an empty beat id.".to_string()); }
    let root = manifest.as_object_mut().ok_or_else(|| "Galer Library index root is invalid.".to_string())?;

    let existing_active = root.get("beats")
        .and_then(|v| v.as_array())
        .and_then(|rows| rows.iter().find(|row| row.get("id").and_then(|v| v.as_str()) == Some(beat_id)))
        .cloned();

    let restored_entry = root.get("trash")
        .and_then(|v| v.as_array())
        .and_then(|rows| rows.iter().find_map(|item| {
            let beat = item.get("beat").unwrap_or(item);
            (beat.get("id").and_then(|v| v.as_str()) == Some(beat_id)).then(|| beat.clone())
        }));
    let had_trash_entry = restored_entry.is_some();

    if restored_entry.is_none() && existing_active.is_none() {
        return Err("The beat is no longer present in Cloud Trash.".to_string());
    }

    // Remove every stale Trash copy for this identity. A previous interrupted
    // restore may have left both active + trash entries; healing that state is
    // intentionally idempotent and never creates a second active beat.
    let removed_trash = {
        let trash = root.entry("trash").or_insert_with(|| Value::Array(Vec::new()));
        let rows = trash.as_array_mut().ok_or_else(|| "Galer Library trash field is invalid.".to_string())?;
        let before = rows.len();
        rows.retain(|item| {
            let beat = item.get("beat").unwrap_or(item);
            beat.get("id").and_then(|v| v.as_str()) != Some(beat_id)
        });
        before != rows.len()
    };

    let beats = root.entry("beats").or_insert_with(|| Value::Array(Vec::new()));
    let rows = beats.as_array_mut().ok_or_else(|| "Galer Library beats field is invalid.".to_string())?;
    if existing_active.is_none() {
        let entry = restored_entry.ok_or_else(|| "Cloud Trash record has no beat payload.".to_string())?;
        // Defensive dedupe in case a malformed INDEX already contains repeated ids.
        rows.retain(|row| row.get("id").and_then(|v| v.as_str()) != Some(beat_id));
        rows.push(entry);
    } else {
        // Heal malformed duplicate active rows while preserving the first
        // authoritative active copy.
        let mut kept = false;
        rows.retain(|row| {
            if row.get("id").and_then(|v| v.as_str()) != Some(beat_id) { return true; }
            if kept { false } else { kept = true; true }
        });
    }

    if removed_trash || had_trash_entry {
        root.insert("updated_at".to_string(), json!(now_epoch()));
        return Ok(true);
    }
    Ok(false)
}

fn direct_restore_beat_from_trash(user_id: &str, beat_id: &str) -> Result<(), String> {
    let mut manifest = direct_get_library_manifest(user_id)?;
    let changed = apply_restore_from_trash_to_manifest(&mut manifest, beat_id)?;
    if changed {
        direct_replace_library_manifest(user_id, &manifest, Some("trash-restore"))?;
    }
    Ok(())
}

fn direct_move_beats_to_trash(user_id: &str, beat_ids: &[String]) -> Result<usize, String> {
    if beat_ids.is_empty() { return Ok(0); }
    let mut manifest = direct_get_library_manifest(user_id)?;
    let now = now_epoch() as i64;
    let wanted: std::collections::HashSet<String> = beat_ids.iter().cloned().collect();

    let root = manifest.as_object_mut().ok_or_else(|| "Galer Library index root is invalid.".to_string())?;
    let beats = root.entry("beats").or_insert_with(|| Value::Array(Vec::new()));
    let beats_array = beats.as_array_mut().ok_or_else(|| "Galer Library beats field is invalid.".to_string())?;
    let mut moved_entries = Vec::<Value>::new();
    beats_array.retain(|beat| {
        let id = beat.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if wanted.contains(id) {
            moved_entries.push(beat.clone());
            false
        } else {
            true
        }
    });

    if moved_entries.is_empty() { return Ok(0); }
    let trash = root.entry("trash").or_insert_with(|| Value::Array(Vec::new()));
    let trash_array = trash.as_array_mut().ok_or_else(|| "Galer Library trash field is invalid.".to_string())?;
    let already: std::collections::HashSet<String> = trash_array.iter()
        .filter_map(|item| item.get("beat"))
        .filter_map(|beat| beat.get("id").and_then(|v| v.as_str()))
        .map(|v| v.to_string())
        .collect();
    let mut moved = 0usize;
    for beat in moved_entries {
        let beat_id = beat.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if beat_id.is_empty() || already.contains(&beat_id) { continue; }
        trash_array.insert(0, json!({
            "trash_id": format!("cloud-trash:{}:{}", beat_id, random_urlsafe(6)),
            "trashed_at": now,
            "purge_after": now.saturating_add(14 * 86400),
            "beat": beat,
        }));
        moved += 1;
    }
    if moved == 0 { return Ok(0); }
    root.insert("updated_at".to_string(), json!(now_epoch()));
    direct_replace_library_manifest(user_id, &manifest, None)?;
    Ok(moved)
}

fn collect_manifest_media_message_ids(entry: &Value, out: &mut std::collections::HashSet<i64>) {
    let mut add = |value: Option<i64>| { if let Some(id) = value { if id > 0 { out.insert(id); } } };
    add(entry.get("telegram_message_id").and_then(|v| v.as_i64()));
    add(entry.get("master").and_then(|v| v.get("telegram_message_id")).and_then(|v| v.as_i64()));
    add(entry.get("artwork").and_then(|v| v.get("telegram_message_id")).and_then(|v| v.as_i64()));
    add(entry.get("metadata_message_id").and_then(|v| v.as_i64()));
    if let Some(files) = entry.get("files").and_then(|v| v.as_array()) {
        for file in files {
            add(file.get("telegram_message_id").and_then(|v| v.as_i64()));
            if let Some(parts) = file.get("parts").and_then(|v| v.as_array()) {
                for part in parts { add(part.get("telegram_message_id").and_then(|v| v.as_i64())); }
            }
            if let Some(parts) = file.get("manifest").and_then(|v| v.get("parts")).and_then(|v| v.as_array()) {
                for part in parts { add(part.get("telegram_message_id").and_then(|v| v.as_i64())); }
            }
        }
    }
    if let Some(project) = entry.get("project") {
        let project = project.get("manifest").unwrap_or(project);
        add(project.get("telegram_message_id").and_then(|v| v.as_i64()));
        if let Some(parts) = project.get("parts").and_then(|v| v.as_array()) {
            for part in parts { add(part.get("telegram_message_id").and_then(|v| v.as_i64())); }
        }
    }
}

fn apply_permanent_delete_to_manifest(
    manifest: &mut Value,
    wanted: &std::collections::HashSet<String>,
    now: i64,
) -> Result<(usize, std::collections::HashSet<i64>), String> {
    let root = manifest.as_object_mut().ok_or_else(|| "Galer Library index root is invalid.".to_string())?;
    let mut media_to_delete = std::collections::HashSet::<i64>::new();
    if let Some(beats) = root.get("beats").and_then(|v| v.as_array()) {
        for beat in beats {
            let id = beat.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if wanted.contains(id) { collect_manifest_media_message_ids(beat, &mut media_to_delete); }
        }
    }
    if let Some(trash) = root.get("trash").and_then(|v| v.as_array()) {
        for item in trash {
            let beat = item.get("beat").unwrap_or(item);
            let id = beat.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if wanted.contains(id) { collect_manifest_media_message_ids(beat, &mut media_to_delete); }
        }
    }

    let removed_beats = {
        let beats = root.entry("beats").or_insert_with(|| Value::Array(Vec::new()));
        let beats_array = beats.as_array_mut().ok_or_else(|| "Galer Library beats field is invalid.".to_string())?;
        let before = beats_array.len();
        beats_array.retain(|beat| !wanted.contains(beat.get("id").and_then(|v| v.as_str()).unwrap_or("")));
        before - beats_array.len()
    };

    let removed_trash = {
        let trash = root.entry("trash").or_insert_with(|| Value::Array(Vec::new()));
        let trash_array = trash.as_array_mut().ok_or_else(|| "Galer Library trash field is invalid.".to_string())?;
        let before = trash_array.len();
        trash_array.retain(|item| {
            let beat = item.get("beat").unwrap_or(item);
            let id = beat.get("id").and_then(|v| v.as_str()).unwrap_or("");
            !wanted.contains(id)
        });
        before - trash_array.len()
    };

    // Keep small tombstones inside the ONE index so a delayed stale client
    // cannot resurrect a permanently-deleted beat on its next sync.
    let deleted = root.entry("deleted").or_insert_with(|| Value::Array(Vec::new()));
    let deleted_array = deleted.as_array_mut().ok_or_else(|| "Galer Library deleted field is invalid.".to_string())?;
    let mut by_id = std::collections::HashMap::<String, i64>::new();
    for row in deleted_array.iter() {
        let id = row.get("beat_id").or_else(|| row.get("id")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() { continue; }
        let at = row.get("deleted_at").and_then(|v| v.as_i64()).unwrap_or(now);
        by_id.entry(id).and_modify(|old| *old = (*old).max(at)).or_insert(at);
    }
    for id in wanted {
        by_id.entry(id.clone()).and_modify(|old| *old = (*old).max(now)).or_insert(now);
    }
    let mut tombstones: Vec<Value> = by_id.into_iter()
        .map(|(id, at)| json!({ "beat_id": id, "deleted_at": at }))
        .collect();
    // Stable ordering keeps the manifest deterministic, which makes retries,
    // diagnostics and tests easier to reason about.
    tombstones.sort_by(|a, b| {
        a.get("beat_id").and_then(|v| v.as_str()).unwrap_or("")
            .cmp(b.get("beat_id").and_then(|v| v.as_str()).unwrap_or(""))
    });
    *deleted_array = tombstones;

    let removed = removed_beats + removed_trash;
    root.insert("updated_at".to_string(), json!(now as u64));
    Ok((removed, media_to_delete))
}

fn direct_permanently_delete_beats(user_id: &str, beat_ids: &[String]) -> Result<usize, String> {
    if beat_ids.is_empty() { return Ok(0); }
    let mut manifest = direct_get_library_manifest(user_id)?;
    let wanted: std::collections::HashSet<String> = beat_ids.iter().cloned().collect();
    let now = now_epoch() as i64;
    let (removed, media_to_delete) = apply_permanent_delete_to_manifest(&mut manifest, &wanted, now)?;

    // Even when the row was already absent, writing the tombstone is useful and
    // makes permanent-delete retries idempotent. This is the ONLY path allowed
    // to shrink beat identity membership. First commit the INDEX, then delete
    // media that belonged to the permanently deleted beats.
    direct_replace_library_manifest_with_options(user_id, &manifest, None, true)?;
    if !media_to_delete.is_empty() {
        let mut ids: Vec<i64> = media_to_delete.into_iter().collect();
        ids.sort_unstable();
        let _ = direct_request(user_id, json!({ "op": "delete_messages", "message_ids": ids }));
    }
    Ok(removed)
}

fn direct_ensure_topic(user_id: &str, beat_id: &str, beat_name: &str) -> Result<i64, String> {
    let url = format!("{}/transport/topic/ensure", telegram_cloud_api_base());
    let response = post_json_cloud_auth_timeout(&url, &json!({
        "beatgalerUserId": user_id,
        "beatId": beat_id,
        "beatName": beat_name,
    }), 20)?;
    response.get("message_thread_id").and_then(|v| v.as_i64())
        .ok_or_else(|| "Galer Storage returned incomplete beat storage information.".to_string())
}

fn direct_upload_file(
    user_id: &str,
    beat_id: &str,
    beat_name: &str,
    kind: &str,
    file_path: &Path,
    filename: &str,
) -> Result<Value, String> {
    ensure_direct_runtime(user_id)?;
    let topic_id = direct_ensure_topic(user_id, beat_id, beat_name)?;
    let response = direct_request(user_id, json!({
        "op": "upload",
        "path": file_path.to_string_lossy().to_string(),
        "filename": filename,
        "caption": format!("BEATGALER_MEDIA_V1 kind={} beat={}", kind, beat_id),
        "reply_to": topic_id,
        "workers": 4,
    }))?;
    let message_id = response.get("message_id").and_then(|v| v.as_i64())
        .ok_or_else(|| "Galer Storage upload returned incomplete storage information.".to_string())?;
    let locator = format!("direct:{}", message_id);
    Ok(json!({
        "telegram_file_id": locator,
        "telegram_message_id": message_id,
        "filename": filename,
        "original_size": response.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0),
        "parts": [{
            "telegram_file_id": format!("direct:{}", message_id),
            "telegram_message_id": message_id,
            "index": 0,
            "size": response.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0),
            "filename": filename,
        }],
        "transport": "direct",
    }))
}

fn direct_probe_media_message(user_id: &str, message_id: i64) -> Result<bool, String> {
    match direct_request(user_id, json!({
        "op": "probe_media",
        "message_id": message_id,
    })) {
        Ok(response) => Ok(response.get("exists").and_then(|v| v.as_bool()).unwrap_or(true)),
        Err(error) => {
            let lower = error.to_ascii_lowercase();
            // Only these Telegram responses are treated as definitive physical loss.
            // Network/control-plane/rate-limit errors must NEVER prune the INDEX.
            if lower.contains("message to forward not found")
                || lower.contains("message_id_invalid")
                || lower.contains("message id invalid")
                || lower.contains("message not found")
            {
                Ok(false)
            } else {
                Err(error)
            }
        }
    }
}

fn direct_download_file(user_id: &str, message_id: i64, destination: &Path) -> Result<u64, String> {
    let response = direct_request(user_id, json!({
        "op": "download",
        "message_id": message_id,
        "output": destination.to_string_lossy().to_string(),
    }))?;
    Ok(response.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0))
}

fn direct_download_range(
    user_id: &str,
    message_id: i64,
    start: u64,
    length: u64,
    output: &Path,
) -> Result<(u64, Option<u64>), String> {
    let response = direct_request(user_id, json!({
        "op": "download_range",
        "message_id": message_id,
        "start": start,
        "length": length,
        "output": output.to_string_lossy().to_string(),
    }))?;
    Ok((
        response.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0),
        response.get("total").and_then(|v| v.as_u64()),
    ))
}

fn direct_download_range_with_retry(
    user_id: &str,
    message_id: i64,
    start: u64,
    length: u64,
    output: &Path,
) -> Result<(u64, Option<u64>), String> {
    let mut last_error = String::new();
    for attempt in 0..3u64 {
        let _ = std::fs::remove_file(output);
        match direct_download_range(user_id, message_id, start, length, output) {
            Ok(value) => return Ok(value),
            Err(error) => {
                last_error = error;
                if attempt < 2 { std::thread::sleep(Duration::from_millis(250 * (attempt + 1))); }
            }
        }
    }
    Err(format!("Galer Storage range retry exhausted: {}", last_error))
}

pub fn shutdown_direct_transport_runtime() {
    eprintln!("[direct] APP_EXIT_RELEASE_BEGIN");
    let runtime = direct_runtime_slot().lock().ok().and_then(|mut guard| guard.take());
    if let Some(runtime) = runtime {
        let user = runtime.user_id.clone();
        let session = runtime.session_id.clone();
        clear_direct_lease_meta(Some(&session));
        let generation = runtime.generation;
        let transport = runtime.transport_id.clone();
        kill_direct_runtime_without_releasing(runtime);
        direct_stop_server_session(&user, &session, generation);
        eprintln!("[direct] DATA_PLANE_STOPPED transport={}", transport);
    }
    stop_local_bot_api_runtime();
}

/// Managed by the Tauri app so a normal process shutdown releases the leased
/// transport bot even when the user closes the window without pressing Disconnect.
pub struct DirectTransportExitGuard;

impl Drop for DirectTransportExitGuard {
    fn drop(&mut self) {
        shutdown_direct_transport_runtime();
    }
}

/// Fase 6/7: pide al backend un connect_token + deep link, y abre Telegram
/// con el navegador/app del sistema. El frontend debe llamar luego a
/// `poll_telegram_cloud_status` periódicamente hasta que `connected: true`.
#[tauri::command(async)]
pub fn connect_telegram_cloud(
    _app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
) -> Result<(), String> {
    // Telegram is infrastructure now, not an end-user login surface. The
    // BeatGaler account already binds this installation to a MASTER-owned
    // private vault, so there is no /start deep-link or manager-bot command.
    let user_id = ensure_beatgaler_user_id(&state)?;
    let base = telegram_cloud_api_base();
    let url = format!("{}/telegram/connect/status?beatgalerUserId={}", base, user_id);
    let response = get_json_simple(&url)
        .map_err(|e| format!("Could not reach BeatGaler Cloud server. Is it running? ({})", e))?;
    let connected = response.get("connected").and_then(|v| v.as_bool()).unwrap_or(false);
    let reachable = response.get("reachable").and_then(|v| v.as_bool()).unwrap_or(false);
    if !connected {
        return Err("Sign in to BeatGaler to prepare private cloud storage.".to_string());
    }
    if !reachable {
        return Err("BeatGaler Cloud storage is temporarily unreachable.".to_string());
    }
    let username = response
        .get("beatgaler_username")
        .or_else(|| response.get("telegram_username"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.telegram_cloud_connected = true;
        settings.telegram_cloud_username = username;
        save_settings_file(&state.data_dir, &*settings)?;
    }
    ensure_direct_runtime(&user_id)?;
    Ok(())
}

/// Fase 9: BeatGaler llama esto cada pocos segundos mientras espera a que
/// el usuario presione Start en Telegram. Cuando `connected: true`, el
/// resultado también se persiste en settings.json (Fase 10 — persistencia).
#[tauri::command(async)]
pub fn poll_telegram_cloud_status(
    state: tauri::State<SettingsState>,
) -> Result<TelegramCloudStatus, String> {
    let user_id = ensure_beatgaler_user_id(&state)?;
    let base = telegram_cloud_api_base();
    let url = format!("{}/telegram/connect/status?beatgalerUserId={}", base, user_id);

    let response = get_json_simple(&url)
        .map_err(|e| format!("Could not reach BeatGaler Cloud server. Is it running? ({})", e))?;

    let connected = response.get("connected").and_then(|v| v.as_bool()).unwrap_or(false);
    let reachable = response.get("reachable").and_then(|v| v.as_bool()).unwrap_or(connected);
    let username = response
        .get("telegram_username")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if connected {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.telegram_cloud_connected = true;
        settings.telegram_cloud_username = username.clone();
        save_settings_file(&state.data_dir, &*settings)?;
    }

    if connected && reachable {
        schedule_direct_warmup(user_id.clone(), "connect-status");
    }

    Ok(TelegramCloudStatus { connected, reachable, username })
}

/// Fase 10: al abrir la app, verifica el estado REAL con el backend.
/// El valor persistido en settings.json sirve como caché, pero nunca debe
/// hacer que la UI diga "Connected" si el backend ya no conoce la cuenta.
#[tauri::command(async)]
pub fn get_telegram_cloud_status(
    state: tauri::State<SettingsState>,
) -> Result<TelegramCloudStatus, String> {
    let user_id = ensure_beatgaler_user_id(&state)?;
    let base = telegram_cloud_api_base();
    let url = format!("{}/telegram/connect/status?beatgalerUserId={}", base, user_id);

    let response = get_json_simple(&url)
        .map_err(|e| format!("Could not verify Galer Cloud status. Is the BeatGaler Cloud server running? ({})", e))?;

    let connected = response.get("connected").and_then(|v| v.as_bool()).unwrap_or(false);
    let reachable = response.get("reachable").and_then(|v| v.as_bool()).unwrap_or(connected);
    let username = response
        .get("telegram_username")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Reconcile persisted linkage only when Telegram itself is reachable.
    // A disconnected network must never be interpreted as an account logout.
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    if connected {
        settings.telegram_cloud_connected = true;
        settings.telegram_cloud_username = username.clone();
        save_settings_file(&state.data_dir, &*settings)?;
    } else if reachable {
        settings.telegram_cloud_connected = false;
        settings.telegram_cloud_username = None;
        save_settings_file(&state.data_dir, &*settings)?;
    }
    drop(settings);

    if connected && reachable {
        schedule_direct_warmup(user_id.clone(), "cloud-status");
    }

    Ok(TelegramCloudStatus { connected, reachable, username })
}

/// Fase 11 (paso 12/13): desconectar. Avisa al backend y limpia el estado
/// local. No borra ningún archivo ya subido a Telegram — eso corresponde
/// a "Delete permanently" en la papelera (Fase 16), no a esto.
#[tauri::command(async)]
pub fn disconnect_telegram_cloud(
    state: tauri::State<SettingsState>,
) -> Result<(), String> {
    let user_id = ensure_beatgaler_user_id(&state)?;
    // Release the leased transport bot before unlinking the account. This keeps
    // the FIFO pool healthy and removes the bot from the user's vault promptly.
    shutdown_direct_transport_runtime();

    let base = telegram_cloud_api_base();
    let url = format!("{}/telegram/disconnect", base);
    let body = serde_json::json!({ "beatgalerUserId": user_id });

    // Best-effort: si el servidor no responde, igual limpiamos localmente
    // para que el usuario no quede atascado en "Connected".
    let _ = post_json_simple(&url, &body);

    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.telegram_cloud_connected = false;
    settings.telegram_cloud_username = None;
    save_settings_file(&state.data_dir, &*settings)?;

    Ok(())
}

/// Locate an ffmpeg executable for WAV -> MP3 MASTER conversion.
///
/// Search order:
/// 1. BEATGALER_FFMPEG explicit override (development/support)
/// 2. ffmpeg shipped next to the executable / inside macOS Resources
/// 3. system ffmpeg as a final development fallback
///
/// Production installers should ship ffmpeg with BeatGaler so users never
/// need to install an encoder themselves.
fn beatgaler_ffmpeg_program() -> Result<PathBuf, String> {
    let exe_name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(custom) = std::env::var("BEATGALER_FFMPEG") {
        if !custom.trim().is_empty() {
            candidates.push(PathBuf::from(custom));
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join(exe_name));
            candidates.push(exe_dir.join("bin").join(exe_name));
            candidates.push(exe_dir.join("resources").join(exe_name));

            // macOS: MyApp.app/Contents/MacOS/app -> Contents/Resources/ffmpeg
            if cfg!(target_os = "macos") {
                if let Some(contents) = exe_dir.parent() {
                    candidates.push(contents.join("Resources").join(exe_name));
                    candidates.push(contents.join("Resources").join("bin").join(exe_name));
                }
            }
        }
    }

    // Development fallback. This is intentionally LAST.
    candidates.push(PathBuf::from(exe_name));

    let mut attempted = Vec::new();
    for candidate in candidates {
        let label = candidate.to_string_lossy().to_string();
        if attempted.iter().any(|v: &String| v == &label) {
            continue;
        }
        attempted.push(label.clone());

        match Command::new(&candidate).arg("-version").output() {
            Ok(out) if out.status.success() => return Ok(candidate),
            _ => {}
        }
    }

    Err(format!(
        "MP3 encoder unavailable. BeatGaler could not find its bundled ffmpeg. Attempted: {}. \
The production app must ship ffmpeg; users should not have to install it manually.",
        attempted.join(", ")
    ))
}

fn convert_wav_to_cloud_master_mp3(
    beat: &BeatMeta,
    wav_path: &Path,
) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(wav_path)
        .map_err(|e| format!("WAV source could not be read '{}': {}", wav_path.display(), e))?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(format!(
            "WAV source is not a readable non-empty file: {}",
            wav_path.display()
        ));
    }

    let ffmpeg = beatgaler_ffmpeg_program()?;
    let dir = beatgaler_temp_dir().join("master-conversion");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create MASTER conversion TEMP folder: {}", e))?;

    let output = dir.join(format!(
        "{}-{}.mp3",
        beat.id,
        random_urlsafe(8)
    ));
    let _ = std::fs::remove_file(&output);

    let result = Command::new(&ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel", "error",
            "-i",
        ])
        .arg(wav_path)
        .args([
            "-vn",
            "-map_metadata", "-1",
            "-codec:a", "libmp3lame",
            "-b:a", "320k",
        ])
        .arg(&output)
        .output()
        .map_err(|e| format!(
            "Could not start WAV -> MP3 converter '{}': {}",
            ffmpeg.display(), e
        ))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        let _ = std::fs::remove_file(&output);
        return Err(format!(
            "WAV -> MP3 conversion failed (exit {}): {}",
            result.status.code().map(|v| v.to_string()).unwrap_or_else(|| "signal".to_string()),
            if stderr.is_empty() { "ffmpeg returned no error text".to_string() } else { stderr }
        ));
    }

    let out_meta = std::fs::metadata(&output)
        .map_err(|e| format!("Converted MASTER MP3 was not created: {}", e))?;
    if out_meta.len() == 0 {
        let _ = std::fs::remove_file(&output);
        return Err("WAV -> MP3 conversion produced an empty MASTER file.".to_string());
    }

    Ok(output)
}

/// Fase 17: sube el MP3/WAV principal de un beat a Telegram Cloud. Solo el
/// archivo principal por ahora — stems y project.zip vienen en fases
/// posteriores. Guarda telegram_file_id/message_id en el propio beat
/// (dentro de meta_json) para poder descargarlo después sin adivinar nada
/// por nombre (Fase 22 — nunca confiar en nombres).
#[tauri::command(async)]
pub fn upload_beat_to_telegram(
    beat: BeatMeta,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<BeatMeta, String> {
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("Galer Cloud is not connected. Connect it in Settings first.".to_string());
        }
    }
    let user_id = ensure_beatgaler_user_id(&state)?;

    // Review -> Save is the commit boundary. Only NOW do we consult Telegram
    // (the sole source of truth) and resolve the final cloud name. Import preview
    // never talks to Telegram and never invents _2 before the user finishes editing.
    let mut beat = beat;
    // Metadata must be valid before anything becomes durable or reaches
    // Telegram. Invalid embedded tags are dropped; BPM/key are strict.
    beat.tags = filter_metadata_tags(&beat.tags);
    beat.bpm = validate_bpm_value(&beat.bpm)?;
    beat.key = validate_key_value(&beat.key)?;
    // V7: preserve the Telegram-authoritative duplicate-name gate, but it now
    // reads the in-process VERIFIED manifest cache instead of performing a new
    // get_index/transport reservation for every beat in a batch.
    let final_name = final_cloud_display_name_after_review(&state, &beat.id, &beat.name)?;
    if final_name != beat.name {
        beat.name = final_name;
    }
    beat.cloud_status = Some("UPLOADING".to_string());
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        db_save(&conn, &beat).map_err(|e| e.to_string())?;
    }

    // MASTER is ALWAYS MP3 in BeatGaler Cloud.
    // - Existing MP3: use it.
    // - WAV-only import: create a temporary 320 kbps MP3 MASTER.
    // The original WAV remains a separate HQ cloud slot.
    let mut generated_master: Option<PathBuf> = None;
    let source_path = if !beat.mp3_path.trim().is_empty() && Path::new(&beat.mp3_path).is_file() {
        PathBuf::from(&beat.mp3_path)
    } else if let Some(wav) = beat.wav_path.as_ref().filter(|p| !p.trim().is_empty()) {
        let wav_path = PathBuf::from(wav);
        let converted = convert_wav_to_cloud_master_mp3(&beat, &wav_path)
            .map_err(|e| format!("WAV-only MASTER generation failed: {}", e))?;
        generated_master = Some(converted.clone());
        converted
    } else {
        return Err(
            "This beat has no usable audio source. BeatGaler needs an MP3, or a WAV that can be converted to the MASTER MP3."
                .to_string()
        );
    };

    let source_meta = std::fs::metadata(&source_path)
        .map_err(|e| format!("MASTER source exists check failed for '{}': {}", source_path.display(), e))?;
    if !source_meta.is_file() || source_meta.len() == 0 {
        if let Some(path) = generated_master.as_ref() { let _ = std::fs::remove_file(path); }
        return Err(format!(
            "MASTER source is not a readable non-empty file: {} ({} bytes)",
            source_path.display(),
            source_meta.len()
        ));
    }

    let upload_copy = match make_cloud_master_upload_copy(&beat, &source_path, &state.data_dir) {
        Ok(path) => path,
        Err(e) => {
            if let Some(path) = generated_master.as_ref() { let _ = std::fs::remove_file(path); }
            return Err(format!("MASTER temp/metadata preparation failed: {}", e));
        }
    };

    let direct_filename = cloud_master_filename(&beat);
    let direct_result = direct_upload_file(
        &user_id,
        &beat.id,
        &beat.name,
        "MASTER",
        &upload_copy,
        &direct_filename,
    );
    let response_result: Result<Value, String> = direct_result;
    let _ = std::fs::remove_file(&upload_copy);
    if let Some(path) = generated_master.as_ref() {
        let _ = std::fs::remove_file(path);
    }
    let response = response_result?;

    let telegram_file_id = response.get("telegram_file_id").and_then(|v| v.as_str()).map(|s| s.to_string());
    let telegram_message_id = response.get("telegram_message_id").and_then(|v| v.as_i64());

    let mut updated = beat;
    updated.cloud_status = Some("SYNCED".to_string());
    updated.telegram_file_id = telegram_file_id;
    updated.telegram_message_id = telegram_message_id;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db_save(&conn, &updated).map_err(|e| e.to_string())?;

    Ok(updated)
}


fn normalize_cloud_file_type(raw: &str) -> Result<String, String> {
    let upper = raw.trim().to_ascii_uppercase();
    match upper.as_str() {
        "MASTER" | "WAV" | "LOOP" | "PROJECT" | "STEMS" | "OTHER" => Ok(upper),
        _ => Err(format!("Unsupported cloud file type: {}", raw)),
    }
}

fn new_cloud_file_id() -> String {
    let mut buf = [0u8; 16];
    OsRng.fill_bytes(&mut buf);
    let mut out = String::with_capacity(32);
    for b in buf {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{:02x}", b);
    }
    out
}




fn cloud_master_filename(beat: &BeatMeta) -> String {
    [
        (!beat.playback_path.is_empty()).then(|| PathBuf::from(&beat.playback_path)),
        (!beat.mp3_path.is_empty()).then(|| PathBuf::from(&beat.mp3_path)),
        beat.wav_path.as_ref().map(PathBuf::from),
    ]
    .into_iter()
    .flatten()
    .find_map(|p| p.file_name().and_then(|v| v.to_str()).map(|v| v.to_string()))
    .unwrap_or_else(|| format!("{}.mp3", beat.name))
}

fn artwork_mime_from_data_url(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if !value.starts_with("data:") { return None; }
    let rest = value.strip_prefix("data:")?;
    let mime = rest.split(';').next()?.trim();
    if mime.starts_with("image/") { Some(mime.to_string()) } else { None }
}

/// Writes ONE complete library manifest to a pinned Telegram document.
/// The manifest contains logical metadata and Telegram IDs only; local source
/// paths and artwork bytes are deliberately excluded.
#[tauri::command]
pub fn clear_local_cloud_vault(db: tauri::State<DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM cloud_files", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM cloud_projects", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM cloud_metadata", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM trash", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM beats", []).map_err(|e| e.to_string())?;
    Ok(())
}

fn build_cloud_manifest_entry(
    conn: &Connection,
    beat: &BeatMeta,
    sort_order: Option<usize>,
) -> Result<Option<Value>, String> {
    let mut cloud_files = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT cloud_file_id, file_type, filename, source_size, manifest_json, status
         FROM cloud_files
         WHERE beat_id=?1 AND file_type NOT IN ('MASTER','PROJECT')
         ORDER BY created_at ASC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![beat.id.clone()], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    }).map_err(|e| e.to_string())?;

    for row in rows {
        let (cloud_file_id, file_type, filename, source_size, raw, status) =
            row.map_err(|e| e.to_string())?;
        let file_manifest: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        cloud_files.push(json!({
            "cloud_file_id": cloud_file_id,
            "type": file_type,
            "filename": filename,
            "size": source_size.unwrap_or(0),
            "status": status,
            "manifest": file_manifest,
        }));
    }
    drop(stmt);

    let metadata_row = conn.query_row(
        "SELECT telegram_metadata_message_id, artwork_hash, artwork_telegram_file_id, artwork_telegram_message_id
         FROM cloud_metadata WHERE beat_id=?1",
        params![beat.id.clone()],
        |row| Ok((
            row.get::<_, Option<i64>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<i64>>(3)?,
        )),
    );
    let (metadata_message_id, artwork_hash, artwork_file_id, artwork_message_id) = match metadata_row {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => (None, None, None, None),
        Err(e) => return Err(e.to_string()),
    };

    let project_row = conn.query_row(
        "SELECT manifest_json, source_size FROM cloud_projects WHERE beat_id=?1",
        params![beat.id.clone()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
    );
    let project = match project_row {
        Ok((raw, source_size)) => {
            let mut project_manifest = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);

            // PROJECT capability flags are discovered from the archive at upload
            // time and stored in cloud_projects.manifest_json. Never overwrite
            // those durable flags with stale BeatMeta fields when publishing the
            // Telegram library index: a beat can start as audio-only and receive
            // its FLP/ALS later through PROJECT.zip.
            let manifest_has_flp = project_manifest.get("has_flp").and_then(|v| v.as_bool())
                .or_else(|| project_manifest.get("openable").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let manifest_has_als = project_manifest.get("has_als").and_then(|v| v.as_bool())
                .unwrap_or(false);
            let manifest_has_samples = project_manifest.get("has_samples").and_then(|v| v.as_bool())
                .unwrap_or(false);
            let manifest_openable = project_manifest.get("openable").and_then(|v| v.as_bool())
                .unwrap_or(false);

            let has_flp = beat.has_flp || manifest_has_flp;
            let has_als = beat.has_als || manifest_has_als;
            let has_samples = beat.has_samples || manifest_has_samples;
            let openable = manifest_openable || has_flp || has_als;

            if let Some(obj) = project_manifest.as_object_mut() {
                obj.insert("openable".to_string(), Value::Bool(openable));
                obj.insert("has_flp".to_string(), Value::Bool(has_flp));
                obj.insert("has_als".to_string(), Value::Bool(has_als));
                obj.insert("has_samples".to_string(), Value::Bool(has_samples));
            }

            Some(json!({
                "manifest": project_manifest,
                "size": source_size.unwrap_or(0),
                "openable": openable,
                "has_flp": has_flp,
                "has_als": has_als,
                "has_samples": has_samples,
            }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(e.to_string()),
    };

    let has_master = beat.telegram_file_id.as_deref().map(|v| !v.is_empty()).unwrap_or(false);
    let has_any_cloud = has_master
        || !cloud_files.is_empty()
        || project.is_some()
        || metadata_message_id.is_some()
        || artwork_file_id.is_some();
    if !has_any_cloud {
        return Ok(None);
    }

    Ok(Some(json!({
        "id": beat.id,
        "sort_order": sort_order,
        "name": beat.name,
        "bpm": beat.bpm,
        "key": beat.key,
        "tags": beat.tags,
        "rating": beat.rating,
        "color": beat.color,
        "color2": beat.color2,
        "master": {
            "telegram_file_id": beat.telegram_file_id,
            "telegram_message_id": beat.telegram_message_id,
            "filename": cloud_master_filename(beat),
        },
        "artwork": {
            "telegram_file_id": artwork_file_id,
            "telegram_message_id": artwork_message_id,
            "hash": artwork_hash,
            "mime": artwork_mime_from_data_url(beat.image_base64.as_deref()),
        },
        "metadata_message_id": metadata_message_id,
        "files": cloud_files,
        "project": project,
    })))
}

#[tauri::command(async)]
pub fn sync_cloud_library_index(
    beats: Vec<BeatMeta>,
    source_id: Option<String>,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<CloudLibrarySyncResult, String> {
    let sync_op = random_urlsafe(6);
    let sync_started = Instant::now();
    eprintln!("[index] BUILD_BEGIN op={} snapshot_beats={} source={}", sync_op, beats.len(), source_id.as_deref().unwrap_or("none"));
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("Galer Cloud is not connected.".to_string());
        }
    }

    let user_id = ensure_beatgaler_user_id(&state)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut manifest_beats = Vec::new();

    for (sort_order, beat) in beats.iter().enumerate() {
        if let Some(entry) = build_cloud_manifest_entry(&conn, beat, Some(sort_order))? {
            manifest_beats.push(entry);
        }
    }
    let project_count = manifest_beats.iter()
        .filter(|entry| entry.get("project").map(|value| !value.is_null()).unwrap_or(false))
        .count();
    eprintln!("[index] BUILD_ACTIVE_READY op={} indexed_beats={} projects={}", sync_op, manifest_beats.len(), project_count);

    // Trash is part of the Telegram source of truth. Files stay in their
    // original Telegram messages while trashed; only membership changes.
    let mut manifest_trash = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, beat_meta_json, trashed_at
         FROM trash
         WHERE is_cloud=1 AND beat_meta_json IS NOT NULL
         ORDER BY trashed_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    }).map_err(|e| e.to_string())?;

    for row in rows {
        let (trash_id, raw, trashed_at) = row.map_err(|e| e.to_string())?;
        let Ok(beat) = serde_json::from_str::<BeatMeta>(&raw) else { continue; };
        if let Some(entry) = build_cloud_manifest_entry(&conn, &beat, None)? {
            manifest_trash.push(json!({
                "trash_id": trash_id,
                "trashed_at": trashed_at,
                "purge_after": trashed_at.saturating_add(14 * 86400),
                "beat": entry,
            }));
        }
    }
    drop(stmt);
    drop(conn);

    let manifest = json!({
        "schema": GALER_T_LIBRARY_SCHEMA,
        "version": GALER_T_LIBRARY_SCHEMA_VERSION,
        "updated_at": now_epoch(),
        "beats": manifest_beats,
        "trash": manifest_trash,
    });

    // Safety invariant: ordinary UI/index sync may add beats, move them between
    // active/trash, or replace their media, but it may NEVER make an existing
    // beat identity disappear. Permanent deletion has its own explicit path.
    let current_manifest = direct_get_library_manifest(&user_id)
        .map_err(|e| format!("Could not read Galer Library source-of-truth index before sync: {}", e))?;
    let identity_ids = |value: &Value| -> std::collections::HashSet<String> {
        let mut out = std::collections::HashSet::new();
        if let Some(rows) = value.get("beats").and_then(|v| v.as_array()) {
            for row in rows { if let Some(id) = row.get("id").and_then(|v| v.as_str()) { if !id.is_empty() { out.insert(id.to_string()); } } }
        }
        if let Some(rows) = value.get("trash").and_then(|v| v.as_array()) {
            for row in rows {
                let beat = row.get("beat").unwrap_or(row);
                if let Some(id) = beat.get("id").and_then(|v| v.as_str()) { if !id.is_empty() { out.insert(id.to_string()); } }
            }
        }
        out
    };
    let previous_ids = identity_ids(&current_manifest);
    let candidate_ids = identity_ids(&manifest);
    let missing_count = previous_ids.iter().filter(|id| !candidate_ids.contains(*id)).count();
    if missing_count > 0 {
        return Err(format!(
            "Safety barrier blocked stale/destructive INDEX sync: {} existing beat(s) were missing from the candidate snapshot.",
            missing_count
        ));
    }

    // SINGLE Telegram index, written by the active transport bot directly
    // from this computer. MASTER never carries index bytes. Automatic cleanup
    // is limited to replaced media for identities still present in the vault.
    let response = direct_replace_library_manifest(&user_id, &manifest, source_id.as_deref())
        .map_err(|e| format!("Could not sync Galer Library index directly: {}", e))?;
    let library_message_id = response.get("message_id").and_then(|v| v.as_i64()).unwrap_or(0);

    eprintln!(
        "[index] BUILD_COMMIT_OK op={} message_id={} beats={} projects={} elapsed_ms={}",
        sync_op,
        library_message_id,
        manifest.get("beats").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
        project_count,
        sync_started.elapsed().as_millis(),
    );
    Ok(CloudLibrarySyncResult {
        telegram_file_id: format!("index:{}", library_message_id),
        telegram_message_id: library_message_id,
        updated: response.get("previous_message_id").and_then(|v| v.as_i64()).unwrap_or(0) > 0,
        beat_count: manifest.get("beats")
            .and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
    })
}

fn fetch_restored_artwork(
    user_id: &str,
    telegram_file_id: &str,
    mime: Option<&str>,
    data_dir: &Path,
) -> Option<String> {
    let temp_dir = beatgaler_temp_dir().join("cloud-cache").join("artwork-restore");
    std::fs::create_dir_all(&temp_dir).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(telegram_file_id.as_bytes());
    let key = format!("{:x}", hasher.finalize());
    let temp_path = temp_dir.join(format!("{}.img", key));
    if !temp_path.exists() {
        if let Some(message_id) = direct_message_id(telegram_file_id) {
            match direct_download_file(user_id, message_id, &temp_path) {
                Ok(bytes) if bytes > 0 => {}
                _ => { let _ = std::fs::remove_file(&temp_path); return None; }
            }
        } else {
            // Old Bot API file_id-only artwork is intentionally not fetched through 001BeatGaler.
            // It must be migrated/re-uploaded so the index carries direct:<message_id>.
            return None;
        }
    }
    let bytes = std::fs::read(&temp_path).ok()?;
    if bytes.is_empty() { return None; }
    // When lazy-loading artwork we may no longer have the manifest MIME at the
    // call site. Sniff the actual Telegram bytes so a JPEG stays image/jpeg
    // instead of becoming image/png in the data URL (which would change the
    // artwork hash and cause a pointless re-upload on the next metadata edit).
    let inferred_mime = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        "image/png"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else {
        "image/png"
    };
    let mime = mime.filter(|v| v.starts_with("image/")).unwrap_or(inferred_mime);
    Some(format!("data:{};base64,{}", mime, general_purpose::STANDARD.encode(bytes)))
}

fn beat_local_master_exists(beat: &BeatMeta) -> bool {
    let playback = Path::new(&beat.playback_path);
    if !beat.playback_path.trim().is_empty() && playback.is_file() { return true; }
    let mp3 = Path::new(&beat.mp3_path);
    if !beat.mp3_path.trim().is_empty() && mp3.is_file() { return true; }
    if let Some(wav) = beat.wav_path.as_deref() {
        if !wav.trim().is_empty() && Path::new(wav).is_file() { return true; }
    }
    false
}

fn existing_beat_meta(conn: &Connection, beat_id: &str) -> Option<BeatMeta> {
    let raw: Option<String> = conn.query_row(
        "SELECT meta_json FROM beats WHERE id=?1",
        params![beat_id],
        |row| row.get(0),
    ).ok().flatten();
    raw.and_then(|value| serde_json::from_str::<BeatMeta>(&value).ok())
}

/// Rebuilds the local SQLite/cache view from the pinned Telegram library index.
/// No original beat folder is required. All restored source paths deliberately
/// point at NON-CREATED app-data placeholders, so filesystem scans cannot own
/// or delete these cloud-only beats.
fn restore_cloud_records_from_manifest_entry(
    conn: &Connection,
    id: &str,
    entry: &Value,
) -> Result<(), String> {
    let files = entry.get("files").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for file in files {
        let cloud_file_id = file.get("cloud_file_id").and_then(|v| v.as_str()).unwrap_or("");
        let file_type = file.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if cloud_file_id.is_empty() || file_type.is_empty() || matches!(file_type, "MASTER" | "PROJECT") {
            continue;
        }
        let filename = file.get("filename").and_then(|v| v.as_str()).unwrap_or("file");
        let source_size = file.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
        let status = file.get("status").and_then(|v| v.as_str()).unwrap_or("SYNCED");
        let file_manifest = file.get("manifest").cloned().unwrap_or(Value::Null).to_string();
        conn.execute(
            "INSERT INTO cloud_files
             (cloud_file_id, beat_id, file_type, filename, source_path, source_size, source_modified_ms, manifest_json, status, created_at, updated_at)
             VALUES (?1,?2,?3,?4,NULL,?5,NULL,?6,?7,strftime('%s','now'),strftime('%s','now'))
             ON CONFLICT(cloud_file_id) DO UPDATE SET
               beat_id=excluded.beat_id, file_type=excluded.file_type, filename=excluded.filename,
               source_path=NULL, source_size=excluded.source_size, manifest_json=excluded.manifest_json,
               status=excluded.status, updated_at=excluded.updated_at",
            params![cloud_file_id, id, file_type, filename, source_size, file_manifest, status],
        ).map_err(|e| e.to_string())?;
    }

    conn.execute(
        "DELETE FROM cloud_files WHERE beat_id=?1 AND file_type IN ('MASTER','PROJECT')",
        params![id],
    ).map_err(|e| e.to_string())?;

    if let Some(project) = entry.get("project").filter(|v| !v.is_null()) {
        // Never let an older/stale Telegram index downgrade PROJECT capabilities
        // that were already positively detected from the actual ZIP on this device.
        let existing_project_manifest = conn.query_row(
            "SELECT manifest_json FROM cloud_projects WHERE beat_id=?1",
            params![id],
            |row| row.get::<_, String>(0),
        ).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

        let mut project_manifest_value = project.get("manifest").cloned().unwrap_or(Value::Null);
        if !project_manifest_value.is_object() {
            project_manifest_value = json!({});
        }

        let incoming_bool = |key: &str| -> bool {
            project.get(key).and_then(|v| v.as_bool())
                .or_else(|| project.get("manifest").and_then(|m| m.get(key)).and_then(|v| v.as_bool()))
                .unwrap_or(false)
        };
        let existing_bool = |key: &str| -> bool {
            existing_project_manifest.as_ref()
                .and_then(|m| m.get(key))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        };

        let has_flp = incoming_bool("has_flp") || existing_bool("has_flp");
        let has_als = incoming_bool("has_als") || existing_bool("has_als");
        let has_samples = incoming_bool("has_samples") || existing_bool("has_samples");
        let openable = incoming_bool("openable") || existing_bool("openable") || has_flp || has_als;

        if let Some(obj) = project_manifest_value.as_object_mut() {
            obj.insert("openable".to_string(), Value::Bool(openable));
            obj.insert("has_flp".to_string(), Value::Bool(has_flp));
            obj.insert("has_als".to_string(), Value::Bool(has_als));
            obj.insert("has_samples".to_string(), Value::Bool(has_samples));
        }
        let project_manifest = project_manifest_value.to_string();
        let project_size = project.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
        conn.execute(
            "INSERT INTO cloud_projects
             (beat_id, local_zip_path, manifest_json, source_size, source_modified_ms, uploaded_at)
             VALUES (?1,NULL,?2,?3,NULL,strftime('%s','now'))
             ON CONFLICT(beat_id) DO UPDATE SET
               local_zip_path=NULL, manifest_json=excluded.manifest_json,
               source_size=excluded.source_size, source_modified_ms=NULL, uploaded_at=excluded.uploaded_at",
            params![id, project_manifest, project_size],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute("DELETE FROM cloud_projects WHERE beat_id=?1", params![id])
            .map_err(|e| e.to_string())?;
    }

    let artwork = entry.get("artwork").cloned().unwrap_or(Value::Null);
    let metadata_message_id = entry.get("metadata_message_id").and_then(|v| v.as_i64());
    let artwork_hash = artwork.get("hash").and_then(|v| v.as_str()).map(|v| v.to_string());
    let artwork_file_id = artwork.get("telegram_file_id").and_then(|v| v.as_str()).map(|v| v.to_string());
    let artwork_message_id = artwork.get("telegram_message_id").and_then(|v| v.as_i64());
    conn.execute(
        "INSERT INTO cloud_metadata
         (beat_id, telegram_metadata_message_id, artwork_hash, artwork_telegram_file_id, artwork_telegram_message_id, updated_at)
         VALUES (?1,?2,?3,?4,?5,strftime('%s','now'))
         ON CONFLICT(beat_id) DO UPDATE SET
           telegram_metadata_message_id=excluded.telegram_metadata_message_id,
           artwork_hash=excluded.artwork_hash,
           artwork_telegram_file_id=excluded.artwork_telegram_file_id,
           artwork_telegram_message_id=excluded.artwork_telegram_message_id,
           updated_at=excluded.updated_at",
        params![id, metadata_message_id, artwork_hash, artwork_file_id, artwork_message_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn beat_from_cloud_manifest_entry(
    entry: &Value,
    _user_id: &str,
    state: &SettingsState,
    conn: &Connection,
) -> Result<BeatMeta, String> {
    let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() { return Err("Galer Library entry has no beat id.".to_string()); }
    let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
    let master = entry.get("master").cloned().unwrap_or(Value::Null);
    let telegram_file_id = master.get("telegram_file_id").and_then(|v| v.as_str()).map(|v| v.to_string());
    let telegram_message_id = master.get("telegram_message_id").and_then(|v| v.as_i64());
    let master_filename = master.get("filename").and_then(|v| v.as_str()).unwrap_or("master.mp3");

    let placeholder_folder = state.data_dir.join("cloud-library").join(&id);
    let placeholder_master_name = if Path::new(master_filename).extension()
        .and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case("mp3")).unwrap_or(false)
    {
        master_filename.to_string()
    } else {
        format!("{}.mp3", safe_cloud_filename(&name))
    };
    let placeholder_master = placeholder_folder.join(placeholder_master_name);
    let existing_local = existing_beat_meta(conn, &id).filter(beat_local_master_exists);

    // Startup restore is metadata-only. Artwork is fetched on demand by the
    // frontend for the first six priority beats, then progressively for the
    // remaining library. This keeps hundreds of Telegram artwork requests out
    // of the startup critical path.
    let image_base64 = None;

    let files = entry.get("files").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let has_wav_cloud = files.iter().any(|v| v.get("type").and_then(|x| x.as_str()) == Some("WAV"));
    let has_stems = files.iter().any(|v| v.get("type").and_then(|x| x.as_str()) == Some("STEMS"));
    let has_loop = files.iter().any(|v| v.get("type").and_then(|x| x.as_str()) == Some("LOOP"));
    let project = entry.get("project").cloned().unwrap_or(Value::Null);
    let project_manifest = project.get("manifest").cloned().unwrap_or(Value::Null);
    let project_has_flp = project.get("has_flp").and_then(|v| v.as_bool())
        .or_else(|| project_manifest.get("has_flp").and_then(|v| v.as_bool()))
        .or_else(|| project.get("openable").and_then(|v| v.as_bool()))
        .or_else(|| project_manifest.get("openable").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    let project_has_als = project.get("has_als").and_then(|v| v.as_bool())
        .or_else(|| project_manifest.get("has_als").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    let project_has_samples = project.get("has_samples").and_then(|v| v.as_bool())
        .or_else(|| project_manifest.get("has_samples").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    let tags = entry.get("tags").and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>()
    }).unwrap_or_default();
    let rating = entry.get("rating").and_then(|v| v.as_u64()).unwrap_or(0).min(255) as u8;

    Ok(BeatMeta {
        id: id.clone(),
        name,
        folder_path: existing_local.as_ref().map(|b| b.folder_path.clone())
            .unwrap_or_else(|| placeholder_folder.to_string_lossy().to_string()),
        mp3_path: existing_local.as_ref().map(|b| b.mp3_path.clone())
            .unwrap_or_else(|| placeholder_master.to_string_lossy().to_string()),
        wav_path: existing_local.as_ref().and_then(|b| b.wav_path.clone()),
        playback_path: existing_local.as_ref().map(|b| b.playback_path.clone())
            .unwrap_or_else(|| placeholder_master.to_string_lossy().to_string()),
        bpm: entry.get("bpm").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        key: entry.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        needs_resolution: false,
        tags,
        rating,
        image_base64,
        has_wav: existing_local.as_ref().map(|b| b.has_wav).unwrap_or(false) || has_wav_cloud,
        has_stems: existing_local.as_ref().map(|b| b.has_stems).unwrap_or(false) || has_stems,
        has_samples: existing_local.as_ref().map(|b| b.has_samples).unwrap_or(false) || project_has_samples,
        samples_path: existing_local.as_ref().and_then(|b| b.samples_path.clone()),
        has_flp: existing_local.as_ref().map(|b| b.has_flp).unwrap_or(false) || project_has_flp,
        has_als: existing_local.as_ref().map(|b| b.has_als).unwrap_or(false) || project_has_als,
        stems_path: existing_local.as_ref().and_then(|b| b.stems_path.clone()),
        flp_path: existing_local.as_ref().and_then(|b| b.flp_path.clone()),
        als_path: existing_local.as_ref().and_then(|b| b.als_path.clone()),
        other_files: existing_local.as_ref().map(|b| b.other_files.clone()).unwrap_or_default(),
        color: entry.get("color").and_then(|v| v.as_str()).unwrap_or("#666666").to_string(),
        color2: entry.get("color2").and_then(|v| v.as_str()).unwrap_or("#999999").to_string(),
        has_loop: existing_local.as_ref().map(|b| b.has_loop).unwrap_or(false) || has_loop,
        loop_path: existing_local.as_ref().and_then(|b| b.loop_path.clone()),
        cloud_status: telegram_file_id.as_ref()
            .map(|_| if existing_local.is_some() { "SYNCED" } else { "CLOUD_ONLY" }.to_string()),
        telegram_file_id,
        telegram_message_id,
        offline_available: false,
    })
}

#[tauri::command(async)]
pub fn repair_stale_cloud_library_refs(
    state: tauri::State<SettingsState>,
) -> Result<usize, String> {
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected { return Ok(0); }
    }
    let user_id = ensure_beatgaler_user_id(&state)?;
    let mut manifest = direct_get_library_manifest(&user_id)
        .map_err(|e| format!("Could not read Galer Library for integrity repair: {}", e))?;

    let entries = manifest.get("beats").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if entries.is_empty() { return Ok(0); }

    let mut stale_ids = std::collections::HashSet::<String>::new();
    for entry in &entries {
        let beat_id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if beat_id.is_empty() { continue; }
        let message_id = entry.get("master")
            .and_then(|v| v.get("telegram_message_id"))
            .and_then(|v| v.as_i64())
            .or_else(|| entry.get("master")
                .and_then(|v| v.get("telegram_file_id"))
                .and_then(|v| v.as_str())
                .and_then(direct_message_id));
        let Some(message_id) = message_id.filter(|id| *id > 0) else {
            // Unknown/legacy entry: preserve it. Integrity repair is intentionally
            // conservative and only removes media Telegram explicitly proves missing.
            continue;
        };

        match direct_probe_media_message(&user_id, message_id) {
            Ok(true) => {}
            Ok(false) => {
                eprintln!("[direct] INDEX_STALE_MASTER_CONFIRMED beat_id={} message_id={}", beat_id, message_id);
                stale_ids.insert(beat_id.to_string());
            }
            Err(error) => {
                // Transient verification errors are non-destructive. Keep the beat and
                // allow a later Reload/startup repair pass to try again.
                eprintln!("[direct] INDEX_MASTER_PROBE_DEFERRED beat_id={} message_id={} reason={}", beat_id, message_id, error);
            }
        }
    }

    if stale_ids.is_empty() { return Ok(0); }

    let root = manifest.as_object_mut().ok_or_else(|| "Galer Library index root is invalid.".to_string())?;
    let beats = root.entry("beats").or_insert_with(|| Value::Array(Vec::new()));
    let beats_array = beats.as_array_mut().ok_or_else(|| "Galer Library beats field is invalid.".to_string())?;
    let before = beats_array.len();
    beats_array.retain(|entry| {
        let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
        !stale_ids.contains(id)
    });
    let removed = before.saturating_sub(beats_array.len());
    let remaining = beats_array.len();
    if removed == 0 { return Ok(0); }
    root.insert("updated_at".to_string(), Value::from(now_epoch()));

    // This is the only automatic path allowed to reduce active identities without a
    // user delete: every removed beat's MASTER message was independently confirmed
    // missing by Telegram itself. Existing delete_messages/cleanup behavior remains
    // untouched.
    direct_replace_library_manifest_with_options(&user_id, &manifest, Some("integrity-repair"), true)
        .map_err(|e| format!("Could not publish repaired Galer Library INDEX: {}", e))?;
    eprintln!("[direct] INDEX_STALE_REPAIR_COMMIT removed={} remaining={}", removed, remaining);
    Ok(removed)
}

#[tauri::command(async)]
pub fn restore_library_from_telegram(
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<Vec<BeatMeta>, String> {
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected { return Err("Galer Cloud is not connected.".to_string()); }
    }
    let user_id = ensure_beatgaler_user_id(&state)?;
    // Restore the authoritative index directly from Telegram through the
    // currently leased transport bot. No MASTER/backend download of the index.
    let manifest = direct_get_library_manifest(&user_id)
        .map_err(|e| format!("Could not restore Galer Library directly: {}", e))?;

    let entries = manifest.get("beats").and_then(|v| v.as_array())
        .ok_or_else(|| "Galer Library index has no beats array.".to_string())?;
    let trash_entries = manifest.get("trash").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let manifest_ids: std::collections::HashSet<String> = entries.iter()
        .filter_map(|entry| entry.get("id").and_then(|v| v.as_str()).map(|v| v.to_string()))
        .filter(|id| !id.is_empty()).collect();
    let trash_beat_ids: std::collections::HashSet<String> = trash_entries.iter()
        .filter_map(|item| item.get("beat"))
        .filter_map(|entry| entry.get("id").and_then(|v| v.as_str()).map(|v| v.to_string()))
        .filter(|id| !id.is_empty()).collect();
    let manifest_trash_ids: std::collections::HashSet<String> = trash_entries.iter()
        .filter_map(|item| item.get("trash_id").and_then(|v| v.as_str()).map(|v| v.to_string()))
        .collect();

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // V7: Telegram is the source of truth. An authoritative empty INDEX means
    // Empty Gallery. Local SQLite/cloud rows are caches and are reconciled below;
    // they must never veto a valid empty remote library.
    let mut restored = Vec::new();
    for entry in entries {
        let beat = beat_from_cloud_manifest_entry(entry, &user_id, &state, &conn)?;
        let sort_order = entry.get("sort_order").and_then(|v| v.as_i64());
        db_upsert_with_order(&conn, &beat, sort_order).map_err(|e| e.to_string())?;
        restore_cloud_records_from_manifest_entry(&conn, &beat.id, entry)?;
        restored.push(beat);
    }

    for item in &trash_entries {
        let Some(entry) = item.get("beat") else { continue; };
        let beat = beat_from_cloud_manifest_entry(entry, &user_id, &state, &conn)?;
        let trash_id = item.get("trash_id").and_then(|v| v.as_str())
            .map(|v| v.to_string()).unwrap_or_else(|| format!("cloud-trash:{}", beat.id));
        let trashed_at = item.get("trashed_at").and_then(|v| v.as_i64())
            .unwrap_or_else(|| now_epoch() as i64);
        let raw_beat = serde_json::to_string(&beat).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO trash
             (id, original_folder_path, trashed_path, beat_name, beat_meta_json, is_cloud, trashed_at)
             VALUES (?1,?2,'',?3,?4,1,?5)
             ON CONFLICT(id) DO UPDATE SET
               original_folder_path=excluded.original_folder_path,
               beat_name=excluded.beat_name, beat_meta_json=excluded.beat_meta_json,
               is_cloud=1, trashed_at=excluded.trashed_at",
            params![trash_id, beat.folder_path, beat.name, raw_beat, trashed_at],
        ).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM beats WHERE id=?1", params![beat.id.clone()])
            .map_err(|e| e.to_string())?;
        restore_cloud_records_from_manifest_entry(&conn, &beat.id, entry)?;
    }

    let mut trash_stmt = conn.prepare("SELECT id FROM trash WHERE is_cloud=1")
        .map_err(|e| e.to_string())?;
    let local_trash_ids = trash_stmt.query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok()).collect::<Vec<_>>();
    drop(trash_stmt);
    for trash_id in local_trash_ids {
        if !manifest_trash_ids.contains(&trash_id) {
            conn.execute("DELETE FROM trash WHERE id=?1", params![trash_id])
                .map_err(|e| e.to_string())?;
        }
    }

    let existing_rows = db_load_all(&conn).map_err(|e| e.to_string())?;
    for row in existing_rows {
        if manifest_ids.contains(&row.id) { continue; }
        if trash_beat_ids.contains(&row.id) {
            conn.execute("DELETE FROM beats WHERE id=?1", params![row.id.clone()])
                .map_err(|e| e.to_string())?;
            continue;
        }
        let Some(meta) = db_meta(&row) else { continue; };
        let had_cloud = meta.telegram_file_id.as_deref().map(|v| !v.is_empty()).unwrap_or(false)
            || matches!(meta.cloud_status.as_deref(), Some("SYNCED") | Some("CLOUD_ONLY"));
        if !had_cloud { continue; }

        // Telegram's pinned library index is authoritative for cloud-backed beats.
        // A local source/cache copy is only a cache; it must never resurrect a beat
        // that is absent from both the active list and Telegram trash.
        conn.execute("DELETE FROM beats WHERE id=?1", params![row.id.clone()])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM cloud_files WHERE beat_id=?1", params![row.id.clone()])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM cloud_projects WHERE beat_id=?1", params![row.id.clone()])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM cloud_metadata WHERE beat_id=?1", params![row.id.clone()])
            .map_err(|e| e.to_string())?;
    }
    Ok(restored)
}

/// Fetch one beat artwork lazily from Telegram using the file id already saved
/// from the pinned index. The byte cache inside fetch_restored_artwork means a
/// previously fetched cover does not require another network download.
#[tauri::command(async)]
pub fn load_cloud_artwork_for_beat(
    beat_id: String,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<Option<String>, String> {
    let artwork_file_id = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT artwork_telegram_file_id FROM cloud_metadata WHERE beat_id=?1 LIMIT 1",
            params![beat_id.clone()],
            |row| row.get::<_, Option<String>>(0),
        ).ok().flatten()
    };

    let Some(file_id) = artwork_file_id.filter(|v| !v.trim().is_empty()) else {
        return Ok(None);
    };

    let user_id = ensure_beatgaler_user_id(&state)?;
    fetch_restored_artwork(&user_id, &file_id, None, &state.data_dir)
        .map(Some)
        .ok_or_else(|| format!("Could not load artwork for beat {}.", beat_id))
}

// Serialize metadata/artwork syncs. React can legitimately request a sync from
// both the immediate upload path and the debounced library observer. Without a
// lock those calls can read the same old artwork hash/message id and both send
// a new Telegram document before either one updates SQLite.
static CLOUD_METADATA_SYNC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// Restore requests may be launched rapidly from the UI. Each command runs in the
// background, but the read-modify-write of the single authoritative library INDEX
// must stay serialized so two restores cannot overwrite each other.
static TRASH_RESTORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Syncs lightweight LIVE BeatGaler metadata to Telegram without re-uploading
/// the master audio. Artwork is uploaded separately only when it changed.
#[tauri::command(async)]
pub fn sync_beat_metadata_to_telegram(
    beat: BeatMeta,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<CloudMetadataSyncResult, String> {
    let _sync_guard = CLOUD_METADATA_SYNC_LOCK
        .lock()
        .map_err(|_| "Galer metadata sync lock was poisoned.".to_string())?;

    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("Galer Cloud is not connected.".to_string());
        }
    }

    if beat.telegram_file_id.as_deref().unwrap_or("").is_empty() {
        return Err("Upload the beat MASTER to Galer Cloud before syncing its metadata.".to_string());
    }

    let user_id = ensure_beatgaler_user_id(&state)?;
    let base = telegram_cloud_api_base();

    let (old_metadata_message_id, old_artwork_hash, mut artwork_file_id, mut artwork_message_id) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let row = conn.query_row(
            "SELECT telegram_metadata_message_id, artwork_hash, artwork_telegram_file_id, artwork_telegram_message_id
             FROM cloud_metadata WHERE beat_id=?1",
            params![beat.id],
            |r| Ok((
                r.get::<_, Option<i64>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<i64>>(3)?,
            )),
        );
        match row {
            Ok(v) => v,
            Err(rusqlite::Error::QueryReturnedNoRows) => (None, None, None, None),
            Err(e) => return Err(e.to_string()),
        }
    };

    let new_artwork_hash = artwork_hash(beat.image_base64.as_deref());

    if new_artwork_hash != old_artwork_hash {
        // Direct mode is copy-on-write: a changed cover gets a NEW Telegram
        // message. The previous artwork message is retained only until the next
        // single-index commit; once the new index is pinned, the transport bot
        // recognizes the old unreferenced media and deletes it.
        let existing_artwork_message_id = artwork_message_id;
        artwork_file_id = None;

        if let Some(image) = beat.image_base64.as_deref().filter(|v| !v.trim().is_empty()) {
            let temp = write_cloud_artwork_temp(&state.data_dir, image, &beat.id)?;
            let filename = temp
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("artwork.img")
                .to_string();

            let direct_result = direct_upload_file(
                &user_id,
                &beat.id,
                &beat.name,
                "ARTWORK",
                &temp,
                &filename,
            );
            let response = match direct_result {
                Ok(value) => value,
                Err(error) => {
                    let _ = std::fs::remove_file(&temp);
                    return Err(format!("Could not upload artwork with BeatGaler Cloud: {}", error));
                }
            };
            let _ = std::fs::remove_file(&temp);
            if let Some(err) = response.get("error").and_then(|v| v.as_str()) {
                return Err(err.to_string());
            }
            artwork_file_id = response.get("telegram_file_id").and_then(|v| v.as_str()).map(|v| v.to_string());
            artwork_message_id = response.get("telegram_message_id").and_then(|v| v.as_i64());
        }
    }

    // Live tags/BPM/key/rating/name are already persisted in the SINGLE pinned
    // Telegram library index. Sending a raw BEATGALER_METADATA_V1 message for
    // every beat is redundant and noisy, so this command now only maintains the
    // separate artwork media and its IDs.
    let metadata_message_id = old_metadata_message_id.unwrap_or(0);

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO cloud_metadata
             (beat_id, telegram_metadata_message_id, artwork_hash, artwork_telegram_file_id, artwork_telegram_message_id, updated_at)
             VALUES (?1,?2,?3,?4,?5,strftime('%s','now'))
             ON CONFLICT(beat_id) DO UPDATE SET
               telegram_metadata_message_id=excluded.telegram_metadata_message_id,
               artwork_hash=excluded.artwork_hash,
               artwork_telegram_file_id=excluded.artwork_telegram_file_id,
               artwork_telegram_message_id=excluded.artwork_telegram_message_id,
               updated_at=excluded.updated_at",
            params![
                beat.id,
                if metadata_message_id > 0 { Some(metadata_message_id) } else { None },
                new_artwork_hash,
                artwork_file_id,
                artwork_message_id
            ],
        ).map_err(|e| e.to_string())?;
    }

    Ok(CloudMetadataSyncResult {
        beat_id: beat.id,
        telegram_metadata_message_id: metadata_message_id,
        artwork_telegram_file_id: artwork_file_id,
        artwork_telegram_message_id: artwork_message_id,
    })
}

/// Creates a disposable upload copy of the main audio and writes the current
/// BeatGaler metadata into the bytes that are sent to Telegram. The user's
/// source file is never modified. Because Telegram receives the file as a
/// document, these tags/artwork survive cloud storage and later downloads.
fn make_cloud_master_upload_copy(
    beat: &BeatMeta,
    source: &Path,
    data_dir: &Path,
) -> Result<PathBuf, String> {
    let ext = source.extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "mp3" {
        return Err("MASTER must be an MP3. WAV belongs in the WAV HQ slot.".to_string());
    }

    let dir = beatgaler_temp_dir().join("cloud-upload-tmp");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create cloud upload temp folder: {}", e))?;

    let safe_id: String = beat.id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let path = dir.join(format!(
        "master-{}-{}.{}",
        if safe_id.is_empty() { "beat" } else { &safe_id },
        now_epoch(),
        ext
    ));

    std::fs::copy(source, &path)
        .map_err(|e| format!("Could not prepare cloud audio copy: {}", e))?;

    if let Err(e) = write_id3_to(
        &path,
        &beat.bpm,
        &beat.key,
        &beat.tags,
        beat.rating,
        beat.image_base64.as_deref(),
    ) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("Could not embed BeatGaler metadata for cloud upload: {}", e));
    }

    // Title is also part of the cloud copy. write_id3_to handles the rest:
    // artwork, BPM, key, tags/genre and rating.
    let mut tag = Tag::read_from_path(&path).unwrap_or_default();
    tag.set_title(beat.name.clone());
    if let Err(e) = tag.write_to_path(&path, Version::Id3v23) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("Could not embed BeatGaler title for cloud upload: {}", e));
    }

    Ok(path)
}

/// Uploads a file dropped directly on a beat artwork without copying it into
/// the beat's local folder first. Telegram becomes the durable copy.
/// MASTER keeps the legacy BeatMeta Telegram IDs in sync for playback.
/// PROJECT also updates cloud_projects so Open Project keeps working.
#[tauri::command(async)]
pub fn upload_dropped_file_to_telegram(
    beat: BeatMeta,
    file_path: String,
    file_type: String,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<CloudFileUploadResult, String> {
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("Galer Cloud is not connected. Connect it in Settings first.".to_string());
        }
    }

    let cloud_type = normalize_cloud_file_type(&file_type)?;
    let original_source = PathBuf::from(&file_path);
    if !original_source.exists() || !original_source.is_file() {
        return Err(format!("Dropped file no longer exists: {}", file_path));
    }
    if std::fs::metadata(&original_source).map_err(|e| e.to_string())?.len() == 0 {
        return Err("The dropped file is empty.".to_string());
    }

    // A valid PROJECT ZIP is allowed to contain Backup/Backups. Those entries
    // are removed into a temporary filtered copy before any bytes are sent to Telegram.
    let filtered_project_source = if cloud_type == "PROJECT" {
        filtered_project_zip_for_upload(&original_source)?
    } else { None };
    let source = filtered_project_source.as_ref().unwrap_or(&original_source).clone();
    if cloud_type == "PROJECT" && !project_zip_is_valid(&source) {
        if let Some(parent) = filtered_project_source.as_ref().and_then(|p| p.parent()) { let _ = std::fs::remove_dir_all(parent); }
        return Err("PROJECT zip is invalid. It must contain a project file (.flp/.als/.logicx/.ptx/.ptf).".to_string());
    }
    let meta = std::fs::metadata(&source).map_err(|e| e.to_string())?;

    let filename = original_source.file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("file")
        .to_string();
    let (_, modified_ms) = project_file_stamp(&source)
        .ok_or_else(|| "Could not read dropped file metadata.".to_string())?;

    let user_id = ensure_beatgaler_user_id(&state)?;

    // MASTER remains compatible with the existing cloud-only playback path.
    if cloud_type == "MASTER" {
        let effective_beat = adopt_mp3_metadata_if_empty(&beat, &source);
        let upload_copy = make_cloud_master_upload_copy(&effective_beat, &source, &state.data_dir)?;
        let direct_result = direct_upload_file(
            &user_id,
            &beat.id,
            &beat.name,
            "MASTER",
            &upload_copy,
            &filename,
        );
        let response_result: Result<Value, String> = direct_result;
        let _ = std::fs::remove_file(&upload_copy);
        let response = response_result?;

        let telegram_file_id = response.get("telegram_file_id")
            .and_then(|v| v.as_str()).map(|v| v.to_string())
            .ok_or_else(|| "Galer Storage did not return a cloud file reference.".to_string())?;
        let telegram_message_id = response.get("telegram_message_id").and_then(|v| v.as_i64());

        let cloud_file_id = format!("MASTER:{}", beat.id);

        let mut updated = effective_beat;
        updated.cloud_status = Some("SYNCED".to_string());
        updated.telegram_file_id = Some(telegram_file_id.clone());
        updated.telegram_message_id = telegram_message_id;

        let conn = db.0.lock().map_err(|e| e.to_string())?;
        db_save(&conn, &updated).map_err(|e| e.to_string())?;
        // MASTER has exactly one logical home: BeatMeta.telegram_*.
        // Remove legacy duplicate rows left by older builds.
        conn.execute(
            "DELETE FROM cloud_files WHERE beat_id=?1 AND file_type='MASTER'",
            params![beat.id.clone()],
        ).map_err(|e| e.to_string())?;

        return Ok(CloudFileUploadResult {
            cloud_file_id,
            beat_id: beat.id,
            file_type: cloud_type,
            filename,
            original_size: meta.len(),
            part_count: 1,
            telegram_file_id: Some(telegram_file_id),
            telegram_message_id,
        });
    }

    let existing_slot: Option<(String, Option<i64>)> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if cloud_type == "PROJECT" {
            let row = conn.query_row(
                "SELECT manifest_json FROM cloud_projects WHERE beat_id=?1",
                params![beat.id.clone()],
                |r| r.get::<_, String>(0),
            );
            match row {
                Ok(manifest_raw) => {
                    let message_id = serde_json::from_str::<Value>(&manifest_raw).ok()
                        .and_then(|v| v.get("parts").and_then(|p| p.as_array()).cloned())
                        .and_then(|parts| parts.first().cloned())
                        .and_then(|p| p.get("telegram_message_id").and_then(|m| m.as_i64()));
                    Some((format!("PROJECT:{}", beat.id), message_id))
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(e) => return Err(e.to_string()),
            }
        } else {
            let row = conn.query_row(
                "SELECT cloud_file_id, manifest_json FROM cloud_files WHERE beat_id=?1 AND file_type=?2 AND status='SYNCED' ORDER BY updated_at DESC LIMIT 1",
                params![beat.id.clone(), cloud_type.clone()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            );
            match row {
                Ok((cloud_file_id, manifest_raw)) => {
                    let message_id = serde_json::from_str::<Value>(&manifest_raw).ok()
                        .and_then(|v| v.get("parts").and_then(|p| p.as_array()).cloned())
                        .and_then(|parts| parts.first().cloned())
                        .and_then(|p| p.get("telegram_message_id").and_then(|m| m.as_i64()));
                    Some((cloud_file_id, message_id))
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(e) => return Err(e.to_string()),
            }
        }
    };

    // The selected file goes from this desktop straight to the assigned transport bot.
    // No service/manager-bot media fallback exists.
    let direct_result = direct_upload_file(
        &user_id,
        &beat.id,
        &beat.name,
        &cloud_type,
        &source,
        &filename,
    );
    let response_result: Result<Value, String> = direct_result;
    if let Some(parent) = filtered_project_source.as_ref().and_then(|p| p.parent()) {
        let _ = std::fs::remove_dir_all(parent);
    }
    let response = response_result?;

    let parts = response.get("parts").and_then(|v| v.as_array())
        .ok_or_else(|| "BeatGaler Cloud did not return uploaded file parts.".to_string())?;
    if parts.is_empty() {
        return Err("Galer Storage did not return any uploaded file parts.".to_string());
    }

    let first_file_id = parts.first()
        .and_then(|v| v.get("telegram_file_id"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let first_message_id = parts.first()
        .and_then(|v| v.get("telegram_message_id"))
        .and_then(|v| v.as_i64());

    let cloud_file_id = existing_slot.as_ref().map(|(id, _)| id.clone()).unwrap_or_else(new_cloud_file_id);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM cloud_files WHERE beat_id=?1 AND file_type=?2 AND cloud_file_id<>?3",
        params![beat.id.clone(), cloud_type.clone(), cloud_file_id.clone()],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO cloud_files
         (cloud_file_id, beat_id, file_type, filename, source_path, source_size, source_modified_ms, manifest_json, status, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'SYNCED',strftime('%s','now'),strftime('%s','now'))",
        params![
            cloud_file_id,
            beat.id,
            cloud_type,
            filename,
            source.to_string_lossy().to_string(),
            meta.len() as i64,
            modified_ms,
            response.to_string()
        ],
    ).map_err(|e| e.to_string())?;

    if cloud_type == "PROJECT" {
        conn.execute(
            "INSERT INTO cloud_projects
             (beat_id, local_zip_path, manifest_json, source_size, source_modified_ms, uploaded_at)
             VALUES (?1,?2,?3,?4,?5,strftime('%s','now'))
             ON CONFLICT(beat_id) DO UPDATE SET
               local_zip_path=excluded.local_zip_path,
               manifest_json=excluded.manifest_json,
               source_size=excluded.source_size,
               source_modified_ms=excluded.source_modified_ms,
               uploaded_at=excluded.uploaded_at",
            params![
                beat.id,
                Option::<String>::None,
                response.to_string(),
                meta.len() as i64,
                modified_ms
            ],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM cloud_files WHERE beat_id=?1 AND file_type='PROJECT'",
            params![beat.id.clone()],
        ).map_err(|e| e.to_string())?;
    }

    let returned_cloud_file_id = if cloud_type == "PROJECT" {
        format!("PROJECT:{}", beat.id)
    } else {
        cloud_file_id
    };

    Ok(CloudFileUploadResult {
        cloud_file_id: returned_cloud_file_id,
        beat_id: beat.id,
        file_type: cloud_type,
        filename,
        original_size: meta.len(),
        part_count: parts.len(),
        telegram_file_id: first_file_id,
        telegram_message_id: first_message_id,
    })
}

/// Download a Telegram-backed file into an exact destination path.
/// The write is atomic-ish: curl writes to a sidecar temp file first and we
/// only replace/copy the destination after a non-empty download completes.
fn download_telegram_file_to_path(
    telegram_file_id: &str,
    user_id: &str,
    destination: &Path,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create download folder: {}", e))?;
    }

    let file_name = destination.file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("beat.audio");
    let tmp_path = destination.with_file_name(format!(".{}.beatgaler-download", file_name));
    let _ = std::fs::remove_file(&tmp_path);

    if let Some(message_id) = direct_message_id(telegram_file_id) {
        let bytes = direct_download_file(user_id, message_id, &tmp_path)?;
        if bytes == 0 {
            let _ = std::fs::remove_file(&tmp_path);
            return Err("BeatGaler Cloud returned an empty file.".to_string());
        }
    } else {
        return Err(
            "This asset still uses a legacy storage reference. Re-upload it through Galer Cloud."
                .to_string(),
        );
    }

    let downloaded_size = std::fs::metadata(&tmp_path)
        .map_err(|e| format!("Downloaded file is missing: {}", e))?
        .len();
    if downloaded_size == 0 {
        let _ = std::fs::remove_file(&tmp_path);
        return Err("Galer Storage returned an empty file.".to_string());
    }

    // rename is cheapest when possible. Fall back to copy for edge cases.
    let _ = std::fs::remove_file(destination);
    if std::fs::rename(&tmp_path, destination).is_err() {
        std::fs::copy(&tmp_path, destination)
            .map_err(|e| format!("Could not save downloaded beat to {}: {}", destination.display(), e))?;
        let _ = std::fs::remove_file(&tmp_path);
    }

    Ok(())
}

/// Downloads the main audio for a cloud-backed beat to its ORIGINAL library
/// location. This is the explicit "Make available offline" behavior only.
fn download_beat_from_telegram_inner(
    mut beat: BeatMeta,
    state: &tauri::State<SettingsState>,
) -> Result<BeatMeta, String> {
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("Galer Cloud is not connected. Connect it in Settings first.".to_string());
        }
    }

    let telegram_file_id = beat.telegram_file_id.clone()
        .ok_or_else(|| "This beat has no Cloud MASTER reference. Upload it first.".to_string())?;
    let user_id = ensure_beatgaler_user_id(state)?;

    let destination = if !beat.playback_path.is_empty() {
        PathBuf::from(&beat.playback_path)
    } else if !beat.mp3_path.is_empty() {
        PathBuf::from(&beat.mp3_path)
    } else if let Some(ref wav) = beat.wav_path {
        PathBuf::from(wav)
    } else {
        return Err("This beat has no local destination path.".to_string());
    };

    download_telegram_file_to_path(&telegram_file_id, &user_id, &destination)?;

    // Re-apply the current live BeatGaler metadata on explicit restore/export.
    if let Err(e) = write_id3_to(
        &destination,
        &beat.bpm,
        &beat.key,
        &beat.tags,
        beat.rating,
        beat.image_base64.as_deref(),
    ) {
        return Err(format!("Audio downloaded, but current BeatGaler metadata could not be embedded: {}", e));
    }
    if let Ok(mut tag) = Tag::read_from_path(&destination) {
        tag.set_title(beat.name.clone());
        tag.write_to_path(&destination, Version::Id3v23)
            .map_err(|e| format!("Audio downloaded, but title could not be embedded: {}", e))?;
    }

    beat.cloud_status = Some("SYNCED".to_string());
    Ok(beat)
}


fn offline_user_dir_component(user_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(user_id.as_bytes());
    format!("{:x}", hasher.finalize())[..24].to_string()
}

fn offline_cloud_fingerprint(conn: &Connection, beat: &BeatMeta) -> Result<String, String> {
    let master = beat.telegram_file_id.as_deref().unwrap_or("");
    if master.trim().is_empty() {
        return Err("This beat has no Cloud MASTER.".to_string());
    }

    let mut pieces = vec![format!("MASTER:{}", master)];
    let mut stmt = conn.prepare(
        "SELECT file_type, cloud_file_id, manifest_json FROM cloud_files WHERE beat_id=?1 AND status='SYNCED' ORDER BY file_type, cloud_file_id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![beat.id.clone()], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    }).map_err(|e| e.to_string())?;
    for row in rows {
        let (kind, cloud_id, manifest) = row.map_err(|e| e.to_string())?;
        pieces.push(format!("FILE:{}:{}:{}", kind, cloud_id, manifest));
    }
    if let Ok(project_manifest) = conn.query_row(
        "SELECT manifest_json FROM cloud_projects WHERE beat_id=?1",
        params![beat.id.clone()],
        |row| row.get::<_, String>(0),
    ) {
        pieces.push(format!("PROJECT:{}", project_manifest));
    }
    if let Ok((artwork_file_id, artwork_hash)) = conn.query_row(
        "SELECT artwork_telegram_file_id, artwork_hash FROM cloud_metadata WHERE beat_id=?1",
        params![beat.id.clone()],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
    ) {
        pieces.push(format!(
            "ARTWORK:{}:{}",
            artwork_file_id.unwrap_or_default(),
            artwork_hash.unwrap_or_default(),
        ));
    }

    let mut hasher = Sha256::new();
    for piece in pieces {
        hasher.update(piece.as_bytes());
        hasher.update([0]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn offline_record_valid(
    conn: &Connection,
    user_id: &str,
    beat: &BeatMeta,
) -> Result<Option<(String, String)>, String> {
    let row = conn.query_row(
        "SELECT master_path, cloud_fingerprint FROM offline_beats WHERE user_id=?1 AND beat_id=?2",
        params![user_id, beat.id.clone()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    let (master_path, stored_fingerprint) = match row {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let master_ok = std::fs::metadata(&master_path)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false);
    if !master_ok { return Ok(None); }
    let current_fingerprint = offline_cloud_fingerprint(conn, beat)?;
    if current_fingerprint != stored_fingerprint { return Ok(None); }
    Ok(Some((master_path, stored_fingerprint)))
}

fn offline_record_available(
    conn: &Connection,
    user_id: &str,
    beat_id: &str,
) -> Result<Option<(String, String)>, String> {
    let row = conn.query_row(
        "SELECT master_path, cloud_fingerprint FROM offline_beats WHERE user_id=?1 AND beat_id=?2",
        params![user_id, beat_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    let (master_path, fingerprint) = match row {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let master_ok = std::fs::metadata(&master_path)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false);
    if !master_ok { return Ok(None); }
    Ok(Some((master_path, fingerprint)))
}

fn offline_record_root(conn: &Connection, user_id: &str, beat_id: &str) -> Result<Option<String>, String> {
    match conn.query_row(
        "SELECT root_path FROM offline_beats WHERE user_id=?1 AND beat_id=?2",
        params![user_id, beat_id],
        |row| row.get::<_, String>(0),
    ) {
        Ok(root) => Ok(Some(root)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn clear_offline_record(conn: &Connection, user_id: &str, beat_id: &str, root: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM offline_beats WHERE user_id=?1 AND beat_id=?2",
        params![user_id, beat_id],
    ).map_err(|e| e.to_string())?;

    // cloud_projects.local_zip_path can point inside the durable Offline root.
    // Clear it only when it really belongs to this package.
    let project_local_path = conn.query_row(
        "SELECT local_zip_path FROM cloud_projects WHERE beat_id=?1",
        params![beat_id],
        |row| row.get::<_, Option<String>>(0),
    ).ok().flatten();
    if project_local_path.as_deref().map(|path| PathBuf::from(path).starts_with(root)).unwrap_or(false) {
        conn.execute(
            "UPDATE cloud_projects SET local_zip_path=NULL WHERE beat_id=?1",
            params![beat_id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn offline_snapshot_if_valid(
    conn: &Connection,
    user_id: &str,
    beat: &BeatMeta,
) -> Result<Option<BeatMeta>, String> {
    // Offline availability is a durable local promise. Never invalidate/delete
    // the package just because the current materialized cloud fingerprint is
    // temporarily incomplete or changed during reconnect. The stored fingerprint
    // is still retained for future refresh logic, but it is not permission to
    // make a user's pinned files disappear.
    if offline_record_available(conn, user_id, &beat.id)?.is_none() { return Ok(None); }
    let raw = conn.query_row(
        "SELECT beat_meta_json FROM offline_beats WHERE user_id=?1 AND beat_id=?2",
        params![user_id, beat.id.clone()],
        |row| row.get::<_, String>(0),
    ).map_err(|e| e.to_string())?;
    let durable: BeatMeta = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid offline beat metadata: {}", e))?;

    // Metadata keeps following the current SQLite materialized view while file
    // paths come from the durable Offline package. This prevents an old Offline
    // download from freezing name/BPM/key/tags/rating forever.
    let mut snapshot = beat.clone();
    snapshot.folder_path = durable.folder_path;
    snapshot.mp3_path = durable.mp3_path;
    snapshot.playback_path = durable.playback_path;
    snapshot.wav_path = durable.wav_path;
    snapshot.stems_path = durable.stems_path;
    snapshot.loop_path = durable.loop_path;
    snapshot.samples_path = durable.samples_path;
    snapshot.flp_path = durable.flp_path;
    snapshot.als_path = durable.als_path;
    snapshot.other_files = durable.other_files;
    snapshot.has_wav = durable.has_wav;
    snapshot.has_stems = durable.has_stems;
    snapshot.has_samples = durable.has_samples;
    snapshot.has_flp = durable.has_flp;
    snapshot.has_als = durable.has_als;
    snapshot.has_loop = durable.has_loop;
    if snapshot.image_base64.as_deref().map(|v| v.trim().is_empty()).unwrap_or(true) {
        snapshot.image_base64 = durable.image_base64;
    }
    snapshot.cloud_status = beat.cloud_status.clone().or_else(|| Some("CLOUD_ONLY".to_string()));
    snapshot.offline_available = true;
    Ok(Some(snapshot))
}

#[derive(Debug, Clone)]
struct OfflineCloudFileSource {
    cloud_file_id: String,
    file_type: String,
    filename: String,
    manifest: Value,
}

/// Download every durable slot for a beat into app_data/offline. This is NOT
/// cache: clear-cache/LRU never touches it, and the final marker is committed
/// only after the full offline package succeeds.
#[tauri::command(async)]
pub fn make_beat_available_offline(
    beat: BeatMeta,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<BeatMeta, String> {
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("BeatGaler is not connected to Galer Cloud.".to_string());
        }
    }
    let user_id = ensure_beatgaler_user_id(&state)?;

    let (mut current, sources, project_manifest, fingerprint, artwork_file_id) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // The Beat supplied by React is the authority for visible/current metadata.
        // SQLite may lag behind the UI during a recent edit, so it may only fill
        // operational cloud references that are genuinely missing from the live Beat.
        let mut current = beat.clone();
        if let Some(existing) = existing_beat_meta(&conn, &beat.id) {
            if current.telegram_file_id.as_deref().map(str::trim).filter(|v| !v.is_empty()).is_none() {
                current.telegram_file_id = existing.telegram_file_id;
            }
            if current.telegram_message_id.is_none() {
                current.telegram_message_id = existing.telegram_message_id;
            }
            if current.cloud_status.is_none() {
                current.cloud_status = existing.cloud_status;
            }
        }
        let fingerprint = offline_cloud_fingerprint(&conn, &current)?;
        let mut stmt = conn.prepare(
            "SELECT cloud_file_id, file_type, filename, manifest_json FROM cloud_files WHERE beat_id=?1 AND status='SYNCED' ORDER BY file_type, rowid"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![beat.id.clone()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        }).map_err(|e| e.to_string())?;
        let mut sources = Vec::new();
        for row in rows {
            let (cloud_file_id, file_type, filename, manifest_raw) = row.map_err(|e| e.to_string())?;
            let manifest = serde_json::from_str::<Value>(&manifest_raw)
                .map_err(|e| format!("Invalid {} Cloud manifest: {}", file_type, e))?;
            sources.push(OfflineCloudFileSource { cloud_file_id, file_type, filename, manifest });
        }
        let project_manifest = match conn.query_row(
            "SELECT manifest_json FROM cloud_projects WHERE beat_id=?1",
            params![beat.id.clone()],
            |row| row.get::<_, String>(0),
        ) {
            Ok(raw) => Some(serde_json::from_str::<Value>(&raw).map_err(|e| format!("Invalid PROJECT manifest: {}", e))?),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => return Err(error.to_string()),
        };
        let artwork_file_id = conn.query_row(
            "SELECT artwork_telegram_file_id FROM cloud_metadata WHERE beat_id=?1",
            params![beat.id.clone()],
            |row| row.get::<_, Option<String>>(0),
        ).ok().flatten();
        (current, sources, project_manifest, fingerprint, artwork_file_id)
    };

    let master_file_id = current.telegram_file_id.clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "This beat has no Cloud MASTER.".to_string())?;

    // Preserve the cover as part of the offline metadata snapshot. This avoids
    // any artwork network request when BeatGaler cold-starts with no internet.
    if current.image_base64.as_deref().map(|v| v.trim().is_empty()).unwrap_or(true) {
        if let Some(file_id) = artwork_file_id.filter(|value| !value.trim().is_empty()) {
            current.image_base64 = fetch_restored_artwork(&user_id, &file_id, None, &state.data_dir);
        }
    }

    let user_dir = offline_user_dir_component(&user_id);
    let beat_dir = safe_cloud_filename(&current.id);
    let offline_parent = state.data_dir.join("offline").join(user_dir);
    std::fs::create_dir_all(&offline_parent).map_err(|e| format!("Could not create offline storage: {}", e))?;
    let final_root = offline_parent.join(&beat_dir);
    let stage_root = offline_parent.join(format!(".{}.staging-{}", beat_dir, now_epoch()));
    let _ = std::fs::remove_dir_all(&stage_root);
    std::fs::create_dir_all(&stage_root).map_err(|e| format!("Could not create offline staging: {}", e))?;

    let result: Result<BeatMeta, String> = (|| {
        let master_rel = PathBuf::from("MASTER").join("master.mp3");
        let master_stage = stage_root.join(&master_rel);
        download_telegram_file_to_path(&master_file_id, &user_id, &master_stage)?;

        let mut wav_rel: Option<PathBuf> = None;
        let mut stems_rel: Option<PathBuf> = None;
        let mut loop_rel: Option<PathBuf> = None;
        let mut other_rels: Vec<PathBuf> = Vec::new();

        for source in &sources {
            // MASTER has its own canonical Telegram id and PROJECT has its own
            // cloud_projects row. Avoid duplicate copies if old DBs contain one.
            if source.file_type.eq_ignore_ascii_case("MASTER") || source.file_type.eq_ignore_ascii_case("PROJECT") {
                continue;
            }
            let parts = source.manifest.get("parts")
                .and_then(|value| value.as_array())
                .ok_or_else(|| format!("{} Cloud manifest has no parts.", source.file_type))?;
            if parts.is_empty() {
                return Err(format!("{} Cloud manifest is empty.", source.file_type));
            }
            let safe_kind = safe_cloud_filename(&source.file_type.to_ascii_uppercase());
            let safe_id = safe_cloud_filename(&source.cloud_file_id);
            let safe_name = Path::new(&source.filename)
                .file_name().and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .map(safe_cloud_filename)
                .unwrap_or_else(|| "file.bin".to_string());
            let rel = PathBuf::from("FILES").join(safe_kind).join(safe_id).join(safe_name);
            let destination = stage_root.join(&rel);
            download_project_parts_parallel(parts, &user_id, &destination)?;

            match source.file_type.to_ascii_uppercase().as_str() {
                "WAV" if wav_rel.is_none() => wav_rel = Some(rel),
                "STEMS" if stems_rel.is_none() => stems_rel = Some(rel),
                "LOOP" if loop_rel.is_none() => loop_rel = Some(rel),
                _ => other_rels.push(rel),
            }
        }

        let mut project_rel: Option<PathBuf> = None;
        if let Some(manifest) = project_manifest.as_ref() {
            let parts = manifest.get("parts")
                .and_then(|value| value.as_array())
                .ok_or_else(|| "PROJECT Cloud manifest has no parts.".to_string())?;
            if !parts.is_empty() {
                let rel = PathBuf::from("PROJECT").join(format!("{}.zip", safe_cloud_filename(&current.name)));
                let destination = stage_root.join(&rel);
                download_project_parts_parallel(parts, &user_id, &destination)?;
                if !project_zip_is_valid(&destination) {
                    return Err("Downloaded PROJECT is invalid.".to_string());
                }
                project_rel = Some(rel);
            }
        }

        // Atomic-ish publish: incomplete staging is never registered as offline.
        if final_root.exists() {
            std::fs::remove_dir_all(&final_root)
                .map_err(|e| format!("Could not replace old offline copy: {}", e))?;
        }
        std::fs::rename(&stage_root, &final_root)
            .map_err(|e| format!("Could not finalize offline copy: {}", e))?;

        current.folder_path = final_root.to_string_lossy().to_string();
        current.mp3_path = final_root.join(&master_rel).to_string_lossy().to_string();
        current.playback_path = current.mp3_path.clone();
        // Offline packages are self-contained. Never retain source-folder paths
        // from the online materialized view because those may disappear later.
        current.wav_path = None;
        current.stems_path = None;
        current.samples_path = None;
        current.flp_path = None;
        current.als_path = None;
        current.loop_path = None;
        current.other_files.clear();
        current.wav_path = wav_rel.as_ref().map(|rel| final_root.join(rel).to_string_lossy().to_string());
        if current.wav_path.is_some() { current.has_wav = true; }
        current.stems_path = stems_rel.as_ref().map(|rel| final_root.join(rel).to_string_lossy().to_string());
        if current.stems_path.is_some() { current.has_stems = true; }
        current.loop_path = loop_rel.as_ref().map(|rel| final_root.join(rel).to_string_lossy().to_string());
        if current.loop_path.is_some() { current.has_loop = true; }
        current.other_files = other_rels.iter().map(|rel| final_root.join(rel).to_string_lossy().to_string()).collect();
        if let Some(rel) = project_rel.as_ref() {
            let project_path = final_root.join(rel).to_string_lossy().to_string();
            let has_flp = project_manifest.as_ref().and_then(|m| m.get("has_flp")).and_then(|v| v.as_bool())
                .or_else(|| project_manifest.as_ref().and_then(|m| m.get("openable")).and_then(|v| v.as_bool()))
                .unwrap_or(current.has_flp);
            let has_als = project_manifest.as_ref().and_then(|m| m.get("has_als")).and_then(|v| v.as_bool()).unwrap_or(current.has_als);
            let has_samples = project_manifest.as_ref().and_then(|m| m.get("has_samples")).and_then(|v| v.as_bool()).unwrap_or(current.has_samples);
            current.has_flp = has_flp;
            current.has_als = has_als;
            current.has_samples = has_samples;
            if has_flp { current.flp_path = Some(project_path.clone()); }
            if has_als { current.als_path = Some(project_path.clone()); }
        }
        current.cloud_status = Some("CLOUD_ONLY".to_string());
        current.offline_available = true;

        let meta_json = serde_json::to_string(&current).map_err(|e| e.to_string())?;
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO offline_beats (user_id, beat_id, root_path, master_path, master_telegram_file_id, cloud_fingerprint, beat_meta_json, created_at)\n             VALUES (?1,?2,?3,?4,?5,?6,?7,strftime('%s','now'))\n             ON CONFLICT(user_id, beat_id) DO UPDATE SET\n               root_path=excluded.root_path, master_path=excluded.master_path, master_telegram_file_id=excluded.master_telegram_file_id,\n               cloud_fingerprint=excluded.cloud_fingerprint, beat_meta_json=excluded.beat_meta_json, created_at=excluded.created_at",
            params![
                user_id.clone(), current.id.clone(), final_root.to_string_lossy().to_string(), current.mp3_path.clone(),
                master_file_id.clone(), fingerprint.clone(), meta_json,
            ],
        ).map_err(|e| e.to_string())?;

        if let Some(rel) = project_rel.as_ref() {
            let project_path = final_root.join(rel);
            if let Some((size, modified_ms)) = project_file_stamp(&project_path) {
                conn.execute(
                    "UPDATE cloud_projects SET local_zip_path=?2, source_size=?3, source_modified_ms=?4 WHERE beat_id=?1",
                    params![current.id.clone(), project_path.to_string_lossy().to_string(), size as i64, modified_ms],
                ).map_err(|e| e.to_string())?;
            }
        }

        Ok(current.clone())
    })();

    if result.is_err() {
        let _ = std::fs::remove_dir_all(&stage_root);
    }
    result
}

#[tauri::command]
pub fn remove_beat_offline_availability(
    beat_id: String,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<(), String> {
    let user_id = ensure_beatgaler_user_id(&state)?;
    let root = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        offline_record_root(&conn, &user_id, &beat_id)?
    };

    // Delete the durable package before forgetting it in SQLite. If Windows
    // still has the MASTER/PROJECT open, return the real error instead of
    // claiming the beat is no longer Offline while leaving its files behind.
    // The frontend releases an actively-playing beat before this command.
    if let Some(ref root_path) = root {
        match std::fs::remove_dir_all(root_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not remove Offline files: {}", error)),
        }

        let conn = db.0.lock().map_err(|e| e.to_string())?;
        clear_offline_record(&conn, &user_id, &beat_id, root_path)?;
    }
    Ok(())
}

#[tauri::command]
pub fn record_offline_trash_intent(
    beat_id: String,
    settings: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<(), String> {
    let user_id = ensure_beatgaler_user_id(&settings)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO offline_trash_intents (user_id, beat_id, created_at) VALUES (?1,?2,strftime('%s','now')) ON CONFLICT(user_id, beat_id) DO UPDATE SET created_at=excluded.created_at",
        params![user_id, beat_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn flush_offline_trash_intents(
    settings: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<usize, String> {
    let user_id = ensure_beatgaler_user_id(&settings)?;
    let beat_ids: Vec<String> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT beat_id FROM offline_trash_intents WHERE user_id=?1 ORDER BY created_at, beat_id"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![user_id.clone()], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|row| row.ok()).collect()
    };
    if beat_ids.is_empty() { return Ok(0); }

    // Reconcile against the CURRENT Telegram manifest through the active
    // transport bot. This preserves newer edits from another online device and
    // keeps MASTER completely out of index bytes.
    direct_move_beats_to_trash(&user_id, &beat_ids)?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for beat_id in &beat_ids {
        conn.execute(
            "DELETE FROM offline_trash_intents WHERE user_id=?1 AND beat_id=?2",
            params![user_id.clone(), beat_id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(beat_ids.len())
}

#[tauri::command]
pub fn load_offline_library(
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<Vec<BeatMeta>, String> {
    let user_id = settings.settings.lock().map_err(|e| e.to_string())?
        .beatgaler_user_id.clone().unwrap_or_default();
    if user_id.trim().is_empty() { return Ok(Vec::new()); }

    let conn = state.0.lock().map_err(|e| e.to_string())?;

    // Offline pins are the source of truth for a cold disconnected start. Do
    // NOT require the ordinary `beats` materialized view to still contain the
    // row: that view is cache and may have been cleared/rebuilt independently.
    // The durable snapshot + non-empty pinned MASTER is enough offline. When a
    // successful online restore later gives us current cloud metadata, the
    // fingerprint is retained as change-detection data. A durable Offline pin
    // is never deleted automatically; it stays usable until the user removes it
    // or a future refresh explicitly replaces it.
    let mut stmt = conn.prepare(
        "SELECT beat_id, master_path, master_telegram_file_id, beat_meta_json, created_at \
         FROM offline_beats WHERE user_id=?1 ORDER BY created_at, beat_id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![user_id.clone()], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
        ))
    }).map_err(|e| e.to_string())?;

    let mut pinned = Vec::<(String, String, String, String, i64)>::new();
    for row in rows { pinned.push(row.map_err(|e| e.to_string())?); }
    drop(stmt);

    let mut beats = Vec::<(i64, BeatMeta)>::new();
    for (beat_id, master_path, master_file_id, raw_meta, created_at) in pinned {
        let master_ok = std::fs::metadata(&master_path)
            .map(|meta| meta.is_file() && meta.len() > 0)
            .unwrap_or(false);
        if !master_ok { continue; }

        let durable: BeatMeta = match serde_json::from_str(&raw_meta) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("Ignoring invalid Offline snapshot for {}: {}", beat_id, error);
                continue;
            }
        };

        let current = existing_beat_meta(&conn, &beat_id);
        let mut offline = if let Some(current) = current.as_ref().filter(|beat| is_cloud_backed(beat)) {
            // If the full current cloud view exists, use its newer lightweight
            // metadata while keeping durable file paths from the Offline package.
            // A known fingerprint mismatch is authoritative and must not expose
            // the old package. Missing ordinary cache rows are handled by the
            // durable-snapshot branch below.
            let Some(snapshot) = offline_snapshot_if_valid(&conn, &user_id, current)? else { continue; };
            snapshot
        } else {
            durable.clone()
        };

        // The durable record owns playback during Offline mode regardless of
        // whatever transient/cache paths may be present in an old snapshot.
        offline.id = beat_id.clone();
        offline.mp3_path = master_path.clone();
        offline.playback_path = master_path;
        offline.telegram_file_id = Some(master_file_id);
        offline.cloud_status = Some("CLOUD_ONLY".to_string());
        offline.offline_available = true;

        let order = conn.query_row(
            "SELECT sort_order FROM beats WHERE id=?1",
            params![beat_id],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(created_at);
        beats.push((order, offline));
    }

    beats.sort_by_key(|(order, _)| *order);
    Ok(beats.into_iter().map(|(_, beat)| beat).collect())
}

/// Manual cloud restore / "make available offline".
#[tauri::command]
pub fn download_beat_from_telegram(
    beat: BeatMeta,
    _state: tauri::State<SettingsState>,
    _db: tauri::State<DbState>,
) -> Result<BeatMeta, String> {
    let _ = beat;
    Err("Offline restore was removed. BeatGaler only uses temporary cache.".to_string())
}

/// Cloud-first playback.
///
/// - If a private cached MASTER exists, use it directly.
/// - Otherwise return a Range-capable cloud stream URL immediately; Play never
///   waits for the full MP3 download.
/// - The original beat folder stays untouched and transient playback URLs are
///   never persisted to SQLite, so Telegram remains the source of truth.
#[tauri::command(async)]
pub fn prepare_beat_for_playback(
    beat: BeatMeta,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<BeatMeta, String> {
    // BeatGaler playback invariant: PLAY always means MASTER MP3.
    // WAV is an HQ/archive slot only and is never returned as playback_path.

    // Explicit Offline pins outrank temporary cache and network streaming.
    // "Available offline" is a durable local promise: reconnect/cloud metadata
    // churn must never make the locked MASTER disappear unexpectedly.
    if beat.telegram_file_id.is_some() {
        let user_id = state.settings.lock().map_err(|e| e.to_string())?
            .beatgaler_user_id.clone().unwrap_or_default();
        if !user_id.trim().is_empty() {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            if let Some((master_path, _)) = offline_record_available(&conn, &user_id, &beat.id)? {
                let mut ready = beat;
                ready.playback_path = master_path.clone();
                ready.mp3_path = master_path;
                ready.offline_available = true;
                return Ok(ready);
            }
        }
    }

    // Once a Cloud MASTER exists, it is authoritative even if a local WAV is
    // still present. Replacing MASTER changes telegram_file_id, which naturally
    // gives the cache a new key and prevents stale playback.
    if let Some(_telegram_file_id) = beat.telegram_file_id.clone() {
        // Play is a priority signal, not a network setup step. The same cooker
        // that started when the card became visible is promoted to HOT and the
        // HTML5 player receives a local URL immediately.
        let Some((cache_key, port)) = cooking_enqueue(&beat, &state, true)? else {
            return Err("Galer Cloud is not connected. Connect it in Settings first.".to_string());
        };
        let mut ready = beat;
        ready.playback_path = format!("http://127.0.0.1:{}/play/{}", port, cache_key);
        ready.cloud_status = Some("CLOUD_ONLY".to_string());
        return Ok(ready);
    }

    // Before the first Cloud upload finishes, an existing MP3 may be played
    // locally. Do not fall back to WAV.
    if !beat.mp3_path.trim().is_empty() {
        let mp3 = PathBuf::from(&beat.mp3_path);
        if std::fs::metadata(&mp3).map(|m| m.is_file() && m.len() > 0).unwrap_or(false) {
            let mut ready = beat;
            ready.playback_path = mp3.to_string_lossy().to_string();
            return Ok(ready);
        }
    }

    // WAV-only import that is still pending Cloud: create a private TEMP MP3
    // using the same encoder as the upload path. The original WAV is never used
    // as the audio element source.
    if let Some(wav_raw) = beat.wav_path.as_ref().filter(|p| !p.trim().is_empty()) {
        let wav = PathBuf::from(wav_raw);
        if std::fs::metadata(&wav).map(|m| m.is_file() && m.len() > 0).unwrap_or(false) {
            let temp_mp3 = convert_wav_to_cloud_master_mp3(&beat, &wav)
                .map_err(|e| format!("Could not prepare MASTER MP3 for playback: {}", e))?;
            let mut ready = beat;
            ready.playback_path = temp_mp3.to_string_lossy().to_string();
            return Ok(ready);
        }
    }

    Err("This beat has no playable MASTER MP3 and no readable WAV from which BeatGaler can create one.".to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectCloudStatus {
    pub synced: bool,
    pub valid: bool,
    pub state: String,
    pub local_zip_path: Option<String>,
    pub local_exists: bool,
    pub needs_sync: bool,
    pub part_count: usize,
}

fn project_file_stamp(path: &Path) -> Option<(u64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() { return None; }
    let modified_ms = meta.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some((meta.len(), modified_ms))
}

fn project_zip_candidate(beat: &BeatMeta) -> Option<PathBuf> {
    // Prefer flp_path when the scanner identified a ZIP project archive.
    if let Some(ref p) = beat.flp_path {
        let path = PathBuf::from(p);
        if path.exists() && path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false) {
            return Some(path);
        }
    }

    let folder = PathBuf::from(&beat.folder_path);
    if !folder.is_dir() { return None; }
    let beat_name = beat.name.to_lowercase();
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&folder).ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false))
        .filter(|p| !p.file_name().unwrap_or_default().to_string_lossy().to_lowercase().contains("stem"))
        .collect();
    candidates.sort_by_key(|p| {
        let n = p.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
        if n.contains(&beat_name) { 0 } else { 1 }
    });
    candidates.into_iter().next()
}


fn safe_cloud_filename(value: &str) -> String {
    let cleaned: String = value.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "project".to_string()
    } else if is_windows_reserved_component(trimmed) {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    }
}

/// Returns (archive_path, generated_temporarily).
/// If no project ZIP exists, BeatGaler packages the work assets that belong
/// to PROJECT: one recognized project file plus its asset folders. Backup/Backups is forbidden.
/// MASTER audio is deliberately excluded.
fn find_root_project_for_beat(folder: &Path, beat_name: &str) -> Option<PathBuf> {
    let clean_target = clean_name_from_filename(beat_name);
    let (target_core, _) = matcher::normalize_core_name(&clean_target);
    let mut candidates: Vec<(i32, String, PathBuf)> = Vec::new();

    for entry in std::fs::read_dir(folder).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "flp" | "als") { continue; }

        let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
        let clean = clean_name_from_filename(stem);
        let (core, _) = matcher::normalize_core_name(&clean);
        let score = if core == target_core { 1000 }
            else if !target_core.is_empty() && (core.starts_with(&target_core) || target_core.starts_with(&core)) { 800 }
            else { 0 };
        candidates.push((score, stem.to_ascii_lowercase(), path));
    }

    candidates.sort_by(|a,b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())));
    candidates.into_iter().find(|(score,_,_)| *score > 0).map(|(_,_,p)| p)
}

fn build_project_archive_if_needed(
    beat: &BeatMeta,
    data_dir: &Path,
) -> Result<(PathBuf, bool), String> {
    if let Some(existing) = project_zip_candidate(beat) {
        return Ok((existing, false));
    }

    let folder = PathBuf::from(&beat.folder_path);
    if !folder.is_dir() {
        return Err("No local project folder is available to package.".to_string());
    }

    if !folder_has_project_assets(&folder) {
        return Err("No PROJECT project file was found. Add a .flp/.als/.logicx/.ptx/.ptf first.".to_string());
    }

    let root = beatgaler_temp_dir().join("cloud-upload-tmp").join("generated-projects");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let unique = format!("{}-{}", safe_cloud_filename(&beat.id), now_epoch());
    let staging = root.join(format!("{}-staging", unique));
    let archive = root.join(format!("{}.zip", safe_cloud_filename(&beat.name)));

    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&archive);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    // Project files and FL Studio support archives.
    for entry in std::fs::read_dir(&folder).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue; };
        if file_type.is_symlink() || !file_type.is_file() { continue; }
        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        if matches!(ext.as_str(), "flp" | "als" | "ptx" | "ptf" | "zpa") {
            std::fs::copy(&path, staging.join(entry.file_name())).map_err(|e| e.to_string())?;
        }
    }

    // Standard project asset folders. Do not include the MASTER MP3/WAV because
    // Telegram stores it independently as the MASTER cloud slot.
    for entry in std::fs::read_dir(&folder).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue; };
        if file_type.is_symlink() || !file_type.is_dir() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if matches!(lower.as_str(), "backup" | "backups") {
            continue;
        }
        if matches!(lower.as_str(), "audio" | "sample" | "samples")
            || path.extension().and_then(|v| v.to_str()).map(is_recognized_project_extension).unwrap_or(false)
        {
            copy_project_dir_filtered(&path, &staging.join(&name))?;
        }
    }

    if !folder_has_project_assets(&staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("PROJECT staging contains no recognized project file.".to_string());
    }

    // One Rust implementation on every desktop OS. The staging tree has
    // already selected PROJECT assets and removed Backup/Backups; package its
    // contents directly so Windows and macOS produce the same archive layout.
    if let Err(error) = write_project_directory_zip(&staging, &archive) {
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::remove_file(&archive);
        return Err(error);
    }

    let _ = std::fs::remove_dir_all(&staging);
    if !archive.is_file() || std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = std::fs::remove_file(&archive);
        return Err("BeatGaler created an empty project archive.".to_string());
    }

    Ok((archive, true))
}


fn is_forbidden_project_component(name: &str) -> bool {
    matches!(name.trim().to_ascii_lowercase().as_str(), "backup" | "backups")
}

fn path_is_symbolic_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn is_recognized_project_extension(ext: &str) -> bool {
    matches!(ext.trim().trim_start_matches('.').to_ascii_lowercase().as_str(),
        "flp" | "als" | "logicx" | "ptx" | "ptf")
}

fn path_is_recognized_project_file(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .map(is_recognized_project_extension)
        .unwrap_or(false)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectDropInspection {
    pub kind: String,
    pub valid: bool,
    pub reason: Option<String>,
    #[serde(default)]
    pub has_backups: bool,
    #[serde(default)]
    pub project_file_count: usize,
    #[serde(default)]
    pub entry_count: usize,
}

fn folder_contains_backup_component(folder: &Path) -> bool {
    if !folder.is_dir() { return false; }
    WalkDir::new(folder)
        .min_depth(0)
        .into_iter()
        .filter_map(Result::ok)
        .any(|entry| {
            entry.path().components().any(|component| {
                component.as_os_str().to_str().map(is_forbidden_project_component).unwrap_or(false)
            })
        })
}

fn project_zip_entry_names(path: &Path) -> Result<Vec<String>, String> {
    if !path.is_file() {
        return Err("ZIP file does not exist.".to_string());
    }

    let file = std::fs::File::open(path)
        .map_err(|e| format!("Could not open PROJECT ZIP: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Could not inspect PROJECT ZIP: {}", e))?;
    let mut entries = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive.by_index(index)
            .map_err(|e| format!("Could not read PROJECT ZIP entry {}: {}", index, e))?;
        let name = entry.name().replace('\\', "/").trim_start_matches('/').trim().to_string();
        if !name.is_empty() { entries.push(name); }
    }
    if entries.is_empty() { return Err("The ZIP contains no entries.".to_string()); }
    Ok(entries)
}

fn validate_project_zip_entry_names(entries: &[String]) -> Result<(), String> {
    const MAX_PROJECT_ZIP_ENTRIES: usize = 100_000;
    if entries.is_empty() { return Err("The PROJECT ZIP contains no entries.".to_string()); }
    if entries.len() > MAX_PROJECT_ZIP_ENTRIES {
        return Err("The PROJECT ZIP contains too many files.".to_string());
    }
    for raw in entries {
        if raw.contains('\0') { return Err("The PROJECT ZIP contains an invalid path.".to_string()); }
        let normalized = raw.replace('\\', "/");
        let trimmed = normalized.trim();
        if trimmed.is_empty() { continue; }
        if trimmed.starts_with('/') || trimmed.starts_with("//") {
            return Err("The PROJECT ZIP contains an unsafe absolute path.".to_string());
        }
        let first = trimmed.split('/').next().unwrap_or("");
        if first.len() >= 2 && first.as_bytes().get(1) == Some(&b':') {
            return Err("The PROJECT ZIP contains an unsafe drive path.".to_string());
        }
        if trimmed.split('/').any(|part| part == "..") {
            return Err("The PROJECT ZIP contains an unsafe parent path.".to_string());
        }
    }
    Ok(())
}

fn inspect_project_zip_entries(entries: &[String]) -> (bool, usize, bool, bool) {
    let mut project_file_count = 0usize;
    let mut has_backups = false;
    let mut has_flp = false;
    let mut has_als = false;

    for raw in entries {
        let normalized = raw.replace('\\', "/").trim_start_matches('/').to_string();
        if normalized.is_empty() { continue; }
        let parts = normalized.split('/').filter(|p| !p.is_empty()).collect::<Vec<_>>();
        if parts.iter().any(|part| is_forbidden_project_component(part)) {
            has_backups = true;
            // A project file that exists only inside Backup/Backups is not a
            // valid primary project file because that whole tree will be skipped.
            continue;
        }

        let lower = normalized.to_ascii_lowercase();
        let logic_bundle = parts.iter().any(|part| part.to_ascii_lowercase().ends_with(".logicx"));
        let recognized = logic_bundle
            || lower.ends_with(".flp")
            || lower.ends_with(".als")
            || lower.ends_with(".ptx")
            || lower.ends_with(".ptf");
        if recognized {
            project_file_count += 1;
            if lower.ends_with(".flp") { has_flp = true; }
            if lower.ends_with(".als") { has_als = true; }
        }
    }

    (has_backups, project_file_count, has_flp, has_als)
}

#[tauri::command]
pub fn inspect_project_drop_source(source_path: String) -> ProjectDropInspection {
    let source = PathBuf::from(source_path);
    let invalid = |kind: &str, reason: String, has_backups: bool, project_file_count: usize, entry_count: usize| ProjectDropInspection {
        kind: kind.to_string(),
        valid: false,
        reason: Some(reason),
        has_backups,
        project_file_count,
        entry_count,
    };
    let valid = |kind: &str, has_backups: bool, project_file_count: usize, entry_count: usize| ProjectDropInspection {
        kind: kind.to_string(),
        valid: true,
        reason: None,
        has_backups,
        project_file_count,
        entry_count,
    };

    if path_is_symbolic_link(&source) {
        return invalid(
            "symlink",
            "Symbolic links are not imported. Drop the original project file or folder instead.".to_string(),
            false,
            0,
            0,
        );
    }
    if !source.exists() {
        return invalid("unsupported", "The dropped file or folder no longer exists.".to_string(), false, 0, 0);
    }

    if source.is_dir() {
        let name = source.file_name().and_then(|v| v.to_str()).unwrap_or("");
        let has_backups = folder_contains_backup_component(&source);
        if is_forbidden_project_component(name) {
            return invalid(
                "folder",
                "This Backup folder was skipped. BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.".to_string(),
                true,
                0,
                0,
            );
        }
        // Logic Pro .logicx projects are directory bundles on macOS.
        if source.extension().and_then(|v| v.to_str()).map(is_recognized_project_extension).unwrap_or(false) {
            return valid("project_file", has_backups, 1, 1);
        }
        return valid("folder", has_backups, 0, 0);
    }

    let ext = source.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext == "zip" {
        let entries = match project_zip_entry_names(&source) {
            Ok(entries) => entries,
            Err(error) => {
                return invalid(
                    "zip",
                    format!("BeatGaler could not read the ZIP file list: {}", error),
                    false,
                    0,
                    0,
                );
            }
        };
        let (has_backups, project_file_count, _, _) = inspect_project_zip_entries(&entries);
        if project_file_count == 0 {
            return invalid(
                "zip",
                "A PROJECT ZIP needs at least one .flp, .als, .logicx, .ptx, or .ptf project file.".to_string(),
                false,
                0,
                entries.len(),
            );
        }
        return valid("zip", has_backups, project_file_count, entries.len());
    }
    if is_recognized_project_extension(&ext) {
        return valid("project_file", false, 1, 1);
    }

    invalid("unsupported", "This file type is not a supported BeatGaler project asset.".to_string(), false, 0, 0)
}

fn copy_project_dir_filtered(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let src_path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() && matches!(name.trim().to_ascii_lowercase().as_str(), "backup" | "backups") {
            continue;
        }
        let dest_path = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_project_dir_filtered(&src_path, &dest_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&src_path, &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn folder_has_project_assets(folder: &Path) -> bool {
    if !folder.is_dir() { return false; }
    let Ok(rd) = std::fs::read_dir(folder) else { return false; };
    for entry in rd.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue; };
        if file_type.is_symlink() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if is_forbidden_project_component(&name) { continue; }
            if path.extension().and_then(|v| v.to_str()).map(is_recognized_project_extension).unwrap_or(false) {
                return true;
            }
            continue;
        }
        if !file_type.is_file() { continue; }
        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        if is_recognized_project_extension(&ext) {
            return true;
        }
    }
    false
}


fn normalized_zip_name(raw: &str) -> String {
    raw.replace('\\', "/").trim_start_matches('/').to_string()
}

fn zip_name_has_forbidden_component(raw: &str) -> bool {
    normalized_zip_name(raw)
        .split('/')
        .filter(|part| !part.is_empty())
        .any(is_forbidden_project_component)
}

fn zip_name_contains_project_component(raw: &str) -> bool {
    normalized_zip_name(raw)
        .split('/')
        .filter(|part| !part.is_empty())
        .any(|part| {
            Path::new(part)
                .extension()
                .and_then(|value| value.to_str())
                .map(is_recognized_project_extension)
                .unwrap_or(false)
        })
}

fn zip_name_starts_with_case_insensitive(raw: &str, prefix: &str) -> bool {
    normalized_zip_name(raw)
        .to_ascii_lowercase()
        .starts_with(&prefix.to_ascii_lowercase())
}

fn project_zip_file_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

fn project_zip_dir_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o755)
}

fn copy_project_zip_entries<F>(
    source_zip: &Path,
    writer: &mut zip::ZipWriter<std::fs::File>,
    mut exclude: F,
) -> Result<(), String>
where
    F: FnMut(&str) -> bool,
{
    if !source_zip.is_file() { return Ok(()); }
    let names = project_zip_entry_names(source_zip)?;
    validate_project_zip_entry_names(&names)?;

    let file = std::fs::File::open(source_zip)
        .map_err(|e| format!("Could not open existing PROJECT ZIP: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Could not read existing PROJECT ZIP: {}", e))?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)
            .map_err(|e| format!("Could not read PROJECT ZIP entry {}: {}", index, e))?;
        let name = normalized_zip_name(entry.name());
        if name.is_empty() || exclude(&name) { continue; }
        if entry.is_dir() || name.ends_with('/') {
            let directory = if name.ends_with('/') { name } else { format!("{}/", name) };
            writer.add_directory(directory, project_zip_dir_options())
                .map_err(|e| format!("Could not copy PROJECT ZIP directory: {}", e))?;
            continue;
        }
        writer.start_file(name, project_zip_file_options())
            .map_err(|e| format!("Could not copy PROJECT ZIP file: {}", e))?;
        std::io::copy(&mut entry, writer)
            .map_err(|e| format!("Could not copy PROJECT ZIP payload: {}", e))?;
    }
    Ok(())
}

fn relative_zip_path(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or_else(|| "PROJECT contains a filename that is not valid Unicode.".to_string())?;
    Ok(text.replace('\\', "/"))
}

fn add_project_source_to_zip(
    writer: &mut zip::ZipWriter<std::fs::File>,
    source: &Path,
    prefix: &str,
) -> Result<(), String> {
    if path_is_symbolic_link(source) {
        return Err("Symbolic links are not imported. Drop the original project file or folder instead.".to_string());
    }
    if !source.exists() {
        return Err("The PROJECT source no longer exists.".to_string());
    }

    if source.is_file() {
        let filename = source.file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "PROJECT filename is not valid Unicode.".to_string())?;
        if is_forbidden_project_component(filename) {
            return Err("This Backup folder was skipped so old project copies are not uploaded.".to_string());
        }
        let entry_name = format!("{}{}", prefix, filename);
        writer.start_file(entry_name, project_zip_file_options())
            .map_err(|e| format!("Could not add PROJECT file to ZIP: {}", e))?;
        let mut input = std::fs::File::open(source)
            .map_err(|e| format!("Could not open PROJECT source file: {}", e))?;
        std::io::copy(&mut input, writer)
            .map_err(|e| format!("Could not write PROJECT source file: {}", e))?;
        return Ok(());
    }

    if !source.is_dir() {
        return Err("PROJECT source must be a file or folder.".to_string());
    }
    let root_name = source.file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "PROJECT folder name is not valid Unicode.".to_string())?;
    if is_forbidden_project_component(root_name) {
        return Err("This Backup folder was skipped so old project copies are not uploaded.".to_string());
    }

    let walker = WalkDir::new(source).follow_links(false).into_iter().filter_entry(|entry| {
        if entry.depth() == 0 { return true; }
        if entry.file_type().is_symlink() { return false; }
        !is_forbidden_project_component(&entry.file_name().to_string_lossy())
    });

    for item in walker {
        let entry = item.map_err(|e| format!("Could not read PROJECT folder: {}", e))?;
        if entry.depth() == 0 || entry.file_type().is_symlink() { continue; }
        let relative = entry.path().strip_prefix(source)
            .map_err(|e| format!("Could not calculate PROJECT ZIP path: {}", e))?;
        let relative = relative_zip_path(relative)?;
        if relative.is_empty() { continue; }
        let entry_name = format!("{}{}", prefix, relative);
        if entry.file_type().is_dir() {
            writer.add_directory(format!("{}/", entry_name.trim_end_matches('/')), project_zip_dir_options())
                .map_err(|e| format!("Could not add PROJECT directory to ZIP: {}", e))?;
        } else if entry.file_type().is_file() {
            writer.start_file(entry_name, project_zip_file_options())
                .map_err(|e| format!("Could not add PROJECT file to ZIP: {}", e))?;
            let mut input = std::fs::File::open(entry.path())
                .map_err(|e| format!("Could not open PROJECT asset: {}", e))?;
            std::io::copy(&mut input, writer)
                .map_err(|e| format!("Could not write PROJECT asset: {}", e))?;
        }
    }
    Ok(())
}

fn write_project_directory_zip(source_dir: &Path, destination_zip: &Path) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Err("PROJECT source directory does not exist.".to_string());
    }
    if let Some(parent) = destination_zip.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not prepare PROJECT ZIP folder: {}", e))?;
    }
    let temp = destination_zip.with_file_name(format!(".beatgaler-project-write-{}.zip", new_cloud_file_id()));
    let result = (|| -> Result<(), String> {
        let output = std::fs::File::create(&temp)
            .map_err(|e| format!("Could not create PROJECT ZIP: {}", e))?;
        let mut writer = zip::ZipWriter::new(output);
        add_project_source_to_zip(&mut writer, source_dir, "")?;
        writer.finish().map_err(|e| format!("Could not finish PROJECT ZIP: {}", e))?;
        let entries = project_zip_entry_names(&temp)?;
        validate_project_zip_entry_names(&entries)?;
        let (_has_backups, project_count, _, _) = inspect_project_zip_entries(&entries);
        if project_count == 0 {
            return Err("PROJECT ZIP contains no supported project file.".to_string());
        }
        replace_project_zip_file(&temp, destination_zip)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result
}

fn extract_project_zip_to_directory(source_zip: &Path, destination_dir: &Path) -> Result<(), String> {
    let names = project_zip_entry_names(source_zip)?;
    validate_project_zip_entry_names(&names)?;
    if destination_dir.exists() {
        std::fs::remove_dir_all(destination_dir)
            .map_err(|e| format!("Could not reset PROJECT edit folder: {}", e))?;
    }
    std::fs::create_dir_all(destination_dir)
        .map_err(|e| format!("Could not create PROJECT edit folder: {}", e))?;

    let file = std::fs::File::open(source_zip)
        .map_err(|e| format!("Could not open PROJECT ZIP: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Could not read PROJECT ZIP: {}", e))?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)
            .map_err(|e| format!("Could not read PROJECT ZIP entry {}: {}", index, e))?;
        if entry.unix_mode().map(|mode| mode & 0o170000 == 0o120000).unwrap_or(false) {
            // Never materialize archive symlinks. This avoids an extracted path
            // escaping the edit root on Unix-like filesystems.
            continue;
        }
        let name = normalized_zip_name(entry.name());
        if name.is_empty() || zip_name_has_forbidden_component(&name) { continue; }
        let relative = PathBuf::from(&name);
        let out = destination_dir.join(&relative);
        if entry.is_dir() || name.ends_with('/') {
            std::fs::create_dir_all(&out).map_err(|e| format!("Could not create PROJECT directory: {}", e))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Could not create PROJECT directory: {}", e))?;
        }
        let mut output = std::fs::File::create(&out)
            .map_err(|e| format!("Could not extract PROJECT file '{}': {}", name, e))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|e| format!("Could not extract PROJECT payload '{}': {}", name, e))?;
    }
    Ok(())
}

fn project_edit_root(beat: &BeatMeta) -> PathBuf {
    beatgaler_temp_dir().join("project-edits").join(safe_cloud_filename(&beat.id))
}

fn project_edit_stamp_path(beat: &BeatMeta) -> PathBuf {
    beatgaler_temp_dir().join("project-edits").join(format!("{}.stamp", safe_cloud_filename(&beat.id)))
}

fn project_archive_stamp(path: &Path) -> Result<String, String> {
    let (size, modified_ms) = project_file_stamp(path)
        .ok_or_else(|| "Could not read PROJECT ZIP metadata.".to_string())?;
    Ok(format!("{}:{}", size, modified_ms))
}

fn invalidate_project_edit_copy(beat: &BeatMeta) {
    let _ = std::fs::remove_dir_all(project_edit_root(beat));
    let _ = std::fs::remove_file(project_edit_stamp_path(beat));
}

fn find_openable_project_in_directory(root: &Path, beat_name: &str) -> Option<PathBuf> {
    let (target_core, _) = matcher::normalize_core_name(&clean_name_from_filename(beat_name));
    let mut candidates: Vec<(i32, usize, String, PathBuf)> = Vec::new();
    for item in WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok) {
        if item.depth() == 0 || item.file_type().is_symlink() { continue; }
        let path = item.path();
        let recognized = path.extension().and_then(|v| v.to_str()).map(is_recognized_project_extension).unwrap_or(false);
        if !recognized { continue; }
        let is_logic_bundle = path.is_dir() && path.extension().and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case("logicx")).unwrap_or(false);
        if !(path.is_file() || is_logic_bundle) { continue; }
        if path.components().any(|component| component.as_os_str().to_str().map(is_forbidden_project_component).unwrap_or(false)) { continue; }
        let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
        let (core, _) = matcher::normalize_core_name(&clean_name_from_filename(stem));
        let score = if !target_core.is_empty() && core == target_core { 1000 }
            else if !target_core.is_empty() && (core.starts_with(&target_core) || target_core.starts_with(&core)) { 800 }
            else { 0 };
        candidates.push((score, item.depth(), path.to_string_lossy().to_lowercase(), path.to_path_buf()));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.cmp(&b.2)));
    candidates.into_iter().next().map(|(_, _, _, path)| path)
}

fn prepare_project_edit_copy(beat: &BeatMeta, archive_path: &Path) -> Result<PathBuf, String> {
    let edit_root = project_edit_root(beat);
    let stamp_path = project_edit_stamp_path(beat);
    let archive_stamp = project_archive_stamp(archive_path)?;
    let existing_stamp = std::fs::read_to_string(&stamp_path).ok();

    // Reuse the extracted tree while the source archive has not changed. This
    // intentionally preserves unsynced DAW saves between Open Project clicks.
    if edit_root.is_dir() && existing_stamp.as_deref() == Some(archive_stamp.as_str()) {
        if let Some(project) = find_openable_project_in_directory(&edit_root, &beat.name) {
            return Ok(project);
        }
    }

    let parent = edit_root.parent().ok_or_else(|| "PROJECT edit folder has no parent.".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Could not prepare PROJECT edit storage: {}", e))?;
    let staging = parent.join(format!(".{}-extract-{}", safe_cloud_filename(&beat.id), new_cloud_file_id()));
    let _ = std::fs::remove_dir_all(&staging);
    extract_project_zip_to_directory(archive_path, &staging)?;
    let project = find_openable_project_in_directory(&staging, &beat.name)
        .ok_or_else(|| "PROJECT ZIP contains no openable .flp/.als/.logicx/.ptx/.ptf file.".to_string())?;
    let rel = project.strip_prefix(&staging).map_err(|e| e.to_string())?.to_path_buf();
    let _ = std::fs::remove_dir_all(&edit_root);
    std::fs::rename(&staging, &edit_root)
        .map_err(|e| format!("Could not activate PROJECT edit folder: {}", e))?;
    std::fs::write(&stamp_path, archive_stamp.as_bytes())
        .map_err(|e| format!("Could not save PROJECT edit marker: {}", e))?;
    Ok(edit_root.join(rel))
}

fn repack_project_edit_copy_if_present(beat: &BeatMeta, archive_path: &Path) -> Result<bool, String> {
    let edit_root = project_edit_root(beat);
    if !edit_root.is_dir() { return Ok(false); }
    if find_openable_project_in_directory(&edit_root, &beat.name).is_none() {
        return Err("PROJECT edit folder no longer contains an openable project file.".to_string());
    }
    write_project_directory_zip(&edit_root, archive_path)?;
    let stamp = project_archive_stamp(archive_path)?;
    if let Some(parent) = project_edit_stamp_path(beat).parent() { let _ = std::fs::create_dir_all(parent); }
    std::fs::write(project_edit_stamp_path(beat), stamp.as_bytes())
        .map_err(|e| format!("Could not update PROJECT edit marker: {}", e))?;
    Ok(true)
}

fn replace_project_zip_file(temp_path: &Path, final_path: &Path) -> Result<(), String> {
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not prepare PROJECT folder: {}", e))?;
    }
    if !final_path.exists() {
        return std::fs::rename(temp_path, final_path)
            .map_err(|e| format!("Could not save PROJECT ZIP: {}", e));
    }

    let parent = final_path.parent().unwrap_or_else(|| Path::new("."));
    let backup = parent.join(format!(".beatgaler-project-backup-{}.zip", new_cloud_file_id()));
    std::fs::rename(final_path, &backup)
        .map_err(|e| format!("Could not prepare PROJECT ZIP replacement: {}", e))?;
    match std::fs::rename(temp_path, final_path) {
        Ok(()) => {
            let _ = std::fs::remove_file(backup);
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::rename(&backup, final_path);
            Err(format!("Could not replace PROJECT ZIP: {}", error))
        }
    }
}

fn filtered_project_zip_for_upload(source: &Path) -> Result<Option<PathBuf>, String> {
    let entries = project_zip_entry_names(source)?;
    validate_project_zip_entry_names(&entries)?;
    let (has_backups, project_file_count, _, _) = inspect_project_zip_entries(&entries);
    if project_file_count == 0 {
        return Err("A PROJECT ZIP needs at least one .flp, .als, .logicx, .ptx, or .ptf project file.".to_string());
    }
    if !has_backups { return Ok(None); }

    let root = beatgaler_temp_dir().join("project-filtered").join(new_cloud_file_id());
    std::fs::create_dir_all(&root).map_err(|e| format!("Could not prepare filtered PROJECT ZIP: {}", e))?;
    let filename = source.file_name().and_then(|v| v.to_str()).unwrap_or("PROJECT.zip");
    let dest = root.join(filename);
    let output = std::fs::File::create(&dest)
        .map_err(|e| format!("Could not create filtered PROJECT ZIP: {}", e))?;
    let mut writer = zip::ZipWriter::new(output);
    if let Err(error) = copy_project_zip_entries(source, &mut writer, zip_name_has_forbidden_component) {
        let _ = std::fs::remove_dir_all(&root);
        return Err(error);
    }
    if let Err(error) = writer.finish() {
        let _ = std::fs::remove_dir_all(&root);
        return Err(format!("Could not finish filtered PROJECT ZIP: {}", error));
    }

    let filtered_entries = project_zip_entry_names(&dest)?;
    let (still_has_backups, filtered_project_files, _, _) = inspect_project_zip_entries(&filtered_entries);
    if still_has_backups || filtered_project_files == 0 {
        let _ = std::fs::remove_dir_all(&root);
        return Err("BeatGaler could not create a clean PROJECT ZIP without Backup folders.".to_string());
    }
    Ok(Some(dest))
}

fn project_zip_is_valid(path: &Path) -> bool {
    let Ok(entries) = project_zip_entry_names(path) else { return false; };
    if validate_project_zip_entry_names(&entries).is_err() { return false; }
    let (_has_backups, project_file_count, _, _) = inspect_project_zip_entries(&entries);
    project_file_count > 0
}

fn project_zip_is_openable(path: &Path) -> bool {
    let Ok(entries) = project_zip_entry_names(path) else { return false; };
    if validate_project_zip_entry_names(&entries).is_err() { return false; }
    let (_has_backups, project_file_count, _, _) = inspect_project_zip_entries(&entries);
    project_file_count > 0
}

fn project_zip_capabilities(path: &Path) -> (bool, bool) {
    let Ok(entries) = project_zip_entry_names(path) else { return (false, false); };
    if validate_project_zip_entry_names(&entries).is_err() { return (false, false); }
    let (_has_backups, project_file_count, has_flp, has_als) = inspect_project_zip_entries(&entries);
    if project_file_count == 0 { (false, false) } else { (has_flp, has_als) }
}

fn project_workspace_path(beat: &BeatMeta) -> PathBuf {
    beatgaler_temp_dir()
        .join("project-workspaces")
        .join(&beat.id)
        .join(format!("{}.zip", safe_cloud_filename(&beat.name)))
}

fn ensure_project_working_copy(
    beat: &BeatMeta,
    state: &SettingsState,
    conn: &Connection,
) -> Result<PathBuf, String> {
    if let Some((saved_path, manifest, _, _)) = project_manifest(conn, &beat.id)? {
        if let Some(saved) = saved_path.as_ref().map(PathBuf::from).filter(|p| p.is_file()) {
            return Ok(saved);
        }

        let parts = manifest
            .get("parts")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "Project cloud manifest has no files.".to_string())?;
        if parts.is_empty() {
            return Err("Project cloud manifest is empty.".to_string());
        }

        let workspace = project_workspace_path(beat);
        let user_id = ensure_beatgaler_user_id_from_settings(state)?;
        download_project_parts_parallel(parts, &user_id, &workspace)?;

        if !project_zip_is_valid(&workspace) {
            let _ = std::fs::remove_file(&workspace);
            return Err("The PROJECT zip is invalid. It must contain a project file (.flp/.als/.logicx/.ptx/.ptf).".to_string());
        }

        let (size, modified_ms) = project_file_stamp(&workspace)
            .ok_or_else(|| "Could not read the downloaded PROJECT zip.".to_string())?;
        conn.execute(
            "UPDATE cloud_projects SET local_zip_path=?2, source_size=?3, source_modified_ms=?4 WHERE beat_id=?1",
            params![beat.id.clone(), workspace.to_string_lossy().to_string(), size as i64, modified_ms],
        ).map_err(|e| e.to_string())?;
        return Ok(workspace);
    }

    Err("No PROJECT is stored for this beat yet. Add a project file first.".to_string())
}

fn ensure_beatgaler_user_id_from_settings(state: &SettingsState) -> Result<String, String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    if let Some(id) = settings.beatgaler_user_id.clone().filter(|v| !v.trim().is_empty()) {
        return Ok(id);
    }
    let id = new_cloud_file_id();
    settings.beatgaler_user_id = Some(id.clone());
    save_settings_file(&state.data_dir, &*settings)?;
    Ok(id)
}

fn mutate_project_zip(zip_path: &Path, source: &Path, kind: &str) -> Result<(), String> {
    if !source.exists() {
        return Err("The PROJECT source no longer exists.".to_string());
    }
    if let Some(parent) = zip_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not prepare PROJECT ZIP folder: {}", e))?;
    }

    let normalized_kind = kind.trim().to_ascii_lowercase();
    let (exclude_mode, add_prefix) = match normalized_kind.as_str() {
        "flp" | "projectfile" => ("project", String::new()),
        "projectfolder" => {
            if !source.is_dir() { return Err("Project folder source is not a folder.".to_string()); }
            let folder_name = source.file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "PROJECT folder name is not valid Unicode.".to_string())?;
            if is_forbidden_project_component(folder_name) {
                return Err("This Backup folder was skipped so old project copies are not uploaded.".to_string());
            }
            ("prefix", format!("{}/", folder_name))
        }
        "samples" => ("prefix", "Samples/".to_string()),
        "audio" => ("prefix", "Audio/".to_string()),
        _ => return Err(format!("Unsupported project asset kind: {}", kind)),
    };

    let parent = zip_path.parent().unwrap_or_else(|| Path::new("."));
    let temp_path = parent.join(format!(".beatgaler-project-update-{}.zip", new_cloud_file_id()));
    let result = (|| -> Result<(), String> {
        let output = std::fs::File::create(&temp_path)
            .map_err(|e| format!("Could not create PROJECT ZIP update: {}", e))?;
        let mut writer = zip::ZipWriter::new(output);
        if zip_path.is_file() {
            let prefix = add_prefix.clone();
            copy_project_zip_entries(zip_path, &mut writer, |name| {
                if exclude_mode == "project" {
                    zip_name_contains_project_component(name)
                } else {
                    zip_name_starts_with_case_insensitive(name, &prefix)
                }
            })?;
        }

        match normalized_kind.as_str() {
            "flp" | "projectfile" => {
                if source.is_dir() {
                    let folder_name = source.file_name()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| "PROJECT folder name is not valid Unicode.".to_string())?;
                    add_project_source_to_zip(&mut writer, source, &format!("{}/", folder_name))?;
                } else {
                    add_project_source_to_zip(&mut writer, source, "")?;
                }
            }
            "projectfolder" => add_project_source_to_zip(&mut writer, source, &add_prefix)?,
            "samples" | "audio" => {
                if !source.is_dir() {
                    return Err("Project asset source is not a folder.".to_string());
                }
                add_project_source_to_zip(&mut writer, source, &add_prefix)?;
            }
            _ => unreachable!(),
        }

        writer.finish().map_err(|e| format!("Could not finish PROJECT ZIP update: {}", e))?;
        let entries = project_zip_entry_names(&temp_path)?;
        validate_project_zip_entry_names(&entries)?;
        let (_has_backups, project_count, _, _) = inspect_project_zip_entries(&entries);
        if project_count == 0 {
            return Err("PROJECT zip update removed the primary project file.".to_string());
        }
        replace_project_zip_file(&temp_path, zip_path)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn project_manifest(conn: &Connection, beat_id: &str) -> Result<Option<(Option<String>, Value, Option<u64>, Option<i64>)>, String> {
    let mut stmt = conn.prepare("SELECT local_zip_path, manifest_json, source_size, source_modified_ms FROM cloud_projects WHERE beat_id=?1")
        .map_err(|e| e.to_string())?;
    let row = stmt.query_row(params![beat_id], |r| {
        let path: Option<String> = r.get(0)?;
        let raw: String = r.get(1)?;
        let source_size: Option<i64> = r.get(2)?;
        let source_modified_ms: Option<i64> = r.get(3)?;
        Ok((path, raw, source_size.map(|v| v.max(0) as u64), source_modified_ms))
    });
    match row {
        Ok((path, raw, source_size, source_modified_ms)) => {
            let json: Value = serde_json::from_str(&raw).map_err(|e| format!("Invalid project cloud manifest: {}", e))?;
            Ok(Some((path, json, source_size, source_modified_ms)))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn get_project_cloud_status(
    beat: BeatMeta,
    db: tauri::State<DbState>,
) -> Result<ProjectCloudStatus, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let detected_local = project_zip_candidate(&beat);
    if let Some((saved_path, manifest, uploaded_size, uploaded_modified_ms)) = project_manifest(&conn, &beat.id)? {
        let count = manifest.get("parts").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0);
        let cloud_exists = count > 0;
        let local_path = detected_local.or_else(|| saved_path.as_ref().map(PathBuf::from).filter(|p| p.exists()));
        let local_stamp = local_path.as_deref().and_then(project_file_stamp);
        let local_exists = local_stamp.is_some();
        let needs_sync = match (local_stamp, uploaded_size, uploaded_modified_ms) {
            (Some((size, modified_ms)), Some(old_size), Some(old_modified_ms)) => size != old_size || modified_ms != old_modified_ms,
            _ => false,
        };
        let state = if !cloud_exists { "LOCAL" } else if !local_exists { "CLOUD_ONLY" } else if needs_sync { "NEEDS_SYNC" } else { "SYNCED" }.to_string();
        let valid = if let Some(ref local) = local_path {
            project_zip_is_valid(local)
        } else {
            cloud_exists
        };
        return Ok(ProjectCloudStatus { synced: cloud_exists, valid, state, local_zip_path: local_path.map(|p| p.to_string_lossy().to_string()).or(saved_path), local_exists, needs_sync, part_count: count });
    }
    let local_path = detected_local;
    let local_exists = local_path.is_some();
    let valid = local_path.as_deref().map(project_zip_is_valid).unwrap_or(false);
    Ok(ProjectCloudStatus { synced: false, valid, state: "LOCAL".to_string(), local_zip_path: local_path.map(|p| p.to_string_lossy().to_string()), local_exists, needs_sync: false, part_count: 0 })
}

// ─────────────────────────────────────────────────────────────
//  DOWNLOAD COOKING — cold -> warm -> hot playback cache
//
//  COLD: beat has never entered the viewport.
//  WARM: visible beat is continuously downloaded from byte 0 in small,
//        round-robin Range chunks.  Many visible beats therefore advance
//        together without spawning one permanent curl process per card.
//  HOT:  the user pressed Play.  That beat moves to the front of the queue
//        and uses much larger chunks while the other WARM beats keep cooking.
//
//  The HTML5 player never talks to Telegram directly.  It receives one local
//  HTTP URL whose response tails the same growing .part file.  This removes
//  cloud/index/getFile latency from the click path whenever the card already
//  had time to cook.
// ─────────────────────────────────────────────────────────────

const COOK_WARM_CHUNK_BYTES: u64 = 512 * 1024;
const COOK_HOT_CHUNK_BYTES: u64 = 1024 * 1024;
const COOK_WORKERS: usize = 6;
const COOK_STARTUP_READY_BYTES: u64 = 512 * 1024;

#[derive(Clone)]
struct CookingEntry {
    beat_id: String,
    beat_name: String,
    telegram_file_id: String,
    user_id: String,
    cache_key: String,
    part_path: PathBuf,
    final_path: PathBuf,
    downloaded: u64,
    total: Option<u64>,
    queued: bool,
    in_flight: bool,
    hot: bool,
    complete: bool,
    failed: bool,
    warm_ready_logged: bool,
}

struct CookingState {
    entries: HashMap<String, CookingEntry>,
    queue: VecDeque<String>,
}

struct CookingManager {
    state: Mutex<CookingState>,
    cv: Condvar,
    port: u16,
}

static DOWNLOAD_COOKING_MANAGER: OnceLock<Arc<CookingManager>> = OnceLock::new();
static PLAYBACK_CACHE_LIMIT_MB: AtomicU64 = AtomicU64::new(2048);

static COOK_DIAG_START: OnceLock<Instant> = OnceLock::new();
static COOK_DIAG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn download_cooking_diagnostic_path() -> PathBuf {
    beatgaler_temp_dir().join("download-cooking-diagnostic.txt")
}

fn cooking_diag(event: &str, beat_id: &str, beat_name: &str, detail: &str) {
    let lock = COOK_DIAG_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().ok();
    let path = download_cooking_diagnostic_path();
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    let first = COOK_DIAG_START.get().is_none();
    let start = COOK_DIAG_START.get_or_init(Instant::now);
    if first {
        let header = "DOWNLOAD COOKING DIAGNOSTIC\n===========================\nTimes are relative to the first cooking event in this app session.\n\n";
        let _ = std::fs::write(&path, header);
    }
    let ms = start.elapsed().as_millis();
    let clean = |v: &str| v.replace('\r', " ").replace('\n', " ");
    let line = format!("[+{:>7} ms] {:<24} beat={} name=\"{}\" {}\n", ms, event, clean(beat_id), clean(beat_name), clean(detail));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct DownloadCookingEntryStatus {
    pub beat_id: String,
    pub beat_name: String,
    pub telegram_file_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub complete: bool,
    pub failed: bool,
    pub hot: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct DownloadCookingStatus {
    pub ready_bytes: u64,
    pub diagnostic_path: String,
    pub entries: Vec<DownloadCookingEntryStatus>,
}

#[tauri::command]
pub fn get_download_cooking_status() -> DownloadCookingStatus {
    let entries = DOWNLOAD_COOKING_MANAGER.get().map(|manager| {
        let state = manager.state.lock().unwrap();
        state.entries.values().map(|e| DownloadCookingEntryStatus {
            beat_id: e.beat_id.clone(),
            beat_name: e.beat_name.clone(),
            telegram_file_id: e.telegram_file_id.clone(),
            downloaded_bytes: e.downloaded,
            total_bytes: e.total,
            complete: e.complete,
            failed: e.failed,
            hot: e.hot,
        }).collect()
    }).unwrap_or_default();
    DownloadCookingStatus {
        ready_bytes: COOK_STARTUP_READY_BYTES,
        diagnostic_path: download_cooking_diagnostic_path().to_string_lossy().to_string(),
        entries,
    }
}

#[tauri::command]
pub fn download_cooking_diagnostic_event(event: String, beat_id: Option<String>, beat_name: Option<String>, detail: Option<String>) -> String {
    cooking_diag(&event, beat_id.as_deref().unwrap_or("-"), beat_name.as_deref().unwrap_or("-"), detail.as_deref().unwrap_or(""));
    download_cooking_diagnostic_path().to_string_lossy().to_string()
}

fn cooking_cache_paths(cache_key: &str) -> (PathBuf, PathBuf) {
    let dir = beatgaler_temp_dir().join("cloud-cache").join("audio");
    let _ = std::fs::create_dir_all(&dir);
    (
        dir.join(format!("{}.part", cache_key)),
        dir.join(format!("{}.mp3", cache_key)),
    )
}

fn parse_content_range_total(headers: &str) -> Option<u64> {
    for line in headers.lines().rev() {
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("content-range:") { continue; }
        let value = line.split_once(':')?.1.trim();
        let total = value.rsplit_once('/')?.1.trim();
        if total == "*" { return None; }
        if let Ok(n) = total.parse::<u64>() { return Some(n); }
    }
    None
}

fn cooking_download_chunk(entry: &CookingEntry, start: u64, chunk_bytes: u64) -> Result<(u64, Option<u64>, u128), String> {
    let request_started = Instant::now();
    let end = start.saturating_add(chunk_bytes).saturating_sub(1);
    let chunk_path = entry.part_path.with_extension(format!("chunk-{}", start));
    let header_path = entry.part_path.with_extension(format!("headers-{}", start));
    let _ = std::fs::remove_file(&chunk_path);
    let _ = std::fs::remove_file(&header_path);

    let (body_len, total) = if let Some(message_id) = direct_message_id(&entry.telegram_file_id) {
        match direct_download_range_with_retry(&entry.user_id, message_id, start, chunk_bytes, &chunk_path)? {
            (bytes, total) if bytes > 0 => (bytes, total),
            (_, total) => {
                let _ = std::fs::remove_file(&chunk_path);
                return Ok((0, total, request_started.elapsed().as_millis()));
            }
        }
    } else {
        return Err(
            "Cloud audio reference is outdated. Refresh the library and try again."
                .to_string(),
        );
    };

    if body_len == 0 {
        let _ = std::fs::remove_file(&chunk_path);
        let _ = std::fs::remove_file(&header_path);
        return Err("Download Cooking received an empty Range chunk.".to_string());
    }

    // Every cooking file is contiguous from byte 0. A worker only appends the
    // exact next chunk assigned to it, so the growing .part is always playable.
    let current = std::fs::metadata(&entry.part_path).map(|m| m.len()).unwrap_or(0);
    if current != start {
        let _ = std::fs::remove_file(&chunk_path);
        let _ = std::fs::remove_file(&header_path);
        return Ok((0, total, request_started.elapsed().as_millis()));
    }
    let mut out = std::fs::OpenOptions::new()
        .create(true).append(true).open(&entry.part_path)
        .map_err(|e| format!("Could not append cooking cache: {}", e))?;
    let mut input = std::fs::File::open(&chunk_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut input, &mut out).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&chunk_path);
    let _ = std::fs::remove_file(&header_path);
    Ok((body_len, total, request_started.elapsed().as_millis()))
}

fn cooking_worker(manager: Arc<CookingManager>) {
    loop {
        let (key, snapshot, start, chunk_bytes) = {
            let mut state = manager.state.lock().unwrap();
            loop {
                if let Some(key) = state.queue.pop_front() {
                    let Some(entry) = state.entries.get_mut(&key) else { continue; };
                    entry.queued = false;
                    if entry.complete || entry.failed || entry.in_flight { continue; }
                    entry.in_flight = true;
                    let start = entry.downloaded;
                    let chunk_bytes = if entry.hot { COOK_HOT_CHUNK_BYTES } else { COOK_WARM_CHUNK_BYTES };
                    break (key, entry.clone(), start, chunk_bytes);
                }
                state = manager.cv.wait(state).unwrap();
            }
        };

        let result = cooking_download_chunk(&snapshot, start, chunk_bytes);
        let mut state = manager.state.lock().unwrap();
        let Some(entry) = state.entries.get_mut(&key) else { continue; };
        entry.in_flight = false;
        let mut completed_now = false;

        match result {
            Ok((written, total, request_ms)) => {
                if let Some(total) = total { entry.total = Some(total); }
                if written > 0 { entry.downloaded = entry.downloaded.saturating_add(written); }
                if start == 0 && written > 0 {
                    cooking_diag("FIRST_CHUNK", &entry.beat_id, &entry.beat_name, &format!("bytes={} request_ms={} total={:?}", written, request_ms, entry.total));
                }
                if !entry.warm_ready_logged && entry.downloaded >= COOK_STARTUP_READY_BYTES {
                    entry.warm_ready_logged = true;
                    cooking_diag("WARM_READY", &entry.beat_id, &entry.beat_name, &format!("downloaded_bytes={}", entry.downloaded));
                }
                let done = entry.total.map(|t| entry.downloaded >= t).unwrap_or(written < chunk_bytes);
                if done {
                    entry.complete = true;
                    completed_now = true;
                    // Best effort finalization.  The local playback server can
                    // continue serving .part if Windows temporarily holds it.
                    if !entry.final_path.exists() {
                        let _ = std::fs::rename(&entry.part_path, &entry.final_path);
                    }
                } else if !entry.queued {
                    entry.queued = true;
                    // End the entry borrow before mutating the shared queue.
                    let hot = entry.hot;
                    if hot { state.queue.push_front(key.clone()); }
                    else { state.queue.push_back(key.clone()); }
                }
            }
            Err(err) => {
                eprintln!("Download Cooking failed for {}: {}", key, err);
                // Do not spin forever on a permanent failure. A later viewport
                // event or Play can revive it explicitly.
                entry.failed = true;
                cooking_diag("DOWNLOAD_FAILED", &entry.beat_id, &entry.beat_name, &err);
            }
        }
        if completed_now {
            let mut protected = std::collections::HashSet::new();
            for candidate in state.entries.values() {
                if candidate.in_flight || candidate.queued || candidate.hot || candidate.cache_key == key {
                    protected.insert(candidate.part_path.clone());
                    protected.insert(candidate.final_path.clone());
                }
            }
            let limit_mb = PLAYBACK_CACHE_LIMIT_MB.load(Ordering::Relaxed);
            let _ = enforce_playback_cache_limit_in_dir(
                &playback_cache_audio_dir(),
                limit_mb.saturating_mul(1024 * 1024),
                &protected,
            );
        }
        manager.cv.notify_all();
    }
}

fn parse_http_range(request: &str, total: u64) -> Option<(u64, u64)> {
    let mut requested = None;
    for line in request.lines() {
        if line.to_ascii_lowercase().starts_with("range:") {
            requested = line.split_once(':').map(|(_, v)| v.trim().to_string());
            break;
        }
    }
    let Some(value) = requested else { return Some((0, total.saturating_sub(1))); };
    let raw = value.strip_prefix("bytes=")?;
    let (a, b) = raw.split_once('-')?;
    let start = if a.trim().is_empty() { 0 } else { a.trim().parse::<u64>().ok()? };
    let end = if b.trim().is_empty() { total.saturating_sub(1) } else { b.trim().parse::<u64>().ok()?.min(total.saturating_sub(1)) };
    if start > end || start >= total { None } else { Some((start, end)) }
}

fn cooking_handle_client(mut stream: TcpStream, manager: Arc<CookingManager>) -> Result<(), String> {
    let _ = stream.set_nodelay(true);
    let mut buffer = [0u8; 8192];
    let n = stream.read(&mut buffer).map_err(|e| e.to_string())?;
    if n == 0 { return Ok(()); }
    let request = String::from_utf8_lossy(&buffer[..n]).to_string();
    let first = request.lines().next().unwrap_or_default();
    let mut pieces = first.split_whitespace();
    let method = pieces.next().unwrap_or("GET");
    let target = pieces.next().unwrap_or("/");
    let key = target.split('?').next().unwrap_or(target).trim_start_matches("/play/").to_string();
    if key.is_empty() || !target.starts_with("/play/") {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return Ok(());
    }

    let is_prewarm = target.split('?').nth(1)
        .map(|q| q.split('&').any(|pair| pair == "prewarm=1"))
        .unwrap_or(false);

    // A real Play immediately turns this entry HOT. A PREWARM request is only
    // allowed to read already-cooked local bytes; it never steals scheduler
    // priority from the visible WARM set.
    {
        let mut state = manager.state.lock().unwrap();
        if let Some(entry) = state.entries.get_mut(&key) {
            if !is_prewarm {
                entry.hot = true;
                if entry.failed { entry.failed = false; }
            }
            let should_queue = !entry.complete && !entry.queued && !entry.in_flight;
            if should_queue { entry.queued = true; }
            if should_queue {
                if is_prewarm { state.queue.push_back(key.clone()); }
                else { state.queue.push_front(key.clone()); }
            }
        } else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return Ok(());
        }
        manager.cv.notify_all();
    }

    // We need total size for a standards-compliant Range response. Usually the
    // first WARM chunk learned it before the user can click.
    let total = {
        let mut state = manager.state.lock().unwrap();
        loop {
            let Some(entry) = state.entries.get(&key) else { return Ok(()); };
            if let Some(total) = entry.total { break total; }
            if entry.complete {
                let path = if entry.final_path.exists() { &entry.final_path } else { &entry.part_path };
                if let Ok(meta) = std::fs::metadata(path) { break meta.len(); }
            }
            if entry.failed { return Err("Download Cooking could not prepare this beat.".to_string()); }
            state = manager.cv.wait_timeout(state, Duration::from_millis(250)).unwrap().0;
        }
    };

    let Some((start, end)) = parse_http_range(&request, total) else {
        let header = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", total);
        let _ = stream.write_all(header.as_bytes());
        return Ok(());
    };

    // Seeking ahead of the contiguous cooked prefix is uncommon in the instant
    // start path. Redirect that case to the cloud Range endpoint rather than
    // forcing the local cooker to create holes in the file.
    let available_now = {
        let state = manager.state.lock().unwrap();
        state.entries.get(&key).map(|e| e.downloaded).unwrap_or(0)
    };
    {
        let state = manager.state.lock().unwrap();
        if let Some(entry) = state.entries.get(&key) {
            cooking_diag("LOCAL_PLAYER_REQUEST", &entry.beat_id, &entry.beat_name, &format!("available_bytes={} total_bytes={} range={}", available_now, total, request.lines().find(|l| l.to_ascii_lowercase().starts_with("range:")).unwrap_or("none")));
        }
    }
    if start >= available_now {
        // Direct-only seek path. Do not redirect to the old service-bot HTTP
        // endpoint: 001BeatGaler is manager-only and never reads user media.
        let entry = {
            let state = manager.state.lock().unwrap();
            state.entries.get(&key).cloned()
        };
        let Some(entry) = entry else { return Ok(()); };
        let Some(message_id) = direct_message_id(&entry.telegram_file_id) else {
            return Err("This cloud audio reference is outdated. Refresh the library and try playback again.".to_string());
        };
        let requested_len = end.saturating_sub(start).saturating_add(1);
        let seek_path = entry.part_path.with_extension(format!("seek-{}-{}", start, end));
        let _ = std::fs::remove_file(&seek_path);
        let (bytes, direct_total) = direct_download_range_with_retry(&entry.user_id, message_id, start, requested_len, &seek_path)?;
        if bytes == 0 {
            let _ = std::fs::remove_file(&seek_path);
            let header = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", direct_total.unwrap_or(total));
            let _ = stream.write_all(header.as_bytes());
            return Ok(());
        }
        let actual_total = direct_total.unwrap_or(total);
        let served_end = start.saturating_add(bytes).saturating_sub(1);
        let header = format!("HTTP/1.1 206 Partial Content\r\nContent-Type: audio/mpeg\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n", start, served_end, actual_total, bytes);
        stream.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
        if method != "HEAD" {
            let mut input = std::fs::File::open(&seek_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut input, &mut stream).map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_file(&seek_path);
        return Ok(());
    }

    // IMPORTANT: serve a CLOSED snapshot of what is already cooked. Never tell
    // WebView2 that this response will contain the whole MP3 and then keep the
    // socket open waiting for Internet bytes. That behavior made Chromium wait
    // several seconds before AUDIO_CANPLAY on slower machines.
    let available_snapshot = {
        let state = manager.state.lock().unwrap();
        state.entries.get(&key).map(|e| e.downloaded).unwrap_or(0)
    };
    if available_snapshot == 0 || start >= available_snapshot {
        let header = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n", total);
        let _ = stream.write_all(header.as_bytes());
        return Ok(());
    }

    let served_end = end.min(available_snapshot.saturating_sub(1));
    let content_len = served_end - start + 1;
    let partial = request.to_ascii_lowercase().contains("range:") || available_snapshot < total;
    let header = if partial {
        format!("HTTP/1.1 206 Partial Content\r\nContent-Type: audio/mpeg\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n", start, served_end, total, content_len)
    } else {
        format!("HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n", total)
    };
    stream.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    if method.eq_ignore_ascii_case("HEAD") { return Ok(()); }

    let (path, beat_id, beat_name) = {
        let state = manager.state.lock().unwrap();
        let Some(entry) = state.entries.get(&key) else { return Ok(()); };
        let path = if entry.final_path.exists() { entry.final_path.clone() } else { entry.part_path.clone() };
        (path, entry.beat_id.clone(), entry.beat_name.clone())
    };
    if !is_prewarm { mark_playback_cache_access(&path); }
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut remaining = content_len;
    let mut first_local_bytes_logged = false;
    while remaining > 0 {
        let want = remaining.min(256 * 1024) as usize;
        let mut buf = vec![0u8; want];
        let read = file.read(&mut buf).map_err(|e| e.to_string())?;
        if read == 0 { break; }
        if stream.write_all(&buf[..read]).is_err() { break; }
        if !first_local_bytes_logged {
            first_local_bytes_logged = true;
            cooking_diag(
                if is_prewarm { "PREWARM_FIRST_BYTES" } else { "LOCAL_FIRST_BYTES" },
                &beat_id,
                &beat_name,
                &format!("sent_bytes={} start={} served_end={} snapshot_bytes={}", read, start, served_end, available_snapshot),
            );
        }
        remaining = remaining.saturating_sub(read as u64);
    }
    cooking_diag(
        if is_prewarm { "PREWARM_RESPONSE_DONE" } else { "LOCAL_RESPONSE_DONE" },
        &beat_id,
        &beat_name,
        &format!("start={} end={} content_len={} snapshot_bytes={}", start, served_end, content_len, available_snapshot),
    );
    if !is_prewarm {
        if let Ok(mut state) = manager.state.lock() {
            if let Some(entry) = state.entries.get_mut(&key) {
                if entry.complete { entry.hot = false; }
            }
        }
        let limit_mb = PLAYBACK_CACHE_LIMIT_MB.load(Ordering::Relaxed);
        let _ = enforce_playback_cache_limit(limit_mb);
    }
    Ok(())
}

fn ensure_download_cooking_manager() -> Arc<CookingManager> {
    DOWNLOAD_COOKING_MANAGER.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").expect("Download Cooking local server bind failed");
        let port = listener.local_addr().expect("Download Cooking local addr failed").port();
        let manager = Arc::new(CookingManager {
            state: Mutex::new(CookingState { entries: HashMap::new(), queue: VecDeque::new() }),
            cv: Condvar::new(),
            port,
        });

        let accept_manager = manager.clone();
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(stream) = incoming else { continue; };
                let m = accept_manager.clone();
                std::thread::spawn(move || { let _ = cooking_handle_client(stream, m); });
            }
        });

        for _ in 0..COOK_WORKERS {
            let worker_manager = manager.clone();
            std::thread::spawn(move || cooking_worker(worker_manager));
        }
        manager
    }).clone()
}

fn cooking_enqueue(beat: &BeatMeta, state: &tauri::State<SettingsState>, hot: bool) -> Result<Option<(String, u16)>, String> {
    let telegram_file_id = match beat.telegram_file_id.clone() {
        Some(id) if !id.trim().is_empty() => id,
        _ => return Ok(None),
    };
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected { return Ok(None); }
        PLAYBACK_CACHE_LIMIT_MB.store(settings.playback_cache_limit_mb, Ordering::Relaxed);
    }
    let user_id = ensure_beatgaler_user_id(state)?;
    let mut hasher = Sha256::new();
    hasher.update(telegram_file_id.as_bytes());
    let cache_key = format!("{:x}", hasher.finalize());
    let (part_path, final_path) = cooking_cache_paths(&cache_key);
    // Assign the beat a local cooking file immediately on first visibility.
    // It may be 0 KB for only a few milliseconds until a worker gets its turn.
    if !final_path.exists() && !part_path.exists() {
        let _ = std::fs::OpenOptions::new().create(true).write(true).open(&part_path);
    }
    let manager = ensure_download_cooking_manager();

    let mut cooking = manager.state.lock().map_err(|e| e.to_string())?;
    let final_size = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
    let part_size = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    let is_new_entry = !cooking.entries.contains_key(&cache_key);
    let entry = cooking.entries.entry(cache_key.clone()).or_insert_with(|| CookingEntry {
        beat_id: beat.id.clone(),
        beat_name: beat.name.clone(),
        telegram_file_id: telegram_file_id.clone(),
        user_id: user_id.clone(),
        cache_key: cache_key.clone(),
        part_path: part_path.clone(),
        final_path: final_path.clone(),
        downloaded: if final_size > 0 { final_size } else { part_size },
        total: if final_size > 0 { Some(final_size) } else { None },
        queued: false,
        in_flight: false,
        hot,
        complete: final_size > 0,
        failed: false,
        warm_ready_logged: final_size >= COOK_STARTUP_READY_BYTES || part_size >= COOK_STARTUP_READY_BYTES,
    });
    entry.beat_id = beat.id.clone();
    entry.beat_name = beat.name.clone();
    entry.telegram_file_id = telegram_file_id;
    entry.user_id = user_id;

    // Disk is authoritative for temporary cache existence. The manager lives
    // for the whole Tauri process while the WebView can refresh independently,
    // so reconcile stale `complete/downloaded` flags after Clear cache.
    if final_size > 0 {
        entry.downloaded = final_size;
        entry.total = Some(final_size);
        entry.complete = true;
        entry.failed = false;
        entry.warm_ready_logged = final_size >= COOK_STARTUP_READY_BYTES;
    } else {
        entry.downloaded = part_size;
        entry.complete = false;
        if part_size == 0 { entry.total = None; }
        entry.warm_ready_logged = part_size >= COOK_STARTUP_READY_BYTES;
    }
    // Any explicit enqueue is a retry signal. This matters immediately after
    // upload: Telegram can return a file_id a fraction before the download side
    // can serve it, so the first WARM attempt may fail transiently. A later WARM
    // must revive that entry instead of leaving it permanently poisoned.
    if entry.failed { entry.failed = false; }
    if hot { entry.hot = true; }
    if is_new_entry {
        cooking_diag("WARM_ASSIGNED", &entry.beat_id, &entry.beat_name, &format!("existing_bytes={}", entry.downloaded));
    } else if hot {
        cooking_diag("PLAY_HOT", &entry.beat_id, &entry.beat_name, &format!("cooked_bytes={} total={:?}", entry.downloaded, entry.total));
    }

    let should_queue = !entry.complete && !entry.queued && !entry.in_flight;
    if should_queue { entry.queued = true; }
    // NLL releases `entry` here before we mutate the queue.
    if should_queue {
        if hot { cooking.queue.push_front(cache_key.clone()); }
        else { cooking.queue.push_back(cache_key.clone()); }
    }
    drop(cooking);
    manager.cv.notify_all();
    Ok(Some((cache_key, manager.port)))
}

/// COLD -> WARM. Called when a BeatCard actually enters the viewport.
/// Returns immediately after enqueueing; no network work occurs on the UI thread.
#[tauri::command]
pub fn warm_beat_for_playback(
    beat: BeatMeta,
    state: tauri::State<SettingsState>,
) -> Result<Option<String>, String> {
    let Some((cache_key, port)) = cooking_enqueue(&beat, &state, false)? else {
        return Ok(None);
    };
    // PREWARM is a local-only media probe. It must never promote the beat to
    // HOT; it exists so WebView2 can initialize metadata/decoder work while
    // the startup overlay is still visible.
    Ok(Some(format!("http://127.0.0.1:{}/play/{}?prewarm=1", port, cache_key)))
}

/// Backward-compatible alias for older frontend code. Download Cooking is
/// viewport-driven now, not "next beat" driven.
#[tauri::command]
pub fn prefetch_beat_for_playback(
    beat: BeatMeta,
    state: tauri::State<SettingsState>,
) -> Result<(), String> {
    let _ = warm_beat_for_playback(beat, state)?;
    Ok(())
}

#[tauri::command(async)]
pub fn upload_project_to_telegram(
    beat: BeatMeta,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<ProjectCloudStatus, String> {
    let upload_op = random_urlsafe(6);
    let upload_started = Instant::now();
    eprintln!("[project-sync] UPLOAD_BEGIN op={} beat_id={}", upload_op, beat.id);
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("Galer Cloud is not connected. Connect it in Settings first.".to_string());
        }
    }

    let existing_working_copy = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        project_manifest(&conn, &beat.id)?
            .and_then(|(saved, _, _, _)| saved)
            .map(PathBuf::from)
            .filter(|p| p.is_file())
    };
    let (zip_path, generated_archive) = if let Some(path) = existing_working_copy {
        (path, false)
    } else {
        build_project_archive_if_needed(&beat, &state.data_dir)?
    };
    if !generated_archive {
        // If Open Project created an editable extracted tree, package the user's
        // latest DAW saves back into PROJECT.zip immediately before upload.
        let _ = repack_project_edit_copy_if_present(&beat, &zip_path)?;
    }
    if !project_zip_is_valid(&zip_path) {
        if generated_archive { let _ = std::fs::remove_file(&zip_path); }
        return Err("PROJECT zip is invalid. It must contain a project file (.flp/.als/.logicx/.ptx/.ptf).".to_string());
    }
    let size = std::fs::metadata(&zip_path).map_err(|e| e.to_string())?.len();
    if size == 0 { return Err("Project ZIP is empty.".to_string()); }
    let (_, modified_ms) = project_file_stamp(&zip_path).ok_or_else(|| "Could not read project ZIP metadata.".to_string())?;
    eprintln!(
        "[project-sync] ARCHIVE_READY op={} beat_id={} bytes={} generated={} elapsed_ms={}",
        upload_op,
        beat.id,
        size,
        generated_archive,
        upload_started.elapsed().as_millis(),
    );

    let user_id = ensure_beatgaler_user_id(&state)?;
    let project_filename = zip_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("project.zip")
        .to_string();

    let direct_result = direct_upload_file(
        &user_id,
        &beat.id,
        &beat.name,
        "PROJECT",
        &zip_path,
        &project_filename,
    );
    let mut response: Value = match direct_result {
        Ok(value) => value,
        Err(error) => {
            if generated_archive { let _ = std::fs::remove_file(&zip_path); }
            return Err(format!("Could not upload project with BeatGaler Cloud: {}", error));
        }
    };
    if let Some(err) = response.get("error").and_then(|v| v.as_str()) {
        if generated_archive { let _ = std::fs::remove_file(&zip_path); }
        return Err(err.to_string());
    }
    let parts = match response.get("parts").and_then(|v| v.as_array()) {
        Some(parts) if !parts.is_empty() => parts,
        _ => {
            if generated_archive { let _ = std::fs::remove_file(&zip_path); }
            return Err("Galer Storage did not return any project files.".to_string());
        }
    };
    let part_count = parts.len();
    eprintln!(
        "[project-sync] MEDIA_UPLOAD_OK op={} beat_id={} parts={} bytes={} elapsed_ms={}",
        upload_op,
        beat.id,
        part_count,
        size,
        upload_started.elapsed().as_millis(),
    );
    // The project manifest must reflect the archive we actually uploaded,
    // not stale BeatMeta flags. This matters when a beat was created from audio
    // first and an FLP/ALS was added later.
    let (archive_has_flp, archive_has_als) = project_zip_capabilities(&zip_path);
    let archive_openable = project_zip_is_openable(&zip_path);
    if let Some(obj) = response.as_object_mut() {
        obj.insert("openable".to_string(), Value::Bool(archive_openable));
        obj.insert("has_flp".to_string(), Value::Bool(archive_has_flp));
        obj.insert("has_als".to_string(), Value::Bool(archive_has_als));
        obj.insert("has_samples".to_string(), Value::Bool(beat.has_samples));
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let stored_local_path: Option<String> =
        if generated_archive { None } else { Some(zip_path.to_string_lossy().to_string()) };
    conn.execute(
        "INSERT INTO cloud_projects (beat_id, local_zip_path, manifest_json, source_size, source_modified_ms, uploaded_at) VALUES (?1,?2,?3,?4,?5,strftime('%s','now')) ON CONFLICT(beat_id) DO UPDATE SET local_zip_path=excluded.local_zip_path, manifest_json=excluded.manifest_json, source_size=excluded.source_size, source_modified_ms=excluded.source_modified_ms, uploaded_at=excluded.uploaded_at",
        params![beat.id.clone(), stored_local_path, response.to_string(), size as i64, modified_ms],
    ).map_err(|e| e.to_string())?;
    drop(conn);
    eprintln!(
        "[project-sync] LOCAL_MANIFEST_OK op={} beat_id={} parts={} openable={} elapsed_ms={}",
        upload_op,
        beat.id,
        part_count,
        archive_openable,
        upload_started.elapsed().as_millis(),
    );

    if generated_archive { let _ = std::fs::remove_file(&zip_path); }

    Ok(ProjectCloudStatus {
        synced: true,
        valid: true,
        state: "SYNCED".to_string(),
        local_zip_path: if generated_archive { None } else { Some(zip_path.to_string_lossy().to_string()) },
        local_exists: !generated_archive,
        needs_sync: false,
        part_count,
    })
}

fn download_project_parts_parallel(
    parts: &[Value],
    user_id: &str,
    archive_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = archive_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp_archive = archive_path.with_extension("zip.partial");
    let _ = std::fs::remove_file(&tmp_archive);

    let part_dir = archive_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("parts");
    if part_dir.exists() {
        let _ = std::fs::remove_dir_all(&part_dir);
    }
    std::fs::create_dir_all(&part_dir).map_err(|e| e.to_string())?;

    // Four concurrent Telegram downloads is enough to hide most network latency
    // without spawning dozens of curl processes for very large projects.
    const MAX_PARALLEL: usize = 4;
    let mut downloaded: Vec<PathBuf> = Vec::with_capacity(parts.len());

    for batch_start in (0..parts.len()).step_by(MAX_PARALLEL) {
        let batch_end = std::cmp::min(batch_start + MAX_PARALLEL, parts.len());
        let mut handles = Vec::with_capacity(batch_end - batch_start);

        for i in batch_start..batch_end {
            let file_id = parts[i]
                .get("telegram_file_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("Project part {} has no cloud file reference.", i + 1))?
                .to_string();
            let uid = user_id.to_string();
            let part_path = part_dir.join(format!("part-{:05}.bin", i + 1));
            let thread_path = part_path.clone();

            handles.push((i, part_path, std::thread::spawn(move || {
                download_telegram_file_to_path(&file_id, &uid, &thread_path)
            })));
        }

        for (i, part_path, handle) in handles {
            match handle.join() {
                Ok(Ok(())) => downloaded.push(part_path),
                Ok(Err(e)) => {
                    let _ = std::fs::remove_dir_all(&part_dir);
                    let _ = std::fs::remove_file(&tmp_archive);
                    return Err(format!("Could not download project part {}: {}", i + 1, e));
                }
                Err(_) => {
                    let _ = std::fs::remove_dir_all(&part_dir);
                    let _ = std::fs::remove_file(&tmp_archive);
                    return Err(format!("Project download worker {} crashed.", i + 1));
                }
            }
        }
    }

    downloaded.sort();
    let mut out = std::fs::File::create(&tmp_archive).map_err(|e| e.to_string())?;
    for part_path in &downloaded {
        let mut input = std::fs::File::open(part_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut out).map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())?;

    let final_size = std::fs::metadata(&tmp_archive).map_err(|e| e.to_string())?.len();
    if final_size == 0 {
        let _ = std::fs::remove_dir_all(&part_dir);
        let _ = std::fs::remove_file(&tmp_archive);
        return Err("Reconstructed project ZIP is empty.".to_string());
    }

    let _ = std::fs::remove_file(archive_path);
    std::fs::rename(&tmp_archive, archive_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&part_dir);
    Ok(())
}

#[tauri::command]
pub fn download_cloud_file_to_cache(
    cloud_file_id: String,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<String, String> {
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("Galer Cloud is not connected. Connect it in Settings first.".to_string());
        }
    }

    let (filename, manifest_raw) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if let Some(beat_id) = cloud_file_id.strip_prefix("PROJECT:") {
            conn.query_row(
                "SELECT manifest_json FROM cloud_projects WHERE beat_id=?1",
                params![beat_id],
                |r| r.get::<_, String>(0),
            ).map(|manifest| ("project.zip".to_string(), manifest))
             .map_err(|e| match e {
                 rusqlite::Error::QueryReturnedNoRows => "PROJECT cloud slot not found.".to_string(),
                 _ => e.to_string(),
             })?
        } else {
            conn.query_row(
                "SELECT filename, manifest_json FROM cloud_files WHERE cloud_file_id=?1",
                params![cloud_file_id.clone()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            ).map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => "Cloud file not found.".to_string(),
                _ => e.to_string(),
            })?
        }
    };

    let manifest: Value = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("Invalid cloud file manifest: {}", e))?;
    let parts = manifest.get("parts")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Cloud file manifest has no parts.".to_string())?;
    if parts.is_empty() {
        return Err("Cloud file manifest is empty.".to_string());
    }

    let safe_name = Path::new(&filename)
        .file_name()
        .and_then(|v| v.to_str())
        .filter(|v| !v.is_empty())
        .unwrap_or("cloud-file.bin")
        .to_string();

    let cache_path = beatgaler_temp_dir()
        .join("cloud-cache")
        .join("files")
        .join(&cloud_file_id)
        .join(safe_name);

    let cache_ok = std::fs::metadata(&cache_path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false);
    if cache_ok {
        return Ok(cache_path.to_string_lossy().to_string());
    }

    let user_id = ensure_beatgaler_user_id(&state)?;
    download_project_parts_parallel(parts, &user_id, &cache_path)?;
    Ok(cache_path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn cached_fl_studio_path(data_dir: &Path) -> PathBuf {
    data_dir.join("flstudio-path.txt")
}

#[cfg(target_os = "windows")]
fn extract_exe_from_command(raw: &str) -> Option<PathBuf> {
    let s = raw.trim();
    if s.is_empty() { return None; }

    let candidate = if let Some(rest) = s.strip_prefix('"') {
        let end = rest.find('"')?;
        &rest[..end]
    } else {
        s.split_whitespace().next()?
    };

    let path = PathBuf::from(candidate);
    if path.is_file() { Some(path) } else { None }
}

#[cfg(target_os = "windows")]
fn query_flp_file_association() -> Option<PathBuf> {
    // HKCR is the merged per-user/system Classes view, so this also works when
    // FL Studio was installed only for the current Windows account.
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCR\.flp", "/ve"])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    let prog_id = text.lines()
        .find_map(|line| {
            let t = line.trim();
            if !t.contains("REG_SZ") { return None; }
            t.split("REG_SZ").nth(1).map(str::trim).filter(|v| !v.is_empty())
        })?;

    let key = format!(r"HKCR\{}\shell\open\command", prog_id);
    let out = std::process::Command::new("reg")
        .args(["query", &key, "/ve"])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    let command = text.lines().find_map(|line| {
        let t = line.trim();
        if !t.contains("REG_SZ") { return None; }
        t.split("REG_SZ").nth(1).map(str::trim).filter(|v| !v.is_empty())
    })?;
    extract_exe_from_command(command)
}

#[cfg(target_os = "windows")]
fn find_fl64_under(root: &Path, depth: usize) -> Vec<PathBuf> {
    if depth == 0 || !root.is_dir() { return Vec::new(); }
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return found; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path.file_name().and_then(|n| n.to_str()).map(|n| n.eq_ignore_ascii_case("FL64.exe")).unwrap_or(false) {
                found.push(path);
            }
        } else if path.is_dir() {
            found.extend(find_fl64_under(&path, depth - 1));
        }
    }
    found
}

#[cfg(target_os = "windows")]
fn detect_fl_studio_path(data_dir: &Path) -> Result<PathBuf, String> {
    let cache_file = cached_fl_studio_path(data_dir);

    // Fast path: after the first successful detection this is only one tiny
    // file read + one metadata check.
    if let Ok(raw) = std::fs::read_to_string(&cache_file) {
        let cached = PathBuf::from(raw.trim());
        if cached.is_file() {
            return Ok(cached);
        }
        let _ = std::fs::remove_file(&cache_file);
    }

    // Usually the fastest first-time detection: ask Windows which executable
    // owns .flp files. This also supports custom installation folders.
    if let Some(path) = query_flp_file_association() {
        if let Some(parent) = cache_file.parent() { let _ = std::fs::create_dir_all(parent); }
        let _ = std::fs::write(&cache_file, path.to_string_lossy().as_bytes());
        return Ok(path);
    }

    // Fallback: scan only Image-Line's normal install directories, never the
    // whole drive. This keeps first detection quick even on large disks.
    let mut roots = Vec::<PathBuf>::new();
    if let Ok(v) = std::env::var("ProgramFiles") { roots.push(PathBuf::from(v).join("Image-Line")); }
    if let Ok(v) = std::env::var("ProgramFiles(x86)") { roots.push(PathBuf::from(v).join("Image-Line")); }
    roots.push(PathBuf::from(r"C:\Program Files\Image-Line"));
    roots.push(PathBuf::from(r"C:\Program Files (x86)\Image-Line"));
    roots.sort();
    roots.dedup();

    let mut candidates = Vec::new();
    for root in roots {
        candidates.extend(find_fl64_under(&root, 4));
    }
    // Newer FL Studio folders normally sort after older ones. Prefer the last
    // candidate while keeping the result deterministic.
    candidates.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    if let Some(path) = candidates.pop() {
        if let Some(parent) = cache_file.parent() { let _ = std::fs::create_dir_all(parent); }
        let _ = std::fs::write(&cache_file, path.to_string_lossy().as_bytes());
        return Ok(path);
    }

    Err("BeatGaler could not find FL Studio (FL64.exe). Open/install FL Studio so Windows registers .flp files, then try again.".to_string())
}

fn open_path_as_fl_project(path: &Path, data_dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let is_flp = path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("flp")).unwrap_or(false);
        if is_flp {
            let fl = detect_fl_studio_path(data_dir)?;
            std::process::Command::new(&fl)
                .arg(path)
                .spawn()
                .map_err(|e| format!("Could not launch FL Studio at {}: {}", fl.display(), e))?;
            return Ok(());
        }
        return open_project_file(path.to_string_lossy().to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = data_dir;
        open_project_file(path.to_string_lossy().to_string())
    }
}

#[tauri::command]
pub fn open_beat_project(
    beat: BeatMeta,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<(), String> {
    // Do not require a live Telegram session up front. ensure_project_working_copy
    // returns a durable saved Offline PROJECT immediately when one exists, and
    // only reaches the network when no local PROJECT is available.

    // Stable TEMP edit tree: BeatGaler safely extracts PROJECT.zip, opens the
    // actual DAW project inside it, and repacks saved edits only when the user
    // explicitly chooses Update Project.
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let archive_path = ensure_project_working_copy(&beat, &state, &conn)?;
    drop(conn);

    let project_path = prepare_project_edit_copy(&beat, &archive_path)?;
    open_path_as_fl_project(&project_path, &state.data_dir)
}

#[tauri::command]
pub fn download_project_to_cache(
    beat: BeatMeta,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<String, String> {
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("Galer Cloud is not connected. Connect it in Settings first.".to_string());
        }
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let archive_path = ensure_project_working_copy(&beat, &state, &conn)?;
    Ok(archive_path.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn update_project_archive_from_source(
    beat: BeatMeta,
    source_path: String,
    asset_kind: String,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<ProjectCloudStatus, String> {
    let kind = asset_kind.trim().to_ascii_lowercase();
    if !matches!(kind.as_str(), "flp" | "samples" | "audio" | "projectfile" | "projectfolder") {
        return Err("Unsupported PROJECT update type.".to_string());
    }

    let source = PathBuf::from(&source_path);
    if source.is_dir() {
        let folder_name = source.file_name().and_then(|v| v.to_str()).unwrap_or("");
        if is_forbidden_project_component(folder_name) {
            return Err("This Backup folder was skipped so old project copies are not uploaded.".to_string());
        }
    }
    if matches!(kind.as_str(), "flp" | "projectfile") {
        let is_logic_bundle = source.is_dir()
            && source.extension().and_then(|v| v.to_str()).map(is_recognized_project_extension).unwrap_or(false);
        if !(source.is_file() && path_is_recognized_project_file(&source)) && !is_logic_bundle {
            return Err("Choose a project file: .flp, .als, .logicx, .ptx, or .ptf.".to_string());
        }
    } else if !source.is_dir() {
        return Err("Choose a project asset folder.".to_string());
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let workspace = match ensure_project_working_copy(&beat, &state, &conn) {
        Ok(path) => path,
        Err(_) if kind == "flp" || kind == "projectfile" => {
            let path = project_workspace_path(&beat);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if path.exists() { std::fs::remove_file(&path).map_err(|e| e.to_string())?; }
            // mutate_project_zip creates the archive if missing.
            path
        }
        Err(e) => return Err(format!("{} Add a project file first.", e)),
    };

    mutate_project_zip(&workspace, &source, &kind)?;
    // An explicit dropped replacement becomes the new archive authority. Any
    // older extracted edit tree must not overwrite it on the next upload.
    invalidate_project_edit_copy(&beat);
    if !project_zip_is_valid(&workspace) {
        return Err("PROJECT zip is invalid: no supported project file was found after the update.".to_string());
    }
    let (size, modified_ms) = project_file_stamp(&workspace)
        .ok_or_else(|| "Could not read updated PROJECT zip.".to_string())?;

    // Keep the current remote manifest if it exists; otherwise create a local-only
    // PROJECT row that upload_project_to_telegram can promote to Telegram.
    let current_manifest = project_manifest(&conn, &beat.id)?
        .map(|(_, manifest, _, _)| manifest.to_string())
        .unwrap_or_else(|| "{}".to_string());

    conn.execute(
        "INSERT INTO cloud_projects (beat_id, local_zip_path, manifest_json, source_size, source_modified_ms, uploaded_at)
         VALUES (?1,?2,?3,?4,?5,NULL)
         ON CONFLICT(beat_id) DO UPDATE SET
           local_zip_path=excluded.local_zip_path,
           source_size=excluded.source_size,
           source_modified_ms=excluded.source_modified_ms",
        params![beat.id.clone(), workspace.to_string_lossy().to_string(), current_manifest, size as i64, modified_ms],
    ).map_err(|e| e.to_string())?;
    drop(conn);

    get_project_cloud_status(beat, db)
}

#[tauri::command(async)]
pub fn detach_local_sources_after_cloud_upload(
    beat_id: String,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<BeatMeta, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let raw: String = conn.query_row(
        "SELECT meta_json FROM beats WHERE id=?1",
        params![beat_id.clone()],
        |row| row.get::<_, Option<String>>(0),
    ).map_err(|e| e.to_string())?
      .ok_or_else(|| "Beat metadata is missing.".to_string())?;

    let mut beat: BeatMeta = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if beat.telegram_file_id.as_deref().map(|v| v.is_empty()).unwrap_or(true) {
        return Err("MASTER must be uploaded first.".to_string());
    }

    // Virtual identifiers only; no folders/files are created.
    let virtual_root = state.data_dir.join("cloud-virtual").join(&beat.id);
    beat.folder_path = virtual_root.to_string_lossy().to_string();
    beat.mp3_path = virtual_root.join("master.audio").to_string_lossy().to_string();
    beat.playback_path = beat.mp3_path.clone();
    // Keep logical availability flags from Telegram records, but forget source paths.
    let has_cloud_type = |kind: &str| -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_files WHERE beat_id=?1 AND file_type=?2 AND status='SYNCED')",
            params![beat.id.clone(), kind],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0) != 0
    };
    beat.wav_path = None;
    beat.has_wav = has_cloud_type("WAV");
    beat.stems_path = None;
    beat.has_stems = has_cloud_type("STEMS");
    beat.samples_path = None;
    beat.has_samples = false;
    beat.flp_path = None;
    beat.has_flp = has_cloud_type("PROJECT");
    beat.als_path = None;
    beat.has_als = false;
    beat.loop_path = None;
    beat.has_loop = has_cloud_type("LOOP");
    beat.other_files.clear();
    beat.cloud_status = Some("CLOUD_ONLY".to_string());

    db_save(&conn, &beat).map_err(|e| e.to_string())?;
    Ok(beat)
}



#[derive(Debug, Serialize, Clone)]
struct BackgroundDownloadEvent {
    task_id: String,
    kind: String,
    beat_id: String,
    beat_name: String,
    status: String,
    error: Option<String>,
    output_path: Option<String>,
}

fn background_download_emit(
    app: &tauri::AppHandle,
    task_id: &str,
    kind: &str,
    beat: &BeatMeta,
    status: &str,
    error: Option<String>,
    output_path: Option<String>,
) {
    let _ = app.emit("beatgaler-download-event", BackgroundDownloadEvent {
        task_id: task_id.to_string(),
        kind: kind.to_string(),
        beat_id: beat.id.clone(),
        beat_name: beat.name.clone(),
        status: status.to_string(),
        error,
        output_path,
    });
}

fn is_windows_reserved_component(value: &str) -> bool {
    let base = value
        .trim()
        .trim_end_matches(['.', ' '])
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
}

fn safe_export_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() {
        "Beat".to_string()
    } else if is_windows_reserved_component(trimmed) {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    }
}

fn existing_local_file(path: &str) -> Option<PathBuf> {
    if path.trim().is_empty() { return None; }
    let candidate = PathBuf::from(path);
    std::fs::metadata(&candidate)
        .ok()
        .filter(|meta| meta.is_file() && meta.len() > 0)
        .map(|_| candidate)
}

fn existing_optional_local_file(path: &Option<String>) -> Option<PathBuf> {
    path.as_deref().and_then(existing_local_file)
}

fn existing_local_project_archive(beat: &BeatMeta) -> Option<PathBuf> {
    beat.flp_path.as_deref().and_then(existing_local_file)
        .or_else(|| beat.als_path.as_deref().and_then(existing_local_file))
        .filter(|path| path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("zip")).unwrap_or(false))
}

fn ensure_master_export_cache(
    beat: &BeatMeta,
    state: &tauri::State<SettingsState>,
) -> Result<PathBuf, String> {
    // Available Offline owns a protected MASTER outside the temporary cache.
    // Always export that local file first; no Telegram status check is needed.
    if beat.offline_available {
        if let Some(local) = existing_local_file(&beat.mp3_path) {
            return Ok(local);
        }
    }

    let telegram_file_id = beat.telegram_file_id.clone()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "MP3 MASTER is not available in Galer Cloud.".to_string())?;
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        if !settings.telegram_cloud_connected {
            return Err("Galer Cloud is not connected. Connect it in Settings first.".to_string());
        }
    }
    let user_id = ensure_beatgaler_user_id(state)?;
    let mut hasher = Sha256::new();
    hasher.update(telegram_file_id.as_bytes());
    let cache_key = format!("{:x}", hasher.finalize());
    let cache_path = beatgaler_temp_dir()
        .join("cloud-cache")
        .join("audio")
        .join(format!("{}.mp3", cache_key));
    let cache_ok = std::fs::metadata(&cache_path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false);
    if !cache_ok {
        download_telegram_file_to_path(&telegram_file_id, &user_id, &cache_path)?;
    }
    Ok(cache_path)
}

fn cloud_file_id_for_beat(
    conn: &Connection,
    beat_id: &str,
    file_type: &str,
) -> Result<Option<String>, String> {
    let mut stmt = conn.prepare(
        "SELECT cloud_file_id FROM cloud_files WHERE beat_id=?1 AND file_type=?2 ORDER BY rowid DESC LIMIT 1"
    ).map_err(|e| e.to_string())?;
    match stmt.query_row(params![beat_id, file_type], |r| r.get::<_, String>(0)) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn riff_info_value(value: &str) -> Vec<u8> {
    // RIFF INFO strings are NUL-terminated. UTF-8 keeps modern readers happy;
    // ASCII metadata remains byte-identical and is understood by Windows.
    let mut out = value.as_bytes().to_vec();
    out.push(0);
    out
}

fn push_riff_info_subchunk(list: &mut Vec<u8>, id: &[u8; 4], value: &str) {
    if value.trim().is_empty() { return; }
    let payload = riff_info_value(value);
    list.extend_from_slice(id);
    list.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    list.extend_from_slice(&payload);
    if payload.len() % 2 != 0 { list.push(0); }
}

fn riff_info_text(payload: &[u8]) -> String {
    let trimmed = payload.iter().copied().take_while(|b| *b != 0).collect::<Vec<_>>();
    String::from_utf8_lossy(&trimmed).trim().to_string()
}

fn build_wav_list_info_chunk_preserving(existing_info: Option<&[u8]>, beat: &BeatMeta) -> Vec<u8> {
    let mut preserved = Vec::<([u8; 4], Vec<u8>)>::new();
    let mut existing_name = String::new();
    let mut existing_genre = String::new();
    let mut existing_comment = String::new();

    if let Some(data) = existing_info.filter(|d| d.len() >= 4 && &d[0..4] == b"INFO") {
        let mut pos = 4usize;
        while pos + 8 <= data.len() {
            let id: [u8; 4] = data[pos..pos + 4].try_into().unwrap();
            let size = u32::from_le_bytes(data[pos + 4..pos + 8].try_into().unwrap()) as usize;
            let value_start = pos + 8;
            let value_end = value_start.saturating_add(size);
            if value_end > data.len() { break; }
            let value = data[value_start..value_end].to_vec();
            match &id {
                b"INAM" => existing_name = riff_info_text(&value),
                b"IGNR" => existing_genre = riff_info_text(&value),
                b"ICMT" => existing_comment = riff_info_text(&value),
                _ => preserved.push((id, value)),
            }
            pos = value_end + (size % 2);
        }
    }

    let safe_tags = filter_metadata_tags(&beat.tags);
    let merged_genre = merge_existing_genre(
        if existing_genre.trim().is_empty() { None } else { Some(existing_genre.as_str()) },
        &safe_tags,
    ).unwrap_or_default();

    let effective_name = if beat.name.trim().is_empty() { existing_name } else { beat.name.trim().to_string() };

    let mut beatgaler_comment_parts = Vec::new();
    if !beat.bpm.trim().is_empty() { beatgaler_comment_parts.push(format!("BPM={}", beat.bpm.trim())); }
    if !beat.key.trim().is_empty() { beatgaler_comment_parts.push(format!("KEY={}", beat.key.trim())); }
    if beat.rating > 0 { beatgaler_comment_parts.push(format!("RATING={}", beat.rating)); }
    let beatgaler_comment = beatgaler_comment_parts.join("; ");

    // Preserve the source comment. If this file was exported by BeatGaler before,
    // replace only our own trailing annotation instead of appending it forever.
    let source_comment = existing_comment
        .split(" | BeatGaler: ")
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let merged_comment = match (source_comment.is_empty(), beatgaler_comment.is_empty()) {
        (true, true) => String::new(),
        (false, true) => source_comment,
        (true, false) => beatgaler_comment,
        (false, false) => format!("{} | BeatGaler: {}", source_comment, beatgaler_comment),
    };

    let mut payload = b"INFO".to_vec();
    for (id, value) in preserved {
        payload.extend_from_slice(&id);
        payload.extend_from_slice(&(value.len() as u32).to_le_bytes());
        payload.extend_from_slice(&value);
        if value.len() % 2 != 0 { payload.push(0); }
    }
    push_riff_info_subchunk(&mut payload, b"INAM", &effective_name);
    push_riff_info_subchunk(&mut payload, b"IGNR", &merged_genre);
    push_riff_info_subchunk(&mut payload, b"ICMT", &merged_comment);

    let mut chunk = Vec::with_capacity(payload.len() + 8);
    chunk.extend_from_slice(b"LIST");
    chunk.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    chunk.extend_from_slice(&payload);
    if payload.len() % 2 != 0 { chunk.push(0); }
    chunk
}

fn write_wav_riff_metadata(beat: &BeatMeta, path: &Path) -> Result<(), String> {
    // First overlay BeatGaler's ID3 values on the existing WAV tag. The id3
    // writer preserves unrelated frames; unlike the old exporter we do NOT
    // discard the complete source ID3 block just to update BPM/key/artwork.
    write_id3_to(
        path,
        &beat.bpm,
        &beat.key,
        &beat.tags,
        beat.rating,
        beat.image_base64.as_deref(),
    )?;
    {
        let mut tag = Tag::read_from_path(path).unwrap_or_default();
        tag.set_title(beat.name.clone());
        tag.write_to_path(path, Version::Id3v23)
            .map_err(|e| format!("Could not write WAV title metadata: {}", e))?;
    }

    let mut input = std::fs::File::open(path)
        .map_err(|e| format!("Could not open exported WAV '{}': {}", path.display(), e))?;
    let mut header = [0u8; 12];
    input.read_exact(&mut header)
        .map_err(|e| format!("Could not read WAV header '{}': {}", path.display(), e))?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err(format!("Exported HQ audio is not a standard RIFF/WAVE file: {}", path.display()));
    }

    let tmp = path.with_extension("beatgaler-metadata.tmp.wav");
    let mut output = std::fs::File::create(&tmp)
        .map_err(|e| format!("Could not create WAV metadata temp '{}': {}", tmp.display(), e))?;
    output.write_all(b"RIFF").map_err(|e| e.to_string())?;
    output.write_all(&0u32.to_le_bytes()).map_err(|e| e.to_string())?;
    output.write_all(b"WAVE").map_err(|e| e.to_string())?;

    let mut existing_info: Option<Vec<u8>> = None;
    loop {
        let mut chunk_header = [0u8; 8];
        match input.read_exact(&mut chunk_header) {
            Ok(()) => {},
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("Could not read WAV chunk '{}': {}", path.display(), e)),
        }
        let id = &chunk_header[0..4];
        let size = u32::from_le_bytes(chunk_header[4..8].try_into().unwrap()) as usize;
        let mut data = vec![0u8; size];
        input.read_exact(&mut data)
            .map_err(|e| format!("Could not read WAV chunk data '{}': {}", path.display(), e))?;
        let mut pad = [0u8; 1];
        if size % 2 != 0 {
            input.read_exact(&mut pad)
                .map_err(|e| format!("Could not read WAV padding '{}': {}", path.display(), e))?;
        }

        let is_info_list = id == b"LIST" && data.len() >= 4 && &data[0..4] == b"INFO";
        if is_info_list {
            existing_info = Some(data);
            continue;
        }

        // Preserve every other chunk byte-for-byte, INCLUDING ID3, bext, iXML,
        // smpl, cue, JUNK and any DAW/vendor-specific metadata chunks.
        output.write_all(&chunk_header).map_err(|e| e.to_string())?;
        output.write_all(&data).map_err(|e| e.to_string())?;
        if size % 2 != 0 { output.write_all(&pad).map_err(|e| e.to_string())?; }
    }

    let list_info = build_wav_list_info_chunk_preserving(existing_info.as_deref(), beat);
    output.write_all(&list_info).map_err(|e| format!("Could not write WAV INFO metadata: {}", e))?;
    output.flush().map_err(|e| e.to_string())?;
    drop(output);
    drop(input);

    let total_len = std::fs::metadata(&tmp).map_err(|e| e.to_string())?.len();
    if total_len < 8 || total_len - 8 > u32::MAX as u64 {
        let _ = std::fs::remove_file(&tmp);
        return Err("WAV is too large to store RIFF metadata safely (>4GB RIFF limit).".to_string());
    }
    {
        use std::io::{Seek, SeekFrom};
        let mut f = std::fs::OpenOptions::new().write(true).open(&tmp).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?;
        f.write_all(&((total_len - 8) as u32).to_le_bytes()).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }

    std::fs::rename(&tmp, path).or_else(|_| {
        std::fs::copy(&tmp, path)?;
        std::fs::remove_file(&tmp)
    }).map_err(|e| format!("Could not finalize WAV metadata '{}': {}", path.display(), e))?;
    Ok(())
}

fn resolve_export_beat_metadata(
    incoming: &BeatMeta,
    state: &tauri::State<SettingsState>,
    db: &tauri::State<DbState>,
) -> Result<BeatMeta, String> {
    // Export must use BeatGaler's CURRENT metadata, not whatever tags happened
    // to exist in the audio bytes uploaded months ago. SQLite is the local
    // materialized view of the pinned Telegram index, so prefer that record.
    let mut resolved = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        existing_beat_meta(&conn, &incoming.id).unwrap_or_else(|| incoming.clone())
    };

    // Defensive merge: if an older local record is missing a field that the
    // current UI beat has, keep the current value instead of exporting blanks.
    if resolved.name.trim().is_empty() && !incoming.name.trim().is_empty() {
        resolved.name = incoming.name.clone();
    }
    if resolved.bpm.trim().is_empty() && !incoming.bpm.trim().is_empty() {
        resolved.bpm = incoming.bpm.clone();
    }
    if resolved.key.trim().is_empty() && !incoming.key.trim().is_empty() {
        resolved.key = incoming.key.clone();
    }
    if resolved.tags.is_empty() && !incoming.tags.is_empty() {
        resolved.tags = incoming.tags.clone();
    }
    if resolved.rating == 0 && incoming.rating > 0 {
        resolved.rating = incoming.rating;
    }
    if resolved.image_base64.as_deref().map(|v| v.trim().is_empty()).unwrap_or(true) {
        if let Some(image) = incoming.image_base64.as_ref().filter(|v| !v.trim().is_empty()) {
            resolved.image_base64 = Some(image.clone());
        }
    }

    // The incoming Offline BeatMeta is the authoritative LOCAL source map for
    // exports. SQLite normally contains the online materialized view, whose
    // mp3/wav/project paths may deliberately point at cloud-virtual locations.
    // Preserve metadata from SQLite, but never throw away protected Offline paths.
    if incoming.offline_available {
        resolved.offline_available = true;
        resolved.folder_path = incoming.folder_path.clone();
        resolved.mp3_path = incoming.mp3_path.clone();
        resolved.playback_path = incoming.playback_path.clone();
        resolved.wav_path = incoming.wav_path.clone();
        resolved.stems_path = incoming.stems_path.clone();
        resolved.samples_path = incoming.samples_path.clone();
        resolved.flp_path = incoming.flp_path.clone();
        resolved.als_path = incoming.als_path.clone();
        resolved.loop_path = incoming.loop_path.clone();
        resolved.other_files = incoming.other_files.clone();
        resolved.has_wav = incoming.has_wav;
        resolved.has_stems = incoming.has_stems;
        resolved.has_samples = incoming.has_samples;
        resolved.has_flp = incoming.has_flp;
        resolved.has_als = incoming.has_als;
        resolved.has_loop = incoming.has_loop;
    }

    // A cloud-only beat can occasionally have its artwork omitted from the
    // in-memory BeatMeta (for example after cache cleanup). In that case use
    // the Telegram artwork file id saved during index restoration and fetch
    // the actual cover bytes before writing the exported audio.
    if !incoming.offline_available && resolved.image_base64.as_deref().map(|v| v.trim().is_empty()).unwrap_or(true) {
        let artwork_file_id = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT artwork_telegram_file_id FROM cloud_metadata WHERE beat_id=?1 LIMIT 1",
                params![incoming.id.clone()],
                |row| row.get::<_, Option<String>>(0),
            ).ok().flatten()
        };

        if let Some(file_id) = artwork_file_id.filter(|v| !v.trim().is_empty()) {
            let user_id = ensure_beatgaler_user_id(state)?;
            resolved.image_base64 = fetch_restored_artwork(
                &user_id,
                &file_id,
                None,
                &state.data_dir,
            );
        }
    }

    Ok(resolved)
}

fn write_beat_metadata_to_exported_audio(
    beat: &BeatMeta,
    path: &Path,
) -> Result<(), String> {
    if path.extension().and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case("wav")).unwrap_or(false) {
        return write_wav_riff_metadata(beat, path);
    }

    write_id3_to(
        path,
        &beat.bpm,
        &beat.key,
        &beat.tags,
        beat.rating,
        beat.image_base64.as_deref(),
    )?;
    let mut tag = Tag::read_from_path(path).unwrap_or_default();
    tag.set_title(beat.name.clone());
    tag.write_to_path(path, Version::Id3v23)
        .map_err(|e| format!("Could not write BeatGaler title metadata: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn start_background_download(
    app: tauri::AppHandle,
    kind: String,
    beat: BeatMeta,
    destination_path: String,
) -> Result<String, String> {
    let normalized = kind.trim().to_ascii_uppercase();
    if !matches!(normalized.as_str(), "MP3" | "WAV" | "PROJECT" | "ALL") {
        return Err(format!("Unsupported download kind: {}", kind));
    }
    if destination_path.trim().is_empty() {
        return Err("Download destination is empty.".to_string());
    }

    let task_id = format!(
        "download-{}-{}",
        SystemTime::now().duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis()).unwrap_or(0),
        rand::random::<u64>()
    );
    let task_id_worker = task_id.clone();
    let app_worker = app.clone();

    std::thread::spawn(move || {
        let result: Result<String, String> = (|| {
            let state = app_worker.state::<SettingsState>();
            let db = app_worker.state::<DbState>();
            let export_beat = resolve_export_beat_metadata(&beat, &state, &db)?;
            let safe_base = safe_export_name(&export_beat.name);
            let export_suffix = format_bpm_key_suffix(export_beat.bpm.trim(), export_beat.key.trim());
            let audio_safe_base = if export_suffix.is_empty() || safe_base.ends_with(&export_suffix) {
                safe_base.clone()
            } else {
                format!("{} {}", safe_base, export_suffix)
            };
            let destination = PathBuf::from(&destination_path);

            if normalized == "MP3" {
                let source = ensure_master_export_cache(&export_beat, &state)?;
                copy_export_file(
                    source.to_string_lossy().to_string(),
                    destination.to_string_lossy().to_string(),
                )?;
                // Overlay current BeatGaler-managed fields on the durable audio
                // while preserving unrelated source metadata (artist/album/comments/etc.).
                write_beat_metadata_to_exported_audio(&export_beat, &destination)?;
                return Ok(destination.to_string_lossy().to_string());
            }

            if normalized == "WAV" {
                let source = if export_beat.offline_available {
                    existing_optional_local_file(&export_beat.wav_path)
                } else {
                    None
                };
                let source = match source {
                    Some(local) => local.to_string_lossy().to_string(),
                    None => {
                        let wav_cloud_id = {
                            let conn = db.0.lock().map_err(|e| e.to_string())?;
                            cloud_file_id_for_beat(&conn, &beat.id, "WAV")?
                        }.ok_or_else(|| "WAV HQ is not available for this beat.".to_string())?;
                        download_cloud_file_to_cache(
                            wav_cloud_id,
                            app_worker.state::<SettingsState>(),
                            app_worker.state::<DbState>(),
                        )?
                    }
                };
                copy_export_file(source, destination.to_string_lossy().to_string())?;
                // Preserve source WAV metadata/chunks and overlay BeatGaler's current
                // title + BPM + key + tags/genre + rating + CoverFront artwork.
                write_beat_metadata_to_exported_audio(&export_beat, &destination)?;
                return Ok(destination.to_string_lossy().to_string());
            }

            if normalized == "PROJECT" {
                let source = if export_beat.offline_available {
                    existing_local_project_archive(&export_beat)
                } else {
                    None
                };
                let source = match source {
                    Some(local) => local,
                    None => {
                        let conn = db.0.lock().map_err(|e| e.to_string())?;
                        ensure_project_working_copy(&export_beat, &state, &conn)?
                    }
                };
                copy_export_file(
                    source.to_string_lossy().to_string(),
                    destination.to_string_lossy().to_string(),
                )?;
                return Ok(destination.to_string_lossy().to_string());
            }

            // ALL: destination_path is the user-selected BASE folder.
            // Create BeatName / BeatName (1) / ... inside the worker so the UI is
            // released immediately after the folder picker closes.
            let export_folder = PathBuf::from(prepare_unique_export_folder(
                destination_path.clone(),
                safe_base.clone(),
            )?);

            if export_beat.telegram_file_id.as_ref().is_some_and(|v| !v.trim().is_empty()) {
                let source = ensure_master_export_cache(&export_beat, &state)?;
                let mp3_dest = export_folder.join(format!("{}.mp3", audio_safe_base));
                copy_export_file(
                    source.to_string_lossy().to_string(),
                    mp3_dest.to_string_lossy().to_string(),
                )?;
                write_beat_metadata_to_exported_audio(&export_beat, &mp3_dest)?;
            }

            let local_wav = if export_beat.offline_available {
                existing_optional_local_file(&export_beat.wav_path)
            } else {
                None
            };
            if let Some(source) = local_wav {
                let wav_dest = export_folder.join(format!("{}.wav", audio_safe_base));
                copy_export_file(source.to_string_lossy().to_string(), wav_dest.to_string_lossy().to_string())?;
                write_beat_metadata_to_exported_audio(&export_beat, &wav_dest)?;
            } else {
                let wav_cloud_id = {
                    let conn = db.0.lock().map_err(|e| e.to_string())?;
                    cloud_file_id_for_beat(&conn, &beat.id, "WAV")?
                };
                if let Some(wav_cloud_id) = wav_cloud_id {
                    let source = download_cloud_file_to_cache(
                        wav_cloud_id,
                        app_worker.state::<SettingsState>(),
                        app_worker.state::<DbState>(),
                    )?;
                    let wav_dest = export_folder.join(format!("{}.wav", audio_safe_base));
                    copy_export_file(source, wav_dest.to_string_lossy().to_string())?;
                    write_beat_metadata_to_exported_audio(&export_beat, &wav_dest)?;
                }
            }

            // PROJECT follows the same local-first rule. Available Offline must
            // never need Telegram merely to export a ZIP that is already durable.
            let local_project = if export_beat.offline_available {
                existing_local_project_archive(&export_beat)
            } else {
                None
            };
            if let Some(source) = local_project {
                let project_dest = export_folder.join(format!("{}.zip", safe_base));
                copy_export_file(source.to_string_lossy().to_string(), project_dest.to_string_lossy().to_string())?;
            } else {
                let has_project = {
                    let conn = db.0.lock().map_err(|e| e.to_string())?;
                    conn.query_row(
                        "SELECT 1 FROM cloud_projects WHERE beat_id=?1 LIMIT 1",
                        params![beat.id.clone()],
                        |_| Ok(()),
                    ).is_ok()
                };
                if has_project {
                    let source = {
                        let conn = db.0.lock().map_err(|e| e.to_string())?;
                        ensure_project_working_copy(&export_beat, &state, &conn)?
                    };
                    let project_dest = export_folder.join(format!("{}.zip", safe_base));
                    copy_export_file(source.to_string_lossy().to_string(), project_dest.to_string_lossy().to_string())?;
                }
            }

            Ok(export_folder.to_string_lossy().to_string())
        })();

        match result {
            Ok(path) => background_download_emit(
                &app_worker,
                &task_id_worker,
                &normalized,
                &beat,
                "completed",
                None,
                Some(path),
            ),
            Err(err) => background_download_emit(
                &app_worker,
                &task_id_worker,
                &normalized,
                &beat,
                "error",
                Some(err),
                None,
            ),
        }
    });

    Ok(task_id)
}

/// Copies an already-downloaded/cache file to an explicit user-selected path.
/// This is an EXPORT only: it does not mutate BeatGaler metadata, playback_path,
/// cloud state, or the library.
/// Copies the complete ID3 metadata from one audio file to another.
/// Used by exports so the WAV copy carries the exact same BeatGaler/ID3
/// metadata as the MASTER MP3, without modifying either cloud source.
#[tauri::command]
pub fn copy_audio_metadata(
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    let destination = PathBuf::from(&destination_path);

    let meta = std::fs::metadata(&destination)
        .map_err(|e| format!("Exported audio could not be read '{}': {}", destination.display(), e))?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(format!("Exported audio is not a readable non-empty file: {}", destination.display()));
    }

    let tag = Tag::read_from_path(&source)
        .map_err(|e| format!("Could not read MASTER metadata '{}': {}", source.display(), e))?;
    tag.write_to_path(&destination, Version::Id3v23)
        .map_err(|e| format!("Could not write MASTER metadata to WAV '{}': {}", destination.display(), e))?;

    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
pub fn copy_export_file(
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    let destination = PathBuf::from(&destination_path);

    let source_meta = std::fs::metadata(&source)
        .map_err(|e| format!("Export source could not be read '{}': {}", source.display(), e))?;
    if !source_meta.is_file() || source_meta.len() == 0 {
        return Err(format!("Export source is not a readable non-empty file: {}", source.display()));
    }

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create export folder '{}': {}", parent.display(), e))?;
    }

    let name = destination.file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("export.bin");
    let tmp = destination.with_file_name(format!(".{}.beatgaler-export", name));
    let _ = std::fs::remove_file(&tmp);

    std::fs::copy(&source, &tmp)
        .map_err(|e| format!(
            "Could not export '{}' to '{}': {}",
            source.display(), destination.display(), e
        ))?;

    let copied = std::fs::metadata(&tmp)
        .map_err(|e| format!("Export TEMP copy vanished: {}", e))?
        .len();
    if copied == 0 {
        let _ = std::fs::remove_file(&tmp);
        return Err("Export produced an empty file.".to_string());
    }

    // The native Save dialog handles replace confirmation for individual files.
    let _ = std::fs::remove_file(&destination);
    if std::fs::rename(&tmp, &destination).is_err() {
        std::fs::copy(&tmp, &destination)
            .map_err(|e| format!("Could not finalize export '{}': {}", destination.display(), e))?;
        let _ = std::fs::remove_file(&tmp);
    }

    Ok(destination.to_string_lossy().to_string())
}

fn safe_export_component(raw: &str) -> String {
    let cleaned: String = raw.chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() { "BeatGaler Export".to_string() } else { trimmed.chars().take(120).collect() }
}

/// Download Everything never overwrites an older export folder. If "Beat Name"
/// exists, BeatGaler creates "Beat Name (1)", "(2)", etc.
#[tauri::command]
pub fn prepare_unique_export_folder(
    base_path: String,
    beat_name: String,
) -> Result<String, String> {
    let base = PathBuf::from(base_path);
    if !base.is_dir() {
        return Err(format!("Selected export location is not a folder: {}", base.display()));
    }

    let safe_name = safe_export_component(&beat_name);
    for index in 0..10_000usize {
        let folder_name = if index == 0 {
            safe_name.clone()
        } else {
            format!("{} ({})", safe_name, index)
        };
        let candidate = base.join(folder_name);
        if !candidate.exists() {
            std::fs::create_dir_all(&candidate)
                .map_err(|e| format!("Could not create export folder '{}': {}", candidate.display(), e))?;
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err("Could not find an available export folder name.".to_string())
}

fn sanitize_tags(tags: &[String]) -> Vec<String> {
    use std::collections::HashSet;

    fn clean_one(raw: &str) -> Option<String> {
        // TCON supports text, including Unicode. We reject characters that
        // Beat Galer itself uses as tag separators, plus ASCII control chars.
        let cleaned: String = raw
            .chars()
            .filter(|c| !c.is_control() && !matches!(c, ',' | ';' | '/' | '\\' | '|'))
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .trim_start_matches('#')
            .trim()
            .to_lowercase();

        if cleaned.is_empty() { return None; }
        Some(cleaned.chars().take(50).collect())
    }

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in tags {
        let Some(tag) = clean_one(raw) else { continue; };
        if seen.insert(tag.clone()) {
            out.push(tag);
        }
        if out.len() >= 30 { break; }
    }
    out
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveMetaPayload {
    pub mp3_path: String,
    pub wav_path: Option<String>,
    pub bpm: String,
    pub key: String,
    pub tags: Vec<String>,
    pub rating: u8,
    pub image_base64: Option<String>,
    pub update_filename: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RenamePayload {
    pub mp3_path: String,
    pub folder_path: String,
    pub new_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RenameResult {
    pub new_folder_path: String,
    pub new_mp3_path: String,
    pub new_wav_path: Option<String>,
    pub new_stems_path: Option<String>,
    pub new_flp_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderScanResult {
    pub needs_resolution: bool,
    pub mp3_files: Vec<String>,
    pub wav_files: Vec<String>,
    pub stems_files: Vec<String>,
    pub flp_files: Vec<String>,
    pub beat: Option<BeatMeta>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResolveFilesPayload {
    pub folder_path: String,
    pub mp3_path: String,
    pub wav_path: Option<String>,
    pub stems_path: Option<String>,
    pub flp_path: Option<String>,
}

/// Add a file to an existing beat (mp3, wav, stems, flp, als)
#[derive(Debug, Serialize, Deserialize)]
pub struct AddFilePayload {
    pub beat_folder: String,
    pub file_path: String,   // source path to copy/move
    pub file_role: String,   // "mp3" | "wav" | "stems" | "flp" | "als"
    pub beat_name: String,   // clean name for renaming
    pub bpm: String,
    pub key: String,
}

pub struct DbState(pub Mutex<Connection>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub beats_folder: Option<String>,
    #[serde(default)]
    pub templates_folder: Option<String>,
    #[serde(default = "default_true")]
    pub incomplete_warnings_enabled: bool,
    #[serde(default = "default_true")]
    pub custom_cursor_enabled: bool,
    // ── Telegram Cloud (Fase 2/10 del plan) ──
    // ID local, aleatorio y permanente que identifica esta instalación de
    // BeatGaler ante el backend de Telegram Cloud. NUNCA es el id de Telegram.
    #[serde(default)]
    pub beatgaler_user_id: Option<String>,
    #[serde(default)]
    pub telegram_cloud_connected: bool,
    #[serde(default)]
    pub telegram_cloud_username: Option<String>,
    #[serde(default = "default_playback_cache_limit_mb")]
    pub playback_cache_limit_mb: u64,
}

fn default_true() -> bool { true }
fn default_playback_cache_limit_mb() -> u64 { 2048 }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            beats_folder: None,
            templates_folder: None,
            incomplete_warnings_enabled: true,
            custom_cursor_enabled: true,
            beatgaler_user_id: None,
            telegram_cloud_connected: false,
            telegram_cloud_username: None,
            playback_cache_limit_mb: default_playback_cache_limit_mb(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct YouTubeChannel {
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub connected: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct YouTubeUploadPayload {
    pub audio_path: String,
    pub image_base64: Option<String>,
    pub image_path: Option<String>,
    pub video_path: Option<String>,
    pub video_loop: bool,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub visibility: String,
    pub scheduled_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct YouTubeUploadResult {
    pub video_id: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StoredOAuthClient {
    client_type: String,
    client_id: String,
    client_secret: Option<String>,
    auth_uri: String,
    token_uri: String,
    redirect_uris: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct StoredYouTubeTokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}



pub struct SettingsState {
    pub settings: Mutex<AppSettings>,
    pub data_dir: PathBuf,
}

impl SettingsState {
    pub fn beats_dir(&self) -> PathBuf {
        // Legacy import helpers may still ask for a root, but V1 never has a
        // permanent beats folder. Any staging root is OS-temporary.
        beatgaler_temp_dir().join("legacy-import")
    }

    pub fn templates_dir(&self) -> PathBuf {
        let s = self.settings.lock().unwrap();
        if let Some(ref f) = s.templates_folder {
            let p = PathBuf::from(f);
            std::fs::create_dir_all(&p).ok();
            p
        } else {
            let p = self.data_dir.join("templates");
            std::fs::create_dir_all(&p).ok();
            p
        }
    }
}

pub fn load_settings(data_dir: &Path) -> AppSettings {
    let path = data_dir.join("settings.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings_file(data_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    let path = data_dir.join("settings.json");
    serde_json::to_string_pretty(settings)
        .map_err(|e| e.to_string())
        .and_then(|json| std::fs::write(path, json).map_err(|e| e.to_string()))
}

fn copy_path_into(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        copy_dir_recursive(src, dest)
    } else {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Create dir failed: {}", e))?;
        }
        std::fs::copy(src, dest).map_err(|e| format!("Copy failed: {}", e))?;
        Ok(())
    }
}

fn remove_path_best_effort(path: &Path) {
    if path.is_dir() { let _ = std::fs::remove_dir_all(path); }
    else { let _ = std::fs::remove_file(path); }
}

/// Moves the whole library to a new folder WITHOUT ever deleting the
/// originals until the copy and the DB update have both fully succeeded.
/// If anything fails partway (disk full, permission denied, DB error),
/// whatever was already copied into `new_root` is cleaned up and `old_root`
/// is left completely untouched — the user never loses beats to a failed migration.
fn migrate_library_root(old_root: &Path, new_root: &Path, conn: &mut Connection, data_dir: &Path) -> Result<(), String> {
    let old_canon = old_root.canonicalize().unwrap_or_else(|_| old_root.to_path_buf());
    let new_canon = new_root.canonicalize().unwrap_or_else(|_| new_root.to_path_buf());
    if old_canon == new_canon {
        return Ok(());
    }
    if new_canon.starts_with(&old_canon) || old_canon.starts_with(&new_canon) {
        return Err("Choose a folder outside the current Beat Galer folder tree.".to_string());
    }

    std::fs::create_dir_all(new_root).map_err(|e| format!("Cannot create destination folder: {}", e))?;
    log_info(data_dir, &format!("Migrating library: {} -> {}", old_root.display(), new_root.display()));

    let db_rows = db_load_all(conn).map_err(|e| e.to_string())?;
    let mut moved_folders = std::collections::HashMap::<String, String>::new();
    let mut copied_dest_paths: Vec<PathBuf> = Vec::new();

    if old_root.exists() {
        let entries = std::fs::read_dir(old_root).map_err(|e| format!("Read dir failed: {}", e))?;
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    for p in &copied_dest_paths { remove_path_best_effort(p); }
                    log_error(data_dir, &format!("Migration aborted (read dir entry failed): {}", e));
                    return Err(format!("Read dir entry failed: {}", e));
                }
            };
            let src_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let dest_path = unique_folder_path(new_root, &name);

            if let Err(e) = copy_path_into(&src_path, &dest_path) {
                // Roll back everything copied so far. The originals in
                // old_root were only ever READ, never touched — nothing lost.
                for p in &copied_dest_paths { remove_path_best_effort(p); }
                remove_path_best_effort(&dest_path);
                log_error(data_dir, &format!("Migration aborted while copying '{}': {}", name, e));
                return Err(format!(
                    "Could not copy '{}' to the new folder — nothing was moved, your original files are untouched. ({})",
                    name, e
                ));
            }
            copied_dest_paths.push(dest_path.clone());
            moved_folders.insert(src_path.to_string_lossy().to_string(), dest_path.to_string_lossy().to_string());
        }
    }

    // Update the DB atomically — either every beat ends up pointing at the
    // new location, or (on any failure) none of them do.
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut db_error: Option<String> = None;
    for row in &db_rows {
        let Some(new_folder) = moved_folders.get(&row.folder_path) else { continue; };
        let new_folder_path = PathBuf::from(new_folder);
        let stored_mp3 = PathBuf::from(&row.mp3_path);
        let candidate_mp3 = stored_mp3.file_name().map(|n| new_folder_path.join(n)).filter(|p| p.exists());
        let files = scan_folder_structured(&new_folder_path);
        let new_mp3 = candidate_mp3.or_else(|| files.mp3s.first().cloned()).unwrap_or_default();
        if let Err(e) = tx.execute(
            "UPDATE beats SET folder_path=?1, mp3_path=?2 WHERE id=?3",
            params![new_folder, new_mp3.to_string_lossy().to_string(), row.id],
        ) {
            db_error = Some(e.to_string());
            break;
        }
    }

    if let Some(err) = db_error {
        let _ = tx.rollback();
        for p in &copied_dest_paths { remove_path_best_effort(p); }
        log_error(data_dir, &format!("Migration aborted (DB update failed): {}", err));
        return Err(format!("Database update failed during migration — nothing was moved, your original files are untouched. ({})", err));
    }

    if let Err(e) = tx.commit() {
        for p in &copied_dest_paths { remove_path_best_effort(p); }
        log_error(data_dir, &format!("Migration aborted (commit failed): {}", e));
        return Err(e.to_string());
    }

    // Only now — copies confirmed on disk AND the DB confirmed updated —
    // do we remove the originals.
    if old_root.exists() {
        if let Ok(rd) = std::fs::read_dir(old_root) {
            for entry in rd.flatten() {
                remove_path_best_effort(&entry.path());
            }
        }
        let _ = std::fs::remove_dir(old_root);
    }

    log_info(data_dir, "Migration completed successfully");
    Ok(())
}


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaybackCacheStatus {
    pub used_bytes: u64,
    pub limit_mb: u64,
}


#[derive(Debug, Clone, PartialEq, Eq)]
struct PlaybackCacheCandidate {
    path: PathBuf,
    bytes: u64,
    last_used: u64,
}

fn playback_cache_access_path(path: &Path) -> PathBuf {
    path.with_extension("access")
}

fn mark_playback_cache_access(path: &Path) {
    let access = playback_cache_access_path(path);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Small sidecar gives us a cross-platform, persistent "last used" signal.
    // It avoids depending on filesystem atime, which Windows may update lazily.
    let _ = std::fs::write(access, now.to_string());
}

fn playback_cache_last_used(path: &Path) -> u64 {
    let access = playback_cache_access_path(path);
    let metadata = std::fs::metadata(&access).or_else(|_| std::fs::metadata(path));
    metadata.ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn select_playback_cache_evictions(
    mut candidates: Vec<PlaybackCacheCandidate>,
    limit_bytes: u64,
    protected: &std::collections::HashSet<PathBuf>,
) -> Vec<PathBuf> {
    let mut used: u64 = candidates.iter().map(|c| c.bytes).sum();
    if used <= limit_bytes { return Vec::new(); }

    // Oldest use first. Path tie-breaker keeps the result deterministic.
    candidates.sort_by(|a, b| a.last_used.cmp(&b.last_used).then_with(|| a.path.cmp(&b.path)));
    let mut evict = Vec::new();
    for candidate in candidates {
        if used <= limit_bytes { break; }
        if protected.contains(&candidate.path) { continue; }
        used = used.saturating_sub(candidate.bytes);
        evict.push(candidate.path);
    }
    evict
}

fn enforce_playback_cache_limit_in_dir(
    dir: &Path,
    limit_bytes: u64,
    protected: &std::collections::HashSet<PathBuf>,
) -> u64 {
    let mut candidates = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("mp3") && !ext.eq_ignore_ascii_case("part") { continue; }
            let Ok(meta) = std::fs::metadata(&path) else { continue; };
            candidates.push(PlaybackCacheCandidate {
                bytes: meta.len(),
                last_used: playback_cache_last_used(&path),
                path,
            });
        }
    }
    let total: u64 = candidates.iter().map(|c| c.bytes).sum();
    let evictions = select_playback_cache_evictions(candidates, limit_bytes, protected);
    let mut removed = 0u64;
    for path in evictions {
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            let _ = std::fs::remove_file(playback_cache_access_path(&path));
            removed = removed.saturating_add(bytes);
        }
    }
    total.saturating_sub(removed)
}

fn active_playback_cache_paths() -> std::collections::HashSet<PathBuf> {
    let mut protected = std::collections::HashSet::new();
    if let Some(manager) = DOWNLOAD_COOKING_MANAGER.get() {
        if let Ok(state) = manager.state.lock() {
            for entry in state.entries.values() {
                if entry.in_flight || entry.queued || entry.hot {
                    protected.insert(entry.part_path.clone());
                    protected.insert(entry.final_path.clone());
                }
            }
        }
    }
    protected
}

fn enforce_playback_cache_limit(limit_mb: u64) -> u64 {
    let limit_bytes = limit_mb.saturating_mul(1024 * 1024);
    let protected = active_playback_cache_paths();
    enforce_playback_cache_limit_in_dir(&playback_cache_audio_dir(), limit_bytes, &protected)
}

fn playback_cache_audio_dir() -> PathBuf {
    beatgaler_temp_dir().join("cloud-cache").join("audio")
}

fn playback_cache_used_bytes() -> u64 {
    let dir = playback_cache_audio_dir();
    std::fs::read_dir(dir).ok().into_iter().flatten().flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("mp3") && !ext.eq_ignore_ascii_case("part") { return None; }
            std::fs::metadata(path).ok().map(|m| m.len())
        })
        .sum()
}

#[tauri::command]
pub fn get_playback_cache_status(state: tauri::State<SettingsState>) -> PlaybackCacheStatus {
    let limit_mb = state.settings.lock()
        .map(|s| s.playback_cache_limit_mb)
        .unwrap_or(default_playback_cache_limit_mb());
    PlaybackCacheStatus { used_bytes: playback_cache_used_bytes(), limit_mb }
}

#[tauri::command]
pub fn set_playback_cache_limit_mb(
    limit_mb: u64,
    state: tauri::State<SettingsState>,
) -> Result<PlaybackCacheStatus, String> {
    let limit_mb = limit_mb.min(51_200);
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.playback_cache_limit_mb = limit_mb;
        save_settings_file(&state.data_dir, &*settings)?;
    }
    PLAYBACK_CACHE_LIMIT_MB.store(limit_mb, Ordering::Relaxed);
    let used_bytes = enforce_playback_cache_limit(limit_mb);
    Ok(PlaybackCacheStatus { used_bytes, limit_mb })
}

#[tauri::command]
pub fn clear_playback_cache(state: tauri::State<SettingsState>) -> Result<PlaybackCacheStatus, String> {
    // Offline packages live under app_data/offline and are deliberately NOT
    // touched here. This command owns only temporary Download Cooking cache.
    let dir = playback_cache_audio_dir();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
            if ext.eq_ignore_ascii_case("mp3") || ext.eq_ignore_ascii_case("part") || ext.eq_ignore_ascii_case("access") || ext.starts_with("chunk-") || ext.starts_with("headers-") {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    // The Rust cooker survives a WebView refresh. Previously its in-memory
    // entries could still say `complete=true` after Clear cache deleted the
    // underlying MP3, so the next Play returned a dead localhost URL and never
    // queued Telegram again. Reset only transient cooker state; Offline pins are
    // stored in a separate SQLite table/directory and remain intact.
    if let Some(manager) = DOWNLOAD_COOKING_MANAGER.get() {
        if let Ok(mut cooking) = manager.state.lock() {
            cooking.queue.clear();
            for entry in cooking.entries.values_mut() {
                entry.downloaded = 0;
                entry.total = None;
                entry.queued = false;
                entry.hot = false;
                entry.complete = false;
                entry.failed = false;
                entry.warm_ready_logged = false;
            }
            manager.cv.notify_all();
        }
    }

    let limit_mb = state.settings.lock().map_err(|e| e.to_string())?.playback_cache_limit_mb;
    Ok(PlaybackCacheStatus { used_bytes: playback_cache_used_bytes(), limit_mb })
}

#[tauri::command]
pub fn get_settings(state: tauri::State<SettingsState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_incomplete_warnings_enabled(
    enabled: bool,
    state: tauri::State<SettingsState>,
) -> Result<(), String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.incomplete_warnings_enabled = enabled;
    save_settings_file(&state.data_dir, &*settings)
}

#[tauri::command]
pub fn set_custom_cursor_enabled(
    enabled: bool,
    state: tauri::State<SettingsState>,
) -> Result<(), String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.custom_cursor_enabled = enabled;
    save_settings_file(&state.data_dir, &*settings)
}

#[tauri::command]
pub fn set_beats_folder(
    _folder: String,
    state: tauri::State<SettingsState>,
    _db: tauri::State<DbState>,
) -> Result<(), String> {
    // Cloud-only V1 has no permanent beats directory. Clear any legacy value.
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.beats_folder = None;
    save_settings_file(&state.data_dir, &*settings)
}


#[tauri::command]
pub fn set_templates_folder(
    folder: String,
    state: tauri::State<SettingsState>,
) -> Result<(), String> {
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.templates_folder = Some(folder);
    save_settings_file(&state.data_dir, &*s)
}

#[tauri::command]
pub fn get_templates_dir(state: tauri::State<SettingsState>) -> String {
    state.templates_dir().to_string_lossy().to_string()
}

/// Lists every .txt preset saved in the managed templates folder (full
/// paths, sorted by filename). The frontend reads each one individually via
/// readTemplateFile — this command only does the directory listing part,
/// since Tauri's fs plugin scope requires knowing paths up front.
#[tauri::command]
pub fn list_template_files(state: tauri::State<SettingsState>) -> Result<Vec<String>, String> {
    let dir = state.templates_dir();
    let mut paths: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("txt")).unwrap_or(false) {
                paths.push(p.to_string_lossy().to_string());
            }
        }
    }
    paths.sort();
    Ok(paths)
}

#[tauri::command]
pub fn delete_template_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("Could not delete preset: {}", e))?;
    }
    Ok(())
}

// ── Upload presets (title/description/tags), stored as .txt files ──
// Read/written directly via std::fs (not the JS fs plugin) so this never
// runs into Tauri's capability/scope restrictions — same reasoning as
// everything else in this file that touches the filesystem.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TemplateData {
    pub name: String,
    pub title_template: String,
    pub description_template: String,
    pub tags: Vec<String>,
}

fn extract_template_block(raw: &str, tag: &str) -> String {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    if let Some(start) = raw.find(&open) {
        let content_start = start + open.len();
        if let Some(end_rel) = raw[content_start..].find(&close) {
            return raw[content_start..content_start + end_rel].trim().to_string();
        }
    }
    String::new()
}

fn parse_template_txt(raw: &str, fallback_name: &str) -> TemplateData {
    let tags_raw = extract_template_block(raw, "tags");
    let tags: Vec<String> = tags_raw
        .split(|c: char| c == '\n' || c == ',' || c == ';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    TemplateData {
        name: fallback_name.to_string(),
        title_template: extract_template_block(raw, "title"),
        description_template: extract_template_block(raw, "description"),
        tags,
    }
}

fn serialize_template_txt(t: &TemplateData) -> String {
    format!(
        "<title>\n{}\n</title>\n\n<description>\n{}\n</description>\n\n<tags>\n{}\n</tags>",
        t.title_template, t.description_template, t.tags.join(",")
    )
}

#[tauri::command]
pub fn read_template_file(path: String) -> Result<TemplateData, String> {
    let p = PathBuf::from(&path);
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("Could not read preset: {}", e))?;
    let fallback_name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Untitled".to_string());
    Ok(parse_template_txt(&raw, &fallback_name))
}

#[tauri::command]
pub fn write_template_file(path: String, template: TemplateData) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create templates folder: {}", e))?;
    }
    let contents = serialize_template_txt(&template);
    std::fs::write(&p, contents).map_err(|e| format!("Could not save preset: {}", e))
}

// ── Preset trash (mirrors the beat trash pattern above, but on its own
// table/folder since restore semantics differ completely: a beat restore
// rebuilds a BeatMeta from a folder scan, a preset restore is just writing
// the .txt back and re-parsing it) ──

#[derive(Debug, Serialize, Deserialize)]
pub struct TemplateTrashItem {
    pub id: String,
    pub preset_name: String,
    pub trashed_at: i64,
}

#[tauri::command]
pub fn delete_template_to_trash(
    path: String,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<(), String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err("Ese preset ya no existe.".to_string());
    }
    let preset_name = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Untitled".to_string());

    let trash_dir = settings.data_dir.join(".trash-templates");
    std::fs::create_dir_all(&trash_dir).map_err(|e| format!("No se pudo crear la papelera de presets: {}", e))?;

    let fname = src.file_name().unwrap_or_default().to_string_lossy().to_string();
    let dest = trash_dir.join(format!("{}_{}", now_epoch(), fname));

    if std::fs::rename(&src, &dest).is_err() {
        // Cross-device fallback: copy then remove the original.
        std::fs::copy(&src, &dest).map_err(|e| format!("No se pudo mover el preset a la papelera: {}", e))?;
        let _ = std::fs::remove_file(&src);
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let trash_id = random_urlsafe(10);
    conn.execute(
        "INSERT INTO template_trash (id, original_path, trashed_path, preset_name, trashed_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))",
        params![trash_id, path, dest.to_string_lossy().to_string(), preset_name],
    ).map_err(|e| e.to_string())?;

    log_info(&settings.data_dir, &format!("Preset '{}' moved to trash", preset_name));
    Ok(())
}

#[tauri::command]
pub fn list_template_trash(state: tauri::State<DbState>) -> Result<Vec<TemplateTrashItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, preset_name, trashed_at FROM template_trash ORDER BY trashed_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(TemplateTrashItem {
        id: r.get(0)?, preset_name: r.get(1)?, trashed_at: r.get(2)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// Restores a trashed preset. Writes it back into the CURRENT templates
/// folder (not necessarily its original path, in case that folder moved
/// since deletion) and returns the parsed template so the frontend can drop
/// it straight into the preset list without a full reload.
#[tauri::command]
pub fn restore_template_from_trash(
    trash_id: String,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<TemplateData, String> {
    let (original_path, trashed_path) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT original_path, trashed_path FROM template_trash WHERE id=?1",
            params![trash_id.clone()],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        ).map_err(|_| "Ese preset ya no está en la papelera.".to_string())?
    };

    let src = PathBuf::from(&trashed_path);
    if !src.exists() {
        return Err("El archivo de este preset ya no existe en la papelera.".to_string());
    }

    let templates_dir = settings.templates_dir();
    std::fs::create_dir_all(&templates_dir).ok();
    let fname = PathBuf::from(&original_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "preset.txt".to_string());
    let mut dest = templates_dir.join(&fname);
    if dest.exists() {
        // Something already occupies that name — disambiguate instead of overwriting.
        let stem = PathBuf::from(&fname).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "preset".to_string());
        dest = templates_dir.join(format!("{}_restored_{}.txt", stem, now_epoch()));
    }

    if std::fs::rename(&src, &dest).is_err() {
        std::fs::copy(&src, &dest).map_err(|e| format!("No se pudo restaurar el preset: {}", e))?;
        let _ = std::fs::remove_file(&src);
    }

    let raw = std::fs::read_to_string(&dest).map_err(|e| format!("No se pudo leer el preset restaurado: {}", e))?;
    let fallback_name = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Untitled".to_string());
    let template = parse_template_txt(&raw, &fallback_name);

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM template_trash WHERE id=?1", params![trash_id]).map_err(|e| e.to_string())?;
    log_info(&settings.data_dir, &format!("Preset restored from trash: {}", template.name));
    Ok(template)
}

/// Same 14-day auto-purge pattern as beat trash — see purge_old_trash_internal.
pub fn purge_old_template_trash_internal(conn: &Connection, data_dir: &Path, max_age_days: i64) -> usize {
    let cutoff = now_epoch().saturating_sub((max_age_days.max(0) as u64) * 86400) as i64;
    let mut stmt = match conn.prepare("SELECT id, trashed_path FROM template_trash WHERE trashed_at < ?1") {
        Ok(s) => s, Err(_) => return 0,
    };
    let rows: Vec<(String, String)> = match stmt.query_map(params![cutoff], |r| Ok((r.get(0)?, r.get(1)?))) {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => return 0,
    };
    drop(stmt);

    let mut purged = 0;
    for (trash_id, path) in rows {
        let p = PathBuf::from(&path);
        if p.exists() { let _ = std::fs::remove_file(&p); }
        if conn.execute("DELETE FROM template_trash WHERE id=?1", params![trash_id]).is_ok() {
            purged += 1;
        }
    }
    if purged > 0 { log_info(data_dir, &format!("Auto-purged {} preset trash item(s) older than {} days", purged, max_age_days)); }
    purged
}

#[tauri::command]
pub fn purge_template_trash_now(state: tauri::State<DbState>, settings: tauri::State<SettingsState>) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(purge_old_template_trash_internal(&conn, &settings.data_dir, 0))
}

// ─────────────────────────────────────────────────────────────
//  Gradient
// ─────────────────────────────────────────────────────────────

fn hsl_to_hex(h: f32, s: f32, l: f32) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r1, g1, b1) = match h as u32 {
        0..=59   => (c, x, 0.0),
        60..=119 => (x, c, 0.0),
        120..=179 => (0.0, c, x),
        180..=239 => (0.0, x, c),
        240..=299 => (x, 0.0, c),
        _         => (c, 0.0, x),
    };
    let r = ((r1 + m) * 255.0).round() as u8;
    let g = ((g1 + m) * 255.0).round() as u8;
    let b = ((b1 + m) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

fn gradient_for(name: &str) -> (String, String) {
    let hash: u64 = name.bytes().enumerate()
        .map(|(i, b)| (b as u64).wrapping_mul(31u64.wrapping_pow(i as u32)))
        .fold(0u64, |acc, v| acc.wrapping_add(v));
    let base_hue = (hash % 360) as f32;
    let hue2 = (base_hue + 44.0) % 360.0;
    let var = ((hash >> 8) % 20) as f32;
    let sat = 0.55 + var * 0.0075;
    let light1 = 0.30 + ((hash >> 4) % 8) as f32 * 0.01;
    let light2 = 0.24 + ((hash >> 12) % 6) as f32 * 0.01;
    (hsl_to_hex(base_hue, sat, light1), hsl_to_hex(hue2, sat, light2))
}

// ─────────────────────────────────────────────────────────────
//  BPM / Key filename parsing & formatting
// ─────────────────────────────────────────────────────────────

pub fn parse_bpm_key_from_filename(filename: &str) -> (Option<String>, Option<String>) {
    let re_bracket = regex_lite::Regex::new(r"\[([^\]]+)\]").unwrap();
    for cap in re_bracket.captures_iter(filename) {
        let inner = cap[1].trim();
        // Restrict keys to allowed letters (A,B,C,D,E,F,G) with optional #/b and optional m (minor)
        let re_bpm_key = regex_lite::Regex::new(r"^(\d{2,3})\s+([ABCDEFGabcdefg][b#]?m?)$").unwrap();
        if let Some(m) = re_bpm_key.captures(inner) {
            return (Some(m[1].to_string()), Some(normalize_key(&m[2].to_string())));
        }
        let re_key_bpm = regex_lite::Regex::new(r"^([ABCDEFGabcdefg][b#]?m?)\s+(\d{2,3})$").unwrap();
        if let Some(m) = re_key_bpm.captures(inner) {
            return (Some(m[2].to_string()), Some(normalize_key(&m[1].to_string())));
        }
    }
    (None, None)
}

// Normalize a key string to canonical form or return empty string if invalid.
// Accepts forms like: "A", "A#", "Bb", "Am", "A#m", "Bb m", "C Major", "C Minor" (minor -> m)
fn normalize_key(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() { return String::new(); }
    let s = s.replace('♯', "#").replace('♭', "b");

    // Friendly input is accepted, but BeatGaler always emits one strict form:
    // major = C / C# / Cb, minor = cm / c#m / cbm.
    let long = regex_lite::Regex::new(r"^([A-Ga-g])([#b])?\s*(major|maj|minor|min)$").unwrap();
    if let Some(c) = long.captures(&s) {
        let root = c.get(1).unwrap().as_str();
        let accidental = c.get(2).map(|m| m.as_str()).unwrap_or("");
        let quality = c.get(3).unwrap().as_str().to_ascii_lowercase();
        let minor = quality.starts_with("min");
        let root = if minor { root.to_ascii_lowercase() } else { root.to_ascii_uppercase() };
        return format!("{}{}{}", root, accidental, if minor { "m" } else { "" });
    }

    let compact = s.split_whitespace().collect::<String>();
    let short = regex_lite::Regex::new(r"^([A-Ga-g])([#b])?(m)?$").unwrap();
    if let Some(c) = short.captures(&compact) {
        let root = c.get(1).unwrap().as_str();
        let accidental = c.get(2).map(|m| m.as_str()).unwrap_or("");
        let minor = c.get(3).is_some();
        let root = if minor { root.to_ascii_lowercase() } else { root.to_ascii_uppercase() };
        return format!("{}{}{}", root, accidental, if minor { "m" } else { "" });
    }

    String::new()
}

fn bracket_token_is_bpm(token: &str) -> bool {
    let t = token.trim();
    t.len() >= 2 && t.len() <= 3 && t.chars().all(|ch| ch.is_ascii_digit())
}

fn bracket_token_is_key(token: &str) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    !normalize_key(token).is_empty()
}

fn bracket_is_metadata_marker(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return false;
    }

    // A bracket is BeatGaler metadata only when the whole bracket is metadata.
    // This prevents legitimate labels such as "[VERSION A]" from being removed
    // merely because one word ("A") also happens to be a valid musical key.
    if !normalize_key(trimmed).is_empty() {
        return true;
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    !tokens.is_empty()
        && tokens
            .iter()
            .all(|token| bracket_token_is_bpm(token) || bracket_token_is_key(token))
}

/// Strip BeatGaler BPM/key metadata brackets from a stem while preserving
/// unrelated user text such as "[FINAL]" or "[DRAFT MIX]".
pub fn clean_name_from_filename(filename: &str) -> String {
    let stem = if let Some(dot) = filename.rfind('.') { &filename[..dot] } else { filename };
    let mut out = String::with_capacity(stem.len());
    let chars: Vec<char> = stem.chars().collect();
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(relative_end) = chars[i + 1..].iter().position(|ch| *ch == ']') {
                let end = i + 1 + relative_end;
                let content: String = chars[i + 1..end].iter().collect();
                if bracket_is_metadata_marker(&content) {
                    while out.ends_with(' ') {
                        out.pop();
                    }
                    i = end + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }

    out.trim().to_string()
}

pub fn format_bpm_key_suffix(bpm: &str, key: &str) -> String {
    if bpm.is_empty() && key.is_empty() { return String::new(); }
    if bpm.is_empty() { return format!("[{}]", key); }
    if key.is_empty() { return format!("[{}]", bpm); }
    // Ensure key is normalized when formatting
    let key_n = normalize_key(key);
    if key_n.is_empty() { format!("[{}]", bpm) } else { format!("[{} {}]", bpm, key_n) }
}

pub fn canonical_filename(clean_name: &str, bpm: &str, key: &str, ext: &str) -> String {
    let suffix = format_bpm_key_suffix(bpm, key);
    if suffix.is_empty() { format!("{}.{}", clean_name, ext) }
    else { format!("{} {}.{}", clean_name, suffix, ext) }
}

fn normalized_beat_name_key(name: &str) -> String {
    // Finder/APFS can surface canonically equivalent Unicode using a different
    // scalar representation than Windows. Normalize identity comparisons to NFC
    // so e.g. "Canción" and "Cancio\u{301}n" cannot become two cloud beats.
    let nfc = name.nfc().collect::<String>();
    nfc.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_lowercase()
}

fn normalized_beat_display_name(name: &str) -> String {
    name.nfc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn ensure_unique_beat_name(_conn: &Connection, beat: &BeatMeta) -> rusqlite::Result<()> {
    // Telegram's pinned library index is the ONLY authority for durable beat
    // identity/name ownership. SQLite is a cache/operational store and must
    // never reject a name merely because a stale/local row still exists.
    if normalized_beat_name_key(&beat.name).is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(
            "Beat name cannot be empty.".to_string(),
        ));
    }
    Ok(())
}

fn beat_metadata_is_empty(beat: &BeatMeta) -> bool {
    beat.bpm.trim().is_empty()
        && beat.key.trim().is_empty()
        && beat.tags.is_empty()
        && beat.rating == 0
        && beat.image_base64.as_deref().map(|v| v.trim().is_empty()).unwrap_or(true)
}

fn adopt_mp3_metadata_if_empty(beat: &BeatMeta, source: &Path) -> BeatMeta {
    let is_mp3 = source.extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("mp3"))
        .unwrap_or(false);
    if !is_mp3 || !beat_metadata_is_empty(beat) {
        return beat.clone();
    }

    let (bpm, key, tags, rating, image_base64) = read_id3(source);
    let has_source_metadata = !bpm.trim().is_empty()
        || !key.trim().is_empty()
        || !tags.is_empty()
        || rating > 0
        || image_base64.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false);
    if !has_source_metadata {
        return beat.clone();
    }

    let mut adopted = beat.clone();
    adopted.bpm = bpm;
    adopted.key = key;
    adopted.tags = tags;
    adopted.rating = rating;
    adopted.image_base64 = image_base64;
    adopted
}

// ─────────────────────────────────────────────────────────────
//  DB
// ─────────────────────────────────────────────────────────────

pub fn init_db(db_path: &Path) -> rusqlite::Result<Connection> {
    let mut conn = Connection::open(db_path)?;
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS beats (
            id          TEXT PRIMARY KEY,
            mp3_path    TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            color       TEXT NOT NULL,
            color2      TEXT NOT NULL,
            sort_order  INTEGER DEFAULT 0,
            added_at    INTEGER DEFAULT (strftime('%s','now')),
            folder_signature TEXT,
            meta_json   TEXT
        );
    ")?;
    let _ = conn.execute("ALTER TABLE beats ADD COLUMN sort_order INTEGER DEFAULT 0", []);
    // Cache the disk signature and fully built BeatMeta so startup can avoid
    // re-reading ID3 metadata when a beat folder has not changed.
    let _ = conn.execute("ALTER TABLE beats ADD COLUMN folder_signature TEXT", []);
    let _ = conn.execute("ALTER TABLE beats ADD COLUMN meta_json TEXT", []);
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS import_decisions (
            path_hash   TEXT PRIMARY KEY,
            file_path   TEXT NOT NULL,
            decision    TEXT NOT NULL,
            role        TEXT,
            decided_at  INTEGER DEFAULT (strftime('%s','now'))
        );
    ")?;
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS trash (
            id                    TEXT PRIMARY KEY,
            original_folder_path  TEXT NOT NULL,
            trashed_path          TEXT NOT NULL,
            beat_name             TEXT NOT NULL,
            beat_meta_json        TEXT,
            is_cloud              INTEGER NOT NULL DEFAULT 0,
            trashed_at            INTEGER DEFAULT (strftime('%s','now'))
        );
    ")?;
    let _ = conn.execute("ALTER TABLE trash ADD COLUMN beat_meta_json TEXT", []);
    let _ = conn.execute("ALTER TABLE trash ADD COLUMN is_cloud INTEGER NOT NULL DEFAULT 0", []);
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS template_trash (
            id             TEXT PRIMARY KEY,
            original_path  TEXT NOT NULL,
            trashed_path   TEXT NOT NULL,
            preset_name    TEXT NOT NULL,
            trashed_at     INTEGER DEFAULT (strftime('%s','now'))
        );
    ")?;
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS cloud_projects (
            beat_id             TEXT PRIMARY KEY,
            local_zip_path      TEXT,
            manifest_json       TEXT NOT NULL,
            source_size         INTEGER,
            source_modified_ms  INTEGER,
            uploaded_at         INTEGER DEFAULT (strftime('%s','now'))
        );
    ")?;
    let _ = conn.execute("ALTER TABLE cloud_projects ADD COLUMN source_size INTEGER", []);
    let _ = conn.execute("ALTER TABLE cloud_projects ADD COLUMN source_modified_ms INTEGER", []);
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS cloud_metadata (
            beat_id                       TEXT PRIMARY KEY,
            telegram_metadata_message_id  INTEGER,
            artwork_hash                  TEXT,
            artwork_telegram_file_id      TEXT,
            artwork_telegram_message_id   INTEGER,
            updated_at                    INTEGER DEFAULT (strftime('%s','now'))
        );
    ")?;
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS cloud_files (
            cloud_file_id       TEXT PRIMARY KEY,
            beat_id             TEXT NOT NULL,
            file_type           TEXT NOT NULL,
            filename            TEXT NOT NULL,
            source_path         TEXT,
            source_size         INTEGER,
            source_modified_ms  INTEGER,
            manifest_json       TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'SYNCED',
            created_at          INTEGER DEFAULT (strftime('%s','now')),
            updated_at          INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cloud_files_beat_type
        ON cloud_files(beat_id, file_type);

        CREATE TABLE IF NOT EXISTS offline_beats (
            user_id                 TEXT NOT NULL,
            beat_id                 TEXT NOT NULL,
            root_path               TEXT NOT NULL,
            master_path             TEXT NOT NULL,
            master_telegram_file_id TEXT NOT NULL,
            cloud_fingerprint       TEXT NOT NULL,
            beat_meta_json          TEXT NOT NULL,
            created_at              INTEGER DEFAULT (strftime('%s','now')),
            PRIMARY KEY(user_id, beat_id)
        );
        CREATE INDEX IF NOT EXISTS idx_offline_beats_user
        ON offline_beats(user_id);

        CREATE TABLE IF NOT EXISTS offline_trash_intents (
            user_id    TEXT NOT NULL,
            beat_id    TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            PRIMARY KEY(user_id, beat_id)
        );
        CREATE INDEX IF NOT EXISTS idx_offline_trash_intents_user
        ON offline_trash_intents(user_id);
    ")?;
    migrate_sqlite_schema(&mut conn)?;
    Ok(conn)
}

struct DbBeat {
    id: String,
    mp3_path: String,
    folder_path: String,
    color: String,
    color2: String,
    sort_order: i64,
    folder_signature: Option<String>,
    meta_json: Option<String>,
}

fn db_load_all(conn: &Connection) -> rusqlite::Result<Vec<DbBeat>> {
    let mut stmt = conn.prepare(
        "SELECT id, mp3_path, folder_path, color, color2, sort_order, folder_signature, meta_json FROM beats ORDER BY sort_order ASC, added_at DESC")?;
    let rows = stmt.query_map([], |r| Ok(DbBeat {
        id: r.get(0)?, mp3_path: r.get(1)?, folder_path: r.get(2)?,
        color: r.get(3)?, color2: r.get(4)?, sort_order: r.get(5)?,
        folder_signature: r.get(6)?, meta_json: r.get(7)?,
    }))?;
    rows.collect()
}

/// Cheap change detector for a beat folder. It walks file metadata only —
/// no ID3/audio parsing — and hashes relative path, size and mtime. This
/// catches additions/removals, renames and edits to existing audio files.
fn folder_signature(folder: &Path) -> Result<String, String> {
    let mut entries: Vec<String> = Vec::new();
    for entry in WalkDir::new(folder).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_symlink() { continue; }
        let path = entry.path();
        if path == folder { continue; }
        let rel = path.strip_prefix(folder).unwrap_or(path).to_string_lossy();
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let len = if meta.is_file() { meta.len() } else { 0 };
        let mtime = meta.modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        entries.push(format!("{}|{}|{}|{}", if meta.is_dir() { 'd' } else { 'f' }, rel, len, mtime));
    }
    entries.sort_unstable();
    let mut hasher = Sha256::new();
    for entry in entries { hasher.update(entry.as_bytes()); hasher.update([0u8]); }
    Ok(format!("{:x}", hasher.finalize()))
}

fn db_cached_meta(existing: &DbBeat, signature: &str) -> Option<BeatMeta> {
    if existing.folder_signature.as_deref() != Some(signature) { return None; }
    let mut cached: BeatMeta = existing.meta_json.as_deref().and_then(|raw| serde_json::from_str(raw).ok())?;

    // Samples detection is cheap and must not rely on old cached JSON. This also
    // upgrades libraries created before has_samples/samples_path existed.
    let folder = PathBuf::from(&cached.folder_path);
    cached.samples_path = find_samples_folder(&folder).map(|p| p.to_string_lossy().to_string());
    cached.has_samples = cached.samples_path.is_some();
    Some(cached)
}

fn db_meta(existing: &DbBeat) -> Option<BeatMeta> {
    existing.meta_json.as_deref().and_then(|raw| serde_json::from_str(raw).ok())
}

fn is_cloud_backed(meta: &BeatMeta) -> bool {
    meta.telegram_file_id.as_deref().map(|v| !v.is_empty()).unwrap_or(false)
        && matches!(meta.cloud_status.as_deref(), Some("SYNCED") | Some("CLOUD_ONLY"))
}

fn mark_cloud_only(conn: &Connection, existing: &DbBeat) -> Result<bool, String> {
    let Some(mut meta) = db_meta(existing) else { return Ok(false); };
    if !is_cloud_backed(&meta) { return Ok(false); }
    meta.cloud_status = Some("CLOUD_ONLY".to_string());
    db_save(conn, &meta).map_err(|e| e.to_string())?;
    Ok(true)
}

fn db_save(conn: &Connection, b: &BeatMeta) -> rusqlite::Result<()> {
    ensure_unique_beat_name(conn, b)?;
    let signature = folder_signature(Path::new(&b.folder_path)).ok();
    let meta_json = serde_json::to_string(b).ok();
    conn.execute(
        "INSERT INTO beats (id, mp3_path, folder_path, color, color2, sort_order, folder_signature, meta_json)\n         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT sort_order FROM beats WHERE id=?1), 0), ?6, ?7)\n         ON CONFLICT(id) DO UPDATE SET\n           mp3_path=excluded.mp3_path,\n           folder_path=excluded.folder_path,\n           color=excluded.color,\n           color2=excluded.color2,\n           folder_signature=excluded.folder_signature,\n           meta_json=excluded.meta_json",
        params![b.id, b.mp3_path, b.folder_path, b.color, b.color2, signature, meta_json],
    )?;
    Ok(())
}

fn db_upsert_with_order(conn: &Connection, b: &BeatMeta, sort_order: Option<i64>) -> rusqlite::Result<()> {
    ensure_unique_beat_name(conn, b)?;
    let signature = folder_signature(Path::new(&b.folder_path)).ok();
    let meta_json = serde_json::to_string(b).ok();
    conn.execute(
        "INSERT INTO beats (id, mp3_path, folder_path, color, color2, sort_order, folder_signature, meta_json)\n         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 0), ?7, ?8)\n         ON CONFLICT(id) DO UPDATE SET\n           mp3_path=excluded.mp3_path,\n           folder_path=excluded.folder_path,\n           color=excluded.color,\n           color2=excluded.color2,\n           folder_signature=excluded.folder_signature,
           meta_json=excluded.meta_json",
        params![b.id, b.mp3_path, b.folder_path, b.color, b.color2, sort_order, signature, meta_json],
    )?;
    Ok(())
}

fn sync_library_from_disk(conn: &Connection, beats_root: &Path) -> Result<(), String> {
    let rows = db_load_all(conn).map_err(|e| e.to_string())?;

    // Cloud-backed beats are part of the library even when the local vault
    // folder is unavailable. Local-only beats still follow the old disk-first
    // behavior and disappear if their files are gone.
    if !beats_root.exists() {
        for row in &rows {
            if !mark_cloud_only(conn, row)? {
                conn.execute("DELETE FROM beats WHERE id=?1", params![row.id.clone()]).map_err(|e| e.to_string())?;
            }
        }
        return Ok(());
    }

    let mut by_folder = std::collections::HashMap::<String, DbBeat>::new();
    for row in rows {
        by_folder.insert(row.folder_path.clone(), row);
    }

    let mut seen_folders = std::collections::HashSet::<String>::new();
    let mut next_sort = by_folder.values().map(|row| row.sort_order).max().unwrap_or(-1) + 1;

    for entry in WalkDir::new(beats_root).min_depth(1).max_depth(1) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_dir() { continue; }
        let folder = entry.path();
        let folder_str = folder.to_string_lossy().to_string();
        let signature = folder_signature(folder)?;

        if let Some(existing) = by_folder.get(&folder_str) {
            if let Some(cached) = db_cached_meta(existing, &signature) {
                seen_folders.insert(folder_str.clone());
                let _ = cached;
                continue;
            }
        }

        let files = scan_folder_structured(folder);

        // The folder can remain while its main audio was removed. If Telegram
        // owns a copy, keep the beat and switch it to CLOUD_ONLY instead of
        // deleting it from the library.
        if files.mp3s.is_empty() && files.wavs.is_empty() {
            if let Some(existing) = by_folder.get(&folder_str) {
                if mark_cloud_only(conn, existing)? {
                    seen_folders.insert(folder_str.clone());
                }
            }
            continue;
        }

        seen_folders.insert(folder_str.clone());

        let beat = if let Some(existing) = by_folder.get(&folder_str) {
            let previous_cloud = db_meta(existing);
            let has_conflict = files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1;
            let mut built = build_beat_from_parts(
                existing.id.clone(),
                folder,
                files.mp3s.first().map(|p| p.as_path()),
                files.wavs.first().map(|p| p.as_path()),
                files.stems.first().map(|p| p.as_path()),
                files.flps.first().map(|p| p.as_path()),
                files.alss.first().map(|p| p.as_path()),
                &files.others,
                existing.color.clone(),
                existing.color2.clone(),
                has_conflict,
            );

            // A disk rescan must never erase the Telegram identity of a beat.
            if let Some(previous) = previous_cloud {
                if previous.telegram_file_id.is_some() {
                    built.cloud_status = Some("SYNCED".to_string());
                    built.telegram_file_id = previous.telegram_file_id;
                    built.telegram_message_id = previous.telegram_message_id;
                }
            }

            db_upsert_with_order(conn, &built, Some(existing.sort_order)).map_err(|e| e.to_string())?;
            built
        } else {
            let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
            let name = clean_name_from_filename(&folder_name);
            let (color, color2) = gradient_for(&name);
            let id = make_id(&name, &folder_str);
            let has_conflict = files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1;
            let built = build_beat_from_parts(
                id,
                folder,
                files.mp3s.first().map(|p| p.as_path()),
                files.wavs.first().map(|p| p.as_path()),
                files.stems.first().map(|p| p.as_path()),
                files.flps.first().map(|p| p.as_path()),
                files.alss.first().map(|p| p.as_path()),
                &files.others,
                color,
                color2,
                has_conflict,
            );
            db_upsert_with_order(conn, &built, Some(next_sort)).map_err(|e| e.to_string())?;
            next_sort += 1;
            built
        };

        let _ = beat;
    }

    for row in by_folder.values() {
        if !seen_folders.contains(&row.folder_path) {
            if !mark_cloud_only(conn, row)? {
                conn.execute("DELETE FROM beats WHERE id=?1", params![row.id.clone()]).map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────
//  ID3 read — works for MP3; reads from WAV ID3 chunk if present
// ─────────────────────────────────────────────────────────────

fn read_id3(path: &Path) -> (String, String, Vec<String>, u8, Option<String>) {
    let tag = match Tag::read_from_path(path) {
        Ok(t) => t,
        Err(_) => {
            let fname = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let (bpm, key) = parse_bpm_key_from_filename(&fname);
            return (bpm.unwrap_or_default(), key.unwrap_or_default(), vec![], 0, None);
        }
    };

    let bpm_tag_raw = tag.get("TBPM").and_then(|f| f.content().text()).unwrap_or("").trim().to_string();
    let key_tag_raw = tag.get("TKEY").and_then(|f| f.content().text()).unwrap_or("").trim().to_string();

    // Normalize BPM: extract first 2-3 digit sequence if present
    let bpm_tag = {
        let re = regex_lite::Regex::new(r"(\d{2,3})").unwrap();
        if let Some(m) = re.captures(&bpm_tag_raw) { m.get(1).unwrap().as_str().to_string() } else { String::new() }
    };

    // Normalize key tag using canonical rules; discard if not valid
    let key_tag = normalize_key(&key_tag_raw);

    let (bpm_file, key_file) = {
        let fname = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        parse_bpm_key_from_filename(&fname)
    };
    let bpm = if !bpm_tag.is_empty() { bpm_tag } else { bpm_file.unwrap_or_default() };
    let key = if !key_tag.is_empty() { key_tag } else { key_file.unwrap_or_default() };

    let genre_raw = tag.genre().unwrap_or("").to_string();
    let raw_tags: Vec<String> = genre_raw
        .split(|c: char| c == ';' || c == ',' || c == '/')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    // Invalid metadata tags are dropped, never silently "repaired" into a
    // different tag. Example: `(9)vicious` is invalid and must not become
    // `vicious` during Review Beat.
    let tags = filter_metadata_tags(&raw_tags);

    let rating = tag.frames().find(|f| f.id() == "POPM")
        .and_then(|f| match f.content() {
            id3::Content::Popularimeter(p) => Some(match p.rating {
                0=>0u8, 1..=51=>1, 52..=114=>2, 115..=167=>3, 168..=204=>4, _=>5 }),
            id3::Content::Unknown(u) => {
                let null = u.data.iter().position(|&b| b == 0)?;
                let raw = *u.data.get(null + 1)?;
                Some(match raw { 0=>0u8, 1..=51=>1, 52..=114=>2, 115..=167=>3, 168..=204=>4, _=>5 })
            },
            _ => None,
        }).unwrap_or(0);

    let image_base64 = tag.pictures().next().map(|pic| {
        let mime = if pic.mime_type.to_lowercase().contains("png") { "image/png" } else { "image/jpeg" };
        format!("data:{};base64,{}", mime, general_purpose::STANDARD.encode(&pic.data))
    });

    (bpm, key, tags, rating, image_base64)
}

// ─────────────────────────────────────────────────────────────
//  ID3 write — writes to both MP3 and WAV if provided
// ─────────────────────────────────────────────────────────────

fn filter_metadata_tags(tags: &[String]) -> Vec<String> {
    let re = regex_lite::Regex::new(r"^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$").unwrap();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in tags {
        let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_lowercase();
        if normalized.is_empty() || normalized.chars().count() > 40 || !re.is_match(&normalized) {
            continue;
        }
        if seen.insert(normalized.clone()) {
            out.push(normalized);
            if out.len() >= 30 { break; }
        }
    }
    out
}

fn validate_bpm_value(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() { return Ok(String::new()); }
    let re = regex_lite::Regex::new(r"^\d{1,3}(?:\.\d{1,2})?$").unwrap();
    if !re.is_match(trimmed) {
        return Err("BPM must be a number from 60 to 300".to_string());
    }
    let value: f64 = trimmed.parse().map_err(|_| "BPM must be a number from 60 to 300".to_string())?;
    if !(60.0..=300.0).contains(&value) {
        return Err("BPM must be between 60 and 300".to_string());
    }
    if value.fract() == 0.0 {
        Ok(format!("{:.0}", value))
    } else {
        // Preserve at most the two decimal places accepted above while
        // removing insignificant trailing zeroes.
        let mut canonical = format!("{:.2}", value);
        while canonical.ends_with('0') { canonical.pop(); }
        if canonical.ends_with('.') { canonical.pop(); }
        Ok(canonical)
    }
}

fn validate_key_value(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() { return Ok(String::new()); }
    let normalized = normalize_key(trimmed);
    if normalized.is_empty() {
        return Err("Key must be A-G with optional # or b; minor keys use lowercase + m (for example c#m)".to_string());
    }
    Ok(normalized)
}

fn validate_metadata_tags(tags: &[String]) -> Result<Vec<String>, String> {
    if tags.len() > 30 {
        return Err("Maximum 30 tags per beat".to_string());
    }
    let re = regex_lite::Regex::new(r"^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$").unwrap();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in tags {
        let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_lowercase();
        if normalized.is_empty() { continue; }
        if normalized.chars().count() > 40 {
            return Err(format!("Tag is too long: '{}' (max 40 characters)", raw));
        }
        if !re.is_match(&normalized) {
            return Err(format!("Invalid tag '{}'. Use only letters, numbers, spaces, - or _. Parentheses and separators are not allowed.", raw));
        }
        if seen.insert(normalized.clone()) { out.push(normalized); }
    }
    Ok(out)
}

fn merge_existing_genre(existing: Option<&str>, safe_tags: &[String]) -> Option<String> {
    let existing_raw = existing.unwrap_or("");
    let mut seen = std::collections::HashSet::new();
    for value in existing_raw
        .split(|c: char| c == ';' || c == ',' || c == '/' || c == '\0')
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
    {
        seen.insert(value);
    }

    let mut merged = existing_raw.trim_matches('\0').trim().to_string();
    for value in safe_tags {
        let key = value.trim().to_lowercase();
        if key.is_empty() || !seen.insert(key) { continue; }
        if !merged.is_empty() { merged.push_str("; "); }
        merged.push_str(value.trim());
    }

    if merged.is_empty() { None } else { Some(merged) }
}

fn write_id3_to(path: &Path, bpm: &str, key: &str, tags: &[String], rating: u8, image_base64: Option<&str>) -> Result<(), String> {
    // Metadata export is an OVERLAY, never a destructive rebuild. Preserve
    // artist/album/comments/custom frames/extra pictures/genres already stored
    // in the uploaded audio and only update BeatGaler-owned values that are
    // actually present in the current beat.
    let safe_tags = filter_metadata_tags(tags);
    let safe_bpm = validate_bpm_value(bpm)?;
    let safe_key = validate_key_value(key)?;
    let mut tag = Tag::read_from_path(path).unwrap_or_default();

    if !safe_bpm.is_empty() {
        tag.remove("TBPM");
        tag.set_text("TBPM", safe_bpm);
    }
    if !safe_key.is_empty() {
        tag.remove("TKEY");
        tag.set_text("TKEY", safe_key);
    }

    if !safe_tags.is_empty() {
        let existing_genre = tag.genre().map(|v| v.to_string());
        if let Some(merged_genre) = merge_existing_genre(existing_genre.as_deref(), &safe_tags) {
            tag.remove("TCON");
            tag.set_genre(merged_genre);
        }
    }

    // A zero BeatGaler rating means "no BeatGaler override" during export.
    // Keep any rating frame the source already had. A real BeatGaler rating is
    // added as its own POPM identity; id3::Tag::add_frame replaces a conflicting
    // Beat Galer POPM while leaving non-conflicting source frames intact.
    if rating > 0 {
        let raw: u8 = match rating { 1=>1, 2=>64, 3=>128, 4=>192, _=>255 };
        tag.add_frame(id3::Frame::with_content("POPM",
            id3::Content::Popularimeter(id3::frame::Popularimeter {
                user: "Beat Galer".to_string(), rating: raw, counter: 0,
            })));
    }

    // Only replace CoverFront when BeatGaler actually has artwork bytes. If
    // artwork is temporarily unavailable (for example cache was cleared), the
    // original embedded picture must survive the export untouched.
    if let Some(img) = image_base64 {
        let (mime, b64) = if let Some(comma) = img.find(',') {
            let header = &img[5..comma];
            (header.split(';').next().unwrap_or("image/jpeg").to_string(), &img[comma+1..])
        } else { ("image/jpeg".to_string(), img) };
        if let Ok(bytes) = general_purpose::STANDARD.decode(b64) {
            tag.remove_picture_by_type(frame::PictureType::CoverFront);
            tag.add_frame(frame::Picture {
                mime_type: mime, picture_type: frame::PictureType::CoverFront,
                description: String::new(), data: bytes,
            });
        }
    }
    // Windows Explorer's shell32 ID3 reader has poor/broken support for
    // ID3v2.4 (synchsafe frame sizes, UTF-8 text encoding) — album art
    // embedded in a v2.4 tag frequently fails to show as a thumbnail even
    // though media players read it fine. Writing v2.3 keeps compatibility
    // with Explorer without losing anything we actually use (TBPM, TKEY,
    // TCON, POPM, APIC are all valid in 2.3).
    tag.write_to_path(path, Version::Id3v23).map_err(|e| format!("ID3 write failed: {}", e))
}


// ─────────────────────────────────────────────────────────────
//  Normalización de portada — fuerza que la primera imagen embebida
//  quede marcada como Cover Front, para que Explorer/Finder la usen
//  como thumbnail del archivo. Algunas fuentes (ID3 de terceros, DAWs,
//  etc) taggean la imagen como "Other" y el explorador la ignora.
// ─────────────────────────────────────────────────────────────

fn ensure_cover_front(path: &Path) {
    let mut tag = match Tag::read_from_path(path) {
        Ok(t) => t,
        Err(_) => return, // sin tag legible -> nada que normalizar
    };

    let count = tag.pictures().count();
    let already_front = tag.pictures().next()
        .map(|p| p.picture_type == frame::PictureType::CoverFront)
        .unwrap_or(false);
    if count == 1 && already_front {
        return; // ya está bien, no reescribimos el archivo innecesariamente
    }

    let first = match tag.pictures().next() {
        Some(p) => p,
        None => return, // no tiene imagen embebida
    };
    let mime_type = first.mime_type.clone();
    let data = first.data.clone();

    tag.remove("APIC"); // saca todas las imágenes (evita ambigüedad)
    tag.add_frame(frame::Picture {
        mime_type,
        picture_type: frame::PictureType::CoverFront,
        description: String::new(),
        data,
    });
    // Same reasoning as write_id3_to above: keep Explorer thumbnail support.
    let _ = tag.write_to_path(path, Version::Id3v23);
}

fn normalize_folder_artwork(_folder: &Path) {
    // Cloud-only V1: never alter source folders.
}



// ─────────────────────────────────────────────────────────────
//  File renaming helpers
// ─────────────────────────────────────────────────────────────

fn rename_file_if_needed(old_path: &Path, new_name: &str) -> Result<PathBuf, String> {
    let parent = old_path.parent().unwrap_or(Path::new(""));
    let new_path = parent.join(new_name);
    if new_path == old_path { return Ok(old_path.to_path_buf()); }
    std::fs::rename(old_path, &new_path)
        .map_err(|e| format!("Failed to rename {:?}: {}", old_path.file_name().unwrap_or_default(), e))?;
    Ok(new_path)
}

fn rename_all_files(
    folder_path: &Path, mp3_path: Option<&Path>, wav_path: Option<&Path>,
    stems_path: Option<&Path>, flp_path: Option<&Path>,
    clean_name: &str, bpm: &str, key: &str,
) -> Result<(PathBuf, Option<PathBuf>, Option<PathBuf>, Option<PathBuf>, Option<PathBuf>), String> {
    let base_name = {
        let s = canonical_filename(clean_name, bpm, key, "");
        s.trim_end_matches('.').to_string()
    };

    let new_mp3 = if let Some(p) = mp3_path {
        Some(rename_file_if_needed(p, &format!("{}.mp3", base_name))?)
    } else { None };

    let new_wav = if let Some(p) = wav_path {
        Some(rename_file_if_needed(p, &format!("{}.wav", base_name))?)
    } else { None };

    let new_stems = if let Some(p) = stems_path {
        let ext = p.extension().unwrap_or_default().to_string_lossy();
        if p.is_dir() {
            // rename folder
            let parent = p.parent().unwrap_or(Path::new(""));
            let new_p = parent.join(format!("{}_stems", base_name));
            if new_p != p { rename_folder_windows(p, &new_p)?; }
            Some(new_p)
        } else {
            Some(rename_file_if_needed(p, &format!("{}_stems.{}", base_name, ext))?)
        }
    } else { None };

    let new_flp = if let Some(p) = flp_path {
        let ext = p.extension().unwrap_or_default().to_string_lossy();
        Some(rename_file_if_needed(p, &format!("{}.{}", base_name, ext))?)
    } else { None };

    // Rename folder last
    let parent = folder_path.parent().ok_or("No parent dir")?;
    let new_folder = parent.join(clean_name);
    let new_folder = if new_folder != folder_path {
        rename_folder_windows(folder_path, &new_folder)?;
        new_folder
    } else { folder_path.to_path_buf() };

    let nf = new_folder.clone();
    let rb = |p: PathBuf| nf.join(p.file_name().unwrap_or_default());
    Ok((
        new_folder,
        new_mp3.map(rb),
        new_wav.map(|p| nf.join(p.file_name().unwrap_or_default())),
        new_stems.map(|p| nf.join(p.file_name().unwrap_or_default())),
        new_flp.map(|p| nf.join(p.file_name().unwrap_or_default())),
    ))
}

// ─────────────────────────────────────────────────────────────
//  Folder scanner
// ─────────────────────────────────────────────────────────────

struct FolderFiles {
    mp3s: Vec<PathBuf>,
    wavs: Vec<PathBuf>,
    stems: Vec<PathBuf>,  // may be dirs or .zip
    flps: Vec<PathBuf>,
    alss: Vec<PathBuf>,
    others: Vec<PathBuf>, // mp3/wav not matching folder name
}

fn scan_folder_structured(folder: &Path) -> FolderFiles {
    let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
    let clean_folder = clean_name_from_filename(&folder_name).to_lowercase();

    let mut all_mp3s = vec![];
    let mut all_wavs = vec![];
    let mut stems = vec![];
    let mut flps = vec![];
    let mut alss = vec![];
    let mut mp3s = vec![];
    let mut wavs = vec![];
    let mut others = vec![];

    if let Ok(rd) = folder.read_dir() {
        for e in rd.flatten() {
            let Ok(file_type) = e.file_type() else { continue; };
            if file_type.is_symlink() { continue; }
            let Ok(meta) = e.metadata() else { continue; };
            let p = e.path();

            // Stems folder detection (directory named with "stem")
            if meta.is_dir() {
                if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                    if name.to_lowercase().contains("stem") {
                        stems.push(p);
                        continue;
                    }
                }
                continue;
            }
            if !meta.is_file() { continue; }

            // Use extension detection instead of raw filename suffix to be more robust
            let ext = p.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()).unwrap_or_default();

            match ext.as_str() {
                "mp3" => all_mp3s.push(p),
                "wav" => all_wavs.push(p),
                "zip" => {
                    if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                        let n = name.to_lowercase();
                        if n.contains("stem") { stems.push(p); }
                        else { flps.push(p); } // non-stems ZIP == project archive candidate
                    }
                }
                "flp" => flps.push(p),
                "als" => alss.push(p),
                _ => {}
            }
        }
    }

    let mut exact_mp3s = vec![];
    let mut exact_wavs = vec![];
    for p in &all_mp3s {
        let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
        if clean_name_from_filename(&stem).to_lowercase() == clean_folder {
            exact_mp3s.push(p.clone());
        }
    }
    for p in &all_wavs {
        let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
        if clean_name_from_filename(&stem).to_lowercase() == clean_folder {
            exact_wavs.push(p.clone());
        }
    }

    if !exact_mp3s.is_empty() || !exact_wavs.is_empty() {
        mp3s = exact_mp3s;
        wavs = exact_wavs;

        for p in &all_mp3s {
            if !mp3s.contains(p) {
                others.push(p.clone());
            }
        }
        for p in &all_wavs {
            if !wavs.contains(p) {
                others.push(p.clone());
            }
        }
    } else {
        let total_audio = all_mp3s.len() + all_wavs.len();
        if total_audio <= 1 {
            mp3s = all_mp3s;
            wavs = all_wavs;
        } else {
            // Ambiguous folder: keep all candidates so UI can ask user to resolve.
            mp3s = all_mp3s;
            wavs = all_wavs;
        }
    }

    mp3s.sort(); wavs.sort(); stems.sort(); flps.sort(); alss.sort(); others.sort();
    FolderFiles { mp3s, wavs, stems, flps, alss, others }
}

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            e == "mp3" || e == "wav"
        })
        .unwrap_or(false)
}

fn find_samples_folder(folder: &Path) -> Option<PathBuf> {
    if !folder.is_dir() { return None; }
    WalkDir::new(folder).min_depth(1).into_iter().filter_map(Result::ok).find_map(|entry| {
        if !entry.file_type().is_dir() { return None; }
        let name = entry.file_name().to_string_lossy().trim().to_ascii_lowercase();
        let normalized = name.replace(['-', '_'], " ");
        let is_samples = matches!(normalized.as_str(),
            "sample" | "samples" | "audio sample" | "audio samples" |
            "project sample" | "project samples" | "used sample" | "used samples"
        ) || normalized.starts_with("samples ") || normalized.ends_with(" samples");
        if is_samples { Some(entry.path().to_path_buf()) } else { None }
    })
}

fn has_samples_folder(folder: &Path) -> bool { find_samples_folder(folder).is_some() }

fn is_auxiliary_dir_name(name: &str) -> bool {
    let n = name.to_lowercase();
    let aux = [
        "samples", "sample", "stems", "stem", "backup", "backups", "audio", "audio files",
        "recorded", "recording", "recordings", "rendered", "render", "renders", "processed",
        "imported", "waveforms", "recopiladas", "presets", "sliced audio", "freeze", "consolidated",
    ];
    aux.contains(&n.as_str())
}

fn is_structured_beat_folder(folder: &Path) -> bool {
    let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
    let clean_folder = clean_name_from_filename(&folder_name).to_lowercase();

    if let Ok(rd) = folder.read_dir() {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() || !is_audio_file(&p) {
                continue;
            }
            let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
            if clean_name_from_filename(&stem).to_lowercase() == clean_folder {
                return true;
            }
        }
    }
    false
}

#[derive(Clone)]
struct LooseImportCandidate {
    source_anchor: PathBuf,
    clean_name: String,
    bpm: String,
    key: String,
    tags: Vec<String>,
    rating: u8,
    image_base64: Option<String>,
    mp3: Option<PathBuf>,
    wav: Option<PathBuf>,
}

fn build_loose_candidate_from_audio(audio_path: &Path) -> Result<LooseImportCandidate, String> {
    if !audio_path.exists() || !audio_path.is_file() || !is_audio_file(audio_path) {
        return Err(format!("Invalid audio file: {}", audio_path.to_string_lossy()));
    }

    let stem = audio_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let clean_name = clean_name_from_filename(&stem);
    if clean_name.trim().is_empty() {
        return Err("Could not infer beat name from file".to_string());
    }

    // A standalone file is ONE slot. Never scan its parent folder for a
    // same-name MP3/WAV or any project assets. Extra slots are added later by
    // dropping them directly onto the existing beat.
    let ext = audio_path.extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mp3 = if ext == "mp3" { Some(audio_path.to_path_buf()) } else { None };
    let wav = if ext == "wav" { Some(audio_path.to_path_buf()) } else { None };
    let (bpm, key, tags, rating, image_base64) = read_id3(audio_path);

    Ok(LooseImportCandidate {
        source_anchor: audio_path.to_path_buf(),
        clean_name,
        bpm,
        key,
        tags,
        rating,
        image_base64,
        mp3,
        wav,
    })
}

fn build_preview_beat_from_loose(c: &LooseImportCandidate) -> BeatMeta {
    let (color, color2) = gradient_for(&c.clean_name);
    let anchor = c.source_anchor.to_string_lossy().to_string();
    let id = make_id(&c.clean_name, &anchor);

    let mp3_path = c.mp3.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let wav_path = c.wav.as_ref().map(|p| p.to_string_lossy().to_string());
    let playback_path = wav_path.clone().unwrap_or_else(|| mp3_path.clone());

    BeatMeta {
        id,
        name: c.clean_name.clone(),
        folder_path: anchor,
        mp3_path,
        wav_path: wav_path.clone(),
        playback_path,
        bpm: c.bpm.clone(),
        key: c.key.clone(),
        needs_resolution: false,
        tags: c.tags.clone(),
        rating: c.rating,
        image_base64: c.image_base64.clone(),
        has_wav: wav_path.is_some(),
        has_stems: false,
        has_samples: false,
        samples_path: None,
        has_flp: false,
        has_als: false,
        stems_path: None,
        flp_path: None,
        als_path: None,
        other_files: vec![],
        color,
        color2,
        has_loop: false,
        loop_path: None,
        cloud_status: None,
        telegram_file_id: None,
        telegram_message_id: None,
        offline_available: false,
    }
}

fn materialize_loose_candidate(c: &LooseImportCandidate, _library_root: &Path) -> Result<PathBuf, String> {
    let source = c.mp3.as_ref().or(c.wav.as_ref())
        .ok_or_else(|| "No audio source found.".to_string())?;
    Ok(source.parent().unwrap_or_else(|| Path::new(".")).to_path_buf())
}

fn discover_import_sources_recursive(folder: &Path, out: &mut Vec<PathBuf>) {
    if !folder.is_dir() {
        return;
    }

    if is_structured_beat_folder(folder) {
        out.push(folder.to_path_buf());
        return;
    }

    let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
    let skip_loose_here = is_auxiliary_dir_name(&folder_name);

    let mut grouped_audio: std::collections::HashMap<String, Vec<PathBuf>> = std::collections::HashMap::new();
    let mut subdirs: Vec<PathBuf> = vec![];

    if let Ok(rd) = folder.read_dir() {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                let n = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                if !is_auxiliary_dir_name(&n) {
                    subdirs.push(p);
                }
                continue;
            }
            if !skip_loose_here && p.is_file() && is_audio_file(&p) {
                let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
                let clean = clean_name_from_filename(&stem);
                grouped_audio.entry(clean).or_default().push(p);
            }
        }
    }

    let mut keys: Vec<String> = grouped_audio.keys().cloned().collect();
    keys.sort();
    for key in keys {
        if let Some(files) = grouped_audio.get_mut(&key) {
            files.sort();
            let anchor = files.first().cloned();
            if let Some(a) = anchor {
                out.push(a);
            }
        }
    }

    subdirs.sort();
    for sub in subdirs {
        discover_import_sources_recursive(&sub, out);
    }
}

fn discover_import_sources(base: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![];
    discover_import_sources_recursive(base, &mut out);
    out.sort();
    out.dedup();
    out
}

fn paths_to_strings(paths: &[PathBuf]) -> Vec<String> {
    paths.iter().map(|p| p.to_string_lossy().to_string()).collect()
}

fn unique_folder_path(base: &Path, folder_name: &str) -> PathBuf {
    let candidate = base.join(folder_name);
    if !candidate.exists() {
        return candidate;
    }
    for i in 2..=10_000 {
        let next = base.join(format!("{} ({})", folder_name, i));
        if !next.exists() {
            return next;
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    base.join(format!("{} ({})", folder_name, stamp))
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("Create dir failed: {}", e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Read dir failed: {}", e))? {
        let entry = entry.map_err(|e| format!("Read dir entry failed: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| format!("Read file type failed: {}", e))?;
        if ft.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else if ft.is_file() {
            std::fs::copy(&src_path, &dest_path).map_err(|e| format!("Copy failed: {}", e))?;
        }
    }
    Ok(())
}

fn ensure_folder_in_library(src_folder: &Path, _library_root: &Path) -> Result<PathBuf, String> {
    Ok(src_folder.to_path_buf())
}

// ─────────────────────────────────────────────────────────────
//  Build BeatMeta from disk
// ─────────────────────────────────────────────────────────────

fn build_beat_from_parts(
    id: String, folder: &Path, mp3: Option<&Path>, wav: Option<&Path>,
    stems: Option<&Path>, flp: Option<&Path>, als: Option<&Path>,
    others: &[PathBuf], color: String, color2: String,
    needs_resolution: bool,
) -> BeatMeta {
    // Name from folder (clean)
    let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
    let name = clean_name_from_filename(&folder_name);

    // Read metadata — prefer MP3 tags, fallback to WAV, fallback to filename
    let (mut bpm, mut key, tags, rating, image_base64) = if let Some(p) = mp3.or(wav) {
        read_id3(p)
    } else {
        let (b, k) = parse_bpm_key_from_filename(&folder_name);
        (b.unwrap_or_default(), k.unwrap_or_default(), vec![], 0, None)
    };

    // Detect conflicts between filename and tags or malformed duplicate brackets.
    // If both filename and tags provide BPM/key but differ, mark as needing resolution.
    let mut extra_conflict = false;
    let (fname_bpm_opt, fname_key_opt) = parse_bpm_key_from_filename(&folder_name);
    if let Some(fb) = fname_bpm_opt {
        if !bpm.is_empty() && bpm != fb { extra_conflict = true; }
        // if tag missing prefer filename bpm
        if bpm.is_empty() { bpm = fb; }
    }
    if let Some(fk) = fname_key_opt {
        let fk_n = normalize_key(&fk);
        if !key.is_empty() && key != fk_n { extra_conflict = true; }
        if key.is_empty() { key = fk_n; }
    }

    if has_multiple_bpm_key_brackets(&folder_name) { extra_conflict = true; }

    let playback_path = wav.map(|p| p.to_string_lossy().to_string())
        .or_else(|| mp3.map(|p| p.to_string_lossy().to_string()))
        .unwrap_or_default();

    // Only report others that exist on disk AND are not the main mp3/wav
    let main_paths: std::collections::HashSet<PathBuf> = [mp3, wav]
        .iter().filter_map(|p| *p).map(|p| p.to_path_buf()).collect();
    let others: Vec<PathBuf> = others.iter()
        .filter(|p| p.exists() && !main_paths.contains(p.as_path()))
        .cloned()
        .collect();

    // Same-folder loop detection: an audio file among "others" whose name matches
    // the beat's core name plus a loop word (e.g. "Beat Loop.wav") is the loop, not
    // a stray "other" file.
    let (beat_core, _) = crate::matcher::normalize_core_name(&name);
    let mut loop_path: Option<PathBuf> = None;
    let mut others_final: Vec<PathBuf> = Vec::new();
    for p in others {
        if loop_path.is_none() && is_audio_file(&p) {
            let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let (core, role) = crate::matcher::normalize_core_name(&stem);
            if role == Some(crate::matcher::FileRole::Loop) && core == beat_core {
                loop_path = Some(p);
                continue;
            }
        }
        others_final.push(p);
    }

    BeatMeta {
        id, name,
        folder_path: folder.to_string_lossy().to_string(),
        mp3_path: mp3.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        wav_path: wav.map(|p| p.to_string_lossy().to_string()),
        playback_path,
        bpm, key, tags, rating, image_base64,
        has_wav: wav.is_some(),
        has_stems: stems.is_some(),
        has_samples: has_samples_folder(folder),
        samples_path: find_samples_folder(folder).map(|p| p.to_string_lossy().to_string()),
        has_flp: flp.is_some(),
        has_als: als.is_some(),
        needs_resolution: needs_resolution || extra_conflict,
        stems_path: stems.map(|p| p.to_string_lossy().to_string()),
        flp_path: flp.map(|p| p.to_string_lossy().to_string()),
        als_path: als.map(|p| p.to_string_lossy().to_string()),
        other_files: paths_to_strings(&others_final),
        color, color2,
        has_loop: loop_path.is_some(),
        loop_path: loop_path.map(|p| p.to_string_lossy().to_string()),
        cloud_status: None,
        telegram_file_id: None,
        telegram_message_id: None,
        offline_available: false,
    }
}

fn build_from_disk(db: DbBeat) -> Option<BeatMeta> {
    let folder = PathBuf::from(&db.folder_path);

    // Cloud-only beats intentionally survive without a local folder/file.
    if !folder.exists() {
        let mut cached = db_meta(&db)?;
        if !is_cloud_backed(&cached) { return None; }
        cached.cloud_status = Some("CLOUD_ONLY".to_string());
        return Some(cached);
    }

    // load_library calls sync first, so a matching signature means the cached
    // BeatMeta is current and we can return it without another disk scan.
    if let Some(signature) = db.folder_signature.as_deref() {
        if let Some(cached) = db_cached_meta(&db, signature) {
            return Some(cached);
        }
    }

    let previous_cloud = db_meta(&db);
    let mp3 = PathBuf::from(&db.mp3_path);
    let files = scan_folder_structured(&folder);

    if files.mp3s.is_empty() && files.wavs.is_empty() {
        let mut cached = previous_cloud?;
        if !is_cloud_backed(&cached) { return None; }
        cached.cloud_status = Some("CLOUD_ONLY".to_string());
        return Some(cached);
    }

    // Find main mp3/wav — prefer the one matching the stored path
    let mp3_opt = if mp3.exists() { Some(mp3.clone()) }
        else { files.mp3s.first().cloned() };
    let wav_opt = files.wavs.first().cloned();

    let mut beat = build_beat_from_parts(
        db.id, &folder,
        mp3_opt.as_deref(), wav_opt.as_deref(),
        files.stems.first().map(|p| p.as_path()),
        files.flps.first().map(|p| p.as_path()),
        files.alss.first().map(|p| p.as_path()),
        &files.others,
        db.color, db.color2,
        files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1,
    );

    if let Some(previous) = previous_cloud {
        if previous.telegram_file_id.is_some() {
            beat.cloud_status = Some("SYNCED".to_string());
            beat.telegram_file_id = previous.telegram_file_id;
            beat.telegram_message_id = previous.telegram_message_id;
        }
    }
    Some(beat)
}

// ─────────────────────────────────────────────────────────────
//  Windows rename
// ─────────────────────────────────────────────────────────────

fn rename_folder_windows(old: &Path, new: &Path) -> Result<(), String> {
    if old == new { return Ok(()); }
    if std::fs::rename(old, new).is_ok() { return Ok(()); }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let old_w: Vec<u16> = old.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let new_w: Vec<u16> = new.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        if unsafe { MoveFileExW(old_w.as_ptr(), new_w.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0 { return Ok(()); }
        let new_name = new.file_name().unwrap_or_default().to_string_lossy();
        let script = format!(
            "Rename-Item -LiteralPath '{}' -NewName '{}' -ErrorAction Stop",
            old.to_string_lossy().replace('\'', "''"),
            new_name.replace('\'', "''"),
        );
        let ok = background_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status().map(|s| s.success()).unwrap_or(false);
        if ok { return Ok(()); }
    }
    Err("No se pudo renombrar la carpeta.".to_string())
}

// ─────────────────────────────────────────────────────────────
//  Commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn load_library(state: tauri::State<DbState>, settings: tauri::State<SettingsState>) -> Result<Vec<BeatMeta>, String> {
    let user_id = settings.settings.lock().map_err(|e| e.to_string())?
        .beatgaler_user_id.clone().unwrap_or_default();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let rows = db_load_all(&conn).map_err(|e| e.to_string())?;
    let mut beats = Vec::new();
    for row in rows {
        let Some(mut meta) = db_meta(&row) else { continue; };
        if !is_cloud_backed(&meta) { continue; }
        meta.cloud_status = Some("CLOUD_ONLY".to_string());
        meta.offline_available = if user_id.trim().is_empty() {
            false
        } else {
            // "Available offline" is a locked local package, not cache. A cloud
            // restore/reconnect must not silently delete it because metadata rows
            // are momentarily incomplete or because the remote beat was updated.
            offline_record_available(&conn, &user_id, &meta.id)?.is_some()
        };
        beats.push(meta);
    }
    drop(conn);
    Ok(beats)
}

#[tauri::command]
pub fn scan_beat_folder(
    folder_path: String,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<FolderScanResult, String> {
    let folder = PathBuf::from(&folder_path);
    if !folder.exists() { return Err(format!("Not found: {}", folder_path)); }

    let files = scan_folder_structured(&folder);
    if files.mp3s.is_empty() && files.wavs.is_empty() {
        return Err("No MP3 or WAV found in this folder".to_string());
    }

    let has_conflict = files.mp3s.len() > 1 || files.wavs.len() > 1
        || files.stems.len() > 1 || files.flps.len() > 1;

    if has_conflict {
        return Ok(FolderScanResult {
            needs_resolution: true,
            mp3_files: paths_to_strings(&files.mp3s),
            wav_files: paths_to_strings(&files.wavs),
            stems_files: paths_to_strings(&files.stems),
            flp_files: paths_to_strings(&files.flps),
            beat: None,
        });
    }

    let imported_folder = ensure_folder_in_library(&folder, &settings.beats_dir())?;
	normalize_folder_artwork(&imported_folder);	
    let imported_files = scan_folder_structured(&imported_folder);

    let folder_name = imported_folder.file_name().unwrap_or_default().to_string_lossy().to_string();
    let name = clean_name_from_filename(&folder_name);
    let (color, color2) = gradient_for(&name);
    let imported_folder_str = imported_folder.to_string_lossy().to_string();
    let id = make_id(&name, &imported_folder_str);

    let beat = build_beat_from_parts(
        id, &imported_folder,
        imported_files.mp3s.first().map(|p| p.as_path()),
        imported_files.wavs.first().map(|p| p.as_path()),
        imported_files.stems.first().map(|p| p.as_path()),
        imported_files.flps.first().map(|p| p.as_path()),
        imported_files.alss.first().map(|p| p.as_path()),
        &imported_files.others, color, color2,
        (imported_files.mp3s.len() > 1 || imported_files.wavs.len() > 1 || imported_files.stems.len() > 1 || imported_files.flps.len() > 1),
    );

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;

    Ok(FolderScanResult { needs_resolution: false, mp3_files: vec![], wav_files: vec![], stems_files: vec![], flp_files: vec![], beat: Some(beat) })
}

#[tauri::command]
pub fn resolve_beat_files(
    payload: ResolveFilesPayload,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<BeatMeta, String> {
    let source_folder = PathBuf::from(&payload.folder_path);
    let folder = ensure_folder_in_library(&source_folder, &settings.beats_dir())?;
	normalize_folder_artwork(&folder);
    let mp3 = if payload.mp3_path.is_empty() {
        None
    } else {
        PathBuf::from(&payload.mp3_path)
            .file_name()
            .map(|n| folder.join(n))
    };
    let wav = payload.wav_path.as_ref().and_then(|p| PathBuf::from(p).file_name().map(|n| folder.join(n)));
    let stems = payload.stems_path.as_ref().and_then(|p| PathBuf::from(p).file_name().map(|n| folder.join(n)));
    let flp = payload.flp_path.as_ref().and_then(|p| PathBuf::from(p).file_name().map(|n| folder.join(n)));

    let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
    let name = clean_name_from_filename(&folder_name);
    let (color, color2) = gradient_for(&name);
    let folder_str = folder.to_string_lossy().to_string();
    let id = make_id(&name, &folder_str);

    // scan for others/als
    let files = scan_folder_structured(&folder);

    let beat = build_beat_from_parts(
        id, &folder,
        mp3.as_deref(), wav.as_deref(),
        stems.as_deref(), flp.as_deref(),
        files.alss.first().map(|p| p.as_path()),
        &files.others, color, color2,
        (files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1),
    );
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;
    Ok(beat)
}

#[tauri::command]
pub fn scan_beats_folder(
    folder_path: String,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<Vec<BeatMeta>, String> {
    let base = PathBuf::from(&folder_path);
    if !base.exists() { return Err(format!("Not found: {}", folder_path)); }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut beats = Vec::new();

    for source in discover_import_sources(&base) {
        if source.is_dir() {
            let imported_folder = ensure_folder_in_library(&source, &settings.beats_dir())?;
			normalize_folder_artwork(&imported_folder);
            let files = scan_folder_structured(&imported_folder);
            if files.mp3s.is_empty() && files.wavs.is_empty() { continue; }

            let folder_name = imported_folder.file_name().unwrap_or_default().to_string_lossy().to_string();
            let name = clean_name_from_filename(&folder_name);
            let (color, color2) = gradient_for(&name);
            let folder_str = imported_folder.to_string_lossy().to_string();
            let id = make_id(&name, &folder_str);

            let beat = build_beat_from_parts(
                id, &imported_folder,
                files.mp3s.first().map(|p| p.as_path()),
                files.wavs.first().map(|p| p.as_path()),
                files.stems.first().map(|p| p.as_path()),
                files.flps.first().map(|p| p.as_path()),
                files.alss.first().map(|p| p.as_path()),
                &files.others, color, color2,
                (files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1),
            );
            db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;
            beats.push(beat);
            continue;
        }

        if source.is_file() && is_audio_file(&source) {
            let candidate = build_loose_candidate_from_audio(&source)?;
            let imported_folder = materialize_loose_candidate(&candidate, &settings.beats_dir())?;
			normalize_folder_artwork(&imported_folder);
            let files = scan_folder_structured(&imported_folder);

            let folder_name = imported_folder.file_name().unwrap_or_default().to_string_lossy().to_string();
            let name = clean_name_from_filename(&folder_name);
            let (color, color2) = gradient_for(&name);
            let folder_str = imported_folder.to_string_lossy().to_string();
            let id = make_id(&name, &folder_str);

            let beat = build_beat_from_parts(
                id, &imported_folder,
                files.mp3s.first().map(|p| p.as_path()),
                files.wavs.first().map(|p| p.as_path()),
                files.stems.first().map(|p| p.as_path()),
                files.flps.first().map(|p| p.as_path()),
                files.alss.first().map(|p| p.as_path()),
                &files.others, color, color2,
                (files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1),
            );
            db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;
            beats.push(beat);
        }
    }

    beats.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(beats)
}

/// Preview all beat subfolders WITHOUT copying to vault or saving to DB.
/// Used by the import modal to let the user choose which beats to bring in.
#[tauri::command]
pub fn preview_beats_folder(folder_path: String) -> Result<Vec<BeatMeta>, String> {
    let base = PathBuf::from(&folder_path);
    if !base.exists() { return Err(format!("Not found: {}", folder_path)); }
    let mut beats = Vec::new();

    for source in discover_import_sources(&base) {
        if source.is_dir() {
            let files = scan_folder_structured(&source);
            if files.mp3s.is_empty() && files.wavs.is_empty() { continue; }

            let folder_name = source.file_name().unwrap_or_default().to_string_lossy().to_string();
            let name = clean_name_from_filename(&folder_name);
            let (color, color2) = gradient_for(&name);
            let folder_str = source.to_string_lossy().to_string();
            let id = make_id(&name, &folder_str);

            let beat = build_beat_from_parts(
                id, &source,
                files.mp3s.first().map(|p| p.as_path()),
                files.wavs.first().map(|p| p.as_path()),
                files.stems.first().map(|p| p.as_path()),
                files.flps.first().map(|p| p.as_path()),
                files.alss.first().map(|p| p.as_path()),
                &files.others, color, color2,
                files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1,
            );
            beats.push(beat);
            continue;
        }

        if source.is_file() && is_audio_file(&source) {
            let candidate = build_loose_candidate_from_audio(&source)?;
            beats.push(build_preview_beat_from_loose(&candidate));
        }
    }
    beats.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(beats)
}

/// Copy selected beat folders into the vault and save them to DB.
/// Called only when the user clicks Import in the modal.
#[tauri::command]
pub fn import_selected_beats(
    folder_paths: Vec<String>,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<Vec<BeatMeta>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut beats = Vec::new();

    for folder_path in folder_paths {
        let source = PathBuf::from(&folder_path);
        if !source.exists() { continue; }

        // Standalone MP3/WAV import must stay standalone. Do not turn its
        // parent directory into the beat and do not discover sibling files.
        if source.is_file() && is_audio_file(&source) {
            let candidate = build_loose_candidate_from_audio(&source)?;
            let beat = build_preview_beat_from_loose(&candidate);
            db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;
            beats.push(beat);
            continue;
        }

        let imported_folder = if source.is_dir() {
            ensure_folder_in_library(&source, &settings.beats_dir())?
        } else {
            continue;
        };
		normalize_folder_artwork(&imported_folder);

        let files = scan_folder_structured(&imported_folder);
        if files.mp3s.is_empty() && files.wavs.is_empty() { continue; }

        let folder_name = imported_folder.file_name().unwrap_or_default().to_string_lossy().to_string();
        let name = clean_name_from_filename(&folder_name);
        let (color, color2) = gradient_for(&name);
        let folder_str = imported_folder.to_string_lossy().to_string();
        let id = make_id(&name, &folder_str);

        let beat = build_beat_from_parts(
            id, &imported_folder,
            files.mp3s.first().map(|p| p.as_path()),
            files.wavs.first().map(|p| p.as_path()),
            files.stems.first().map(|p| p.as_path()),
            files.flps.first().map(|p| p.as_path()),
            files.alss.first().map(|p| p.as_path()),
                &files.others, color, color2,
                (files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1),
        );
        db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;
        beats.push(beat);
    }
    Ok(beats)
}

#[tauri::command]
pub fn read_beat_meta(
    mp3_path: String,
    state: tauri::State<DbState>,
    _settings: tauri::State<SettingsState>,
) -> Result<BeatMeta, String> {
    let path = PathBuf::from(&mp3_path);
    if !path.exists() { return Err(format!("Not found: {}", mp3_path)); }

    // Read exactly the selected file. This command is also used by single-file
    // flows, so scanning the parent folder here would silently attach siblings.
    let candidate = build_loose_candidate_from_audio(&path)?;
    let beat = build_preview_beat_from_loose(&candidate);

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db_save(&conn, &beat).map_err(|e| e.to_string())?;
    Ok(beat)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioMetadataPreview {
    pub bpm: String,
    pub key: String,
    pub tags: Vec<String>,
    pub rating: u8,
    pub image_base64: Option<String>,
    pub has_metadata: bool,
}

/// Read metadata from a candidate replacement audio file WITHOUT importing,
/// copying, renaming, writing tags, touching SQLite, or uploading anything.
#[tauri::command]
pub fn inspect_audio_metadata(file_path: String) -> Result<AudioMetadataPreview, String> {
    let path = PathBuf::from(&file_path);
    let meta = std::fs::metadata(&path)
        .map_err(|e| format!("Could not inspect audio '{}': {}", path.display(), e))?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(format!("Selected audio is not a readable non-empty file: {}", path.display()));
    }
    let (bpm, key, tags, rating, image_base64) = read_id3(&path);
    let has_metadata = !bpm.trim().is_empty()
        || !key.trim().is_empty()
        || !tags.is_empty()
        || rating > 0
        || image_base64.as_ref().map(|v| !v.trim().is_empty()).unwrap_or(false);
    Ok(AudioMetadataPreview { bpm, key, tags, rating, image_base64, has_metadata })
}

/// Save metadata — writes to both MP3 and WAV, updates filenames if needed
#[tauri::command]
pub fn save_beat_meta(payload: SaveMetaPayload) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "new_mp3_path": payload.mp3_path,
        "new_wav_path": payload.wav_path,
    }))
}

/// Rename just the audio filenames to match new BPM/Key
fn update_audio_filenames(mp3: Option<&Path>, wav: Option<&Path>, bpm: &str, key: &str) -> Result<(String, Option<String>), String> {
    let new_mp3 = if let Some(p) = mp3 {
        let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let clean = clean_name_from_filename(&stem);
        let new_name = canonical_filename(&clean, bpm, key, "mp3");
        rename_file_if_needed(p, &new_name)?.to_string_lossy().to_string()
    } else { String::new() };

    let new_wav = if let Some(p) = wav {
        let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let clean = clean_name_from_filename(&stem);
        let new_name = canonical_filename(&clean, bpm, key, "wav");
        Some(rename_file_if_needed(p, &new_name)?.to_string_lossy().to_string())
    } else { None };

    Ok((new_mp3, new_wav))
}

/// Rename beat folder + all matched files
#[tauri::command]
pub fn rename_beat(payload: RenamePayload, _state: tauri::State<DbState>) -> Result<RenameResult, String> {
    Ok(RenameResult {
        new_folder_path: payload.folder_path,
        new_mp3_path: payload.mp3_path,
        new_wav_path: None,
        new_stems_path: None,
        new_flp_path: None,
    })
}

/// Add a file to a beat by copying it into the beat folder with the right name
#[tauri::command]
pub fn add_file_to_beat(payload: AddFilePayload) -> Result<String, String> {
    let src = PathBuf::from(&payload.file_path);
    if !src.exists() { return Err(format!("Source file not found: {}", payload.file_path)); }

    let folder = PathBuf::from(&payload.beat_folder);
    if !folder.exists() {
        std::fs::create_dir_all(&folder)
            .map_err(|e| format!("Could not create beat folder: {}", e))?;
    }

    // Samples are a folder, not a single file. Copy the whole selected folder
    // recursively into a canonical Samples directory inside the beat.
    if payload.file_role == "samples" {
        if !src.is_dir() { return Err("Samples selection must be a folder.".to_string()); }
        let dest = folder.join("Samples");
        if dest == src { return Ok(dest.to_string_lossy().to_string()); }
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(|e| format!("Could not replace Samples folder: {}", e))?;
        }
        copy_dir_recursive(&src, &dest)?;
        return Ok(dest.to_string_lossy().to_string());
    }

    let ext = src.extension().unwrap_or_default().to_string_lossy().to_lowercase();

    let dest_name = match payload.file_role.as_str() {
        "mp3" => canonical_filename(&payload.beat_name, &payload.bpm, &payload.key, "mp3"),
        "wav" => canonical_filename(&payload.beat_name, &payload.bpm, &payload.key, "wav"),
        "stems" => {
            let base = canonical_filename(&payload.beat_name, &payload.bpm, &payload.key, "");
            let base = base.trim_end_matches('.');
            format!("{}_stems.{}", base, ext)
        },
        "loop" => {
            let base = canonical_filename(&payload.beat_name, &payload.bpm, &payload.key, "");
            let base = base.trim_end_matches('.');
            format!("{}_loop.{}", base, ext)
        },
        "project" => {
            let base = canonical_filename(&payload.beat_name, &payload.bpm, &payload.key, "");
            let base = base.trim_end_matches('.');
            format!("{}_project.{}", base, ext)
        },
        "flp" => canonical_filename(&payload.beat_name, &payload.bpm, &payload.key, &ext),
        "als" => canonical_filename(&payload.beat_name, &payload.bpm, &payload.key, "als"),
        _ => src.file_name().unwrap_or_default().to_string_lossy().to_string(),
    };

    let dest = folder.join(&dest_name);
    if dest == src {
        return Ok(dest.to_string_lossy().to_string());
    }

    // If the source is already inside the beat folder, rename in-place instead of copying
    let src_parent = src.parent().unwrap_or(Path::new(""));
    if src_parent == folder.as_path() {
        std::fs::rename(&src, &dest)
            .map_err(|e| format!("Rename failed: {}", e))?;
    } else {
        std::fs::copy(&src, &dest).map_err(|e| format!("Copy failed: {}", e))?;
    }
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn reorder_beats(ordered_ids: Vec<String>, state: tauri::State<DbState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    for (i, id) in ordered_ids.iter().enumerate() {
        conn.execute("UPDATE beats SET sort_order=?1 WHERE id=?2", params![i as i64, id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_beat_from_library(
    id: String,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<(), String> {
    let (folder_path, mp3_path, beat_meta_json, is_cloud_backed) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        match conn.query_row(
            "SELECT folder_path, mp3_path, meta_json FROM beats WHERE id=?1",
            params![id.clone()],
            |row| {
                let folder_path: String = row.get(0)?;
                let mp3_path: String = row.get(1)?;
                let raw: Option<String> = row.get(2)?;
                let cloud = raw.as_deref()
                    .and_then(|value| serde_json::from_str::<BeatMeta>(value).ok())
                    .map(|meta| meta.telegram_file_id.as_deref().map(|v| !v.is_empty()).unwrap_or(false))
                    .unwrap_or(false);
                Ok((folder_path, mp3_path, raw, cloud))
            },
        ) {
            Ok(paths) => paths,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
    };

    // Cloud-only rows often use synthetic local paths such as `import-...`.
    // The human beat name already lives in meta_json, so Trash must prefer it
    // instead of deriving a label from folder_path/mp3_path.
    let metadata_display_name = beat_meta_json.as_deref()
        .and_then(|value| serde_json::from_str::<BeatMeta>(value).ok())
        .map(|meta| meta.name.trim().to_string())
        .filter(|name| !name.is_empty());

    let display_name = metadata_display_name.unwrap_or_else(|| {
        if !folder_path.trim().is_empty() {
            PathBuf::from(&folder_path).file_name()
                .map(|n| clean_name_from_filename(&n.to_string_lossy()))
                .unwrap_or_default()
        } else {
            PathBuf::from(&mp3_path).file_stem()
                .map(|n| clean_name_from_filename(&n.to_string_lossy()))
                .unwrap_or_default()
        }
    });

    let trash_dir = settings.data_dir.join(".trash");
    std::fs::create_dir_all(&trash_dir).ok();
    let mut trashed_path: Option<PathBuf> = None;

    if !is_cloud_backed && !folder_path.trim().is_empty() {
        let beat_folder = PathBuf::from(&folder_path);
        if beat_folder.exists() {
            let name = beat_folder.file_name().unwrap_or_default().to_string_lossy().to_string();
            let dest = unique_folder_path(&trash_dir, &format!("{}_{}", now_epoch(), name));
            if std::fs::rename(&beat_folder, &dest).is_err() {
                // Cross-device fallback: copy then remove the original.
                if copy_dir_recursive(&beat_folder, &dest).is_err() {
                    log_error(&settings.data_dir, &format!("Could not move beat '{}' to trash", id));
                    return Err("No se pudo mover el beat a la papelera.".to_string());
                }
                let _ = std::fs::remove_dir_all(&beat_folder);
            }
            trashed_path = Some(dest);
        }
    } else if !is_cloud_backed && !mp3_path.trim().is_empty() {
        let mp3 = PathBuf::from(&mp3_path);
        if mp3.exists() {
            let name = mp3.file_name().unwrap_or_default().to_string_lossy().to_string();
            let dest = trash_dir.join(format!("{}_{}", now_epoch(), name));
            if std::fs::rename(&mp3, &dest).is_err() {
                if std::fs::copy(&mp3, &dest).is_err() {
                    log_error(&settings.data_dir, &format!("Could not move beat '{}' to trash", id));
                    return Err("No se pudo mover el beat a la papelera.".to_string());
                }
                let _ = std::fs::remove_file(&mp3);
            }
            trashed_path = Some(dest);
            if let Some(parent) = PathBuf::from(&mp3_path).parent() {
                let beats_root = settings.beats_dir();
                if parent.starts_with(&beats_root) {
                    let _ = std::fs::remove_dir(parent);
                }
            }
        }
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let trash_id = random_urlsafe(10);

    if is_cloud_backed {
        conn.execute(
            "INSERT INTO trash
             (id, original_folder_path, trashed_path, beat_name, beat_meta_json, is_cloud, trashed_at)
             VALUES (?1, ?2, '', ?3, ?4, 1, strftime('%s','now'))",
            params![
                trash_id,
                folder_path,
                display_name,
                beat_meta_json.unwrap_or_default()
            ],
        ).map_err(|e| e.to_string())?;
    } else if let Some(dest) = &trashed_path {
        conn.execute(
            "INSERT INTO trash
             (id, original_folder_path, trashed_path, beat_name, beat_meta_json, is_cloud, trashed_at)
             VALUES (?1, ?2, ?3, ?4, NULL, 0, strftime('%s','now'))",
            params![trash_id, folder_path, dest.to_string_lossy().to_string(), display_name],
        ).map_err(|e| e.to_string())?;
    }

    conn.execute("DELETE FROM beats WHERE id=?1", params![id.clone()]).map_err(|e| e.to_string())?;
    if is_cloud_backed {
        log_info(&settings.data_dir, &format!("Cloud-backed beat '{}' removed from active library; Telegram files retained", id));
    } else {
        log_info(&settings.data_dir, &format!("Beat '{}' moved to trash", id));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrashItem {
    pub id: String,
    pub beat_name: String,
    pub trashed_at: i64,
    pub is_cloud: bool,
}

#[tauri::command]
pub fn list_trash(state: tauri::State<DbState>) -> Result<Vec<TrashItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, beat_name, trashed_at, is_cloud, beat_meta_json FROM trash ORDER BY trashed_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let stored_name: String = r.get(1)?;
        let is_cloud = r.get::<_, i64>(3)? != 0;
        let raw_meta: Option<String> = r.get(4)?;

        // Repair old Trash rows at read-time too. This makes already-broken
        // `import-...` labels display the real beat name without a migration.
        let metadata_name = if is_cloud {
            raw_meta.as_deref()
                .and_then(|value| serde_json::from_str::<BeatMeta>(value).ok())
                .map(|meta| meta.name.trim().to_string())
                .filter(|name| !name.is_empty())
        } else {
            None
        };

        Ok(TrashItem {
            id: r.get(0)?,
            beat_name: metadata_name.unwrap_or(stored_name),
            trashed_at: r.get(2)?,
            is_cloud,
        })
    }).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// Restores a trashed beat back into the active library.
/// Runs off the UI thread; cloud INDEX mutations are serialized below so users
/// can queue several restores quickly without freezing the Settings panel.
#[tauri::command(async)]
pub fn restore_beat_from_trash(
    trash_id: String,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<BeatMeta, String> {
    let (folder_path, trashed_path, beat_meta_json, is_cloud) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT original_folder_path, trashed_path, beat_meta_json, is_cloud
             FROM trash WHERE id=?1",
            params![trash_id.clone()],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)? != 0,
            )),
        ).map_err(|_| "Ese elemento ya no está en la papelera.".to_string())?
    };

    if is_cloud {
        let _restore_guard = TRASH_RESTORE_LOCK
            .lock()
            .map_err(|_| "Cloud Trash restore queue was interrupted.".to_string())?;

        let raw = beat_meta_json
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Cloud trash record is missing beat metadata.".to_string())?;
        let beat: BeatMeta = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid cloud trash metadata: {}", e))?;
        // Cloud is the source of truth. Restore there FIRST and as one direct
        // INDEX transaction. The old renderer path restored SQLite first and
        // published a second snapshot later, leaving a race window where
        // observers/uploads could see active+trash at the same time.
        let user_id = ensure_beatgaler_user_id(&settings)?;
        direct_restore_beat_from_trash(&user_id, &beat.id)
            .map_err(|e| format!("Could not restore beat from Galer Cloud Trash: {}", e))?;

        // Only mirror the already-committed Cloud state into SQLite afterwards.
        // If the app crashes here, the next authoritative reload repairs SQLite.
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM trash WHERE id=?1", params![trash_id])
            .map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "DELETE FROM offline_trash_intents WHERE user_id=?1 AND beat_id=?2",
            params![user_id, beat.id.clone()],
        );
        log_info(&settings.data_dir, &format!("Cloud beat restored atomically from trash: {}", beat.name));
        return Ok(beat);
    }

    let src = PathBuf::from(&trashed_path);
    if !src.exists() {
        return Err("Los archivos de este beat ya no existen en la papelera.".to_string());
    }

    let original_name = PathBuf::from(&folder_path)
        .file_name().map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Restored Beat".to_string());
    let dest = unique_folder_path(&settings.beats_dir(), &original_name);

    if src.is_dir() {
        copy_dir_recursive(&src, &dest)?;
        let _ = std::fs::remove_dir_all(&src);
    } else {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let fname = src.file_name().unwrap_or_default();
        std::fs::copy(&src, dest.join(fname)).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&src);
    }

    let files = scan_folder_structured(&dest);
    let folder_name = dest.file_name().unwrap_or_default().to_string_lossy().to_string();
    let name = clean_name_from_filename(&folder_name);
    let (color, color2) = gradient_for(&name);
    let id = make_id(&name, &dest.to_string_lossy());
    let beat = build_beat_from_parts(
        id, &dest,
        files.mp3s.first().map(|p| p.as_path()),
        files.wavs.first().map(|p| p.as_path()),
        files.stems.first().map(|p| p.as_path()),
        files.flps.first().map(|p| p.as_path()),
        files.alss.first().map(|p| p.as_path()),
        &files.others, color, color2, false,
    );

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM trash WHERE id=?1", params![trash_id]).map_err(|e| e.to_string())?;
    log_info(&settings.data_dir, &format!("Beat restored from trash: {}", beat.name));
    Ok(beat)
}

/// Deletes trash entries older than `max_age_days` permanently. Used both as
/// a manual command (Settings -> "Empty trash") and automatically on every
/// app startup (see lib.rs) with a 14-day default.
pub fn purge_old_trash_internal(conn: &Connection, data_dir: &Path, max_age_days: i64) -> usize {
    let cutoff = now_epoch().saturating_sub((max_age_days.max(0) as u64) * 86400) as i64;
    let mut stmt = match conn.prepare(
        "SELECT id, trashed_path, beat_meta_json, is_cloud
         FROM trash WHERE trashed_at <= ?1"
    ) {
        Ok(s) => s, Err(_) => return 0,
    };
    let rows: Vec<(String, String, Option<String>, bool)> = match stmt.query_map(
        params![cutoff],
        |r| Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get::<_, i64>(3)? != 0,
        ))
    ) {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => return 0,
    };
    drop(stmt);

    let mut purged = 0usize;
    let mut cloud_rows: Vec<(String, String)> = Vec::new(); // (trash_id, beat_id)

    // Local-only trash never needs the network, so purge it immediately.
    // Cloud trash is collected and deleted in ONE server request below.
    for (trash_id, path, beat_meta_json, is_cloud) in rows {
        if is_cloud {
            let Some(raw) = beat_meta_json.as_deref() else { continue; };
            let Ok(meta) = serde_json::from_str::<BeatMeta>(raw) else { continue; };
            cloud_rows.push((trash_id, meta.id));
            continue;
        }

        let p = PathBuf::from(&path);
        if p.exists() { remove_path_best_effort(&p); }
        if conn.execute("DELETE FROM trash WHERE id=?1", params![trash_id]).is_ok() {
            purged += 1;
        }
    }

    if !cloud_rows.is_empty() {
        let settings_snapshot = load_settings(data_dir);
        if let Some(user_id) = settings_snapshot.beatgaler_user_id.as_deref() {
            let beat_ids: Vec<String> = cloud_rows.iter().map(|(_, beat_id)| beat_id.clone()).collect();

            // Permanent delete is committed by the active Desktop transport bot.
            // replace_index pins the new single index first, then deletes media
            // no longer referenced by it. MASTER only cleans up empty Topics.
            match direct_permanently_delete_beats(user_id, &beat_ids) {
                Ok(_) => {
                    let batch_url = format!("{}/beats/delete-topics-batch", telegram_cloud_api_base());
                    let body = serde_json::json!({
                        "beatgalerUserId": user_id,
                        "beatIds": beat_ids,
                    });
                    let queued = match post_json_cloud_auth_timeout(&batch_url, &body, 30) {
                        Ok(_) => true,
                        Err(first_error) => {
                            log_warn(data_dir, &format!(
                                "Cloud Trash Topic cleanup enqueue failed once; retrying automatically: {}",
                                first_error
                            ));
                            std::thread::sleep(Duration::from_millis(300));
                            match post_json_cloud_auth_timeout(&batch_url, &body, 30) {
                                Ok(_) => true,
                                Err(second_error) => {
                                    log_warn(data_dir, &format!(
                                        "Cloud Trash index delete committed but Topic cleanup could not be queued; keeping local Trash rows for retry: {}",
                                        second_error
                                    ));
                                    false
                                }
                            }
                        }
                    };
                    if !queued { return purged; }
                    for (trash_id, beat_id) in cloud_rows {
                        let _ = conn.execute("DELETE FROM cloud_files WHERE beat_id=?1", params![beat_id.clone()]);
                        let _ = conn.execute("DELETE FROM cloud_projects WHERE beat_id=?1", params![beat_id.clone()]);
                        let _ = conn.execute("DELETE FROM cloud_metadata WHERE beat_id=?1", params![beat_id.clone()]);
                        if conn.execute("DELETE FROM trash WHERE id=?1", params![trash_id]).is_ok() {
                            purged += 1;
                        }
                    }
                }
                Err(error) => {
                    // Startup may run before the Direct lease exists. Keep every
                    // Cloud Trash row and retry once the app has a live session.
                    log_warn(data_dir, &format!(
                        "Skipped Cloud Trash auto-purge until Direct transport is ready: {}",
                        error
                    ));
                }
            }
        } else {
            log_warn(data_dir, "Skipped permanent Cloud trash delete because BeatGaler user id is unavailable");
        }
    }

    if purged > 0 {
        log_info(data_dir, &format!(
            "Purged {} trash item(s) older than {} days; Cloud Topics were batch-deleted before local rows",
            purged, max_age_days
        ));
    }
    purged
}

fn purge_trash_now_blocking(state: &DbState, settings: &SettingsState) -> Result<usize, String> {
    // Manual Empty Trash must not hold the SQLite mutex while waiting on the
    // Cloud Server/Telegram. Snapshot the work first, release the DB, perform
    // the network commit, then briefly lock again to remove accepted rows.
    let rows: Vec<(String, String, Option<String>, bool)> = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, trashed_path, beat_meta_json, is_cloud FROM trash"
        ).map_err(|e| e.to_string())?;
        let iter = stmt.query_map([], |r| Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get::<_, i64>(3)? != 0,
        ))).map_err(|e| e.to_string())?;
        iter.filter_map(|row| row.ok()).collect()
    };

    let mut purged = 0usize;
    let mut cloud_rows: Vec<(String, String)> = Vec::new();

    // Local-only items are cheap and can be finished immediately.
    for (trash_id, path, beat_meta_json, is_cloud) in rows {
        if is_cloud {
            let Some(raw) = beat_meta_json.as_deref() else { continue; };
            let Ok(meta) = serde_json::from_str::<BeatMeta>(raw) else { continue; };
            cloud_rows.push((trash_id, meta.id));
            continue;
        }

        let p = PathBuf::from(&path);
        if p.exists() { remove_path_best_effort(&p); }
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        if conn.execute("DELETE FROM trash WHERE id=?1", params![trash_id]).is_ok() {
            purged += 1;
        }
    }

    if cloud_rows.is_empty() {
        return Ok(purged);
    }

    let settings_snapshot = load_settings(&settings.data_dir);
    let Some(user_id) = settings_snapshot.beatgaler_user_id.as_deref() else {
        log_warn(&settings.data_dir, "Skipped permanent Cloud trash delete because BeatGaler user id is unavailable");
        return Ok(purged);
    };

    let beat_ids: Vec<String> = cloud_rows.iter().map(|(_, beat_id)| beat_id.clone()).collect();

    // Commit the logical delete + media cleanup through the active Desktop
    // transport bot before asking MASTER to clean the now-empty Topics.
    direct_permanently_delete_beats(user_id, &beat_ids)?;

    let batch_url = format!("{}/beats/delete-topics-batch", telegram_cloud_api_base());
    let body = serde_json::json!({
        "beatgalerUserId": user_id,
        "beatIds": beat_ids,
    });
    let queue_topics = || -> Result<Value, String> {
        post_json_cloud_auth_timeout(&batch_url, &body, 30)
    };
    if let Err(first_error) = queue_topics() {
        log_warn(&settings.data_dir, &format!(
            "Empty Trash Topic cleanup enqueue failed once; retrying automatically: {}",
            first_error
        ));
        std::thread::sleep(Duration::from_millis(300));
        queue_topics().map_err(|second_error| format!(
            "The Galer Library index was updated, but BeatGaler could not queue storage cleanup. Retry Empty Trash. First error: {}. Retry error: {}",
            first_error, second_error
        ))?;
    }
    let accepted_ids: std::collections::HashSet<String> = cloud_rows
        .iter().map(|(_, beat_id)| beat_id.clone()).collect();

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    for (trash_id, beat_id) in cloud_rows {
        if !accepted_ids.contains(&beat_id) { continue; }
        let _ = conn.execute("DELETE FROM cloud_files WHERE beat_id=?1", params![beat_id.clone()]);
        let _ = conn.execute("DELETE FROM cloud_projects WHERE beat_id=?1", params![beat_id.clone()]);
        let _ = conn.execute("DELETE FROM cloud_metadata WHERE beat_id=?1", params![beat_id.clone()]);
        if conn.execute("DELETE FROM trash WHERE id=?1", params![trash_id]).is_ok() {
            purged += 1;
        }
    }

    log_info(&settings.data_dir, &format!(
        "Queued {} Cloud trash item(s) for permanent delete; Galer Storage cleanup continues in background",
        accepted_ids.len()
    ));
    Ok(purged)
}

#[tauri::command]
pub async fn purge_trash_now(app: tauri::AppHandle) -> Result<usize, String> {
    // IMPORTANT: curl/Telegram index commit is blocking I/O. Running the old
    // synchronous command on Tauri's command thread could make the whole app
    // feel frozen even though React had already hidden Trash. Keep the invoke
    // Promise pending for reconciliation, but move ALL blocking work off the UI
    // thread so the user can immediately navigate, play audio, or keep working.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DbState>();
        let settings = app.state::<SettingsState>();
        purge_trash_now_blocking(state.inner(), settings.inner())
    })
    .await
    .map_err(|error| format!("Empty Trash background task failed to join: {}", error))?
}

#[tauri::command]
pub fn purge_interrupted_upload_local(
    beat_id: String,
    staging_paths: Vec<String>,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<(), String> {
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM cloud_files WHERE beat_id=?1", params![beat_id.clone()]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM cloud_projects WHERE beat_id=?1", params![beat_id.clone()]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM cloud_metadata WHERE beat_id=?1", params![beat_id.clone()]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM beats WHERE id=?1", params![beat_id.clone()]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }

    // Staging is transaction-owned scratch space. Remove whole UUID sessions,
    // never arbitrary user paths.
    let staging_root = settings.data_dir.join("drop-staging");
    let mut sessions = std::collections::HashSet::<PathBuf>::new();
    for raw in staging_paths {
        let path = PathBuf::from(raw);
        if let Ok(relative) = path.strip_prefix(&staging_root) {
            if let Some(first) = relative.components().next() {
                sessions.insert(staging_root.join(first.as_os_str()));
            }
        }
    }
    for session in sessions {
        if session.starts_with(&staging_root) {
            let _ = std::fs::remove_dir_all(session);
        }
    }

    log_info(&settings.data_dir, &format!("Rolled back interrupted cloud upload: {}", beat_id));
    Ok(())
}

#[tauri::command]
pub fn path_is_directory(path: String) -> bool {
    Path::new(&path).is_dir()
}

fn supported_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        return Some("image/avif");
    }
    None
}

#[cfg(test)]
mod artwork_native_reader_tests {
    use super::supported_image_mime;

    #[test]
    fn recognizes_supported_artwork_by_bytes_not_extension() {
        assert_eq!(supported_image_mime(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]), Some("image/png"));
        assert_eq!(supported_image_mime(&[0xff, 0xd8, 0xff, 0x00]), Some("image/jpeg"));
        assert_eq!(supported_image_mime(b"GIF89a-rest"), Some("image/gif"));
        assert_eq!(supported_image_mime(b"RIFF0000WEBP"), Some("image/webp"));
        assert_eq!(supported_image_mime(b"BM-not-really-large"), Some("image/bmp"));
        assert_eq!(supported_image_mime(b"0000ftypavif"), Some("image/avif"));
        assert_eq!(supported_image_mime(b"not an image"), None);
    }
}

#[cfg(test)]
mod direct_warmup_tests {
    use super::is_direct_warmup_configuration_error;

    #[test]
    fn configuration_credentials_trigger_warmup_backoff() {
        assert!(is_direct_warmup_configuration_error(
            "Galer Cloud did not provide a required local data-plane credential."
        ));
        assert!(is_direct_warmup_configuration_error(
            "BeatGaler Cloud did not provide the Telegram application id required by the local data plane."
        ));
        assert!(!is_direct_warmup_configuration_error("curl SSL connection timeout"));
    }
}

/// Reads artwork through Rust instead of the WebView asset protocol. Native
/// file dialogs on macOS can return security-scoped paths whose asset URL has
/// no useful Content-Type (or is denied by WebKit); direct native I/O avoids
/// that platform-specific failure and gives us precise stage diagnostics.
#[tauri::command]
pub fn read_image_file_data_url(
    path: String,
    state: tauri::State<SettingsState>,
) -> Result<String, String> {
    const MAX_ARTWORK_BYTES: u64 = 64 * 1024 * 1024;
    let op = random_urlsafe(6);
    let started = Instant::now();
    let image_path = PathBuf::from(&path);
    let filename = image_path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("(unnamed image)")
        .replace(['\r', '\n'], " ");
    let extension = image_path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let begin = format!("ARTWORK_READ_BEGIN op={} file={} ext={}", op, filename, extension);
    eprintln!("[artwork] {}", begin);
    log_info(&state.data_dir, &begin);

    let metadata = std::fs::metadata(&image_path).map_err(|error| {
        let detail = format!("ARTWORK_READ_FAILED op={} stage=metadata error={}", op, error);
        eprintln!("[artwork] {}", detail);
        log_error(&state.data_dir, &detail);
        format!("Could not access the selected artwork file: {}", error)
    })?;
    if !metadata.is_file() {
        let detail = format!("ARTWORK_READ_FAILED op={} stage=validate reason=not-a-file", op);
        eprintln!("[artwork] {}", detail);
        log_error(&state.data_dir, &detail);
        return Err("Selected artwork is not a file.".to_string());
    }
    if metadata.len() == 0 || metadata.len() > MAX_ARTWORK_BYTES {
        let detail = format!("ARTWORK_READ_FAILED op={} stage=validate bytes={} reason=size", op, metadata.len());
        eprintln!("[artwork] {}", detail);
        log_error(&state.data_dir, &detail);
        return Err(format!("Artwork must be between 1 byte and {} MB.", MAX_ARTWORK_BYTES / 1024 / 1024));
    }

    let bytes = std::fs::read(&image_path).map_err(|error| {
        let detail = format!("ARTWORK_READ_FAILED op={} stage=read bytes={} error={}", op, metadata.len(), error);
        eprintln!("[artwork] {}", detail);
        log_error(&state.data_dir, &detail);
        format!("Could not read the selected artwork file: {}", error)
    })?;
    let mime = supported_image_mime(&bytes).ok_or_else(|| {
        let detail = format!("ARTWORK_READ_FAILED op={} stage=decode bytes={} reason=unsupported-signature", op, bytes.len());
        eprintln!("[artwork] {}", detail);
        log_error(&state.data_dir, &detail);
        "Artwork must be a valid PNG, JPEG, WebP, GIF, BMP, or AVIF image.".to_string()
    })?;
    let encoded = general_purpose::STANDARD.encode(&bytes);
    let done = format!(
        "ARTWORK_READ_OK op={} mime={} bytes={} encoded_bytes={} elapsed_ms={}",
        op,
        mime,
        bytes.len(),
        encoded.len(),
        started.elapsed().as_millis(),
    );
    eprintln!("[artwork] {}", done);
    log_info(&state.data_dir, &done);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    #[cfg(target_os = "windows")]
    {
        if p.is_file() {
            // /select highlights the file in its parent folder
            std::process::Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Launches a file (FLP, ALS, or anything else) with whatever app is
/// registered as its default handler on the OS — i.e. the same as
/// double-clicking it in Explorer/Finder. Used for the "Open project"
/// right-click action.
#[tauri::command]
pub fn open_project_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    #[cfg(target_os = "windows")]
    {
        // `cmd /C start "" "<path>"` is the standard way to trigger the
        // default file association from the command line on Windows.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Unsupported platform for opening files.".to_string())
}

fn make_id(name: &str, folder: &str) -> String {
    format!("{}_{}", name.replace(|c: char| !c.is_alphanumeric(), "_"), folder.len())
}

fn youtube_client_path(data_dir: &Path) -> PathBuf {
    data_dir.join("youtube_oauth_client.json")
}

fn youtube_tokens_path(data_dir: &Path) -> PathBuf {
    data_dir.join("youtube_tokens.json")
}

fn youtube_temp_dir(data_dir: &Path) -> Result<PathBuf, String> {
    let path = data_dir.join("youtube-temp");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn parse_oauth_client(raw_json: &str) -> Result<StoredOAuthClient, String> {
    let parsed: Value = serde_json::from_str(raw_json).map_err(|e| format!("Invalid OAuth JSON: {}", e))?;
    let (client_type, body) = if let Some(installed) = parsed.get("installed") {
        ("installed", installed)
    } else if let Some(web) = parsed.get("web") {
        ("web", web)
    } else {
        return Err("OAuth JSON must contain either an 'installed' or 'web' client block.".to_string());
    };

    let redirect_uris = body
        .get("redirect_uris")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
        .unwrap_or_default();

    Ok(StoredOAuthClient {
        client_type: client_type.to_string(),
        client_id: body.get("client_id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        client_secret: body.get("client_secret").and_then(|v| v.as_str()).map(|s| s.to_string()),
        auth_uri: body.get("auth_uri").and_then(|v| v.as_str()).unwrap_or("https://accounts.google.com/o/oauth2/v2/auth").to_string(),
        token_uri: body.get("token_uri").and_then(|v| v.as_str()).unwrap_or("https://oauth2.googleapis.com/token").to_string(),
        redirect_uris,
    })
}

fn bundled_google_client_secret() -> Option<String> {
    // Lightweight obfuscation only: keeps the OAuth secret out of plaintext source
    // and avoids a user file picker. A desktop binary cannot make a static client
    // secret truly confidential; PKCE remains the real OAuth protection.
    const KEY: &[u8] = &[113, 45, 164, 25, 195, 88, 143, 226, 51, 183, 76, 149, 6];
    const DATA: &[u8] = &[54, 98, 231, 74, 147, 0, 162, 142, 71, 238, 39, 225, 50, 72, 85, 147, 90, 181, 16, 226, 207, 75, 129, 6, 164, 80, 69, 93, 147, 78, 160, 104, 192, 136, 64];

    let decoded: Vec<u8> = DATA
        .iter()
        .enumerate()
        .map(|(i, byte)| byte ^ KEY[i % KEY.len()])
        .collect();

    String::from_utf8(decoded).ok().filter(|s| !s.trim().is_empty())
}

fn load_oauth_client(_data_dir: &Path) -> Result<StoredOAuthClient, String> {
    // Native/Desktop OAuth clients are public clients: a bundled client_secret
    // cannot be made confidential once distributed. PKCE is the actual protection.
    // The secret is therefore injected at build time (not stored in the repo).
    Ok(StoredOAuthClient {
        client_type: "installed".to_string(),
        client_id: "499243641799-f01nc2k19n34rj2cmtlb6a2n4h8o1fvv.apps.googleusercontent.com".to_string(),
        client_secret: bundled_google_client_secret(),
        auth_uri: "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
        token_uri: "https://oauth2.googleapis.com/token".to_string(),
        redirect_uris: vec!["http://127.0.0.1".to_string(), "http://localhost".to_string()],
    })
}

fn save_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn load_tokens(data_dir: &Path) -> Option<StoredYouTubeTokens> {
    std::fs::read_to_string(youtube_tokens_path(data_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}

fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn choose_redirect_uri(client: &StoredOAuthClient, port: u16) -> Result<String, String> {
    if client.client_type == "installed" {
        return Ok(format!("http://127.0.0.1:{}/oauth2callback", port));
    }

    client
        .redirect_uris
        .iter()
        .find(|uri| uri.starts_with("http://127.0.0.1") || uri.starts_with("http://localhost"))
        .cloned()
        .ok_or_else(|| "This OAuth client does not have an HTTP loopback redirect URI. Use a Desktop OAuth client or add one like http://127.0.0.1:8765/oauth2callback.".to_string())
}

fn launch_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Unsupported platform for browser launch.".to_string())
}

fn receive_oauth_code(redirect_uri: &str, expected_state: &str) -> Result<String, String> {
    let url = Url::parse(redirect_uri).map_err(|e| e.to_string())?;
    let host = url.host_str().unwrap_or("127.0.0.1");
    let port = url.port_or_known_default().ok_or("Redirect URI is missing a port.")?;
    let callback_path = url.path().to_string();
    let listener = TcpListener::bind((host, port)).map_err(|e| format!("Could not start OAuth callback listener: {}", e))?;
    listener.set_nonblocking(false).ok();

    let (mut stream, _) = listener.accept().map_err(|e| format!("OAuth callback failed: {}", e))?;
    let mut buffer = [0u8; 8192];
    let size = stream.read(&mut buffer).map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..size]);
    let first_line = request.lines().next().ok_or("Invalid OAuth callback request.")?;
    let mut parts = first_line.split_whitespace();
    let _method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or("/");
    let target_url = Url::parse(&format!("http://localhost{}", target)).map_err(|e| e.to_string())?;

    if target_url.path() != callback_path {
        let body = "<html><body><h2>Beat Galer</h2><p>Wrong callback path. You can close this window.</p></body></html>";
        let response = format!("HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
        let _ = stream.write_all(response.as_bytes());
        return Err("Received OAuth callback on an unexpected path.".to_string());
    }

    let query: std::collections::HashMap<String, String> = target_url.query_pairs().into_owned().collect();
    if let Some(error) = query.get("error") {
        let body = "<html><body><h2>Beat Galer</h2><p>Authorization was cancelled. You can close this window.</p></body></html>";
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
        let _ = stream.write_all(response.as_bytes());
        return Err(format!("Google returned an OAuth error: {}", error));
    }

    let state = query.get("state").cloned().unwrap_or_default();
    if state != expected_state {
        return Err("OAuth state mismatch. Please try connecting again.".to_string());
    }

    let code = query.get("code").cloned().ok_or("Google did not send an authorization code.")?;
    let body = "<html><body><h2>Beat Galer</h2><p>YouTube is connected. You can close this tab.</p></body></html>";
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(response.as_bytes());
    Ok(code)
}

fn run_curl(args: &[String]) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let curl_program = "/usr/bin/curl";
    #[cfg(target_os = "windows")]
    let curl_program = "curl.exe";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let curl_program = "curl";

    let mut command = Command::new(curl_program);
    command.args(args);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|e| format!("Failed to start curl at '{}': {}", curl_program, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "curl failed (program={}, exit={}): {}",
            curl_program,
            output.status.code().map(|v| v.to_string()).unwrap_or_else(|| "signal".to_string()),
            if detail.is_empty() { "no error text returned".to_string() } else { detail }
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn post_form_json(url: &str, form: &[(&str, String)]) -> Result<Value, String> {
    let mut args = vec![
        "-sS".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        url.to_string(),
    ];
    for (key, value) in form {
        args.push("--data-urlencode".to_string());
        args.push(format!("{}={}", key, value));
    }
    args.push("-w".to_string());
    args.push("\n__BEATGALER_HTTP_STATUS__:%{http_code}".to_string());

    let raw = run_curl(&args)?;
    let (body, status_text) = raw
        .rsplit_once("\n__BEATGALER_HTTP_STATUS__:")
        .ok_or_else(|| "Google token endpoint did not return an HTTP status.".to_string())?;
    let status = status_text.trim().parse::<u16>().unwrap_or(0);

    let parsed: Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid JSON from Google (HTTP {}): {}", status, e))?;

    if !(200..300).contains(&status) {
        let code = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("oauth_error");
        let description = parsed
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or("Google rejected the OAuth request.");
        return Err(format!("Google OAuth {}: {}", code, description));
    }

    Ok(parsed)
}

fn get_json(url: &str, bearer_token: &str) -> Result<Value, String> {
    let args = vec![
        "-sS".to_string(),
        "-f".to_string(),
        "-H".to_string(),
        format!("Authorization: Bearer {}", bearer_token),
        url.to_string(),
    ];
    let raw = run_curl(&args)?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid JSON from Google: {}", e))
}

fn post_json_with_headers(url: &str, bearer_token: &str, body: &str, extra_headers: &[String]) -> Result<(Vec<String>, String), String> {
    let mut args = vec![
        "-sS".to_string(),
        "-D".to_string(),
        "-".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        "-H".to_string(),
        format!("Authorization: Bearer {}", bearer_token),
        "-H".to_string(),
        "Content-Type: application/json; charset=UTF-8".to_string(),
    ];
    for header in extra_headers {
        args.push("-H".to_string());
        args.push(header.clone());
    }
    args.push("--data-binary".to_string());
    args.push(body.to_string());
    args.push(url.to_string());

    let raw = run_curl(&args)?;
    let normalized = raw.replace("\r\n", "\n");
    let (header_text, body_text) = normalized
        .rsplit_once("\n\n")
        .ok_or("Google did not return upload headers.".to_string())?;
    Ok((header_text.lines().map(|line| line.to_string()).collect(), body_text.to_string()))
}

fn put_binary_json(url: &str, bearer_token: &str, file_path: &Path) -> Result<Value, String> {
    let args = vec![
        "-sS".to_string(),
        "-f".to_string(),
        "-X".to_string(),
        "PUT".to_string(),
        "-H".to_string(),
        format!("Authorization: Bearer {}", bearer_token),
        "-H".to_string(),
        "Content-Type: video/mp4".to_string(),
        "--data-binary".to_string(),
        format!("@{}", file_path.to_string_lossy()),
        url.to_string(),
    ];
    let raw = run_curl(&args)?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid JSON from YouTube upload: {}", e))
}

/// Retries the final binary upload up to 3 times with exponential backoff
/// (2s, then 4s) before giving up — a dropped connection mid-upload
/// shouldn't throw away a render that already took minutes. Cancellation is
/// checked both before each attempt and while waiting out the backoff, so
/// hitting "cancel" still stops it immediately instead of waiting out a retry.
fn put_binary_with_retry(
    url: &str,
    bearer_token: &str,
    file_path: &Path,
    cancelled: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    data_dir: &Path,
) -> Result<Value, String> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("CANCELLED".to_string());
        }
        match put_binary_json(url, bearer_token, file_path) {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e.clone();
                log_warn(data_dir, &format!("YouTube upload attempt {}/{} failed: {}", attempt, MAX_ATTEMPTS, e));
                if attempt < MAX_ATTEMPTS {
                    let backoff = std::time::Duration::from_secs(2u64.pow(attempt)); // 2s, then 4s
                    let mut waited = std::time::Duration::from_secs(0);
                    while waited < backoff {
                        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                            return Err("CANCELLED".to_string());
                        }
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        waited += std::time::Duration::from_millis(200);
                    }
                }
            }
        }
    }
    Err(format!("Video upload failed after {} attempts: {}", MAX_ATTEMPTS, last_err))
}

fn exchange_code_for_tokens(client_cfg: &StoredOAuthClient, redirect_uri: &str, code: &str, code_verifier: &str) -> Result<StoredYouTubeTokens, String> {
    let mut form: Vec<(&str, String)> = vec![
        ("code", code.to_string()),
        ("client_id", client_cfg.client_id.clone()),
        ("redirect_uri", redirect_uri.to_string()),
        ("grant_type", "authorization_code".to_string()),
        ("code_verifier", code_verifier.to_string()),
    ];
    if let Some(secret) = &client_cfg.client_secret {
        if !secret.is_empty() {
            form.push(("client_secret", secret.clone()));
        }
    }
    let response = post_form_json(&client_cfg.token_uri, &form)
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    Ok(StoredYouTubeTokens {
        access_token: response.get("access_token").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        refresh_token: response.get("refresh_token").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        expires_at: now_epoch() + response.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600) - 60,
    })
}

fn refresh_access_token(client_cfg: &StoredOAuthClient, tokens: &StoredYouTubeTokens) -> Result<StoredYouTubeTokens, String> {
    let mut form: Vec<(&str, String)> = vec![
        ("client_id", client_cfg.client_id.clone()),
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", tokens.refresh_token.clone()),
    ];
    if let Some(secret) = &client_cfg.client_secret {
        if !secret.is_empty() {
            form.push(("client_secret", secret.clone()));
        }
    }
    let response = post_form_json(&client_cfg.token_uri, &form)
        .map_err(|e| format!("Token refresh failed: {}", e))?;

    Ok(StoredYouTubeTokens {
        access_token: response.get("access_token").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        refresh_token: if tokens.refresh_token.is_empty() {
            response.get("refresh_token").and_then(|v| v.as_str()).unwrap_or_default().to_string()
        } else {
            tokens.refresh_token.clone()
        },
        expires_at: now_epoch() + response.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600) - 60,
    })
}

fn valid_access_token(data_dir: &Path, client_cfg: &StoredOAuthClient) -> Result<StoredYouTubeTokens, String> {
    let tokens = load_tokens(data_dir).ok_or("YouTube is not connected yet.".to_string())?;
    if !tokens.access_token.is_empty() && tokens.expires_at > now_epoch() {
        return Ok(tokens);
    }
    let refreshed = refresh_access_token(client_cfg, &tokens)?;
    save_json_file(&youtube_tokens_path(data_dir), &refreshed)?;
    Ok(refreshed)
}

fn fetch_channel(access_token: &str) -> Result<YouTubeChannel, String> {
    let response = get_json("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", access_token)
        .map_err(|e| format!("Failed to fetch YouTube channel: {}", e))?;

    let item = response
        .get("items")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
        .ok_or("No YouTube channel was returned for this account.")?;

    Ok(YouTubeChannel {
        id: item.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        name: item.get("snippet").and_then(|s| s.get("title")).and_then(|v| v.as_str()).unwrap_or("Connected YouTube").to_string(),
        avatar_url: item
            .get("snippet")
            .and_then(|s| s.get("thumbnails"))
            .and_then(|t| t.get("default").or_else(|| t.get("medium")).or_else(|| t.get("high")))
            .and_then(|t| t.get("url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        connected: true,
    })
}

fn write_base64_image(data_dir: &Path, image_base64: &str) -> Result<PathBuf, String> {
    let temp_dir = youtube_temp_dir(data_dir)?;
    let encoded = image_base64.split(',').nth(1).unwrap_or(image_base64);
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Invalid embedded image data: {}", e))?;
    let path = temp_dir.join(format!("cover-{}.png", now_epoch()));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

fn render_upload_video(data_dir: &Path, payload: &YouTubeUploadPayload) -> Result<PathBuf, String> {
    let audio_path = PathBuf::from(&payload.audio_path);
    if !audio_path.exists() {
        return Err(format!("Audio file not found: {}", payload.audio_path));
    }

    let temp_dir = youtube_temp_dir(data_dir)?;
    let output = temp_dir.join(format!("upload-{}.mp4", now_epoch()));

    let mut cleanup_image: Option<PathBuf> = None;
    let mut args = vec!["-y".to_string()];

    if let Some(video_path) = payload.video_path.as_ref().filter(|p| !p.trim().is_empty()) {
        if payload.video_loop {
            args.push("-stream_loop".to_string());
            args.push("-1".to_string());
        }
        args.push("-i".to_string());
        args.push(video_path.clone());
        args.push("-i".to_string());
        args.push(payload.audio_path.clone());
		args.extend([
			"-c:v".to_string(),
			"libx264".to_string(),
			"-preset".to_string(),
			"slow".to_string(),
			"-crf".to_string(),
			"18".to_string(),
			"-pix_fmt".to_string(),
			"yuv420p".to_string(),
			"-c:a".to_string(),
			"aac".to_string(),
			"-b:a".to_string(),
			"320k".to_string(),
			"-vf".to_string(),
			"scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2".to_string(),
			"-movflags".to_string(),
			"+faststart".to_string(),
			"-shortest".to_string(),
			output.to_string_lossy().to_string(),
		]);
    } else {
        let image_path = if let Some(path) = payload.image_path.as_ref().filter(|p| !p.trim().is_empty()) {
            PathBuf::from(path)
        } else if let Some(base64) = payload.image_base64.as_ref().filter(|s| !s.trim().is_empty()) {
            let path = write_base64_image(data_dir, base64)?;
            cleanup_image = Some(path.clone());
            path
        } else {
            return Err("Pick an image or a video before uploading to YouTube.".to_string());
        };

		args.extend([
			"-loop".to_string(),
			"1".to_string(),
			"-i".to_string(),
			image_path.to_string_lossy().to_string(),
			"-i".to_string(),
			payload.audio_path.clone(),
			"-c:v".to_string(),
			"libx264".to_string(),
			"-preset".to_string(),
			"slow".to_string(),
			"-crf".to_string(),
			"18".to_string(),
			"-tune".to_string(),
			"stillimage".to_string(),
			"-pix_fmt".to_string(),
			"yuv420p".to_string(),
			"-c:a".to_string(),
			"aac".to_string(),
			"-b:a".to_string(),
			"320k".to_string(),
			"-vf".to_string(),
			"scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2".to_string(),
			"-movflags".to_string(),
			"+faststart".to_string(),
			"-shortest".to_string(),
			output.to_string_lossy().to_string(),
		]);
    }

    let ffmpeg = beatgaler_ffmpeg_program()?;
    let status = Command::new(&ffmpeg)
        .args(&args)
        .status()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    if let Some(path) = cleanup_image {
        let _ = std::fs::remove_file(path);
    }

    if !status.success() {
        return Err("ffmpeg could not render the upload video.".to_string());
    }

    Ok(output)
}

/// Same as render_upload_video but runs ffmpeg as a killable child process,
/// polling for cancellation instead of blocking until it exits. Used only by
/// the background job path (start_youtube_upload) so the "X" in the job tray
/// can actually stop an in-progress render, not just hide the UI.
fn render_upload_video_cancellable(
    data_dir: &Path,
    payload: &YouTubeUploadPayload,
    cancelled: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ffmpeg_pid: &std::sync::Arc<Mutex<Option<u32>>>,
) -> Result<PathBuf, String> {
    let audio_path = PathBuf::from(&payload.audio_path);
    if !audio_path.exists() {
        return Err(format!("Audio file not found: {}", payload.audio_path));
    }

    let temp_dir = youtube_temp_dir(data_dir)?;
    let output = temp_dir.join(format!("upload-{}.mp4", now_epoch()));

    let mut cleanup_image: Option<PathBuf> = None;
    let mut args = vec!["-y".to_string()];

    if let Some(video_path) = payload.video_path.as_ref().filter(|p| !p.trim().is_empty()) {
        if payload.video_loop {
            args.push("-stream_loop".to_string());
            args.push("-1".to_string());
        }
        args.push("-i".to_string());
        args.push(video_path.clone());
        args.push("-i".to_string());
        args.push(payload.audio_path.clone());
        args.extend([
            "-c:v".to_string(), "libx264".to_string(), "-preset".to_string(), "slow".to_string(),
            "-crf".to_string(), "18".to_string(), "-pix_fmt".to_string(), "yuv420p".to_string(),
            "-c:a".to_string(), "aac".to_string(), "-b:a".to_string(), "320k".to_string(),
            "-vf".to_string(), "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2".to_string(),
            "-movflags".to_string(), "+faststart".to_string(), "-shortest".to_string(),
            output.to_string_lossy().to_string(),
        ]);
    } else {
        let image_path = if let Some(path) = payload.image_path.as_ref().filter(|p| !p.trim().is_empty()) {
            PathBuf::from(path)
        } else if let Some(base64) = payload.image_base64.as_ref().filter(|s| !s.trim().is_empty()) {
            let path = write_base64_image(data_dir, base64)?;
            cleanup_image = Some(path.clone());
            path
        } else {
            return Err("Pick an image or a video before uploading to YouTube.".to_string());
        };

        args.extend([
            "-loop".to_string(), "1".to_string(), "-i".to_string(), image_path.to_string_lossy().to_string(),
            "-i".to_string(), payload.audio_path.clone(),
            "-c:v".to_string(), "libx264".to_string(), "-preset".to_string(), "slow".to_string(),
            "-crf".to_string(), "18".to_string(), "-tune".to_string(), "stillimage".to_string(),
            "-pix_fmt".to_string(), "yuv420p".to_string(), "-c:a".to_string(), "aac".to_string(),
            "-b:a".to_string(), "320k".to_string(),
            "-vf".to_string(), "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2".to_string(),
            "-movflags".to_string(), "+faststart".to_string(), "-shortest".to_string(),
            output.to_string_lossy().to_string(),
        ]);
    }

    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        if let Some(path) = cleanup_image { let _ = std::fs::remove_file(path); }
        return Err("CANCELLED".to_string());
    }

    let ffmpeg = beatgaler_ffmpeg_program()?;
    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    if let Ok(mut lock) = ffmpeg_pid.lock() { *lock = Some(child.id()); }

    let status = loop {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(path) = cleanup_image { let _ = std::fs::remove_file(path); }
            if let Ok(mut lock) = ffmpeg_pid.lock() { *lock = None; }
            return Err("CANCELLED".to_string());
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(e) => {
                if let Some(path) = cleanup_image { let _ = std::fs::remove_file(path); }
                return Err(format!("Failed while waiting for ffmpeg: {}", e));
            }
        }
    };

    if let Ok(mut lock) = ffmpeg_pid.lock() { *lock = None; }
    if let Some(path) = cleanup_image { let _ = std::fs::remove_file(path); }

    if !status.success() {
        return Err("ffmpeg could not render the upload video.".to_string());
    }

    Ok(output)
}

fn normalized_description(payload: &YouTubeUploadPayload) -> String {
    payload.description.trim().to_string()
}

#[tauri::command]
pub fn save_youtube_oauth_config(_raw_json: String, _state: tauri::State<SettingsState>) -> Result<(), String> {
    // Legacy compatibility only. OAuth configuration is bundled at build time now.
    // Intentionally do not persist user-selected client JSON or client_secret files.
    Ok(())
}

#[tauri::command]
pub fn get_youtube_channel(state: tauri::State<SettingsState>) -> Result<YouTubeChannel, String> {
    let client_cfg = load_oauth_client(&state.data_dir)?;
    let tokens = valid_access_token(&state.data_dir, &client_cfg)?;
    fetch_channel(&tokens.access_token)
}

#[tauri::command]
pub fn connect_youtube_channel(state: tauri::State<SettingsState>) -> Result<YouTubeChannel, String> {
    let client_cfg = load_oauth_client(&state.data_dir)?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Could not allocate OAuth callback port: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);

    let redirect_uri = choose_redirect_uri(&client_cfg, port)?;
    let code_verifier = random_urlsafe(64);
    let code_challenge = general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let state_token = random_urlsafe(24);
    let scope = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

    let auth_url = Url::parse_with_params(
        &client_cfg.auth_uri,
        &[
            ("client_id", client_cfg.client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", scope),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("code_challenge", code_challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state_token.as_str()),
        ],
    )
    .map_err(|e| e.to_string())?
    .to_string();

    launch_external_url(&auth_url)?;
    let code = receive_oauth_code(&redirect_uri, &state_token)?;
    let tokens = exchange_code_for_tokens(&client_cfg, &redirect_uri, &code, &code_verifier)?;
    save_json_file(&youtube_tokens_path(&state.data_dir), &tokens)?;
    fetch_channel(&tokens.access_token)
}

#[tauri::command]
pub fn upload_to_youtube(payload: YouTubeUploadPayload, state: tauri::State<SettingsState>) -> Result<YouTubeUploadResult, String> {
    let client_cfg = load_oauth_client(&state.data_dir)?;
    let tokens = valid_access_token(&state.data_dir, &client_cfg)?;
    let rendered_video = render_upload_video(&state.data_dir, &payload)?;

    let privacy = if payload.scheduled_at.as_ref().is_some_and(|s| !s.trim().is_empty()) {
        "private".to_string()
    } else {
        match payload.visibility.as_str() {
            "public" | "unlisted" | "private" => payload.visibility.clone(),
            _ => "private".to_string(),
        }
    };

    let sanitized_tags = sanitize_tags(&payload.tags);

    let metadata = json!({
        "snippet": {
            "title": payload.title,
            "description": normalized_description(&payload),
            "tags": sanitized_tags,
        },
        "status": {
            "privacyStatus": privacy,
            "publishAt": payload.scheduled_at,
            "selfDeclaredMadeForKids": false
        }
    });

    let video_len = std::fs::metadata(&rendered_video)
        .map_err(|e| format!("Failed to read rendered video metadata: {}", e))?
        .len();
    let (headers, body_text) = post_json_with_headers(
        "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable",
        &tokens.access_token,
        &metadata.to_string(),
        &[
            "X-Upload-Content-Type: video/mp4".to_string(),
            format!("X-Upload-Content-Length: {}", video_len),
        ],
    )
    .map_err(|e| format!("Failed to start YouTube upload: {}", e))?;

    // Inspect HTTP status from headers (first header line) and surface body on error
    if let Some(status_line) = headers.get(0) {
        let status_code = status_line.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
        if status_code < 200 || status_code >= 300 {
            return Err(format!("YouTube upload start failed: {} - {}", status_line, body_text));
        }
    }

    let upload_url = headers
        .iter()
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.starts_with("location:") {
                Some(line[9..].trim().to_string())
            } else {
                None
            }
        })
        .ok_or(format!("YouTube did not return an upload URL. Response body: {}", body_text))?;

    let upload_response = put_binary_json(&upload_url, &tokens.access_token, &rendered_video)
        .map_err(|e| format!("Video upload failed: {}", e))?;

    let _ = std::fs::remove_file(rendered_video);

    let video_id = upload_response.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if video_id.is_empty() {
        return Err("YouTube upload finished, but the response did not include a video id.".to_string());
    }

    Ok(YouTubeUploadResult {
        url: format!("https://www.youtube.com/watch?v={}", video_id),
        video_id,
    })
}

// ── Cancellable, sequential upload job queue ──
// Uploads are queued and processed ONE AT A TIME by a single background
// worker (spawned once in lib.rs at startup) instead of a new thread per
// click. This avoids N simultaneous ffmpeg renders + N simultaneous YouTube
// uploads fighting over CPU/bandwidth when the user queues several beats.
pub struct UploadJobHandle {
    pub cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub ffmpeg_pid: std::sync::Arc<Mutex<Option<u32>>>,
}
pub struct JobRegistry(pub Mutex<std::collections::HashMap<String, UploadJobHandle>>);

pub struct QueuedUploadJob {
    pub job_id: String,
    pub payload: YouTubeUploadPayload,
    pub app: tauri::AppHandle,
    pub data_dir: PathBuf,
    pub cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub ffmpeg_pid: std::sync::Arc<Mutex<Option<u32>>>,
}

pub struct UploadQueueState(pub Mutex<std::sync::mpsc::Sender<QueuedUploadJob>>);

/// Runs on its own thread for the lifetime of the app (spawned once from
/// lib.rs). Pulls jobs off the channel and processes them strictly one at a
/// time — the next job doesn't start rendering/uploading until the previous
/// one finishes, errors out, or is cancelled.
pub fn run_upload_worker(receiver: std::sync::mpsc::Receiver<QueuedUploadJob>) {
    for job in receiver {
        let started_payload = json!({ "job_id": job.job_id });
        let _ = job.app.emit("youtube:started", started_payload);

        let res = upload_to_youtube_internal(job.payload, &job.data_dir, &job.cancelled, &job.ffmpeg_pid);
        match res {
            Ok(r) => {
                let _ = job.app.emit("youtube:done", json!({ "job_id": job.job_id, "result": r }));
            }
            Err(e) if e == "CANCELLED" => {
                let _ = job.app.emit("youtube:cancelled", json!({ "job_id": job.job_id }));
            }
            Err(e) => {
                log_error(&job.data_dir, &format!("YouTube upload failed (job {}): {}", job.job_id, e));
                let _ = job.app.emit("youtube:error", json!({ "job_id": job.job_id, "error": e }));
            }
        }
    }
}

#[tauri::command]
pub fn cancel_youtube_upload(job_id: String, jobs: tauri::State<JobRegistry>) -> Result<(), String> {
    let lock = jobs.0.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = lock.get(&job_id) {
        handle.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        // If ffmpeg is currently rendering, kill it immediately instead of
        // waiting for the next checkpoint — that's the slow step.
        if let Ok(pid_lock) = handle.ffmpeg_pid.lock() {
            if let Some(pid) = *pid_lock {
                #[cfg(target_os = "windows")]
                { let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status(); }
                #[cfg(not(target_os = "windows"))]
                { let _ = std::process::Command::new("kill").arg(pid.to_string()).status(); }
            }
        }
    }
    Ok(())
}

// Enqueues a YouTube upload and returns a job id immediately. The actual
// work happens sequentially on the single worker thread started in lib.rs —
// this command never spawns its own thread.
#[tauri::command]
pub fn start_youtube_upload(
    app: tauri::AppHandle,
    payload: YouTubeUploadPayload,
    state: tauri::State<SettingsState>,
    jobs: tauri::State<JobRegistry>,
    queue: tauri::State<UploadQueueState>,
) -> Result<String, String> {
    let job_id = random_urlsafe(12);
    let data_dir = state.data_dir.clone();

    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ffmpeg_pid = std::sync::Arc::new(Mutex::new(None));
    {
        let mut lock = jobs.0.lock().map_err(|e| e.to_string())?;
        lock.insert(job_id.clone(), UploadJobHandle { cancelled: cancelled.clone(), ffmpeg_pid: ffmpeg_pid.clone() });
    }

    let queued = QueuedUploadJob {
        job_id: job_id.clone(), payload, app: app.clone(), data_dir, cancelled, ffmpeg_pid,
    };

    {
        let sender = queue.0.lock().map_err(|e| e.to_string())?;
        sender.send(queued).map_err(|e| format!("Could not queue upload: {}", e))?;
    }
    let _ = app.emit("youtube:queued", json!({ "job_id": job_id }));
    Ok(job_id)
}

// Internal helper used by the background worker
fn upload_to_youtube_internal(
    payload: YouTubeUploadPayload,
    data_dir: &Path,
    cancelled: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ffmpeg_pid: &std::sync::Arc<Mutex<Option<u32>>>,
) -> Result<YouTubeUploadResult, String> {
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) { return Err("CANCELLED".to_string()); }
    let client_cfg = load_oauth_client(data_dir)?;
    let tokens = valid_access_token(data_dir, &client_cfg)?;
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) { return Err("CANCELLED".to_string()); }
    let rendered_video = render_upload_video_cancellable(data_dir, &payload, cancelled, ffmpeg_pid)?;
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = std::fs::remove_file(&rendered_video);
        return Err("CANCELLED".to_string());
    }

    let privacy = if payload.scheduled_at.as_ref().is_some_and(|s| !s.trim().is_empty()) {
        "private".to_string()
    } else {
        match payload.visibility.as_str() {
            "public" | "unlisted" | "private" => payload.visibility.clone(),
            _ => "private".to_string(),
        }
    };

    let sanitized_tags = sanitize_tags(&payload.tags);

    let metadata = json!({
        "snippet": {
            "title": payload.title,
            "description": normalized_description(&payload),
            "tags": sanitized_tags,
        },
        "status": {
            "privacyStatus": privacy,
            "publishAt": payload.scheduled_at,
            "selfDeclaredMadeForKids": false
        }
    });

    let video_len = std::fs::metadata(&rendered_video)
        .map_err(|e| format!("Failed to read rendered video metadata: {}", e))?
        .len();
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = std::fs::remove_file(&rendered_video);
        return Err("CANCELLED".to_string());
    }
    let (headers, body_text) = post_json_with_headers(
        "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable",
        &tokens.access_token,
        &metadata.to_string(),
        &[
            "X-Upload-Content-Type: video/mp4".to_string(),
            format!("X-Upload-Content-Length: {}", video_len),
        ],
    )
    .map_err(|e| format!("Failed to start YouTube upload: {}", e))?;

    // Inspect HTTP status from headers (first header line) and surface body on error
    if let Some(status_line) = headers.get(0) {
        let status_code = status_line.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
        if status_code < 200 || status_code >= 300 {
            return Err(format!("YouTube upload start failed: {} - {}", status_line, body_text));
        }
    }

    let upload_url = headers
        .iter()
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.starts_with("location:") {
                Some(line[9..].trim().to_string())
            } else {
                None
            }
        })
        .ok_or(format!("YouTube did not return an upload URL. Response body: {}", body_text))?;

    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = std::fs::remove_file(&rendered_video);
        return Err("CANCELLED".to_string());
    }
    let upload_response = put_binary_with_retry(&upload_url, &tokens.access_token, &rendered_video, cancelled, data_dir)
        .map_err(|e| format!("Video upload failed: {}", e))?;

    let _ = std::fs::remove_file(rendered_video);

    let video_id = upload_response.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if video_id.is_empty() {
        return Err("YouTube upload finished, but the response did not include a video id.".to_string());
    }

    Ok(YouTubeUploadResult {
        url: format!("https://www.youtube.com/watch?v={}", video_id),
        video_id,
    })
}

// ─────────────────────────────────────────────────────────────
//  Multi-root smart import (fuzzy matcher integration)
// ─────────────────────────────────────────────────────────────

/// In-memory state holding batches that are waiting on user decisions.
/// Keyed by batch_id so the frontend can resolve a batch without the
/// backend re-scanning the disk.

fn telegram_authoritative_name_keys_excluding_beat(
    state: &tauri::State<SettingsState>,
    exclude_beat_id: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let connected = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.telegram_cloud_connected
    };
    if !connected {
        return Ok(std::collections::HashSet::new());
    }

    // V7: name validation consumes the last VERIFIED Telegram INDEX snapshot
    // already loaded by startup/refresh/library transactions. It must never
    // reserve a new transport operation from inside each individual media upload.
    // If no verified snapshot exists yet, the final INDEX transaction remains
    // authoritative and the upload is not blocked by a second network preflight.
    let manifest = cached_direct_library_manifest().unwrap_or_else(|| json!({
        "schema": GALER_T_LIBRARY_SCHEMA, "version": GALER_T_LIBRARY_SCHEMA_VERSION, "beats": [], "trash": []
    }));

    let mut used = std::collections::HashSet::<String>::new();
    if let Some(beats) = manifest.get("beats").and_then(|v| v.as_array()) {
        for entry in beats {
            if entry.get("id").and_then(|v| v.as_str()) == Some(exclude_beat_id) {
                continue;
            }
            if let Some(name) = entry.get("name").and_then(|v| v.as_str()) {
                let key = normalized_beat_name_key(name);
                if !key.is_empty() { used.insert(key); }
            }
        }
    }
    // Telegram trash is authoritative too. A trashed name remains reserved
    // until Telegram itself removes that tombstone.
    if let Some(trash) = manifest.get("trash").and_then(|v| v.as_array()) {
        for item in trash {
            let trashed_beat = item.get("beat").unwrap_or(item);
            if trashed_beat.get("id").and_then(|v| v.as_str()) == Some(exclude_beat_id) {
                continue;
            }
            if let Some(name) = trashed_beat.get("name").and_then(|v| v.as_str()) {
                let key = normalized_beat_name_key(name);
                if !key.is_empty() { used.insert(key); }
            }
        }
    }
    Ok(used)
}

fn next_import_display_name(
    base: &str,
    reserved_names: &mut std::collections::HashSet<String>,
) -> Result<String, String> {
    // `reserved_names` starts from Telegram's pinned library index. Nothing from
    // SQLite or local Trash is allowed to participate in cloud name ownership.
    // We only add names chosen during THIS import batch so two beats in the same
    // transaction cannot receive the same name before Telegram is updated.
    let base = normalized_beat_display_name(base);
    let base_key = normalized_beat_name_key(&base);
    if !reserved_names.contains(&base_key) {
        reserved_names.insert(base_key);
        return Ok(base);
    }

    for n in 2..10000 {
        let candidate = format!("{}_{}", base, n);
        let key = normalized_beat_name_key(&candidate);
        if !reserved_names.contains(&key) {
            reserved_names.insert(key);
            return Ok(candidate);
        }
    }

    Err(format!("Could not create a unique name for '{}'.", base))
}

fn final_cloud_display_name_after_review(
    state: &tauri::State<SettingsState>,
    beat_id: &str,
    requested_name: &str,
) -> Result<String, String> {
    let requested = normalized_beat_display_name(requested_name);
    if requested.is_empty() {
        return Err("Beat name cannot be empty.".to_string());
    }

    let reserved = telegram_authoritative_name_keys_excluding_beat(state, beat_id)?;
    if reserved.contains(&normalized_beat_name_key(&requested)) {
        return Err(format!(
            "A beat named '{}' already exists. Change the beat name before continuing.",
            requested
        ));
    }

    Ok(requested)
}

fn copy_import_tree_without_backups(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;

    for entry in WalkDir::new(src).min_depth(1).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_symlink() { continue; }
        let path = entry.path();
        let rel = path.strip_prefix(src).map_err(|e| e.to_string())?;

        if rel.components().any(|c| {
            matches!(
                c.as_os_str().to_string_lossy().trim().to_ascii_lowercase().as_str(),
                "backup" | "backups"
            )
        }) {
            continue;
        }

        let out = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(path, &out).map_err(|e| {
                format!("Could not copy '{}' to '{}': {}", path.display(), out.display(), e)
            })?;
        }
    }
    Ok(())
}

fn materialize_duplicate_import_folder(
    source: &Path,
    beat_name: &str,
    library_root: &Path,
) -> Result<MaterializedBeat, String> {
    std::fs::create_dir_all(library_root).map_err(|e| e.to_string())?;
    let dest = unique_folder_path(library_root, beat_name);
    copy_import_tree_without_backups(source, &dest)?;
    normalize_folder_artwork(&dest);

    let files = scan_folder_structured(&dest);
    let flp = files.flps.iter().find(|p| {
        p.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .eq_ignore_ascii_case("flp")
    }).cloned();

    Ok(MaterializedBeat {
        folder: dest,
        mp3: files.mp3s.first().cloned(),
        wav: files.wavs.first().cloned(),
        loop_path: None,
        stems: files.stems.first().cloned(),
        flp,
        als: files.alss.first().cloned(),
    })
}

pub struct ImportBatchState(pub Mutex<std::collections::HashMap<String, PendingImportBatch>>);

pub struct ImportDiscoveryTarget {
    pub path: PathBuf,
}

pub struct ImportDiscoveryStream {
    pub queue: std::collections::VecDeque<ImportDiscoveryTarget>,
}

pub struct PendingImportBatch {
    pub groups: std::collections::HashMap<String, matcher::ConfirmedGroup>,
    // When a confirmed beat came from a real beat folder, keep that folder so
    // materialization can copy its complete contents (Samples, Backup, Audio,
    // artwork, presets, etc.) instead of only the recognized files.
    pub source_folders: std::collections::HashMap<String, PathBuf>,
    // Review preparation is intentionally sequential. Discovery may know the
    // whole batch, but ID3/artwork for Beat N is not read until Beat N reaches
    // this cursor. This keeps Review Beat 1 independent from beats 2..N.
    pub review_order: Vec<String>,
    pub review_cursor: usize,
    pub prepared_cores: std::collections::HashSet<String>,
    // Internal discovery keys are unique even when two source folders contain
    // the same display name. Duplicate-name validation belongs to Review/Telegram,
    // not filesystem discovery.
    pub display_names: std::collections::HashMap<String, String>,
    // Streaming discovery means Review never waits for a full recursive batch scan.
    // Each prepare_next call advances only until the next playable beat is found.
    pub discovery_stream: Option<ImportDiscoveryStream>,
    pub discovery_complete: bool,
    // Same-role audio ambiguity (two MASTER MP3s, two WAV-only candidates, etc.)
    // never blocks the normal queue. It is resolved after normal beats.
    pub audio_conflicts: Vec<ImportAudioConflict>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImportAudioConflict {
    pub core_name: String,
    pub display_name: String,
    pub kind: String, // "master_mp3" | "source_wav" | "hq_wav"
    pub candidates: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportBatchPreview {
    pub batch_id: String,
    pub confirmed_count: usize,
    pub normal_count: usize,
    pub pending: Vec<matcher::PendingDecision>,
    pub audio_conflicts: Vec<ImportAudioConflict>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportReviewStep {
    pub beat: Option<BeatMeta>,
    pub prepared_count: usize,
    // Unknown until the streaming filesystem walk reaches the end.
    pub total_normal: Option<usize>,
    pub remaining_normal: Option<usize>,
    pub discovery_complete: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportDecisionInput {
    pub path: String,
    pub action: String,                   // "assign" | "independent" | "ignore"
    pub target_beat_name: Option<String>, // required when action == "assign"
    pub role: Option<String>,             // required when action == "assign" or "independent"
}

/// Recursively scans one or more root paths (folders OR loose audio files),
/// groups everything it finds by 100%-confidence name matching, and returns
/// whatever couldn't be grouped automatically for the user to resolve.
/// Nothing is copied to the vault yet — that happens in resolve_import_decisions.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BeatFolderUpdatePreview {
    pub has_mp3: bool,
    pub mp3_filename: Option<String>,
    pub has_wav: bool,
    pub has_project_file: bool,
    pub has_project_assets: bool,
}

#[tauri::command]
pub fn inspect_beat_update_folder(folder_path: String) -> Result<BeatFolderUpdatePreview, String> {
    let folder = PathBuf::from(folder_path);
    if !folder.is_dir() {
        return Err("Dropped path is not a folder.".to_string());
    }

    let files = scan_folder_structured(&folder);
    let has_project_file = !files.flps.is_empty() || !files.alss.is_empty();

    Ok(BeatFolderUpdatePreview {
        has_mp3: !files.mp3s.is_empty(),
        mp3_filename: files.mp3s.first()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string()),
        has_wav: !files.wavs.is_empty(),
        has_project_file,
        has_project_assets: folder_has_project_assets(&folder),
    })
}

fn merge_tree_into_existing_beat(src: &Path, dst: &Path) -> Result<(), String> {
    if src == dst {
        return Ok(());
    }

    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;

    for entry in WalkDir::new(src).min_depth(1).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_symlink() { continue; }
        let path = entry.path();
        let rel = path.strip_prefix(src).map_err(|e| e.to_string())?;

        if rel.components().any(|c| {
            matches!(
                c.as_os_str().to_string_lossy().trim().to_ascii_lowercase().as_str(),
                "backup" | "backups"
            )
        }) {
            continue;
        }

        if entry.file_type().is_file() && rel.components().count() == 1 {
            let ext = path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "mp3" || ext == "wav" {
                continue;
            }
        }

        let out = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(path, &out).map_err(|e| {
                format!("Could not merge '{}' into beat: {}", path.display(), e)
            })?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn merge_folder_into_existing_beat(
    mut beat: BeatMeta,
    folder_path: String,
    replace_master: bool,
    settings: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<BeatMeta, String> {
    let source = PathBuf::from(folder_path);
    if !source.is_dir() {
        return Err("Dropped path is not a folder.".to_string());
    }

    let incoming = scan_folder_structured(&source);

    let target = {
        let current = PathBuf::from(&beat.folder_path);
        if current.is_dir() {
            current
        } else {
            let candidate = settings.beats_dir().join(&beat.name);
            std::fs::create_dir_all(&candidate).map_err(|e| e.to_string())?;
            candidate
        }
    };

    merge_tree_into_existing_beat(&source, &target)?;

    if replace_master {
        if let Some(src_mp3) = incoming.mp3s.first() {
            let dest = if !beat.mp3_path.trim().is_empty() {
                let current = PathBuf::from(&beat.mp3_path);
                current.file_name()
                    .map(|n| target.join(n))
                    .unwrap_or_else(|| target.join(src_mp3.file_name().unwrap_or_default()))
            } else {
                target.join(src_mp3.file_name().unwrap_or_default())
            };

            if src_mp3 != &dest {
                std::fs::copy(src_mp3, &dest)
                    .map_err(|e| format!("Could not replace MASTER MP3: {}", e))?;
            }

            beat.mp3_path = dest.to_string_lossy().to_string();
            beat.playback_path = beat.mp3_path.clone();

            let (bpm, key, tags, rating, artwork) = read_id3(&dest);
            beat.bpm = bpm;
            beat.key = key;
            beat.tags = tags;
            beat.rating = rating;
            beat.image_base64 = artwork;
        }
    }

    if let Some(src_wav) = incoming.wavs.first() {
        let dest = beat.wav_path.as_ref()
            .filter(|p| !p.trim().is_empty())
            .and_then(|p| {
                PathBuf::from(p).file_name().map(|n| target.join(n))
            })
            .unwrap_or_else(|| target.join(src_wav.file_name().unwrap_or_default()));

        if src_wav != &dest {
            std::fs::copy(src_wav, &dest)
                .map_err(|e| format!("Could not update WAV: {}", e))?;
        }

        beat.wav_path = Some(dest.to_string_lossy().to_string());
        beat.has_wav = true;
    }

    normalize_folder_artwork(&target);
    let refreshed = scan_folder_structured(&target);

    beat.folder_path = target.to_string_lossy().to_string();
    beat.has_stems = !refreshed.stems.is_empty();
    beat.stems_path = refreshed.stems.first().map(|p| p.to_string_lossy().to_string());

    beat.has_flp = refreshed.flps.iter().any(|p| {
        p.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .eq_ignore_ascii_case("flp")
    });
    beat.flp_path = refreshed.flps.iter().find(|p| {
        p.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .eq_ignore_ascii_case("flp")
    }).map(|p| p.to_string_lossy().to_string());

    beat.has_als = !refreshed.alss.is_empty();
    beat.als_path = refreshed.alss.first().map(|p| p.to_string_lossy().to_string());
    beat.has_samples = has_samples_folder(&target);
    beat.samples_path = find_samples_folder(&target).map(|p| p.to_string_lossy().to_string());
    beat.other_files = refreshed.others.iter().map(|p| p.to_string_lossy().to_string()).collect();

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db_save(&conn, &beat).map_err(|e| e.to_string())?;

    if folder_has_project_assets(&source) {
        conn.execute(
            "UPDATE cloud_projects SET local_zip_path=NULL WHERE beat_id=?1",
            params![beat.id.clone()],
        ).map_err(|e| e.to_string())?;
    }

    Ok(beat)
}

#[tauri::command]
pub fn list_openable_cloud_project_beat_ids(
    db: tauri::State<DbState>,
) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT beat_id, manifest_json FROM cloud_projects ORDER BY beat_id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let (beat_id, raw) = row.map_err(|e| e.to_string())?;
        let manifest: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let manifest_openable = manifest.get("openable").and_then(|v| v.as_bool())
            .or_else(|| manifest.get("has_flp").and_then(|v| v.as_bool()))
            .or_else(|| manifest.get("has_als").and_then(|v| v.as_bool()))
            .unwrap_or(false);

        // Recovery fallback for databases affected by the old manifest bug:
        // BeatMeta may still remember that this beat has an FLP/ALS even when
        // the PROJECT manifest was incorrectly published as openable=false.
        let beat_meta_openable = conn.query_row(
            "SELECT meta_json FROM beats WHERE id=?1",
            params![beat_id.clone()],
            |row| row.get::<_, Option<String>>(0),
        ).ok().flatten()
            .and_then(|raw| serde_json::from_str::<BeatMeta>(&raw).ok())
            .map(|beat| beat.has_flp || beat.has_als)
            .unwrap_or(false);

        if manifest_openable || beat_meta_openable { out.push(beat_id); }
    }
    Ok(out)
}


fn is_auxiliary_stream_import_dir(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "sample" | "samples" | "stem" | "stems" |
        "backup" | "backups" | "render" | "renders" |
        "recording" | "recordings" | "audio" | "audio files" |
        "sliced audio" | "freeze" | "consolidated"
    )
}

fn stream_group_key() -> String {
    format!("__stream_{}", random_urlsafe(10))
}

/// Attach root-level DAW project files to one discovered audio beat.
///
/// Exact normalized-name matches always win. Real Ableton folders often use a
/// render name such as `Trap House F#m.wav` and a session name such as
/// `Trap House Project.als`, though. When the folder contains exactly one
/// supported project file, that file is unambiguous and is safe to attach even
/// when its stem differs from the audio stem. Multiple non-matching project
/// files remain unresolved instead of BeatGaler guessing.
fn attach_root_project_files(
    group: &mut matcher::ConfirmedGroup,
    direct_files: &[PathBuf],
    audio_core: &str,
) {
    let candidates: Vec<(PathBuf, String, String)> = direct_files
        .iter()
        .filter_map(|path| {
            let ext = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext != "flp" && ext != "als" {
                return None;
            }
            let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("");
            let clean = clean_name_from_filename(stem);
            let (core, _) = matcher::normalize_core_name(&clean);
            Some((path.clone(), ext, core))
        })
        .collect();

    let mut exact_matches = 0usize;
    for (path, ext, core) in &candidates {
        if core != audio_core {
            continue;
        }
        exact_matches += 1;
        match ext.as_str() {
            "flp" if group.flp.is_none() => group.flp = Some(path.clone()),
            "als" if group.als.is_none() => group.als = Some(path.clone()),
            _ => {}
        }
    }

    let mut used_unique_fallback = false;
    if group.flp.is_none() && group.als.is_none() && candidates.len() == 1 {
        let (path, ext, _) = &candidates[0];
        match ext.as_str() {
            "flp" => group.flp = Some(path.clone()),
            "als" => group.als = Some(path.clone()),
            _ => unreachable!("project candidates are filtered above"),
        }
        used_unique_fallback = true;
    }

    let candidate_names = candidates
        .iter()
        .filter_map(|(path, _, _)| path.file_name())
        .map(|name| name.to_string_lossy())
        .collect::<Vec<_>>()
        .join("|");
    let selected_names = [group.flp.as_ref(), group.als.as_ref()]
        .into_iter()
        .flatten()
        .filter_map(|path| path.file_name())
        .map(|name| name.to_string_lossy())
        .collect::<Vec<_>>()
        .join("|");
    eprintln!(
        "[review-diag] PROJECT_PAIR_DECISION audio_core={} candidates={} exact_matches={} unique_fallback={} candidate_names={} selected_names={}",
        audio_core,
        candidates.len(),
        exact_matches,
        used_unique_fallback,
        candidate_names,
        selected_names,
    );
}

/// Advance a streaming import session only until the next NORMAL playable beat
/// is known. Ambiguous folders are recorded for the conflict UI and skipped so
/// they never delay the first usable Review item. Directory traversal is
/// breadth-first/shallow-first and only inspects direct children at each step.
fn discover_next_stream_group(batch: &mut PendingImportBatch) -> Result<Option<String>, String> {
    let discovery_started = std::time::Instant::now();
    let mut targets_checked: usize = 0;
    loop {
        let target = match batch.discovery_stream.as_mut() {
            Some(stream) => stream.queue.pop_front(),
            None => None,
        };
        let Some(target) = target else {
            batch.discovery_complete = true;
            eprintln!("[review-diag] DISCOVERY_QUEUE_EXHAUSTED elapsed_ms={} targets_checked={}", discovery_started.elapsed().as_millis(), targets_checked);
            return Ok(None);
        };
        let path = target.path;
        targets_checked += 1;
        let stat_started = std::time::Instant::now();
        let exists = path.exists();
        let exists_ms = stat_started.elapsed().as_millis();
        if !exists {
            eprintln!("[review-diag] DISCOVERY_TARGET_MISSING target={} stat_ms={} path={}", targets_checked, exists_ms, path.display());
            continue;
        }

        // Explicit loose audio files are each their own beat, even when several
        // selected files happen to share the same parent folder.
        let file_check_started = std::time::Instant::now();
        let path_is_file = path.is_file();
        let file_check_ms = file_check_started.elapsed().as_millis();
        if path_is_file {
            eprintln!("[review-diag] DISCOVERY_TARGET_FILE target={} stat_ms={} file_check_ms={} path={}", targets_checked, exists_ms, file_check_ms, path.display());
            if !is_audio_file(&path) { continue; }
            let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext != "mp3" && ext != "wav" { continue; }
            let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("Beat");
            let clean = clean_name_from_filename(stem);
            let (core, _) = matcher::normalize_core_name(&clean);
            let display = if clean.trim().is_empty() { "Beat".to_string() } else { clean };
            let key = stream_group_key();
            let mut group = matcher::ConfirmedGroup { core_name: key.clone(), ..Default::default() };
            if ext == "mp3" { group.mp3 = Some(path.clone()); }
            else { group.wav = Some(path.clone()); }
            if let Some(parent) = path.parent() {
                batch.source_folders.insert(key.clone(), parent.to_path_buf());
            }
            batch.display_names.insert(key.clone(), if core.trim().is_empty() { display } else { titleize(&core) });
            batch.groups.insert(key.clone(), group);
            batch.review_order.push(key.clone());
            eprintln!("[review-diag] FIRST_OR_NEXT_AUDIO_FOUND elapsed_ms={} targets_checked={} kind=loose path={}", discovery_started.elapsed().as_millis(), targets_checked, path.display());
            return Ok(Some(key));
        }

        let dir_check_started = std::time::Instant::now();
        let path_is_dir = path.is_dir();
        let dir_check_ms = dir_check_started.elapsed().as_millis();
        if !path_is_dir { continue; }

        let dir_scan_started = std::time::Instant::now();
        let mut child_dirs: Vec<PathBuf> = Vec::new();
        let mut direct_files: Vec<PathBuf> = Vec::new();
        let mut entry_count: usize = 0;
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) => {
                eprintln!("[review-diag] READ_DIR_ERROR target={} elapsed_ms={} error={} path={}", targets_checked, dir_scan_started.elapsed().as_millis(), error, path.display());
                continue;
            },
        };
        for entry in entries.flatten() {
            entry_count += 1;
            let child = entry.path();
            if child.is_dir() {
                let name = child.file_name().and_then(|v| v.to_str()).unwrap_or("");
                if !is_auxiliary_stream_import_dir(name) {
                    child_dirs.push(child);
                }
                continue;
            }
            if !child.is_file() { continue; }
            let ext = child.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
            if matches!(ext.as_str(), "mp3" | "wav" | "flp" | "als") {
                direct_files.push(child);
            }
        }
        eprintln!(
            "[review-diag] READ_DIR_DONE target={} elapsed_ms={} exists_ms={} file_check_ms={} dir_check_ms={} entries={} child_dirs={} relevant_files={} path={}",
            targets_checked, dir_scan_started.elapsed().as_millis(), exists_ms, file_check_ms, dir_check_ms,
            entry_count, child_dirs.len(), direct_files.len(), path.display()
        );

        let mut audio_by_core: std::collections::HashMap<String, (Vec<PathBuf>, Vec<PathBuf>)> = std::collections::HashMap::new();
        for file in &direct_files {
            let ext = file.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext != "mp3" && ext != "wav" { continue; }
            let stem = file.file_stem().and_then(|v| v.to_str()).unwrap_or("");
            let clean = clean_name_from_filename(stem);
            let (core, _) = matcher::normalize_core_name(&clean);
            if core.trim().is_empty() { continue; }
            let slot = audio_by_core.entry(core).or_default();
            if ext == "mp3" { slot.0.push(file.clone()); }
            else { slot.1.push(file.clone()); }
        }

        if audio_by_core.is_empty() {
            // Container folder: continue shallow-first into its children.
            if let Some(stream) = batch.discovery_stream.as_mut() {
                for dir in child_dirs { stream.queue.push_back(ImportDiscoveryTarget { path: dir }); }
            }
            continue;
        }

        let mut choices: Vec<(String, PathBuf)> = Vec::new();
        for (core, (mp3s, wavs)) in &audio_by_core {
            if !mp3s.is_empty() {
                for file in mp3s { choices.push((core.clone(), file.clone())); }
            } else {
                for file in wavs { choices.push((core.clone(), file.clone())); }
            }
        }

        if choices.len() != 1 {
            // This folder itself is ambiguous. Preserve the conflict for the end,
            // but keep walking non-asset child folders in case they contain normal beats.
            let key = format!("__folder_conflict_{}", random_urlsafe(8));
            let display = path.file_name().and_then(|v| v.to_str()).unwrap_or("Beat").to_string();
            let candidates = choices.iter().map(|(_, p)| p.to_string_lossy().to_string()).collect::<Vec<_>>();
            let candidate_count = candidates.len();
            batch.groups.insert(key.clone(), matcher::ConfirmedGroup { core_name: key.clone(), ..Default::default() });
            batch.source_folders.insert(key.clone(), path.clone());
            batch.audio_conflicts.push(ImportAudioConflict {
                core_name: key,
                display_name: display,
                kind: "main_audio".to_string(),
                candidates,
            });
            eprintln!(
                "[review-diag] AUDIO_CONFLICT_DEFERRED elapsed_ms={} targets_checked={} candidates={} child_dirs={} path={}",
                discovery_started.elapsed().as_millis(), targets_checked, candidate_count, child_dirs.len(), path.display()
            );
            if let Some(stream) = batch.discovery_stream.as_mut() {
                for dir in child_dirs { stream.queue.push_back(ImportDiscoveryTarget { path: dir }); }
            }
            continue;
        }

        let (core, selected) = choices.remove(0);
        let ext = selected.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        let key = stream_group_key();
        let mut group = matcher::ConfirmedGroup { core_name: key.clone(), ..Default::default() };
        if ext == "mp3" { group.mp3 = Some(selected.clone()); }
        else { group.wav = Some(selected.clone()); }

        if let Some((mp3s, wavs)) = audio_by_core.get(&core) {
            // MP3 + one same-core WAV is a normal MASTER + HQ pair.
            if !mp3s.is_empty() && wavs.len() == 1 {
                group.wav = wavs.first().cloned();
            }
        }

        // Root-level project files are cheap to attach. Exact names win, while
        // one unique project is also safe when Ableton names it `... Project`.
        // Deep project/Samples/Stems work stays out of Review and happens later.
        attach_root_project_files(&mut group, &direct_files, &core);

        batch.source_folders.insert(key.clone(), path.clone());
        batch.display_names.insert(key.clone(), titleize(&core));
        batch.groups.insert(key.clone(), group);
        batch.review_order.push(key.clone());
        eprintln!("[review-diag] FIRST_OR_NEXT_AUDIO_FOUND elapsed_ms={} targets_checked={} kind=folder path={}", discovery_started.elapsed().as_millis(), targets_checked, selected.display());
        return Ok(Some(key));
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportReviewStreamStart {
    pub batch_id: String,
}

/// Create a Review discovery session without walking the dropped tree. This
/// returns almost immediately; prepare_next_import_review_beat does the actual
/// incremental shallow-first discovery one beat at a time.
#[tauri::command]
pub fn start_import_review_stream(
    root_paths: Vec<String>,
    batches: tauri::State<ImportBatchState>,
) -> Result<ImportReviewStreamStart, String> {
    let started = std::time::Instant::now();
    eprintln!("[review-diag] RUST_STREAM_CREATE root_count={}", root_paths.len());
    let mut queue = std::collections::VecDeque::new();
    for raw in root_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() { continue; }
        queue.push_back(ImportDiscoveryTarget { path: PathBuf::from(trimmed) });
    }
    if queue.is_empty() { return Err("Nothing to import.".to_string()); }

    let batch_id = random_urlsafe(10);
    let batch = PendingImportBatch {
        groups: std::collections::HashMap::new(),
        source_folders: std::collections::HashMap::new(),
        review_order: Vec::new(),
        review_cursor: 0,
        prepared_cores: std::collections::HashSet::new(),
        display_names: std::collections::HashMap::new(),
        discovery_stream: Some(ImportDiscoveryStream { queue }),
        discovery_complete: false,
        audio_conflicts: Vec::new(),
    };
    let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
    lock.insert(batch_id.clone(), batch);
    eprintln!("[review-diag] RUST_STREAM_READY elapsed_ms={} batch={}", started.elapsed().as_millis(), batch_id);
    Ok(ImportReviewStreamStart { batch_id })
}

#[tauri::command]
pub fn get_import_review_batch_summary(
    batch_id: String,
    batches: tauri::State<ImportBatchState>,
) -> Result<ImportBatchPreview, String> {
    let lock = batches.0.lock().map_err(|e| e.to_string())?;
    let batch = lock.get(&batch_id)
        .ok_or_else(|| "This import batch expired. Drop the files again.".to_string())?;
    Ok(ImportBatchPreview {
        batch_id,
        confirmed_count: batch.groups.len(),
        normal_count: batch.review_order.len(),
        pending: Vec::new(),
        audio_conflicts: batch.audio_conflicts.clone(),
    })
}

#[tauri::command]
pub fn preview_import_batch(
    root_paths: Vec<String>,
    _state: tauri::State<DbState>,
    batches: tauri::State<ImportBatchState>,
) -> Result<ImportBatchPreview, String> {
    let review_started = std::time::Instant::now();
    let mut all_items: Vec<matcher::DiscoveredItem> = Vec::new();
    // Preserve discovery order separately from the HashMap-based matcher. This
    // makes Review deterministic and lets Beat 1 be whichever playable audio
    // BeatGaler encountered first, instead of an arbitrary hash iteration.
    let mut discovery_order: Vec<String> = Vec::new();
    let mut audio_candidates: std::collections::HashMap<String, (Vec<PathBuf>, Vec<PathBuf>)> = std::collections::HashMap::new();
    // Audio discovered while walking a DIRECTORY is also indexed by its direct
    // parent. A folder containing multiple plausible main audios is ambiguous
    // and must ask the user which one represents the beat. Explicitly selected
    // loose files are intentionally NOT put here: selecting 5 audio files means
    // 5 beats, even if those files happen to share a parent directory.
    let mut directory_audio_by_parent: std::collections::HashMap<PathBuf, Vec<PathBuf>> = std::collections::HashMap::new();
    let dropped_roots: Vec<PathBuf> = root_paths.iter().map(PathBuf::from).collect();

    let mut remember_discovered_audio = |item: &matcher::DiscoveredItem| {
        let role = item.role_hint.unwrap_or(matcher::FileRole::Other);
        if item.core_name.trim().is_empty() { return; }
        if matches!(role, matcher::FileRole::Mp3 | matcher::FileRole::Wav) {
            if !discovery_order.iter().any(|name| name == &item.core_name) {
                discovery_order.push(item.core_name.clone());
            }
            let entry = audio_candidates.entry(item.core_name.clone()).or_default();
            match role {
                matcher::FileRole::Mp3 => entry.0.push(item.path.clone()),
                matcher::FileRole::Wav => entry.1.push(item.path.clone()),
                _ => {}
            }
        }
    };

    // These directories are assets that belong to a beat. Audio files inside
    // them must never become independent beats during recursive import.
    fn is_auxiliary_import_dir(name: &str) -> bool {
        matches!(
            name.trim().to_ascii_lowercase().as_str(),
            "sample" | "samples" | "stem" | "stems" |
            "backup" | "backups" | "render" | "renders" |
            "recording" | "recordings" | "audio" | "audio files" |
            "sliced audio" | "freeze" | "consolidated"
        )
    }

    fn path_is_inside_auxiliary_dir(path: &Path, root: &Path) -> bool {
        let parent = path.parent().unwrap_or(path);
        parent
            .strip_prefix(root)
            .ok()
            .map(|relative| {
                relative.components().any(|component| {
                    is_auxiliary_import_dir(&component.as_os_str().to_string_lossy())
                })
            })
            .unwrap_or(false)
    }

    // A folder explicitly selected by the user is a beat container when its
    // ROOT contains a matching MP3. In that case it must create exactly ONE
    // beat. Audio/Samples/Backup are project assets, never independent beats.
    if root_paths.len() == 1 {
        let root_path = PathBuf::from(&root_paths[0]);
        if root_path.is_dir() {
            let folder_name = root_path.file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("Beat")
                .to_string();
            let clean_folder = clean_name_from_filename(&folder_name);
            let (folder_core, _) = matcher::normalize_core_name(&clean_folder);

            let mut matching_mp3: Vec<PathBuf> = Vec::new();
            let mut matching_wav: Vec<PathBuf> = Vec::new();
            let mut matching_flp: Vec<PathBuf> = Vec::new();
            let mut matching_als: Vec<PathBuf> = Vec::new();
            let mut root_project_files: Vec<PathBuf> = Vec::new();
            let mut root_audio_roles: std::collections::HashMap<String, (usize, usize)> = std::collections::HashMap::new();

            for entry in std::fs::read_dir(&root_path).map_err(|e| e.to_string())?.flatten() {
                let path = entry.path();
                if !path.is_file() { continue; }
                let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
                if !matches!(ext.as_str(), "mp3" | "wav" | "flp" | "als") { continue; }
                if matches!(ext.as_str(), "flp" | "als") {
                    root_project_files.push(path.clone());
                }

                let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
                let clean = clean_name_from_filename(stem);
                let (core, _) = matcher::normalize_core_name(&clean);
                if matches!(ext.as_str(), "mp3" | "wav") && !core.trim().is_empty() {
                    let counts = root_audio_roles.entry(core.clone()).or_default();
                    if ext == "mp3" { counts.0 += 1; } else { counts.1 += 1; }
                }
                if core != folder_core { continue; }

                match ext.as_str() {
                    "mp3" => matching_mp3.push(path),
                    "wav" => matching_wav.push(path),
                    "flp" => matching_flp.push(path),
                    "als" => matching_als.push(path),
                    _ => {}
                }
            }

            // MASTER is MP3. WAV is HQ-only and never becomes another beat.
            // The fast path is deliberately reserved for an unambiguous folder.
            // If this folder itself contains more than one plausible main audio,
            // do NOT silently choose the one whose filename matches the folder:
            // the dedicated conflict UI must ask the user at the end.
            let root_main_choice_count: usize = root_audio_roles.values().map(|(mp3_count, wav_count)| {
                if *mp3_count > 0 { *mp3_count } else { *wav_count }
            }).sum();
            if root_main_choice_count == 1 && matching_mp3.len() == 1 && matching_wav.len() <= 1 {
                matching_mp3.sort();
                matching_wav.sort();
                matching_flp.sort();
                matching_als.sort();

                let mut group = matcher::ConfirmedGroup::default();
                group.core_name = folder_core.clone();
                group.mp3 = matching_mp3.into_iter().next();
                group.wav = matching_wav.into_iter().next();
                // Only a ROOT-level FLP/ALS can identify the main project.
                // FLPs inside Backup/ are never scanned here.
                group.flp = matching_flp.into_iter().next();
                group.als = matching_als.into_iter().next();
                attach_root_project_files(&mut group, &root_project_files, &folder_core);

                let batch_id = random_urlsafe(10);
                let mut groups = std::collections::HashMap::new();
                groups.insert(folder_core.clone(), group);
                let mut source_folders = std::collections::HashMap::new();
                source_folders.insert(folder_core.clone(), root_path.clone());

                let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
                lock.insert(batch_id.clone(), PendingImportBatch {
                    groups,
                    source_folders,
                    review_order: vec![folder_core],
                    review_cursor: 0,
                    prepared_cores: std::collections::HashSet::new(),
                    display_names: std::collections::HashMap::new(),
                    discovery_stream: None,
                    discovery_complete: true,
                    audio_conflicts: Vec::new(),
                });
                eprintln!("[review-perf] preview folder fast-path: {} ms", review_started.elapsed().as_millis());
                return Ok(ImportBatchPreview {
                    batch_id,
                    confirmed_count: 1,
                    normal_count: 1,
                    pending: Vec::new(),
                    audio_conflicts: Vec::new(),
                });
            }
        }
    }

    for root in &root_paths {
        let root_path = PathBuf::from(root);
        if !root_path.exists() || path_is_symbolic_link(&root_path) { continue; }

        if root_path.is_file() {
            if is_audio_file(&root_path) {
                let item = matcher::make_discovered_item(root_path, false);
                remember_discovered_audio(&item);
                all_items.push(item);
            }
            continue;
        }

        // Do not descend into Samples/Stems/Backup trees. They are copied later
        // as part of their owning beat folder, but their individual WAV/MP3
        // files are deliberately excluded from beat discovery.
        let walker = WalkDir::new(&root_path)
            .min_depth(1)
            .into_iter()
            .filter_entry(|entry| {
                if entry.file_type().is_symlink() { return false; }
                if !entry.file_type().is_dir() { return true; }
                let name = entry.file_name().to_string_lossy();
                !is_auxiliary_import_dir(&name)
            });

        for entry in walker {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().is_symlink() { continue; }
            let p = entry.path().to_path_buf();
            if entry.file_type().is_dir() { continue; }
            if path_is_inside_auxiliary_dir(&p, &root_path) { continue; }

            let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
            if matches!(ext.as_str(), "mp3" | "wav" | "flp" | "als") {
                if matches!(ext.as_str(), "mp3" | "wav") {
                    if let Some(parent) = p.parent() {
                        directory_audio_by_parent.entry(parent.to_path_buf()).or_default().push(p.clone());
                    }
                }
                let item = matcher::make_discovered_item(p, false);
                remember_discovered_audio(&item);
                all_items.push(item);
            }
        }
    }

    // Scanning is complete; release the closure's mutable borrows before the
    // folder-conflict pass edits the discovery indexes.
    drop(remember_discovered_audio);

    // A directory containing multiple plausible main audios is intentionally
    // ambiguous. Example: dropping Folder/{beatA.mp3, beatB.mp3} asks which one
    // is the beat; selecting beatA.mp3 + beatB.mp3 directly still means 2 beats.
    // One MP3 plus its same-core WAV remains a normal MASTER+HQ pair.
    let mut folder_audio_conflicts: Vec<(String, String, PathBuf, Vec<PathBuf>, Vec<PathBuf>)> = Vec::new();
    let mut folder_conflict_all_audio = std::collections::HashSet::<PathBuf>::new();
    for (parent, raw_paths) in &directory_audio_by_parent {
        let mut by_core: std::collections::HashMap<String, (Vec<PathBuf>, Vec<PathBuf>)> = std::collections::HashMap::new();
        for path in raw_paths {
            let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
            let clean = clean_name_from_filename(stem);
            let (core, _) = matcher::normalize_core_name(&clean);
            if core.trim().is_empty() { continue; }
            let slot = by_core.entry(core).or_default();
            let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext == "mp3" { slot.0.push(path.clone()); } else if ext == "wav" { slot.1.push(path.clone()); }
        }

        let mut choices: Vec<PathBuf> = Vec::new();
        for (_core, (mut mp3s, mut wavs)) in by_core {
            mp3s.sort(); mp3s.dedup();
            wavs.sort(); wavs.dedup();
            if !mp3s.is_empty() { choices.extend(mp3s); } else { choices.extend(wavs); }
        }
        choices.sort(); choices.dedup();
        if choices.len() <= 1 { continue; }

        for path in raw_paths { folder_conflict_all_audio.insert(path.clone()); }
        let display_name = parent.file_name().and_then(|v| v.to_str()).unwrap_or("Beat").to_string();
        folder_audio_conflicts.push((
            format!("__folder_conflict_{}", random_urlsafe(8)),
            display_name,
            parent.clone(),
            choices,
            raw_paths.clone(),
        ));
    }

    if !folder_conflict_all_audio.is_empty() {
        all_items.retain(|item| !folder_conflict_all_audio.contains(&item.path));
        for (_core, (mp3s, wavs)) in audio_candidates.iter_mut() {
            mp3s.retain(|path| !folder_conflict_all_audio.contains(path));
            wavs.retain(|path| !folder_conflict_all_audio.contains(path));
        }
        audio_candidates.retain(|_core, (mp3s, wavs)| !mp3s.is_empty() || !wavs.is_empty());
        discovery_order.retain(|core| audio_candidates.contains_key(core));
    }

    // Review candidates must be derived only from the files the user just
    // dropped. Existing SQLite/library rows must not affect discovery or naming
    // before Save. Cloud duplicate checks happen only after Review -> Save.
    let existing_core_names: Vec<String> = Vec::new();

    // The matcher consumes its input. From this point on we only need the
    // lightweight discovery-order/audio-candidate indexes built above.
    let (confirmed, mut pending) = matcher::group_discovered_items(all_items, &existing_core_names);

    // Same-role audio ambiguity is a beat-level conflict, not a reason to block
    // every other beat. Record it now and move those beats to the end of Review.
    let mut audio_conflicts: Vec<ImportAudioConflict> = Vec::new();
    let mut conflict_cores = std::collections::HashSet::<String>::new();
    let mut conflict_candidate_paths = std::collections::HashSet::<PathBuf>::new();
    for (synthetic_core, display_name, _parent, choices, all_audio) in &folder_audio_conflicts {
        conflict_cores.insert(synthetic_core.clone());
        for path in all_audio { conflict_candidate_paths.insert(path.clone()); }
        audio_conflicts.push(ImportAudioConflict {
            core_name: synthetic_core.clone(),
            display_name: display_name.clone(),
            kind: "main_audio".to_string(),
            candidates: choices.iter().map(|p| p.to_string_lossy().to_string()).collect(),
        });
    }
    for core in &discovery_order {
        let Some((mp3s_raw, wavs_raw)) = audio_candidates.get(core) else { continue; };
        let mut mp3s = mp3s_raw.clone();
        let mut wavs = wavs_raw.clone();
        mp3s.sort(); mp3s.dedup();
        wavs.sort(); wavs.dedup();

        let (kind, candidates) = if mp3s.len() > 1 {
            ("master_mp3", mp3s.clone())
        } else if mp3s.is_empty() && wavs.len() > 1 {
            ("source_wav", wavs.clone())
        } else if mp3s.len() == 1 && wavs.len() > 1 {
            ("hq_wav", wavs.clone())
        } else {
            continue;
        };

        conflict_cores.insert(core.clone());
        for path in &candidates { conflict_candidate_paths.insert(path.clone()); }
        audio_conflicts.push(ImportAudioConflict {
            core_name: core.clone(),
            display_name: titleize(core),
            kind: kind.to_string(),
            candidates: candidates.iter().map(|p| p.to_string_lossy().to_string()).collect(),
        });
    }

    // Candidate files owned by the dedicated audio-conflict UI must not also
    // appear in the old fuzzy-decision modal.
    pending.retain(|item| !conflict_candidate_paths.contains(&PathBuf::from(&item.path)));

    fn common_ancestor(paths: &[PathBuf]) -> Option<PathBuf> {
        let first = paths.first()?.parent()?.to_path_buf();
        let mut candidate = first;
        for path in paths.iter().skip(1) {
            let parent = path.parent()?;
            while !parent.starts_with(&candidate) {
                if !candidate.pop() { return None; }
            }
        }
        Some(candidate)
    }

    fn owning_beat_folder(group_paths: &[PathBuf], dropped_roots: &[PathBuf], total_confirmed: usize) -> Option<PathBuf> {
        for root in dropped_roots {
            if !root.is_dir() || !group_paths.iter().all(|p| p.starts_with(root)) { continue; }
            if total_confirmed == 1 { return Some(root.clone()); }
            let mut child: Option<PathBuf> = None;
            let mut same = true;
            for p in group_paths {
                let rel = p.strip_prefix(root).ok()?;
                let first = rel.components().next()?;
                let current = root.join(first.as_os_str());
                match &child { None => child = Some(current), Some(c) if c == &current => {}, Some(_) => { same = false; break; } }
            }
            if same { if let Some(c) = child { if c.is_dir() { return Some(c); } } }
        }
        common_ancestor(group_paths)
    }

    let batch_id = random_urlsafe(10);
    let mut groups_map: std::collections::HashMap<String, matcher::ConfirmedGroup> = std::collections::HashMap::new();
    let mut source_folders: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();

    // Audio defines a beat. A project-only / loose FLP / unrelated discovered
    // group must never enter Review and later fail with "No playable audio".
    // Ambiguous audio is handled separately by `audio_conflicts` below.
    let playable_confirmed: Vec<matcher::ConfirmedGroup> = confirmed
        .into_iter()
        .filter(|group| group.mp3.is_some() || group.wav.is_some())
        .collect();
    let total_confirmed = playable_confirmed.len();

    for mut g in playable_confirmed {
        // Never let an arbitrary directory-order winner leak into Review for an
        // ambiguous slot. The conflict resolver will explicitly choose it later.
        if let Some(conflict) = audio_conflicts.iter().find(|c| c.core_name == g.core_name) {
            match conflict.kind.as_str() {
                "master_mp3" => {
                    g.mp3 = None;
                    // If HQ itself is ambiguous too, keep Review safe and simply
                    // omit it rather than guessing. The user can add HQ later.
                    if audio_candidates.get(&g.core_name).map(|(_, w)| w.len() > 1).unwrap_or(false) {
                        g.wav = None;
                    }
                }
                "source_wav" | "hq_wav" => g.wav = None,
                _ => {}
            }
            let candidate_set: std::collections::HashSet<PathBuf> = conflict.candidates.iter().map(PathBuf::from).collect();
            g.others.retain(|p| !candidate_set.contains(p));
        }

        let mut group_paths: Vec<PathBuf> = Vec::new();
        if let Some(p) = &g.mp3 { group_paths.push(p.clone()); }
        if let Some(p) = &g.wav { group_paths.push(p.clone()); }
        if let Some(p) = &g.loop_file { group_paths.push(p.clone()); }
        if let Some(p) = &g.flp { group_paths.push(p.clone()); }
        if let Some(p) = &g.als { group_paths.push(p.clone()); }
        group_paths.extend(g.others.iter().cloned());
        if let Some(conflict) = audio_conflicts.iter().find(|c| c.core_name == g.core_name) {
            group_paths.extend(conflict.candidates.iter().map(PathBuf::from));
        }

        if let Some(folder) = owning_beat_folder(&group_paths, &dropped_roots, total_confirmed) {
            if folder.is_dir() { source_folders.insert(g.core_name.clone(), folder); }
        }

        groups_map.insert(g.core_name.clone(), g);
    }
    for (synthetic_core, _display_name, parent, _choices, _all_audio) in &folder_audio_conflicts {
        groups_map.insert(synthetic_core.clone(), matcher::ConfirmedGroup {
            core_name: synthetic_core.clone(),
            ..Default::default()
        });
        source_folders.insert(synthetic_core.clone(), parent.clone());
    }
    let confirmed_count = groups_map.len();

    // Speed first: normal Review follows first-seen playable audio order. HashMap
    // order is never allowed to decide which beat the user waits for first.
    let mut review_order: Vec<String> = Vec::new();
    for core in discovery_order {
        if groups_map.contains_key(&core) && !conflict_cores.contains(&core) && !review_order.contains(&core) {
            review_order.push(core);
        }
    }
    let mut leftovers: Vec<String> = groups_map.keys()
        .filter(|core| !conflict_cores.contains(*core) && !review_order.contains(*core))
        .cloned()
        .collect();
    leftovers.sort();
    review_order.extend(leftovers);
    let normal_count = review_order.len();

    {
        let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
        lock.insert(batch_id.clone(), PendingImportBatch {
            groups: groups_map,
            source_folders,
            review_order,
            review_cursor: 0,
            prepared_cores: std::collections::HashSet::new(),
            display_names: std::collections::HashMap::new(),
            discovery_stream: None,
            discovery_complete: true,
            audio_conflicts: audio_conflicts.clone(),
        });
    }

    eprintln!("[review-perf] preview discovery: {} ms", review_started.elapsed().as_millis());
    Ok(ImportBatchPreview { batch_id, confirmed_count, normal_count, pending, audio_conflicts })
}

/// Slots a discovered file into the right place on a ConfirmedGroup. If that
/// slot is already taken (conflict), the file is preserved in `others` instead
/// of being silently dropped or overwriting what's already there.
fn assign_to_group(group: &mut matcher::ConfirmedGroup, path: PathBuf, role: Option<&str>) {
    let role = role.map(matcher::FileRole::from_str).unwrap_or(matcher::FileRole::Other);
    match role {
        matcher::FileRole::Mp3 if group.mp3.is_none() => group.mp3 = Some(path),
        matcher::FileRole::Wav if group.wav.is_none() => group.wav = Some(path),
        matcher::FileRole::Loop if group.loop_file.is_none() => group.loop_file = Some(path),
        matcher::FileRole::Stems if group.stems.is_none() => group.stems = Some(path),
        matcher::FileRole::Flp if group.flp.is_none() => group.flp = Some(path),
        matcher::FileRole::Als if group.als.is_none() => group.als = Some(path),
        _ => group.others.push(path),
    }
}

fn titleize(core_name: &str) -> String {
    core_name.split(' ').filter(|s| !s.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>().join(" ")
}

struct MaterializedBeat {
    folder: PathBuf,
    mp3: Option<PathBuf>,
    wav: Option<PathBuf>,
    loop_path: Option<PathBuf>,
    stems: Option<PathBuf>,
    flp: Option<PathBuf>,
    als: Option<PathBuf>,
}

/// Copies every file referenced by a ConfirmedGroup into a fresh folder inside
/// the vault, renaming things to the canonical scheme (including turning any
/// generic "stems"/"stem" folder into "{beat_name}_stems" so nothing collides
/// once everything lives inside Beat Galer's own library).
fn materialize_confirmed_group(
    group: &matcher::ConfirmedGroup,
    _beat_name: &str,
    _library_root: &Path,
    source_folder: Option<&Path>,
) -> Result<MaterializedBeat, String> {
    let primary = group.mp3.as_ref().or(group.wav.as_ref())
        .ok_or_else(|| "No playable audio source found.".to_string())?;
    let folder = source_folder
        .map(Path::to_path_buf)
        .or_else(|| primary.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));

    Ok(MaterializedBeat {
        folder,
        mp3: group.mp3.clone(),
        wav: group.wav.clone(),
        loop_path: group.loop_file.clone(),
        stems: group.stems.clone(),
        flp: group.flp.clone(),
        als: group.als.clone(),
    })
}

fn build_beat_from_confirmed(id: String, name: String, m: &MaterializedBeat, others: Vec<PathBuf>) -> BeatMeta {
    let metadata_started = std::time::Instant::now();
    let (bpm, key, tags, rating, image_base64) = if let Some(p) = m.mp3.as_ref().or(m.wav.as_ref()) {
        let file_size = std::fs::metadata(p).map(|meta| meta.len()).unwrap_or(0);
        eprintln!("[review-diag] METADATA_START beat={} bytes={} path={}", name, file_size, p.display());
        let result = read_id3(p);
        eprintln!(
            "[review-diag] METADATA_END beat={} elapsed_ms={} artwork_b64_bytes={} tags={} path={}",
            name, metadata_started.elapsed().as_millis(), result.4.as_ref().map(|value| value.len()).unwrap_or(0), result.2.len(), p.display()
        );
        result
    } else { (String::new(), String::new(), vec![], 0, None) };
    let (color, color2) = gradient_for(&name);
    let playback_path = m.mp3.clone()
        .map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    // Review Beat is a UI preview, not a completeness scan.
    // Never recursively walk the source folder before showing Review: a single
    // MP3 dropped from a large folder used to make BeatGaler scan that entire
    // parent tree just to look for "Samples", causing the ~2s delay.
    let samples_path: Option<String> = None;
    let has_samples = false;

    BeatMeta {
        id, name,
        folder_path: m.folder.to_string_lossy().to_string(),
        mp3_path: m.mp3.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        wav_path: m.wav.as_ref().map(|p| p.to_string_lossy().to_string()),
        playback_path,
        bpm, key, tags, rating, image_base64,
        needs_resolution: false,
        has_wav: m.wav.is_some(),
        has_stems: m.stems.is_some(),
        has_samples,
        samples_path,
        has_flp: m.flp.is_some(),
        has_als: m.als.is_some(),
        stems_path: m.stems.as_ref().map(|p| p.to_string_lossy().to_string()),
        flp_path: m.flp.as_ref().map(|p| p.to_string_lossy().to_string()),
        als_path: m.als.as_ref().map(|p| p.to_string_lossy().to_string()),
        other_files: paths_to_strings(&others),
        color, color2,
        has_loop: m.loop_path.is_some(),
        loop_path: m.loop_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        cloud_status: None,
        telegram_file_id: None,
        telegram_message_id: None,
        offline_available: false,
    }
}

fn build_review_candidate_from_group(
    core_name: &str,
    group: &matcher::ConfirmedGroup,
    source_folder: Option<&Path>,
    settings: &SettingsState,
    display_name_override: Option<&str>,
) -> Result<BeatMeta, String> {
    let display_name = display_name_override
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| titleize(core_name));
    if group.mp3.is_none() && group.wav.is_none() {
        return Err(format!("No playable audio source found for '{}'.", display_name));
    }
    let materialized = materialize_confirmed_group(
        group,
        &display_name,
        &settings.beats_dir(),
        source_folder,
    )?;
    let id = format!("import-{}", random_urlsafe(18));
    Ok(build_beat_from_confirmed(id, display_name, &materialized, group.others.clone()))
}

/// Prepare exactly ONE normal Review beat. Discovery may have already found the
/// rest of the batch, but metadata/artwork work is intentionally serialized so
/// Beat 2..N can never delay Beat 1.
#[tauri::command]
pub fn prepare_next_import_review_beat(
    batch_id: String,
    settings: tauri::State<SettingsState>,
    batches: tauri::State<ImportBatchState>,
) -> Result<ImportReviewStep, String> {
    let started = std::time::Instant::now();
    eprintln!("[review-diag] PREPARE_COMMAND_START batch={}", batch_id);
    let lock_started = std::time::Instant::now();
    let (cursor, core_name, group, source_folder, display_name, discovery_complete_before) = {
        let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
        eprintln!("[review-diag] PREPARE_LOCK_ACQUIRED wait_ms={} batch={}", lock_started.elapsed().as_millis(), batch_id);
        let batch = lock.get_mut(&batch_id)
            .ok_or_else(|| "This import batch expired. Drop the files again.".to_string())?;

        // Streaming batches do NOT know N up front. Advance the shallow-first
        // filesystem cursor only until one normal beat is found (conflicts are
        // recorded and skipped for later), then stop immediately.
        while batch.review_cursor >= batch.review_order.len() && !batch.discovery_complete {
            let found = discover_next_stream_group(batch)?;
            if found.is_some() { break; }
        }

        if batch.review_cursor >= batch.review_order.len() {
            let total = batch.review_order.len();
            return Ok(ImportReviewStep {
                beat: None,
                prepared_count: batch.review_cursor.min(total),
                total_normal: if batch.discovery_complete { Some(total) } else { None },
                remaining_normal: if batch.discovery_complete { Some(total.saturating_sub(batch.review_cursor)) } else { None },
                discovery_complete: batch.discovery_complete,
            });
        }

        let cursor = batch.review_cursor;
        let core = batch.review_order[cursor].clone();
        let group = batch.groups.get(&core)
            .cloned()
            .ok_or_else(|| format!("Import candidate '{}' disappeared.", core))?;
        let source = batch.source_folders.get(&core).cloned();
        let display = batch.display_names.get(&core).cloned();
        (cursor, core, group, source, display, batch.discovery_complete)
    };

    let build_started = std::time::Instant::now();
    eprintln!("[review-diag] BUILD_REVIEW_START core={} total_elapsed_ms={}", core_name, started.elapsed().as_millis());
    let beat = build_review_candidate_from_group(
        &core_name,
        &group,
        source_folder.as_deref(),
        &*settings,
        display_name.as_deref(),
    )?;
    eprintln!("[review-diag] BUILD_REVIEW_END beat={} build_ms={} total_elapsed_ms={}", beat.name, build_started.elapsed().as_millis(), started.elapsed().as_millis());

    let (prepared_count, total_normal, remaining_normal, discovery_complete) = {
        let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
        let batch = lock.get_mut(&batch_id)
            .ok_or_else(|| "This import batch expired while preparing Review.".to_string())?;
        // Calls are serialized by the frontend. Guard against a stale duplicate
        // response so a second candidate can never be skipped accidentally.
        if batch.review_cursor == cursor {
            batch.review_cursor += 1;
        }
        batch.prepared_cores.insert(core_name.clone());
        let prepared = batch.review_cursor.min(batch.review_order.len());
        let complete = batch.discovery_complete;
        let total = if complete { Some(batch.review_order.len()) } else { None };
        let remaining = if complete { Some(batch.review_order.len().saturating_sub(prepared)) } else { None };
        (prepared, total, remaining, complete)
    };

    eprintln!(
        "[review-diag] PREPARE_COMMAND_END beat={} elapsed_ms={} prepared={} discovery_complete_before={} discovery_complete_after={}",
        beat.name, started.elapsed().as_millis(), prepared_count, discovery_complete_before, discovery_complete
    );
    Ok(ImportReviewStep {
        beat: Some(beat),
        prepared_count,
        total_normal,
        remaining_normal,
        discovery_complete,
    })
}

/// Resolve one audio ambiguity after all normal beats. Unselected candidate
/// audio is deliberately ignored, matching the V1 rule chosen for Bulk Import.
#[tauri::command]
pub fn resolve_import_audio_conflict(
    batch_id: String,
    core_name: String,
    selected_path: String,
    settings: tauri::State<SettingsState>,
    batches: tauri::State<ImportBatchState>,
) -> Result<BeatMeta, String> {
    let selected = PathBuf::from(&selected_path);
    let (conflict, mut group, source_folder) = {
        let lock = batches.0.lock().map_err(|e| e.to_string())?;
        let batch = lock.get(&batch_id)
            .ok_or_else(|| "This import batch expired. Drop the files again.".to_string())?;
        let conflict = batch.audio_conflicts.iter()
            .find(|item| item.core_name == core_name)
            .cloned()
            .ok_or_else(|| "That audio conflict is no longer pending.".to_string())?;
        if !conflict.candidates.iter().any(|path| PathBuf::from(path) == selected) {
            return Err("Choose one of the audio files shown by BeatGaler.".to_string());
        }
        let group = batch.groups.get(&core_name)
            .cloned()
            .ok_or_else(|| "The conflicted beat could not be found.".to_string())?;
        let source = batch.source_folders.get(&core_name).cloned();
        (conflict, group, source)
    };

    if !selected.exists() || !selected.is_file() {
        return Err(format!("Selected audio no longer exists: {}", selected.display()));
    }

    match conflict.kind.as_str() {
        "master_mp3" => group.mp3 = Some(selected.clone()),
        "source_wav" | "hq_wav" => group.wav = Some(selected.clone()),
        "main_audio" => {
            let selected_ext = selected.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
            if selected_ext == "mp3" { group.mp3 = Some(selected.clone()); }
            else if selected_ext == "wav" { group.wav = Some(selected.clone()); }
            else { return Err("The selected main audio must be MP3 or WAV.".to_string()); }

            // Once the user chooses the main audio, cheaply attach same-core HQ
            // WAV/project files from that folder. No recursive project inspection
            // or audio conversion happens here.
            if let Some(folder) = source_folder.as_deref() {
                let stem = selected.file_stem().and_then(|v| v.to_str()).unwrap_or("");
                let clean = clean_name_from_filename(stem);
                let (selected_core, _) = matcher::normalize_core_name(&clean);
                if let Ok(entries) = std::fs::read_dir(folder) {
                    let direct_files = entries
                        .flatten()
                        .map(|entry| entry.path())
                        .filter(|path| path.is_file())
                        .collect::<Vec<_>>();
                    for path in &direct_files {
                        if !path.is_file() || path.as_path() == selected.as_path() { continue; }
                        let other_stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
                        let other_clean = clean_name_from_filename(other_stem);
                        let (other_core, _) = matcher::normalize_core_name(&other_clean);
                        if other_core != selected_core { continue; }
                        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
                        match ext.as_str() {
                            "wav" if group.wav.is_none() => group.wav = Some(path.clone()),
                            _ => {}
                        }
                    }
                    attach_root_project_files(&mut group, &direct_files, &selected_core);
                }
            }
        }
        _ => return Err("Unknown import audio conflict type.".to_string()),
    }
    let candidate_set: std::collections::HashSet<PathBuf> = conflict.candidates.iter().map(PathBuf::from).collect();
    group.others.retain(|p| !candidate_set.contains(p));

    let beat = build_review_candidate_from_group(
        &core_name,
        &group,
        source_folder.as_deref(),
        &*settings,
        Some(&conflict.display_name),
    )?;

    let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
    if let Some(batch) = lock.get_mut(&batch_id) {
        batch.groups.insert(core_name.clone(), group);
        batch.prepared_cores.insert(core_name.clone());
        batch.audio_conflicts.retain(|item| item.core_name != core_name);
    }
    Ok(beat)
}

#[tauri::command]
pub fn discard_import_review_batch(
    batch_id: String,
    batches: tauri::State<ImportBatchState>,
) -> Result<(), String> {
    let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
    lock.remove(&batch_id);
    Ok(())
}

/// Applies the user's decisions for a previously-previewed batch and returns
/// local Review candidates. This phase never consults Telegram, never resolves
/// cloud duplicate names, and never inserts the beat into the durable library
/// DB. Review -> Save is the commit boundary. File-assignment decisions are
/// still recorded so re-scans do not ask about the same ambiguous file twice.
#[tauri::command]
pub fn resolve_import_decisions(
    batch_id: String,
    decisions: Vec<ImportDecisionInput>,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
    batches: tauri::State<ImportBatchState>,
) -> Result<Vec<BeatMeta>, String> {
    let review_started = std::time::Instant::now();
    let mut batch = {
        let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
        lock.remove(&batch_id).ok_or_else(|| "This import batch expired or was already resolved. Try importing again.".to_string())?
    };

    // Preview/Review phase is deliberately local-only. Do NOT consult Telegram
    // and do NOT resolve cloud name conflicts here. The user's edited name is
    // authoritative input until Save; Telegram validation happens in
    // upload_beat_to_telegram(), immediately after Save.
    //
    // IMPORTANT: the normal import path has ZERO decisions. It must not wait
    // for SQLite at all. Background sync can legitimately hold the DB lock for
    // a moment; waiting for that lock here was the main source of the visible
    // ~1-2 second delay before Review Beat appeared.
    if !decisions.is_empty() {
        let conn = state.0.lock().map_err(|e| e.to_string())?;

        for d in &decisions {
            let hash = format!("{:x}", Sha256::digest(d.path.as_bytes()));
            conn.execute(
                "INSERT OR REPLACE INTO import_decisions (path_hash, file_path, decision, role, decided_at)
                 VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))",
                params![hash, d.path, d.action, d.role],
            ).map_err(|e| e.to_string())?;
        }
    }

    for d in &decisions {
        let hash = format!("{:x}", Sha256::digest(d.path.as_bytes()));

        match d.action.as_str() {
            "ignore" => continue,
            "independent" => {
                let src = PathBuf::from(&d.path);
                let raw_stem = src.file_stem().unwrap_or_default().to_string_lossy().to_string();
                let clean = clean_name_from_filename(&raw_stem);
                let (core_name, _) = matcher::normalize_core_name(&clean);
                let key = if core_name.is_empty() { format!("indep_{}", hash) } else { core_name.clone() };
                let group = batch.groups.entry(key.clone())
                    .or_insert_with(|| matcher::ConfirmedGroup { core_name: key, ..Default::default() });
                assign_to_group(group, src, d.role.as_deref());
            }
            "assign" => {
                let target = d.target_beat_name.clone().unwrap_or_default();
                let (target_core, _) = matcher::normalize_core_name(&target);
                let group = batch.groups.entry(target_core.clone())
                    .or_insert_with(|| matcher::ConfirmedGroup { core_name: target_core, ..Default::default() });
                assign_to_group(group, PathBuf::from(&d.path), d.role.as_deref());
            }
            _ => {}
        }
    }

    let prepared_cores = batch.prepared_cores.clone();
    let source_folders = batch.source_folders;
    let mut imported = Vec::new();
    for (core_name, group) in batch.groups {
        // Staged Review may already have emitted this beat one-at-a-time. Never
        // recreate it when the deferred fuzzy-decision modal is resolved later.
        if prepared_cores.contains(&core_name) { continue; }
        if group.mp3.is_none() && group.wav.is_none() {
            continue; // nothing playable — don't create an empty beat
        }
        let display_name = titleize(&core_name);
        let source_folder = source_folders.get(&core_name).map(PathBuf::as_path);

        // Review candidate only: preserve the original local files/folder. No
        // duplicate-folder materialization is allowed before the user presses Save.
        let materialized = materialize_confirmed_group(
            &group,
            &display_name,
            &settings.beats_dir(),
            source_folder,
        )?;
        // A Review candidate is a NEW library item, not an edit of whatever
        // happens to live at the same folder/name. Using make_id(name, folder)
        // caused re-dropping the same folder to reuse the existing beat id and
        // bypass duplicate-name guards that intentionally ignore self-updates.
        let id = format!("import-{}", random_urlsafe(18));
        let beat = build_beat_from_confirmed(id, display_name, &materialized, group.others.clone());

        // Do not insert the candidate into the beat library DB before Review -> Save.
        // If the user skips/cancels, no durable beat record is left behind.
        imported.push(beat);
    }

    eprintln!(
        "[review-perf] resolve + ID3/artwork: {} ms ({} beat(s))",
        review_started.elapsed().as_millis(),
        imported.len()
    );
    Ok(imported)
}


// ─────────────────────────────────────────────────────────────
// Global tag rename with crash-safe journal
// ─────────────────────────────────────────────────────────────
#[derive(Debug, Serialize, Deserialize, Clone)]
struct TagRenameJournalEntry {
    path: String,
    original_genre: Option<String>,
    completed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct TagRenameJournal {
    old_tag: String,
    new_tag: String,
    entries: Vec<TagRenameJournalEntry>,
}

#[derive(Debug, Serialize)]
pub struct RenameTagResult {
    pub beats_updated: usize,
    pub files_updated: usize,
}

#[derive(Debug, Serialize, Clone)]
struct TagRenameProgress {
    job_id: String,
    completed: usize,
    total: usize,
}

fn tag_rename_journal_path(data_dir: &Path) -> PathBuf {
    data_dir.join(".tag-rename-journal").join("active.json")
}

fn save_tag_rename_journal(data_dir: &Path, journal: &TagRenameJournal) -> Result<(), String> {
    let path = tag_rename_journal_path(data_dir);
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(journal).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn set_genre_only(path: &Path, genre: Option<&str>) -> Result<(), String> {
    let mut tag = Tag::read_from_path(path).unwrap_or_default();
    tag.remove("TCON");
    if let Some(value) = genre {
        if !value.trim().is_empty() { tag.set_genre(value.to_string()); }
    }
    tag.write_to_path(path, Version::Id3v23).map_err(|e| format!("ID3 write failed for {}: {}", path.display(), e))
}

pub fn rollback_incomplete_tag_rename(data_dir: &Path) -> Result<usize, String> {
    let path = tag_rename_journal_path(data_dir);
    if !path.exists() { return Ok(0); }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let journal: TagRenameJournal = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let mut restored = 0usize;
    for entry in journal.entries.iter().filter(|e| e.completed) {
        let p = PathBuf::from(&entry.path);
        if p.exists() {
            set_genre_only(&p, entry.original_genre.as_deref())?;
            restored += 1;
        }
    }
    let _ = std::fs::remove_file(&path);
    if let Some(parent) = path.parent() { let _ = std::fs::remove_dir(parent); }
    Ok(restored)
}

#[tauri::command]
pub fn rename_tag_everywhere(
    old_tag: String,
    new_tag: String,
    job_id: String,
    app: tauri::AppHandle,
    db: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<RenameTagResult, String> {
    let old_norm = old_tag.trim().to_lowercase();
    let requested_new = new_tag.trim().to_lowercase();
    if old_norm.is_empty() || requested_new.is_empty() { return Err("Tag names cannot be empty".into()); }
    let validated = validate_metadata_tags(&[requested_new])?;
    let new_norm = validated.into_iter().next().ok_or("Tag name cannot be empty")?;
    if old_norm == new_norm { return Err("The new tag is the same as the old tag".into()); }
    if tag_rename_journal_path(&settings.data_dir).exists() {
        return Err("An unfinished tag rename journal already exists. Restart Beat Galer to recover it.".into());
    }

    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let rows = db_load_all(&conn).map_err(|e| e.to_string())?;
    let mut affected: Vec<BeatMeta> = Vec::new();
    let mut entries: Vec<TagRenameJournalEntry> = Vec::new();

    for row in rows {
        let mut meta: BeatMeta = match row.meta_json.as_deref().and_then(|s| serde_json::from_str(s).ok()) {
            Some(m) => m,
            None => continue,
        };
        if !meta.tags.iter().any(|t| t.trim().to_lowercase() == old_norm) { continue; }
        for path in [Some(meta.mp3_path.clone()), meta.wav_path.clone()].into_iter().flatten() {
            let p = PathBuf::from(&path);
            if !p.exists() { continue; }
            let original_genre = Tag::read_from_path(&p).ok().and_then(|t| t.genre().map(|s| s.to_string()));
            entries.push(TagRenameJournalEntry { path, original_genre, completed: false });
        }
        meta.tags = meta.tags.into_iter().map(|t| if t.trim().to_lowercase() == old_norm { new_norm.clone() } else { t }).collect();
        let mut seen = std::collections::HashSet::new();
        meta.tags.retain(|t| seen.insert(t.trim().to_lowercase()));
        affected.push(meta);
    }

    let total = entries.len();
    let mut journal = TagRenameJournal { old_tag: old_norm.clone(), new_tag: new_norm.clone(), entries };
    save_tag_rename_journal(&settings.data_dir, &journal)?;
    drop(conn);

    for i in 0..journal.entries.len() {
        let original = journal.entries[i].original_genre.clone().unwrap_or_default();
        let mut tags: Vec<String> = original.split(|c: char| c == ';' || c == ',' || c == '/')
            .map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        tags = tags.into_iter().map(|t| if t.to_lowercase() == old_norm { new_norm.clone() } else { t }).collect();
        let mut seen = std::collections::HashSet::new();
        tags.retain(|t| seen.insert(t.to_lowercase()));
        let next_genre = if tags.is_empty() { None } else { Some(tags.join("; ")) };
        let result = set_genre_only(Path::new(&journal.entries[i].path), next_genre.as_deref());
        if let Err(err) = result {
            let rollback_err = rollback_incomplete_tag_rename(&settings.data_dir).err();
            let message = match rollback_err { Some(r) => format!("{}; rollback also failed: {}", err, r), None => err };
            let _ = app.emit("tag-rename:error", json!({"job_id": job_id, "error": message}));
            return Err(message);
        }
        journal.entries[i].completed = true;
        save_tag_rename_journal(&settings.data_dir, &journal)?;
        let _ = app.emit("tag-rename:progress", TagRenameProgress { job_id: job_id.clone(), completed: i + 1, total });
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for meta in &affected { db_save(&conn, meta).map_err(|e| e.to_string())?; }
    let journal_path = tag_rename_journal_path(&settings.data_dir);
    let _ = std::fs::remove_file(&journal_path);
    if let Some(parent) = journal_path.parent() { let _ = std::fs::remove_dir(parent); }
    let result = RenameTagResult { beats_updated: affected.len(), files_updated: total };
    let _ = app.emit("tag-rename:done", json!({"job_id": job_id, "beats_updated": result.beats_updated, "files_updated": result.files_updated}));
    Ok(result)
}

#[cfg(test)]
mod import_core_unit_tests {
    use super::{
        attach_root_project_files,
        build_loose_candidate_from_audio,
        discover_next_stream_group,
        discover_import_sources,
        inspect_beat_update_folder,
        scan_folder_structured,
        ImportDiscoveryStream,
        ImportDiscoveryTarget,
        PendingImportBatch,
    };
    use crate::matcher::ConfirmedGroup;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "beatgaler-import-core-{}-{}-{}",
                label,
                std::process::id(),
                nonce
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn dir(&self, relative: &str) -> PathBuf {
            let path = self.root.join(relative);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, b"").unwrap();
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn normalized(paths: Vec<PathBuf>, root: &Path) -> Vec<String> {
        paths
            .into_iter()
            .map(|path| {
                path.strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn standalone_mp3_is_exactly_one_slot_and_never_absorbs_neighbors() {
        let tree = TempTree::new("loose-mp3");
        let mp3 = tree.file("Loose Beat.mp3");
        let neighbor_wav = tree.file("Loose Beat.wav");
        let _neighbor_flp = tree.file("Loose Beat.flp");
        let _sample = tree.file("Samples/kick.wav");

        let candidate = build_loose_candidate_from_audio(&mp3).unwrap();
        assert_eq!(candidate.mp3.as_deref(), Some(mp3.as_path()));
        assert!(candidate.wav.is_none(), "a loose MP3 must not auto-attach a neighboring WAV");
        assert_ne!(candidate.wav.as_deref(), Some(neighbor_wav.as_path()));
        assert_eq!(candidate.source_anchor, mp3);
    }

    #[test]
    fn standalone_wav_is_hq_only_until_master_generation() {
        let tree = TempTree::new("loose-wav");
        let wav = tree.file("WAV Only [140 Cm].wav");
        let _neighbor_mp3 = tree.file("WAV Only [140 Cm].mp3");

        let candidate = build_loose_candidate_from_audio(&wav).unwrap();
        assert!(candidate.mp3.is_none(), "WAV-only discovery must not steal a neighboring MP3");
        assert_eq!(candidate.wav.as_deref(), Some(wav.as_path()));
        assert_eq!(candidate.bpm, "140");
        assert_eq!(candidate.key, "cm");
    }

    #[test]
    fn structured_folder_pairs_matching_master_and_hq_without_promoting_other_audio() {
        let tree = TempTree::new("structured-pair");
        let beat = tree.dir("Purple Beat");
        let master = tree.file("Purple Beat/Purple Beat.mp3");
        let hq = tree.file("Purple Beat/Purple Beat.wav");
        let other = tree.file("Purple Beat/reference.wav");

        let files = scan_folder_structured(&beat);
        assert_eq!(files.mp3s, vec![master]);
        assert_eq!(files.wavs, vec![hq]);
        assert_eq!(files.others, vec![other]);
    }

    #[test]
    fn ambiguous_folder_keeps_all_main_audio_candidates_for_conflict_resolution() {
        let tree = TempTree::new("ambiguous");
        let beat = tree.dir("Inbox");
        let a = tree.file("Inbox/Beat A.mp3");
        let b = tree.file("Inbox/Beat B.mp3");
        let c = tree.file("Inbox/Beat C.wav");

        let files = scan_folder_structured(&beat);
        assert_eq!(files.mp3s, vec![a, b]);
        assert_eq!(files.wavs, vec![c]);
    }

    #[test]
    fn recursive_discovery_never_turns_asset_directories_into_beats() {
        let tree = TempTree::new("aux-skip");
        let beat = tree.dir("Beat A");
        let _master = tree.file("Beat A/Beat A.mp3");
        let _samples = tree.file("Samples/sample-one.wav");
        let _stems = tree.file("Stems/stem-one.wav");
        let _backup = tree.file("Backup/old-version.mp3");
        let _audio = tree.file("Audio/render.wav");

        let found = normalized(discover_import_sources(&tree.root), &tree.root);
        assert_eq!(found, vec!["Beat A"], "asset directories must never produce independent Review beats");
        assert!(beat.is_dir());
    }

    #[test]
    fn multiple_beat_folders_are_discovered_independently_and_deterministically() {
        let tree = TempTree::new("multi-folder");
        tree.file("Zulu/Zulu.mp3");
        tree.file("Alpha/Alpha.mp3");
        tree.file("Middle/Middle.mp3");

        let first = normalized(discover_import_sources(&tree.root), &tree.root);
        let second = normalized(discover_import_sources(&tree.root), &tree.root);
        assert_eq!(first, vec!["Alpha", "Middle", "Zulu"]);
        assert_eq!(first, second, "Review discovery order must be stable across identical scans");
    }

    #[test]
    fn loose_audio_groups_choose_one_anchor_per_clean_name() {
        let tree = TempTree::new("loose-grouping");
        tree.file("Loose A.mp3");
        tree.file("Loose A.wav");
        tree.file("Loose B.wav");

        let found = normalized(discover_import_sources(&tree.root), &tree.root);
        assert_eq!(found.len(), 2, "same-name MP3+WAV must discover as one logical beat anchor");
        assert!(found.iter().any(|value| value == "Loose A.mp3"));
        assert!(found.iter().any(|value| value == "Loose B.wav"));
    }

    #[test]
    fn unique_root_ableton_project_attaches_even_when_its_name_differs_from_render() {
        let tree = TempTree::new("ableton-project-name");
        let wav = tree.file("trap-house Project/trap-house F#m.wav");
        let als = tree.file("trap-house Project/trap-house Project.als");
        let direct_files = vec![wav, als.clone()];
        let mut group = ConfirmedGroup::default();

        attach_root_project_files(&mut group, &direct_files, "trap-house f#m");

        assert_eq!(group.als.as_deref(), Some(als.as_path()));
        assert!(group.flp.is_none());
    }

    #[test]
    fn streaming_folder_import_keeps_differently_named_ableton_project() {
        let tree = TempTree::new("ableton-streaming-import");
        let folder = tree.dir("trap-house Project");
        tree.file("trap-house Project/trap-house F#m.wav");
        let als = tree.file("trap-house Project/trap-house Project.als");
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(ImportDiscoveryTarget { path: folder });
        let mut batch = PendingImportBatch {
            groups: std::collections::HashMap::new(),
            source_folders: std::collections::HashMap::new(),
            review_order: Vec::new(),
            review_cursor: 0,
            prepared_cores: std::collections::HashSet::new(),
            display_names: std::collections::HashMap::new(),
            discovery_stream: Some(ImportDiscoveryStream { queue }),
            discovery_complete: false,
            audio_conflicts: Vec::new(),
        };

        let key = discover_next_stream_group(&mut batch).unwrap().unwrap();
        let group = batch.groups.get(&key).expect("streaming group");

        assert_eq!(group.als.as_deref(), Some(als.as_path()));
        assert!(group.wav.is_some());
        assert!(batch.audio_conflicts.is_empty());
    }

    #[test]
    fn multiple_nonmatching_root_projects_are_never_guessed() {
        let tree = TempTree::new("ambiguous-project-name");
        let first = tree.file("Beat/First Project.als");
        let second = tree.file("Beat/Second Project.als");
        let mut group = ConfirmedGroup::default();

        attach_root_project_files(&mut group, &[first, second], "render name");

        assert!(group.als.is_none());
        assert!(group.flp.is_none());
    }

    #[test]
    fn beat_update_folder_recognizes_ableton_as_a_project_file() {
        let tree = TempTree::new("ableton-update-preview");
        let folder = tree.dir("Beat");
        tree.file("Beat/Beat.wav");
        tree.file("Beat/Beat Project.als");

        let preview = inspect_beat_update_folder(folder.to_string_lossy().to_string()).unwrap();

        assert!(preview.has_project_file);
    }
}

#[cfg(test)]
mod project_zip_unit_tests {
    use super::{
        extract_project_zip_to_directory,
        filtered_project_zip_for_upload,
        find_openable_project_in_directory,
        inspect_project_zip_entries,
        is_forbidden_project_component,
        is_recognized_project_extension,
        mutate_project_zip,
        project_zip_entry_names,
        project_zip_is_openable,
        validate_project_zip_entry_names,
        write_project_directory_zip,
    };
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempProjectTree { root: PathBuf }
    impl TempProjectTree {
        fn new(label: &str) -> Self {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("beatgaler-project-test-{}-{}-{}", label, std::process::id(), stamp));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn path(&self, rel: &str) -> PathBuf { self.root.join(rel) }
        fn file(&self, rel: &str, bytes: &[u8]) -> PathBuf {
            let path = self.path(rel);
            if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).unwrap(); }
            std::fs::write(&path, bytes).unwrap();
            path
        }
        fn dir(&self, rel: &str) -> PathBuf {
            let path = self.path(rel);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
    }
    impl Drop for TempProjectTree {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    fn entries(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn create_zip(path: &Path, values: &[(&str, &[u8])]) {
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).unwrap(); }
        let file = std::fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in values {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn recognizes_all_supported_project_extensions_case_insensitively() {
        for ext in ["flp", ".FLP", "als", ".ALS", "logicx", ".LOGICX", "ptx", ".PTX", "ptf", ".PTF"] {
            assert!(is_recognized_project_extension(ext), "expected supported extension: {ext}");
        }
        for ext in ["zip", "wav", "mp3", "txt", "exe", ""] {
            assert!(!is_recognized_project_extension(ext), "unexpected supported extension: {ext}");
        }
    }

    #[test]
    fn backup_filter_matches_only_backup_folder_names() {
        for name in ["Backup", "backup", " BACKUP ", "Backups", "BACKUPS"] {
            assert!(is_forbidden_project_component(name), "expected forbidden component: {name}");
        }
        for name in ["Backup-old", "My Backups", "backup2", "Audio", "Samples"] {
            assert!(!is_forbidden_project_component(name), "should not over-filter component: {name}");
        }
    }

    #[test]
    fn project_files_inside_backup_do_not_make_zip_valid() {
        let input = entries(&[
            "Backup/old.flp",
            "Backups/older.als",
            "Audio/kick.wav",
        ]);
        let (has_backups, project_count, has_flp, has_als) = inspect_project_zip_entries(&input);
        assert!(has_backups);
        assert_eq!(project_count, 0);
        assert!(!has_flp);
        assert!(!has_als);
    }

    #[test]
    fn project_files_outside_backup_are_counted() {
        let input = entries(&[
            "Beat/main.flp",
            "Beat/alt.als",
            "Beat/Audio/kick.wav",
            "Beat/Backup/old.flp",
        ]);
        let (has_backups, project_count, has_flp, has_als) = inspect_project_zip_entries(&input);
        assert!(has_backups);
        assert_eq!(project_count, 2);
        assert!(has_flp);
        assert!(has_als);
    }

    #[test]
    fn nested_logicx_bundle_is_recognized_once_per_matching_entry() {
        let input = entries(&[
            "Song.logicx/",
            "Song.logicx/Alternatives/000/ProjectData",
            "Song.logicx/Media/Audio Files/kick.wav",
        ]);
        let (_, project_count, _, _) = inspect_project_zip_entries(&input);
        assert!(project_count >= 1, "a .logicx bundle must be recognized as containing a project");
    }

    #[test]
    fn safe_relative_zip_paths_are_allowed() {
        let input = entries(&[
            "Beat/main.flp",
            "Beat/Audio/kick.wav",
            "Beat/Samples/snare.wav",
        ]);
        assert!(validate_project_zip_entry_names(&input).is_ok());
    }

    #[test]
    fn zip_slip_parent_paths_are_rejected() {
        for unsafe_path in ["../evil.flp", "Beat/../../evil.flp", "Beat/../evil.flp"] {
            let result = validate_project_zip_entry_names(&entries(&[unsafe_path]));
            assert!(result.is_err(), "expected parent traversal to fail: {unsafe_path}");
        }
    }

    #[test]
    fn absolute_and_drive_zip_paths_are_rejected() {
        for unsafe_path in ["/tmp/evil.flp", "C:/evil.flp", "D:\\evil.flp"] {
            let result = validate_project_zip_entry_names(&entries(&[unsafe_path]));
            assert!(result.is_err(), "expected absolute path to fail: {unsafe_path}");
        }
    }

    #[test]
    fn nul_bytes_in_zip_paths_are_rejected() {
        let input = vec!["Beat/main\0.flp".to_string()];
        assert!(validate_project_zip_entry_names(&input).is_err());
    }

    #[test]
    fn empty_zip_entry_list_is_rejected() {
        assert!(validate_project_zip_entry_names(&[]).is_err());
    }

    #[test]
    fn rust_project_zip_mutation_replaces_primary_project_without_touching_assets() {
        let tree = TempProjectTree::new("replace-project");
        let archive = tree.path("Beat.zip");
        create_zip(&archive, &[
            ("Old.flp", b"old-project"),
            ("Samples/kick.wav", b"kick"),
            ("Audio/render.wav", b"render"),
        ]);
        let new_project = tree.file("New.flp", b"new-project");

        mutate_project_zip(&archive, &new_project, "projectfile").unwrap();
        let names = project_zip_entry_names(&archive).unwrap();
        assert!(names.iter().any(|name| name == "New.flp"));
        assert!(!names.iter().any(|name| name == "Old.flp"));
        assert!(names.iter().any(|name| name == "Samples/kick.wav"));
        assert!(names.iter().any(|name| name == "Audio/render.wav"));
    }

    #[test]
    fn rust_project_zip_mutation_replaces_samples_tree_only() {
        let tree = TempProjectTree::new("replace-samples");
        let archive = tree.path("Beat.zip");
        create_zip(&archive, &[
            ("Beat.als", b"project"),
            ("Samples/old.wav", b"old"),
            ("Audio/render.wav", b"render"),
        ]);
        let samples = tree.dir("FreshSamples");
        tree.file("FreshSamples/new.wav", b"new");
        tree.file("FreshSamples/nested/snare.wav", b"snare");
        tree.file("FreshSamples/Backup/should-not-upload.wav", b"backup");

        mutate_project_zip(&archive, &samples, "samples").unwrap();
        let names = project_zip_entry_names(&archive).unwrap();
        assert!(names.iter().any(|name| name == "Beat.als"));
        assert!(names.iter().any(|name| name == "Audio/render.wav"));
        assert!(names.iter().any(|name| name == "Samples/new.wav"));
        assert!(names.iter().any(|name| name == "Samples/nested/snare.wav"));
        assert!(!names.iter().any(|name| name == "Samples/old.wav"));
        assert!(!names.iter().any(|name| name.to_ascii_lowercase().contains("backup")));
    }

    #[test]
    fn rust_project_zip_mutation_supports_logicx_package_directories() {
        let tree = TempProjectTree::new("logicx");
        let archive = tree.path("Logic Beat.zip");
        let logicx = tree.dir("Logic Beat.logicx");
        tree.file("Logic Beat.logicx/ProjectData", b"logic-project-data");
        tree.file("Logic Beat.logicx/Media/Audio Files/kick.wav", b"kick");
        tree.file("Logic Beat.logicx/Backup/old-version", b"old");

        mutate_project_zip(&archive, &logicx, "projectfile").unwrap();
        let names = project_zip_entry_names(&archive).unwrap();
        assert!(names.iter().any(|name| name == "Logic Beat.logicx/ProjectData"));
        assert!(names.iter().any(|name| name == "Logic Beat.logicx/Media/Audio Files/kick.wav"));
        assert!(!names.iter().any(|name| name.to_ascii_lowercase().contains("/backup/")));
        let (_, project_count, _, _) = inspect_project_zip_entries(&names);
        assert!(project_count > 0);
    }



    #[test]
    fn logic_and_pro_tools_projects_are_marked_openable_without_flp_or_als() {
        let tree = TempProjectTree::new("openable-formats");
        for (name, payload) in [("Logic.logicx/ProjectData", b"logic".as_slice()), ("ProTools.ptx", b"ptx".as_slice())] {
            let archive = tree.path(&format!("{}.zip", name.replace('/', "_")));
            create_zip(&archive, &[(name, payload)]);
            assert!(project_zip_is_openable(&archive), "expected openable project: {name}");
        }
    }

    #[test]
    fn project_open_edit_repack_cycle_is_cross_platform_for_logicx_and_special_paths() {
        let tree = TempProjectTree::new("open-edit-repack");
        let source = tree.dir("Canción #1 & 50% PROJECT");
        tree.file("Canción #1 & 50% PROJECT/Canción.logicx/ProjectData", b"version-one");
        tree.file("Canción #1 & 50% PROJECT/Canción.logicx/Media/Audio Files/kick #1.wav", b"kick");
        tree.file("Canción #1 & 50% PROJECT/Backup/old.logicx/ProjectData", b"old");
        let archive = tree.path("Output #1 & 50%.zip");

        write_project_directory_zip(&source, &archive).unwrap();
        let first_names = project_zip_entry_names(&archive).unwrap();
        assert!(first_names.iter().any(|name| name == "Canción.logicx/ProjectData"));
        assert!(first_names.iter().any(|name| name.contains("kick #1.wav")));
        assert!(!first_names.iter().any(|name| name.to_ascii_lowercase().contains("backup")));

        let edit = tree.path("Edit Folder # & %");
        extract_project_zip_to_directory(&archive, &edit).unwrap();
        let project = find_openable_project_in_directory(&edit, "Canción").expect("Logic package should be openable");
        assert!(project.is_dir());
        assert_eq!(project.extension().and_then(|value| value.to_str()), Some("logicx"));

        std::fs::write(project.join("ProjectData"), b"version-two").unwrap();
        write_project_directory_zip(&edit, &archive).unwrap();

        let verify = tree.path("Verify");
        extract_project_zip_to_directory(&archive, &verify).unwrap();
        assert_eq!(std::fs::read(verify.join("Canción.logicx/ProjectData")).unwrap(), b"version-two");
    }

    #[test]
    fn upload_filter_removes_backup_tree_and_keeps_primary_project() {
        let tree = TempProjectTree::new("filter-backup");
        let archive = tree.path("Beat.zip");
        create_zip(&archive, &[
            ("Beat.flp", b"project"),
            ("Samples/kick.wav", b"kick"),
            ("Backup/old.flp", b"old"),
            ("Backups/older.flp", b"older"),
        ]);

        let filtered = filtered_project_zip_for_upload(&archive).unwrap().expect("backup tree should require a filtered archive");
        let names = project_zip_entry_names(&filtered).unwrap();
        assert!(names.iter().any(|name| name == "Beat.flp"));
        assert!(names.iter().any(|name| name == "Samples/kick.wav"));
        assert!(!names.iter().any(|name| name.to_ascii_lowercase().contains("backup")));
        if let Some(parent) = filtered.parent() { let _ = std::fs::remove_dir_all(parent); }
    }
}

#[cfg(test)]
mod index_and_cache_unit_tests {
    use super::{
        apply_permanent_delete_to_manifest,
        apply_restore_from_trash_to_manifest,
        enforce_playback_cache_limit_in_dir,
        playback_cache_access_path,
        select_playback_cache_evictions,
        PlaybackCacheCandidate,
    };
    use serde_json::json;
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn wanted(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    #[test]
    fn trash_restore_moves_identity_back_to_active_without_duplicate() {
        let mut manifest = json!({
            "beats":[{"id":"keep"}],
            "trash":[{"trash_id":"t-a","beat":{"id":"a","name":"A","artwork":{"telegram_message_id":7}}}],
            "deleted":[]
        });
        assert!(apply_restore_from_trash_to_manifest(&mut manifest, "a").unwrap());
        let beats = manifest["beats"].as_array().unwrap();
        assert_eq!(beats.iter().filter(|row| row["id"] == "a").count(), 1);
        assert!(manifest["trash"].as_array().unwrap().is_empty());
        assert_eq!(beats.iter().find(|row| row["id"] == "a").unwrap()["artwork"]["telegram_message_id"], 7);
    }

    #[test]
    fn trash_restore_heals_interrupted_active_plus_trash_duplicate() {
        let mut manifest = json!({
            "beats":[{"id":"a","name":"already active"},{"id":"a","name":"duplicate"}],
            "trash":[{"trash_id":"t-a","beat":{"id":"a","name":"trashed"}}],
            "deleted":[]
        });
        assert!(apply_restore_from_trash_to_manifest(&mut manifest, "a").unwrap());
        let beats = manifest["beats"].as_array().unwrap();
        assert_eq!(beats.iter().filter(|row| row["id"] == "a").count(), 1);
        assert_eq!(beats[0]["name"], "already active");
        assert!(manifest["trash"].as_array().unwrap().is_empty());
    }

    #[test]
    fn trash_restore_is_idempotent_when_remote_is_already_active() {
        let mut manifest = json!({"beats":[{"id":"a"}],"trash":[],"deleted":[]});
        assert!(!apply_restore_from_trash_to_manifest(&mut manifest, "a").unwrap());
        assert_eq!(manifest["beats"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn permanent_delete_removes_live_and_trashed_beats_and_adds_tombstones() {
        let mut manifest = json!({
            "schema": "Galer T-Library",
            "version": 2,
            "beats": [
                {"id":"a","master":{"telegram_message_id":11}},
                {"id":"b","master":{"telegram_message_id":22}}
            ],
            "trash": [
                {"trash_id":"t-c","beat":{"id":"c","artwork":{"telegram_message_id":33}}}
            ],
            "deleted": []
        });
        let (removed, media) = apply_permanent_delete_to_manifest(&mut manifest, &wanted(&["a", "c"]), 100).unwrap();
        assert_eq!(removed, 2);
        assert_eq!(manifest["beats"].as_array().unwrap().len(), 1);
        assert_eq!(manifest["beats"][0]["id"], "b");
        assert!(manifest["trash"].as_array().unwrap().is_empty());
        assert!(media.contains(&11));
        assert!(media.contains(&33));
        let deleted = manifest["deleted"].as_array().unwrap();
        assert_eq!(deleted.len(), 2);
        assert_eq!(deleted[0]["beat_id"], "a");
        assert_eq!(deleted[1]["beat_id"], "c");
    }

    #[test]
    fn permanent_delete_is_idempotent_even_when_beat_row_is_already_absent() {
        let mut manifest = json!({"beats":[],"trash":[],"deleted":[]});
        let (removed, media) = apply_permanent_delete_to_manifest(&mut manifest, &wanted(&["gone"]), 200).unwrap();
        assert_eq!(removed, 0);
        assert!(media.is_empty());
        assert_eq!(manifest["deleted"][0]["beat_id"], "gone");
        assert_eq!(manifest["deleted"][0]["deleted_at"], 200);
    }

    #[test]
    fn duplicate_tombstones_collapse_to_latest_timestamp() {
        let mut manifest = json!({
            "beats":[],"trash":[],
            "deleted":[
                {"beat_id":"x","deleted_at":10},
                {"id":"x","deleted_at":30},
                {"beat_id":"y","deleted_at":20}
            ]
        });
        apply_permanent_delete_to_manifest(&mut manifest, &wanted(&["x"]), 25).unwrap();
        let deleted = manifest["deleted"].as_array().unwrap();
        assert_eq!(deleted.len(), 2);
        let x = deleted.iter().find(|row| row["beat_id"] == "x").unwrap();
        assert_eq!(x["deleted_at"], 30, "an older retry must never move a tombstone backwards");
    }

    #[test]
    fn media_collector_deduplicates_message_ids_across_slots() {
        let mut manifest = json!({
            "beats":[{
                "id":"a",
                "telegram_message_id":10,
                "master":{"telegram_message_id":10},
                "artwork":{"telegram_message_id":20},
                "files":[{"telegram_message_id":30,"parts":[{"telegram_message_id":40}]}],
                "project":{"manifest":{"parts":[{"telegram_message_id":50}]}}
            }],
            "trash":[],"deleted":[]
        });
        let (_, media) = apply_permanent_delete_to_manifest(&mut manifest, &wanted(&["a"]), 1).unwrap();
        assert_eq!(media, [10,20,30,40,50].into_iter().collect());
    }

    fn candidate(name: &str, bytes: u64, last_used: u64) -> PlaybackCacheCandidate {
        PlaybackCacheCandidate { path: PathBuf::from(name), bytes, last_used }
    }

    #[test]
    fn lru_evicts_oldest_files_until_under_limit() {
        let evicted = select_playback_cache_evictions(
            vec![candidate("old.mp3", 40, 1), candidate("mid.mp3", 40, 2), candidate("new.mp3", 40, 3)],
            80,
            &HashSet::new(),
        );
        assert_eq!(evicted, vec![PathBuf::from("old.mp3")]);
    }

    #[test]
    fn lru_never_selects_protected_playback_files() {
        let mut protected = HashSet::new();
        protected.insert(PathBuf::from("old.mp3"));
        let evicted = select_playback_cache_evictions(
            vec![candidate("old.mp3", 60, 1), candidate("new.mp3", 60, 2)],
            60,
            &protected,
        );
        assert_eq!(evicted, vec![PathBuf::from("new.mp3")]);
    }

    #[test]
    fn lru_does_nothing_when_cache_is_already_under_limit() {
        let evicted = select_playback_cache_evictions(
            vec![candidate("a.mp3", 20, 1), candidate("b.mp3", 20, 2)],
            100,
            &HashSet::new(),
        );
        assert!(evicted.is_empty());
    }

    #[test]
    fn zero_limit_evicts_every_unprotected_cache_file() {
        let evicted = select_playback_cache_evictions(
            vec![candidate("a.mp3", 20, 1), candidate("b.part", 20, 2)],
            0,
            &HashSet::new(),
        );
        assert_eq!(evicted.len(), 2);
    }

    #[test]
    fn cache_enforcement_removes_audio_cache_but_preserves_unrelated_files() {
        let dir = std::env::temp_dir().join(format!("beatgaler-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mp3 = dir.join("a.mp3");
        let part = dir.join("b.part");
        let note = dir.join("keep.txt");
        std::fs::write(&mp3, vec![1u8; 8]).unwrap();
        std::fs::write(&part, vec![2u8; 8]).unwrap();
        std::fs::write(&note, b"keep").unwrap();
        std::fs::write(playback_cache_access_path(&mp3), b"1").unwrap();

        let used = enforce_playback_cache_limit_in_dir(&dir, 0, &HashSet::new());
        assert_eq!(used, 0);
        assert!(!mp3.exists());
        assert!(!part.exists());
        assert!(!playback_cache_access_path(&mp3).exists());
        assert!(note.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod security_filename_unit_tests {
    use super::{is_windows_reserved_component, safe_cloud_filename, safe_export_name};

    #[test]
    fn windows_reserved_names_are_detected_case_insensitively() {
        for value in ["CON", "con", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "lpt9", "CON.txt"] {
            assert!(is_windows_reserved_component(value), "reserved name escaped detection: {value}");
        }
        for value in ["CONSOLE", "COM0", "COM10", "LPT0", "LPT10", "AUXILIARY", "beat"] {
            assert!(!is_windows_reserved_component(value), "normal name was marked reserved: {value}");
        }
    }

    #[test]
    fn export_name_replaces_windows_illegal_characters_and_controls() {
        let value = safe_export_name("bad<name>:\"/\\|?*\n");
        assert!(!value.chars().any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control()));
        assert!(!value.ends_with('.') && !value.ends_with(' '));
    }

    #[test]
    fn export_name_never_returns_a_windows_reserved_component() {
        for value in ["CON", "con.txt", "NUL", "AUX ", "COM1", "LPT9"] {
            let safe = safe_export_name(value);
            assert!(!is_windows_reserved_component(&safe), "unsafe export component: {safe}");
        }
    }

    #[test]
    fn cloud_filename_never_returns_a_windows_reserved_component() {
        for value in ["CON", "NUL", "AUX", "COM1", "LPT1"] {
            let safe = safe_cloud_filename(value);
            assert!(!is_windows_reserved_component(&safe), "unsafe cloud component: {safe}");
        }
    }
}

#[cfg(test)]
mod direct_sleep_wake_unit_tests {
    use super::{classify_direct_begin_response, DirectBeginDisposition};
    use serde_json::json;

    #[test]
    fn expired_operation_after_sleep_requests_session_recovery() {
        assert_eq!(
            classify_direct_begin_response(&json!({"expired": true})).unwrap(),
            DirectBeginDisposition::Expired
        );
    }

    #[test]
    fn recovered_operation_can_continue_without_reload() {
        assert_eq!(
            classify_direct_begin_response(&json!({"ok": true, "operation_id": "op_after_wake"})).unwrap(),
            DirectBeginDisposition::Ready("op_after_wake".to_string())
        );
    }

    #[test]
    fn transfer_backpressure_is_bounded() {
        assert_eq!(
            classify_direct_begin_response(&json!({"wait": true, "retry_after_ms": 99999})).unwrap(),
            DirectBeginDisposition::Wait(1000)
        );
    }
}

#[cfg(test)]
mod beat_identity_unicode_tests {
    use super::{normalized_beat_display_name, normalized_beat_name_key};

    #[test]
    fn canonical_unicode_forms_share_one_beat_identity() {
        let nfc = "Canción";
        let nfd = "Cancio\u{301}n";
        assert_eq!(normalized_beat_name_key(nfc), normalized_beat_name_key(nfd));
        assert_eq!(normalized_beat_display_name(nfd), nfc);
    }

    #[test]
    fn beat_identity_normalizes_unicode_case_and_spacing_without_losing_emoji() {
        assert_eq!(
            normalized_beat_name_key("  NIÑO   🌙  "),
            normalized_beat_name_key("niño 🌙")
        );
        assert_eq!(normalized_beat_display_name("  Sueño   🔥 "), "Sueño 🔥");
    }
}

#[cfg(test)]
mod export_filename_unit_tests {
    use super::{canonical_filename, clean_name_from_filename, format_bpm_key_suffix, parse_bpm_key_from_filename};

    #[test]
    fn parses_bpm_key_in_both_supported_orders() {
        assert_eq!(parse_bpm_key_from_filename("Beat [140 F#m].wav"), (Some("140".into()), Some("f#m".into())));
        assert_eq!(parse_bpm_key_from_filename("Beat [Bb 92].mp3"), (Some("92".into()), Some("Bb".into())));
    }

    #[test]
    fn parsing_ignores_unrelated_brackets() {
        assert_eq!(parse_bpm_key_from_filename("Beat [FINAL] [140 F#m].wav"), (Some("140".into()), Some("f#m".into())));
        assert_eq!(parse_bpm_key_from_filename("Beat [FINAL].wav"), (None, None));
    }

    #[test]
    fn clean_name_strips_existing_bpm_key_markers() {
        assert_eq!(clean_name_from_filename("Purple Beat [140 F#m].wav"), "Purple Beat");
        assert_eq!(clean_name_from_filename("Purple Beat [F#m 140].mp3"), "Purple Beat");
    }

    #[test]
    fn clean_name_preserves_normal_bracketed_text() {
        assert_eq!(clean_name_from_filename("Purple Beat [FINAL].wav"), "Purple Beat [FINAL]");
        assert_eq!(clean_name_from_filename("Purple Beat [DRAFT MIX].wav"), "Purple Beat [DRAFT MIX]");
        assert_eq!(clean_name_from_filename("Purple Beat [VERSION A].wav"), "Purple Beat [VERSION A]");
        assert_eq!(clean_name_from_filename("Purple Beat [140 FINAL].wav"), "Purple Beat [140 FINAL]");
        assert_eq!(clean_name_from_filename("Purple Beat [MIX F#].wav"), "Purple Beat [MIX F#]");
    }

    #[test]
    fn clean_name_only_strips_complete_metadata_tokens() {
        assert_eq!(clean_name_from_filename("Purple Beat [F].wav"), "Purple Beat");
        assert_eq!(clean_name_from_filename("Purple Beat [F#m].wav"), "Purple Beat");
        assert_eq!(clean_name_from_filename("Purple Beat [140].wav"), "Purple Beat");
        assert_eq!(clean_name_from_filename("Purple Beat [FINAL] [140 F#m].wav"), "Purple Beat [FINAL]");
    }

    #[test]
    fn suffix_builder_handles_partial_metadata() {
        assert_eq!(format_bpm_key_suffix("", ""), "");
        assert_eq!(format_bpm_key_suffix("140", ""), "[140]");
        assert_eq!(format_bpm_key_suffix("", "F#"), "[F#]");
        assert_eq!(format_bpm_key_suffix("140", "F# minor"), "[140 f#m]");
    }

    #[test]
    fn canonical_audio_filename_includes_bpm_key_and_extension() {
        assert_eq!(canonical_filename("Purple Beat", "140", "F#m", "wav"), "Purple Beat [140 f#m].wav");
        assert_eq!(canonical_filename("Purple Beat", "92", "Bb", "mp3"), "Purple Beat [92 Bb].mp3");
    }

    #[test]
    fn canonical_filename_does_not_emit_invalid_key_text() {
        assert_eq!(canonical_filename("Purple Beat", "140", "not-a-key", "wav"), "Purple Beat [140].wav");
    }
}
