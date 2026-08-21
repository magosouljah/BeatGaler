// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

// BEATGALER_MAC_EXTERNAL_IMAGE_PATCH_V1

use std::{ffi::CStr, path::PathBuf};

use objc2::{
  runtime::{Bool, ProtocolObject},
  DeclaredClass,
};
use objc2_app_kit::{
  NSDragOperation, NSDraggingInfo, NSFilenamesPboardType, NSPasteboardTypeHTML,
  NSPasteboardTypeString, NSPasteboardTypeURL,
};
use objc2_foundation::{NSArray, NSPoint, NSRect, NSString};

use crate::DragDropEvent;

use super::WryWebView;

const EXTERNAL_IMAGE_PREFIX: &str = "__BEATGALER_EXTERNAL_IMAGE_V1__";
const EXTERNAL_IMAGE_PENDING: &str = "__BEATGALER_EXTERNAL_IMAGE_V1__PENDING";
const PINTEREST_CLOSEUP_IMAGE_TYPE: &str = "application/x-pinterest-closeup-image";
const WEB_URLS_WITH_TITLES_TYPE: &str = "WebURLsWithTitlesPboardType";
const CHROMIUM_WEB_CUSTOM_DATA_TYPE: &str = "org.chromium.web-custom-data";

unsafe fn ns_string(value: &NSString) -> Option<String> {
  let pointer = value.UTF8String();
  if pointer.is_null() {
    return None;
  }
  Some(unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned())
}

fn urls_in_text(value: &str) -> Vec<String> {
  let mut urls = Vec::new();
  for scheme in ["https://", "http://"] {
    for (start, _) in value.match_indices(scheme) {
      let tail = &value[start..];
      let end = tail
        .char_indices()
        .skip(1)
        .find_map(|(index, ch)| {
          (ch.is_whitespace()
            || ch.is_control()
            || matches!(ch, '\"' | '\'' | '<' | '>' | ')' | ']'))
            .then_some(index)
        })
        .unwrap_or(tail.len());
      let candidate = tail[..end]
        .trim_end_matches(['.', ',', ';'])
        .replace("&amp;", "&");
      if !candidate.is_empty() && !urls.iter().any(|current| current == &candidate) {
        urls.push(candidate);
      }
    }
  }
  urls
}

fn preferred_external_image_url(values: &[String]) -> Option<String> {
  let urls = values
    .iter()
    .flat_map(|value| urls_in_text(value))
    .collect::<Vec<_>>();
  urls
    .iter()
    .find(|url| url.to_ascii_lowercase().contains("pinimg.com"))
    .cloned()
    .or_else(|| urls.into_iter().next())
}

unsafe fn pasteboard_string(
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
  pasteboard_type: &NSString,
) -> Option<String> {
  let pasteboard = drag_info.draggingPasteboard();
  pasteboard.stringForType(pasteboard_type).and_then(|value| ns_string(&value))
}

fn pasteboard_data_strings(bytes: &[u8]) -> Vec<String> {
  // Browser custom data is tiny metadata. Avoid interpreting a binary image
  // representation as text if a browser happens to expose one under the same
  // drag session.
  if bytes.is_empty() || bytes.len() > 2 * 1024 * 1024 {
    return Vec::new();
  }

  let mut values = vec![String::from_utf8_lossy(bytes).into_owned()];
  if bytes.len() >= 4 && bytes.len() % 2 == 0 {
    let utf16 = bytes
      .chunks_exact(2)
      .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
      .collect::<Vec<_>>();
    let decoded = String::from_utf16_lossy(&utf16);
    if decoded.contains("http://") || decoded.contains("https://") {
      values.push(decoded);
    }
  }
  values
}

