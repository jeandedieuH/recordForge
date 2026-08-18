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
            access_key,
            secret_key,
            http,
        }
    }

    fn host_and_path(&self, key: &str, query_params: &str) -> (String, String, String) {
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

        if self.config.force_path_style || base_host == "localhost" || base_host == "127.0.0.1" {
            let host = format!("{}{}", base_host, port_suffix);
            let canonical_path = if clean_key.is_empty() {
                format!("/{}", self.config.bucket)
            } else {
                format!("/{}/{}", self.config.bucket, clean_key)
            };
            let request_url = if query_params.is_empty() {
                format!("{}://{}{}", scheme, host, canonical_path)
            } else {
                format!("{}://{}{}?{}", scheme, host, canonical_path, query_params)
            };
            (host, canonical_path, request_url)
        } else {
            let host = format!("{}.{}{}", self.config.bucket, base_host, port_suffix);
            let canonical_path = if clean_key.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", clean_key)
            };
            let request_url = if query_params.is_empty() {
                format!("{}://{}{}", scheme, host, canonical_path)
            } else {
                format!("{}://{}{}?{}", scheme, host, canonical_path, query_params)
            };
            (host, canonical_path, request_url)
        }
    }

    /// Test S3 connectivity and bucket access
    pub async fn test_connection(&self) -> Result<ConnectionTestResult> {
        let start = Instant::now();
        let signer = SigV4Signer::new(&self.access_key, &self.secret_key, &self.config.region);

        let (host, canonical_path, request_url) = self.host_and_path("", "max-keys=1");
        let payload_hash = SigV4Signer::sha256_hex(b"");
        let (auth_header, amz_date, _) =
            signer.sign("GET", &canonical_path, "max-keys=1", &host, &payload_hash);

        let res = self
            .http
            .get(&request_url)
            .header("host", &host)
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

            let (host, canonical_path, request_url) = self.host_and_path(&remote_key, "");
            let payload_hash = SigV4Signer::sha256_hex(&buffer);
            let (auth_header, amz_date, _) =
                signer.sign("PUT", &canonical_path, "", &host, &payload_hash);

            let resp = self
                .http
                .put(&request_url)
                .header("host", &host)
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
            let (_, _, dest_url) = self.host_and_path(&remote_key, "");
            return Ok(dest_url);
        }

        // Multipart Upload
        info!(file_len, remote_key = %remote_key, "starting S3 multipart upload");

        // 1. Initiate Multipart Upload
        let (host, canonical_path, init_url) = self.host_and_path(&remote_key, "uploads=");
        let payload_hash = SigV4Signer::sha256_hex(b"");
        let (auth_header, amz_date, _) =
            signer.sign("POST", &canonical_path, "uploads=", &host, &payload_hash);

        let init_resp = self
            .http
            .post(&init_url)
            .header("host", &host)
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
                let (host, canonical_path, abort_url) = self.host_and_path(&remote_key, &query);
                let payload_hash = SigV4Signer::sha256_hex(b"");
                let (auth_header, amz_date, _) =
                    signer.sign("DELETE", &canonical_path, &query, &host, &payload_hash);
                let _ = self
                    .http
                    .delete(&abort_url)
                    .header("host", &host)
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
            let (host, canonical_path, part_url) = self.host_and_path(&remote_key, &part_query);
            let payload_hash = SigV4Signer::sha256_hex(slice);
            let (auth_header, amz_date, _) =
                signer.sign("PUT", &canonical_path, &part_query, &host, &payload_hash);

            let part_resp = self
                .http
                .put(&part_url)
                .header("host", &host)
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
        let (host, canonical_path, complete_url) = self.host_and_path(&remote_key, &query);
        let payload_hash = SigV4Signer::sha256_hex(complete_xml.as_bytes());
        let (auth_header, amz_date, _) =
            signer.sign("POST", &canonical_path, &query, &host, &payload_hash);

        let complete_resp = self
            .http
            .post(&complete_url)
            .header("host", &host)
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

        let (_, _, dest_url) = self.host_and_path(&remote_key, "");
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
