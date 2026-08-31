//! Shared WAV audio formatting, header writing, repair, and duration alignment.

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

use crate::capture::traits::AudioCaptureTiming;

pub const DEFAULT_SAMPLE_RATE: u32 = 48_000;
pub const DEFAULT_CHANNELS: u16 = 2;
pub const WAV_HEADER_SIZE: u64 = 44;
pub const SILENCE_CHUNK_FRAMES: usize = 4096;

/// Audio sample encoding format in WAV containers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSampleFormat {
    Pcm16,
    Float32,
}

impl AudioSampleFormat {
    pub fn bits_per_sample(self) -> u16 {
        match self {
            Self::Pcm16 => 16,
            Self::Float32 => 32,
        }
    }

    pub fn bytes_per_sample(self) -> u16 {
        self.bits_per_sample() / 8
    }

    pub fn wav_format_tag(self) -> u16 {
        match self {
            Self::Pcm16 => 1,
            Self::Float32 => 3,
        }
    }
}

/// Convert a duration to an integer frame count given the sample rate.
pub fn frames_for_duration(duration: Duration, sample_rate: u32) -> u64 {
    let frames = duration.as_nanos().saturating_mul(u128::from(sample_rate)) / 1_000_000_000;
    u64::try_from(frames).unwrap_or(u64::MAX)
}

/// Convert an integer frame count at the given sample rate to a duration.
pub fn frames_to_duration(frames: u64, sample_rate: u32) -> Duration {
    if sample_rate == 0 {
        return Duration::ZERO;
    }
    let nanos = (frames as u128)
        .saturating_mul(1_000_000_000)
        .checked_div(u128::from(sample_rate))
        .unwrap_or(u128::MAX);
    Duration::from_nanos(nanos.min(u64::MAX as u128) as u64)
}

/// Write standard 44-byte unfinalized RIFF/WAVE header.
pub fn write_wav_header(
    file: &mut std::fs::File,
    sample_rate: u32,
    channels: u16,
    sample_format: AudioSampleFormat,
) -> std::io::Result<()> {
    let block_align = channels
        .checked_mul(sample_format.bytes_per_sample())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "WAV block alignment overflow",
            )
        })?;
    let byte_rate = sample_rate
        .checked_mul(u32::from(block_align))
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "WAV byte rate overflow")
        })?;

    file.seek(SeekFrom::Start(0))?;
    file.write_all(b"RIFF")?;
    file.write_all(&0u32.to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&sample_format.wav_format_tag().to_le_bytes())?;
    file.write_all(&channels.to_le_bytes())?;
    file.write_all(&sample_rate.to_le_bytes())?;
    file.write_all(&byte_rate.to_le_bytes())?;
    file.write_all(&block_align.to_le_bytes())?;
    file.write_all(&sample_format.bits_per_sample().to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&0u32.to_le_bytes())?;
    Ok(())
}

/// Finalize a WAV file by patching the RIFF chunk size and data chunk size.
pub fn finalize_wav(file: &mut std::fs::File, data_bytes: u64) -> std::io::Result<u64> {
    let data_size = u32::try_from(data_bytes).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "WAV payload exceeds the 4 GB RIFF limit",
        )
    })?;
    let riff_size = 36u32.checked_add(data_size).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "WAV RIFF size overflow")
    })?;

    file.seek(SeekFrom::Start(4))?;
    file.write_all(&riff_size.to_le_bytes())?;
    file.seek(SeekFrom::Start(40))?;
    file.write_all(&data_size.to_le_bytes())?;
    file.flush()?;
    file.sync_all()?;
    Ok(data_bytes + WAV_HEADER_SIZE)
}

/// If an abruptly-interrupted WAV file has written audio data but its 44-byte
/// header still has zero RIFF and data chunk sizes, repair the header in-place
/// using the actual on-disk length.
pub fn repair_wav_header_if_needed(path: &Path) -> std::io::Result<u64> {
    if !path.is_file() {
        return Ok(0);
    }
    let metadata = std::fs::metadata(path)?;
    let file_len = metadata.len();
    if file_len < WAV_HEADER_SIZE {
        return Ok(0);
    }

    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let mut header = [0u8; WAV_HEADER_SIZE as usize];
    file.read_exact(&mut header)?;

    // Verify basic RIFF / WAVE / fmt / data magic
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" || &header[36..40] != b"data" {
        return Ok(0);
    }

    let current_data_size = u32::from_le_bytes([header[40], header[41], header[42], header[43]]);
    let actual_data_size = (file_len - WAV_HEADER_SIZE).min(u32::MAX as u64) as u32;

    if (current_data_size == 0 || current_data_size != actual_data_size) && actual_data_size > 0 {
        let riff_size = 36u32.saturating_add(actual_data_size);
        file.seek(SeekFrom::Start(4))?;
        file.write_all(&riff_size.to_le_bytes())?;
        file.seek(SeekFrom::Start(40))?;
        file.write_all(&actual_data_size.to_le_bytes())?;
        file.flush()?;
        let _ = file.sync_all();
        tracing::info!(
            path = %path.display(),
            actual_data_size,
            "repaired unfinalized WAV header from file length"
        );
    }

    Ok(file_len)
}

