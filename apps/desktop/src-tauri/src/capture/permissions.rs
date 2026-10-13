//! Normalized OS permission queries and states across Windows, macOS, and Linux.
//!
//! Provides truthful capability discovery so UI surfaces can show actionable
//! permission guidance (e.g., macOS System Settings deep links, Linux portal checks)
//! before attempting to start recording.

use serde::{Deserialize, Serialize};

/// Categories of OS permissions required by RecordForge subsystems.
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
    use super::macos_native::{self, AvMediaKind};
    match kind {
        PermissionKind::ScreenRecording => {
            if macos_native::screen_recording_granted() {
                PermissionStatus::Granted
            } else {
                // Preflight cannot distinguish denied from not-determined;
                // the prompt fires once on first capture/request either way.
                PermissionStatus::Denied
            }
        }
        PermissionKind::Microphone => {
            av_authorization_to_status(macos_native::av_authorization_status(AvMediaKind::Audio))
        }
        PermissionKind::Camera => {
            av_authorization_to_status(macos_native::av_authorization_status(AvMediaKind::Video))
        }
        PermissionKind::Accessibility => {
            if macos_native::accessibility_trusted() {
                PermissionStatus::Granted
            } else {
                PermissionStatus::Denied
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn av_authorization_to_status(status: super::macos_native::AvAuthorization) -> PermissionStatus {
    use super::macos_native::AvAuthorization;
    match status {
        AvAuthorization::Authorized => PermissionStatus::Granted,
        AvAuthorization::Denied => PermissionStatus::Denied,
        AvAuthorization::Restricted => PermissionStatus::Restricted,
        AvAuthorization::NotDetermined => PermissionStatus::NotDetermined,
        AvAuthorization::Unknown => PermissionStatus::Unsupported,
    }
}

/// Ask the OS to grant the given permission where a direct request API
/// exists. Screen recording and accessibility have prompt APIs; mic/camera
/// request their prompt on first device open, so the UI should deep-link to
/// System Settings for those instead.
///
/// Returns true when the permission is already (or newly) granted.
pub fn request_permission(kind: PermissionKind) -> bool {
    #[cfg(target_os = "macos")]
    {
        use super::macos_native;
        match kind {
            PermissionKind::ScreenRecording => macos_native::request_screen_recording_access(),
            PermissionKind::Accessibility => macos_native::request_accessibility_access(),
            // +[AVCaptureDevice requestAccessForMediaType:completionHandler:]
            // requires an ObjC block — the device-open path triggers the same
            // prompt, so callers should deep-link to System Settings here.
            PermissionKind::Microphone | PermissionKind::Camera => {
                check_permission(kind) == PermissionStatus::Granted
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        check_permission(kind) == PermissionStatus::Granted
    }
}

/// macOS preflight used by recorder startup: if the screen-recording grant is
/// missing, fire the system request once (undetermined only), then re-check.
/// `false` means the grant is absent — the capture would fail inside ffmpeg
/// with an opaque avfoundation error, so callers should refuse the start.
#[cfg(target_os = "macos")]
pub fn ensure_screen_recording_permission() -> bool {
    if super::macos_native::screen_recording_granted() {
        return true;
    }
    let _ = super::macos_native::request_screen_recording_access();
    super::macos_native::screen_recording_granted()
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
