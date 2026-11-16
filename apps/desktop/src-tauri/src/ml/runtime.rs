//! ONNX Runtime download, verification, and environment init (ADR 021).
//!
//! The runtime is a ~10–85 MB native library, so it is downloaded on demand
//! into `<app_data>/ml/runtime/` rather than bundled. Downloads are pinned to
//! ONNX Runtime v1.31.0 and verified by SHA-256; a failed check deletes the
//! file so `status()` never reports a corrupt runtime as ready.
//!
//! `ort` is built with `load-dynamic`, so the library is loaded from an
//! explicit path with `ort::init_from` before any other `ort` API is used. A
//! DirectML (Windows) or CoreML (macOS) provider is requested first; if the
//! runtime build cannot register it, init falls back to the CPU provider.
//! `RECORDFORGE_ORT_DYLIB` points at a custom runtime build for development.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::errors::{InternalError, Result};

const ORT_VERSION: &str = "1.31.0";

struct RuntimeSpec {
    asset: &'static str,
    archive: ArchiveKind,
    sha256: &'static str,
    /// Library file name inside the archive (the archive nests it in `lib/`).
    lib_name: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    Zip,
    TarGz,
}

fn runtime_spec() -> Option<RuntimeSpec> {
    // Asset digests are taken from the v1.31.0 release metadata.
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some(RuntimeSpec {
            asset: "onnxruntime-win-x64-1.31.0.zip",
            archive: ArchiveKind::Zip,
            sha256: "3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195",
            lib_name: "onnxruntime.dll",
        })
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some(RuntimeSpec {
            asset: "onnxruntime-win-arm64-1.31.0.zip",
            archive: ArchiveKind::Zip,
            sha256: "ef6206fa8d6975878d93a97035d280240ce5764c126a7430e5427e18923316d5",
            lib_name: "onnxruntime.dll",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some(RuntimeSpec {
            asset: "onnxruntime-linux-x64-1.31.0.tgz",
            archive: ArchiveKind::TarGz,
            sha256: "cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57",
            lib_name: "libonnxruntime.so",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some(RuntimeSpec {
            asset: "onnxruntime-linux-aarch64-1.31.0.tgz",
            archive: ArchiveKind::TarGz,
            sha256: "c5b8b3cca31f3d643a3b313b8f42e2d0f16a4fcefd02cda343d97bd5306afaab",
            lib_name: "libonnxruntime.so",
        })
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some(RuntimeSpec {
            asset: "onnxruntime-osx-arm64-1.31.0.tgz",
            archive: ArchiveKind::TarGz,
            sha256: "1031b36dd3bdaa8d976a6130d9cf2a05e9be320b93ae804f8427b91dc3432afc",
            lib_name: "libonnxruntime.dylib",
        })
    } else {
        // Intel macOS and other targets have no pinned ONNX Runtime 1.31
        // build; the UI reports camera AI as unsupported there.
        None
    }
}

pub fn supported() -> bool {
    runtime_spec().is_some()
}

pub fn runtime_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("ml").join("runtime")
}

pub fn runtime_lib_path(app_data_dir: &Path) -> PathBuf {
    if let Ok(path) = std::env::var("RECORDFORGE_ORT_DYLIB") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }
    let spec = runtime_spec();
    let file = spec
        .as_ref()
        .map(|spec| spec.lib_name)
        .unwrap_or(if cfg!(windows) {
            "onnxruntime.dll"
        } else if cfg!(target_os = "macos") {
            "libonnxruntime.dylib"
        } else {
            "libonnxruntime.so"
        });
    runtime_dir(app_data_dir).join(file)
}

pub fn ready(app_data_dir: &Path) -> bool {
    runtime_lib_path(app_data_dir).is_file()
}

/// Download + verify + extract the runtime library. Idempotent.
pub async fn download(app_data_dir: &Path, on_progress: impl Fn(u64, u64)) -> Result<()> {
    let spec = runtime_spec().ok_or_else(|| {
        InternalError::Media("Camera AI is not available on this platform".into())
    })?;
    let dir = runtime_dir(app_data_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|error| InternalError::Storage(format!("create ML runtime dir: {error}")))?;
    let lib_path = dir.join(spec.lib_name);
    if lib_path.is_file() && verify_file(&lib_path, spec.sha256).is_ok() {
        return Ok(());
    }

    let url = format!(
        "https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/{}",
        spec.asset
    );
    // Archives are large; stream to `<dir>/<asset>` and remove it afterwards.
    let archive_path = dir.join(format!("{}.download", spec.asset));
    crate::whisper::download_to_file(&url, &archive_path, on_progress).await?;
    if let Err(error) = verify_file(&archive_path, spec.sha256) {
        let _ = std::fs::remove_file(&archive_path);
        return Err(error);
    }
    let extract_result = match spec.archive {
        ArchiveKind::Zip => extract_zip_member(&archive_path, spec.lib_name, &lib_path),
        ArchiveKind::TarGz => extract_targz_member(&archive_path, spec.lib_name, &lib_path),
    };
    let _ = std::fs::remove_file(&archive_path);
    extract_result?;
    if !lib_path.is_file() {
        return Err(InternalError::Media(
            "the ONNX Runtime archive did not contain the runtime library".into(),
        )
        .into());
    }
    Ok(())
}

fn verify_file(path: &Path, expected: &str) -> Result<()> {
    use sha2::Digest;
    let bytes = std::fs::read(path)
        .map_err(|error| InternalError::Storage(format!("read ONNX Runtime archive: {error}")))?;
    let digest = hex::encode(sha2::Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(expected) {
        return Err(
            InternalError::Storage("ONNX Runtime failed its integrity check".into()).into(),
        );
    }
    Ok(())
}

fn extract_zip_member(archive_path: &Path, member: &str, destination: &Path) -> Result<()> {
    let file = std::fs::File::open(archive_path)
        .map_err(|error| InternalError::Storage(format!("open runtime zip: {error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| InternalError::Storage(format!("read runtime zip: {error}")))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| InternalError::Storage(format!("runtime zip entry: {error}")))?;
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let Some(file_name) = name.file_name() else {
            continue;
        };
        if file_name != member {
            continue;
        }
        let mut out = std::fs::File::create(destination).map_err(|error| {
            InternalError::Storage(format!("write {}: {error}", destination.display()))
        })?;
        std::io::copy(&mut entry, &mut out).map_err(|error| {
            InternalError::Storage(format!("extract {}: {error}", destination.display()))
        })?;
        return Ok(());
    }
    Err(InternalError::Media(format!("runtime archive is missing {member}")).into())
}

fn extract_targz_member(archive_path: &Path, member: &str, destination: &Path) -> Result<()> {
    let file = std::fs::File::open(archive_path)
        .map_err(|error| InternalError::Storage(format!("open runtime archive: {error}")))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in archive
        .entries()
        .map_err(|error| InternalError::Storage(format!("read runtime archive: {error}")))?
    {
        let mut entry =
            entry.map_err(|error| InternalError::Storage(format!("runtime entry: {error}")))?;
        let path = entry
            .path()
            .map_err(|error| InternalError::Storage(format!("runtime path: {error}")))?
            .to_path_buf();
        let Some(file_name) = path.file_name() else {
            continue;
        };
        let name = file_name.to_string_lossy();
        // Linux archives carry `libonnxruntime.so.1.31.0` plus symlinks; take
        // the real file and give it the unversioned name `ort` loads.
        let matches = name == member
            || (member == "libonnxruntime.so" && name.starts_with("libonnxruntime.so.1."))
            || (member == "libonnxruntime.dylib"
                && name.starts_with("libonnxruntime.")
                && name.ends_with(".dylib"));
        if !matches {
            continue;
        }
        let mut out = std::fs::File::create(destination).map_err(|error| {
            InternalError::Storage(format!("write {}: {error}", destination.display()))
        })?;
        std::io::copy(&mut entry, &mut out).map_err(|error| {
            InternalError::Storage(format!("extract {}: {error}", destination.display()))
        })?;
        return Ok(());
    }
    Err(InternalError::Media(format!("runtime archive is missing {member}")).into())
}

static ENVIRONMENT: OnceLock<std::result::Result<ort::environment::Environment, String>> =
    OnceLock::new();

/// Process-wide ONNX Runtime environment. Initialization happens once; the
/// environment must outlive every session, hence the static.
pub fn environment(app_data_dir: &Path) -> Result<&'static ort::environment::Environment> {
    let result = ENVIRONMENT.get_or_init(|| init_environment(app_data_dir));
    match result {
        Ok(environment) => Ok(environment),
        Err(message) => Err(InternalError::Media(message.clone()).into()),
    }
}

fn init_environment(
    app_data_dir: &Path,
) -> std::result::Result<ort::environment::Environment, String> {
    let lib_path = runtime_lib_path(app_data_dir);
    if !lib_path.is_file() {
        return Err("the camera AI runtime is not downloaded yet".into());
    }
    let builder =
        ort::init_from(&lib_path).map_err(|error| format!("load ONNX Runtime: {error}"))?;

    // Provider preference: hardware first, CPU fallback. A provider the
    // runtime build does not ship fails environment creation, so retry CPU.
    let providers = preferred_providers();
    if !providers.is_empty() {
        match builder.with_execution_providers(providers).build() {
            Ok(environment) => return Ok(environment),
            Err(error) => {
                tracing::warn!(error = %error, "camera AI GPU provider unavailable; using CPU");
            }
        }
    }
    ort::init()
        .with_name("recordforge-camera-ai")
        .build()
        .map_err(|error| format!("initialize ONNX Runtime: {error}"))
}

fn preferred_providers() -> Vec<ort::ep::ExecutionProviderDispatch> {
    let mut providers: Vec<ort::ep::ExecutionProviderDispatch> = Vec::new();
    #[cfg(windows)]
    {
        providers.push(ort::ep::DirectML::default().build());
    }
    #[cfg(target_os = "macos")]
    {
        providers.push(ort::ep::CoreML::default().build());
    }
    let _ = &mut providers;
    providers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_spec_matches_the_host() {
        // Every supported host has a pinned archive and a non-empty digest.
        if let Some(spec) = runtime_spec() {
            assert_eq!(spec.sha256.len(), 64);
            assert!(spec.sha256.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(spec.asset.starts_with("onnxruntime-"));
        } else {
            assert!(!supported());
        }
    }

    #[test]
    fn env_override_wins() {
        // SAFETY: tests in this module do not read the variable concurrently;
        // the assertion is the only reader and restores it immediately.
        let previous = std::env::var("RECORDFORGE_ORT_DYLIB").ok();
        std::env::set_var("RECORDFORGE_ORT_DYLIB", "/tmp/custom-ort.dll");
        let path = runtime_lib_path(Path::new("/tmp"));
        if let Some(previous) = previous {
            std::env::set_var("RECORDFORGE_ORT_DYLIB", previous);
        } else {
            std::env::remove_var("RECORDFORGE_ORT_DYLIB");
        }
        assert_eq!(path, PathBuf::from("/tmp/custom-ort.dll"));
    }
}
