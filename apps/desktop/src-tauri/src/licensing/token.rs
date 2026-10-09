//! Offline license token verification.
//!
//! Format: `base64url(json_payload).base64url(ed25519_signature)` where the
//! signature covers the payload segment's raw bytes (JWS-style). Payload
//! fields are camelCase to match the license server:
//! `{v, kid, licenseId, plan, addons, deviceHash, iat}`.
//!
//! Production public keys are embedded below (`kid` keyed so the server can
//! rotate). A separate admin keyring holds owner-issued keys: tokens signed
//! by the admin private key install via the `admin:` activation prefix in
//! any build and never contact the license server. Debug builds additionally
//! accept a dev key from the `RECORD_FORGE_DEV_LICENSE_PUBLIC_KEY` env var so
//! the full flow can be exercised before the production keypair exists.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use crate::errors::{InternalError, Result};

pub const TOKEN_VERSION: u8 = 1;

/// `kid` → base64url/raw base64 public key material for production tokens.
/// Populated when the production Ed25519 keypair is generated (Phase 0); the
/// private half lives only in the license server environment.
const PRODUCTION_KEYS: &[(&str, &str)] =
    &[("prod-1", "MfUSAhiudySsQhuHGoJkBcKSps3oah7pPM1NpY6/OdQ=")];

/// `kid` → public key for admin-issued offline tokens. The admin private key
/// lives only on the owner's machine (`license-admin-key.json`, gitignored);
/// tokens are minted with `tooling/scripts/license-keys.mjs token --prefix
/// admin --kid admin-1` and bound to one device hash. Present in every build
/// so the owner can run Pro in production before the license server ships.
const ADMIN_KEYS: &[(&str, &str)] = &[("admin-1", "7bleZdxKkHAE9g0wcglSSI14rY25xV7jkRiCSHbTkiY=")];

/// Env var carrying a dev public key (base64, 32 bytes) for debug builds.
pub const DEV_PUBLIC_KEY_ENV: &str = "RECORD_FORGE_DEV_LICENSE_PUBLIC_KEY";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseTokenPayload {
    pub v: u8,
    pub kid: String,
    pub license_id: String,
    pub plan: String,
    #[serde(default)]
    pub addons: Vec<String>,
    pub device_hash: String,
    pub iat: i64,
}

fn decode_key(raw: &str) -> Option<VerifyingKey> {
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(raw))
        .ok()?;
    let bytes: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

/// True when `kid` belongs to the admin keyring — i.e. the token was signed
/// by the owner's offline key, not the license server. Admin licenses skip
/// every server flow (refresh/deactivate) so a configured server can never
/// revoke them, and `LicenseManager` treats them as fully local.
pub fn is_admin_kid(kid: &str) -> bool {
    ADMIN_KEYS.iter().any(|(admin_kid, _)| *admin_kid == kid)
}

fn verification_keys() -> Vec<(String, VerifyingKey)> {
    let mut keys: Vec<(String, VerifyingKey)> = PRODUCTION_KEYS
        .iter()
        .chain(ADMIN_KEYS.iter())
        .filter_map(|(kid, raw)| decode_key(raw).map(|key| (kid.to_string(), key)))
        .collect();
    // Dev key accepted only in debug builds so release binaries can never be
    // unlocked by a self-signed token.
    #[cfg(debug_assertions)]
    {
        if let Ok(raw) = std::env::var(DEV_PUBLIC_KEY_ENV) {
            match decode_key(&raw) {
                Some(key) => keys.push(("dev".to_string(), key)),
                None => tracing::warn!("{DEV_PUBLIC_KEY_ENV} is not a valid Ed25519 public key"),
            }
        }
    }
    keys
}

/// Verify `token` for `device_hash` against the build's keyring; returns the
/// payload on success. Fails closed on malformed input, unknown keys, bad
/// signatures, wrong device, or an unsupported token version.
pub fn verify_token(token: &str, device_hash: &str) -> Result<LicenseTokenPayload> {
    verify_token_with_keys(token, device_hash, &verification_keys())
}

