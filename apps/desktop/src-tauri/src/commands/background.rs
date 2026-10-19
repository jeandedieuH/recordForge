use tauri::State;

use crate::errors::{InternalError, Result};
use crate::exports::background;
use crate::state::AppState;

/// Virtual-background model readiness for the export card.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualBackgroundStatus {
    pub supported: bool,
    pub model_ready: bool,
}

/// Virtual background is desktop-wide — `tract` runs the ONNX model on CPU.
#[tauri::command]
pub fn get_virtual_background_status(
    state: State<'_, AppState>,
) -> Result<VirtualBackgroundStatus> {
    let model = background::model_path(state.path_policy.app_data_dir());
    Ok(VirtualBackgroundStatus {
        supported: true,
        model_ready: model.exists(),
    })
}

/// Download the segmentation model (~450 KB) into app data. Emits
/// `virtual-background-download` progress events.
#[tauri::command]
pub async fn download_virtual_background_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    if !state.license.entitlements().pro_enabled {
        return Err(virtual_background_pro_required());
    }
    let _update_operation = state.update_gate.acquire_operation()?;
    // Single-flight: concurrent controller instances queue here and the
    // second one exits immediately once the first wrote the model.
    let _provision = state.model_provision.lock().await;
    let dir = state.path_policy.app_data_dir().to_path_buf();
    if background::model_path(&dir).exists() {
        return Ok(());
    }
    let app_handle = app.clone();
    background::ensure_model(&dir, move |downloaded, total| {
        let _ = tauri::Emitter::emit(
            &app_handle,
            "virtual-background-download",
            serde_json::json!({
                "downloadedBytes": downloaded,
                "totalBytes": total,
            }),
        );
    })
    .await?;
    Ok(())
}

/// Remove the downloaded model.
#[tauri::command]
pub async fn delete_virtual_background_model(state: State<'_, AppState>) -> Result<()> {
    let path = background::model_path(state.path_policy.app_data_dir());
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| InternalError::Storage(format!("delete model: {e}")))?;
    }
    Ok(())
}

fn virtual_background_pro_required() -> crate::errors::AppError {
    crate::errors::AppError::new(
        crate::errors::ErrorCategory::Licensing,
        "pro_feature_required",
        "This feature requires RecordForge Pro",
    )
    .with_details(
        [(
            "features".to_string(),
            serde_json::json!(["virtual-background"]),
        )]
        .into_iter()
        .collect(),
    )
}
