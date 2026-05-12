use base64::{engine::general_purpose, Engine};
use id3::{Tag, TagLike, Version, frame};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use walkdir::WalkDir;

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
    pub tags: Vec<String>,
    pub rating: u8,
    pub image_base64: Option<String>,
    pub has_wav: bool,
    pub has_stems: bool,
    pub has_flp: bool,
    pub has_als: bool,
    pub stems_path: Option<String>,
    pub flp_path: Option<String>,
    pub als_path: Option<String>,
    pub other_files: Vec<String>, // mp3/wav that don't match the beat name
    pub color: String,
    pub color2: String,
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
}

impl Default for AppSettings {
    fn default() -> Self { Self { beats_folder: None } }
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

fn move_path_into(src: &Path, dest: &Path) -> Result<(), String> {
    match std::fs::rename(src, dest) {
        Ok(_) => Ok(()),
        Err(_) => {
            if src.is_dir() {
                copy_dir_recursive(src, dest)?;
                std::fs::remove_dir_all(src).map_err(|e| format!("Remove old dir failed: {}", e))
            } else {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("Create dir failed: {}", e))?;
                }
                std::fs::copy(src, dest).map_err(|e| format!("Copy failed: {}", e))?;
                std::fs::remove_file(src).map_err(|e| format!("Remove old file failed: {}", e))?;
                Ok(())
            }
        }
    }
}

fn migrate_library_root(old_root: &Path, new_root: &Path, conn: &Connection) -> Result<(), String> {
    let old_canon = old_root.canonicalize().unwrap_or_else(|_| old_root.to_path_buf());
    let new_canon = new_root.canonicalize().unwrap_or_else(|_| new_root.to_path_buf());
    if old_canon == new_canon {
        return Ok(());
    }
    if new_canon.starts_with(&old_canon) || old_canon.starts_with(&new_canon) {
        return Err("Choose a folder outside the current BeatVault folder tree.".to_string());
    }

    std::fs::create_dir_all(new_root).map_err(|e| format!("Cannot create destination folder: {}", e))?;

    let db_rows = db_load_all(conn).map_err(|e| e.to_string())?;
    let mut moved_folders = std::collections::HashMap::<String, String>::new();

    if old_root.exists() {
        for entry in std::fs::read_dir(old_root).map_err(|e| format!("Read dir failed: {}", e))? {
            let entry = entry.map_err(|e| format!("Read dir entry failed: {}", e))?;
            let src_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let dest_path = unique_folder_path(new_root, &name);
            move_path_into(&src_path, &dest_path)?;
            moved_folders.insert(
                src_path.to_string_lossy().to_string(),
                dest_path.to_string_lossy().to_string(),
            );
        }
    }

    for row in db_rows {
        let Some(new_folder) = moved_folders.get(&row.folder_path) else { continue; };
        let new_folder_path = PathBuf::from(new_folder);
        let stored_mp3 = PathBuf::from(&row.mp3_path);
        let candidate_mp3 = stored_mp3
            .file_name()
            .map(|name| new_folder_path.join(name))
            .filter(|path| path.exists());
        let files = scan_folder_structured(&new_folder_path);
        let new_mp3 = candidate_mp3.or_else(|| files.mp3s.first().cloned()).unwrap_or_default();
        conn.execute(
            "UPDATE beats SET folder_path=?1, mp3_path=?2 WHERE id=?3",
            params![new_folder, new_mp3.to_string_lossy().to_string(), row.id],
        ).map_err(|e| e.to_string())?;
    }

    if old_root.exists() {
        let _ = std::fs::remove_dir(old_root);
    }

    Ok(())
}

