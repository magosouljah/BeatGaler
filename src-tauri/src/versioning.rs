use rusqlite::Connection;
use serde_json::{json, Value};

/// Private compatibility identifier for Galer T-Library Schema v2.
/// This wire value is not user-facing and must remain stable for existing libraries.
pub const GALER_T_LIBRARY_SCHEMA: &str = "beatgaler.telegram.library";

/// Current Galer T-Library Schema emitted by BeatGaler v0.4.0.
pub const GALER_T_LIBRARY_SCHEMA_VERSION: i64 = 2;

/// Current local SQLite schema understood by BeatGaler v0.4.0.
pub const SQLITE_SCHEMA_VERSION: i64 = 2;

/// Validate and normalize a Galer T-Library manifest before the rest of the
/// application consumes it. Older compatible manifests are upgraded in-memory;
/// a future schema is rejected so an older app never rewrites newer data.
pub fn normalize_galer_t_library_manifest(mut manifest: Value) -> Result<Value, String> {
    if manifest.get("schema").and_then(|v| v.as_str()) != Some(GALER_T_LIBRARY_SCHEMA) {
        return Err("Pinned cloud document is not a BeatGaler library index.".to_string());
    }

    let version = manifest
        .get("version")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);

    if version > GALER_T_LIBRARY_SCHEMA_VERSION {
        return Err(format!(
            "This BeatGaler build supports Galer T-Library Schema up to v{}, but the library uses v{}. Update BeatGaler before modifying this library.",
            GALER_T_LIBRARY_SCHEMA_VERSION,
            version
        ));
    }

    if version < 1 {
        return Err(format!(
            "Unsupported Galer T-Library Schema version {}.",
            version
        ));
    }

    // v1 -> v2: trash became an explicit top-level collection. Existing beats
    // are unchanged. This migration is intentionally in-memory only; the
    // normalized v2 form is published on the next ordinary library mutation.
    if version == 1 {
        let root = manifest
            .as_object_mut()
            .ok_or_else(|| "Cloud library index root is invalid.".to_string())?;

        root.entry("beats")
            .or_insert_with(|| Value::Array(Vec::new()));

        root.entry("trash")
            .or_insert_with(|| Value::Array(Vec::new()));

        root.insert("version".to_string(), json!(2));
    }

    let root = manifest
        .as_object_mut()
        .ok_or_else(|| "Cloud library index root is invalid.".to_string())?;

    root.entry("beats")
        .or_insert_with(|| Value::Array(Vec::new()));

    root.entry("trash")
        .or_insert_with(|| Value::Array(Vec::new()));

    Ok(manifest)
}

/// Run SQLite schema migrations atomically.
/// A future schema is rejected so an older BeatGaler build cannot rewrite it.
pub fn migrate_sqlite_schema(conn: &mut Connection) -> rusqlite::Result<()> {
    use rusqlite::TransactionBehavior;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    tx.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     INTEGER PRIMARY KEY,
            applied_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        ",
    )?;

    let current: i64 =
        tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if current > SQLITE_SCHEMA_VERSION {
        return Err(rusqlite::Error::InvalidQuery);
    }

    if current < 1 {
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations (version) VALUES (1)",
            [],
        )?;
    }

    if current < 2 {
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations (version) VALUES (2)",
            [],
        )?;
    }

    tx.pragma_update(None, "user_version", SQLITE_SCHEMA_VERSION)?;

    tx.commit()?;

    Ok(())
}