unsafe fn pasteboard_values(
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
  pasteboard_type: &NSString,
) -> Vec<String> {
  let pasteboard = drag_info.draggingPasteboard();
  let mut values = Vec::new();
  if let Some(value) = pasteboard_string(drag_info, pasteboard_type) {
    values.push(value);
  }
  if let Some(data) = pasteboard.dataForType(pasteboard_type) {
    values.extend(pasteboard_data_strings(&data.to_vec()));
  }
  if let Some(property) = pasteboard.propertyListForType(pasteboard_type) {
    if let Ok(array) = property.downcast::<NSArray>() {
      for value in array {
        match value.downcast::<NSString>() {
          Ok(string) => {
            if let Some(value) = ns_string(&string) {
              values.push(value);
            }
          }
          Err(value) => {
            if let Ok(nested) = value.downcast::<NSArray>() {
              for nested_value in nested {
                if let Ok(string) = nested_value.downcast::<NSString>() {
                  if let Some(value) = ns_string(&string) {
                    values.push(value);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  values
}

unsafe fn external_image_url(
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Option<String> {
  let pinterest_type = NSString::from_str(PINTEREST_CLOSEUP_IMAGE_TYPE);
  let web_urls_type = NSString::from_str(WEB_URLS_WITH_TITLES_TYPE);
  let chromium_type = NSString::from_str(CHROMIUM_WEB_CUSTOM_DATA_TYPE);
  let values = [
    pasteboard_values(drag_info, &pinterest_type),
    pasteboard_values(drag_info, &web_urls_type),
    pasteboard_values(drag_info, &chromium_type),
    pasteboard_values(drag_info, NSPasteboardTypeURL),
    pasteboard_values(drag_info, NSPasteboardTypeHTML),
    pasteboard_values(drag_info, NSPasteboardTypeString),
  ]
  .into_iter()
  .flatten()
  .collect::<Vec<_>>();
  preferred_external_image_url(&values)
}

unsafe fn pasteboard_has_type(
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
  pasteboard_type: &NSString,
) -> bool {
  let pasteboard = drag_info.draggingPasteboard();
  let types = NSArray::arrayWithObject(pasteboard_type);
  pasteboard.availableTypeFromArray(&types).is_some()
}

pub(crate) unsafe fn collect_paths(drag_info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
  let pb = drag_info.draggingPasteboard();
  let mut drag_drop_paths = Vec::new();
  let types = NSArray::arrayWithObject(NSFilenamesPboardType);

  if pb.availableTypeFromArray(&types).is_some() {
    let paths = pb.propertyListForType(NSFilenamesPboardType).unwrap();
    let paths = paths.downcast::<NSArray>().unwrap();
    for path in paths {
      let path = path.downcast::<NSString>().unwrap();
      if let Some(path) = ns_string(&path) {
        drag_drop_paths.push(PathBuf::from(path));
      }
    }
  }
  drag_drop_paths
}

pub(crate) fn dragging_entered(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let mut paths = unsafe { collect_paths(drag_info) };
  if paths.is_empty() {
    let pinterest_type = NSString::from_str(PINTEREST_CLOSEUP_IMAGE_TYPE);
    let web_urls_type = NSString::from_str(WEB_URLS_WITH_TITLES_TYPE);
    let chromium_type = NSString::from_str(CHROMIUM_WEB_CUSTOM_DATA_TYPE);
    let has_pinterest = unsafe { pasteboard_has_type(drag_info, &pinterest_type) };
    let has_web_urls = unsafe { pasteboard_has_type(drag_info, &web_urls_type) };
    let has_chromium = unsafe { pasteboard_has_type(drag_info, &chromium_type) };
    let has_url = unsafe { pasteboard_has_type(drag_info, NSPasteboardTypeURL) };
    let has_html = unsafe { pasteboard_has_type(drag_info, NSPasteboardTypeHTML) };
    let has_string = unsafe { pasteboard_has_type(drag_info, NSPasteboardTypeString) };
    eprintln!(
      "[native-drop-data] MAC_ENTER files=false pinterest={} web_urls={} chromium={} url={} html={} string={}",
      has_pinterest, has_web_urls, has_chromium, has_url, has_html, has_string
    );
    if has_pinterest || has_web_urls || has_chromium || has_url || has_html || has_string {
      paths.push(PathBuf::from(EXTERNAL_IMAGE_PENDING));
    }
  }
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Enter { paths, position }) {
    unsafe { objc2::msg_send![super(this), draggingEntered: drag_info] }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn dragging_updated(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Over { position }) {
    unsafe {
      let os_operation = objc2::msg_send![super(this), draggingUpdated: drag_info];
      if os_operation == NSDragOperation::None {
        NSDragOperation::Copy
      } else {
        os_operation
      }
    }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn perform_drag_operation(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
  let mut paths = unsafe { collect_paths(drag_info) };
  if paths.is_empty() {
    if let Some(url) = unsafe { external_image_url(drag_info) } {
      let source = if url.to_ascii_lowercase().contains("pinimg.com") {
        "pinterest"
      } else {
        "browser"
      };
      eprintln!(
        "[native-drop-data] MAC_DROP_EXTERNAL_IMAGE source={} url_bytes={}",
        source,
        url.len()
      );
      paths.push(PathBuf::from(format!("{}{}", EXTERNAL_IMAGE_PREFIX, url)));
    } else {
      eprintln!("[native-drop-data] MAC_DROP_UNRESOLVED files=false");
    }
  }
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Drop { paths, position }) {
    unsafe { objc2::msg_send![super(this), performDragOperation: drag_info] }
  } else {
    Bool::YES
  }
}

pub(crate) fn dragging_exited(this: &WryWebView, drag_info: &ProtocolObject<dyn NSDraggingInfo>) {
  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Leave) {
    unsafe { objc2::msg_send![super(this), draggingExited: drag_info] }
  }
}
