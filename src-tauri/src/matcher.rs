// ─────────────────────────────────────────────────────────────
//  matcher.rs — Fuzzy grouping engine for multi-root beat import
// ─────────────────────────────────────────────────────────────
//
// Responsible for taking a flat list of discovered files/folders
// (audio, flp/als, stems folders, loops) gathered from ANY number
// of source roots, and grouping them into beats:
//   - 100% core-name match  -> grouped automatically
//   - below 100%, above floor -> queued as a PendingDecision for
//     the user to confirm (which beat, which role) during import
//   - below floor -> treated as an unrelated, independent item
//
// This module has NO Tauri dependencies — it's pure logic so it's
// easy to unit test. commands.rs wires it into the actual
// filesystem + DB + Tauri commands.

use std::path::{Path, PathBuf};
use crate::{clean_name_from_filename};

// Below this score we don't even bother asking the user — too much noise.
pub const MATCH_FLOOR: f32 = 35.0;

// ── Role of a discovered file relative to a beat ──
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileRole {
    Mp3,
    Wav,
    Loop,
    Stems,
    Flp,
    Als,
    Other,
}

use serde::{Deserialize, Serialize};

impl FileRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            FileRole::Mp3 => "mp3",
            FileRole::Wav => "wav",
            FileRole::Loop => "loop",
            FileRole::Stems => "stems",
            FileRole::Flp => "flp",
            FileRole::Als => "als",
            FileRole::Other => "other",
        }
    }
    pub fn from_str(s: &str) -> FileRole {
        match s {
            "mp3" => FileRole::Mp3,
            "wav" => FileRole::Wav,
            "loop" => FileRole::Loop,
            "stems" => FileRole::Stems,
            "flp" => FileRole::Flp,
            "als" => FileRole::Als,
            _ => FileRole::Other,
        }
    }
}

// A single item discovered on disk before it's grouped into a beat.
#[derive(Debug, Clone)]
pub struct DiscoveredItem {
    pub path: PathBuf,
    pub is_dir: bool,
    pub raw_name: String,        // filename or folder name, no extension
    pub core_name: String,       // normalized, role-words stripped
    pub role_hint: Option<FileRole>, // guessed role purely from naming pattern
}

// A file the user needs to confirm during import.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingDecision {
    pub path: String,
    pub display_name: String,
    pub suggested_beat_name: String, // best-guess beat this might belong to
    pub suggested_role: String,      // best-guess role ("loop", "flp", etc.)
    pub score: f32,                  // 0-100 similarity to the suggested beat
}

// A beat assembled purely by 100%-confidence grouping (no user input needed yet).
#[derive(Debug, Clone, Default)]
pub struct ConfirmedGroup {
    pub core_name: String,
    pub mp3: Option<PathBuf>,
    pub wav: Option<PathBuf>,
    pub loop_file: Option<PathBuf>,
    pub stems: Option<PathBuf>,
    pub flp: Option<PathBuf>,
    pub als: Option<PathBuf>,
    pub others: Vec<PathBuf>,
}

// ─────────────────────────────────────────────────────────────
//  Normalization
// ─────────────────────────────────────────────────────────────

const NOISE_WORDS: &[&str] = &[
    "final", "master", "mix", "mixed", "wip", "v1", "v2", "v3",
    "copy", "new", "old", "backup",
];

const LOOP_WORDS: &[&str] = &["loop", "lp", "l"];
const STEMS_WORDS: &[&str] = &["stems", "stem"];

/// Strip bracketed [BPM Key] tags (reuses existing filename logic),
/// then strip noise/role words, collapse whitespace, lowercase.
/// Returns (core_name, role_hint_detected_from_words)
pub fn normalize_core_name(raw: &str) -> (String, Option<FileRole>) {
    let clean = clean_name_from_filename(raw); // strips [BPM Key]
    let mut role_hint = None;

    let tokens: Vec<&str> = clean.split(|c: char| c == ' ' || c == '-' || c == '_' || c == '(' || c == ')')
        .filter(|s| !s.is_empty())
        .collect();

    let mut kept: Vec<String> = Vec::new();
    for tok in &tokens {
        let lower = tok.to_lowercase();
        if LOOP_WORDS.contains(&lower.as_str()) {
            role_hint = Some(FileRole::Loop);
            continue; // drop the word from the core name
        }
        if STEMS_WORDS.contains(&lower.as_str()) {
            role_hint = Some(FileRole::Stems);
            continue;
        }
        if NOISE_WORDS.contains(&lower.as_str()) {
            continue;
        }
        kept.push(lower);
    }

    (kept.join(" ").trim().to_string(), role_hint)
}

