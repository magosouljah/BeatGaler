#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::ptr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use winsafe::{self as w, co, prelude::*};

#[derive(Clone, Debug, Default)]
struct DragState { kind: String, paths: Vec<String>, path_kinds: Vec<String>, url: Option<String> }

#[derive(Clone, Debug, Serialize)]
struct DragPosition { x: i32, y: i32 }

#[derive(Clone, Debug, Serialize)]
struct NativeDragPayload {
    phase: String,
    kind: String,
    paths: Vec<String>,
    path_kinds: Vec<String>,
    url: Option<String>,
    position: Option<DragPosition>,
}

fn image_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif"].iter().any(|ext| lower.ends_with(ext))
}

fn format_for(cf: co::CF, lindex: i32) -> w::FORMATETC<'static> {
    let mut fmt = w::FORMATETC::default();
    fmt.cfFormat = cf;
    fmt.dwAspect = co::DVASPECT::CONTENT;
    fmt.tymed = co::TYMED::HGLOBAL;
    fmt.lindex = lindex;
    fmt
}

fn extract_paths(data: &w::IDataObject) -> Vec<String> {
    let fmt = format_for(co::CF::HDROP, -1);
    let Ok(medium) = (unsafe { data.GetData(&fmt) }) else { return Vec::new(); };
    let Some(hglobal) = (unsafe { medium.ptr_hglobal() }) else { return Vec::new(); };
    let Ok(lock) = hglobal.GlobalLock() else { return Vec::new(); };
    let hdrop = unsafe { w::HDROP::from_ptr(lock.as_ptr() as _) };
    let Ok(iter) = hdrop.DragQueryFile() else { return Vec::new(); };
    iter.filter_map(Result::ok).collect()
}

fn register_clipboard_format(name: &str) -> Option<co::CF> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let raw = unsafe { windows_sys::Win32::System::DataExchange::RegisterClipboardFormatW(wide.as_ptr()) };
    if raw == 0 { None } else { Some(unsafe { co::CF::from_raw(raw as u16) }) }
}

fn hglobal_bytes(data: &w::IDataObject, cf: co::CF) -> Option<Vec<u8>> {
    let fmt = format_for(cf, -1);
    let medium = unsafe { data.GetData(&fmt) }.ok()?;
    let hglobal = unsafe { medium.ptr_hglobal() }?;
    let lock = hglobal.GlobalLock().ok()?;
    Some(lock.as_slice().to_vec())
}

fn decode_utf16_nul(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 2 { return None; }
    let mut words = Vec::with_capacity(bytes.len()/2);
    for pair in bytes.chunks_exact(2) {
        let value = u16::from_le_bytes([pair[0], pair[1]]);
        if value == 0 { break; }
        words.push(value);
    }
    let text = String::from_utf16_lossy(&words).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn decode_ansi_nul(bytes: &[u8]) -> Option<String> {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    let text = String::from_utf8_lossy(&bytes[..end]).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn clean_url(raw: &str) -> Option<String> {
    let mut value = raw.trim().trim_matches(['\'', '"']).replace("&amp;", "&");
    if let Some(pos) = value.find(['\r', '\n']) { value.truncate(pos); }
    if value.starts_with("http://") || value.starts_with("https://") { Some(value) } else { None }
}

fn img_src_from_html(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let img_at = lower.find("<img")?;
    let tail = &html[img_at..];
    let tail_lower = &lower[img_at..];
    for attr in ["src", "data-src", "data-original"] {
        let needle = format!("{}=", attr);
        let Some(rel) = tail_lower.find(&needle) else { continue; };
        let after = &tail[rel + needle.len()..];
        let trimmed = after.trim_start();
        let first = trimmed.chars().next()?;
        let value = if first == '"' || first == '\'' {
            let rest = &trimmed[first.len_utf8()..];
            let end = rest.find(first)?;
            &rest[..end]
        } else {
            let end = trimmed.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(trimmed.len());
            &trimmed[..end]
        };
        if let Some(url) = clean_url(value) { return Some(url); }
    }
    None
}


fn looks_like_direct_image_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("i.pinimg.com/") ||
        [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif"]
            .iter()
            .any(|ext| lower.contains(ext))
}

fn http_urls_from_text(raw: &str) -> Vec<String> {
    let normalized = raw
        .replace("\\u002F", "/")
        .replace("\\u002f", "/")
        .replace("\\/", "/")
        .replace("&amp;", "&");
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while cursor < normalized.len() {
        let tail = &normalized[cursor..];
        let http = tail.find("http://");
        let https = tail.find("https://");
        let rel = match (http, https) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => break,
        };
        let start = cursor + rel;
        let rest = &normalized[start..];
        let end = rest.find(|c: char| {
            c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '\\' | ')' | ']' | '}')
        }).unwrap_or(rest.len());
        if let Some(url) = clean_url(&rest[..end]) {
            if !out.iter().any(|item| item == &url) { out.push(url); }
        }
        cursor = start + end.max(1);
    }
    out
}

