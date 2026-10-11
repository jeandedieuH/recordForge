//! Word-level transcripts from whisper.cpp `-ojf` output.
//!
//! **Time base:** all times are in the recording asset's *container* timeline —
//! the same base timeline `AudioClip.sourceInMs/sourceOutMs` use (export does
//! `atrim=start=sourceIn:end=sourceOut` on the raw stream). The extraction
//! step pads streams that start after container zero (see
//! `whisper::extract_stream_transcribe_audio`) so WAV time == container time.
//!
//! With `--vad`, whisper v1.9.2 remaps *segment* offsets back to the original
//! timeline but leaves *token* offsets in the compressed (silence-removed)
//! timeline. `TokenTimeMap` applies whisper's own `vad_segment_info` table —
//! logged on stderr — to recover container-time token offsets.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::errors::{AppError, ErrorCategory, InternalError, Result};

/// Tauri event carrying `{jobId, phase, percent}` while a job runs.
pub const PROGRESS_EVENT: &str = "ai-captions-progress";

/// Phase strings emitted on [`PROGRESS_EVENT`].
pub const PHASE_PREPARING: &str = "preparing";
pub const PHASE_TRANSCRIBING: &str = "transcribing";
pub const PHASE_FINALIZING: &str = "finalizing";

const TRANSCRIPT_CACHE_VERSION: u32 = 1;
/// whisper token timestamps are model estimates; durations below this read as
/// flicker in karaoke-style captions, so words are stretched to a floor when
/// the segment has room for it.
const MIN_WORD_MS: u64 = 30;
/// `( ... )` runs with more inner words than this are kept as speech (a long
/// parenthetical is real text; a short one is a noise annotation).
const MAX_PAREN_RUN_WORDS: usize = 4;

/// One transcribed word in container time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    /// Trimmed token text with trailing punctuation attached. Never empty.
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    /// Whether a space precedes this word in the spoken text — false for the
    /// first word and for scripts without inter-word spaces (CJK, Thai, ...).
    pub space_before: bool,
    /// Mean whisper token probability (0..1) over the word's member tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

/// The `transcribe_audio` command result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// ISO-639 code detected by whisper (`result.language`) — never "auto".
    pub language: String,
    /// Model id that produced the transcript (e.g. "base").
    pub model: String,
    /// Absolute ffprobe index of the transcribed audio stream.
    pub stream_index: i32,
    /// Duration of the extracted WAV — container length plus any leading pad.
    pub duration_ms: u64,
    pub words: Vec<TranscriptWord>,
    /// True when served from the on-disk transcript cache.
    pub cached: bool,
}

/// The parsed part of a whisper `-ojf` file before command-level fields
/// (model, stream, cache flag) are attached.
pub struct ParsedTranscript {
    pub language: String,
    pub words: Vec<TranscriptWord>,
}

/// Error returned when `cancel_transcription` wins the race.
pub fn transcription_cancelled() -> AppError {
    AppError::new(
        ErrorCategory::Media,
        "transcription_cancelled",
        "Transcription cancelled",
    )
}

/// In-flight transcription jobs. At most one runs at a time — registration is
/// the busy gate, and each job carries the cancel flag plus the running
/// whisper child so `cancel_transcription` can kill it.
#[derive(Debug, Default)]
pub struct TranscriptionRegistry {
    jobs: Mutex<HashMap<String, Arc<TranscriptionJob>>>,
}

/// One running transcription: a cancel flag and (once spawned) the whisper
/// child handle used for `kill()`.
#[derive(Debug)]
pub struct TranscriptionJob {
    cancelled: AtomicBool,
    child: Mutex<Option<std::process::Child>>,
}

/// RAII handle that keeps a job registered; dropping it frees the busy gate
/// on every exit path — success, error, cancel, or panic.
#[derive(Debug)]
pub struct TranscriptionRegistration {
    registry: Arc<TranscriptionRegistry>,
    job_id: String,
    job: Arc<TranscriptionJob>,
}

impl TranscriptionRegistry {
    /// Register a new job. Fails with `transcription_busy` while any other job
    /// is registered — transcription is a single-slot operation.
    pub fn begin(self: &Arc<Self>, job_id: &str) -> Result<TranscriptionRegistration> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| InternalError::Media("transcription registry unavailable".into()))?;
        if !jobs.is_empty() {
            return Err(AppError::new(
                ErrorCategory::Media,
                "transcription_busy",
                "A transcription is already running. Wait for it to finish, or cancel it first.",
            ));
        }
        let job = Arc::new(TranscriptionJob {
            cancelled: AtomicBool::new(false),
            child: Mutex::new(None),
        });
        jobs.insert(job_id.to_string(), Arc::clone(&job));
        Ok(TranscriptionRegistration {
            registry: Arc::clone(self),
            job_id: job_id.to_string(),
            job,
        })
    }

    /// Mark a job cancelled and kill its whisper child if one is running.
    /// Unknown or finished jobs are a no-op.
    pub fn cancel(&self, job_id: &str) {
        let job = self
            .jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(job_id).cloned());
        if let Some(job) = job {
            job.cancel();
        }
    }

    fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(job_id);
        }
    }
}