#[tauri::command]
pub fn get_settings(state: tauri::State<SettingsState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
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
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        migrate_library_root(&old_root, &new_root, &conn)?;
    }

    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.beats_folder = Some(folder);
    save_settings_file(&state.data_dir, &*s)
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
        let re_bpm_key = regex_lite::Regex::new(r"^(\d{2,3})\s+([A-Ga-g][b#]?m?)$").unwrap();
        if let Some(m) = re_bpm_key.captures(inner) {
            return (Some(m[1].to_string()), Some(m[2].to_string()));
        }
        let re_key_bpm = regex_lite::Regex::new(r"^([A-Ga-g][b#]?m?)\s+(\d{2,3})$").unwrap();
        if let Some(m) = re_key_bpm.captures(inner) {
            return (Some(m[2].to_string()), Some(m[1].to_string()));
        }
    }
    (None, None)
}

/// Strip ANY [BPM Key] style bracket from a stem, return clean name
pub fn clean_name_from_filename(filename: &str) -> String {
    let stem = if let Some(dot) = filename.rfind('.') { &filename[..dot] } else { filename };
    // Accept both naming conventions inside brackets: [137 A] and [A 137].
    let re = regex_lite::Regex::new(r"\s*\[(?:\d{2,3}\s+[A-Ga-g][b#]?m?|[A-Ga-g][b#]?m?\s+\d{2,3})\]").unwrap();
    re.replace_all(stem, "").trim().to_string()
}

pub fn format_bpm_key_suffix(bpm: &str, key: &str) -> String {
    if bpm.is_empty() && key.is_empty() { return String::new(); }
    if bpm.is_empty() { return format!("[{}]", key); }
    if key.is_empty() { return format!("[{}]", bpm); }
    format!("[{} {}]", bpm, key)
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
            added_at    INTEGER DEFAULT (strftime('%s','now'))
        );
    ")?;
    let _ = conn.execute("ALTER TABLE beats ADD COLUMN sort_order INTEGER DEFAULT 0", []);
    Ok(conn)
}

struct DbBeat { id: String, mp3_path: String, folder_path: String, color: String, color2: String, sort_order: i64 }

fn db_load_all(conn: &Connection) -> rusqlite::Result<Vec<DbBeat>> {
    let mut stmt = conn.prepare(
        "SELECT id, mp3_path, folder_path, color, color2, sort_order FROM beats ORDER BY sort_order ASC, added_at DESC")?;
    let rows = stmt.query_map([], |r| Ok(DbBeat {
        id: r.get(0)?, mp3_path: r.get(1)?, folder_path: r.get(2)?,
        color: r.get(3)?, color2: r.get(4)?, sort_order: r.get(5)?,
    }))?;
    rows.collect()
}

fn db_save(conn: &Connection, b: &BeatMeta) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO beats (id, mp3_path, folder_path, color, color2, sort_order)\n         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT sort_order FROM beats WHERE id=?1), 0))\n         ON CONFLICT(id) DO UPDATE SET\n           mp3_path=excluded.mp3_path,\n           folder_path=excluded.folder_path,\n           color=excluded.color,\n           color2=excluded.color2",
        params![b.id, b.mp3_path, b.folder_path, b.color, b.color2],
    )?;
    Ok(())
}

