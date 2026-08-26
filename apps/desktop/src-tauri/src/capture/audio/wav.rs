//! Shared WAV audio formatting, header writing, repair, and duration alignment.

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

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
}
