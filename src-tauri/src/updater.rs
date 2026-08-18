use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

const COMPILED_UPDATER_ENDPOINT: Option<&str> = option_env!("BEATGALER_UPDATER_ENDPOINT");

#[derive(Debug, Clone, Serialize)]
pub struct AppUpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

fn updater_endpoint() -> Result<&'static str, String> {
    let endpoint = COMPILED_UPDATER_ENDPOINT
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Updates are not configured for this build.".to_string())?;

    if !endpoint.starts_with("https://") {
        return Err("The update service is not configured securely.".to_string());
    }
    Ok(endpoint)
}

fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = updater_endpoint()?;
    let parsed = endpoint
        .parse()
        .map_err(|_| "The update service URL is invalid.".to_string())?;

    app.updater_builder()
        .endpoints(vec![parsed])
        .map_err(|_| "The update service could not be configured.".to_string())?
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "The update service could not be initialized.".to_string())
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<AppUpdateInfo, String> {
    let updater = build_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|_| "Could not check for updates right now.".to_string())?;

    match update {
        Some(update) => Ok(AppUpdateInfo {
            available: true,
            current_version: update.current_version.clone(),
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            date: update.date.map(|value| value.to_string()),
        }),
        None => Ok(AppUpdateInfo {
            available: false,
            current_version: app.package_info().version.to_string(),
            version: None,
            notes: None,
            date: None,
        }),
    }
}

#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), String> {
    let updater = build_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|_| "Could not check for updates right now.".to_string())?
        .ok_or_else(|| "Beat Galer is already up to date.".to_string())?;

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| "The update could not be downloaded or installed.".to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_endpoint_is_https_when_present() {
        if let Some(endpoint) = COMPILED_UPDATER_ENDPOINT {
            assert!(endpoint.trim().starts_with("https://"));
        }
    }
}
