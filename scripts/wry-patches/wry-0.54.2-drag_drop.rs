// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

// A silly implementation of file drop handling for Windows!
//
// BEATGALER_OPTION2_PATCH_V2
// BeatGaler keeps WRY as the single Windows OLE drop owner. CF_HDROP remains
// the untouched fast path. Only when CF_HDROP is absent do we probe browser
// clipboard formats, and their bytes are read only on Drop (never DragOver).

use crate::DragDropEvent;

use std::{
  cell::UnsafeCell,
  ffi::OsString,
  os::{raw::c_void, windows::ffi::OsStringExt},
  path::PathBuf,
  ptr,
  rc::Rc,
  time::Instant,
};

use windows::{
  core::{implement, BOOL},
  Win32::{
    Foundation::{DRAGDROP_E_INVALIDHWND, HWND, LPARAM, POINT, POINTL},
    Graphics::Gdi::ScreenToClient,
    System::{
      Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
      Ole::{
        IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
        CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
      },
      SystemServices::MODIFIERKEYS_FLAGS,
    },
    UI::{
      Shell::{DragFinish, DragQueryFileW, HDROP},
      WindowsAndMessaging::EnumChildWindows,
    },
  },
};

const CF_UNICODETEXT_ID: u16 = 13;
const MAX_EXTERNAL_TEXT_BYTES: usize = 1024 * 1024;
const EXTERNAL_IMAGE_PREFIX: &str = "__BEATGALER_EXTERNAL_IMAGE_V1__";
const EXTERNAL_IMAGE_PENDING: &str = "__BEATGALER_EXTERNAL_IMAGE_V1__PENDING";

const HTML_FORMAT: &str = "HTML Format";
const TEXT_HTML_FORMAT: &str = "text/html";
const URL_W_FORMAT: &str = "UniformResourceLocatorW";
const URL_A_FORMAT: &str = "UniformResourceLocator";
const URI_LIST_FORMAT: &str = "text/uri-list";
const TEXT_PLAIN_FORMAT: &str = "text/plain";
const PINTEREST_FORMAT: &str = "application/x-pinterest-closeup-image";
const DOWNLOAD_URL_FORMAT: &str = "DownloadURL";
const CHROMIUM_DRAG_ID_FORMAT: &str = "chromium/x-drag-id";
const CHROMIUM_WEB_CUSTOM_MIME_FORMAT: &str = "Chromium Web Custom MIME Data Format";
const FILE_GROUP_DESCRIPTOR_W_FORMAT: &str = "FileGroupDescriptorW";
const FILE_CONTENTS_FORMAT: &str = "FileContents";

#[link(name = "user32")]
extern "system" {
  fn RegisterClipboardFormatW(lpsz_format: *const u16) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
  fn GlobalLock(h_mem: *mut c_void) -> *mut c_void;
  fn GlobalUnlock(h_mem: *mut c_void) -> i32;
  fn GlobalSize(h_mem: *mut c_void) -> usize;
}

#[derive(Default, Clone, Copy)]
struct ExternalFormatProbe {
  html: bool,
  url: bool,
  text: bool,
  pinterest: bool,
  download_url: bool,
  chromium_drag_id: bool,
  chromium_web_custom: bool,
  virtual_file: bool,
}

impl ExternalFormatProbe {
  fn any(self) -> bool {
    self.html
      || self.url
      || self.text
      || self.pinterest
      || self.download_url
      || self.chromium_drag_id
      || self.chromium_web_custom
      || self.virtual_file
  }
}

struct HGlobalPayload {
  bytes: Vec<u8>,
  total_bytes: usize,
}

#[derive(Default)]
struct ExternalDropPayload {
  html: Option<String>,
  html_bytes: usize,
  url: Option<String>,
  uri_list: Option<String>,
  text: Option<String>,
  pinterest: Option<String>,
  download_url: Option<String>,
  chromium_web_custom: Option<String>,
}

#[derive(Default)]
pub(crate) struct DragDropController {
  drop_targets: Vec<IDropTarget>,
}