impl TranscriptionJob {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        if let Ok(mut slot) = self.child.lock() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
            }
        }
    }

    /// Hand the spawned whisper child to the job. If `cancel` raced the spawn,
    /// the child is killed immediately so the wait loop can't block on an
    /// already-cancelled job.
    pub fn set_child(&self, child: std::process::Child) {
        if let Ok(mut slot) = self.child.lock() {
            *slot = Some(child);
            if self.is_cancelled() {
                if let Some(child) = slot.as_mut() {
                    let _ = child.kill();
                }
            }
        }
    }

    /// Poll the child without holding the lock — `cancel` must always be able
    /// to reach `kill()` between polls.
    pub fn try_wait(&self) -> Result<Option<std::process::ExitStatus>> {
        let mut slot = self
            .child
            .lock()
            .map_err(|_| InternalError::Media("transcription child lock unavailable".into()))?;
        match slot.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(|e| InternalError::Media(format!("whisper wait: {e}")).into()),
            None => Err(InternalError::Media("whisper process was not started".into()).into()),
        }
    }
}

impl TranscriptionRegistration {
    pub fn job(&self) -> &Arc<TranscriptionJob> {
        &self.job
    }
}

impl Drop for TranscriptionRegistration {
    fn drop(&mut self) {
        self.registry.finish(&self.job_id);
    }
}

/// One contiguous VAD speech region. `[vad_start_ms, vad_end_ms]` is the range
/// in the compressed stream whisper actually transcribed; it maps linearly to
/// `[orig_start_ms, orig_end_ms]` on the recording timeline.
#[derive(Debug, Clone, Copy)]
pub struct VadSegment {
    pub orig_start_ms: u64,
    pub orig_end_ms: u64,
    pub vad_start_ms: u64,
    pub vad_end_ms: u64,
}

/// Maps `-ojf` token offsets to the recording's container timeline.
pub enum TokenTimeMap {
    /// No VAD — token offsets are already container time.
    Identity,
    /// VAD ran — piecewise map built from the `vad_segment_info` table whisper
    /// logs on stderr while loading segments (verified against v1.9.2).
    Vad(Vec<VadSegment>),
    /// VAD ran but no mapping table was captured — degrade to aligning each
    /// segment's first timed token with the segment's own (already remapped)
    /// start. Word order and rough placement stay correct.
    VadUnmapped,
}

impl TokenTimeMap {
    fn map_ms(&self, ms: u64) -> u64 {
        let TokenTimeMap::Vad(segments) = self else {
            return ms;
        };
        for segment in segments {
            if ms >= segment.vad_start_ms && ms <= segment.vad_end_ms {
                let vad_span = segment.vad_end_ms - segment.vad_start_ms;
                if vad_span == 0 {
                    return segment.orig_start_ms;
                }
                let orig_span = segment.orig_end_ms - segment.orig_start_ms;
                let offset = (ms - segment.vad_start_ms).saturating_mul(orig_span) / vad_span;
                return segment.orig_start_ms + offset;
            }
        }
        // Between speech regions (padding whisper trimmed): clamp to the
        // nearest mapped boundary so token order is preserved.
        let mut best_ms = ms;
        let mut best_dist = u64::MAX;
        for segment in segments {
            for (bound, mapped) in [
                (segment.vad_start_ms, segment.orig_start_ms),
                (segment.vad_end_ms, segment.orig_end_ms),
            ] {
                let dist = ms.abs_diff(bound);
                if dist < best_dist {
                    best_dist = dist;
                    best_ms = mapped;
                }
            }
        }
        best_ms
    }
}

#[derive(Debug, Deserialize)]
struct JsonTranscript {
    #[serde(default)]
    result: JsonResult,
    #[serde(default)]
    transcription: Vec<JsonSegment>,
}

#[derive(Debug, Default, Deserialize)]
struct JsonResult {
    #[serde(default)]
    language: String,
}