/// Parsed canonical 44-byte WAV header fields needed for timeline alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: AudioSampleFormat,
}

/// Read the canonical 44-byte RIFF/WAVE header written by `write_wav_header`.
///
/// Returns `Ok(None)` when the file is not a canonical PCM/float WAV this
/// module can align (wrong magic, unknown format tag, or a zero channel count
/// or sample rate). Callers treat that as "mux unaligned" rather than an error.
pub fn read_wav_format(path: &Path) -> std::io::Result<Option<WavFormat>> {
    let mut file = std::fs::File::open(path)?;
    let mut header = [0u8; WAV_HEADER_SIZE as usize];
    file.read_exact(&mut header)?;

    // Same magic checks as `repair_wav_header_if_needed`, plus the fmt chunk.
    if &header[0..4] != b"RIFF"
        || &header[8..12] != b"WAVE"
        || &header[12..16] != b"fmt "
        || &header[36..40] != b"data"
    {
        return Ok(None);
    }

    let format_tag = u16::from_le_bytes([header[20], header[21]]);
    let channels = u16::from_le_bytes([header[22], header[23]]);
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]);
    let bits_per_sample = u16::from_le_bytes([header[34], header[35]]);

    let sample_format = match format_tag {
        1 if bits_per_sample == AudioSampleFormat::Pcm16.bits_per_sample() => {
            AudioSampleFormat::Pcm16
        }
        3 if bits_per_sample == AudioSampleFormat::Float32.bits_per_sample() => {
            AudioSampleFormat::Float32
        }
        _ => return Ok(None),
    };
    if channels == 0 || sample_rate == 0 {
        return Ok(None);
    }

    Ok(Some(WavFormat {
        sample_rate,
        channels,
        sample_format,
    }))
}

/// Truncate a torn crash tail so the WAV payload is a whole number of audio
/// frames, patching the RIFF/data sizes, and return the aligned payload bytes.
///
/// `repair_wav_header_if_needed` sizes the header from the on-disk length,
/// which can include a partially written frame when the recording process
/// died mid-write; `align_wav_to_duration` requires a frame-aligned payload.
pub fn snap_wav_to_whole_frames(path: &Path, block_align: usize) -> std::io::Result<u64> {
    if block_align == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "WAV block alignment must be positive",
        ));
    }

    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < WAV_HEADER_SIZE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "WAV file is missing its header",
        ));
    }

    let data_bytes = file_len - WAV_HEADER_SIZE;
    let aligned_bytes = data_bytes - data_bytes % block_align as u64;
    if aligned_bytes != data_bytes {
        file.set_len(WAV_HEADER_SIZE + aligned_bytes)?;
        finalize_wav(&mut file, aligned_bytes)?;
        tracing::info!(
            path = %path.display(),
            dropped_bytes = data_bytes - aligned_bytes,
            "snapped torn WAV tail to whole audio frames"
        );
    }
    Ok(aligned_bytes)
}

/// Append zero-valued PCM silence frames to `file` until `target_frames` are written.
pub fn append_silence_until(
    file: &mut std::fs::File,
    data_bytes: &mut u64,
    target_frames: u64,
    block_align: usize,
) -> std::io::Result<()> {
    if block_align == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "WAV block alignment must be positive",
        ));
    }

    let current_frames = *data_bytes / block_align as u64;
    let mut remaining_frames = target_frames.saturating_sub(current_frames);
    if remaining_frames == 0 {
        return Ok(());
    }

    let silence_buffer_len = SILENCE_CHUNK_FRAMES
        .checked_mul(block_align)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "WAV silence buffer size overflow",
            )
        })?;
    let silence = vec![0u8; silence_buffer_len];

    while remaining_frames > 0 {
        let frames = remaining_frames.min(SILENCE_CHUNK_FRAMES as u64) as usize;
        let bytes = frames.checked_mul(block_align).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "WAV silence payload size overflow",
            )
        })?;
        file.write_all(&silence[..bytes])?;
        *data_bytes = data_bytes.checked_add(bytes as u64).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "WAV payload size overflow")
        })?;
        remaining_frames -= frames as u64;
    }

    Ok(())
}

