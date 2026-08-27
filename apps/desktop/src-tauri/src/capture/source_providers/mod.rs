//! Platform source providers for discovering displays, windows, and regions.

pub mod linux;
pub mod macos;
pub mod windows;

pub use linux::LinuxSourceProvider;
pub use macos::MacosSourceProvider;
pub use windows::WindowsSourceProvider;

use crate::capture::traits::SourceProvider;

/// Return the appropriate SourceProvider instance for the active host platform.
pub fn get_source_provider() -> Box<dyn SourceProvider> {
    #[cfg(windows)]
    {
        Box::new(WindowsSourceProvider)
    }

    #[cfg(target_os = "macos")]
    {
        Box::new(MacosSourceProvider)
    }

    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxSourceProvider)
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        Box::new(WindowsSourceProvider)
    }
}
