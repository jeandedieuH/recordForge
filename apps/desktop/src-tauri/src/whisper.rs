//! AI Captions — on-device speech-to-text via whisper.cpp.
//!
//! The engine is downloaded on demand into `<app_data>/whisper/` rather than
//! bundled: the binary + model would add ~160 MB-1.7 GB to the installer for a
//! Pro-only feature. We pin **v1.9.2** — the newest *tagged* release whose tag
//! carries binary assets (v1.9.3+ publish binaries only on untagged nightly
//! releases, which are a moving target).
//!
//! Platform coverage of the pinned release:
//! - Windows x64  → `whisper-bin-x64.zip`             (upstream)
//! - Linux x64    → `whisper-bin-ubuntu-x64.tar.gz`   (upstream; Ubuntu 22.04
//!   build → glibc ≥ 2.35; libs resolve via `$ORIGIN` rpath, no env needed)
//! - Linux ARM64  → `whisper-bin-ubuntu-arm64.tar.gz` (upstream, armv8-a)
//! - macOS arm64/x64, Windows ARM64 → self-hosted on this repo's
//!   `whisper-engine-v1.9.2` release — statically built single binaries
//!   produced by `.github/workflows/build-whisper-engine.yml` (upstream ships
//!   only the xcframework *library* for Apple, no runnable CLI).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tracing::instrument;

use crate::errors::{InternalError, Result};

const WHISPER_MODEL_URL_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// Downloadable ggml models. All are the *multilingual* weights (no `.en`
/// suffix) so any spoken language transcribes via `-l auto`. "large" maps to
/// `large-v3-turbo`: OpenAI's distilled release — ~half the download and ~8×
/// faster than `large-v3` at near-equal accuracy, which is the right fit for
/// a desktop transcription feature.
const WHISPER_MODELS: &[WhisperModelSpec] = &[
    WhisperModelSpec {
        id: "base",
        label: "Base — fastest, good drafts",
        file: "ggml-base.bin",
        size_bytes: 147_951_465,
    },
    WhisperModelSpec {
        id: "small",
        label: "Small — balanced",
        file: "ggml-small.bin",
        size_bytes: 487_601_967,
    },
    WhisperModelSpec {
        id: "medium",
        label: "Medium — accurate",
        file: "ggml-medium.bin",
        size_bytes: 1_533_763_059,
    },
    WhisperModelSpec {
        id: "large",
        label: "Large (v3 Turbo) — best",
        file: "ggml-large-v3-turbo.bin",
        size_bytes: 1_624_555_275,
    },
];

pub struct WhisperModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub file: &'static str,
    pub size_bytes: u64,
}

/// One model's availability on this machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// Approximate download size, shown in the picker.
    pub size_bytes: u64,
    pub downloaded: bool,
}

/// Engine readiness reported to the Captions panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperStatus {
    /// This platform has a downloadable engine (Windows x64, Linux x64/arm64).
    pub supported: bool,
    /// whisper-cli binary + runtime libraries present.
    pub binary_ready: bool,
    /// Per-model download state — several models may coexist on disk.
    pub models: Vec<WhisperModelInfo>,
    /// `binary_ready && at least one model downloaded`.
    pub ready: bool,
}

pub fn engine_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("whisper")
}

fn binary_path(dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        dir.join("whisper-cli.exe")
    }
    #[cfg(not(windows))]
    {
        dir.join("whisper-cli")
    }
}

fn model_spec(id: &str) -> Option<&'static WhisperModelSpec> {
    WHISPER_MODELS.iter().find(|m| m.id == id)
}

fn model_path(dir: &Path, spec: &WhisperModelSpec) -> PathBuf {
    dir.join("models").join(spec.file)
}

/// whisper.cpp version pin — bump together with the workflow's default
/// `whisper_ref` input and re-run it so the self-hosted release tag
/// (`whisper-engine-<version>`) stays in sync.
const WHISPER_VERSION: &str = "v1.9.2";

enum EngineArchive {
    Zip,
    TarGz,
}

struct EngineBinary {
    url: String,
    archive: EngineArchive,
}

