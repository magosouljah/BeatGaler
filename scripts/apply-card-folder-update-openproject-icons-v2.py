from pathlib import Path
import re, shutil, subprocess, sys

ROOT = Path.cwd()
COMMANDS = ROOT / "src-tauri" / "src" / "commands.rs"
LIBRS = ROOT / "src-tauri" / "src" / "lib.rs"
TAURI = ROOT / "src" / "lib" / "tauri.ts"
APP = ROOT / "src" / "App.tsx"
CARD = ROOT / "src" / "components" / "BeatCard.tsx"

TARGETS = [COMMANDS, LIBRS, TAURI, APP, CARD]

def fail(msg):
    print("[ERROR]", msg)
    sys.exit(1)

def backup(path):
    bak = Path(str(path) + ".pre-card-folder-update.bak")
    if not bak.exists():
        shutil.copy2(path, bak)

for p in TARGETS:
    if not p.exists():
        fail(f"Missing {p}")
    backup(p)

# ---------------- Rust ----------------
rust = COMMANDS.read_text(encoding="utf-8")

old = '''        Ok((raw, source_size)) => Some(json!({
            "manifest": serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
            "size": source_size.unwrap_or(0),
        })),'''
new = '''        Ok((raw, source_size)) => Some(json!({
            "manifest": serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
            "size": source_size.unwrap_or(0),
            "openable": beat.has_flp,
        })),'''
if old in rust:
    rust = rust.replace(old, new, 1)
    print("[OK] PROJECT manifest openable = real FLP")

old = 'has_flp: existing_local.as_ref().map(|b| b.has_flp).unwrap_or(false) || has_project,'
new = '''has_flp: existing_local.as_ref().map(|b| b.has_flp).unwrap_or(false)
            || entry.get("project")
                .and_then(|p| p.get("openable"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false),'''
if old in rust:
    rust = rust.replace(old, new, 1)
    print("[OK] Audio/Samples-only PROJECT no longer becomes has_flp on restore")

state_marker = 'pub struct ImportBatchState(pub Mutex<std::collections::HashMap<String, PendingImportBatch>>);'
if state_marker not in rust:
    fail("ImportBatchState marker not found")

helpers = r'''
fn next_import_display_name(conn: &Connection, base: &str) -> Result<String, String> {
    let mut used = std::collections::HashSet::<String>::new();

    for row in db_load_all(conn).map_err(|e| e.to_string())? {
        if let Some(meta) = db_meta(&row) {
            used.insert(normalized_beat_name_key(&meta.name));
        }
    }

    let mut stmt = conn.prepare("SELECT beat_name FROM trash").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    for row in rows {
        if let Ok(name) = row {
            used.insert(normalized_beat_name_key(&name));
        }
    }
    drop(stmt);

    if !used.contains(&normalized_beat_name_key(base)) {
        return Ok(base.to_string());
    }

    for n in 2..10000 {
        let candidate = format!("{}_{}", base, n);
        if !used.contains(&normalized_beat_name_key(&candidate)) {
            return Ok(candidate);
        }
    }

    Err(format!("Could not create a unique name for '{}'.", base))
}

fn copy_import_tree_without_backups(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;

    for entry in WalkDir::new(src).min_depth(1).into_iter().filter_map(Result::ok) {
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

'''
if "fn next_import_display_name" not in rust:
    rust = rust.replace(state_marker, helpers + state_marker, 1)
    print("[OK] duplicate normal-import helper added")

old_block = '''        let display_name = titleize(&core_name);
        let source_folder = source_folders.get(&core_name).map(PathBuf::as_path);
        let materialized = materialize_confirmed_group(
            &group,
            &display_name,
            &settings.beats_dir(),
            source_folder,
        )?;'''
new_block = '''        let base_display_name = titleize(&core_name);
        let display_name = next_import_display_name(&conn, &base_display_name)?;
        let source_folder = source_folders.get(&core_name).map(PathBuf::as_path);

        let materialized = if display_name != base_display_name {
            if let Some(source) = source_folder {
                materialize_duplicate_import_folder(source, &display_name, &settings.beats_dir())?
            } else {
                materialize_confirmed_group(
                    &group,
                    &display_name,
                    &settings.beats_dir(),
                    source_folder,
                )?
            }
        } else {
            materialize_confirmed_group(
                &group,
                &display_name,
                &settings.beats_dir(),
                source_folder,
            )?
        };'''
if old_block in rust:
    rust = rust.replace(old_block, new_block, 1)
    print("[OK] outside-card duplicate import -> BeatName_2 / _3")
