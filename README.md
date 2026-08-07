# Beat Galer — Setup Guide

## Prerequisites

Install these once on your machine:

### 1. Node.js (v20+)
https://nodejs.org/

### 2. Rust
```
winget install Rustlang.Rustup
```
Or: https://rustup.rs/

### 3. Tauri prerequisites (Windows)
```
winget install Microsoft.VisualStudio.2022.BuildTools
```
During install, select: **C++ build tools** workload.

### 4. Tauri CLI
```
npm install -g @tauri-apps/cli
```

---

## Run in development

```bash
cd beat-galer
npm install
npm run tauri dev
```

This opens the app window. Hot-reload works for the React frontend.
The Rust backend recompiles when you change `src-tauri/src/`.

---

## Build for production

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/`
- Windows: `.msi` installer + `.exe`

---

## How it works

### Audio playback
- Uses Tauri's `asset://` protocol to stream MP3s directly from disk
- `convertFileSrc(path)` converts `C:\...\beat.mp3` → `asset://localhost/C:/.../beat.mp3`
- HTML5 `<audio>` plays it natively — real seek, real duration

### Reading ID3 tags
- Rust `id3` crate reads TBPM, TKEY, TCON, POPM, APIC from the MP3
- APIC (embedded image) is extracted and base64-encoded for the UI
- Genre (TCON) is split by `;` `/` `,` into individual tags

### Writing ID3 tags
- When you click "Save changes" in the drawer, Rust writes ID3v2.4 tags directly to the MP3 file on disk
- Fields written: BPM, Key, Genre/Tags, Rating (POPM), artwork (APIC)
- No copy — edits the original file

### Renaming
- If the beat name changes, Rust renames the folder on disk
- All file paths are updated in the UI state automatically

---

## Project Structure

```
beat-galer/
├── src/                     ← React frontend
│   ├── App.tsx              ← Main app, state management
│   ├── components/
│   │   ├── BeatCard.tsx     ← Grid card
│   │   ├── Drawer.tsx       ← Detail/edit panel
│   │   ├── Player.tsx       ← Bottom player bar
│   │   ├── AddBeatModal.tsx ← File picker + folder scan
│   │   └── ui.tsx           ← Shared: Artwork, Stars, Tags, Icons
│   ├── hooks/
│   │   └── useAudio.ts      ← HTML5 Audio playback hook
│   ├── lib/
│   │   └── tauri.ts         ← All invoke() calls in one place
│   └── types/
│       └── index.ts         ← Shared TypeScript types
│
└── src-tauri/               ← Rust backend
    └── src/
        ├── main.rs          ← Entry point
        ├── lib.rs           ← Registers commands + plugin setup
        └── commands.rs      ← All Tauri commands:
                               scan_beats_folder
                               read_beat_meta
                               save_beat_meta
                               rename_beat
                               reveal_in_explorer
```

---

## Beat folder structure expected

```
C:\Users\...\ALL MY BEATS\
├── Beat Name\
│   ├── anyname.mp3        ← required (first .mp3 found)
│   ├── anyname.wav        ← optional
│   ├── stems.zip          ← optional (filename must contain "stem")
│   └── proyecto.zip       ← optional (filename must contain "flp", "project", or "proyecto")
└── ...
```

---

## Notes

- **Only Chrome/Chromium WebView** is used inside Tauri — no browser compatibility issues
- The library is **in-memory only** for now — on next open you need to re-scan the folder.
  Next step: add SQLite cache with `tauri-plugin-sql`