fn url_from_arbitrary_text(raw: &str) -> Option<String> {
    if let Some(url) = img_src_from_html(raw) { return Some(url); }
    let urls = http_urls_from_text(raw);
    urls.iter().find(|url| looks_like_direct_image_url(url)).cloned()
        .or_else(|| urls.into_iter().next())
}

fn extract_url(data: &w::IDataObject) -> Option<String> {
    // Chromium/Pinterest normally exposes HTML Format plus URI/text fallbacks.
    // Keep custom MIME probes too so a Pinterest implementation change does not
    // force us back through WebView2's expensive virtual-file staging path.
    for name in [
        "HTML Format",
        "text/html",
        "application/x-pinterest-closeup-image",
    ] {
        if let Some(cf) = register_clipboard_format(name) {
            if let Some(bytes) = hglobal_bytes(data, cf) {
                let utf8 = String::from_utf8_lossy(&bytes);
                if let Some(url) = url_from_arbitrary_text(&utf8) { return Some(url); }
                if let Some(text) = decode_utf16_nul(&bytes) {
                    if let Some(url) = url_from_arbitrary_text(&text) { return Some(url); }
                }
            }
        }
    }
    if let Some(cf) = register_clipboard_format("UniformResourceLocatorW") {
        if let Some(bytes) = hglobal_bytes(data, cf) {
            if let Some(url) = decode_utf16_nul(&bytes).and_then(|v| clean_url(&v)) { return Some(url); }
        }
    }
    if let Some(cf) = register_clipboard_format("UniformResourceLocator") {
        if let Some(bytes) = hglobal_bytes(data, cf) {
            if let Some(url) = decode_ansi_nul(&bytes).and_then(|v| clean_url(&v)) { return Some(url); }
        }
    }
    if let Some(bytes) = hglobal_bytes(data, co::CF::UNICODETEXT) {
        if let Some(text) = decode_utf16_nul(&bytes) {
            if let Some(url) = url_from_arbitrary_text(&text) { return Some(url); }
        }
    }
    None
}

fn classify(data: &w::IDataObject) -> DragState {
    let paths = extract_paths(data);
    if !paths.is_empty() {
        let path_kinds = paths.iter().map(|raw| {
            if std::path::Path::new(raw).is_dir() { "directory".to_string() } else { "file".to_string() }
        }).collect();
        return DragState {
            kind: if paths.len()==1 && image_path(&paths[0]) { "image".into() } else { "file".into() },
            paths,
            path_kinds,
            url: None,
        };
    }
    if let Some(url) = extract_url(data) {
        return DragState { kind: "image".into(), paths: Vec::new(), path_kinds: Vec::new(), url: Some(url) };
    }
    DragState { kind: "unknown".into(), ..Default::default() }
}

fn client_position(hwnd: &w::HWND, pt: w::POINT) -> Option<DragPosition> {
    let point = hwnd.ScreenToClient(pt).ok()?;
    Some(DragPosition { x: point.x, y: point.y })
}

fn emit<R: Runtime>(app: &AppHandle<R>, phase: &str, state: &DragState, position: Option<DragPosition>) {
    let _ = app.emit("beatgaler-native-drag", NativeDragPayload {
        phase: phase.into(), kind: state.kind.clone(), paths: state.paths.clone(), path_kinds: state.path_kinds.clone(), url: state.url.clone(), position,
    });
}

#[link(name = "ole32")]
extern "system" {
    fn OleInitialize(pv_reserved: *mut c_void) -> i32;
    fn RevokeDragDrop(hwnd: *mut c_void) -> i32;
}

