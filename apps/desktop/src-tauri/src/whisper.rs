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
    /// Silero VAD model present — enables `--vad` for word-accurate timing.
    pub vad_ready: bool,
}

/// Optional Silero VAD model (`--vad`). Tiny (~0.9 MB), downloaded
/// best-effort — its absence must never fail engine setup or transcription.
const VAD_MODEL_FILE: &str = "ggml-silero-v5.1.2.bin";
const VAD_MODEL_URL: &str =
    "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
const VAD_MODEL_SHA256: &str = "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf";

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

fn vad_model_path(dir: &Path) -> PathBuf {
    dir.join("models").join(VAD_MODEL_FILE)
}

pub(crate) fn model_spec(id: &str) -> Option<&'static WhisperModelSpec> {
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
        vad_ready: vad_model_path(&dir).is_file(),
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

    // VAD weights are ~0.9 MB and unlock `--vad`. Best-effort: a download
    // failure must not fail the whole engine setup.
    if let Err(error) = download_vad_model(&dir).await {
        tracing::warn!(error = %error, "VAD model download failed");
    }
    Ok(())
}

/// Download the pinned Silero VAD model into `<engine>/models/`. The sha256 is
/// verified; a corrupt download is deleted so `vad_ready` never reports a
/// bad file. Idempotent — returns early when the file already exists.
pub async fn download_vad_model(engine_dir: &Path) -> Result<()> {
    let dest = vad_model_path(engine_dir);
    if dest.is_file() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InternalError::Storage(format!("create whisper models dir: {e}")))?;
    }
    download_to_file(VAD_MODEL_URL, &dest, |_, _| {}).await?;
    let digest = file_sha256(&dest)?;
    if !digest.eq_ignore_ascii_case(VAD_MODEL_SHA256) {
        let _ = std::fs::remove_file(&dest);
        return Err(InternalError::Storage("VAD model failed its integrity check".into()).into());
    }
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String> {
    use sha2::Digest;
    let bytes = std::fs::read(path)
        .map_err(|e| InternalError::Storage(format!("read downloaded file: {e}")))?;
    Ok(hex::encode(sha2::Sha256::digest(&bytes)))
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

// ---------------------------------------------------------------------------
// Word-level transcription pipeline (`transcribe_audio`)
// ---------------------------------------------------------------------------

/// `adelay=<ms>:all=1` pads the decoded stream with leading silence so WAV
/// time stays on the recording's container timeline — audio streams can start
/// after container zero, and transcript times must match the time base that
/// `AudioClip.sourceInMs/sourceOutMs` use (`atrim` on the raw stream).
pub fn adelay_filter(stream_start_ms: Option<u64>) -> Option<String> {
    match stream_start_ms {
        Some(ms) if ms > 0 => Some(format!("adelay={ms}:all=1")),
        _ => None,
    }
}

/// Extract ONE audio stream as a mono 16 kHz pcm_s16le WAV for whisper.
/// `stream_index` is the absolute ffprobe stream index (`-map 0:N`).
pub fn extract_stream_transcribe_audio(
    ffmpeg_path: &Path,
    source: &Path,
    wav_path: &Path,
    stream_index: i32,
    stream_start_ms: Option<u64>,
) -> Result<()> {
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(source);
    let map = format!("0:{stream_index}");
    command
        .args(["-map", map.as_str()])
        .args(["-vn", "-sn", "-dn"]);
    if let Some(filter) = adelay_filter(stream_start_ms) {
        command.arg("-af").arg(filter);
    }
    command
        .args(["-ac", "1", "-ar", "16000"])
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

/// whisper-cli `-t`: more than ~8 threads buys nothing on inference and takes
/// CPU a screen recorder may need.
pub fn whisper_threads() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4)
        .clamp(1, 8)
}

/// whisper-cli argument list for word-level JSON output. Verified against the
/// pinned v1.9.2 binary's `--help`: `-ojf` writes `<out_base>.json` including
/// per-token `offsets` (ms) and confidence `p`; `-pp` prints
/// `progress = NN%` on stderr; `-sns` suppresses non-speech tokens; `--vad`
/// (+`-vm`) runs Silero VAD first so silence is skipped, not transcribed.
pub fn transcribe_args(
    model: &Path,
    wav_path: &Path,
    out_base: &Path,
    language: &str,
    threads: u32,
    vad_model: Option<&Path>,
) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec![
        "-m".into(),
        model.as_os_str().into(),
        "-f".into(),
        wav_path.as_os_str().into(),
        "-l".into(),
        language.into(),
        "-ojf".into(),
        "-of".into(),
        out_base.as_os_str().into(),
        "-pp".into(),
        "-sns".into(),
        "-t".into(),
        threads.to_string().into(),
    ];
    if let Some(vad) = vad_model {
        args.push("--vad".into());
        args.push("-vm".into());
        args.push(vad.as_os_str().into());
    }
    args
}