elif "let base_display_name = titleize(&core_name);" not in rust:
    fail("resolve_import_decisions layout did not match")

# Remove old identity-preserving repair block from normal import path.
rust, n = re.subn(
    r'\n\s*// Same folder = same beat\..*?\n\s*db_upsert_with_order',
    '\n\n        db_upsert_with_order',
    rust,
    count=1,
    flags=re.S,
)
if n:
    print("[OK] outside-card duplicate import no longer inherits old Telegram MASTER")

preview_marker = '#[tauri::command]\npub fn preview_import_batch('
if preview_marker not in rust:
    fail("preview_import_batch marker not found")

folder_api = r'''
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
    let has_flp = files.flps.iter().any(|p| {
        p.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .eq_ignore_ascii_case("flp")
    });

    Ok(BeatFolderUpdatePreview {
        has_mp3: !files.mp3s.is_empty(),
        mp3_filename: files.mp3s.first()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string()),
        has_wav: !files.wavs.is_empty(),
        has_project_file: has_flp,
        has_project_assets: folder_has_project_assets(&folder),
    })
}

fn merge_tree_into_existing_beat(src: &Path, dst: &Path) -> Result<(), String> {
    if src == dst {
        return Ok(());
    }

    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;

    for entry in WalkDir::new(src).min_depth(1).into_iter().filter_map(Result::ok) {
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
        r#"SELECT b.meta_json
           FROM cloud_projects cp
           JOIN beats b ON b.id=cp.beat_id"#
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| row.get::<_, Option<String>>(0))
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let Some(raw) = row.map_err(|e| e.to_string())? else { continue; };
        let Ok(meta) = serde_json::from_str::<BeatMeta>(&raw) else { continue; };
        if meta.has_flp {
            out.push(meta.id);
        }
    }

    Ok(out)
}

'''
if "pub fn inspect_beat_update_folder" not in rust:
    rust = rust.replace(preview_marker, folder_api + preview_marker, 1)
    print("[OK] folder-on-card update commands added")

COMMANDS.write_text(rust, encoding="utf-8", newline="\n")

# ---------------- lib.rs ----------------
lib = LIBRS.read_text(encoding="utf-8")
for command in (
    "inspect_beat_update_folder",
    "merge_folder_into_existing_beat",
    "list_openable_cloud_project_beat_ids",
):
    if f"commands::{command}" in lib:
        continue

    # BeatGaler's current lib.rs imports commands into scope and its
    # generate_handler list may use either `preview_import_batch` or
    # `commands::preview_import_batch`. Support both layouts.
    candidates = [
        ("commands::preview_import_batch,", f"commands::{command},"),
        ("preview_import_batch,", command + ","),
    ]

    inserted = False
    for needle, rendered in candidates:
        if needle in lib:
            lib = lib.replace(needle, needle + f"\n            {rendered}", 1)
            inserted = True
            break

    if not inserted:
        # Final fallback: insert immediately after generate_handler![.
        # This avoids depending on any particular neighboring command.
        marker = "tauri::generate_handler!["
        if marker in lib:
            qualified = "commands::" in lib[lib.find(marker):lib.find(marker)+500]
            rendered = f"commands::{command}," if qualified else command + ","
            lib = lib.replace(marker, marker + f"\n            {rendered}", 1)
            inserted = True

    if not inserted:
        fail("Could not locate tauri::generate_handler![ in src-tauri/src/lib.rs")

    print("[OK] registered", command)

LIBRS.write_text(lib, encoding="utf-8", newline="\n")

# ---------------- tauri.ts ----------------
ts = TAURI.read_text(encoding="utf-8")
anchor = "export interface ImportBatchPreview {"
if anchor not in ts:
    fail("tauri.ts ImportBatchPreview anchor missing")

