fn main() {
    println!("cargo:rerun-if-env-changed=BEATGALER_UPDATER_ENDPOINT");
    tauri_build::build()
}