/// Parse a `-pp` stderr line like
/// `whisper_print_progress_callback: progress =  45%` into 0..=100.
/// Tolerant of spacing differences between builds.
pub fn parse_progress_line(line: &str) -> Option<u8> {
    let marker = line.find("progress")?;
    let rest = line[marker..].split_once('=')?.1.trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let value: u8 = digits.parse().ok()?;
    if value > 100 || !rest[digits.len()..].trim_start().starts_with('%') {
        return None;
    }
    Some(value)
}

/// Parse a `--vad` stderr line like
/// `whisper_vad: vad_segment_info: orig_start: 21.47, orig_end: 22.01, vad_start: 16.02, vad_end: 16.56`
/// (seconds, 2 decimals). These lines are the compressed→original mapping
/// whisper applies to segment timestamps but — measured on v1.9.2 — not to
/// token offsets, so we apply it to tokens ourselves.
pub fn parse_vad_segment_info(line: &str) -> Option<crate::transcript::VadSegment> {
    fn field(line: &str, key: &str) -> Option<u64> {
        let start = line.find(key)? + key.len();
        line[start..]
            .trim_start_matches([':', ' '])
            .split(|c: char| c == ',' || c.is_whitespace())
            .next()?
            .parse::<f64>()
            .ok()
            .map(|seconds| (seconds * 1000.0).round() as u64)
    }
    if !line.contains("vad_segment_info") {
        return None;
    }
    Some(crate::transcript::VadSegment {
        orig_start_ms: field(line, "orig_start")?,
        orig_end_ms: field(line, "orig_end")?,
        vad_start_ms: field(line, "vad_start")?,
        vad_end_ms: field(line, "vad_end")?,
    })
}

/// Duration of a PCM WAV in milliseconds, derived from the `data` chunk size
/// and the `fmt ` byte rate — no ffprobe round trip for a file we just wrote.
pub fn wav_duration_ms(path: &Path) -> Result<u64> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)
        .map_err(|e| InternalError::Storage(format!("open extracted audio: {e}")))?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header)
        .map_err(|e| InternalError::Media(format!("read extracted audio: {e}")))?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err(InternalError::Media("extracted audio is not a WAV file".into()).into());
    }
    let mut byte_rate: Option<u64> = None;
    let mut data_len: Option<u64> = None;
    loop {
        let mut chunk = [0u8; 8];
        if file.read_exact(&mut chunk).is_err() {
            break;
        }
        let len = u32::from_le_bytes(chunk[4..8].try_into().unwrap()) as u64;
        match &chunk[0..4] {
            b"fmt " => {
                let mut fmt = [0u8; 16];
                file.read_exact(&mut fmt)
                    .map_err(|e| InternalError::Media(format!("read wav fmt chunk: {e}")))?;
                byte_rate = Some(u32::from_le_bytes(fmt[8..12].try_into().unwrap()) as u64);
                let remaining = len.saturating_sub(16) + (len % 2);
                file.seek(SeekFrom::Current(remaining as i64))
                    .map_err(|e| InternalError::Media(format!("seek wav chunk: {e}")))?;
            }
            b"data" => {
                data_len = Some(len);
                break;
            }
            _ => {
                file.seek(SeekFrom::Current((len + (len % 2)) as i64))
                    .map_err(|e| InternalError::Media(format!("seek wav chunk: {e}")))?;
            }
        }
    }
    match (byte_rate, data_len) {
        (Some(rate), Some(len)) if rate > 0 => Ok(len * 1000 / rate),
        _ => Err(InternalError::Media("could not determine audio duration".into()).into()),
    }
}

/// What [`run_whisper_transcribe`] produced: the JSON path plus the token
/// time map recovered from the run's stderr.
pub struct WhisperTranscribeOutput {
    pub json_path: PathBuf,
    pub token_time_map: crate::transcript::TokenTimeMap,
}

/// Drain a child stream line-by-line on raw bytes. A single non-UTF-8 byte
/// must not end the read — `BufRead::lines` stops on the first decode error,
/// the pipe would stop draining, and whisper could block forever on a full
/// stderr pipe — so we read to `'\n'` ourselves and decode each line lossily.
fn for_each_pipe_line(reader: impl std::io::Read, mut on_line: impl FnMut(&str)) {
    use std::io::BufRead;
    let mut buffered = std::io::BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match buffered.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                on_line(line.trim_end_matches(['\r', '\n']));
            }
        }
    }
}