pub fn install<R: Runtime>(app: &tauri::App<R>) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or_else(|| "BeatGaler main window was not found.".to_string())?;
    let native_hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let hwnd = unsafe { w::HWND::from_ptr(native_hwnd.0 as _) };

    // Call OleInitialize directly instead of WinSafe's wrapper here.
    // Windows legitimately returns S_FALSE (1) when OLE is already initialized
    // on this STA. S_FALSE is success, not an error. The previous wrapper path
    // surfaced that success code as "[0x0001] Incorrect function" and aborted.
    let ole_hr = unsafe { OleInitialize(ptr::null_mut()) };
    if ole_hr < 0 {
        return Err(format!("OleInitialize failed: HRESULT 0x{:08X}", ole_hr as u32));
    }
    // Every successful OleInitialize, including S_FALSE, increments the OLE
    // initialization count. BeatGaler keeps this registration for the lifetime
    // of the UI thread/process, so we intentionally keep that initialization.

    let state = Arc::new(Mutex::new(DragState::default()));
    // DragOver can fire hundreds of times per second. Do not flood Tauri/React
    // with IPC events while the user is dragging; ~60 Hz is more than enough to
    // keep artwork/card/library hover feedback visually locked to the pointer.
    let last_over_emit = Arc::new(Mutex::new(None::<Instant>));
    let target = w::IDropTarget::new_impl();

    {
        let app = app.handle().clone(); let state = state.clone(); let hwnd = unsafe { hwnd.raw_copy() };
        target.DragEnter(move |data, _keys, pt, effect| {
            let next = classify(data);
            *effect = if next.kind == "unknown" { co::DROPEFFECT::NONE } else { co::DROPEFFECT::COPY };
            if let Ok(mut current) = state.lock() { *current = next.clone(); }
            emit(&app, "enter", &next, client_position(&hwnd, pt));
            Ok(())
        });
    }
    {
        let app = app.handle().clone();
        let state = state.clone();
        let last_over_emit = last_over_emit.clone();
        let hwnd = unsafe { hwnd.raw_copy() };
        target.DragOver(move |_keys, pt, effect| {
            let current = state.lock().ok().map(|v| v.clone()).unwrap_or_default();
            *effect = if current.kind == "unknown" { co::DROPEFFECT::NONE } else { co::DROPEFFECT::COPY };
            let should_emit = last_over_emit.lock().ok().map(|mut last| {
                let now = Instant::now();
                let due = last.as_ref().map(|value| now.duration_since(value.clone()) >= Duration::from_millis(16)).unwrap_or(true);
                if due { *last = Some(now); }
                due
            }).unwrap_or(true);
            if should_emit { emit(&app, "over", &current, client_position(&hwnd, pt)); }
            Ok(())
        });
    }
    {
        let app = app.handle().clone(); let state = state.clone(); let last_over_emit = last_over_emit.clone();
        target.DragLeave(move || {
            let old = state.lock().ok().map(|v| v.clone()).unwrap_or_default();
            if let Ok(mut current) = state.lock() { *current = DragState::default(); }
            if let Ok(mut last) = last_over_emit.lock() { *last = None; }
            emit(&app, "leave", &old, None);
            Ok(())
        });
    }
    {
        let app = app.handle().clone(); let state = state.clone(); let last_over_emit = last_over_emit.clone(); let hwnd = unsafe { hwnd.raw_copy() };
        target.Drop(move |data, _keys, pt, effect| {
            let final_state = classify(data);
            *effect = if final_state.kind == "unknown" { co::DROPEFFECT::NONE } else { co::DROPEFFECT::COPY };
            eprintln!(
                "[native-drop] DROP kind={} paths={} url={}",
                final_state.kind,
                final_state.paths.len(),
                if final_state.url.is_some() { "yes" } else { "no" }
            );
            if let Ok(mut current) = state.lock() { *current = DragState::default(); }
            if let Ok(mut last) = last_over_emit.lock() { *last = None; }
            emit(&app, "drop", &final_state, client_position(&hwnd, pt));
            Ok(())
        });
    }

    // WebView2/Tauri may have already registered this HWND as an OLE drop target
    // even when Tauri's high-level dragDropEnabled handler is disabled. Windows
    // only allows one IDropTarget per HWND, so remove the existing registration
    // before installing BeatGaler's combined file + browser-image target.
    // DRAGDROP_E_NOTREGISTERED (0x80040100) is harmless and intentionally ignored.
    let revoke_hr = unsafe { RevokeDragDrop(native_hwnd.0 as *mut c_void) };
    const DRAGDROP_E_NOTREGISTERED: i32 = 0x80040100u32 as i32;
    if revoke_hr < 0 && revoke_hr != DRAGDROP_E_NOTREGISTERED {
        return Err(format!("RevokeDragDrop failed: HRESULT 0x{:08X}", revoke_hr as u32));
    }

    hwnd.RegisterDragDrop(&target).map_err(|e| e.to_string())?;
    Box::leak(Box::new(target));
    eprintln!("[native-drop] Windows OLE router installed");
    Ok(())
}
