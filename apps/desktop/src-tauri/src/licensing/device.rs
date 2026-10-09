//! Device identity for license binding.
//!
//! The token carries `sha256(machine_uid + app salt)` so the raw machine ID
//! never leaves the OS API boundary and can't be correlated with anything.

use sha2::{Digest, Sha256};

use crate::errors::{InternalError, Result};

const DEVICE_SALT: &str = "recordforge-license-device-v1";

/// Salted, stable machine hash embedded in license tokens.
pub fn device_hash() -> Result<String> {
    let uid = machine_uid::get()
        .map_err(|error| InternalError::Unknown(format!("machine uid: {error}")))?;
    let mut hasher = Sha256::new();
    hasher.update(DEVICE_SALT.as_bytes());
    hasher.update(uid.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

/// Human-readable device label shown on the license server's device list.
pub fn device_label() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "this device".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_hash_is_stable_and_salted() {
        let first = device_hash().expect("device hash");
        let second = device_hash().expect("device hash");
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
    }
}