/// The verification core, separated from the keyring so tests can inject
/// keys without relying on process env or build-time constants.
fn verify_token_with_keys(
    token: &str,
    device_hash: &str,
    keys: &[(String, VerifyingKey)],
) -> Result<LicenseTokenPayload> {
    if device_hash.is_empty() {
        return Err(InternalError::Unknown("device identity is unavailable".into()).into());
    }
    let (payload_segment, signature_segment) = token
        .trim()
        .split_once('.')
        .filter(|(payload, signature)| !payload.is_empty() && !signature.is_empty())
        .ok_or_else(|| InternalError::Unknown("license token is malformed".into()))?;
    if signature_segment.contains('.') {
        return Err(InternalError::Unknown("license token is malformed".into()).into());
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_segment)
        .map_err(|_| InternalError::Unknown("license token payload is malformed".into()))?;
    let payload: LicenseTokenPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| InternalError::Unknown("license token payload is malformed".into()))?;
    if payload.v != TOKEN_VERSION {
        return Err(InternalError::Unknown("license token version is unsupported".into()).into());
    }
    let key = keys
        .iter()
        .find(|(kid, _)| kid == &payload.kid)
        .map(|(_, key)| key)
        .ok_or_else(|| InternalError::Unknown("license token signing key is unknown".into()))?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_segment)
        .map_err(|_| InternalError::Unknown("license token signature is malformed".into()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| InternalError::Unknown("license token signature is malformed".into()))?;
    key.verify(payload_segment.as_bytes(), &signature)
        .map_err(|_| InternalError::Unknown("license token signature is invalid".into()))?;
    if payload.device_hash != device_hash {
        return Err(
            InternalError::Unknown("license token is bound to a different device".into()).into(),
        );
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;

    fn dev_keypair() -> (ed25519_dalek::SigningKey, VerifyingKey) {
        let mut seed = [0u8; 32];
        for (index, byte) in seed.iter_mut().enumerate() {
            *byte = index as u8 + 1;
        }
        let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
        let verifying = signing.verifying_key();
        (signing, verifying)
    }

    fn sign_token(signing: &ed25519_dalek::SigningKey, payload: &serde_json::Value) -> String {
        let segment = URL_SAFE_NO_PAD.encode(serde_json::to_vec(payload).expect("payload json"));
        let signature = signing.sign(segment.as_bytes());
        format!("{segment}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    fn test_device_hash() -> String {
        "f".repeat(64)
    }

    fn payload_for(kid: &str, device_hash: &str) -> serde_json::Value {
        serde_json::json!({
            "v": 1,
            "kid": kid,
            "licenseId": "lic_test_123",
            "plan": "pro_lifetime",
            "addons": [],
            "deviceHash": device_hash,
            "iat": 1_700_000_000_000_i64,
        })
    }

    /// The real verification path with an injectable keyring so tests don't
    /// depend on process env or build-time constants.
    fn verify_with_keys(
        token: &str,
        device_hash: &str,
        keys: &[(String, VerifyingKey)],
    ) -> Result<LicenseTokenPayload> {
        verify_token_with_keys(token, device_hash, keys)
    }

    #[test]
    fn valid_token_verifies_for_bound_device() {
        let (signing, verifying) = dev_keypair();
        let token = sign_token(&signing, &payload_for("dev", &test_device_hash()));
        let keys = vec![("dev".to_string(), verifying)];
        let payload =
            verify_with_keys(&token, &test_device_hash(), &keys).expect("token should verify");
        assert_eq!(payload.plan, "pro_lifetime");
        assert_eq!(payload.license_id, "lic_test_123");
    }

    #[test]
    fn tampered_payload_fails_signature() {
        let (signing, verifying) = dev_keypair();
        let token = sign_token(&signing, &payload_for("dev", &test_device_hash()));
        // Re-sign-free tamper: swap the payload segment for a different one.
        let forged_payload = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload_for("dev", &"a".repeat(64))).expect("json"));
        let forged = format!("{forged_payload}.{}", token.split('.').nth(1).unwrap());
        let keys = vec![("dev".to_string(), verifying)];
        assert!(verify_with_keys(&forged, &test_device_hash(), &keys).is_err());
    }

    #[test]
    fn token_for_another_device_is_rejected() {
        let (signing, verifying) = dev_keypair();
        let token = sign_token(&signing, &payload_for("dev", &test_device_hash()));
        let keys = vec![("dev".to_string(), verifying)];
        assert!(verify_with_keys(&token, &"b".repeat(64), &keys).is_err());
    }

    #[test]
    fn unknown_signing_key_is_rejected() {
        let (signing, _verifying) = dev_keypair();
        let mut other_seed = [9u8; 32];
        other_seed[0] = 1;
        let other_verifying = ed25519_dalek::SigningKey::from_bytes(&other_seed).verifying_key();
        let token = sign_token(&signing, &payload_for("dev", &test_device_hash()));
        let keys = vec![("dev".to_string(), other_verifying)];
        assert!(verify_with_keys(&token, &test_device_hash(), &keys).is_err());
    }

    #[test]
    fn rotated_key_id_selects_matching_key() {
        let (signing, verifying) = dev_keypair();
        let token = sign_token(&signing, &payload_for("prod-2", &test_device_hash()));
        // The key ring may hold several kids; verification must pick the
        // token's own kid rather than the first entry.
        let mut decoy_seed = [7u8; 32];
        decoy_seed[0] = 3;
        let decoy = ed25519_dalek::SigningKey::from_bytes(&decoy_seed);
        let keys = vec![
            ("prod-1".to_string(), decoy.verifying_key()),
            ("prod-2".to_string(), verifying),
        ];
        assert!(verify_with_keys(&token, &test_device_hash(), &keys).is_ok());
    }

    #[test]
    fn admin_kids_are_detected_by_keyring_membership() {
        for (kid, _) in ADMIN_KEYS {
            assert!(is_admin_kid(kid), "{kid} should be recognized as admin");
        }
        assert!(!is_admin_kid("dev"));
        assert!(!is_admin_kid("prod-1"));
        assert!(!is_admin_kid(""));
    }

    #[test]
    fn every_embedded_key_decodes() {
        // A typo'd base64 constant would silently shrink the keyring.
        for (kid, raw) in PRODUCTION_KEYS.iter().chain(ADMIN_KEYS.iter()) {
            assert!(decode_key(raw).is_some(), "{kid} failed to decode");
        }
    }

    #[test]
    fn malformed_tokens_fail_closed() {
        assert!(verify_token("", &test_device_hash()).is_err());
        assert!(verify_token("abc", &test_device_hash()).is_err());
        assert!(verify_token("a.b.c", &test_device_hash()).is_err());
        assert!(verify_token(&test_device_hash(), "").is_err());
    }

    /// `cargo test -- --ignored print_device_hash --nocapture` prints the
    /// hash `license-keys.mjs token --device` needs for this machine —
    /// an alternative to copying `deviceHash` from the running app.
    #[test]
    #[ignore = "helper: prints this machine's device hash"]
    fn print_device_hash() {
        println!(
            "{}",
            crate::licensing::device::device_hash().expect("device hash")
        );
    }

    /// End-to-end check for the embedded admin keyring: set
    /// `RECORD_FORGE_TEST_ADMIN_TOKEN` to a minted `admin:<token>` for this
    /// machine, then `cargo test -- --ignored embedded_admin_key`.
    #[test]
    #[ignore = "requires RECORD_FORGE_TEST_ADMIN_TOKEN for this device"]
    fn embedded_admin_key_verifies_a_real_token() {
        let raw = std::env::var("RECORD_FORGE_TEST_ADMIN_TOKEN")
            .expect("set RECORD_FORGE_TEST_ADMIN_TOKEN to a minted admin:<token>");
        let token = raw.strip_prefix("admin:").unwrap_or(&raw);
        let device_hash = crate::licensing::device::device_hash().expect("device hash");
        let payload = verify_token(token, &device_hash).expect("admin token should verify");
        assert!(is_admin_kid(&payload.kid));
        assert!(payload.plan.starts_with("pro"));
    }
}