/// Upstream binary assets (ggml-org/whisper.cpp releases).
fn upstream_url(asset: &str) -> String {
    format!("https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_VERSION}/{asset}")
}

/// Our own statically built binaries — produced by
/// `.github/workflows/build-whisper-engine.yml` and attached to the
/// `whisper-engine-<WHISPER_VERSION>` release on this repo.
fn self_hosted_url(asset: &str) -> String {
    format!("https://github.com/jeandedieuH/recordForge/releases/download/whisper-engine-{WHISPER_VERSION}/{asset}")
}

/// The engine asset matching this OS/arch, if one exists. See the module
/// docs for the per-platform coverage table.
fn engine_binary() -> Option<EngineBinary> {
    let (asset, archive, self_hosted) = if cfg!(all(windows, target_arch = "x86_64")) {
        ("whisper-bin-x64.zip", EngineArchive::Zip, false)
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        ("whisper-bin-ubuntu-x64.tar.gz", EngineArchive::TarGz, false)
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        (
            "whisper-bin-ubuntu-arm64.tar.gz",
            EngineArchive::TarGz,
            false,
        )
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        ("whisper-bin-darwin-arm64.zip", EngineArchive::Zip, true)
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        ("whisper-bin-darwin-x64.zip", EngineArchive::Zip, true)
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        ("whisper-bin-win-arm64.zip", EngineArchive::Zip, true)
    } else {
        return None;
    };
    let url = if self_hosted {
        self_hosted_url(asset)
    } else {
        upstream_url(asset)
    };
    Some(EngineBinary { url, archive })
}

pub fn status(app_data_dir: &Path) -> WhisperStatus {
    let supported = engine_binary().is_some();
    let dir = engine_dir(app_data_dir);
    let binary_ready = binary_path(&dir).is_file();
    let models: Vec<WhisperModelInfo> = WHISPER_MODELS
        .iter()
        .map(|spec| WhisperModelInfo {
            id: spec.id,
            label: spec.label,
            size_bytes: spec.size_bytes,
            downloaded: model_path(&dir, spec).is_file(),
        })
        .collect();
    let ready = binary_ready && models.iter().any(|m| m.downloaded);
    WhisperStatus {
        supported,
        binary_ready,
        models,
        ready,
    }
}

/// Download the engine binary (if missing) plus the chosen model into the
/// engine dir. Emits `ai-captions-setup` progress events:
/// `{stage: "binary"|"model", downloadedBytes, totalBytes}`.
pub async fn download_engine(
    app_data_dir: &Path,
    app: &tauri::AppHandle,
    model_id: &str,
) -> Result<()> {
    use tauri::Emitter;

    let Some(binary) = engine_binary() else {
        return Err(InternalError::Media(
            "AI Captions is not yet available on this platform".into(),
        )
        .into());
    };
    let spec = model_spec(model_id)
        .ok_or_else(|| InternalError::Media(format!("unknown whisper model '{model_id}'")))?;
    let dir = engine_dir(app_data_dir);
    std::fs::create_dir_all(dir.join("models"))
        .map_err(|e| InternalError::Storage(format!("create whisper dir: {e}")))?;

    let emit = |stage: &str, downloaded: u64, total: u64| {
        let _ = app.emit(
            "ai-captions-setup",
            serde_json::json!({
                "stage": stage,
                "downloadedBytes": downloaded,
                "totalBytes": total,
            }),
        );
    };

    if !status(app_data_dir).binary_ready {
        let archive_path = dir.join("whisper-engine-download");
        download_to_file(&binary.url, &archive_path, |done, total| {
            emit("binary", done, total)
        })
        .await?;
        match binary.archive {
            EngineArchive::Zip => extract_zip(&archive_path, &dir)?,
            EngineArchive::TarGz => extract_targz(&archive_path, &dir)?,
        }
        let _ = std::fs::remove_file(&archive_path);
        // Fail loudly if keep_entry drifts from upstream asset names —
        // otherwise we'd download a multi-hundred-MB model and still leave
        // the engine unusable.
        if !binary_path(&dir).is_file() {
            return Err(InternalError::Media(
                "engine archive did not contain the whisper-cli binary".into(),
            )
            .into());
        }
        // Zip loses the unix exec bit (self-hosted macOS builds are zips);
        // tar extraction preserves it but the chmod is harmless either way.
        #[cfg(unix)]
        set_executable(&binary_path(&dir))?;
    }

    let model = model_path(&dir, spec);
    if !model.is_file() {
        download_to_file(
            &format!("{WHISPER_MODEL_URL_BASE}/{}", spec.file),
            &model,
            |done, total| emit("model", done, total),
        )
        .await?;
    }
    Ok(())
}

