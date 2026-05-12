mod commands;
pub use commands::*;

use std::path::PathBuf;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir: PathBuf = app.path().app_data_dir()
                .expect("Failed to get app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("beatvault.db");
            let conn = init_db(&db_path).expect("Failed to open database");
            app.manage(DbState(std::sync::Mutex::new(conn)));
            let app_settings = load_settings(&data_dir);
            if let Some(ref f) = app_settings.beats_folder {
                std::fs::create_dir_all(f).ok();
            } else {
                std::fs::create_dir_all(data_dir.join("beats")).ok();
            }
            app.manage(SettingsState {
                settings: std::sync::Mutex::new(app_settings),
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_library,
            scan_beats_folder,
            scan_beat_folder,
            resolve_beat_files,
            read_beat_meta,
            save_beat_meta,
            rename_beat,
            reorder_beats,
            remove_beat_from_library,
            reveal_in_explorer,
            add_file_to_beat,
            get_settings,
            set_beats_folder,
            preview_beats_folder,
            import_selected_beats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BeatVault");
}
