use base64::{engine::general_purpose, Engine};
use id3::{Tag, TagLike, Version, frame};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use walkdir::WalkDir;
use tauri::Emitter;
use crate::matcher;

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
    pub playback_path: String,  // what we actually play: wav preferred over mp3
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
}

// Return true if filename contains multiple bracket groups that look like BPM/key markers
fn has_multiple_bpm_key_brackets(filename: &str) -> bool {
    let re_bracket = regex_lite::Regex::new(r"\[([^\]]+)\]").unwrap();
    let mut count = 0;
    for cap in re_bracket.captures_iter(filename) {
        let inner = cap[1].trim();
        // consider it a BPM/key bracket if it contains a 2-3 digit number or a possible key token
        let re_bpm = regex_lite::Regex::new(r"\d{2,3}").unwrap();
        let re_key = regex_lite::Regex::new(r"[ABCDFGabcdfg][#b]?m?").unwrap();
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
}

fn default_true() -> bool { true }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            beats_folder: None,
            templates_folder: None,
            incomplete_warnings_enabled: true,
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
        let s = self.settings.lock().unwrap();
        if let Some(ref f) = s.beats_folder {
            let p = PathBuf::from(f);
            std::fs::create_dir_all(&p).ok();
            p
        } else {
            let p = self.data_dir.join("beats");
            std::fs::create_dir_all(&p).ok();
            p
        }
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
pub fn set_beats_folder(
    folder: String,
    state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<(), String> {
    let new_root = PathBuf::from(&folder);
    std::fs::create_dir_all(&new_root).map_err(|e| format!("Cannot create folder: {}", e))?;

    let old_root = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.beats_folder
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| state.data_dir.join("beats"))
    };

    {
        let mut conn = db.0.lock().map_err(|e| e.to_string())?;
        migrate_library_root(&old_root, &new_root, &mut conn, &state.data_dir)?;
    }

    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.beats_folder = Some(folder);
    save_settings_file(&state.data_dir, &*s)
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
        // Restrict keys to allowed letters (A,B,C,D,F,G) with optional #/b and optional m (minor)
        let re_bpm_key = regex_lite::Regex::new(r"^(\d{2,3})\s+([ABCDFGabcdfg][b#]?m?)$").unwrap();
        if let Some(m) = re_bpm_key.captures(inner) {
            return (Some(m[1].to_string()), Some(normalize_key(&m[2].to_string())));
        }
        let re_key_bpm = regex_lite::Regex::new(r"^([ABCDFGabcdfg][b#]?m?)\s+(\d{2,3})$").unwrap();
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
    // Replace Unicode sharp with '#'
    let s = s.replace('♯', "#").replace('♭', "b");
    // Extract base token (stop at space or non-alnum)
    let token = s.split_whitespace().next().unwrap_or("");
    // Match letter, optional #/b, optional trailing 'm' or 'min' variants
    let re = regex_lite::Regex::new(r"^([ABCDFGabcdfg])([#b])?m?$").unwrap();
    if let Some(c) = re.captures(token) {
        let base = c.get(1).unwrap().as_str().to_uppercase();
        let accidental = c.get(2).map(|m| m.as_str()).unwrap_or("");
        let is_minor = token.to_lowercase().ends_with('m');
        if is_minor {
            return format!("{}{}m", base, accidental);
        }
        return format!("{}{}", base, accidental);
    }
    // Allow patterns like "A#M" or "A#m" explicitly
    let re2 = regex_lite::Regex::new(r"^([ABCDFGabcdfg])([#b])?m$" ).unwrap();
    if let Some(c) = re2.captures(token) {
        let base = c.get(1).unwrap().as_str().to_uppercase();
        let accidental = c.get(2).map(|m| m.as_str()).unwrap_or("");
        return format!("{}{}m", base, accidental);
    }
    // Not a valid key per rules -> return empty
    String::new()
}

