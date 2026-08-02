use serde::{Deserialize, Serialize};
use thiserror::Error;

/// User-facing error categories aligned with the shared TypeScript contracts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorCategory {
    Capture,
    Media,
    Storage,
    Project,
    Editor,
    Permissions,
    Unknown,
}

/// Standard application error returned from Tauri commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub category: ErrorCategory,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}

impl AppError {
    pub fn new(
        category: ErrorCategory,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            category,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Map<String, serde_json::Value>) -> Self {
        self.details = Some(details);
        self
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} [{}]: {}",
            self.category.as_str(),
            self.code,
            self.message
        )
    }
}

impl ErrorCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCategory::Capture => "capture",
            ErrorCategory::Media => "media",
            ErrorCategory::Storage => "storage",
            ErrorCategory::Project => "project",
            ErrorCategory::Editor => "editor",
            ErrorCategory::Permissions => "permissions",
            ErrorCategory::Unknown => "unknown",
        }
    }
}

/// Internal error type for Rust operations.
#[derive(Debug, Error)]
pub enum InternalError {
    #[error("capture failed: {0}")]
    Capture(String),
    #[error("media processing failed: {0}")]
    Media(String),
    #[error("storage operation failed: {0}")]
    Storage(String),
    #[error("project operation failed: {0}")]
    Project(String),
    #[error("permission denied: {0}")]
    Permissions(String),
    #[error("unknown error: {0}")]
    Unknown(String),
}

impl From<InternalError> for AppError {
    fn from(err: InternalError) -> Self {
        match err {
            InternalError::Capture(msg) => {
                AppError::new(ErrorCategory::Capture, "capture_failed", msg)
            }
            InternalError::Media(msg) => AppError::new(ErrorCategory::Media, "media_failed", msg),
            InternalError::Storage(msg) => {
                AppError::new(ErrorCategory::Storage, "storage_failed", msg)
            }
            InternalError::Project(msg) => {
                AppError::new(ErrorCategory::Project, "project_failed", msg)
            }
            InternalError::Permissions(msg) => {
                AppError::new(ErrorCategory::Permissions, "permissions_denied", msg)
            }
            InternalError::Unknown(msg) => AppError::new(ErrorCategory::Unknown, "unknown", msg),
        }
    }
}

impl From<tauri::Error> for AppError {
    fn from(err: tauri::Error) -> Self {
        AppError::new(ErrorCategory::Unknown, "tauri_error", err.to_string())
    }
}

impl From<tauri_plugin_global_shortcut::Error> for AppError {
    fn from(err: tauri_plugin_global_shortcut::Error) -> Self {
        AppError::new(
            ErrorCategory::Unknown,
            "global_shortcut_error",
            err.to_string(),
        )
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
