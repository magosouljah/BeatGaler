use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=BEATGALER_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-changed=src/commands.rs");
    println!("cargo:rerun-if-changed=direct-transport/transport-helper.source.mjs");
    println!("cargo:rerun-if-changed=../scripts/build-direct-temp-helper.mjs");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().expect("src-tauri parent");
    let helper_status = Command::new("node")
        .arg(repo_root.join("scripts/build-direct-temp-helper.mjs"))
        .current_dir(repo_root)
        .status()
        .expect("Task 5.1 requires Node to build the self-contained Desktop Direct helper");
    if !helper_status.success() {
        panic!("Task 5.1 Desktop temporary-auth helper bundle failed");
    }

    // commands.rs is the reviewed source of truth. Keep the generated include
    // used by lib.rs byte-for-byte identical instead of applying hidden build-time patches.
    let commands = fs::read_to_string(manifest_dir.join("src/commands.rs")).expect("read commands.rs");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out_dir.join("commands_task_5_1.rs"), commands).expect("write generated commands module");

    tauri_build::build();
}