/// Strip ANY [BPM Key] style bracket from a stem, return clean name
pub fn clean_name_from_filename(filename: &str) -> String {
    let stem = if let Some(dot) = filename.rfind('.') { &filename[..dot] } else { filename };
    // Remove any bracketed segment that looks like a BPM/key marker or contains a 2-3 digit number
    // This also strips malformed or duplicate bracket groups like "[idkK idkK]" "[135 idkK]"
    let re_loose = regex_lite::Regex::new(r"\s*\[[^\]]*(?:\d{2,3}|[A-Ga-g][b#]?m?)[^\]]*\]").unwrap();
    // Also remove strict [BPM Key] patterns (covers properly formatted cases)
    let re_strict = regex_lite::Regex::new(r"\s*\[(?:\d{2,3}\s+[A-Ga-g][b#]?m?|[A-Ga-g][b#]?m?\s+\d{2,3})\]").unwrap();
    let intermediate = re_loose.replace_all(stem, "");
    let cleaned = re_strict.replace_all(&intermediate, "");
    cleaned.trim().to_string()
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

// ─────────────────────────────────────────────────────────────
//  DB
// ─────────────────────────────────────────────────────────────

pub fn init_db(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
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
            trashed_at            INTEGER DEFAULT (strftime('%s','now'))
        );
    ")?;
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS template_trash (
            id             TEXT PRIMARY KEY,
            original_path  TEXT NOT NULL,
            trashed_path   TEXT NOT NULL,
            preset_name    TEXT NOT NULL,
            trashed_at     INTEGER DEFAULT (strftime('%s','now'))
        );
    ")?;
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
    for entry in WalkDir::new(folder) {
        let entry = entry.map_err(|e| e.to_string())?;
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

fn db_save(conn: &Connection, b: &BeatMeta) -> rusqlite::Result<()> {
    let signature = folder_signature(Path::new(&b.folder_path)).ok();
    let meta_json = serde_json::to_string(b).ok();
    conn.execute(
        "INSERT INTO beats (id, mp3_path, folder_path, color, color2, sort_order, folder_signature, meta_json)\n         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT sort_order FROM beats WHERE id=?1), 0), ?6, ?7)\n         ON CONFLICT(id) DO UPDATE SET\n           mp3_path=excluded.mp3_path,\n           folder_path=excluded.folder_path,\n           color=excluded.color,\n           color2=excluded.color2,\n           folder_signature=excluded.folder_signature,\n           meta_json=excluded.meta_json",
        params![b.id, b.mp3_path, b.folder_path, b.color, b.color2, signature, meta_json],
    )?;
    Ok(())
}

fn db_upsert_with_order(conn: &Connection, b: &BeatMeta, sort_order: Option<i64>) -> rusqlite::Result<()> {
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
    if !beats_root.exists() {
        conn.execute("DELETE FROM beats", []).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let rows = db_load_all(conn).map_err(|e| e.to_string())?;
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

        // Existing rows with matching signatures already contain the fully
        // materialized BeatMeta. Avoid scanning filenames and, most importantly,
        // avoid reading ID3 from every MP3/WAV on every startup.
        if let Some(existing) = by_folder.get(&folder_str) {
            if let Some(cached) = db_cached_meta(existing, &signature) {
                seen_folders.insert(folder_str.clone());
                continue;
            }
        }

        let files = scan_folder_structured(folder);
        if files.mp3s.is_empty() && files.wavs.is_empty() { continue; }

        seen_folders.insert(folder_str.clone());

        let beat = if let Some(existing) = by_folder.get(&folder_str) {
            let has_conflict = files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1;
            let built = build_beat_from_parts(
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
            conn.execute("DELETE FROM beats WHERE id=?1", params![row.id.clone()]).map_err(|e| e.to_string())?;
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
    let tags: Vec<String> = genre_raw
        .split(|c: char| c == ';' || c == ',' || c == '/')
        .map(|s| {
            let s = s.trim();
            let s = if s.starts_with('(') {
                s.trim_start_matches(|c: char| c == '(' || c.is_ascii_digit() || c == ')').trim()
            } else { s };
            s.to_lowercase()
        })
        .filter(|s| !s.is_empty())
        .collect();

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

fn write_id3_to(path: &Path, bpm: &str, key: &str, tags: &[String], rating: u8, image_base64: Option<&str>) -> Result<(), String> {
    let safe_tags = validate_metadata_tags(tags)?;
    let mut tag = Tag::read_from_path(path).unwrap_or_default();

    tag.remove("TBPM");
    if !bpm.is_empty() { tag.set_text("TBPM", bpm); }
    tag.remove("TKEY");
    if !key.is_empty() { tag.set_text("TKEY", key); }
    tag.remove("TCON");
    if !safe_tags.is_empty() { tag.set_genre(safe_tags.join("; ")); }
    tag.remove("POPM");
    {
        let raw: u8 = match rating { 0=>0, 1=>1, 2=>64, 3=>128, 4=>192, _=>255 };
        tag.add_frame(id3::Frame::with_content("POPM",
            id3::Content::Popularimeter(id3::frame::Popularimeter {
                user: "Beat Galer".to_string(), rating: raw, counter: 0,
            })));
    }
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
    } else {
        tag.remove_picture_by_type(frame::PictureType::CoverFront);
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

fn normalize_folder_artwork(folder: &Path) {
    let files = scan_folder_structured(folder);
    for p in files.mp3s.iter().chain(files.wavs.iter()) {
        ensure_cover_front(p);
    }
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
            let meta = e.metadata().unwrap_or_else(|_| e.path().metadata().unwrap());
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
                        else if n.contains("flp") || n.contains("project") { flps.push(p); }
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
        "samples", "sample", "backup", "audio", "recorded", "rendered", "processed",
        "imported", "waveforms", "recopiladas", "presets",
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
    mp3: Option<PathBuf>,
    wav: Option<PathBuf>,
}

fn build_loose_candidate_from_audio(audio_path: &Path) -> Result<LooseImportCandidate, String> {
    if !audio_path.exists() || !audio_path.is_file() || !is_audio_file(audio_path) {
        return Err(format!("Invalid audio file: {}", audio_path.to_string_lossy()));
    }

    let parent = audio_path.parent().ok_or("Audio file has no parent folder")?;
    let stem = audio_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let clean_name = clean_name_from_filename(&stem);
    if clean_name.trim().is_empty() {
        return Err("Could not infer beat name from file".to_string());
    }

    let mut mp3: Option<PathBuf> = None;
    let mut wav: Option<PathBuf> = None;

    if let Ok(rd) = parent.read_dir() {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() || !is_audio_file(&p) {
                continue;
            }
            let p_stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
            if clean_name_from_filename(&p_stem) != clean_name {
                continue;
            }
            let ext = p.extension().unwrap_or_default().to_string_lossy().to_lowercase();
            if ext == "mp3" && mp3.is_none() {
                mp3 = Some(p.clone());
            }
            if ext == "wav" && wav.is_none() {
                wav = Some(p.clone());
            }
        }
    }

    let primary = mp3.as_ref().or(wav.as_ref()).unwrap_or(&audio_path.to_path_buf()).clone();
    let (bpm, key, _, _, _) = read_id3(&primary);

    Ok(LooseImportCandidate {
        source_anchor: audio_path.to_path_buf(),
        clean_name,
        bpm,
        key,
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
        tags: vec![],
        rating: 0,
        image_base64: None,
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
    }
}

fn materialize_loose_candidate(c: &LooseImportCandidate, library_root: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(library_root).map_err(|e| format!("Create library folder failed: {}", e))?;

    let dest_folder = unique_folder_path(library_root, &c.clean_name);
    std::fs::create_dir_all(&dest_folder).map_err(|e| format!("Create beat folder failed: {}", e))?;

    if let Some(ref mp3) = c.mp3 {
        let name = canonical_filename(&c.clean_name, &c.bpm, &c.key, "mp3");
        std::fs::copy(mp3, dest_folder.join(name)).map_err(|e| format!("Copy MP3 failed: {}", e))?;
    }
    if let Some(ref wav) = c.wav {
        let name = canonical_filename(&c.clean_name, &c.bpm, &c.key, "wav");
        std::fs::copy(wav, dest_folder.join(name)).map_err(|e| format!("Copy WAV failed: {}", e))?;
    }

    Ok(dest_folder)
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

fn ensure_folder_in_library(src_folder: &Path, library_root: &Path) -> Result<PathBuf, String> {
    let src_canon = src_folder.canonicalize().unwrap_or_else(|_| src_folder.to_path_buf());
    let root_canon = library_root.canonicalize().unwrap_or_else(|_| library_root.to_path_buf());
    if src_canon.starts_with(&root_canon) {
        return Ok(src_folder.to_path_buf());
    }

    std::fs::create_dir_all(library_root).map_err(|e| format!("Create library folder failed: {}", e))?;
    let folder_name = src_folder
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let dest_folder = unique_folder_path(library_root, &folder_name);
    copy_dir_recursive(src_folder, &dest_folder)?;
    Ok(dest_folder)
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
    }
}

fn build_from_disk(db: DbBeat) -> Option<BeatMeta> {
    let folder = PathBuf::from(&db.folder_path);
    if !folder.exists() { return None; }

    // load_library calls sync first, so a matching signature means the cached
    // BeatMeta is current and we can return it without another disk scan.
    if let Some(signature) = db.folder_signature.as_deref() {
        if let Some(cached) = db_cached_meta(&db, signature) {
            return Some(cached);
        }
    }

    let mp3 = PathBuf::from(&db.mp3_path);
    let files = scan_folder_structured(&folder);

    // Find main mp3/wav — prefer the one matching the stored path
    let mp3_opt = if mp3.exists() { Some(mp3.clone()) }
        else { files.mp3s.first().cloned() };
    let wav_opt = files.wavs.first().cloned();

    let beat = build_beat_from_parts(
        db.id, &folder,
        mp3_opt.as_deref(), wav_opt.as_deref(),
        files.stems.first().map(|p| p.as_path()),
        files.flps.first().map(|p| p.as_path()),
        files.alss.first().map(|p| p.as_path()),
        &files.others,
        db.color, db.color2,
        (files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1),
    );
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
        let ok = std::process::Command::new("powershell")
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
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    sync_library_from_disk(&conn, &settings.beats_dir())?;
    let rows = db_load_all(&conn).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().filter_map(build_from_disk).collect())
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

        let imported_folder = if source.is_dir() {
            ensure_folder_in_library(&source, &settings.beats_dir())?
        } else if source.is_file() && is_audio_file(&source) {
            let candidate = build_loose_candidate_from_audio(&source)?;
            materialize_loose_candidate(&candidate, &settings.beats_dir())?
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
    settings: tauri::State<SettingsState>,
) -> Result<BeatMeta, String> {
    let path = PathBuf::from(&mp3_path);
    if !path.exists() { return Err(format!("Not found: {}", mp3_path)); }
    let candidate = build_loose_candidate_from_audio(&path)?;
    let folder = materialize_loose_candidate(&candidate, &settings.beats_dir())?;
	normalize_folder_artwork(&folder);
    let files = scan_folder_structured(&folder);

    let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
    let name = clean_name_from_filename(&folder_name);
    let (color, color2) = gradient_for(&name);
    let folder_str = folder.to_string_lossy().to_string();
    let id = make_id(&name, &folder_str);

    let imported_path = path
        .file_name()
        .map(|name| folder.join(name))
        .unwrap_or_else(|| path.clone());
    let mp3 = if imported_path.extension().map(|e| e.eq_ignore_ascii_case("mp3")).unwrap_or(false) { Some(imported_path.clone()) } else { None };
    let wav = if imported_path.extension().map(|e| e.eq_ignore_ascii_case("wav")).unwrap_or(false) { Some(imported_path.clone()) } else { files.wavs.first().cloned() };

    let beat = build_beat_from_parts(
        id, &folder,
        mp3.as_deref().or_else(|| files.mp3s.first().map(|p| p.as_path())),
        wav.as_deref(),
        files.stems.first().map(|p| p.as_path()),
        files.flps.first().map(|p| p.as_path()),
        files.alss.first().map(|p| p.as_path()),
        &files.others, color, color2,
        (files.mp3s.len() > 1 || files.wavs.len() > 1 || files.stems.len() > 1 || files.flps.len() > 1),
    );
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db_save(&conn, &beat).map_err(|e| e.to_string())?;
    Ok(beat)
}

/// Save metadata — writes to both MP3 and WAV, updates filenames if needed
#[tauri::command]
pub fn save_beat_meta(payload: SaveMetaPayload) -> Result<serde_json::Value, String> {
    let mp3 = if !payload.mp3_path.is_empty() { Some(PathBuf::from(&payload.mp3_path)) } else { None };
    let wav = payload.wav_path.as_ref().map(PathBuf::from);

    // Normalize incoming BPM/Key before writing
    let bpm_norm = {
        let re = regex_lite::Regex::new(r"(\d{2,3})").unwrap();
        if let Some(m) = re.captures(&payload.bpm) { m.get(1).unwrap().as_str().to_string() } else { payload.bpm.trim().to_string() }
    };
    let key_norm = normalize_key(&payload.key);
    let sanitized_tags = sanitize_tags(&payload.tags);

    // Write tags to MP3
    if let Some(ref p) = mp3 {
        if p.exists() {
            write_id3_to(p, &bpm_norm, &key_norm, &sanitized_tags, payload.rating, payload.image_base64.as_deref())?;
        }
    }
    // Write tags to WAV too — same metadata
    if let Some(ref p) = wav {
        if p.exists() {
            // Best-effort: WAV ID3 may fail silently
            let _ = write_id3_to(p, &bpm_norm, &key_norm, &sanitized_tags, payload.rating, payload.image_base64.as_deref());
        }
    }

    // Update filenames if requested
    if payload.update_filename {
        let (new_mp3, new_wav) = update_audio_filenames(mp3.as_deref(), wav.as_deref(), &bpm_norm, &key_norm)?;
        return Ok(serde_json::json!({
            "new_mp3_path": new_mp3,
            "new_wav_path": new_wav,
        }));
    }

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
pub fn rename_beat(payload: RenamePayload, state: tauri::State<DbState>) -> Result<RenameResult, String> {
    let old_folder = PathBuf::from(&payload.folder_path);
    if !old_folder.exists() { return Err(format!("Folder not found: {}", payload.folder_path)); }

    let safe: String = payload.new_name.chars().map(|c| match c {
        '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_', c => c,
    }).collect();
    let clean = safe.trim().to_string();
    if clean.is_empty() { return Err("Name cannot be empty".to_string()); }

    let parent = old_folder.parent().ok_or("No parent directory")?;
    let new_folder_path = parent.join(&clean);
    if new_folder_path == old_folder {
        return Ok(RenameResult {
            new_folder_path: old_folder.to_string_lossy().to_string(),
            new_mp3_path: payload.mp3_path.clone(),
            new_wav_path: None, new_stems_path: None, new_flp_path: None,
        });
    }
    if new_folder_path.exists() { return Err(format!("A folder named '{}' already exists", clean)); }

    let mp3 = if !payload.mp3_path.is_empty() { Some(PathBuf::from(&payload.mp3_path)) } else { None };
    let files = scan_folder_structured(&old_folder);
    let wav = files.wavs.first().cloned();
    let stems = files.stems.first().cloned();
    let flp = files.flps.first().cloned();

    // Read BPM/key from existing metadata to preserve in filename
    let (bpm, key) = if let Some(ref p) = mp3.as_ref().or(wav.as_ref()) {
        let (b, k, _, _, _) = read_id3(p);
        (b, k)
    } else { (String::new(), String::new()) };

    let (new_folder, new_mp3, new_wav, new_stems, new_flp) = rename_all_files(
        &old_folder, mp3.as_deref(), wav.as_deref(),
        stems.as_deref(), flp.as_deref(),
        &clean, &bpm, &key,
    )?;

    let new_folder_str = new_folder.to_string_lossy().to_string();
    let new_mp3_str = new_mp3.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE beats SET folder_path=?1, mp3_path=?2 WHERE folder_path=?3",
        params![new_folder_str, new_mp3_str, old_folder.to_string_lossy().as_ref()],
    ).map_err(|e| e.to_string())?;

    Ok(RenameResult {
        new_folder_path: new_folder_str, new_mp3_path: new_mp3_str,
        new_wav_path: new_wav.map(|p| p.to_string_lossy().to_string()),
        new_stems_path: new_stems.map(|p| p.to_string_lossy().to_string()),
        new_flp_path: new_flp.map(|p| p.to_string_lossy().to_string()),
    })
}

/// Add a file to a beat by copying it into the beat folder with the right name
#[tauri::command]
pub fn add_file_to_beat(payload: AddFilePayload) -> Result<String, String> {
    let src = PathBuf::from(&payload.file_path);
    if !src.exists() { return Err(format!("Source file not found: {}", payload.file_path)); }

    let folder = PathBuf::from(&payload.beat_folder);

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
    let (folder_path, mp3_path) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        match conn.query_row(
            "SELECT folder_path, mp3_path FROM beats WHERE id=?1",
            params![id.clone()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            Ok(paths) => paths,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
    };

    let display_name = if !folder_path.trim().is_empty() {
        PathBuf::from(&folder_path).file_name()
            .map(|n| clean_name_from_filename(&n.to_string_lossy()))
            .unwrap_or_default()
    } else {
        PathBuf::from(&mp3_path).file_stem()
            .map(|n| clean_name_from_filename(&n.to_string_lossy()))
            .unwrap_or_default()
    };

    let trash_dir = settings.data_dir.join(".trash");
    std::fs::create_dir_all(&trash_dir).ok();
    let mut trashed_path: Option<PathBuf> = None;

    if !folder_path.trim().is_empty() {
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
    } else if !mp3_path.trim().is_empty() {
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
    if let Some(dest) = &trashed_path {
        let trash_id = random_urlsafe(10);
        let _ = conn.execute(
            "INSERT INTO trash (id, original_folder_path, trashed_path, beat_name, trashed_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))",
            params![trash_id, folder_path, dest.to_string_lossy().to_string(), display_name],
        );
    }
    conn.execute("DELETE FROM beats WHERE id=?1", params![id.clone()]).map_err(|e| e.to_string())?;
    log_info(&settings.data_dir, &format!("Beat '{}' moved to trash", id));
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrashItem {
    pub id: String,
    pub beat_name: String,
    pub trashed_at: i64,
}

#[tauri::command]
pub fn list_trash(state: tauri::State<DbState>) -> Result<Vec<TrashItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, beat_name, trashed_at FROM trash ORDER BY trashed_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(TrashItem {
        id: r.get(0)?, beat_name: r.get(1)?, trashed_at: r.get(2)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// Restores a trashed beat back into the active library.
#[tauri::command]
pub fn restore_beat_from_trash(
    trash_id: String,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
) -> Result<BeatMeta, String> {
    let (folder_path, trashed_path) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT original_folder_path, trashed_path FROM trash WHERE id=?1",
            params![trash_id.clone()],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        ).map_err(|_| "Ese elemento ya no está en la papelera.".to_string())?
    };

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
    let mut stmt = match conn.prepare("SELECT id, trashed_path FROM trash WHERE trashed_at < ?1") {
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
        if p.exists() { remove_path_best_effort(&p); }
        if conn.execute("DELETE FROM trash WHERE id=?1", params![trash_id]).is_ok() {
            purged += 1;
        }
    }
    if purged > 0 { log_info(data_dir, &format!("Auto-purged {} trash item(s) older than {} days", purged, max_age_days)); }
    purged
}

#[tauri::command]
pub fn purge_trash_now(state: tauri::State<DbState>, settings: tauri::State<SettingsState>) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(purge_old_trash_internal(&conn, &settings.data_dir, 0))
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

fn load_oauth_client(_data_dir: &Path) -> Result<StoredOAuthClient, String> {
    // Desktop apps cannot keep a client_secret confidential. Beat Galer uses
    // OAuth PKCE and ships only the public Desktop OAuth client_id.
    Ok(StoredOAuthClient {
        client_type: "installed".to_string(),
        client_id: "499243641799-f01nc2k19n34rj2cmtlb6a2n4h8o1fvv.apps.googleusercontent.com".to_string(),
        client_secret: None,
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
    let output = Command::new("curl")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to start curl: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn post_form_json(url: &str, form: &[(&str, String)]) -> Result<Value, String> {
    let mut args = vec!["-sS".to_string(), "-f".to_string(), "-X".to_string(), "POST".to_string(), url.to_string()];
    for (key, value) in form {
        args.push("--data-urlencode".to_string());
        args.push(format!("{}={}", key, value));
    }
    let raw = run_curl(&args)?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid JSON from Google: {}", e))
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

    let status = Command::new("ffmpeg")
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

    let mut child = Command::new("ffmpeg")
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
pub fn save_youtube_oauth_config(raw_json: String, state: tauri::State<SettingsState>) -> Result<(), String> {
    let client = parse_oauth_client(&raw_json)?;
    save_json_file(&youtube_client_path(&state.data_dir), &client)
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
pub struct ImportBatchState(pub Mutex<std::collections::HashMap<String, PendingImportBatch>>);

pub struct PendingImportBatch {
    pub groups: std::collections::HashMap<String, matcher::ConfirmedGroup>,
    // When a confirmed beat came from a real beat folder, keep that folder so
    // materialization can copy its complete contents (Samples, Backup, Audio,
    // artwork, presets, etc.) instead of only the recognized files.
    pub source_folders: std::collections::HashMap<String, PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportBatchPreview {
    pub batch_id: String,
    pub confirmed_count: usize,
    pub pending: Vec<matcher::PendingDecision>,
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
#[tauri::command]
pub fn preview_import_batch(
    root_paths: Vec<String>,
    state: tauri::State<DbState>,
    batches: tauri::State<ImportBatchState>,
) -> Result<ImportBatchPreview, String> {
    let mut all_items: Vec<matcher::DiscoveredItem> = Vec::new();
    let dropped_roots: Vec<PathBuf> = root_paths.iter().map(PathBuf::from).collect();

    // These directories are assets that belong to a beat. Audio files inside
    // them must never become independent beats during recursive import.
    fn is_auxiliary_import_dir(name: &str) -> bool {
        matches!(
            name.trim().to_ascii_lowercase().as_str(),
            "sample" | "samples" | "stem" | "stems" |
            "backup" | "backups" | "render" | "renders" |
            "recording" | "recordings" | "audio files" |
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

    for root in &root_paths {
        let root_path = PathBuf::from(root);
        if !root_path.exists() { continue; }

        if root_path.is_file() {
            if is_audio_file(&root_path) {
                all_items.push(matcher::make_discovered_item(root_path, false));
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
                if !entry.file_type().is_dir() { return true; }
                let name = entry.file_name().to_string_lossy();
                !is_auxiliary_import_dir(&name)
            });

        for entry in walker {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path().to_path_buf();
            if entry.file_type().is_dir() { continue; }
            if path_is_inside_auxiliary_dir(&p, &root_path) { continue; }

            let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
            if matches!(ext.as_str(), "mp3" | "wav" | "flp" | "als") {
                all_items.push(matcher::make_discovered_item(p, false));
            }
        }
    }

    let existing_core_names: Vec<String> = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let rows = db_load_all(&conn).map_err(|e| e.to_string())?;
        rows.iter()
            .filter_map(|b| {
                let folder_name = PathBuf::from(&b.folder_path)
                    .file_name().map(|n| n.to_string_lossy().to_string())?;
                let clean = clean_name_from_filename(&folder_name);
                let (core, _) = matcher::normalize_core_name(&clean);
                if core.is_empty() { None } else { Some(core) }
            })
            .collect()
    };

    let (confirmed, pending) = matcher::group_discovered_items(all_items, &existing_core_names);

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
    let total_confirmed = confirmed.len();

    for g in confirmed {
        let mut group_paths: Vec<PathBuf> = Vec::new();
        if let Some(p) = &g.mp3 { group_paths.push(p.clone()); }
        if let Some(p) = &g.wav { group_paths.push(p.clone()); }
        if let Some(p) = &g.loop_file { group_paths.push(p.clone()); }
        if let Some(p) = &g.flp { group_paths.push(p.clone()); }
        if let Some(p) = &g.als { group_paths.push(p.clone()); }
        group_paths.extend(g.others.iter().cloned());

        if let Some(folder) = owning_beat_folder(&group_paths, &dropped_roots, total_confirmed) {
            if folder.is_dir() { source_folders.insert(g.core_name.clone(), folder); }
        }

        groups_map.insert(g.core_name.clone(), g);
    }
    let confirmed_count = groups_map.len();

    {
        let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
        lock.insert(batch_id.clone(), PendingImportBatch { groups: groups_map, source_folders });
    }

    Ok(ImportBatchPreview { batch_id, confirmed_count, pending })
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
    beat_name: &str,
    library_root: &Path,
    source_folder: Option<&Path>,
) -> Result<MaterializedBeat, String> {
    std::fs::create_dir_all(library_root).map_err(|e| format!("Create library folder failed: {}", e))?;
    let dest_folder = unique_folder_path(library_root, beat_name);
    std::fs::create_dir_all(&dest_folder).map_err(|e| format!("Create beat folder failed: {}", e))?;

    // A real dropped beat folder is copied completely first, preserving every
    // nested folder and unknown asset. Recognized paths are then mapped to their
    // copied equivalents rather than duplicated or flattened.
    if let Some(src_folder) = source_folder {
        copy_dir_recursive(src_folder, &dest_folder)?;
    }

    fn mapped_or_copy(
        src: &Path,
        source_folder: Option<&Path>,
        dest_folder: &Path,
        fallback_name: PathBuf,
    ) -> Result<PathBuf, String> {
        if let Some(root) = source_folder {
            if let Ok(relative) = src.strip_prefix(root) {
                let mapped = dest_folder.join(relative);
                if mapped.exists() {
                    return Ok(mapped);
                }
            }
        }

        let dest = dest_folder.join(fallback_name);
        if src.is_dir() {
            copy_dir_recursive(src, &dest)?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("Create destination failed: {}", e))?;
            }
            std::fs::copy(src, &dest).map_err(|e| format!("Copy failed: {}", e))?;
        }
        Ok(dest)
    }

    let primary = group.mp3.as_ref().or(group.wav.as_ref());
    let (bpm, key) = if let Some(p) = primary {
        let (b, k, _, _, _) = read_id3(p);
        (b, k)
    } else { (String::new(), String::new()) };

    let mut m = MaterializedBeat {
        folder: dest_folder.clone(),
        mp3: None, wav: None, loop_path: None, stems: None, flp: None, als: None,
    };

    if let Some(ref src) = group.mp3 {
        m.mp3 = Some(mapped_or_copy(
            src, source_folder, &dest_folder,
            PathBuf::from(canonical_filename(beat_name, &bpm, &key, "mp3")),
        )?);
    }
    if let Some(ref src) = group.wav {
        m.wav = Some(mapped_or_copy(
            src, source_folder, &dest_folder,
            PathBuf::from(canonical_filename(beat_name, &bpm, &key, "wav")),
        )?);
    }
    if let Some(ref src) = group.loop_file {
        let ext = src.extension().unwrap_or_default().to_string_lossy();
        m.loop_path = Some(mapped_or_copy(
            src, source_folder, &dest_folder,
            PathBuf::from(format!("{} loop.{}", beat_name, ext)),
        )?);
    }
    if let Some(ref src) = group.stems {
        let fallback = if src.is_dir() {
            PathBuf::from(format!("{}_stems", beat_name))
        } else {
            let ext = src.extension().unwrap_or_default().to_string_lossy();
            PathBuf::from(format!("{}_stems.{}", beat_name, ext))
        };
        m.stems = Some(mapped_or_copy(src, source_folder, &dest_folder, fallback)?);
    }
    if let Some(ref src) = group.flp {
        let ext = src.extension().unwrap_or_default().to_string_lossy();
        m.flp = Some(mapped_or_copy(
            src, source_folder, &dest_folder,
            PathBuf::from(format!("{}.{}", beat_name, ext)),
        )?);
    }
    if let Some(ref src) = group.als {
        m.als = Some(mapped_or_copy(
            src, source_folder, &dest_folder,
            PathBuf::from(format!("{}.als", beat_name)),
        )?);
    }

    for src in &group.others {
        // Files already included by the complete-folder copy need no second copy.
        if let Some(root) = source_folder {
            if src.strip_prefix(root).ok().map(|rel| dest_folder.join(rel).exists()).unwrap_or(false) {
                continue;
            }
        }
        if let Some(fname) = src.file_name() {
            let destination = dest_folder.join(fname);
            if src.is_dir() {
                copy_dir_recursive(src, &destination)?;
            } else {
                std::fs::copy(src, destination).map_err(|e| format!("Copy additional file failed: {}", e))?;
            }
        }
    }

    // Re-scan the finished destination so folders copied wholesale (for
    // example Samples/Stems/Backup) are reflected in BeatMeta as well.
    let copied = scan_folder_structured(&dest_folder);
    if m.stems.is_none() { m.stems = copied.stems.first().cloned(); }
    if m.flp.is_none() { m.flp = copied.flps.first().cloned(); }
    if m.als.is_none() { m.als = copied.alss.first().cloned(); }

    Ok(m)
}

fn build_beat_from_confirmed(id: String, name: String, m: &MaterializedBeat, others: Vec<PathBuf>) -> BeatMeta {
    let (bpm, key, tags, rating, image_base64) = if let Some(p) = m.mp3.as_ref().or(m.wav.as_ref()) {
        read_id3(p)
    } else { (String::new(), String::new(), vec![], 0, None) };
    let (color, color2) = gradient_for(&name);
    let playback_path = m.wav.clone().or_else(|| m.mp3.clone())
        .map(|p| p.to_string_lossy().to_string()).unwrap_or_default();

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
        has_samples: has_samples_folder(&m.folder),
        samples_path: find_samples_folder(&m.folder).map(|p| p.to_string_lossy().to_string()),
        has_flp: m.flp.is_some(),
        has_als: m.als.is_some(),
        stems_path: m.stems.as_ref().map(|p| p.to_string_lossy().to_string()),
        flp_path: m.flp.as_ref().map(|p| p.to_string_lossy().to_string()),
        als_path: m.als.as_ref().map(|p| p.to_string_lossy().to_string()),
        other_files: paths_to_strings(&others),
        color, color2,
        has_loop: m.loop_path.is_some(),
        loop_path: m.loop_path.as_ref().map(|p| p.to_string_lossy().to_string()),
    }
}

/// Applies the user's decisions for a previously-previewed batch, then
/// materializes every resulting group (confirmed + user-assigned +
/// independent) into the vault and saves them to the DB. Also records every
/// decision in `import_decisions` so re-scans never ask about the same file
/// twice.
#[tauri::command]
pub fn resolve_import_decisions(
    batch_id: String,
    decisions: Vec<ImportDecisionInput>,
    state: tauri::State<DbState>,
    settings: tauri::State<SettingsState>,
    batches: tauri::State<ImportBatchState>,
) -> Result<Vec<BeatMeta>, String> {
    let mut batch = {
        let mut lock = batches.0.lock().map_err(|e| e.to_string())?;
        lock.remove(&batch_id).ok_or_else(|| "This import batch expired or was already resolved. Try importing again.".to_string())?
    };

    let conn = state.0.lock().map_err(|e| e.to_string())?;

    for d in &decisions {
        let hash = format!("{:x}", Sha256::digest(d.path.as_bytes()));
        conn.execute(
            "INSERT OR REPLACE INTO import_decisions (path_hash, file_path, decision, role, decided_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))",
            params![hash, d.path, d.action, d.role],
        ).map_err(|e| e.to_string())?;

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

    let source_folders = batch.source_folders;
    let mut imported = Vec::new();
    for (core_name, group) in batch.groups {
        if group.mp3.is_none() && group.wav.is_none() {
            continue; // nothing playable — don't create an empty beat
        }
        let display_name = titleize(&core_name);
        let source_folder = source_folders.get(&core_name).map(PathBuf::as_path);
        let materialized = materialize_confirmed_group(
            &group,
            &display_name,
            &settings.beats_dir(),
            source_folder,
        )?;
		normalize_folder_artwork(&materialized.folder);
        let id = make_id(&display_name, &materialized.folder.to_string_lossy());
        let beat = build_beat_from_confirmed(id, display_name, &materialized, group.others.clone());
        db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;
        imported.push(beat);
    }

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