fn db_upsert_with_order(conn: &Connection, b: &BeatMeta, sort_order: Option<i64>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO beats (id, mp3_path, folder_path, color, color2, sort_order)\n         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 0))\n         ON CONFLICT(id) DO UPDATE SET\n           mp3_path=excluded.mp3_path,\n           folder_path=excluded.folder_path,\n           color=excluded.color,\n           color2=excluded.color2",
        params![b.id, b.mp3_path, b.folder_path, b.color, b.color2, sort_order],
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
        let files = scan_folder_structured(folder);
        if files.mp3s.is_empty() && files.wavs.is_empty() { continue; }

        let folder_str = folder.to_string_lossy().to_string();
        seen_folders.insert(folder_str.clone());

        let beat = if let Some(existing) = by_folder.get(&folder_str) {
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
            );
            db_upsert_with_order(conn, &built, Some(existing.sort_order)).map_err(|e| e.to_string())?;
            built
        } else {
            let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
            let name = clean_name_from_filename(&folder_name);
            let (color, color2) = gradient_for(&name);
            let id = make_id(&name, &folder_str);
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

    let bpm_tag = tag.get("TBPM").and_then(|f| f.content().text()).unwrap_or("").trim().to_string();
    let key_tag = tag.get("TKEY").and_then(|f| f.content().text()).unwrap_or("").trim().to_string();

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

fn write_id3_to(path: &Path, bpm: &str, key: &str, tags: &[String], rating: u8, image_base64: Option<&str>) -> Result<(), String> {
    let mut tag = Tag::read_from_path(path).unwrap_or_default();

    tag.remove("TBPM");
    if !bpm.is_empty() { tag.set_text("TBPM", bpm); }
    tag.remove("TKEY");
    if !key.is_empty() { tag.set_text("TKEY", key); }
    tag.remove("TCON");
    if !tags.is_empty() { tag.set_genre(tags.join("; ")); }
    tag.remove("POPM");
    {
        let raw: u8 = match rating { 0=>0, 1=>1, 2=>64, 3=>128, 4=>192, _=>255 };
        tag.add_frame(id3::Frame::with_content("POPM",
            id3::Content::Popularimeter(id3::frame::Popularimeter {
                user: "BeatVault".to_string(), rating: raw, counter: 0,
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
    tag.write_to_path(path, Version::Id3v24).map_err(|e| format!("ID3 write failed: {}", e))
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
    let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    let clean_folder = clean_name_from_filename(&folder_name).to_lowercase();

    let mut mp3s = vec![];
    let mut wavs = vec![];
    let mut stems = vec![];
    let mut flps = vec![];
    let mut alss = vec![];
    let mut others = vec![];

    if let Ok(rd) = folder.read_dir() {
        for e in rd.flatten() {
            let meta = e.metadata().unwrap_or_else(|_| e.path().metadata().unwrap());
            let n = e.file_name().to_string_lossy().to_lowercase();
            let p = e.path();

            // Stems folder detection
            if meta.is_dir() && n.contains("stem") {
                stems.push(p);
                continue;
            }
            if !meta.is_file() { continue; }

            if n.ends_with(".mp3") || n.ends_with(".wav") {
                let stem_clean = clean_name_from_filename(&n).to_lowercase();
                // Strict match: the clean file name must equal the clean folder name
                let is_main = stem_clean == clean_folder;
                if n.ends_with(".mp3") {
                    if is_main { mp3s.push(p); } else { others.push(p); }
                } else {
                    if is_main { wavs.push(p); } else { others.push(p); }
                }
            } else if n.ends_with(".zip") && n.contains("stem") {
                stems.push(p);
            } else if n.ends_with(".flp") {
                flps.push(p);
            } else if n.ends_with(".als") {
                alss.push(p);
            } else if n.ends_with(".zip") && (n.contains("flp") || n.contains("project")) {
                // Only treat a zip as FLP if it was explicitly named as such
                flps.push(p);
            }
            // plain .zip files that aren't stems or flp are ignored
        }
    }
    mp3s.sort(); wavs.sort(); stems.sort(); flps.sort(); alss.sort(); others.sort();
    FolderFiles { mp3s, wavs, stems, flps, alss, others }
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
) -> BeatMeta {
    // Name from folder (clean)
    let folder_name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
    let name = clean_name_from_filename(&folder_name);

    // Read metadata — prefer MP3 tags, fallback to WAV, fallback to filename
    let (bpm, key, tags, rating, image_base64) = if let Some(p) = mp3.or(wav) {
        read_id3(p)
    } else {
        let (b, k) = parse_bpm_key_from_filename(&folder_name);
        (b.unwrap_or_default(), k.unwrap_or_default(), vec![], 0, None)
    };

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

    BeatMeta {
        id, name,
        folder_path: folder.to_string_lossy().to_string(),
        mp3_path: mp3.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        wav_path: wav.map(|p| p.to_string_lossy().to_string()),
        playback_path,
        bpm, key, tags, rating, image_base64,
        has_wav: wav.is_some(),
        has_stems: stems.is_some(),
        has_flp: flp.is_some(),
        has_als: als.is_some(),
        stems_path: stems.map(|p| p.to_string_lossy().to_string()),
        flp_path: flp.map(|p| p.to_string_lossy().to_string()),
        als_path: als.map(|p| p.to_string_lossy().to_string()),
        other_files: paths_to_strings(&others),
        color, color2,
    }
}

fn build_from_disk(db: DbBeat) -> Option<BeatMeta> {
    let mp3 = PathBuf::from(&db.mp3_path);
    let folder = PathBuf::from(&db.folder_path);
    if !folder.exists() { return None; }

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

    for entry in WalkDir::new(&base).min_depth(1).max_depth(1) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_dir() { continue; }
        let bf = entry.path();
        let imported_folder = ensure_folder_in_library(bf, &settings.beats_dir())?;
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
        );
        db_upsert_with_order(&conn, &beat, None).map_err(|e| e.to_string())?;
        beats.push(beat);
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

    for entry in WalkDir::new(&base).min_depth(1).max_depth(1) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_dir() { continue; }
        let bf = entry.path();
        let files = scan_folder_structured(bf);
        if files.mp3s.is_empty() && files.wavs.is_empty() { continue; }

        let folder_name = bf.file_name().unwrap_or_default().to_string_lossy().to_string();
        let name = clean_name_from_filename(&folder_name);
        let (color, color2) = gradient_for(&name);
        let folder_str = bf.to_string_lossy().to_string();
        let id = make_id(&name, &folder_str);

        let beat = build_beat_from_parts(
            id, bf,
            files.mp3s.first().map(|p| p.as_path()),
            files.wavs.first().map(|p| p.as_path()),
            files.stems.first().map(|p| p.as_path()),
            files.flps.first().map(|p| p.as_path()),
            files.alss.first().map(|p| p.as_path()),
            &files.others, color, color2,
        );
        beats.push(beat);
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
        let bf = PathBuf::from(&folder_path);
        if !bf.exists() { continue; }
        let imported_folder = ensure_folder_in_library(&bf, &settings.beats_dir())?;
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
    let source_folder = path.parent().unwrap_or(Path::new("")).to_path_buf();
    let folder = ensure_folder_in_library(&source_folder, &settings.beats_dir())?;
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

    // Write tags to MP3
    if let Some(ref p) = mp3 {
        if p.exists() {
            write_id3_to(p, &payload.bpm, &payload.key, &payload.tags, payload.rating, payload.image_base64.as_deref())?;
        }
    }
    // Write tags to WAV too — same metadata
    if let Some(ref p) = wav {
        if p.exists() {
            // Best-effort: WAV ID3 may fail silently
            let _ = write_id3_to(p, &payload.bpm, &payload.key, &payload.tags, payload.rating, payload.image_base64.as_deref());
        }
    }

    // Update filenames if requested
    if payload.update_filename {
        let (new_mp3, new_wav) = update_audio_filenames(mp3.as_deref(), wav.as_deref(), &payload.bpm, &payload.key)?;
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

    if !folder_path.trim().is_empty() {
        let beat_folder = PathBuf::from(&folder_path);
        if beat_folder.exists() {
            if beat_folder.is_dir() {
                std::fs::remove_dir_all(&beat_folder).map_err(|e| format!("Delete folder failed: {}", e))?;
            } else {
                std::fs::remove_file(&beat_folder).map_err(|e| format!("Delete file failed: {}", e))?;
            }
        }
    } else if !mp3_path.trim().is_empty() {
        let mp3 = PathBuf::from(&mp3_path);
        if mp3.exists() {
            std::fs::remove_file(&mp3).map_err(|e| format!("Delete file failed: {}", e))?;
            if let Some(parent) = mp3.parent() {
                let beats_root = settings.beats_dir();
                if parent.starts_with(&beats_root) {
                    let _ = std::fs::remove_dir(parent);
                }
            }
        }
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM beats WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
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

fn make_id(name: &str, folder: &str) -> String {
    format!("{}_{}", name.replace(|c: char| !c.is_alphanumeric(), "_"), folder.len())
}
