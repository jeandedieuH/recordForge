use regex::Regex;
use std::process::Command;
use std::time::Instant;
use tracing::{info, instrument};

use super::config::RecordingProfile;
use super::encoder::EncoderInfo;

/// Result of a single encoder/profile benchmark run.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderBenchmarkResult {
    pub encoder_id: String,
    pub profile_id: String,
    pub width: i64,
    pub height: i64,
    pub fps: i64,
    pub duration_sec: f64,
    pub frames_processed: i64,
    pub avg_fps: f64,
    pub speed: f64,
    pub bitrate_kbps: Option<f64>,
    pub cpu_percent: Option<f64>,
    pub memory_mb: Option<f64>,
    pub error: Option<String>,
}

/// Aggregate benchmark report used to choose the default profile/encoder.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkReport {
    pub id: String,
    pub created_at: String,
    pub platform: BenchmarkPlatform,
    pub results: Vec<EncoderBenchmarkResult>,
    pub recommendation: BenchmarkRecommendation,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkPlatform {
    pub os: String,
    pub ffmpeg_version: String,
    pub cpu: Option<String>,
    pub memory_mb: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkRecommendation {
    pub profile_id: String,
    pub encoder_id: String,
    pub reason: String,
}

/// Run a short benchmark for every combination of built-in profiles and
/// detected encoders. This is intentionally lightweight: it feeds a short
/// generated test signal to FFmpeg and records the reported encoding speed.
#[instrument]
pub fn run_benchmark(
    ffmpeg_path: &str,
    profiles: Vec<RecordingProfile>,
    encoders: Vec<EncoderInfo>,
) -> crate::errors::Result<BenchmarkReport> {
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();
    let os = os_info();
    let ffmpeg_version = ffmpeg_version(ffmpeg_path)?;

    let mut results = Vec::new();

    for profile in &profiles {
        for encoder in &encoders {
            if !encoder.available {
                continue;
            }

            info!(
                encoder_id = %encoder.id,
                profile_id = %profile.id,
                "benchmarking encoder/profile"
            );

            let result = benchmark_single(ffmpeg_path, profile, encoder);
            results.push(result);
        }
    }

    let cpu_cores = std::thread::available_parallelism().map(|n| n.get()).ok();
    let cpu = cpu_cores.map(|c| {
        if c == 1 {
            "1 Core".to_string()
        } else {
            format!("{c} Cores")
        }
    });

    let recommendation = choose_recommendation(&profiles, &results, cpu_cores.unwrap_or(4));

    Ok(BenchmarkReport {
        id,
        created_at,
        platform: BenchmarkPlatform {
            os,
            ffmpeg_version,
            cpu,
            memory_mb: None,
        },
        results,
        recommendation,
    })
}

fn os_info() -> String {
    if cfg!(windows) {
        "windows".into()
    } else if cfg!(target_os = "macos") {
        "macos".into()
    } else if cfg!(target_os = "linux") {
        "linux".into()
    } else {
        "unknown".into()
    }
}

fn ffmpeg_version(ffmpeg_path: &str) -> crate::errors::Result<String> {
    let output = Command::new(ffmpeg_path)
        .arg("-version")
        .output()
        .map_err(|e| crate::errors::InternalError::Media(format!("ffmpeg version: {e}")))?;

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .next()
        .unwrap_or("unknown")
        .split_whitespace()
        .nth(2)
        .unwrap_or("unknown")
        .to_string())
}

