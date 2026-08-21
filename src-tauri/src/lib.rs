mod matcher;
mod commands;
mod versioning;
mod updater;
pub use commands::*;
pub use updater::*;

use std::path::PathBuf;
use tauri::Manager;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance must be registered first. A second launch focuses the
        // existing window instead of creating a second SQLite/Direct runtime.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // macOS red close button should close the window visually, not
                // terminate BeatGaler or destroy the only main window. Cmd+Q /
                // app Quit still reaches RunEvent::ExitRequested below.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let data_dir: PathBuf = app.path().app_data_dir().expect("Failed to get app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            set_direct_runtime_data_dir(&data_dir);
            let db_path = data_dir.join("beatvault.db");
            let conn = init_db(&db_path).expect("Failed to open database");
            let purged = purge_old_trash_internal(&conn, &data_dir, 14);
            if purged > 0 { log_line(&data_dir, "INFO", &format!("Startup: purged {} old trash item(s)", purged)); }
            let purged_templates = purge_old_template_trash_internal(&conn, &data_dir, 14);
            if purged_templates > 0 { log_line(&data_dir, "INFO", &format!("Startup: purged {} old preset trash item(s)", purged_templates)); }
            app.manage(DbState(std::sync::Mutex::new(conn)));
            let app_settings = load_settings(&data_dir);
            if let Some(ref f) = app_settings.beats_folder { std::fs::create_dir_all(f).ok(); }
            else { std::fs::create_dir_all(data_dir.join("beats")).ok(); }
            app.manage(SettingsState { settings: std::sync::Mutex::new(app_settings), data_dir: data_dir.clone() });
            app.manage(ImportBatchState(std::sync::Mutex::new(std::collections::HashMap::new())));
            app.manage(JobRegistry(std::sync::Mutex::new(std::collections::HashMap::new())));
            let (tx, rx) = std::sync::mpsc::channel::<QueuedUploadJob>();
            std::thread::spawn(move || run_upload_worker(rx));
            app.manage(UploadQueueState(std::sync::Mutex::new(tx)));
            app.manage(DirectTransportExitGuard);

            // Finder/Explorer filesystem drops use Tauri native paths. On macOS
            // the HTML controller remains installed only as the browser-artwork
            // fallback; the native arbiter prevents duplicate file staging.
            eprintln!("[native-drop] Tauri native filesystem drop enabled os={}", std::env::consts::OS);

            log_line(&data_dir, "INFO", "BeatVault started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_library, scan_beats_folder, scan_beat_folder, resolve_beat_files, read_beat_meta,
            save_beat_meta, inspect_audio_metadata, rename_tag_everywhere, rename_beat, reorder_beats,
            remove_beat_from_library, purge_interrupted_upload_local, list_trash, restore_beat_from_trash, purge_trash_now, get_log_dir, review_perf_log, diagnostic_log,
            reveal_in_explorer, path_is_directory, read_image_file_data_url, open_project_file, add_file_to_beat, get_settings, set_incomplete_warnings_enabled, get_playback_cache_status, set_playback_cache_limit_mb, clear_playback_cache,
            set_custom_cursor_enabled, set_beats_folder, preview_beats_folder, import_selected_beats,
            start_import_review_stream, get_import_review_batch_summary, preview_import_batch, prepare_next_import_review_beat, resolve_import_audio_conflict, discard_import_review_batch,
            list_openable_cloud_project_beat_ids, merge_folder_into_existing_beat,
            inspect_beat_update_folder, resolve_import_decisions, save_youtube_oauth_config, get_youtube_channel,
            connect_youtube_channel, upload_to_youtube, start_youtube_upload, cancel_youtube_upload,
            disconnect_youtube, connect_telegram_cloud, poll_telegram_cloud_status, get_telegram_cloud_status,
            disconnect_telegram_cloud, set_cloud_auth_token, upload_beat_to_telegram, upload_dropped_file_to_telegram,
            sync_beat_metadata_to_telegram, sync_cloud_library_index, repair_stale_cloud_library_refs, restore_library_from_telegram, load_cloud_artwork_for_beat,
            clear_local_cloud_vault, detach_local_sources_after_cloud_upload, list_cloud_files_for_beat,
            download_cloud_file_to_cache, copy_export_file, copy_audio_metadata, prepare_unique_export_folder, start_background_download,
            download_beat_from_telegram, make_beat_available_offline, remove_beat_offline_availability, load_offline_library, record_offline_trash_intent, flush_offline_trash_intents,
            prepare_beat_for_playback, warm_beat_for_playback, prefetch_beat_for_playback, get_download_cooking_status, download_cooking_diagnostic_event, upload_project_to_telegram,
            get_project_cloud_status, inspect_project_drop_source, open_beat_project, download_project_to_cache, update_project_archive_from_source,
            get_settings, set_beats_folder, set_templates_folder, get_templates_dir, list_template_files,
            delete_template_file, read_template_file, write_template_file, delete_template_to_trash,
            list_template_trash, restore_template_from_trash, purge_template_trash_now,
            check_app_update, install_app_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building BeatVault")
        .run(|app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    // Do not rely only on managed-state Drop: on some desktop
                    // shutdown paths the process can tear down before that guard
                    // gets a useful authenticated HTTP window. Release while the
                    // Tauri event loop is still alive. The runtime take() makes
                    // this idempotent if ExitRequested and Exit both fire.
                    shutdown_direct_transport_runtime();
                }
                _ => {}
            }
        });
}
