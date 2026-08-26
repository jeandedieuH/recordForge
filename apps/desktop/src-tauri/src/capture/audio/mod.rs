//! Audio capture subsystem for recordForge.
//!
//! Provides platform-native audio capture engines:
//! - Windows: Native WASAPI capture (microphone & loopback)
//! - macOS: Native CoreAudio capture & device enumeration
//! - Shared: WAV header, repair, duration alignment, and sample conversions

pub mod coreaudio;
pub mod wasapi;
pub mod wav;

pub use wav::{
    align_wav_to_duration, finalize_wav, frames_for_duration, loopback_packet_start_frames,
    repair_wav_header_if_needed, write_wav_header, AudioSampleFormat, DEFAULT_CHANNELS,
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

/// Cross-platform audio device enumeration.
pub fn enumerate_audio_devices() -> crate::errors::Result<Vec<AudioDeviceInfo>> {
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

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        coreaudio::enumerate_coreaudio_devices()
    }
}