/// Run whisper-cli for a word-level transcript: `-ojf` JSON output, `-pp`
/// progress events on stderr, `--vad` when the Silero model is present.
///
/// stderr is read line-by-line on a reader thread (progress → `on_progress`,
/// `vad_segment_info` → the returned [`TokenTimeMap`]); stdout is never read —
/// it carries the transcript text — so it is redirected to null. The child is
/// registered on `job` so `cancel_transcription` can kill it; the wait loop
/// polls `try_wait` so the cancel path is never blocked on a held lock.
pub fn run_whisper_transcribe(
    app_data_dir: &Path,
    model_id: &str,
    wav_path: &Path,
    out_base: &Path,
    language: &str,
    job: &std::sync::Arc<crate::transcript::TranscriptionJob>,
    on_progress: impl Fn(u8) + Send + 'static,
) -> Result<WhisperTranscribeOutput> {
    use std::process::Stdio;
    use std::sync::{Arc, Mutex};

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
    let vad = vad_model_path(&dir);
    let vad = vad.is_file().then_some(vad);
    let args = transcribe_args(
        &model,
        wav_path,
        out_base,
        language,
        whisper_threads(),
        vad.as_deref(),
    );

    let mut child = crate::process::create_command(&binary)
        .current_dir(&dir) // runtime libs resolve next to the binary
        .args(&args)
        .stdin(Stdio::null())
        // Transcript text goes to stdout — redirect to null rather than risk
        // it reaching a log.
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| InternalError::Media(format!("whisper spawn: {e}")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| InternalError::Media("whisper stderr pipe unavailable".into()))?;
    job.set_child(child);

    let vad_segments = Arc::new(Mutex::new(Vec::new()));
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let reader = std::thread::spawn({
        let vad_segments = Arc::clone(&vad_segments);
        let stderr_tail = Arc::clone(&stderr_tail);
        move || {
            for_each_pipe_line(stderr, |line| {
                if let Some(percent) = parse_progress_line(line) {
                    on_progress(percent);
                }
                if let Some(segment) = parse_vad_segment_info(line) {
                    if let Ok(mut segments) = vad_segments.lock() {
                        segments.push(segment);
                    }
                }
                // Keep a short tail for failure reporting — never persisted,
                // only surfaced inside a bounded AppError message.
                if let Ok(mut tail) = stderr_tail.lock() {
                    if tail.len() + line.len() > 2000 {
                        let mut drop_to = tail.len().saturating_sub(1500);
                        while drop_to < tail.len() && !tail.is_char_boundary(drop_to) {
                            drop_to += 1;
                        }
                        tail.drain(..drop_to);
                    }
                    tail.push_str(line);
                    tail.push('\n');
                }
            });
        }
    });

    let status = loop {
        match job.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(error) => {
                let _ = reader.join();
                return Err(error);
            }
        }
    };
    let _ = reader.join();

    let token_time_map = match vad {
        None => crate::transcript::TokenTimeMap::Identity,
        Some(_) => {
            let segments = vad_segments.lock().map(|s| s.clone()).unwrap_or_default();
            if segments.is_empty() {
                crate::transcript::TokenTimeMap::VadUnmapped
            } else {
                crate::transcript::TokenTimeMap::Vad(segments)
            }
        }
    };

    if job.is_cancelled() {
        return Err(crate::transcript::transcription_cancelled());
    }
    if !status.success() {
        let tail = stderr_tail.lock().map(|t| t.clone()).unwrap_or_default();
        let snippet = scrub_paths(
            &tail,
            &[
                &dir,
                &model,
                wav_path,
                out_base,
                vad.as_deref().unwrap_or(&dir),
            ],
        );
        let snippet: String = snippet
            .chars()
            .rev()
            .take(200)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        let snippet = snippet.trim().to_string();
        return Err(InternalError::Media(if snippet.is_empty() {
            "transcription failed".to_string()
        } else {
            format!("transcription failed: {snippet}")
        })
        .into());
    }
    Ok(WhisperTranscribeOutput {
        json_path: out_base.with_extension("json"),
        token_time_map,
    })
}

