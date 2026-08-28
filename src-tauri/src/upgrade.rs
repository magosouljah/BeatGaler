use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Bundle identifier used by the audited 0.7.4 Desktop baseline.
/// Tauri derives app_data_dir from the bundle identifier, so changing it without
/// a bridge would strand the user's existing SQLite/settings/offline state.
pub const LEGACY_BUNDLE_IDENTIFIER: &str = "vtm.beatgaler.playground";
const LEGACY_MIGRATION_MARKER: &str = ".galer-upgrade-from-vtm.beatgaler.playground";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LegacyMigrationReport {
    pub source: Option<PathBuf>,
    pub copied_files: usize,
    pub created_dirs: usize,
    pub skipped_existing: usize,
    pub skipped_symlinks: usize,
    pub marker_already_present: bool,
}

fn copy_missing_tree(source: &Path, destination: &Path, report: &mut LegacyMigrationReport) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());

        // Never follow a legacy symlink/junction into an arbitrary user path.
        // Upgrade migration copies only files/directories physically owned by
        // the old app-data tree.
        if file_type.is_symlink() {
            report.skipped_symlinks += 1;
            continue;
        }

        if file_type.is_dir() {
            if target.exists() && !target.is_dir() {
                report.skipped_existing += 1;
                continue;
            }
            if !target.exists() {
                fs::create_dir_all(&target)?;
                report.created_dirs += 1;
            }
            copy_missing_tree(&entry.path(), &target, report)?;
            continue;
        }

        if file_type.is_file() {
            if target.exists() {
                // Never overwrite state already written by the new identity.
                // This also makes an interrupted migration safely resumable.
                report.skipped_existing += 1;
                continue;
            }
            fs::copy(entry.path(), &target)?;
            report.copied_files += 1;
        }
    }
    Ok(())
}

/// Non-destructively bridge the 0.7.4 app-data directory into the directory
/// selected by the current bundle identifier.
///
/// The source remains untouched so a rollback to 0.7.4 still sees its data.
/// Existing destination files always win. The marker is written only after a
/// complete traversal, so a crash or I/O error simply resumes on the next run.
pub fn migrate_legacy_app_data(data_dir: &Path) -> io::Result<LegacyMigrationReport> {
    let mut report = LegacyMigrationReport::default();

    if data_dir.file_name().and_then(|value| value.to_str()) == Some(LEGACY_BUNDLE_IDENTIFIER) {
        return Ok(report);
    }

    let Some(parent) = data_dir.parent() else {
        return Ok(report);
    };
    let legacy_dir = parent.join(LEGACY_BUNDLE_IDENTIFIER);
    if !legacy_dir.is_dir() {
        return Ok(report);
    }
    report.source = Some(legacy_dir.clone());

    fs::create_dir_all(data_dir)?;
    let marker = data_dir.join(LEGACY_MIGRATION_MARKER);
    if marker.is_file() {
        report.marker_already_present = true;
        return Ok(report);
    }

    copy_missing_tree(&legacy_dir, data_dir, &mut report)?;

    let marker_tmp = data_dir.join(format!("{}.tmp", LEGACY_MIGRATION_MARKER));
    let marker_body = format!(
        "source={}\ncopied_files={}\ncreated_dirs={}\nskipped_existing={}\nskipped_symlinks={}\n",
        legacy_dir.display(),
        report.copied_files,
        report.created_dirs,
        report.skipped_existing,
        report.skipped_symlinks,
    );
    fs::write(&marker_tmp, marker_body)?;
    fs::rename(marker_tmp, marker)?;
    Ok(report)
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn move_preserving(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            // Cross-device and some antivirus/filesystem cases reject rename.
            // Copy + remove is safe here because the destination is a recovery
            // quarantine and the caller will create a fresh SQLite database.
            if let Err(copy_error) = fs::copy(source, destination) {
                return Err(io::Error::new(
                    copy_error.kind(),
                    format!("rename failed ({rename_error}); copy failed ({copy_error})"),
                ));
            }
            fs::remove_file(source)
        }
    }
}

