//! S3-Compatible Cloud Storage Engine
//!
//! Handles multipart video uploads to AWS S3, Cloudflare R2, MinIO, Wasabi, and Backblaze B2.

use reqwest::Client;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tracing::{error, info, warn};

use crate::errors::{InternalError, Result};
use crate::storage::sigv4::SigV4Signer;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default = "default_part_size")]
    pub part_size_bytes: usize,
    #[serde(default)]
    pub force_path_style: bool,
}

fn default_part_size() -> usize {
    8 * 1024 * 1024 // 8 MB
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
}

/// Everything needed to sign and dispatch one S3 request. The canonical path
/// and query are already percent-encoded per SigV4 rules, and `url` is built
/// from those same encoded components so the signature always matches what the
/// server receives.
struct SignTarget {
    host: String,
    canonical_path: String,
    canonical_query: String,
    url: String,
}

pub struct S3Client {
    config: S3Config,
    access_key: String,
    secret_key: String,
    http: Client,
}

impl S3Client {
    pub fn new(config: S3Config, access_key: String, secret_key: String) -> Self {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            config,
            // Trim pasted credentials — a stray leading/trailing space in the
            // secret key silently corrupts every signature.
            access_key: access_key.trim().to_string(),
            secret_key: secret_key.trim().to_string(),
            http,
        }
    }

    fn sign_target(&self, key: &str, query_params: &str) -> SignTarget {
        let endpoint = self.config.endpoint.trim_end_matches('/');
        let url_parsed = reqwest::Url::parse(endpoint)
            .unwrap_or_else(|_| reqwest::Url::parse(&format!("https://{}", endpoint)).unwrap());

        let scheme = url_parsed.scheme();
        let base_host = url_parsed.host_str().unwrap_or("s3.amazonaws.com");
        let port_suffix = url_parsed
            .port()
            .map(|p| format!(":{}", p))
            .unwrap_or_default();

        let clean_key = key.trim_start_matches('/');
        // SigV4 requires the canonical URI and query to be percent-encoded.
        // Without this, keys containing spaces or other reserved characters are
        // signed raw while reqwest sends them encoded, causing
        // SignatureDoesNotMatch on the server side.
        let encoded_key = SigV4Signer::uri_encode(clean_key, false);
        let canonical_query = SigV4Signer::canonical_query(query_params);

        let (host, canonical_path) =
            if self.config.force_path_style || base_host == "localhost" || base_host == "127.0.0.1"
            {
                let path = if encoded_key.is_empty() {
                    format!("/{}", self.config.bucket)
                } else {
                    format!("/{}/{}", self.config.bucket, encoded_key)
                };
                (format!("{}{}", base_host, port_suffix), path)
            } else {
                let path = if encoded_key.is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", encoded_key)
                };
                (
                    format!("{}.{}{}", self.config.bucket, base_host, port_suffix),
                    path,
                )
            };

        let url = if canonical_query.is_empty() {
            format!("{}://{}{}", scheme, host, canonical_path)
        } else {
            format!(
                "{}://{}{}?{}",
                scheme, host, canonical_path, canonical_query
            )
        };

        SignTarget {
            host,
            canonical_path,
            canonical_query,
            url,
        }
    }

    /// Test S3 connectivity and bucket access
    pub async fn test_connection(&self) -> Result<ConnectionTestResult> {
        let start = Instant::now();
        let signer = SigV4Signer::new(&self.access_key, &self.secret_key, &self.config.region);

        let target = self.sign_target("", "max-keys=1");
        let payload_hash = SigV4Signer::sha256_hex(b"");
        let (auth_header, amz_date, _) = signer.sign(
            "GET",
            &target.canonical_path,
            &target.canonical_query,
            &target.host,
            &payload_hash,
        );

        let res = self
            .http
            .get(&target.url)
            .header("host", &target.host)
            .header("x-amz-date", &amz_date)
            .header("x-amz-content-sha256", &payload_hash)
            .header("authorization", &auth_header)
            .send()
            .await;

        let elapsed = start.elapsed().as_millis() as u64;

        match res {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    Ok(ConnectionTestResult {
                        ok: true,
                        message: format!(
                            "Successfully connected to bucket '{}'",
                            self.config.bucket
                        ),
                        latency_ms: Some(elapsed),
                    })
                } else {
                    let status_code = status.as_u16();
                    let err_body = resp.text().await.unwrap_or_default();
                    warn!(status = status_code, body = %err_body, "S3 test connection returned error status");
                    Ok(ConnectionTestResult {
                        ok: false,
                        message: format!(
                            "S3 connection failed (HTTP {}): {}",
                            status_code, err_body
                        ),
                        latency_ms: Some(elapsed),
                    })
                }
            }
            Err(e) => {
                error!(error = ?e, "S3 connection test failed");
                Ok(ConnectionTestResult {
                    ok: false,
                    message: format!("Could not reach S3 endpoint: {}", e),
                    latency_ms: Some(elapsed),
                })
            }
        }
    }

    /// Upload a file with progress reporting and cancellation support
    pub async fn upload_file(
        &self,
        local_path: &Path,
        destination_name: &str,
        progress_cb: impl Fn(u64, u64),
        cancel_flag: &AtomicBool,
    ) -> Result<String> {
        let mut file = File::open(local_path)
            .map_err(|e| InternalError::Storage(format!("failed to open file for upload: {e}")))?;
        let file_len = file
            .metadata()
            .map_err(|e| InternalError::Storage(format!("failed to get file metadata: {e}")))?
            .len();

        let remote_key = if self.config.prefix.trim().is_empty() {
            destination_name.to_string()
        } else {
            format!(
                "{}/{}",
                self.config.prefix.trim_matches('/'),
                destination_name
            )
        };

        let signer = SigV4Signer::new(&self.access_key, &self.secret_key, &self.config.region);

        if file_len <= self.config.part_size_bytes as u64 {
            // Single PUT
            let mut buffer = Vec::with_capacity(file_len as usize);
            file.read_to_end(&mut buffer)
                .map_err(|e| InternalError::Storage(format!("failed to read file: {e}")))?;

            if cancel_flag.load(Ordering::Relaxed) {
                return Err(InternalError::Storage("upload cancelled by user".into()).into());
            }

            let target = self.sign_target(&remote_key, "");
            let payload_hash = SigV4Signer::sha256_hex(&buffer);
            let (auth_header, amz_date, _) = signer.sign(
                "PUT",
                &target.canonical_path,
                &target.canonical_query,
                &target.host,
                &payload_hash,
            );

            let resp = self
                .http
                .put(&target.url)
                .header("host", &target.host)
                .header("x-amz-date", &amz_date)
                .header("x-amz-content-sha256", &payload_hash)
                .header("authorization", &auth_header)
                .header("content-type", "video/mp4")
                .body(buffer)
                .send()
                .await
                .map_err(|e| {
                    InternalError::Storage(format!("S3 single upload request failed: {e}"))
                })?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(InternalError::Storage(format!(
                    "S3 single upload failed ({status}): {text}"
                ))
                .into());
            }

            progress_cb(file_len, file_len);
            return Ok(self.sign_target(&remote_key, "").url);
        }

        // Multipart Upload
        info!(file_len, remote_key = %remote_key, "starting S3 multipart upload");

        // 1. Initiate Multipart Upload
        let init_target = self.sign_target(&remote_key, "uploads=");
        let payload_hash = SigV4Signer::sha256_hex(b"");
        let (auth_header, amz_date, _) = signer.sign(
            "POST",
            &init_target.canonical_path,
            &init_target.canonical_query,
            &init_target.host,
            &payload_hash,
        );

        let init_resp = self
            .http
            .post(&init_target.url)
            .header("host", &init_target.host)
            .header("x-amz-date", &amz_date)
            .header("x-amz-content-sha256", &payload_hash)
            .header("authorization", &auth_header)
            .header("content-type", "video/mp4")
            .send()
            .await
            .map_err(|e| {
                InternalError::Storage(format!("failed to initiate multipart upload: {e}"))
            })?;

        if !init_resp.status().is_success() {
            let status = init_resp.status();
            let text = init_resp.text().await.unwrap_or_default();
            return Err(InternalError::Storage(format!(
                "initiate multipart upload failed ({status}): {text}"
            ))
            .into());
        }

        let init_xml = init_resp.text().await.map_err(|e| {
            InternalError::Storage(format!("failed to read init response XML: {e}"))
        })?;

        let upload_id = extract_xml_tag(&init_xml, "UploadId")
            .ok_or_else(|| InternalError::Storage("UploadId not found in XML response".into()))?;

        // 2. Upload Parts
        let part_size = self.config.part_size_bytes;
        let mut part_number = 1;
        let mut uploaded_bytes = 0u64;
        let mut completed_parts: Vec<(usize, String)> = Vec::new();

        let mut part_buffer = vec![0u8; part_size];

        while uploaded_bytes < file_len {
            if cancel_flag.load(Ordering::Relaxed) {
                // Abort multipart upload
                let query = format!("uploadId={}", upload_id);
                let abort_target = self.sign_target(&remote_key, &query);
                let payload_hash = SigV4Signer::sha256_hex(b"");
                let (auth_header, amz_date, _) = signer.sign(
                    "DELETE",
                    &abort_target.canonical_path,
                    &abort_target.canonical_query,
                    &abort_target.host,
                    &payload_hash,
                );
                let _ = self
                    .http
                    .delete(&abort_target.url)
                    .header("host", &abort_target.host)
                    .header("x-amz-date", &amz_date)
                    .header("x-amz-content-sha256", &payload_hash)
                    .header("authorization", &auth_header)
                    .send()
                    .await;
                return Err(
                    InternalError::Storage("multipart upload cancelled by user".into()).into(),
                );
            }

            file.seek(SeekFrom::Start(uploaded_bytes))
                .map_err(|e| InternalError::Storage(format!("seek error: {e}")))?;
            let bytes_read = file
                .read(&mut part_buffer)
                .map_err(|e| InternalError::Storage(format!("read error: {e}")))?;

            if bytes_read == 0 {
                break;
            }

            let slice = &part_buffer[..bytes_read];
            let part_query = format!("partNumber={}&uploadId={}", part_number, upload_id);
            let part_target = self.sign_target(&remote_key, &part_query);
            let payload_hash = SigV4Signer::sha256_hex(slice);
            let (auth_header, amz_date, _) = signer.sign(
                "PUT",
                &part_target.canonical_path,
                &part_target.canonical_query,
                &part_target.host,
                &payload_hash,
            );

            let part_resp = self
                .http
                .put(&part_target.url)
                .header("host", &part_target.host)
                .header("x-amz-date", &amz_date)
                .header("x-amz-content-sha256", &payload_hash)
                .header("authorization", &auth_header)
                .body(slice.to_vec())
                .send()
                .await
                .map_err(|e| {
                    InternalError::Storage(format!("failed to upload part {part_number}: {e}"))
                })?;

            if !part_resp.status().is_success() {
                let status = part_resp.status();
                let text = part_resp.text().await.unwrap_or_default();
                return Err(InternalError::Storage(format!(
                    "upload part {part_number} failed ({status}): {text}"
                ))
                .into());
            }

            let etag = part_resp
                .headers()
                .get("etag")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("")
                .trim_matches('"')
                .to_string();

            completed_parts.push((part_number, etag));
            uploaded_bytes += bytes_read as u64;
            part_number += 1;

            progress_cb(uploaded_bytes, file_len);
        }

        // 3. Complete Multipart Upload
        let mut complete_xml = "<CompleteMultipartUpload>".to_string();
        for (num, etag) in completed_parts {
            complete_xml.push_str(&format!(
                "<Part><PartNumber>{}</PartNumber><ETag>\"{}\"</ETag></Part>",
                num, etag
            ));
        }
        complete_xml.push_str("</CompleteMultipartUpload>");

        let query = format!("uploadId={}", upload_id);
        let complete_target = self.sign_target(&remote_key, &query);
        let payload_hash = SigV4Signer::sha256_hex(complete_xml.as_bytes());
        let (auth_header, amz_date, _) = signer.sign(
            "POST",
            &complete_target.canonical_path,
            &complete_target.canonical_query,
            &complete_target.host,
            &payload_hash,
        );

        let complete_resp = self
            .http
            .post(&complete_target.url)
            .header("host", &complete_target.host)
            .header("x-amz-date", &amz_date)
            .header("x-amz-content-sha256", &payload_hash)
            .header("authorization", &auth_header)
            .header("content-type", "application/xml")
            .body(complete_xml)
            .send()
            .await
            .map_err(|e| {
                InternalError::Storage(format!("failed to complete multipart upload: {e}"))
            })?;

        if !complete_resp.status().is_success() {
            let status = complete_resp.status();
            let text = complete_resp.text().await.unwrap_or_default();
            return Err(InternalError::Storage(format!(
                "complete multipart upload failed ({status}): {text}"
            ))
            .into());
        }

        let dest_url = self.sign_target(&remote_key, "").url;
        info!(url = %dest_url, "S3 multipart upload completed successfully");
        Ok(dest_url)
    }
}

fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client_with(force_path_style: bool) -> S3Client {
        S3Client::new(
            S3Config {
                endpoint: "https://acct.r2.cloudflarestorage.com".to_string(),
                region: "auto".to_string(),
                bucket: "videos".to_string(),
                prefix: String::new(),
                part_size_bytes: 8 * 1024 * 1024,
                force_path_style,
            },
            "ak".to_string(),
            "sk".to_string(),
        )
    }

    #[test]
    fn test_sign_target_encodes_key_with_space() {
        // Regression: a space in the object key was signed raw while reqwest
        // sent it percent-encoded, producing SignatureDoesNotMatch on R2.
        let client = client_with(false);
        let target = client.sign_target("Recording 8577bd55.mp4", "uploads=");

        assert_eq!(target.host, "videos.acct.r2.cloudflarestorage.com");
        assert_eq!(target.canonical_path, "/Recording%208577bd55.mp4");
        assert_eq!(target.canonical_query, "uploads=");
        assert_eq!(
            target.url,
            "https://videos.acct.r2.cloudflarestorage.com/Recording%208577bd55.mp4?uploads="
        );
        // The signed canonical path must be exactly what goes on the wire.
        let wire_path = reqwest::Url::parse(&target.url)
            .expect("request URL must be parseable")
            .path()
            .to_string();
        assert_eq!(wire_path, target.canonical_path);
    }

    #[test]
    fn test_sign_target_path_style() {
        let client = client_with(true);
        let target = client.sign_target("a b/c.mp4", "");

        assert_eq!(target.host, "acct.r2.cloudflarestorage.com");
        assert_eq!(target.canonical_path, "/videos/a%20b/c.mp4");
        assert_eq!(
            target.url,
            "https://acct.r2.cloudflarestorage.com/videos/a%20b/c.mp4"
        );
    }

    #[test]
    fn test_sign_target_encodes_upload_id_query() {
        let client = client_with(false);
        let target = client.sign_target("k.mp4", "partNumber=3&uploadId=Ab+C/d=");

        assert_eq!(
            target.canonical_query,
            "partNumber=3&uploadId=Ab%2BC%2Fd%3D"
        );
        assert!(target.url.contains("uploadId=Ab%2BC%2Fd%3D"));
    }
}