/// Remove known filesystem paths from a stderr snippet before it reaches an
/// error message — media paths must never surface to the UI or logs.
fn scrub_paths(text: &str, paths: &[&Path]) -> String {
    let mut out = text.to_string();
    for path in paths {
        let display = path.to_string_lossy().to_string();
        if !display.is_empty() {
            out = out.replace(&display, "<path>");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn adelay_only_applies_to_late_streams() {
        assert_eq!(adelay_filter(None), None);
        assert_eq!(adelay_filter(Some(0)), None);
        assert_eq!(
            adelay_filter(Some(2454)),
            Some("adelay=2454:all=1".to_string())
        );
    }

    #[test]
    fn threads_are_clamped_to_engine_range() {
        let threads = whisper_threads();
        assert!((1..=8).contains(&threads));
    }

    fn args_to_strings(args: &[std::ffi::OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn transcribe_args_match_verified_cli() {
        let args = args_to_strings(&transcribe_args(
            Path::new("models/ggml-base.bin"),
            Path::new("work/audio.wav"),
            Path::new("work/out"),
            "auto",
            4,
            None,
        ));
        assert_eq!(
            args,
            [
                "-m",
                "models/ggml-base.bin",
                "-f",
                "work/audio.wav",
                "-l",
                "auto",
                "-ojf",
                "-of",
                "work/out",
                "-pp",
                "-sns",
                "-t",
                "4"
            ]
        );
    }

    #[test]
    fn transcribe_args_add_vad_and_explicit_language() {
        let args = args_to_strings(&transcribe_args(
            Path::new("models/ggml-small.bin"),
            Path::new("work/audio.wav"),
            Path::new("work/out"),
            "de",
            8,
            Some(Path::new("models/ggml-silero-v5.1.2.bin")),
        ));
        assert!(args.contains(&"-l".to_string()));
        assert_eq!(args[args.iter().position(|a| a == "-l").unwrap() + 1], "de");
        let tail: Vec<&str> = args[args.len() - 3..].iter().map(String::as_str).collect();
        assert_eq!(tail, ["--vad", "-vm", "models/ggml-silero-v5.1.2.bin"]);
    }

    #[test]
    fn parses_progress_lines_tolerantly() {
        assert_eq!(
            parse_progress_line("whisper_print_progress_callback: progress =  45%"),
            Some(45)
        );
        assert_eq!(
            parse_progress_line("whisper_print_progress_callback: progress = 100%"),
            Some(100)
        );
        assert_eq!(parse_progress_line("progress =   3%"), Some(3));
        assert_eq!(
            parse_progress_line("whisper_model_load: n_vocab = 51865"),
            None
        );
        assert_eq!(parse_progress_line("progress = 250%"), None);
        assert_eq!(parse_progress_line("progress = "), None);
    }

    #[test]
    fn pipe_lines_survive_invalid_utf8() {
        // A non-UTF-8 byte mid-stream must not end the drain — progress and
        // VAD lines after it still get parsed.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"whisper_print_progress_callback: progress =  10%\n");
        bytes.extend_from_slice(&[0xff, 0xfe, 0x80]); // invalid UTF-8
        bytes.extend_from_slice(b"garbage \xf0\x28\n");
        bytes.extend_from_slice(
            b"whisper_vad: vad_segment_info: orig_start: 2.59, orig_end: 4.06, vad_start: 0.00, vad_end: 1.47\n",
        );
        bytes.extend_from_slice(b"whisper_print_progress_callback: progress =  95%");
        let mut progress = Vec::new();
        let mut vad_count = 0;
        for_each_pipe_line(&bytes[..], |line| {
            if let Some(p) = parse_progress_line(line) {
                progress.push(p);
            }
            if parse_vad_segment_info(line).is_some() {
                vad_count += 1;
            }
        });
        assert_eq!(progress, [10, 95]);
        assert_eq!(vad_count, 1);
    }

    #[test]
    fn parses_vad_segment_info_lines() {
        let line = "whisper_vad: vad_segment_info: orig_start: 21.47, orig_end: 22.01, vad_start: 16.02, vad_end: 16.56";
        let seg = parse_vad_segment_info(line).unwrap();
        assert_eq!(seg.orig_start_ms, 21470);
        assert_eq!(seg.orig_end_ms, 22010);
        assert_eq!(seg.vad_start_ms, 16020);
        assert_eq!(seg.vad_end_ms, 16560);
        assert!(parse_vad_segment_info("whisper_vad: VAD is enabled").is_none());
    }

    /// Minimal PCM WAV: RIFF header + fmt + data chunks.
    fn write_wav(path: &Path, byte_rate: u32, data_bytes: usize) {
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&1u16.to_le_bytes()); // mono
        out.extend_from_slice(&16000u32.to_le_bytes()); // sample rate
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes()); // block align
        out.extend_from_slice(&16u16.to_le_bytes()); // bits
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data_bytes as u32).to_le_bytes());
        out.extend(std::iter::repeat_n(0u8, data_bytes));
        std::fs::write(path, out).unwrap();
    }

    #[test]
    fn wav_duration_comes_from_data_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("a.wav");
        // 32 000 B/s (16 kHz s16 mono) × 64 000 bytes = 2 000 ms.
        write_wav(&wav, 32_000, 64_000);
        assert_eq!(wav_duration_ms(&wav).unwrap(), 2000);
        std::fs::write(dir.path().join("bad.wav"), b"not a wav").unwrap();
        assert!(wav_duration_ms(&dir.path().join("bad.wav")).is_err());
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
