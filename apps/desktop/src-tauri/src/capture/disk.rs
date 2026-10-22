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

            // A virus scanner, search indexer, or another thread can hold the
            // destination open for the instant ReplaceFileW needs to delete it;
            // Windows then reports ERROR_UNABLE_TO_REMOVE_REPLACED or a sharing/
            // lock violation. Those are transient — retry briefly instead of
            // failing the recording's manifest publish.
            const TRANSIENT: [u32; 3] = [0x8007_0497, 0x8007_0020, 0x8007_0021];
            const MAX_ATTEMPTS: u32 = 5;
            for attempt in 1..=MAX_ATTEMPTS {
                let result = unsafe {
                    ReplaceFileW(
                        PCWSTR(destination_wide.as_ptr()),
                        PCWSTR(temp_wide.as_ptr()),
                        PCWSTR::null(),
                        REPLACEFILE_WRITE_THROUGH,
                        None,
                        None,
                    )
                };
                match result {
                    Ok(()) => return Ok(()),
                    Err(error)
                        if attempt < MAX_ATTEMPTS
                            && TRANSIENT.contains(&(error.code().0 as u32)) =>
                    {
                        std::thread::sleep(std::time::Duration::from_millis(
                            20 * u64::from(attempt),
                        ));
                    }
                    Err(error) => {
                        return Err(crate::errors::InternalError::Storage(format!(
                            "replace destination: {error}"
                        ))
                        .into());
                    }
                }
            }
            unreachable!("replace loop returns on success or final error");
        }
    }

    std::fs::rename(temp, destination)
        .map_err(|e| crate::errors::InternalError::Storage(format!("publish destination: {e}")))?;

    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use std::os::windows::fs::OpenOptionsExt;

    /// A scanner/indexer holding the destination open for an instant must not
    /// fail the publish: ReplaceFileW fails with a sharing violation inside
    /// that window, so `atomic_replace` retries instead of erroring.
    #[test]
    fn atomic_replace_retries_through_a_transient_lock() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("manifest.json");
        let temp = directory.path().join("manifest.json.tmp");
        std::fs::write(&destination, b"old").unwrap();
        std::fs::write(&temp, b"new").unwrap();

        let guarded = destination.clone();
        let guard = std::thread::spawn(move || {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&guarded)
                .expect("open destination without sharing");
            std::thread::sleep(std::time::Duration::from_millis(60));
            drop(file);
        });

        // Let the guard win the race to open the file before the replace runs.
        std::thread::sleep(std::time::Duration::from_millis(20));
        super::atomic_replace(&temp, &destination).expect("replace survives a transient lock");
        guard.join().unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"new");
        assert!(!temp.exists(), "temp file must be consumed by the replace");
    }
}