/// Preserve an unreadable SQLite database (plus WAL/SHM when present) before a
/// fresh database is created. Nothing is silently deleted.
pub fn quarantine_sqlite_family(db_path: &Path) -> io::Result<PathBuf> {
    let parent = db_path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "SQLite path has no parent"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let recovery_dir = parent.join("recovery").join(format!("sqlite-{stamp}"));
    fs::create_dir_all(&recovery_dir)?;

    let db_name = db_path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "SQLite path has no filename"))?;

    for suffix in ["", "-wal", "-shm"] {
        let source = path_with_suffix(db_path, suffix);
        if !source.is_file() {
            continue;
        }
        let mut destination_name = db_name.to_os_string();
        destination_name.push(suffix);
        move_preserving(&source, &recovery_dir.join(destination_name))?;
    }

    Ok(recovery_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "galer-upgrade-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn copies_074_state_without_destroying_rollback_source() {
        let root = test_root("copy");
        let legacy = root.join(LEGACY_BUNDLE_IDENTIFIER);
        let current = root.join("com.beatgaler.app");
        fs::create_dir_all(legacy.join("offline/user/beat")).unwrap();
        fs::create_dir_all(legacy.join("cloud-library/beat")).unwrap();
        fs::write(legacy.join("beatvault.db"), b"sqlite-fixture").unwrap();
        fs::write(legacy.join("settings.json"), br#"{"playback_cache_limit_mb":2048}"#).unwrap();
        fs::write(legacy.join("offline/user/beat/master.mp3"), b"offline-master").unwrap();
        fs::write(legacy.join("cloud-library/beat/index.json"), b"cache-like-state").unwrap();

        let report = migrate_legacy_app_data(&current).unwrap();
        assert_eq!(report.source.as_deref(), Some(legacy.as_path()));
        assert!(report.copied_files >= 4);
        assert_eq!(fs::read(current.join("beatvault.db")).unwrap(), b"sqlite-fixture");
        assert_eq!(fs::read(current.join("settings.json")).unwrap(), br#"{"playback_cache_limit_mb":2048}"#);
        assert_eq!(fs::read(current.join("offline/user/beat/master.mp3")).unwrap(), b"offline-master");
        assert_eq!(fs::read(legacy.join("beatvault.db")).unwrap(), b"sqlite-fixture");
        assert!(current.join(LEGACY_MIGRATION_MARKER).is_file());

        let second = migrate_legacy_app_data(&current).unwrap();
        assert!(second.marker_already_present);
        assert_eq!(second.copied_files, 0);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_new_identity_state_wins_over_legacy_conflicts() {
        let root = test_root("no-overwrite");
        let legacy = root.join(LEGACY_BUNDLE_IDENTIFIER);
        let current = root.join("com.beatgaler.app");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&current).unwrap();
        fs::write(legacy.join("settings.json"), b"legacy").unwrap();
        fs::write(current.join("settings.json"), b"current").unwrap();

        let report = migrate_legacy_app_data(&current).unwrap();
        assert!(report.skipped_existing >= 1);
        assert_eq!(fs::read(current.join("settings.json")).unwrap(), b"current");
        assert_eq!(fs::read(legacy.join("settings.json")).unwrap(), b"legacy");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clean_install_and_incomplete_legacy_tree_are_valid() {
        let root = test_root("clean");
        let current = root.join("com.beatgaler.app");
        let clean = migrate_legacy_app_data(&current).unwrap();
        assert!(clean.source.is_none());

        let legacy = root.join(LEGACY_BUNDLE_IDENTIFIER);
        fs::create_dir_all(legacy.join("offline/partial")).unwrap();
        fs::write(legacy.join("settings.json"), b"{}").unwrap();
        let partial = migrate_legacy_app_data(&current).unwrap();
        assert!(partial.source.is_some());
        assert_eq!(fs::read(current.join("settings.json")).unwrap(), b"{}");
        assert!(current.join("offline/partial").is_dir());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_sqlite_family_is_quarantined_not_deleted() {
        let root = test_root("quarantine");
        fs::create_dir_all(&root).unwrap();
        let db = root.join("beatvault.db");
        fs::write(&db, b"not-a-database").unwrap();
        fs::write(path_with_suffix(&db, "-wal"), b"wal").unwrap();
        fs::write(path_with_suffix(&db, "-shm"), b"shm").unwrap();

        let recovery = quarantine_sqlite_family(&db).unwrap();
        assert!(!db.exists());
        assert_eq!(fs::read(recovery.join("beatvault.db")).unwrap(), b"not-a-database");
        assert_eq!(fs::read(recovery.join("beatvault.db-wal")).unwrap(), b"wal");
        assert_eq!(fs::read(recovery.join("beatvault.db-shm")).unwrap(), b"shm");

        let _ = fs::remove_dir_all(root);
    }
}
