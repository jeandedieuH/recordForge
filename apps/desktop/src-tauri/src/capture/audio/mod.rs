//! Audio capture subsystem for recordForge.
//!
//! Provides platform-native audio capture engines:
//! - Windows: Native WASAPI capture (microphone & loopback)
//! - macOS: Native CoreAudio capture & ScreenCaptureKit audio streams
//! - Linux: Native PipeWire / PulseAudio monitor streams & ALSA fallback
//! - Shared: WAV header, repair, duration alignment, and sample conversions

pub mod coreaudio;
pub mod linux;
pub mod wasapi;
pub mod wav;

use std::path::PathBuf;

pub use wav::{
    align_wav_to_duration, finalize_wav, frames_for_duration, frames_to_duration,
    loopback_packet_start_frames, read_wav_format, repair_wav_header_if_needed,
    snap_wav_to_whole_frames, write_wav_header, AudioSampleFormat, WavFormat, DEFAULT_CHANNELS,
    DEFAULT_SAMPLE_RATE, SILENCE_CHUNK_FRAMES, WAV_HEADER_SIZE,
};

// Re-export Windows WASAPI symbols for backwards compatibility
pub use wasapi::{
    enumerate_wasapi_devices, WasapiCaptureKind, WasapiCaptureOptions, WasapiCaptureSession,
    WasapiDeviceInfo, WasapiSampleFormat,
};

// Re-export macOS CoreAudio symbols
pub use coreaudio::{
    enumerate_coreaudio_devices, AudioCaptureKind, AudioCaptureOptions, AudioDeviceInfo,
    CoreAudioCaptureSession,
};

// Re-export Linux symbols
pub use linux::{enumerate_linux_audio_devices, LinuxAudioCaptureSession, LinuxAudioOptions};

use crate::capture::traits::{AudioTrack, TimelineAnchor};
use crate::errors::Result;

/// Cross-platform audio device enumeration.
pub fn enumerate_audio_devices() -> Result<Vec<AudioDeviceInfo>> {
    #[cfg(windows)]
    {
        let wasapi_devices = wasapi::enumerate_wasapi_devices()?;
        Ok(wasapi_devices
            .into_iter()
            .map(|d| AudioDeviceInfo {
                id: d.id,
                name: d.name,
                is_default: d.is_default,
                is_loopback: d.is_loopback,
            })
            .collect())
    }

    #[cfg(target_os = "macos")]
    {
        coreaudio::enumerate_coreaudio_devices()
    }

    #[cfg(target_os = "linux")]
    {
        linux::enumerate_linux_audio_devices()
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        coreaudio::enumerate_coreaudio_devices()
    }
}

/// Start an audio capture track (microphone or system audio loopback) on the active host platform.
pub fn start_audio_track(
    kind: AudioCaptureKind,
    device_id: Option<String>,
    output_path: PathBuf,
    timeline_origin: TimelineAnchor,
) -> Result<Box<dyn AudioTrack>> {
    #[cfg(windows)]
    {
        let wasapi_kind = match kind {
            AudioCaptureKind::Microphone => wasapi::WasapiCaptureKind::Microphone,
            AudioCaptureKind::SystemLoopback => wasapi::WasapiCaptureKind::SystemLoopback,
        };
        let options = match wasapi_kind {
            wasapi::WasapiCaptureKind::Microphone => {
                wasapi::WasapiCaptureOptions::microphone(device_id, output_path)
                    .with_timeline_anchor(timeline_origin)
            }
            wasapi::WasapiCaptureKind::SystemLoopback => {
                wasapi::WasapiCaptureOptions::system_loopback(device_id, output_path)
                    .with_timeline_anchor(timeline_origin)
            }
        };
        let session = wasapi::WasapiCaptureSession::start(options)?;
        Ok(Box::new(session))
    }

    #[cfg(target_os = "macos")]
    {
        let options = match kind {
            AudioCaptureKind::Microphone => {
                coreaudio::AudioCaptureOptions::microphone(device_id, output_path)
                    .with_timeline_origin(timeline_origin.instant)
            }
            AudioCaptureKind::SystemLoopback => {
                coreaudio::AudioCaptureOptions::system_loopback(device_id, output_path)
                    .with_timeline_origin(timeline_origin.instant)
            }
        };
        let session = coreaudio::CoreAudioCaptureSession::start(options)?;
        Ok(Box::new(session))
    }

    #[cfg(target_os = "linux")]
    {
        let options = match kind {
            AudioCaptureKind::Microphone => {
                linux::LinuxAudioOptions::microphone(device_id, output_path)
                    .with_timeline_origin(timeline_origin.instant)
            }
            AudioCaptureKind::SystemLoopback => {
                linux::LinuxAudioOptions::system_monitor(device_id, output_path)
                    .with_timeline_origin(timeline_origin.instant)
            }
        };
        let session = linux::LinuxAudioCaptureSession::start(options)?;
        Ok(Box::new(session))
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let options = match kind {
            AudioCaptureKind::Microphone => {
                coreaudio::AudioCaptureOptions::microphone(device_id, output_path)
                    .with_timeline_origin(timeline_origin.instant)
            }
            AudioCaptureKind::SystemLoopback => {
                coreaudio::AudioCaptureOptions::system_loopback(device_id, output_path)
                    .with_timeline_origin(timeline_origin.instant)
            }
        };
        let session = coreaudio::CoreAudioCaptureSession::start(options)?;
        Ok(Box::new(session))
    }
}