impl DragDropController {
  #[inline]
  pub(crate) fn new(hwnd: HWND, handler: Box<dyn Fn(DragDropEvent) -> bool>) -> Self {
    let mut controller = DragDropController::default();

    let handler = Rc::new(handler);

    // Enumerate child windows to find the WebView2 "window" and override!
    {
      let mut callback = |hwnd| controller.inject_in_hwnd(hwnd, handler.clone());
      let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut callback;
      let closure_pointer_pointer: *mut c_void = unsafe { std::mem::transmute(&mut trait_obj) };
      let lparam = LPARAM(closure_pointer_pointer as _);
      unsafe extern "system" fn enumerate_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let closure = &mut *(lparam.0 as *mut c_void as *mut &mut dyn FnMut(HWND) -> bool);
        closure(hwnd).into()
      }
      let _ = unsafe { EnumChildWindows(Some(hwnd), Some(enumerate_callback), lparam) };
    }

    controller
  }

  #[inline]
  fn inject_in_hwnd(&mut self, hwnd: HWND, handler: Rc<dyn Fn(DragDropEvent) -> bool>) -> bool {
    let drag_drop_target: IDropTarget = DragDropTarget::new(hwnd, handler).into();
    if unsafe { RevokeDragDrop(hwnd) } != Err(DRAGDROP_E_INVALIDHWND.into())
      && unsafe { RegisterDragDrop(hwnd, &drag_drop_target) }.is_ok()
    {
      self.drop_targets.push(drag_drop_target);
    }

    true
  }
}

#[implement(IDropTarget)]
pub struct DragDropTarget {
  hwnd: HWND,
  listener: Rc<dyn Fn(DragDropEvent) -> bool>,
  cursor_effect: UnsafeCell<DROPEFFECT>,
  enter_is_valid: UnsafeCell<bool>, /* If the currently hovered item is not valid there must not be any `HoveredFileCancelled` emitted */
  enter_is_external: UnsafeCell<bool>,
}

impl DragDropTarget {
  pub fn new(hwnd: HWND, listener: Rc<dyn Fn(DragDropEvent) -> bool>) -> DragDropTarget {
    Self {
      hwnd,
      listener,
      cursor_effect: DROPEFFECT_NONE.into(),
      enter_is_valid: false.into(),
      enter_is_external: false.into(),
    }
  }

  unsafe fn iterate_filenames<F>(data_obj: &IDataObject, mut callback: F) -> Option<HDROP>
  where
    F: FnMut(PathBuf),
  {
    let drop_format = format_etc(CF_HDROP.0);

    match data_obj.GetData(&drop_format) {
      Ok(medium) => {
        let hdrop = HDROP(medium.u.hGlobal.0 as _);

        // The second parameter (0xFFFFFFFF) instructs the function to return the item count
        let item_count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);

        for i in 0..item_count {
          // Get the length of the path string NOT including the terminating null character.
          // Previously, this was using a fixed size array of MAX_PATH length, but the
          // Windows API allows longer paths under certain circumstances.
          let character_count = DragQueryFileW(hdrop, i, None) as usize;

          // Fill path_buf with the null-terminated file name
          let str_len = character_count + 1;
          let mut path_buf = vec![0; str_len];
          DragQueryFileW(hdrop, i, Some(&mut path_buf));
          callback(OsString::from_wide(&path_buf[0..character_count]).into());
        }

        Some(hdrop)
      }
      Err(_error) => {
        #[cfg(feature = "tracing")]
        tracing::warn!(
          "{}",
          match _error.code() {
            windows::Win32::Foundation::DV_E_FORMATETC => {
              // If the dropped item is not a file this error will occur.
              // In this case it is OK to return without taking further action.
              "Error occurred while processing dropped/hovered item: item is not a file."
            }
            _ => "Unexpected error occurred while processing dropped/hovered item.",
          }
        );
        None
      }
    }
  }
}