/// Remove a downloaded model file (multi-GB models deserve an off switch).
pub fn delete_model(app_data_dir: &Path, model_id: &str) -> Result<()> {
    let spec = model_spec(model_id)
        .ok_or_else(|| InternalError::Media(format!("unknown whisper model '{model_id}'")))?;
    let path = model_path(&engine_dir(app_data_dir), spec);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| InternalError::Storage(format!("delete model: {e}")))?;
    }
    Ok(())
}

pub(crate) async fn download_to_file(
    url: &str,
    dest: &Path,
    on_progress: impl Fn(u64, u64),
) -> Result<()> {
    use futures_util::StreamExt;

    let response = reqwest::get(url)
        .await
        .map_err(|e| InternalError::Storage(format!("engine download: {e}")))?;
    if !response.status().is_success() {
        return Err(InternalError::Storage(format!(
            "engine download failed: HTTP {}",
            response.status()
        ))
        .into());
    }
    let total = response.content_length().unwrap_or(0);
    // Write to .part first — a killed download must never present as a
    // half-written binary that status() would report as ready.
    let part_path = dest.with_extension("part");
    let mut file = std::fs::File::create(&part_path)
        .map_err(|e| InternalError::Storage(format!("create download file: {e}")))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| InternalError::Storage(format!("download read: {e}")))?;
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|e| InternalError::Storage(format!("write download: {e}")))?;
        downloaded += chunk.len() as u64;
        on_progress(downloaded, total);
    }
    drop(file);
    std::fs::rename(&part_path, dest)
        .map_err(|e| InternalError::Storage(format!("finalize download: {e}")))?;
    Ok(())
}

/// Files worth keeping from an engine archive: the CLI, its shared libs
/// (`libggml*` / `libwhisper*` — per-microarch dispatch on Linux), and the
/// upstream LICENSE (required when redistributing the MIT-licensed binaries).
fn keep_entry(name: &str) -> bool {
    name == "whisper-cli"
        || name == "whisper-cli.exe"
        || name.ends_with(".dll")
        || name == "LICENSE"
        || name.starts_with("libwhisper")
        || name.starts_with("libggml")
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| InternalError::Storage(format!("open engine zip: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| InternalError::Storage(format!("read engine zip: {e}")))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| InternalError::Storage(format!("zip entry: {e}")))?;
        let Some(name) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        // Flatten: the release zip nests binaries under a folder; we only
        // need the top-level exe + ggml DLLs next to it.
        let Some(file_name) = name.file_name() else {
            continue;
        };
        if !keep_entry(&file_name.to_string_lossy()) {
            continue;
        }
        let out = dest.join(file_name);
        let mut out_file = std::fs::File::create(&out)
            .map_err(|e| InternalError::Storage(format!("extract {}: {e}", out.display())))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| InternalError::Storage(format!("write {}: {e}", out.display())))?;
    }
    Ok(())
}

/// The Linux tarball carries the binary plus `libggml-cpu-*` per-microarch
/// libraries and versioned `.so` symlinks (`libwhisper.so` → `.so.1` →
/// `.so.1.9.2`). `Entry::unpack` preserves permissions and re-creates the
/// symlinks with their original *relative* targets, so flattening every entry
/// into `dest` keeps the chain intact. The binary's `$ORIGIN` rpath then finds
/// the libs next to itself — no `LD_LIBRARY_PATH` needed.
fn extract_targz(tar_path: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(tar_path)
        .map_err(|e| InternalError::Storage(format!("open engine archive: {e}")))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in archive
        .entries()
        .map_err(|e| InternalError::Storage(format!("read engine archive: {e}")))?
    {
        let mut entry = entry.map_err(|e| InternalError::Storage(format!("archive entry: {e}")))?;
        let name = entry
            .path()
            .map_err(|e| InternalError::Storage(format!("archive path: {e}")))?
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
        let Some(name) = name else { continue };
        if !keep_entry(&name) {
            continue;
        }
        entry
            .unpack(dest.join(&name))
            .map_err(|e| InternalError::Storage(format!("extract {name}: {e}")))?;
    }
    Ok(())
}