/// Benchmark a single encoder against a short synthetic source.
fn benchmark_single(
    ffmpeg_path: &str,
    profile: &RecordingProfile,
    encoder: &EncoderInfo,
) -> EncoderBenchmarkResult {
    let duration_sec = 3.0;
    let input = format!(
        "testsrc=size={}x{}:rate={}:duration={}",
        profile.width, profile.height, profile.fps, duration_sec
    );

    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-f",
        "lavfi",
        "-i",
        &input,
        "-c:v",
        &encoder.id,
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-f",
        "null",
        "-",
    ]);

    let started = Instant::now();
    let output = match command.output() {
        Ok(o) => o,
        Err(e) => {
            return EncoderBenchmarkResult {
                encoder_id: encoder.id.clone(),
                profile_id: profile.id.clone(),
                width: profile.width as i64,
                height: profile.height as i64,
                fps: profile.fps as i64,
                duration_sec,
                frames_processed: 0,
                avg_fps: 0.0,
                speed: 0.0,
                bitrate_kbps: None,
                cpu_percent: None,
                memory_mb: None,
                error: Some(format!("failed to run ffmpeg: {e}")),
            };
        }
    };
    let elapsed = started.elapsed().as_secs_f64();

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stats = parse_last_stats(&stderr);

    if !output.status.success() {
        return EncoderBenchmarkResult {
            encoder_id: encoder.id.clone(),
            profile_id: profile.id.clone(),
            width: profile.width as i64,
            height: profile.height as i64,
            fps: profile.fps as i64,
            duration_sec: elapsed,
            frames_processed: stats.frame.unwrap_or(0),
            avg_fps: stats.fps.unwrap_or(0.0),
            speed: stats.speed.unwrap_or(0.0),
            bitrate_kbps: None,
            cpu_percent: None,
            memory_mb: None,
            error: Some(stderr.lines().last().unwrap_or("unknown error").to_string()),
        };
    }

    EncoderBenchmarkResult {
        encoder_id: encoder.id.clone(),
        profile_id: profile.id.clone(),
        width: profile.width as i64,
        height: profile.height as i64,
        fps: profile.fps as i64,
        duration_sec: elapsed,
        frames_processed: stats.frame.unwrap_or(0),
        avg_fps: stats.fps.unwrap_or(0.0),
        speed: stats.speed.unwrap_or(0.0),
        bitrate_kbps: None,
        cpu_percent: None,
        memory_mb: None,
        error: None,
    }
}

#[derive(Debug, Default)]
struct StatsSnapshot {
    frame: Option<i64>,
    fps: Option<f64>,
    speed: Option<f64>,
}

fn parse_last_stats(stderr: &str) -> StatsSnapshot {
    let re = match Regex::new(
        r"frame=\s*(\d+)\s+fps=\s*([\d.]+)\s+q=\s*[\d.-]+\s+(?:size=\s*[\d.]+\w+\s+)?time=([\d:.]+)\s+speed=\s*([\d.]+)x",
    ) {
        Ok(re) => re,
        Err(_) => return StatsSnapshot::default(),
    };

    let mut snapshot = StatsSnapshot::default();
    for line in stderr.lines() {
        if let Some(caps) = re.captures(line) {
            snapshot.frame = caps.get(1).and_then(|m| m.as_str().parse().ok());
            snapshot.fps = caps.get(2).and_then(|m| m.as_str().parse().ok());
            snapshot.speed = caps.get(4).and_then(|m| m.as_str().parse().ok());
        }
    }
    snapshot
}

fn choose_recommendation(
    profiles: &[RecordingProfile],
    results: &[EncoderBenchmarkResult],
    cpu_cores: usize,
) -> BenchmarkRecommendation {
    // If running on a low-end CPU with 2 or fewer cores, recommend Low Impact to ensure low CPU usage.
    if cpu_cores <= 2 {
        let low_impact = profiles
            .iter()
            .find(|p| p.id == "low-impact")
            .map(|p| p.id.clone())
            .unwrap_or_else(|| "low-impact".into());

        let best_encoder = results
            .iter()
            .filter(|r| r.profile_id == "low-impact" && r.error.is_none())
            .max_by(|a, b| {
                a.speed
                    .partial_cmp(&b.speed)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|r| r.encoder_id.clone())
            .unwrap_or_else(|| "libx264".into());

        return BenchmarkRecommendation {
            profile_id: low_impact,
            encoder_id: best_encoder,
            reason: format!(
                "Low-spec hardware detected ({cpu_cores} CPU cores). 'Low Impact' profile (720p/480p) is recommended for low CPU usage and zero frame drops."
            ),
        };
    }

    // Prefer the encoder with the highest speed, then libx264, then any available.
    let mut sorted = results.to_vec();
    sorted.sort_by(|a, b| {
        b.speed
            .partial_cmp(&a.speed)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if let Some(best) = sorted.first() {
        let reason = if best.encoder_id == "libx264" {
            format!(
                "libx264 is the best available option at {:.2}x real-time",
                best.speed
            )
        } else {
            format!(
                "{} was the fastest encoder at {:.2}x real-time",
                best.encoder_id, best.speed
            )
        };

        return BenchmarkRecommendation {
            profile_id: best.profile_id.clone(),
            encoder_id: best.encoder_id.clone(),
            reason,
        };
    }

    // If no encoder is available, fall back to the first profile with libx264.
    let profile = profiles
        .first()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| "low-impact".into());

    BenchmarkRecommendation {
        profile_id: profile,
        encoder_id: "libx264".into(),
        reason: "fallback to libx264; no encoders succeeded during benchmark".into(),
    }
}