fn format_etc(cf_format: u16) -> FORMATETC {
  FORMATETC {
    cfFormat: cf_format,
    ptd: ptr::null_mut(),
    dwAspect: DVASPECT_CONTENT.0,
    lindex: -1,
    tymed: TYMED_HGLOBAL.0 as u32,
  }
}

fn registered_clipboard_format(name: &str) -> Option<u16> {
  let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
  let value = unsafe { RegisterClipboardFormatW(wide.as_ptr()) };
  if value == 0 || value > u16::MAX as u32 {
    None
  } else {
    Some(value as u16)
  }
}

fn format_available(data_obj: &IDataObject, cf_format: u16) -> bool {
  // QueryGetData during DragEnter must not assume HGLOBAL. Chromium may advertise
  // browser drag formats through IStream/FILE even though the text formats we
  // actually read on Drop are normally HGLOBAL. 1|2|4 = HGLOBAL|FILE|ISTREAM.
  let mut format = format_etc(cf_format);
  format.tymed = 1 | 2 | 4;
  unsafe { data_obj.QueryGetData(&format) }.is_ok()
}

fn registered_format_available(data_obj: &IDataObject, name: &str) -> bool {
  registered_clipboard_format(name)
    .map(|format| format_available(data_obj, format))
    .unwrap_or(false)
}

fn probe_external_formats(data_obj: &IDataObject) -> ExternalFormatProbe {
  ExternalFormatProbe {
    html: registered_format_available(data_obj, HTML_FORMAT)
      || registered_format_available(data_obj, TEXT_HTML_FORMAT),
    url: registered_format_available(data_obj, URL_W_FORMAT)
      || registered_format_available(data_obj, URL_A_FORMAT)
      || registered_format_available(data_obj, URI_LIST_FORMAT),
    text: format_available(data_obj, CF_UNICODETEXT_ID)
      || registered_format_available(data_obj, TEXT_PLAIN_FORMAT),
    pinterest: registered_format_available(data_obj, PINTEREST_FORMAT),
    download_url: registered_format_available(data_obj, DOWNLOAD_URL_FORMAT),
    chromium_drag_id: registered_format_available(data_obj, CHROMIUM_DRAG_ID_FORMAT),
    chromium_web_custom: registered_format_available(data_obj, CHROMIUM_WEB_CUSTOM_MIME_FORMAT),
    virtual_file: registered_format_available(data_obj, FILE_GROUP_DESCRIPTOR_W_FORMAT)
      || registered_format_available(data_obj, FILE_CONTENTS_FORMAT),
  }
}

fn read_hglobal_payload(data_obj: &IDataObject, cf_format: u16) -> Option<HGlobalPayload> {
  let format = format_etc(cf_format);
  let mut medium = unsafe { data_obj.GetData(&format) }.ok()?;

  let result = unsafe {
    let hglobal = medium.u.hGlobal.0 as *mut c_void;
    if hglobal.is_null() {
      None
    } else {
      let total_bytes = GlobalSize(hglobal);
      if total_bytes == 0 {
        None
      } else {
        let locked = GlobalLock(hglobal);
        if locked.is_null() {
          None
        } else {
          let copy_len = total_bytes.min(MAX_EXTERNAL_TEXT_BYTES);
          let bytes = std::slice::from_raw_parts(locked as *const u8, copy_len).to_vec();
          let _ = GlobalUnlock(hglobal);
          Some(HGlobalPayload { bytes, total_bytes })
        }
      }
    }
  };

  unsafe { ReleaseStgMedium(&mut medium as *mut _) };
  result
}

fn read_registered_payload(data_obj: &IDataObject, name: &str) -> Option<HGlobalPayload> {
  let format = registered_clipboard_format(name)?;
  read_hglobal_payload(data_obj, format)
}

fn decode_utf16_payload(bytes: &[u8]) -> String {
  let mut words = Vec::with_capacity(bytes.len() / 2);
  for chunk in bytes.chunks_exact(2) {
    let word = u16::from_le_bytes([chunk[0], chunk[1]]);
    if word == 0 {
      break;
    }
    words.push(word);
  }
  String::from_utf16_lossy(&words)
}