api = '''export interface BeatFolderUpdatePreview {
  has_mp3: boolean;
  mp3_filename: string | null;
  has_wav: boolean;
  has_project_file: boolean;
  has_project_assets: boolean;
}

export async function inspectBeatUpdateFolder(folderPath: string): Promise<BeatFolderUpdatePreview> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<BeatFolderUpdatePreview>("inspect_beat_update_folder", { folderPath });
}

export async function mergeFolderIntoExistingBeat(
  beat: Beat,
  folderPath: string,
  replaceMaster: boolean,
): Promise<Beat> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<Beat>("merge_folder_into_existing_beat", { beat, folderPath, replaceMaster });
}

export async function listOpenableCloudProjectBeatIds(): Promise<string[]> {
  await initTauri();
  if (!invoke) return [];
  return invoke<string[]>("list_openable_cloud_project_beat_ids");
}

export async function uploadProjectToTelegram(beat: Beat): Promise<void> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  await invoke("upload_project_to_telegram", { beat });
}

export async function syncBeatMetadataToTelegram(beat: Beat): Promise<void> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  await invoke("sync_beat_metadata_to_telegram", { beat });
}

export async function uploadDroppedFileToTelegram(
  beat: Beat,
  filePath: string,
  fileType: string,
): Promise<void> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  await invoke("upload_dropped_file_to_telegram", { beat, filePath, fileType });
}

'''
if "export interface BeatFolderUpdatePreview" not in ts:
    ts = ts.replace(anchor, api + anchor, 1)
    print("[OK] tauri.ts wrappers added")

TAURI.write_text(ts, encoding="utf-8", newline="\n")

# ---------------- BeatCard ----------------
card = CARD.read_text(encoding="utf-8")

if "BeatGalerIcon" not in card:
    anchor = 'import { useTagColors } from "../lib/tagColors";'
    if anchor not in card:
        fail("BeatCard import anchor missing")
    card = card.replace(anchor, anchor + '\nimport BeatGalerIcon from "./BeatGalerIcon";', 1)

if "openableProject: boolean;" not in card:
    card = card.replace(
        "showIncompleteWarnings: boolean;",
        "showIncompleteWarnings: boolean;\n  openableProject: boolean;",
        1,
    )

card = re.sub(
    r'(beat,\s*tagFrequency,\s*showIncompleteWarnings,)(?!\s*openableProject)',
    r'\1 openableProject,',
    card,
    count=1,
)

if "folderUpdateDragOver" not in card:
    card = card.replace(
        "const [imageDragOver, setImageDragOver] = useState(false);",
        "const [imageDragOver, setImageDragOver] = useState(false);\n"
        "  const [folderUpdateDragOver, setFolderUpdateDragOver] = useState(false);",
        1,
    )

    effect_anchor = "  useEffect(() => {\n    const handleNativeArtworkDrag"
    if effect_anchor in card:
        card = card.replace(
            effect_anchor,
            '''  useEffect(() => {
    const onBeatUpdateDrag = (event: Event) => {
      const detail = (event as CustomEvent<{ beatId: string | null; active: boolean }>).detail;
      setFolderUpdateDragOver(Boolean(detail?.active && detail?.beatId === beat.id));
    };
    window.addEventListener("beatgaler:beat-update-drag", onBeatUpdateDrag);
    return () => window.removeEventListener("beatgaler:beat-update-drag", onBeatUpdateDrag);
  }, [beat.id]);

''' + effect_anchor,
            1,
        )

if 'data-beat-card-id={beat.id}' not in card:
    card, n = re.subn(
        r'(<div\s*\n\s*ref=\{setNodeRef\})',
        r'\1\n      data-beat-card-id={beat.id}',
        card,
        count=1,
    )
    if not n:
        fail("Could not add data-beat-card-id to BeatCard root")

if "outline: folderUpdateDragOver" not in card:
    card = card.replace(
        'opacity: isDragging ? 0.72 : 1,',
        'opacity: isDragging ? 0.72 : 1,\n'
        '        outline: folderUpdateDragOver ? "2px solid #6f8f68" : "none",\n'
        '        outlineOffset: folderUpdateDragOver ? "4px" : "0px",',
        1,
    )

# Remove PNG cloud/box accidentally anchored beside title.
title_pos = card.find("{beat.name}")
if title_pos >= 0:
    title_end = card.find("</div>", title_pos)
    if title_end > title_pos:
        segment = card[title_pos:title_end]
        segment = re.sub(r'\s*<BeatGalerIcon\s+name="(?:cloud|box)"[^>]*/>', "", segment)
        card = card[:title_pos] + segment + card[title_end:]

status_row = '''{(beat.rating > 0 || Boolean(beat.telegram_file_id) || openableProject) && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4, minHeight: 10 }}>
            {beat.rating > 0 && (
              <div style={{ display: "flex", gap: 2 }}>
                {[1,2,3,4,5].map(i => (
                  <span key={i} style={{ color: i <= beat.rating ? "#555" : "#242424", fontSize: 8 }}>★</span>
                ))}
              </div>
            )}
            {beat.telegram_file_id && <BeatGalerIcon name="cloud" size={12} title="MASTER in Cloud" />}
            {openableProject && <BeatGalerIcon name="box" size={12} title="Open Project available" />}
          </div>
        )}'''