// ─────────────────────────────────────────────────────────────
//  Similarity scoring
// ─────────────────────────────────────────────────────────────

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (la, lb) = (a.len(), b.len());
    if la == 0 { return lb; }
    if lb == 0 { return la; }

    let mut prev: Vec<usize> = (0..=lb).collect();
    let mut curr = vec![0usize; lb + 1];

    for i in 1..=la {
        curr[0] = i;
        for j in 1..=lb {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[lb]
}

/// 0-100 similarity score between two already-normalized core names.
/// Combines edit-distance ratio with a substring-containment bonus.
pub fn similarity_score(a: &str, b: &str) -> f32 {
    if a.is_empty() || b.is_empty() { return 0.0; }
    if a == b { return 100.0; }

    let dist = levenshtein(a, b) as f32;
    let max_len = a.chars().count().max(b.chars().count()) as f32;
    let edit_ratio = (1.0 - dist / max_len).max(0.0) * 100.0;

    let contains_bonus = if a.contains(b) || b.contains(a) { 15.0 } else { 0.0 };

    (edit_ratio + contains_bonus).min(99.0) // never let a non-exact match masquerade as 100
}

// ─────────────────────────────────────────────────────────────
//  Grouping
// ─────────────────────────────────────────────────────────────

/// Guess a role purely from file extension when no role word was found in the name.
fn role_from_extension(path: &Path) -> Option<FileRole> {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase())?;
    match ext.as_str() {
        "mp3" => Some(FileRole::Mp3),
        "wav" => Some(FileRole::Wav),
        "flp" => Some(FileRole::Flp),
        "als" => Some(FileRole::Als),
        _ => None,
    }
}

/// Build a DiscoveredItem from any path (file or folder) found during the scan.
pub fn make_discovered_item(path: PathBuf, is_dir: bool) -> DiscoveredItem {
    let raw_name = if is_dir {
        path.file_name().unwrap_or_default().to_string_lossy().to_string()
    } else {
        path.file_stem().unwrap_or_default().to_string_lossy().to_string()
    };
    let (core_name, word_role) = normalize_core_name(&raw_name);

    // Folder named literally "stems"/"stem" (with nothing else) has no useful
    // core name of its own — it belongs to whatever beat folder contains it,
    // handled separately in commands.rs (same-folder case). Here we only deal
    // with cross-folder loose matching.
    let role_hint = word_role.or_else(|| if is_dir { Some(FileRole::Stems) } else { role_from_extension(&path) });

    DiscoveredItem { path, is_dir, raw_name, core_name, role_hint }
}

/// Groups discovered items into confirmed beats (100% core match) and a list
/// of items that need user confirmation (below 100%, above MATCH_FLOOR).
///
/// `existing_core_names` lets us also match new loose files against beats
/// that are ALREADY in the library (not just against each other in this batch).
pub fn group_discovered_items(
    items: Vec<DiscoveredItem>,
    existing_core_names: &[String],
) -> (Vec<ConfirmedGroup>, Vec<PendingDecision>) {
    // 1. Bucket exact core-name matches together.
    use std::collections::HashMap;
    let mut buckets: HashMap<String, Vec<DiscoveredItem>> = HashMap::new();
    for item in items {
        buckets.entry(item.core_name.clone()).or_default().push(item);
    }

    let mut confirmed: Vec<ConfirmedGroup> = Vec::new();
    let mut leftovers: Vec<DiscoveredItem> = Vec::new();

    for (core_name, group_items) in buckets {
        // A bucket with a real (non-empty) core name that matches an existing
        // beat's core name 100%, or is internally consistent, becomes confirmed.
        if core_name.is_empty() {
            leftovers.extend(group_items);
            continue;
        }
        let mut group = ConfirmedGroup { core_name: core_name.clone(), ..Default::default() };
        let mut assigned_any = false;

        for item in group_items {
            let role = item.role_hint.unwrap_or(FileRole::Other);
            match role {
                FileRole::Mp3 if group.mp3.is_none() => { group.mp3 = Some(item.path); assigned_any = true; }
                FileRole::Wav if group.wav.is_none() => { group.wav = Some(item.path); assigned_any = true; }
                FileRole::Loop if group.loop_file.is_none() => { group.loop_file = Some(item.path); assigned_any = true; }
                FileRole::Stems if group.stems.is_none() => { group.stems = Some(item.path); assigned_any = true; }
                FileRole::Flp if group.flp.is_none() => { group.flp = Some(item.path); assigned_any = true; }
                FileRole::Als if group.als.is_none() => { group.als = Some(item.path); assigned_any = true; }
                _ => {
                    // Slot already taken or no clear role -> park it as a
                    // candidate for the ambiguity pass below, not lost.
                    leftovers.push(DiscoveredItem {
                        path: item.path.clone(), is_dir: item.is_dir,
                        raw_name: item.raw_name, core_name: core_name.clone(), role_hint: item.role_hint,
                    });
                }
            }
        }

        if assigned_any {
            confirmed.push(group);
        }
    }

    // 2. Build the list of known beat names to compare leftovers against:
    // beats we just confirmed in this batch + beats already in the library.
    let mut known_names: Vec<String> = confirmed.iter().map(|g| g.core_name.clone()).collect();
    known_names.extend(existing_core_names.iter().cloned());
    known_names.sort();
    known_names.dedup();

    // 3. Score every leftover against every known beat name; keep the best.
    let mut pending: Vec<PendingDecision> = Vec::new();
    for item in leftovers {
        let mut best_name = String::new();
        let mut best_score = 0.0f32;
        for name in &known_names {
            let score = similarity_score(&item.core_name, name);
            if score > best_score {
                best_score = score;
                best_name = name.clone();
            }
        }

        if best_score < MATCH_FLOOR {
            // Genuinely unrelated — import it later as its own independent beat,
            // not part of this decision queue.
            continue;
        }

        pending.push(PendingDecision {
            path: item.path.to_string_lossy().to_string(),
            display_name: item.raw_name.clone(),
            suggested_beat_name: best_name,
            suggested_role: item.role_hint.unwrap_or(FileRole::Other).as_str().to_string(),
            score: best_score,
        });
    }

    (confirmed, pending)
}
