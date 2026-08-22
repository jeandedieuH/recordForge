use std::fs::OpenOptions;
use std::path::Path;

/// Flush a completed media or manifest file before it is referenced by recovery metadata.
pub fn sync_file(path: &Path) -> crate::errors::Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| crate::errors::InternalError::Storage(format!("open file for sync: {e}")))?;

    file.sync_all()
        .map_err(|e| crate::errors::InternalError::Storage(format!("sync file: {e}")))
        .map(|_| ())
        .map_err(Into::into)
}

/// Publish a completed temporary file without exposing a partially-written target.
pub fn atomic_replace(temp: &Path, destination: &Path) -> crate::errors::Result<()> {
    #[cfg(windows)]
    {
        if destination.exists() {
            use std::os::windows::ffi::OsStrExt;
            use windows::core::PCWSTR;
            use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

            let destination_wide: Vec<u16> = destination
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let temp_wide: Vec<u16> = temp
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            unsafe {
                ReplaceFileW(
                    PCWSTR(destination_wide.as_ptr()),
                    PCWSTR(temp_wide.as_ptr()),
                    PCWSTR::null(),
                    REPLACEFILE_WRITE_THROUGH,
                    None,
                    None,
                )
                .map_err(|e| {
                    crate::errors::InternalError::Storage(format!("replace destination: {e}"))
                })?;
            }

            return Ok(());
        }
    }

    std::fs::rename(temp, destination)
        .map_err(|e| crate::errors::InternalError::Storage(format!("publish destination: {e}")))?;

    Ok(())
}