star_start = card.find("{beat.rating > 0 && (")
if star_start >= 0:
    # Find the next tags block as stable boundary and replace only the rating block.
    tags_boundary = card.find("{sortedTags.length", star_start)
    if tags_boundary < 0:
        tags_boundary = card.find("{beat.tags", star_start)

    if tags_boundary > star_start:
        region = card[star_start:tags_boundary]
        # Use balanced braces/parens approximately by finding first "\n        )}".
        end = region.find("\n        )}")
        if end >= 0:
            end += len("\n        )}")
            card = card[:star_start] + status_row + region[end:] + card[tags_boundary:]
        else:
            fail("Could not close BeatCard rating block")
else:
    if 'title="Open Project available"' not in card:
        fail("BeatCard rating block not found")

CARD.write_text(card, encoding="utf-8", newline="\n")
print("[OK] cloud/box anchored beside star row; Box requires synced PROJECT + FLP")

# ---------------- App ----------------
app = APP.read_text(encoding="utf-8")

if "openableCloudProjectIds" not in app:
    m = re.search(r'const \[beats,\s*setBeats\][^;]*;', app)
    if not m:
        fail("beats state not found")
    app = app[:m.end()] + \
        '\n  const [openableCloudProjectIds, setOpenableCloudProjectIds] = useState<Set<string>>(new Set());' + \
        app[m.end():]

if "refreshOpenableCloudProjects" not in app:
    marker = "  const updateBeat = useCallback"
    if marker not in app:
        fail("updateBeat marker not found")
    block = '''  const refreshOpenableCloudProjects = useCallback(async () => {
    try {
      const t = await import("./lib/tauri");
      const ids = await t.listOpenableCloudProjectBeatIds();
      setOpenableCloudProjectIds(new Set(ids));
    } catch (error) {
      console.warn("Could not refresh Open Project indicators", error);
    }
  }, []);

  useEffect(() => {
    void refreshOpenableCloudProjects();
  }, [beats, refreshOpenableCloudProjects]);

'''
    app = app.replace(marker, block + marker, 1)

if "updateExistingBeatFromFolder" not in app:
    marker = "  useEffect(() => {\n    if (!isTauriAvailable) return;"
    if marker not in app:
        fail("native drag effect marker not found")

    handler = '''  const updateExistingBeatFromFolder = useCallback(async (beat: Beat, folderPath: string): Promise<boolean> => {
    const t = await import("./lib/tauri");

    let preview;
    try {
      preview = await t.inspectBeatUpdateFolder(folderPath);
    } catch {
      return false;
    }

    let replaceMaster = false;
    if (preview.has_mp3) {
      const alreadyHasMaster = Boolean(beat.telegram_file_id) || Boolean(beat.mp3_path?.trim());
      if (alreadyHasMaster) {
        const incoming = preview.mp3_filename || "the incoming MP3";
        const confirmed = window.confirm(
          `Replace current MASTER for "${beat.name}"?\\n\\n` +
          `${incoming} will become the new MASTER.\\n` +
          `Its BPM, key, tags, rating and artwork will replace the current metadata.\\n\\n` +
          `WAV and project files from this folder will also be added or updated.`
        );
        if (!confirmed) return true;
      }
      replaceMaster = true;
    }

    try {
      let updated = await t.mergeFolderIntoExistingBeat(beat, folderPath, replaceMaster);
      setBeats(bs => bs.map(b => b.id === beat.id ? updated : b));

      if (replaceMaster) {
        updated = await t.uploadBeatToTelegram(updated);
        setBeats(bs => bs.map(b => b.id === beat.id ? updated : b));
      }

      if (preview.has_wav && updated.wav_path) {
        await t.uploadDroppedFileToTelegram(updated, updated.wav_path, "WAV");
      }

      if (preview.has_project_assets) {
        await t.uploadProjectToTelegram(updated);
      }

      if (replaceMaster && updated.telegram_file_id) {
        await t.syncBeatMetadataToTelegram(updated);
      }

      await refreshOpenableCloudProjects();
      setBeats(bs => bs.map(b => b.id === beat.id ? updated : b));
      return true;
    } catch (error) {
      console.error(error);
      alert(`Could not update "${beat.name}" from the dropped folder: ${String(error)}`);
      return true;
    }
  }, [refreshOpenableCloudProjects]);

'''
    app = app.replace(marker, handler + marker, 1)
    print("[OK] folder-on-card update pipeline added")

