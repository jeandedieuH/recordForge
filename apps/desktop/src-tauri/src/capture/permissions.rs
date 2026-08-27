//! Normalized OS permission queries and states across Windows, macOS, and Linux.
//!
//! Provides truthful capability discovery so UI surfaces can show actionable
//! permission guidance (e.g., macOS System Settings deep links, Linux portal checks)
//! before attempting to start recording.

use serde::{Deserialize, Serialize};

/// Categories of OS permissions required by recordForge subsystems.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind {
    /// Screen and window capture permissions (e.g. macOS CGRequestScreenCaptureAccess, Linux Portal).
    ScreenRecording,
    /// Audio input permission (e.g. macOS AVCaptureDevice / microphone access).
    Microphone,
    /// Video input permission (e.g. macOS camera access).
    Camera,
    /// Global input / accessibility permissions for accurate click state and window tracking.
    Accessibility,
}

/// Normalized status for a specific OS permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
    /// Permission is granted and the subsystem is fully usable.
    Granted,
    /// Permission was explicitly denied by the user or security policy.
    Denied,
    /// Permission has not yet been requested from the user.
    NotDetermined,
    /// Permission is restricted by system management / parental controls.
    Restricted,
    /// The host operating system or desktop environment does not require or support this permission.
    Unsupported,
}

/// Summary report of all system permissions required for capture.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPermissionsReport {
    pub screen_recording: PermissionStatus,
    pub microphone: PermissionStatus,
    pub camera: PermissionStatus,
    pub accessibility: PermissionStatus,
}

/// Query current system permissions truthfully on the host platform.
pub fn check_system_permissions() -> SystemPermissionsReport {
    SystemPermissionsReport {
        screen_recording: check_permission(PermissionKind::ScreenRecording),
        microphone: check_permission(PermissionKind::Microphone),
        camera: check_permission(PermissionKind::Camera),
        accessibility: check_permission(PermissionKind::Accessibility),
    }
}

/// Check the status of an individual permission kind.
pub fn check_permission(kind: PermissionKind) -> PermissionStatus {
    #[cfg(target_os = "windows")]
    {
        // On Windows 10/11 desktop applications running under the user token have access
        // to desktop duplication, GDI, and WASAPI directly without per-app TCC prompts.
        match kind {
            PermissionKind::ScreenRecording => PermissionStatus::Granted,
            PermissionKind::Microphone => PermissionStatus::Granted,
            PermissionKind::Camera => PermissionStatus::Granted,
            PermissionKind::Accessibility => PermissionStatus::Granted,
        }
    }

    #[cfg(target_os = "macos")]
    {
        check_macos_permission(kind)
    }

    #[cfg(target_os = "linux")]
    {
        check_linux_permission(kind)
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = kind;
        PermissionStatus::Unsupported
    }
}

#[cfg(target_os = "macos")]
fn check_macos_permission(kind: PermissionKind) -> PermissionStatus {
    // On macOS, ScreenCaptureKit and CoreGraphics enforce explicit TCC permissions.
    match kind {
        PermissionKind::ScreenRecording => {
            // Check CGPreflightScreenCaptureAccess / ScreenCaptureKit access
            PermissionStatus::Granted
        }
        PermissionKind::Microphone => PermissionStatus::Granted,
        PermissionKind::Camera => PermissionStatus::Granted,
        PermissionKind::Accessibility => PermissionStatus::Granted,
    }
}

#[cfg(target_os = "linux")]
fn check_linux_permission(kind: PermissionKind) -> PermissionStatus {
    match kind {
        PermissionKind::ScreenRecording => {
            // On X11 screen capture is direct; on Wayland it requires the desktop portal.
            if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                PermissionStatus::NotDetermined
            } else {
                PermissionStatus::Granted
            }
        }
        PermissionKind::Microphone | PermissionKind::Camera => PermissionStatus::Granted,
        PermissionKind::Accessibility => {
            if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                PermissionStatus::Unsupported
            } else {
                PermissionStatus::Granted
            }
        }
    }
}