/// Drop `head_frames` frames from the front of the WAV payload in place by
/// moving the remaining bytes over them.
pub fn trim_wav_head(
    file: &mut std::fs::File,
    current_bytes: &mut u64,
    head_frames: u64,
    block_align: usize,
) -> std::io::Result<()> {
    let head_bytes = head_frames.saturating_mul(block_align as u64);
    if head_bytes == 0 {
        return Ok(());
    }
    if head_bytes >= *current_bytes {
        file.set_len(WAV_HEADER_SIZE)?;
        *current_bytes = 0;
        return Ok(());
    }

    let mut buffer = vec![0u8; 64 * 1024];
    let data_start = WAV_HEADER_SIZE;
    let mut read_pos = data_start + head_bytes;
    let mut write_pos = data_start;
    let end = data_start + *current_bytes;
    while read_pos < end {
        let chunk = buffer.len().min((end - read_pos) as usize);
        file.seek(SeekFrom::Start(read_pos))?;
        file.read_exact(&mut buffer[..chunk])?;
        file.seek(SeekFrom::Start(write_pos))?;
        file.write_all(&buffer[..chunk])?;
        read_pos += chunk as u64;
        write_pos += chunk as u64;
    }
    file.set_len(data_start + (*current_bytes - head_bytes))?;
    *current_bytes -= head_bytes;
    Ok(())
}

/// Align a WAV track to match the segment's video timeline: trims `head_trim`
/// leading frames, then trims or silence-pads the duration to `duration`.
pub fn align_wav_to_duration(
    path: &Path,
    sample_rate: u32,
    channels: u16,
    sample_format: AudioSampleFormat,
    head_trim: Duration,
    duration: Duration,
) -> std::io::Result<u64> {
    if sample_rate == 0 || channels == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "WAV sample rate and channel count must be positive",
        ));
    }

    let block_align = usize::from(channels)
        .checked_mul(usize::from(sample_format.bytes_per_sample()))
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "WAV block alignment overflow",
            )
        })?;
    let target_frames = frames_for_duration(duration, sample_rate);
    let target_bytes = target_frames
        .checked_mul(block_align as u64)
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "WAV target size overflow")
        })?;
    u32::try_from(target_bytes).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "WAV target exceeds the 4 GB RIFF limit",
        )
    })?;

    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < WAV_HEADER_SIZE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "WAV file is missing its header",
        ));
    }

    let current_bytes = file_len - WAV_HEADER_SIZE;
    if !current_bytes.is_multiple_of(block_align as u64) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "WAV payload is not aligned to a complete audio frame",
        ));
    }

    let mut current_bytes = current_bytes;
    trim_wav_head(
        &mut file,
        &mut current_bytes,
        frames_for_duration(head_trim, sample_rate),
        block_align,
    )?;

    if target_bytes < current_bytes {
        file.set_len(WAV_HEADER_SIZE + target_bytes)?;
    } else if target_bytes > current_bytes {
        file.seek(SeekFrom::End(0))?;
        let mut data_bytes = current_bytes;
        append_silence_until(&mut file, &mut data_bytes, target_frames, block_align)?;
    }

    finalize_wav(&mut file, target_bytes)
}