/// Zip extraction doesn't restore unix permissions — the extracted
/// whisper-cli would not be runnable on macOS without this.
#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| InternalError::Storage(format!("stat {}: {e}", path.display())))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms)
        .map_err(|e| InternalError::Storage(format!("chmod {}: {e}", path.display())))?;
    Ok(())
}

/// Extract a mono 16 kHz WAV (whisper.cpp's expected input) from a source
/// file. All audio streams are merged so speech on any track transcribes.
pub fn extract_transcribe_audio(
    ffmpeg_path: &Path,
    source: &Path,
    wav_path: &Path,
    audio_indices: &[i32],
) -> Result<()> {
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(source);
    if audio_indices.len() <= 1 {
        command
            .args(["-map", "0:a:0"])
            .args(["-ac", "1", "-ar", "16000"]);
    } else {
        let labels: String = audio_indices
            .iter()
            .map(|index| format!("[0:{index}]"))
            .collect();
        command
            .arg("-filter_complex")
            .arg(format!("{labels}amerge=inputs={}[a]", audio_indices.len()))
            .args(["-map", "[a]", "-ac", "1", "-ar", "16000"]);
    }
    command
        .args(["-c:a", "pcm_s16le", "-f", "wav"])
        .arg(wav_path);
    let output = command
        .output()
        .map_err(|e| InternalError::Media(format!("audio extract spawn: {e}")))?;
    if !output.status.success() {
        return Err(InternalError::Media(format!(
            "audio extract failed: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(400)
                .collect::<String>()
        ))
        .into());
    }
    Ok(())
}

/// Run whisper-cli on the WAV and return the generated SRT path. Output is
/// `<out_base>.srt` next to the WAV.
#[instrument(skip_all)]
pub fn run_whisper(
    app_data_dir: &Path,
    model_id: &str,
    wav_path: &Path,
    out_base: &Path,
) -> Result<PathBuf> {
    let spec = model_spec(model_id)
        .ok_or_else(|| InternalError::Media(format!("unknown whisper model '{model_id}'")))?;
    let dir = engine_dir(app_data_dir);
    let binary = binary_path(&dir);
    let model = model_path(&dir, spec);
    if !binary.is_file() {
        return Err(InternalError::Media("speech engine is not downloaded yet".into()).into());
    }
    if !model.is_file() {
        return Err(
            InternalError::Media("the selected speech model is not downloaded yet".into()).into(),
        );
    }
    let output = crate::process::create_command(&binary)
        .current_dir(&dir) // libs resolve next to the binary ($ORIGIN rpath / DLL search)
        .arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(wav_path)
        // Multilingual weights: auto-detect the spoken language instead of
        // assuming English (whisper-cli's `-l` default is "en").
        .args(["-l", "auto"])
        .arg("-osrt")
        .arg("-of")
        .arg(out_base)
        .output()
        .map_err(|e| InternalError::Media(format!("whisper spawn: {e}")))?;
    if !output.status.success() {
        return Err(InternalError::Media(format!(
            "transcription failed: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(400)
                .collect::<String>()
        ))
        .into());
    }
    Ok(out_base.with_extension("srt"))
}

/// Parse an SRT file into (start_ms, end_ms, text) tuples.
pub fn parse_srt(content: &str) -> Vec<(u64, u64, String)> {
    let mut cues = Vec::new();
    let normalized = content.replace("\r\n", "\n");
    for block in normalized.split("\n\n") {
        let mut lines = block.trim().lines();
        let Some(timing) = lines
            .find(|line| line.contains("-->"))
            .map(|line| line.to_string())
        else {
            continue;
        };
        let mut parts = timing.split("-->");
        let start_ms = parts.next().and_then(|s| parse_srt_time(s.trim()));
        let end_ms = parts
            .next()
            .and_then(|s| parse_srt_time(s.split_whitespace().next().unwrap_or("")));
        let text: String = lines.collect::<Vec<_>>().join(" ").trim().to_string();
        if let (Some(start), Some(end)) = (start_ms, end_ms) {
            if end > start && !text.is_empty() {
                cues.push((start, end, text));
            }
        }
    }
    cues
}