fn decode_byte_payload(bytes: &[u8]) -> String {
  let end = bytes.iter().position(|value| *value == 0).unwrap_or(bytes.len());
  String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn decode_maybe_utf16_payload(bytes: &[u8]) -> String {
  let odd_zeroes = bytes
    .iter()
    .enumerate()
    .filter(|(index, value)| index % 2 == 1 && **value == 0)
    .count();
  if bytes.len() >= 4 && odd_zeroes * 4 >= bytes.len() {
    decode_utf16_payload(bytes)
  } else {
    decode_byte_payload(bytes)
  }
}

fn decode_searchable_payload(bytes: &[u8]) -> String {
  // Chromium's custom web MIME blob is binary. We do not deserialize its
  // private structure; we only build bounded UTF-8/UTF-16 search views and
  // scan them for an image URL. This stays Drop-only and max 1 MiB.
  let utf8 = String::from_utf8_lossy(bytes).replace('\0', " ");
  let words = bytes
    .chunks_exact(2)
    .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
    .collect::<Vec<_>>();
  let utf16 = String::from_utf16_lossy(&words).replace('\0', " ");
  format!("{utf8}\n{utf16}")
}

fn read_external_drop_payload(data_obj: &IDataObject) -> ExternalDropPayload {
  let mut payload = ExternalDropPayload::default();

  if let Some(raw) = read_registered_payload(data_obj, HTML_FORMAT)
    .or_else(|| read_registered_payload(data_obj, TEXT_HTML_FORMAT))
  {
    payload.html_bytes = raw.total_bytes;
    payload.html = Some(decode_maybe_utf16_payload(&raw.bytes));
  }

  if let Some(raw) = read_registered_payload(data_obj, URL_W_FORMAT) {
    payload.url = Some(decode_utf16_payload(&raw.bytes));
  } else if let Some(raw) = read_registered_payload(data_obj, URL_A_FORMAT) {
    payload.url = Some(decode_byte_payload(&raw.bytes));
  }

  if let Some(raw) = read_registered_payload(data_obj, URI_LIST_FORMAT) {
    payload.uri_list = Some(decode_maybe_utf16_payload(&raw.bytes));
  }

  if let Some(raw) = read_hglobal_payload(data_obj, CF_UNICODETEXT_ID) {
    payload.text = Some(decode_utf16_payload(&raw.bytes));
  } else if let Some(raw) = read_registered_payload(data_obj, TEXT_PLAIN_FORMAT) {
    payload.text = Some(decode_maybe_utf16_payload(&raw.bytes));
  }

  if let Some(raw) = read_registered_payload(data_obj, PINTEREST_FORMAT) {
    payload.pinterest = Some(decode_maybe_utf16_payload(&raw.bytes));
  }

  if let Some(raw) = read_registered_payload(data_obj, DOWNLOAD_URL_FORMAT) {
    payload.download_url = Some(decode_maybe_utf16_payload(&raw.bytes));
  }

  if let Some(raw) = read_registered_payload(data_obj, CHROMIUM_WEB_CUSTOM_MIME_FORMAT) {
    payload.chromium_web_custom = Some(decode_searchable_payload(&raw.bytes));
  }

  payload
}

fn normalized_drag_text(value: &str) -> String {
  value
    .replace("\\u002F", "/")
    .replace("\\u002f", "/")
    .replace("\\/", "/")
    .replace("&amp;", "&")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
}

fn candidate_urls(value: &str) -> Vec<String> {
  let normalized = normalized_drag_text(value);
  let mut urls = Vec::new();
  let mut cursor = 0usize;

  while cursor < normalized.len() {
    let tail = &normalized[cursor..];
    let https = tail.find("https://");
    let http = tail.find("http://");
    let relative_start = match (https, http) {
      (Some(a), Some(b)) => a.min(b),
      (Some(a), None) => a,
      (None, Some(b)) => b,
      (None, None) => break,
    };
    let start = cursor + relative_start;
    let url_tail = &normalized[start..];
    let end_rel = url_tail
      .char_indices()
      .find_map(|(index, ch)| {
        if index == 0 {
          None
        } else if ch.is_whitespace()
          || matches!(ch, '\"' | '\'' | '<' | '>' | '[' | ']' | '(' | ')' | '{' | '}' | ',')
        {
          Some(index)
        } else {
          None
        }
      })
      .unwrap_or(url_tail.len());
    let cleaned = url_tail[..end_rel]
      .trim_end_matches(|ch: char| matches!(ch, ';' | ':' | '.'))
      .to_string();
    if !cleaned.is_empty() && !urls.iter().any(|existing| existing == &cleaned) {
      urls.push(cleaned);
    }
    cursor = start + end_rel.max(1);
  }

  urls
}

fn is_pinimg_url(url: &str) -> bool {
  let lower = url.to_ascii_lowercase();
  (lower.starts_with("https://") || lower.starts_with("http://"))
    && (lower.contains("//i.pinimg.com/") || lower.contains(".pinimg.com/"))
}

fn is_direct_image_url(url: &str) -> bool {
  if is_pinimg_url(url) {
    return true;
  }
  let lower = url.to_ascii_lowercase();
  if !(lower.starts_with("https://") || lower.starts_with("http://")) {
    return false;
  }
  let path = lower
    .split(|ch| ch == '?' || ch == '#')
    .next()
    .unwrap_or(&lower);
  [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]
    .iter()
    .any(|extension| path.ends_with(extension))
}

fn first_url_matching<F>(values: &[&str], mut predicate: F) -> Option<String>
where
  F: FnMut(&str) -> bool,
{
  for value in values {
    for url in candidate_urls(value) {
      if predicate(&url) {
        return Some(url);
      }
    }
  }
  None
}

fn resolve_external_image_url(payload: &ExternalDropPayload) -> Option<String> {
  let all_values: Vec<&str> = [
    payload.url.as_deref(),
    payload.uri_list.as_deref(),
    payload.html.as_deref(),
    payload.text.as_deref(),
    payload.pinterest.as_deref(),
    payload.download_url.as_deref(),
    payload.chromium_web_custom.as_deref(),
  ]
  .into_iter()
  .flatten()
  .collect();

  // 1. Direct Pinterest CDN image, regardless of which browser format carried it.
  if let Some(url) = first_url_matching(&all_values, is_pinimg_url) {
    return Some(url);
  }

  // 2. HTML <img src/srcset>. Candidate scanning is intentionally restricted
  // to the HTML payload for this priority tier.
  if let Some(html) = payload.html.as_deref() {
    if let Some(url) = first_url_matching(&[html], is_direct_image_url) {
      return Some(url);
    }
  }

  // 3. URL / URI list / text containing a direct image URL.
  let url_text_values: Vec<&str> = [
    payload.url.as_deref(),
    payload.uri_list.as_deref(),
    payload.text.as_deref(),
  ]
  .into_iter()
  .flatten()
  .collect();
  if let Some(url) = first_url_matching(&url_text_values, is_direct_image_url) {
    return Some(url);
  }

  // 4. Browser/Pinterest-specific formats.
  let custom_values: Vec<&str> = [
    payload.pinterest.as_deref(),
    payload.download_url.as_deref(),
    payload.chromium_web_custom.as_deref(),
  ]
    .into_iter()
    .flatten()
    .collect();
  first_url_matching(&custom_values, is_direct_image_url)
}

fn diagnostic_preview(value: &str) -> String {
  let compact = value
    .chars()
    .map(|ch| if ch.is_whitespace() || ch.is_control() { ' ' } else { ch })
    .collect::<String>()
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ");
  compact.chars().take(220).collect()
}

fn source_for_url(url: &str) -> &'static str {
  let lower = url.to_ascii_lowercase();
  if lower.contains("pinimg.com") || lower.contains("pinterest.") {
    "pinterest"
  } else {
    "browser"
  }
}

