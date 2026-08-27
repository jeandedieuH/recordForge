//! OS Credential Vault Interface
//!
//! Provides secure storage for cloud storage credentials (S3 access/secret keys,
//! Google OAuth tokens) in the native Windows Credential Manager.
//!
//! Credentials are NEVER stored in plaintext code, project files, or SQLite.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tracing::info;

use crate::errors::{InternalError, Result};

pub const SERVICE_NAME: &str = "recordForge";

static IN_MEMORY_FALLBACK: OnceLock<Arc<Mutex<HashMap<String, String>>>> = OnceLock::new();

fn get_in_memory_store() -> &'static Arc<Mutex<HashMap<String, String>>> {
    IN_MEMORY_FALLBACK.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn vault_target_name(account: &str) -> String {
    format!("{}:{}", SERVICE_NAME, account)
}

/// Store a secret key in the OS Credential Vault.
pub fn set_secret(account: &str, secret: &str) -> Result<()> {
    info!(account = %account, "storing credential in OS vault");

    #[cfg(windows)]
    {
        use windows::core::PWSTR;
        use windows::Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        };

        let target = vault_target_name(account);
        let mut target_utf16: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        let mut user_utf16: Vec<u16> = account.encode_utf16().chain(std::iter::once(0)).collect();
        let secret_bytes = secret.as_bytes();

        let cred = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target_utf16.as_mut_ptr()),
            Comment: PWSTR(std::ptr::null_mut()),
            LastWritten: windows::Win32::Foundation::FILETIME::default(),
            CredentialBlobSize: secret_bytes.len() as u32,
            CredentialBlob: secret_bytes.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: PWSTR(std::ptr::null_mut()),
            UserName: PWSTR(user_utf16.as_mut_ptr()),
        };

        unsafe {
            if CredWriteW(&cred, 0).is_ok() {
                return Ok(());
            } else {
                tracing::warn!("CredWriteW failed, falling back to memory vault");
            }
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, account) {
            if let Err(err) = entry.set_password(secret) {
                tracing::warn!(error = %err, "keyring set_password failed; falling back to memory vault");
            } else {
                return Ok(());
            }
        }
    }

    // Fallback store
    let store = get_in_memory_store();
    let mut map = store
        .lock()
        .map_err(|_| InternalError::Storage("vault mutex poisoned".into()))?;
    map.insert(vault_target_name(account), secret.to_string());
    Ok(())
}

/// Retrieve a secret key from the OS Credential Vault.
pub fn get_secret(account: &str) -> Result<Option<String>> {
    info!(account = %account, "retrieving credential from OS vault");

    #[cfg(windows)]
    {
        use windows::core::PWSTR;
        use windows::Win32::Security::Credentials::{
            CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
        };

        let target = vault_target_name(account);
        let mut target_utf16: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();

        unsafe {
            if CredReadW(
                PWSTR(target_utf16.as_mut_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut cred_ptr,
            )
            .is_ok()
                && !cred_ptr.is_null()
            {
                let cred = *cred_ptr;
                let slice = std::slice::from_raw_parts(
                    cred.CredentialBlob,
                    cred.CredentialBlobSize as usize,
                );
                let secret_str = String::from_utf8(slice.to_vec()).ok();
                CredFree(cred_ptr as *const _);
                if let Some(secret) = secret_str {
                    return Ok(Some(secret));
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, account) {
            match entry.get_password() {
                Ok(secret) => return Ok(Some(secret)),
                Err(keyring::Error::NoEntry) => return Ok(None),
                Err(err) => {
                    tracing::warn!(error = %err, "keyring get_password failed; checking memory vault");
                }
            }
        }
    }

    // Fallback store
    let store = get_in_memory_store();
    let map = store
        .lock()
        .map_err(|_| InternalError::Storage("vault mutex poisoned".into()))?;
    Ok(map.get(&vault_target_name(account)).cloned())
}

/// Delete a secret key from the OS Credential Vault.
pub fn delete_secret(account: &str) -> Result<()> {
    info!(account = %account, "deleting credential from OS vault");

    #[cfg(windows)]
    {
        use windows::core::PWSTR;
        use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

        let target = vault_target_name(account);
        let mut target_utf16: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let _ = CredDeleteW(PWSTR(target_utf16.as_mut_ptr()), CRED_TYPE_GENERIC, None);
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, account) {
            let _ = entry.delete_credential();
        }
    }

    // Fallback store
    let store = get_in_memory_store();
    let mut map = store
        .lock()
        .map_err(|_| InternalError::Storage("vault mutex poisoned".into()))?;
    map.remove(&vault_target_name(account));
    Ok(())
}

/// Redact sensitive secret strings from log outputs and diagnostics.
pub fn redact_secret(secret: &str) -> String {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return "".into();
    }
    if trimmed.len() <= 4 {
        "****".into()
    } else {
        format!("{}...****", &trimmed[..4])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_secret() {
        assert_eq!(redact_secret("AKIAIOSFODNN7EXAMPLE"), "AKIA...****");
        assert_eq!(redact_secret("abc"), "****");
        assert_eq!(redact_secret(""), "");
    }

    #[test]
    fn test_vault_roundtrip() {
        let test_account = "test-account-roundtrip";
        let test_secret = "my-super-secret-key-12345";

        set_secret(test_account, test_secret).expect("set_secret should succeed");
        let retrieved = get_secret(test_account).expect("get_secret should succeed");
        assert_eq!(retrieved, Some(test_secret.to_string()));

        delete_secret(test_account).expect("delete_secret should succeed");
        let after_delete = get_secret(test_account).expect("get_secret should succeed");
        assert_eq!(after_delete, None);
    }
}