fn parse_srt_time(value: &str) -> Option<u64> {
    let (hms, ms) = value.split_once(',')?;
    let mut parts = hms.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    let millis: f64 = ms.parse().ok()?;
    Some(((hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0 + millis).round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_srt_reads_cues_and_skips_malformed() {
        let srt = "1\n00:00:01,500 --> 00:00:03,000\nHello world\n\n2\n00:00:04,000 --> 00:00:05,250\nSecond cue\nsecond line\n\n3\nbad timing\norphan\n";
        let cues = parse_srt(srt);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0], (1500, 3000, "Hello world".to_string()));
        assert_eq!(cues[1].0, 4000);
        assert_eq!(cues[1].1, 5250);
        // Multi-line cue text joins with a space.
        assert_eq!(cues[1].2, "Second cue second line");
    }

    #[test]
    fn keep_entry_filters_runtime_payload() {
        assert!(keep_entry("whisper-cli"));
        assert!(keep_entry("whisper-cli.exe"));
        assert!(keep_entry("libwhisper.so.1"));
        assert!(keep_entry("libggml-cpu-zen4.so"));
        assert!(keep_entry("ggml.dll"));
        assert!(keep_entry("LICENSE"));
        // Test tools, servers, and unrelated binaries stay out of the install.
        assert!(!keep_entry("whisper-server"));
        assert!(!keep_entry("whisper-bench"));
        assert!(!keep_entry("test-vad"));
        assert!(!keep_entry("libparakeet.so.1"));
    }

    /// Deflated zip mimicking the upstream `Release/` layout. Regresses the
    /// engine-download failure where `zip` was compiled without a deflate
    /// backend and `by_index` rejected every entry after the ~8 MB download.
    const ENGINE_ZIP_FIXTURE_B64: &str = "UEsDBBQAAAAIADqoSl0lhKNWCgAAAAgAAAARAAAAUmVsZWFzZS9iZW5jaC5leGXLyy9RyE4tKAEAUEsDBBQAAAAIADqoSl3yCi6OEQAAAA8AAAAXAAAAUmVsZWFzZS93aGlzcGVyLWNsaS5leGVLS8xOVUjOyVRIysxLLKoEAFBLAwQUAAAACAA6qEpdB70V+xAAAAAOAAAAEAAAAFJlbGVhc2UvZ2dtbC5kbGxLS8xOVUjJyVFIqixJLQYAUEsBAhQAFAAAAAgAOqhKXSWEo1YKAAAACAAAABEAAAAAAAAAAAAAAIABAAAAAFJlbGVhc2UvYmVuY2guZXhlUEsBAhQAFAAAAAgAOqhKXfIKLo4RAAAADwAAABcAAAAAAAAAAAAAAIABOQAAAFJlbGVhc2Uvd2hpc3Blci1jbGkuZXhlUEsBAhQAFAAAAAgAOqhKXQe9FfsQAAAADgAAABAAAAAAAAAAAAAAAIABfwAAAFJlbGVhc2UvZ2dtbC5kbGxQSwUGAAAAAAMAAwDCAAAAvQAAAAAA";

    #[test]
    fn extract_zip_keeps_and_flattens_deflated_entries() {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(ENGINE_ZIP_FIXTURE_B64)
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("engine.zip");
        std::fs::write(&zip_path, bytes).unwrap();
        let dest = tmp.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();

        extract_zip(&zip_path, &dest).unwrap();

        assert_eq!(
            std::fs::read(dest.join("whisper-cli.exe")).unwrap(),
            b"fake cli binary"
        );
        assert_eq!(
            std::fs::read(dest.join("ggml.dll")).unwrap(),
            b"fake dll bytes"
        );
        assert!(!dest.join("bench.exe").exists());
    }
}