fn marker_for_external_image(url: &str) -> PathBuf {
  const HEX: &[u8; 16] = b"0123456789ABCDEF";
  let mut encoded = String::with_capacity(url.len() + EXTERNAL_IMAGE_PREFIX.len());
  encoded.push_str(EXTERNAL_IMAGE_PREFIX);
  for byte in url.bytes() {
    if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
      encoded.push(byte as char);
    } else {
      encoded.push('%');
      encoded.push(HEX[(byte >> 4) as usize] as char);
      encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
  }
  PathBuf::from(encoded)
}

fn inspect_external_drop(data_obj: &IDataObject) -> Option<PathBuf> {
  let started = Instant::now();
  let formats = probe_external_formats(data_obj);
  eprintln!(
    "[native-drop-data] FORMAT CF_HDROP=false HTML={} URL={} TEXT={} PINTEREST={} DOWNLOAD_URL={} CHROMIUM_DRAG_ID={} CHROMIUM_WEB_CUSTOM={} VIRTUAL_FILE={}",
    formats.html,
    formats.url,
    formats.text,
    formats.pinterest,
    formats.download_url,
    formats.chromium_drag_id,
    formats.chromium_web_custom,
    formats.virtual_file
  );

  let payload = read_external_drop_payload(data_obj);
  if let Some(html) = payload.html.as_deref() {
    eprintln!(
      "[native-drop-data] HTML_BYTES={} HTML_PREVIEW={}",
      payload.html_bytes,
      diagnostic_preview(html)
    );
  }
  if let Some(url) = payload.url.as_deref() {
    eprintln!("[native-drop-data] URL={}", diagnostic_preview(url));
  }
  if let Some(uri_list) = payload.uri_list.as_deref() {
    eprintln!("[native-drop-data] URI_LIST={}", diagnostic_preview(uri_list));
  }
  if let Some(text) = payload.text.as_deref() {
    eprintln!("[native-drop-data] TEXT={}", diagnostic_preview(text));
  }
  if let Some(pinterest) = payload.pinterest.as_deref() {
    eprintln!("[native-drop-data] PINTEREST={}", diagnostic_preview(pinterest));
  }
  if let Some(download_url) = payload.download_url.as_deref() {
    eprintln!("[native-drop-data] DOWNLOAD_URL={}", diagnostic_preview(download_url));
  }
  if let Some(custom) = payload.chromium_web_custom.as_deref() {
    eprintln!("[native-drop-data] CHROMIUM_WEB_CUSTOM={}", diagnostic_preview(custom));
  }

  let resolved = resolve_external_image_url(&payload);
  if let Some(url) = resolved.as_deref() {
    eprintln!(
      "[native-drop-data] RESOLVED_URL={} SOURCE={}",
      diagnostic_preview(url),
      source_for_url(url)
    );
  } else {
    eprintln!("[native-drop-data] RESOLVED_URL=<none>");
  }
  eprintln!(
    "[native-drop-data] INSPECT_US={}",
    started.elapsed().as_micros()
  );

  resolved.map(|url| marker_for_external_image(&url))
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for DragDropTarget_Impl {
  fn DragEnter(
    &self,
    pDataObj: windows_core::Ref<'_, IDataObject>,
    _grfKeyState: MODIFIERKEYS_FLAGS,
    pt: &POINTL,
    pdwEffect: *mut DROPEFFECT,
  ) -> windows::core::Result<()> {
    let mut pt = POINT { x: pt.x, y: pt.y };
    let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };

    let data_obj = pDataObj.as_ref().expect("Received null IDataObject");
    let mut paths = Vec::new();
    let hdrop = unsafe { DragDropTarget::iterate_filenames(data_obj, |path| paths.push(path)) };

    // Critical BeatGaler performance invariant: a real Explorer/CF_HDROP drop
    // returns immediately to the exact upstream WRY path. Zero HTML/URL format
    // probes are performed for local files or folders.
    let is_external = if hdrop.is_some() {
      false
    } else {
      let formats = probe_external_formats(data_obj);
      eprintln!(
        "[native-drop-data] ENTER CF_HDROP=false HTML={} URL={} TEXT={} PINTEREST={} DOWNLOAD_URL={} CHROMIUM_DRAG_ID={} CHROMIUM_WEB_CUSTOM={} VIRTUAL_FILE={}",
        formats.html,
        formats.url,
        formats.text,
        formats.pinterest,
        formats.download_url,
        formats.chromium_drag_id,
        formats.chromium_web_custom,
        formats.virtual_file
      );
      formats.any()
    };
    if is_external {
      paths.push(PathBuf::from(EXTERNAL_IMAGE_PENDING));
    }

    let enter_is_valid = hdrop.is_some() || is_external;

    unsafe {
      *self.enter_is_valid.get() = enter_is_valid;
      *self.enter_is_external.get() = is_external;
    }

    if !enter_is_valid {
      unsafe {
        *pdwEffect = DROPEFFECT_NONE;
        *self.cursor_effect.get() = DROPEFFECT_NONE;
      }
      return Ok(());
    }

    (self.listener)(DragDropEvent::Enter {
      paths,
      position: (pt.x as _, pt.y as _),
    });

    let cursor_effect = DROPEFFECT_COPY;

    unsafe {
      *pdwEffect = cursor_effect;
      *self.cursor_effect.get() = cursor_effect;
    }

    Ok(())
  }

  fn DragOver(
    &self,
    _grfKeyState: MODIFIERKEYS_FLAGS,
    pt: &POINTL,
    pdwEffect: *mut DROPEFFECT,
  ) -> windows::core::Result<()> {
    if unsafe { *self.enter_is_valid.get() } {
      let mut pt = POINT { x: pt.x, y: pt.y };
      let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };
      (self.listener)(DragDropEvent::Over {
        position: (pt.x as _, pt.y as _),
      });
    }

    unsafe { *pdwEffect = *self.cursor_effect.get() };
    Ok(())
  }

  fn DragLeave(&self) -> windows::core::Result<()> {
    if unsafe { *self.enter_is_valid.get() } {
      (self.listener)(DragDropEvent::Leave);
    }
    unsafe {
      *self.enter_is_valid.get() = false;
      *self.enter_is_external.get() = false;
      *self.cursor_effect.get() = DROPEFFECT_NONE;
    }
    Ok(())
  }

  fn Drop(
    &self,
    pDataObj: windows_core::Ref<'_, IDataObject>,
    _grfKeyState: MODIFIERKEYS_FLAGS,
    pt: &POINTL,
    pdwEffect: *mut DROPEFFECT,
  ) -> windows::core::Result<()> {
    if unsafe { *self.enter_is_valid.get() } {
      let mut pt = POINT { x: pt.x, y: pt.y };
      let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };
      let data_obj = pDataObj.as_ref().expect("Received null IDataObject");

      if unsafe { *self.enter_is_external.get() } {
        // Browser payload bytes are intentionally touched only here, on Drop.
        let paths = inspect_external_drop(data_obj).into_iter().collect::<Vec<_>>();
        let accepted = !paths.is_empty();
        (self.listener)(DragDropEvent::Drop {
          paths,
          position: (pt.x as _, pt.y as _),
        });
        unsafe {
          *pdwEffect = if accepted { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
        }
      } else {
        // Exact local filesystem fast path: CF_HDROP only, original paths only.
        let mut paths = Vec::new();
        let hdrop = unsafe { DragDropTarget::iterate_filenames(data_obj, |path| paths.push(path)) };
        (self.listener)(DragDropEvent::Drop {
          paths,
          position: (pt.x as _, pt.y as _),
        });

        if let Some(hdrop) = hdrop {
          unsafe { DragFinish(hdrop) };
        }
      }
    }

    unsafe {
      *self.enter_is_valid.get() = false;
      *self.enter_is_external.get() = false;
      *self.cursor_effect.get() = DROPEFFECT_NONE;
    }

    Ok(())
  }
}