/// Calculate the frame offset where a loopback packet should begin.
pub fn loopback_packet_start_frames(
    stream_offset_frames: u64,
    packet_index: u64,
    elapsed_frames: u64,
    frames_written: u64,
    sample_rate: u32,
) -> u64 {
    let wall_position = stream_offset_frames.saturating_add(elapsed_frames);
    let device_position = stream_offset_frames.saturating_add(packet_index);
    let max_plausible_gap = u64::from(sample_rate);
    let device_gap = device_position.saturating_sub(frames_written);
    let device_position_is_plausible = device_position >= frames_written
        && device_gap <= max_plausible_gap
        && device_position <= wall_position.saturating_add(max_plausible_gap);

    if device_position_is_plausible {
        wall_position.max(device_position)
    } else {
        wall_position
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioTimelineAlignment {
    pub sample_rate: u32,
    pub synthetic_leading_frames: u64,
    pub start_offset: Duration,
    pub source_duration: Duration,
    pub wall_duration: Duration,
    pub pts_scale: f64,
    pub head_trim: Duration,
    pub duration: Duration,
    pub drift_ms: i64,
}

pub fn compute_audio_timeline_alignment(
    timing: AudioCaptureTiming,
    head_trim: Duration,
    duration: Duration,
) -> Option<AudioTimelineAlignment> {
    const HNS_PER_SECOND: u128 = 10_000_000;
    const MAX_RATE_CORRECTION: f64 = 0.02;

    if timing.sample_rate == 0
        || timing.captured_frames == 0
        || timing.last_packet_frames == 0
        || timing.timestamp_errors > 0
        || timing.discontinuities > 0
        || duration.is_zero()
        || timing.first_packet_qpc_100ns < timing.timeline_origin_qpc_100ns
        || timing.last_packet_qpc_100ns < timing.first_packet_qpc_100ns
    {
        return None;
    }

    let frame_duration_hns = u128::from(timing.last_packet_frames)
        .saturating_mul(HNS_PER_SECOND)
        .checked_div(u128::from(timing.sample_rate))?;
    let packet_end_hns =
        u128::from(timing.last_packet_qpc_100ns).checked_add(frame_duration_hns)?;
    let wall_duration_hns =
        packet_end_hns.checked_sub(u128::from(timing.first_packet_qpc_100ns))?;
    let source_duration_hns = u128::from(timing.captured_frames)
        .saturating_mul(HNS_PER_SECOND)
        .checked_div(u128::from(timing.sample_rate))?;
    if wall_duration_hns == 0 || source_duration_hns == 0 {
        return None;
    }

    let pts_scale = wall_duration_hns as f64 / source_duration_hns as f64;
    if !pts_scale.is_finite() || (pts_scale - 1.0).abs() > MAX_RATE_CORRECTION {
        return None;
    }

    let start_offset_hns = timing
        .first_packet_qpc_100ns
        .checked_sub(timing.timeline_origin_qpc_100ns)?;
    let start_offset = duration_from_hns(u128::from(start_offset_hns))?;
    if start_offset > head_trim.saturating_add(duration) {
        return None;
    }

    let source_duration = duration_from_hns(source_duration_hns)?;
    let wall_duration = duration_from_hns(wall_duration_hns)?;
    let drift_hns = wall_duration_hns as i128 - source_duration_hns as i128;
    let drift_ms = i64::try_from(drift_hns / 10_000).ok()?;

    Some(AudioTimelineAlignment {
        sample_rate: timing.sample_rate,
        synthetic_leading_frames: timing.synthetic_leading_frames,
        start_offset,
        source_duration,
        wall_duration,
        pts_scale,
        head_trim,
        duration,
        drift_ms,
    })
}

fn duration_from_hns(hns: u128) -> Option<Duration> {
    let seconds = hns / 10_000_000;
    let nanos = (hns % 10_000_000).saturating_mul(100);
    Some(Duration::new(
        u64::try_from(seconds).ok()?,
        u32::try_from(nanos).ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_writes_and_finalizes_wav_header() {
        let directory = tempfile::tempdir().expect("create temp dir");
        let path = directory.path().join("test.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open wav");

        write_wav_header(&mut file, 48000, 2, AudioSampleFormat::Pcm16).expect("write header");
        let payload = vec![0x12u8; 19200]; // 19200 bytes = 0.1s of 48kHz stereo 16-bit PCM
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(&payload).unwrap();

        let total_size = finalize_wav(&mut file, payload.len() as u64).expect("finalize");
        assert_eq!(total_size, 19200 + 44);

        let mut read_file = std::fs::File::open(&path).unwrap();
        let mut header = [0u8; 44];
        read_file.read_exact(&mut header).unwrap();

        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(&header[8..12], b"WAVE");
        assert_eq!(&header[12..16], b"fmt ");
        assert_eq!(&header[36..40], b"data");

        let riff_size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let data_size = u32::from_le_bytes([header[40], header[41], header[42], header[43]]);
        assert_eq!(riff_size, 19200 + 36);
        assert_eq!(data_size, 19200);
    }

    #[test]
    fn test_repairs_unfinalized_wav_header() {
        let directory = tempfile::tempdir().expect("create temp dir");
        let path = directory.path().join("unfinalized.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open wav");

        write_wav_header(&mut file, 48000, 2, AudioSampleFormat::Pcm16).expect("write header");
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(&vec![0x7fu8; 1000]).unwrap();
        file.flush().unwrap();
        drop(file);

        let repaired_len = repair_wav_header_if_needed(&path).expect("repair header");
        assert_eq!(repaired_len, 1044);

        let mut read_file = std::fs::File::open(&path).unwrap();
        let mut header = [0u8; 44];
        read_file.read_exact(&mut header).unwrap();

        let riff_size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let data_size = u32::from_le_bytes([header[40], header[41], header[42], header[43]]);
        assert_eq!(data_size, 1000);
        assert_eq!(riff_size, 1036);
    }

    #[test]
    fn test_reads_wav_format_back_from_the_header() {
        let directory = tempfile::tempdir().expect("create temp dir");

        let pcm_path = directory.path().join("format_pcm.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&pcm_path)
            .expect("open wav");
        write_wav_header(&mut file, 48_000, 2, AudioSampleFormat::Pcm16).expect("write header");
        drop(file);
        assert_eq!(
            read_wav_format(&pcm_path).expect("read pcm format"),
            Some(WavFormat {
                sample_rate: 48_000,
                channels: 2,
                sample_format: AudioSampleFormat::Pcm16,
            })
        );

        let float_path = directory.path().join("format_float.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&float_path)
            .expect("open wav");
        write_wav_header(&mut file, 44_100, 1, AudioSampleFormat::Float32).expect("write header");
        drop(file);
        assert_eq!(
            read_wav_format(&float_path).expect("read float format"),
            Some(WavFormat {
                sample_rate: 44_100,
                channels: 1,
                sample_format: AudioSampleFormat::Float32,
            })
        );

        // An unknown format tag (e.g. a-law) cannot be aligned; readers get
        // None instead of an error so recovery can fall back to an unaligned mux.
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&pcm_path)
            .expect("open wav");
        file.seek(SeekFrom::Start(20)).expect("seek format tag");
        file.write_all(&6u16.to_le_bytes())
            .expect("patch format tag");
        drop(file);
        assert_eq!(
            read_wav_format(&pcm_path).expect("read patched format"),
            None
        );
    }

    #[test]
    fn test_read_wav_format_rejects_non_wav_files() {
        let directory = tempfile::tempdir().expect("create temp dir");
        let path = directory.path().join("not-a-wav.bin");
        std::fs::write(&path, vec![0u8; 64]).expect("write junk file");
        assert_eq!(read_wav_format(&path).expect("read junk"), None);
    }

    #[test]
    fn test_snap_wav_to_whole_frames_trims_a_torn_tail() {
        let directory = tempfile::tempdir().expect("create temp dir");
        let path = directory.path().join("torn.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open wav");
        write_wav_header(&mut file, 48_000, 2, AudioSampleFormat::Pcm16).expect("write header");
        // Stereo 16-bit: 4 bytes per frame. 1003 bytes = 250 frames + 3 torn bytes.
        file.seek(SeekFrom::End(0)).expect("seek end");
        file.write_all(&vec![0x11u8; 1_003])
            .expect("write torn payload");
        drop(file);

        let aligned_bytes = snap_wav_to_whole_frames(&path, 4).expect("snap torn wav");
        assert_eq!(aligned_bytes, 1_000);
        assert_eq!(
            std::fs::metadata(&path).expect("metadata").len(),
            1_000 + WAV_HEADER_SIZE
        );

        let mut read_file = std::fs::File::open(&path).unwrap();
        let mut header = [0u8; 44];
        read_file.read_exact(&mut header).unwrap();
        let data_size = u32::from_le_bytes([header[40], header[41], header[42], header[43]]);
        assert_eq!(data_size, 1_000);

        // An already aligned payload is left untouched.
        assert_eq!(
            snap_wav_to_whole_frames(&path, 4).expect("snap aligned wav"),
            1_000
        );
        assert_eq!(
            std::fs::metadata(&path).expect("metadata").len(),
            1_000 + WAV_HEADER_SIZE
        );
    }

    #[test]
    fn test_frames_to_duration_round_trips_frame_counts() {
        assert_eq!(
            frames_to_duration(216_000, 48_000),
            Duration::from_millis(4_500)
        );
        assert_eq!(frames_to_duration(0, 48_000), Duration::ZERO);
        assert_eq!(frames_to_duration(480, 0), Duration::ZERO);
        assert_eq!(
            frames_for_duration(frames_to_duration(24_000, 48_000), 48_000),
            24_000
        );
    }

    #[test]
    fn test_align_wav_to_duration_pads_silence() {
        let directory = tempfile::tempdir().expect("create temp dir");
        let path = directory.path().join("align_pad.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open wav");

        // 48kHz, 2 channels, 16-bit (4 bytes per frame).
        // 0.5 sec recorded = 24000 frames = 96000 bytes.
        write_wav_header(&mut file, 48000, 2, AudioSampleFormat::Pcm16).expect("write header");
        let initial_payload = vec![0x55u8; 96000];
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(&initial_payload).unwrap();
        finalize_wav(&mut file, 96000).unwrap();
        drop(file);

        // Align to 1.0 second duration (48000 frames = 192000 bytes) with 0 head trim.
        let final_size = align_wav_to_duration(
            &path,
            48000,
            2,
            AudioSampleFormat::Pcm16,
            Duration::ZERO,
            Duration::from_secs(1),
        )
        .expect("align wav");

        assert_eq!(final_size, 192000 + 44);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 192000 + 44);
    }

    #[test]
    fn test_align_wav_to_duration_trims_head_and_tail() {
        let directory = tempfile::tempdir().expect("create temp dir");
        let path = directory.path().join("align_trim.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open wav");

        // 48kHz, 2 channels, 16-bit (4 bytes per frame).
        // 2.0 sec recorded = 96000 frames = 384000 bytes.
        write_wav_header(&mut file, 48000, 2, AudioSampleFormat::Pcm16).expect("write header");
        let initial_payload = vec![0x42u8; 384000];
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(&initial_payload).unwrap();
        finalize_wav(&mut file, 384000).unwrap();
        drop(file);

        // Head trim: 0.5s (24000 frames = 96000 bytes). Target duration: 1.0s (48000 frames = 192000 bytes).
        let final_size = align_wav_to_duration(
            &path,
            48000,
            2,
            AudioSampleFormat::Pcm16,
            Duration::from_millis(500),
            Duration::from_secs(1),
        )
        .expect("align wav");

        assert_eq!(final_size, 192000 + 44);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 192000 + 44);
    }

    #[test]
    fn derives_audio_alignment_from_qpc_packet_timing() {
        let origin = 10_000_000_000;
        let first_packet = origin + 2_000_000;
        let timing = crate::capture::traits::AudioCaptureTiming {
            sample_rate: 48_000,
            synthetic_leading_frames: 9_600,
            captured_frames: 480_000,
            timeline_origin_qpc_100ns: origin,
            first_packet_qpc_100ns: first_packet,
            last_packet_qpc_100ns: first_packet + 100_900_000,
            last_packet_frames: 480,
            timestamp_errors: 0,
            discontinuities: 0,
        };

        let alignment = compute_audio_timeline_alignment(
            timing,
            Duration::from_millis(100),
            Duration::from_secs(10),
        )
        .expect("valid QPC alignment");

        assert_eq!(alignment.start_offset, Duration::from_millis(200));
        assert_eq!(alignment.source_duration, Duration::from_secs(10));
        assert_eq!(alignment.wall_duration, Duration::from_millis(10_100));
        assert!((alignment.pts_scale - 1.01).abs() < 0.000_001);
        assert_eq!(alignment.drift_ms, 100);
    }

    #[test]
    fn rejects_discontinuous_or_implausible_audio_alignment() {
        let origin = 20_000_000_000;
        let base = crate::capture::traits::AudioCaptureTiming {
            sample_rate: 48_000,
            synthetic_leading_frames: 4_800,
            captured_frames: 480_000,
            timeline_origin_qpc_100ns: origin,
            first_packet_qpc_100ns: origin + 1_000_000,
            last_packet_qpc_100ns: origin + 100_900_000,
            last_packet_frames: 480,
            timestamp_errors: 0,
            discontinuities: 0,
        };

        assert!(compute_audio_timeline_alignment(
            crate::capture::traits::AudioCaptureTiming {
                discontinuities: 1,
                ..base
            },
            Duration::ZERO,
            Duration::from_secs(10),
        )
        .is_none());
        assert!(compute_audio_timeline_alignment(
            crate::capture::traits::AudioCaptureTiming {
                timestamp_errors: 1,
                ..base
            },
            Duration::ZERO,
            Duration::from_secs(10),
        )
        .is_none());
        assert!(compute_audio_timeline_alignment(
            crate::capture::traits::AudioCaptureTiming {
                last_packet_qpc_100ns: origin + 109_900_000,
                ..base
            },
            Duration::ZERO,
            Duration::from_secs(10),
        )
        .is_none());
    }
}