# Add a card hit-test helper inside the native drag effect.
if "beatCardElementAt" not in app:
    payload = "const payload = event.payload as any;"
    if payload not in app:
        fail("drag payload marker missing")
    helper = '''const payload = event.payload as any;

          const beatCardElementAt = (position: { x: number; y: number }) => {
            const scale = window.devicePixelRatio || 1;
            const direct = document.elementFromPoint(position.x, position.y) as HTMLElement | null;
            const directCard = direct?.closest?.("[data-beat-card-id]") as HTMLElement | null;
            if (directCard) return directCard;

            const scaled = document.elementFromPoint(position.x / scale, position.y / scale) as HTMLElement | null;
            return scaled?.closest?.("[data-beat-card-id]") as HTMLElement | null;
          };'''
    app = app.replace(payload, helper, 1)

# Hover route.
m = re.search(
    r'if \(payload\.type === "enter" \|\| payload\.type === "over"\) \{([\s\S]*?)\n\s*\} else if \(payload\.type === "leave"\)',
    app,
)
if m and "beatgaler:beat-update-drag" not in m.group(1):
    body = m.group(1) + '''
            const cardEl = payload.position ? beatCardElementAt(payload.position) : null;
            const cardBeatId = cardEl?.getAttribute("data-beat-card-id") || null;
            window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", {
              detail: { beatId: cardBeatId, active: Boolean(cardBeatId) }
            }));'''
    app = app[:m.start(1)] + body + app[m.end(1):]

m = re.search(
    r'else if \(payload\.type === "leave"\) \{([\s\S]*?)\n\s*\} else if \(payload\.type === "drop"\)',
    app,
)
if m and "beatgaler:beat-update-drag" not in m.group(1):
    body = m.group(1) + '''
            window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", {
              detail: { beatId: null, active: false }
            }));'''
    app = app[:m.start(1)] + body + app[m.end(1):]

# Drop route. Handle the existing global import call in the drop branch.
m = re.search(
    r'else if \(payload\.type === "drop"\) \{([\s\S]*?)\n\s*\}',
    app,
)
if m and "updateExistingBeatFromFolder" not in m.group(1):
    body = m.group(1)
    call = re.search(r'void importDroppedPaths\([^;]+?\);', body, re.S)
    if call:
        replacement = '''const droppedPaths = Array.isArray(payload.paths) ? payload.paths : [];
            const cardEl = payload.position ? beatCardElementAt(payload.position) : null;
            const cardBeatId = cardEl?.getAttribute("data-beat-card-id") || null;

            window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", {
              detail: { beatId: null, active: false }
            }));

            if (cardBeatId && droppedPaths.length === 1) {
              const targetBeat = beats.find(b => b.id === cardBeatId);
              if (targetBeat) {
                void (async () => {
                  const consumed = await updateExistingBeatFromFolder(targetBeat, droppedPaths[0]);
                  if (!consumed) await importDroppedPaths(droppedPaths);
                })();
              } else {
                void importDroppedPaths(droppedPaths);
              }
            } else {
              void importDroppedPaths(droppedPaths);
            }'''
        body = body[:call.start()] + replacement + body[call.end():]
        app = app[:m.start(1)] + body + app[m.end(1):]
        print("[OK] folder dropped on card updates existing beat")
    else:
        print("[WARN] Could not patch native drop call automatically")

# Effect deps.
app = app.replace(
    "}, [importDroppedPaths]);",
    "}, [beats, importDroppedPaths, updateExistingBeatFromFolder]);",
    1,
)

if "openableProject={openableCloudProjectIds.has(beat.id)}" not in app:
    app, n = re.subn(
        r'(\s+beat=\{beat\}\s*\n)',
        r'\1                    openableProject={openableCloudProjectIds.has(beat.id)}\n',
        app,
        count=1,
    )
    if not n:
        fail("Could not pass openableProject into BeatCard")

APP.write_text(app, encoding="utf-8", newline="\n")

# ---------------- validation ----------------
npm = "npm.cmd" if sys.platform.startswith("win") else "npm"
print()
print("Running npm run build...")
if subprocess.run([npm, "run", "build"]).returncode != 0:
    fail("npm build failed. Backups remain as *.pre-card-folder-update.bak")

print()
print("Running cargo check...")
if subprocess.run(["cargo", "check", "--manifest-path", str(ROOT/"src-tauri"/"Cargo.toml")]).returncode != 0:
    fail("cargo check failed. Backups remain as *.pre-card-folder-update.bak")

print()
print("[OK] Card Folder Update + Open Project icon pass complete.")
print("Run: npm run tauri dev")
