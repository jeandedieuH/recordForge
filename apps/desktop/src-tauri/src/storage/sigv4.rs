//! AWS Signature Version 4 (SigV4) Signer
//!
//! Provides pure, fast HMAC-SHA256 signing for AWS S3, Cloudflare R2, MinIO,
//! Wasabi, Backblaze B2, and custom S3 endpoints.

use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

type HmacSha256 = Hmac<Sha256>;

pub struct SigV4Signer<'a> {
    access_key: &'a str,
    secret_key: &'a str,
    region: &'a str,
    service: &'a str,
}

impl<'a> SigV4Signer<'a> {
    pub fn new(access_key: &'a str, secret_key: &'a str, region: &'a str) -> Self {
        Self {
            access_key,
            secret_key,
            region,
            service: "s3",
        }
    }

    /// Calculate SHA256 hex digest of a byte slice.
    pub fn sha256_hex(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hex::encode(hasher.finalize())
    }

    /// Sign an HTTP request and return (AuthorizationHeader, AmzDate, ContentSha256).
    pub fn sign(
        &self,
        method: &str,
        path: &str,
        query: &str,
        host: &str,
        payload_sha256: &str,
    ) -> (String, String, String) {
        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();

        let mut headers = BTreeMap::new();
        headers.insert("host", host);
        headers.insert("x-amz-content-sha256", payload_sha256);
        headers.insert("x-amz-date", &amz_date);

        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical_headers = format!(
            "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
            host, payload_sha256, amz_date
        );

        let canonical_request = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method, path, query, canonical_headers, signed_headers, payload_sha256
        );

        let canonical_req_hash = Self::sha256_hex(canonical_request.as_bytes());

        let credential_scope = format!(
            "{}/{}/{}/aws4_request",
            date_stamp, self.region, self.service
        );

        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            amz_date, credential_scope, canonical_req_hash
        );

        let signing_key = self.get_signature_key(&date_stamp);
        let signature = Self::hmac_hex(&signing_key, string_to_sign.as_bytes());

        let auth_header = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            self.access_key, credential_scope, signed_headers, signature
        );

        (auth_header, amz_date, payload_sha256.to_string())
    }

    fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(key).expect("HMAC can take key of any size");
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    }

    fn hmac_hex(key: &[u8], data: &[u8]) -> String {
        hex::encode(Self::hmac_sha256(key, data))
    }

    fn get_signature_key(&self, date_stamp: &str) -> Vec<u8> {
        let k_secret = format!("AWS4{}", self.secret_key);
        let k_date = Self::hmac_sha256(k_secret.as_bytes(), date_stamp.as_bytes());
        let k_region = Self::hmac_sha256(&k_date, self.region.as_bytes());
        let k_service = Self::hmac_sha256(&k_region, self.service.as_bytes());
        Self::hmac_sha256(&k_service, b"aws4_request")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sigv4_sha256_hex() {
        assert_eq!(
            SigV4Signer::sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_sigv4_signing() {
        let signer = SigV4Signer::new("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1");
        let (auth, date, hash) = signer.sign("GET", "/", "", "examplebucket.s3.amazonaws.com", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/"));
        assert!(auth.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
        assert_eq!(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(date.len(), 16);
    }
}