#[derive(Debug, Deserialize)]
struct JsonSegment {
    #[serde(default)]
    offsets: JsonOffsets,
    #[serde(default)]
    tokens: Vec<JsonToken>,
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
struct JsonOffsets {
    #[serde(default)]
    from: f64,
    #[serde(default)]
    to: f64,
}

#[derive(Debug, Deserialize)]
struct JsonToken {
    #[serde(default)]
    text: String,
    #[serde(default)]
    offsets: Option<JsonOffsets>,
    #[serde(default)]
    p: Option<f32>,
}

/// Parse a whisper `-ojf` JSON file into a language code + word list.
/// `language_fallback` is the request language used when the JSON carries no
/// `result.language` (never returns "auto").
pub fn parse_transcript_json(
    content: &str,
    token_map: &TokenTimeMap,
    language_fallback: &str,
) -> Result<ParsedTranscript> {
    let root: JsonTranscript = serde_json::from_str(content)
        .map_err(|e| InternalError::Media(format!("could not read transcription output: {e}")))?;
    let language = if root.result.language.trim().is_empty() {
        match language_fallback {
            "" | "auto" => "und".to_string(),
            other => other.to_string(),
        }
    } else {
        root.result.language.trim().to_string()
    };

    let mut words = Vec::new();
    let mut prev_end = 0u64;
    for segment in &root.transcription {
        let seg_from = segment.offsets.from.max(0.0).round() as u64;
        let seg_to = segment.offsets.to.max(0.0).round() as u64;
        let (seg_from, seg_to) = (seg_from.min(seg_to), seg_from.max(seg_to));

        let tokens = filter_speech_tokens(&segment.tokens);
        if tokens.is_empty() {
            continue;
        }
        let times = token_times(&tokens, seg_from, seg_to, token_map);
        let mut segment_words = build_segment_words(&tokens, &times);
        finalize_segment_words(&mut segment_words, seg_from, seg_to, &mut prev_end);
        words.extend(segment_words);
    }

    Ok(ParsedTranscript { language, words })
}

/// Drop non-speech tokens: whisper specials (`[_BEG_]`, `[_TT_150]`, and the
/// angle-bracket-pipe control family), `[ ... ]` annotation runs, `( ... )`
/// runs whose inner text is at most a few words, and music-symbol tokens.
fn filter_speech_tokens(tokens: &[JsonToken]) -> Vec<&JsonToken> {
    let mut kept = Vec::new();
    let mut in_bracket_run = false;
    let mut paren_run: Vec<&JsonToken> = Vec::new();

    for token in tokens {
        let text = token.text.as_str();
        if is_special_token(text) {
            continue;
        }
        if in_bracket_run {
            if text.contains(']') {
                in_bracket_run = false;
            }
            continue;
        }
        if !paren_run.is_empty() {
            paren_run.push(token);
            if text.contains(')') {
                if paren_inner_word_count(&paren_run) > MAX_PAREN_RUN_WORDS {
                    kept.append(&mut paren_run);
                } else {
                    paren_run.clear();
                }
            }
            continue;
        }
        if text.contains('[') {
            // Self-contained or multi-token annotation — dropped either way.
            in_bracket_run = !text.contains(']');
            continue;
        }
        if text.contains('(') {
            if text.contains(')') {
                if paren_inner_word_count(&[token]) <= MAX_PAREN_RUN_WORDS {
                    continue;
                }
                kept.push(token);
            } else {
                paren_run.push(token);
            }
            continue;
        }
        if is_music_token(text) {
            continue;
        }
        kept.push(token);
    }
    kept
}

fn is_special_token(text: &str) -> bool {
    let trimmed = text.trim_start();
    (trimmed.starts_with("[_") && trimmed.ends_with(']')) || trimmed.starts_with(['<', '|'])
}

/// Tokens that are only music notation symbols (♪ ♫ #).
fn is_music_token(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && trimmed.chars().all(|c| matches!(c, '♪' | '♫' | '#'))
}

/// Words inside a `( ... )` run — punctuation-only fragments don't count.
fn paren_inner_word_count(run: &[&JsonToken]) -> usize {
    let text: String = run.iter().map(|t| t.text.as_str()).collect();
    text.split_whitespace()
        .filter(|word| word.chars().any(|c| c.is_alphanumeric()))
        .count()
}

/// Scripts without inter-word spaces: every token is its own word.
fn is_spaceless_char(c: char) -> bool {
    matches!(c,
        '\u{3040}'..='\u{30FF}'   // Hiragana + Katakana
        | '\u{3400}'..='\u{4DBF}' // CJK Extension A
        | '\u{4E00}'..='\u{9FFF}' // CJK Unified Ideographs
        | '\u{F900}'..='\u{FAFF}' // CJK Compatibility Ideographs
        | '\u{0E00}'..='\u{0E7F}' // Thai
        | '\u{0E80}'..='\u{0EFF}' // Lao
        | '\u{1780}'..='\u{17FF}' // Khmer
        | '\u{1000}'..='\u{109F}' // Myanmar
    )
}

fn is_punctuation_char(c: char) -> bool {
    c.is_ascii_punctuation()
        || matches!(
            c,
            '…' | '。'
                | '、'
                | '，'
                | '？'
                | '！'
                | '：'
                | '；'
                | '．'
                | '｡'
                | '・'
                | '‘'
                | '’'
                | '“'
                | '”'
                | '«'
                | '»'
                | '‹'
                | '›'
                | '「'
                | '」'
                | '『'
                | '』'
                | '【'
                | '】'
                | '〈'
                | '〉'
                | '《'
                | '》'
                | '—'
                | '–'
                | '―'
        )
}

/// Tokens like `,`, `.`, `%.`, `"` attach to the preceding word.
fn is_punctuation_token(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && trimmed.chars().all(is_punctuation_char)
}

/// Resolve (start, end) for every kept token of one segment: real offsets
/// remapped to container time, missing ones linearly interpolated between the
/// nearest timed neighbours inside the segment.
fn token_times(
    tokens: &[&JsonToken],
    seg_from: u64,
    seg_to: u64,
    token_map: &TokenTimeMap,
) -> Vec<(u64, u64)> {
    let mut times: Vec<Option<(u64, u64)>> = tokens
        .iter()
        .map(|token| {
            token
                .offsets
                // A 0/0 offset pair is a timestamp placeholder, not a time.
                .filter(|o| !(o.from == 0.0 && o.to == 0.0))
                .map(|o| {
                    (
                        token_map.map_ms(o.from.max(0.0).round() as u64),
                        token_map.map_ms(o.to.max(0.0).round() as u64),
                    )
                })
        })
        .collect();

    // VAD ran but no remap table was captured: shift the segment's tokens so
    // the first timed one lands on the (already original-time) segment start.
    if matches!(token_map, TokenTimeMap::VadUnmapped) {
        if let Some((first_from, _)) = times.iter().flatten().next() {
            let shift = seg_from as i64 - *first_from as i64;
            for slot in times.iter_mut().flatten() {
                slot.0 = (slot.0 as i64 + shift).max(0) as u64;
                slot.1 = (slot.1 as i64 + shift).max(0) as u64;
            }
        }
    }

    // Interpolate untimed tokens between their nearest timed neighbours; the
    // segment bounds are the anchors at the edges.
    let mut index = 0;
    while index < times.len() {
        if times[index].is_some() {
            index += 1;
            continue;
        }
        let run_start = index;
        while index < times.len() && times[index].is_none() {
            index += 1;
        }
        let run_len = index - run_start;
        let anchor_lo = run_start
            .checked_sub(1)
            .and_then(|prev| times[prev])
            .map(|(_, end)| end)
            .unwrap_or(seg_from);
        let anchor_hi = times[index]
            .map(|(start, _)| start)
            .unwrap_or(seg_to)
            .max(anchor_lo);
        let step = (anchor_hi - anchor_lo) / (run_len as u64 + 1);
        for (offset, slot) in times[run_start..index].iter_mut().enumerate() {
            let start = anchor_lo + step * (offset as u64 + 1);
            *slot = Some((start, start + step));
        }
    }

    times
        .into_iter()
        .map(|slot| slot.unwrap_or((seg_from, seg_from)))
        .collect()
}

/// Group filtered tokens into words. A token starting with whitespace begins
/// a new word; punctuation-only tokens extend the previous word; tokens in
/// spaceless scripts are single-token words. Words never span segments.
fn build_segment_words(tokens: &[&JsonToken], times: &[(u64, u64)]) -> Vec<TranscriptWord> {
    struct Acc {
        text: String,
        start_ms: u64,
        end_ms: u64,
        space_before: bool,
        ps: Vec<f32>,
    }
    impl Acc {
        fn finish(self) -> TranscriptWord {
            TranscriptWord {
                text: self.text,
                start_ms: self.start_ms,
                end_ms: self.end_ms,
                space_before: self.space_before,
                confidence: if self.ps.is_empty() {
                    None
                } else {
                    Some(self.ps.iter().sum::<f32>() / self.ps.len() as f32)
                },
            }
        }
    }

    let mut words: Vec<TranscriptWord> = Vec::new();
    let mut current: Option<Acc> = None;
    for (token, (start, end)) in tokens.iter().zip(times.iter()) {
        let raw = token.text.as_str();
        let text = raw.trim();
        if text.is_empty() {
            continue;
        }
        if is_punctuation_token(raw) {
            if let Some(acc) = current.as_mut() {
                acc.text.push_str(text);
                acc.end_ms = acc.end_ms.max(*end);
                if let Some(p) = token.p {
                    acc.ps.push(p);
                }
            } else if let Some(last) = words.last_mut() {
                // Punctuation right after a single-token (spaceless-script)
                // word attaches to it too.
                last.text.push_str(text);
                last.end_ms = last.end_ms.max(*end);
            }
            continue;
        }
        if text.chars().any(is_spaceless_char) {
            if let Some(acc) = current.take() {
                words.push(acc.finish());
            }
            words.push(TranscriptWord {
                text: text.to_string(),
                start_ms: *start,
                end_ms: *end,
                space_before: false,
                confidence: token.p,
            });
            continue;
        }
        let leads_with_space = raw.chars().next().is_some_and(|c| c.is_whitespace());
        if leads_with_space || current.is_none() {
            if let Some(acc) = current.take() {
                words.push(acc.finish());
            }
            current = Some(Acc {
                text: String::new(),
                start_ms: *start,
                end_ms: *end,
                space_before: leads_with_space && !words.is_empty(),
                ps: Vec::new(),
            });
        }
        if let Some(acc) = current.as_mut() {
            acc.text.push_str(text);
            acc.end_ms = acc.end_ms.max(*end);
            if let Some(p) = token.p {
                acc.ps.push(p);
            }
        }
    }
    if let Some(acc) = current.take() {
        words.push(acc.finish());
    }
    words
}

/// Clamp each word into its segment, force monotonic non-decreasing times,
/// and stretch durations up to `MIN_WORD_MS` where the segment has room —
/// `prev_end` carries across segments so words never overlap globally.
fn finalize_segment_words(
    words: &mut [TranscriptWord],
    seg_from: u64,
    seg_to: u64,
    prev_end: &mut u64,
) {
    for word in words.iter_mut() {
        let start = word.start_ms.clamp(seg_from, seg_to).max(*prev_end);
        // `prev_end` can sit beyond this segment when source segments overlap:
        // clamp(start, seg_to) would panic, so the word keeps prev_end as its
        // start and only the duration floor applies past the segment end.
        let raw_end = word.end_ms.max(start);
        let end = if start > seg_to {
            raw_end.max(start + MIN_WORD_MS)
        } else {
            let clamped = raw_end.min(seg_to);
            if clamped - start < MIN_WORD_MS && seg_to - start >= MIN_WORD_MS {
                start + MIN_WORD_MS
            } else {
                clamped
            }
        };
        word.start_ms = start;
        word.end_ms = end;
        *prev_end = end;
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptCacheFile {
    version: u32,
    source_len: u64,
    source_modified_ms: u64,
    transcript: Transcript,
}

/// `<work_dir>/transcripts/<model>-<language>-s<stream>.json` — the cache key
/// uses the *requested* language ("auto" stays "auto").
pub fn cache_path(work_dir: &Path, model: &str, language: &str, stream_index: i32) -> PathBuf {
    work_dir
        .join("transcripts")
        .join(format!("{model}-{language}-s{stream_index}.json"))
}

/// Read a cached transcript when the header still matches the source file.
/// Any read/parse/mismatch problem silently recomputes.
pub fn read_cached(path: &Path, source_len: u64, source_modified_ms: u64) -> Option<Transcript> {
    let content = std::fs::read_to_string(path).ok()?;
    let file: TranscriptCacheFile = serde_json::from_str(&content).ok()?;
    if file.version != TRANSCRIPT_CACHE_VERSION {
        return None;
    }
    if file.source_len != source_len || file.source_modified_ms != source_modified_ms {
        return None;
    }
    Some(file.transcript)
}

/// Persist a transcript next to the recording's work files — temp file +
/// atomic rename so a crash mid-write never presents a corrupt cache.
pub fn write_cache(
    path: &Path,
    source_len: u64,
    source_modified_ms: u64,
    transcript: &Transcript,
) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| InternalError::Storage(format!("create transcript cache dir: {e}")))?;
    }
    let payload = serde_json::to_string(&TranscriptCacheFile {
        version: TRANSCRIPT_CACHE_VERSION,
        source_len,
        source_modified_ms,
        transcript: transcript.clone(),
    })
    .map_err(|e| InternalError::Storage(format!("serialize transcript cache: {e}")))?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, payload)
        .map_err(|e| InternalError::Storage(format!("write transcript cache: {e}")))?;
    crate::capture::disk::atomic_replace(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(text: &str, from: i64, to: i64, p: f32) -> serde_json::Value {
        serde_json::json!({
            "text": text,
            "timestamps": {"from": "00:00:00,000", "to": "00:00:00,000"},
            "offsets": {"from": from, "to": to},
            "id": 1,
            "p": p,
            "t_dtw": -1
        })
    }

    fn segment(tokens: serde_json::Value, from: i64, to: i64) -> serde_json::Value {
        serde_json::json!({
            "timestamps": {"from": "00:00:00,000", "to": "00:00:00,000"},
            "offsets": {"from": from, "to": to},
            "text": "",
            "tokens": tokens
        })
    }

    fn parse(json: serde_json::Value) -> ParsedTranscript {
        parse_transcript_json(
            &serde_json::to_string(&json).unwrap(),
            &TokenTimeMap::Identity,
            "auto",
        )
        .unwrap()
    }

    #[test]
    fn builds_words_from_real_shapes() {
        let json = serde_json::json!({
            "result": {"language": "en"},
            "transcription": [
                segment(serde_json::json!([
                    token("[_BEG_]", 0, 0, 0.9),
                    token(" Welcome", 120, 520, 0.9),
                    token(" to", 520, 630, 0.9),
                    token(" Record", 630, 940, 0.8),
                    token(" For", 1060, 1250, 0.7),
                    token("ge", 1260, 1370, 0.9),
                    token(",", 1640, 1640, 0.9),
                    token(" the", 1680, 1750, 0.9),
                    token(" easiest", 1760, 2200, 0.9),
                    token(" way", 2210, 2400, 0.9),
                    token(".", 4770, 4800, 0.9),
                    token("[_TT_240]", 4800, 4800, 0.9),
                ]), 0, 4800),
                segment(serde_json::json!([
                    token("[_BEG_]", 0, 0, 0.9),
                    token(" In", 4920, 5130, 0.9),
                    token(" 20", 5130, 5620, 0.8),
                    token("26", 5720, 6150, 0.9),
                    token(",", 6150, 6320, 0.9),
                    token(" we", 6320, 6340, 0.9),
                    token("[_TT_596]", 11920, 11920, 0.9),
                ]), 4800, 11920),
            ]
        });
        let parsed = parse(json);
        assert_eq!(parsed.language, "en");
        let texts: Vec<&str> = parsed.words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(
            texts,
            ["Welcome", "to", "Record", "Forge,", "the", "easiest", "way.", "In", "2026,", "we"]
        );
        // First word has no space_before; spaced tokens after it do.
        assert!(!parsed.words[0].space_before);
        assert!(parsed.words[1].space_before);
        // "Forge," merged three tokens incl. attached comma.
        let forge = &parsed.words[3];
        assert_eq!((forge.start_ms, forge.end_ms), (1060, 1640));
        // Attached punctuation extends the word end.
        assert_eq!(parsed.words[6].end_ms, 4800);
        // Confidence is the mean of member token probabilities.
        let forge_p = (0.7f32 + 0.9 + 0.9) / 3.0;
        assert!((forge.confidence.unwrap() - forge_p).abs() < 0.001);
        // Monotonic across segments.
        assert!(parsed.words[8].start_ms >= parsed.words[7].end_ms);
    }

    /// Trimmed real whisper-cli v1.9.2 `-ojf` output (base model, TTS input).
    #[test]
    fn parses_real_ojf_output() {
        let parsed = parse_transcript_json(
            include_str!("testdata/whisper-ojf-sample.json"),
            &TokenTimeMap::Identity,
            "auto",
        )
        .unwrap();
        assert_eq!(parsed.language, "en");
        let texts: Vec<&str> = parsed.words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "Welcome",
                "to",
                "Record",
                "Forge,",
                "The",
                "Easiest",
                "Way",
                "To",
                "Record",
                "Your",
                "Screen.",
                "In",
                "2026,",
                "we",
                "shipped",
                "42",
                "new",
                "features."
            ]
        );
        for word in &parsed.words {
            assert!(!word.text.is_empty());
            assert!(word.end_ms >= word.start_ms);
            assert!(word.confidence.unwrap() > 0.0);
        }
        // Monotonic non-decreasing with no overlaps.
        for pair in parsed.words.windows(2) {
            assert!(pair[1].start_ms >= pair[0].end_ms);
        }
        assert_eq!(parsed.words[0].start_ms, 120);
        assert!(!parsed.words[0].space_before);
    }

    #[test]
    fn drops_annotations_and_keeps_long_parentheticals() {
        let json = serde_json::json!({
            "result": {"language": "en"},
            "transcription": [segment(serde_json::json!([
                token("[_BEG_]", 0, 0, 0.9),
                token(" Hello", 100, 500, 0.9),
                token(" [BLANK_AUDIO]", 500, 3000, 0.9),
                token(" world", 3100, 3500, 0.9),
                token(" [", 3500, 3600, 0.9),
                token("MUSIC", 3600, 3700, 0.9),
                token("]", 3700, 3800, 0.9),
                token(" again", 3900, 4300, 0.9),
                token(" (", 4300, 4400, 0.9),
                token("applause", 4400, 4600, 0.9),
                token(")", 4600, 4700, 0.9),
                token(" yes", 4800, 5100, 0.9),
                token(" ♪", 5100, 5200, 0.9),
                token(" (", 5200, 5300, 0.9),
                token("and", 5300, 5400, 0.9),
                token(" this", 5400, 5500, 0.9),
                token(" was", 5500, 5600, 0.9),
                token(" a", 5600, 5650, 0.9),
                token(" real", 5650, 5800, 0.9),
                token(" aside", 5800, 6100, 0.9),
                token(")", 6100, 6200, 0.9),
                token(" done", 6300, 6600, 0.9),
            ]), 0, 7000)]
        });
        let parsed = parse(json);
        let texts: Vec<&str> = parsed.words.iter().map(|w| w.text.as_str()).collect();
        // [BLANK_AUDIO] inline, a split-token [MUSIC] run, and a 1-word
        // (applause) run are dropped; the 6-word parenthetical is kept — its
        // parens attach as punctuation to the neighbouring words.
        assert_eq!(
            texts,
            ["Hello", "world", "again", "yes(and", "this", "was", "a", "real", "aside)", "done"]
        );
    }

    #[test]
    fn spaceless_scripts_get_one_word_per_token() {
        let json = serde_json::json!({
            "result": {"language": "ja"},
            "transcription": [segment(serde_json::json!([
                token("こんにちは", 100, 600, 0.9),
                token("、", 600, 700, 0.9),
                token("世界", 700, 1100, 0.9),
                token("です", 1100, 1400, 0.9),
            ]), 0, 2000)]
        });
        let parsed = parse(json);
        let texts: Vec<&str> = parsed.words.iter().map(|w| w.text.as_str()).collect();
        // CJK punctuation attaches; every CJK token is its own word.
        assert_eq!(texts, ["こんにちは、", "世界", "です"]);
        assert!(parsed.words.iter().all(|w| !w.space_before));
    }

    #[test]
    fn interpolates_missing_offsets_inside_segment() {
        let mut timed_a = token(" Hello", 100, 500, 0.9);
        let untimed = serde_json::json!({"text": " brave", "p": 0.8});
        let untimed2 = serde_json::json!({"text": " new", "p": 0.8});
        let timed_b = token(" world", 2000, 2600, 0.9);
        timed_a.as_object_mut().unwrap().remove("timestamps");
        let json = serde_json::json!({
            "result": {"language": "en"},
            "transcription": [segment(
                serde_json::json!([timed_a, untimed, untimed2, timed_b]), 0, 5000)]
        });
        let parsed = parse(json);
        let texts: Vec<&str> = parsed.words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["Hello", "brave", "new", "world"]);
        // 2 untimed tokens share the 500..2000 gap evenly.
        assert_eq!(parsed.words[1].start_ms, 1000);
        assert_eq!(parsed.words[2].start_ms, 1500);
        assert_eq!(parsed.words[3].start_ms, 2000);
    }

    #[test]
    fn clamps_words_into_segment_and_enforces_minimum() {
        let json = serde_json::json!({
            "result": {"language": "en"},
            "transcription": [segment(serde_json::json!([
                // Token times before the segment and zero-length.
                token(" Early", 0, 0, 0.9),
                token(" word", 500, 500, 0.9),
            ]), 1000, 3000)]
        });
        let parsed = parse(json);
        // "Early" clamps to the segment start; both stretch to 30 ms.
        assert_eq!(parsed.words[0].start_ms, 1000);
        assert_eq!(parsed.words[0].end_ms, 1030);
        assert_eq!(parsed.words[1].end_ms - parsed.words[1].start_ms, 30);
        assert!(parsed.words[1].start_ms >= parsed.words[0].end_ms);
    }

    #[test]
    fn vad_map_remaps_and_clamps_between_regions() {
        let map = TokenTimeMap::Vad(vec![
            VadSegment {
                orig_start_ms: 2590,
                orig_end_ms: 4060,
                vad_start_ms: 0,
                vad_end_ms: 1470,
            },
            VadSegment {
                orig_start_ms: 4420,
                orig_end_ms: 6400,
                vad_start_ms: 1670,
                vad_end_ms: 3650,
            },
        ]);
        // Inside region 1 — ~1:1 with the orig offset.
        assert_eq!(map.map_ms(30), 2620);
        assert_eq!(map.map_ms(1470), 4060);
        // Between regions: clamps to the nearest boundary.
        assert_eq!(map.map_ms(1570), 4060);
        assert_eq!(map.map_ms(1600), 4420);
        assert_eq!(map.map_ms(3650), 6400);
    }

    #[test]
    fn overlapping_segments_never_panic_or_underflow() {
        // Segment 2 ends BEFORE the last word of segment 1 — the previous
        // word's stretched end (5990) sits past seg 2's 5800 bound.
        let json = serde_json::json!({
            "result": {"language": "en"},
            "transcription": [
                segment(serde_json::json!([token(" Long", 5400, 5960, 0.9)]), 0, 6000),
                segment(serde_json::json!([
                    token(" Late", 5600, 5750, 0.9),
                    token(" word", 5750, 5790, 0.9),
                ]), 5500, 5800),
            ]
        });
        let parsed = parse(json);
        assert_eq!(parsed.words.len(), 3);
        // First word is already past the floor: 5400..5960.
        assert_eq!(
            (parsed.words[0].start_ms, parsed.words[0].end_ms),
            (5400, 5960)
        );
        // Next words keep prev_end as start and take the 30 ms floor even
        // though their segment ended at 5800 — monotonic, no panic, no wrap.
        assert_eq!(
            (parsed.words[1].start_ms, parsed.words[1].end_ms),
            (5960, 5990)
        );
        assert_eq!(
            (parsed.words[2].start_ms, parsed.words[2].end_ms),
            (5990, 6020)
        );
    }

    #[test]
    fn language_falls_back_without_going_auto() {
        let json = serde_json::json!({
            "result": {"language": ""},
            "transcription": []
        });
        let parsed = parse_transcript_json(
            &serde_json::to_string(&json).unwrap(),
            &TokenTimeMap::Identity,
            "auto",
        )
        .unwrap();
        assert_eq!(parsed.language, "und");
        let parsed = parse_transcript_json(
            &serde_json::to_string(&json).unwrap(),
            &TokenTimeMap::Identity,
            "de",
        )
        .unwrap();
        assert_eq!(parsed.language, "de");
    }

    #[test]
    fn cache_round_trips_and_invalidates() {
        let dir = tempfile::tempdir().unwrap();
        let path = cache_path(dir.path(), "base", "auto", 1);
        let transcript = Transcript {
            language: "en".to_string(),
            model: "base".to_string(),
            stream_index: 1,
            duration_ms: 5000,
            words: vec![TranscriptWord {
                text: "Hello".to_string(),
                start_ms: 0,
                end_ms: 500,
                space_before: false,
                confidence: Some(0.9),
            }],
            cached: false,
        };
        assert!(read_cached(&path, 100, 200).is_none());
        write_cache(&path, 100, 200, &transcript).unwrap();
        let hit = read_cached(&path, 100, 200).expect("cache hit");
        assert_eq!(hit.words[0].text, "Hello");
        // Changed source fingerprint or corrupt file => recompute.
        assert!(read_cached(&path, 101, 200).is_none());
        assert!(read_cached(&path, 100, 201).is_none());
        std::fs::write(&path, "not json").unwrap();
        assert!(read_cached(&path, 100, 200).is_none());
    }

    #[test]
    fn registry_busy_gate_and_cancel() {
        let registry = Arc::new(TranscriptionRegistry::default());
        let registration = registry.begin("job-1").unwrap();
        // One at a time.
        let busy = registry.begin("job-2").unwrap_err();
        assert_eq!(busy.code, "transcription_busy");
        // Cancelling an unknown job is a no-op.
        registry.cancel("nobody");
        assert!(!registration.job().is_cancelled());
        registry.cancel("job-1");
        assert!(registration.job().is_cancelled());
        drop(registration);
        // Gate frees after the registration drops.
        assert!(registry.begin("job-3").is_ok());
    }

    #[cfg(windows)]
    fn sleeping_child() -> std::process::Child {
        crate::process::create_command("cmd")
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    }

    #[cfg(not(windows))]
    fn sleeping_child() -> std::process::Child {
        crate::process::create_command("sleep")
            .arg("30")
            .spawn()
            .unwrap()
    }

    #[test]
    fn cancel_kills_registered_child() {
        let registry = Arc::new(TranscriptionRegistry::default());
        let registration = registry.begin("job-1").unwrap();
        registration.job().set_child(sleeping_child());
        registry.cancel("job-1");
        // The killed child reports an exit quickly.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Ok(Some(_)) = registration.job().try_wait() {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "child was not killed");
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(registration.job().is_cancelled());
    }
}
