//! Camera clock correlation for Windows DirectShow webcam captures.
//!
//! The webcam FFmpeg command runs with `use_video_device_timestamps=1` so
//! each packet keeps the driver's sample timestamp, `-copyts` so the demuxer
//! does not re-base them, and `-stats_enc_pre` so the first ENCODED frame
//! reports its original input PTS even though the filter graph normalizes
//! output PTS via `setpts=PTS-STARTPTS`. The stderr reader feeds this module
//! two line shapes:
//!
//! * `rf_camera_frame {n} {tbi} {ptsi} {tb} {pts}` — per-frame encoder stats;
//!   frame 0 carries the original absolute input PTS, which is the camera
//!   file's true media origin.
//! * `[dshow @ ...]` / `[in#0/dshow @ ...] passing through packet of type
//!   video ... timestamp X orig timestamp Y graph timestamp Z diff ...` —
//!   verbose DirectShow packet trace pairing each driver sample timestamp
//!   with the graph clock (the `in#0/` decoration appears in newer FFmpeg).
//!
//! The DirectShow graph clock has an arbitrary epoch — it is not Unix time,
//! QPC ticks, or process uptime — so it cannot be compared to Rust's
//! `Instant` directly. Instead, every packet line's graph timestamp is
//! paired with the elapsed time at which the line was observed, and the
//! maximum `graph - elapsed` across the first [`CLOCK_SAMPLE_LIMIT`] valid
//! observations estimates the graph epoch relative to process spawn. That is
//! the minimum transport delay through the pipe; residual scheduling latency
//! remains, so the result is a clock-correlation estimate, not guaranteed
//! sensor-exposure precision.
//!
//! Nothing here retains device names or raw log lines — parsed numbers only.
//! Any missing, malformed, or regressing telemetry conservatively disables
//! the measurement; callers then fall back to duration-derived alignment.
//! The failure is reported as a stable [`CameraTimingRejection`] code in
//! capture diagnostics so a fallback never needs a custom harness to explain.

use std::time::Duration;

/// Line prefix emitted by `-stats_enc_pre_fmt` on the camera recording
/// output only (never the preview pipe or the screen/concat encoders).
pub(crate) const CAMERA_FRAME_STATS_PREFIX: &str = "rf_camera_frame";
/// Exact format string passed to `-stats_enc_pre_fmt`. `{ptsi}` is the
/// original absolute input PTS in `{tbi}` units — it survives `setpts`
/// normalization, which is what makes the camera origin recoverable.
/// Only the Windows webcam command passes this option.
#[cfg(windows)]
pub(crate) const CAMERA_FRAME_STATS_FORMAT: &str = "rf_camera_frame {n} {tbi} {ptsi} {tb} {pts}";

/// Number of packet observations used for the graph-epoch estimate. The
/// startup window is bounded so later clock drift cannot revise the segment
/// origin.
const CLOCK_SAMPLE_LIMIT: u32 = 64;
/// Sample-to-graph delivery deltas above 5 seconds indicate a timestamp
/// glitch, not real scheduling latency — reject them.
const MAX_SAMPLE_LATENCY_100NS: i64 = 50_000_000;
/// How far the sample clock may run AHEAD of the graph clock (20ms).
/// Virtual-camera drivers (e.g. DroidCam) stamp samples at delivery time, so
/// the two clock reads straddle each other within sub-millisecond skew — a
/// real epoch mismatch would differ by orders of magnitude more.
const MAX_SAMPLE_SKEW_100NS: i64 = 200_000;

/// Why a camera timing measurement was rejected. Reported as a stable code
/// in capture diagnostics so a silent duration-fallback is diagnosable from
/// the session manifest alone — no stderr trace or device names are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CameraTimingRejection {
    /// Frame-0 encoder stats line had missing fields or implausible values.
    StatsMalformed,
    /// Two different frame-0 origins were reported.
    StatsConflict,
    /// A recognized DirectShow packet line could not be parsed.
    PacketMalformed,
    /// FFmpeg fell back to graph-clock timestamps (`use_video_device_timestamps`
    /// did not hold — the driver does not stamp samples).
    TimestampUnsupported,
    /// Sample or graph timestamp was negative.
    NegativeTimestamp,
    /// Sample clock led the graph clock beyond the clock-skew bound — a
    /// different epoch, not read jitter.
    SampleClockSkew,
    /// Sample-to-graph delivery delta exceeded the plausibility bound.
    DeliveryLatency,
    /// Sample or graph timestamps regressed.
    ClockRegression,
    /// Fewer than three valid packet observations — the clock epoch could
    /// not be bounded.
    InsufficientSamples,
    /// No valid frame-0 encoder stats line was observed.
    MissingStats,
    /// The mapped origin was negative or exceeded the startup limit.
    OriginOutOfRange,
}

impl CameraTimingRejection {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::StatsMalformed => "stats-malformed",
            Self::StatsConflict => "stats-conflict",
            Self::PacketMalformed => "packet-malformed",
            Self::TimestampUnsupported => "timestamps-unsupported",
            Self::NegativeTimestamp => "negative-timestamp",
            Self::SampleClockSkew => "sample-clock-skew",
            Self::DeliveryLatency => "delivery-latency",
            Self::ClockRegression => "clock-regression",
            Self::InsufficientSamples => "insufficient-samples",
            Self::MissingStats => "missing-stats",
            Self::OriginOutOfRange => "origin-out-of-range",
        }
    }
}

/// Accumulated camera timing observations from one capture's stderr stream.
///
/// All timestamps are stored in 100ns units: DirectShow packet values are
/// already 100ns, and the stats-line input PTS is converted through its
/// declared input timebase.
#[derive(Debug, Default)]
pub(crate) struct CameraTimingState {
    /// Original input PTS of the first encoded frame, in 100ns.
    first_input_100ns: Option<i128>,
    /// Estimated graph-clock epoch relative to process spawn, in 100ns.
    graph_origin_100ns: Option<i128>,
    samples: u32,
    last_graph_100ns: Option<i64>,
    last_sample_100ns: Option<i64>,
    /// First rejection cause — the root anomaly; later violations may be
    /// downstream of it and do not overwrite.
    rejection: Option<CameraTimingRejection>,
}

impl CameraTimingState {
    /// Fold one stderr line into the timing state. Returns `true` when the
    /// line is camera-timing telemetry that has been consumed — the caller
    /// must NOT forward it to the stderr buffer or logs (packet lines carry
    /// the raw device name as a suffix, which must never persist).
    pub(crate) fn observe(&mut self, line: &str, elapsed: Duration) -> bool {
        // Per-frame encoder stats: only frame 0 carries the camera origin.
        // Later frames are consumed without allocating a field vector.
        if let Some(rest) = line
            .strip_prefix(CAMERA_FRAME_STATS_PREFIX)
            .and_then(|rest| rest.strip_prefix(' '))
        {
            let mut fields = rest.split_whitespace();
            if fields.next() != Some("0") {
                return true;
            }
            let first = (|| {
                let (num, den) = fields.next()?.split_once('/')?;
                let num = num.parse::<i64>().ok()?;
                let den = den.parse::<i64>().ok()?;
                let pts = fields.next()?.parse::<i64>().ok()?;
                // `{tb}` (output timebase) is not needed for the origin.
                let _output_tb = fields.next()?;
                if fields.next() != Some("0") || fields.next().is_some() {
                    return None;
                }
                if num <= 0 || den <= 0 || pts < 0 || pts == i64::MAX {
                    return None;
                }
                i128::from(pts)
                    .checked_mul(i128::from(num))?
                    .checked_mul(10_000_000)?
                    .checked_div(i128::from(den))
            })();
            if let Some(first) = first {
                if self
                    .first_input_100ns
                    .is_some_and(|previous| previous != first)
                {
                    self.reject(CameraTimingRejection::StatsConflict);
                }
                self.first_input_100ns.get_or_insert(first);
            } else {
                self.reject(CameraTimingRejection::StatsMalformed);
            }
            return true;
        }

        // Verbose DirectShow packet trace. The tail after ` diff ` carries
        // the device name — it is parsed away and never stored.
        let Some(rest) = line
            .strip_prefix("[dshow @ ")
            // Newer FFmpeg decorates demuxer logs with the input qualifier
            // (`[in#0/dshow @ …]`). Accept exactly the first input — a loose
            // substring match would also capture other demuxer instances.
            .or_else(|| line.strip_prefix("[in#0/dshow @ "))
            .and_then(|line| line.split_once("] ").map(|(_, rest)| rest))
            .and_then(|line| line.strip_prefix("passing through packet of type video size "))
        else {
            return false;
        };
        let parsed = (|| {
            let (_, rest) = rest.split_once(" timestamp ")?;
            let (chosen, rest) = rest.split_once(" orig timestamp ")?;
            let (sample, rest) = rest.split_once(" graph timestamp ")?;
            let (graph, _) = rest.split_once(" diff ")?;
            Some((
                chosen.trim().parse::<i64>().ok()?,
                sample.trim().parse::<i64>().ok()?,
                graph.trim().parse::<i64>().ok()?,
            ))
        })();
        let Some((chosen, sample, graph)) = parsed else {
            // A recognized packet line we cannot parse is just as suspect as
            // bad values — discard the whole estimate conservatively.
            self.reject(CameraTimingRejection::PacketMalformed);
            return true;
        };
        // Use the driver sample time, not the packet's arrival: when
        // `use_video_device_timestamps=1` holds, chosen == sample. Fallback
        // to the graph clock, negative/regressing timestamps, and absurd
        // delivery deltas all mark the telemetry unusable rather than
        // feeding a bogus origin into the alignment math. The sample clock
        // may lead the graph clock by up to MAX_SAMPLE_SKEW_100NS — virtual
        // cameras stamp at delivery, so sub-millisecond skew is normal.
        let rejection = if chosen != sample {
            Some(CameraTimingRejection::TimestampUnsupported)
        } else if sample < 0 || graph < 0 {
            Some(CameraTimingRejection::NegativeTimestamp)
        } else if sample.saturating_sub(graph) > MAX_SAMPLE_SKEW_100NS {
            Some(CameraTimingRejection::SampleClockSkew)
        } else if graph.saturating_sub(sample) > MAX_SAMPLE_LATENCY_100NS {
            Some(CameraTimingRejection::DeliveryLatency)
        } else if self
            .last_graph_100ns
            .is_some_and(|previous| graph < previous)
            || self
                .last_sample_100ns
                .is_some_and(|previous| sample < previous)
        {
            Some(CameraTimingRejection::ClockRegression)
        } else {
            None
        };
        if let Some(reason) = rejection {
            self.reject(reason);
            return true;
        }
        self.last_graph_100ns = Some(graph);
        self.last_sample_100ns = Some(sample);
        if self.samples < CLOCK_SAMPLE_LIMIT {
            // Correlate the graph clock to the Rust timeline at the moment
            // the line was observed. Keeping the MAXIMUM graph-minus-elapsed
            // picks the observation with the least pipe/scheduler delay —
            // every line took at least the true transport delay, so the
            // earliest-arriving observation bounds the epoch most tightly.
            let elapsed_100ns = i128::try_from(elapsed.as_nanos() / 100).unwrap_or(i128::MAX);
            let origin = i128::from(graph) - elapsed_100ns;
            self.graph_origin_100ns = Some(
                self.graph_origin_100ns
                    .map_or(origin, |previous| previous.max(origin)),
            );
            self.samples += 1;
        }
        true
    }

    /// Record a hard rejection, keeping the FIRST cause: the earliest
    /// anomaly is the root cause; later ones may be downstream of it.
    fn reject(&mut self, reason: CameraTimingRejection) {
        self.rejection.get_or_insert(reason);
    }

    /// Measured camera origin in milliseconds, or the reason it is
    /// unavailable. The checks mirror `observe`'s contract: a stored
    /// rejection dominates, then missing inputs, then the implausibility
    /// bound on the mapped delta.
    fn measured_origin_ms(&self, startup_limit: Duration) -> Result<u64, CameraTimingRejection> {
        if let Some(reason) = self.rejection {
            return Err(reason);
        }
        if self.samples < 3 {
            return Err(CameraTimingRejection::InsufficientSamples);
        }
        let first = self
            .first_input_100ns
            .ok_or(CameraTimingRejection::MissingStats)?;
        // samples >= 3 implies the origin was estimated; if it somehow is
        // absent, the packet clock was never usable — same failure class.
        let origin = self
            .graph_origin_100ns
            .ok_or(CameraTimingRejection::InsufficientSamples)?;
        let delta =
            u64::try_from(first - origin).map_err(|_| CameraTimingRejection::OriginOutOfRange)?;
        if u128::from(delta) > startup_limit.as_nanos() / 100 {
            return Err(CameraTimingRejection::OriginOutOfRange);
        }
        Ok(delta / 10_000)
    }

    /// Camera file origin relative to process spawn, in milliseconds. `None`
    /// when the telemetry was missing, malformed, regressed, or maps to an
    /// implausible startup delay beyond `startup_limit` — the conservative
    /// fallback keeps the caller on duration-derived alignment instead.
    pub(crate) fn first_frame_offset_ms(&self, startup_limit: Duration) -> Option<u64> {
        self.measured_origin_ms(startup_limit).ok()
    }

    /// Stable reason code explaining a `None` origin (e.g.
    /// `sample-clock-skew`), or `None` when the measurement is valid.
    pub(crate) fn rejection_reason(&self, startup_limit: Duration) -> Option<&'static str> {
        self.measured_origin_ms(startup_limit)
            .err()
            .map(CameraTimingRejection::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTUP_LIMIT: Duration = Duration::from_secs(8);

    fn packet_line(sample: i64, graph: i64) -> String {
        format!(
            "[dshow @ 000001] passing through packet of type video size     2048 timestamp {sample} orig timestamp {sample} graph timestamp {graph} diff 6000000 Synthetic Camera"
        )
    }

    fn stats_line(ptsi: i64) -> String {
        format!("rf_camera_frame 0 1/10000000 {ptsi} 1/30 0")
    }

    fn feed_packets(state: &mut CameraTimingState, observations: &[(i64, i64, u64)]) {
        for &(sample, graph, elapsed_ms) in observations {
            assert!(state.observe(
                &packet_line(sample, graph),
                Duration::from_millis(elapsed_ms)
            ));
        }
    }

    /// The documented jitter fixture: first frame PTS 1000.2s of graph time.
    /// The callback carries 600ms of delivery latency. The best observation
    /// adds 1ms of pipe delay, so a 200ms source origin is estimated as 201ms.
    const JITTER_PACKETS: [(i64, i64, u64); 3] = [
        (10_002_000_000, 10_008_000_000, 900),
        (10_003_000_000, 10_009_000_000, 901),
        (10_004_000_000, 10_010_000_000, 1_001),
    ];

    #[test]
    fn offset_uses_sample_clock_not_delivery_jitter() {
        let mut state = CameraTimingState::default();
        assert!(state.observe(&stats_line(10_002_000_000), Duration::ZERO));
        feed_packets(&mut state, &JITTER_PACKETS);
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), Some(201));
    }

    #[test]
    fn stats_line_may_arrive_after_packets() {
        let mut state = CameraTimingState::default();
        feed_packets(&mut state, &JITTER_PACKETS);
        assert!(state.observe(&stats_line(10_002_000_000), Duration::ZERO));
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), Some(201));
    }

    #[test]
    fn requires_the_actual_first_encoded_frame() {
        // Packets alone: the graph epoch is known, but the file's media
        // origin is not — the first callback may have been dropped.
        let mut packets_only = CameraTimingState::default();
        feed_packets(&mut packets_only, &JITTER_PACKETS);
        assert_eq!(packets_only.first_frame_offset_ms(STARTUP_LIMIT), None);

        // Stats alone: media origin known, graph clock unbound.
        let mut stats_only = CameraTimingState::default();
        assert!(stats_only.observe(&stats_line(10_002_000_000), Duration::ZERO));
        assert_eq!(stats_only.first_frame_offset_ms(STARTUP_LIMIT), None);

        // Two packet observations are too few for a delay estimate.
        let mut two_packets = CameraTimingState::default();
        assert!(two_packets.observe(&stats_line(10_002_000_000), Duration::ZERO));
        feed_packets(&mut two_packets, &JITTER_PACKETS[..2]);
        assert_eq!(two_packets.first_frame_offset_ms(STARTUP_LIMIT), None);
    }

    #[test]
    fn rejects_malformed_or_implausible_stats_lines() {
        let bad_lines = [
            // Missing/placeholder PTS.
            "rf_camera_frame 0 1/10000000 9223372036854775807 1/30 0",
            // Malformed timebase rational.
            "rf_camera_frame 0 abc 10002000000 1/30 0",
            // Negative PTS.
            "rf_camera_frame 0 1/10000000 -5 1/30 0",
            // Zero denominator.
            "rf_camera_frame 0 1/0 10002000000 1/30 0",
            // Negative denominator.
            "rf_camera_frame 0 1/-10 10002000000 1/30 0",
            // Nonzero normalized output PTS — not the first frame's origin.
            "rf_camera_frame 0 1/10000000 10002000000 1/30 7",
            // Wrong field count.
            "rf_camera_frame 0 1/10000000 10002000000 0",
        ];
        for bad in bad_lines {
            let mut state = CameraTimingState::default();
            assert!(state.observe(bad, Duration::ZERO));
            feed_packets(&mut state, &JITTER_PACKETS);
            assert_eq!(
                state.first_frame_offset_ms(STARTUP_LIMIT),
                None,
                "malformed stats line must invalidate telemetry: {bad}"
            );
        }
    }

    #[test]
    fn rejects_malformed_or_implausible_packet_lines() {
        let cases: Vec<String> = vec![
            // Chosen PTS differs from the driver sample (fallback to graph
            // clock) — the sample-clock assumption no longer holds.
            "[dshow @ 1] passing through packet of type video size 1 timestamp 100 orig timestamp 200 graph timestamp 300 diff 0 Cam".into(),
            // Sample later than graph clock.
            packet_line(10_008_000_000, 10_002_000_000),
            // Delivery delta above the 5s plausibility bound.
            packet_line(10_002_000_000, 10_002_000_000 + MAX_SAMPLE_LATENCY_100NS + 1),
            // Negative sample timestamp.
            packet_line(-5, 10),
        ];
        for bad in cases {
            let mut state = CameraTimingState::default();
            assert!(state.observe(&stats_line(10_002_000_000), Duration::ZERO));
            feed_packets(&mut state, &JITTER_PACKETS[..2]);
            assert!(state.observe(&bad, Duration::from_millis(1_002)));
            assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), None);
        }

        // Regressing graph or sample clocks invalidate the whole estimate.
        let mut regressed_graph = CameraTimingState::default();
        assert!(regressed_graph.observe(&stats_line(10_002_000_000), Duration::ZERO));
        feed_packets(&mut regressed_graph, &JITTER_PACKETS);
        assert!(regressed_graph.observe(
            &packet_line(10_005_000_000, 10_009_000_000),
            Duration::from_millis(1_100)
        ));
        assert_eq!(regressed_graph.first_frame_offset_ms(STARTUP_LIMIT), None);

        let mut regressed_sample = CameraTimingState::default();
        assert!(regressed_sample.observe(&stats_line(10_002_000_000), Duration::ZERO));
        feed_packets(&mut regressed_sample, &JITTER_PACKETS);
        assert!(regressed_sample.observe(
            &packet_line(10_001_000_000, 10_011_000_000),
            Duration::from_millis(1_100)
        ));
        assert_eq!(regressed_sample.first_frame_offset_ms(STARTUP_LIMIT), None);
    }

    #[test]
    fn ignores_unrelated_lines_and_survives_huge_numbers() {
        let mut state = CameraTimingState::default();
        // Audio packets and other dshow chatter are not camera timing lines.
        assert!(!state.observe(
            "[dshow @ 1] passing through packet of type audio size 128 timestamp 1 orig timestamp 1 graph timestamp 2 diff 1 Mic",
            Duration::ZERO
        ));
        assert!(!state.observe("frame=   42 fps=0.0 q=-1.0", Duration::ZERO));
        assert!(!state.observe("random text", Duration::ZERO));
        // Oversized numbers parse-fail or saturate without panicking.
        assert!(state.observe(
            "[dshow @ 1] passing through packet of type video size 1 timestamp 99999999999999999999 orig timestamp 99999999999999999999 graph timestamp 99999999999999999999 diff 1 Cam",
            Duration::ZERO
        ));
        assert!(state.observe(
            "rf_camera_frame 0 1/1 9223372036854775806 1/1 0",
            Duration::ZERO
        ));
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), None);
    }

    #[test]
    fn duplicate_timestamps_are_permitted() {
        let mut state = CameraTimingState::default();
        assert!(state.observe(&stats_line(10_002_000_000), Duration::ZERO));
        // Equal (non-regressing) sample/graph pairs are legal — a camera can
        // repeat a timestamp under load.
        let dup = [
            (10_002_000_000, 10_008_000_000, 900u64),
            (10_002_000_000, 10_008_000_000, 901),
            (10_004_000_000, 10_010_000_000, 1_001),
        ];
        feed_packets(&mut state, &dup);
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), Some(201));
    }

    #[test]
    fn origin_is_stable_after_the_sample_limit() {
        let mut state = CameraTimingState::default();
        assert!(state.observe(&stats_line(10_000_000_000), Duration::ZERO));
        // 64 observations at a constant 600ms delivery delta → origin is bound.
        for n in 0..CLOCK_SAMPLE_LIMIT as i64 {
            let sample = 10_000_000_000 + n * 1_000_000;
            let elapsed_ms = 800 + n as u64 * 100;
            assert!(state.observe(
                &packet_line(sample, sample + 6_000_000),
                Duration::from_millis(elapsed_ms)
            ));
        }
        let settled = state.first_frame_offset_ms(STARTUP_LIMIT);
        assert_eq!(settled, Some(200));

        // A delayed tail callback with a wildly different implied origin must
        // not move the estimate — but validity checks still apply.
        let sample = 10_000_000_000 + CLOCK_SAMPLE_LIMIT as i64 * 1_000_000;
        assert!(state.observe(
            &packet_line(sample, sample + 6_000_000),
            Duration::from_millis(0) // absurdly fast arrival → huge origin
        ));
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), settled);

        // Chosen/sample monotonicity is still enforced past the limit.
        let bad_sample = sample + 1_000_000;
        assert!(state.observe(
            &format!(
                "[dshow @ 1] passing through packet of type video size 1 timestamp {} orig timestamp {} graph timestamp {} diff 0 Cam",
                bad_sample - 1,
                bad_sample,
                bad_sample + 1_000_000
            ),
            Duration::from_millis(2_000)
        ));
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), None);
    }

    #[test]
    fn arbitrary_graph_epoch_does_not_move_the_offset() {
        // The graph epoch is arbitrary: adding the same constant to the
        // sample PTS, graph clock, and stats PTS must leave the measured
        // offset untouched.
        const EPOCH_SHIFT: i64 = 555_000_000_000;
        let mut state = CameraTimingState::default();
        assert!(state.observe(&stats_line(10_002_000_000 + EPOCH_SHIFT), Duration::ZERO));
        for &(sample, graph, elapsed_ms) in &JITTER_PACKETS {
            assert!(state.observe(
                &packet_line(sample + EPOCH_SHIFT, graph + EPOCH_SHIFT),
                Duration::from_millis(elapsed_ms)
            ));
        }
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), Some(201));
    }

    #[test]
    fn rejects_implausible_or_negative_mapped_starts() {
        // Startup delay beyond the limit → rejected.
        let mut over_limit = CameraTimingState::default();
        assert!(over_limit.observe(&stats_line(10_002_000_000), Duration::ZERO));
        feed_packets(&mut over_limit, &JITTER_PACKETS);
        assert_eq!(
            over_limit.first_frame_offset_ms(Duration::from_millis(100)),
            None
        );

        // A graph epoch AFTER the first frame (impossible in reality) maps to
        // a negative start → rejected.
        let mut negative = CameraTimingState::default();
        assert!(negative.observe(&stats_line(10_002_000_000), Duration::ZERO));
        let zero_elapsed = [
            (10_002_000_000, 10_008_000_000, 0u64),
            (10_003_000_000, 10_009_000_000, 0),
            (10_004_000_000, 10_010_000_000, 0),
        ];
        feed_packets(&mut negative, &zero_elapsed);
        assert_eq!(negative.first_frame_offset_ms(STARTUP_LIMIT), None);
    }

    #[test]
    fn malformed_packet_invalidates_an_existing_origin() {
        let mut state = CameraTimingState::default();
        assert!(state.observe(&stats_line(10_002_000_000), Duration::ZERO));
        feed_packets(&mut state, &JITTER_PACKETS);
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), Some(201));
        // A recognized-but-unparseable video packet line is consumed AND
        // conservatively discards the estimate built so far.
        assert!(state.observe(
            "[dshow @ 1] passing through packet of type video size 1 timestamp invalid orig timestamp 10002000000 graph timestamp 10008000000 diff 0 Cam",
            Duration::from_millis(1_100)
        ));
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), None);
    }

    #[test]
    fn input_qualified_dshow_prefix_preserves_camera_origin() {
        let mut state = CameraTimingState::default();
        // Packet format/numbers are from the bundled FFmpeg hardware trace;
        // receipt times and matching first-encoded-frame metadata are controlled fixtures.
        let observations = [
            ("[in#0/dshow @ 000001ebdab83100] passing through packet of type video size    72256 timestamp 5028392239825 orig timestamp 5028392239825 graph timestamp 5028393800000 diff 1560175 <camera>", 500),
            ("[in#0/dshow @ 000001ebdab83100] passing through packet of type video size    72896 timestamp 5028392560077 orig timestamp 5028392560077 graph timestamp 5028394110000 diff 1549923 <camera>", 531),
            ("[in#0/dshow @ 000001ebdab83100] passing through packet of type video size    71520 timestamp 5028392880608 orig timestamp 5028392880608 graph timestamp 5028394430000 diff 1549392 <camera>", 563),
        ];
        for (line, elapsed_ms) in observations {
            assert!(state.observe(line, Duration::from_millis(elapsed_ms)));
        }
        assert!(state.observe(
            "rf_camera_frame 0 1/10000000 5028392239825 1/30 0",
            Duration::from_millis(600)
        ));
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), Some(343));
    }

    #[test]
    fn modern_prefix_does_not_relax_packet_validation() {
        let mut state = CameraTimingState::default();
        assert!(state.observe(&stats_line(10_002_000_000), Duration::ZERO));
        for &(sample, graph, elapsed_ms) in &JITTER_PACKETS {
            let modern = format!(
                "[in#0/dshow @ 000001] passing through packet of type video size     2048 timestamp {sample} orig timestamp {sample} graph timestamp {graph} diff 6000000 Synthetic Camera"
            );
            assert!(state.observe(&modern, Duration::from_millis(elapsed_ms)));
        }
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), Some(201));

        // The new prefix keeps every validity check: a chosen PTS that fell
        // back to the graph clock still invalidates the whole estimate.
        assert!(state.observe(
            "[in#0/dshow @ 1] passing through packet of type video size 1 timestamp 100 orig timestamp 200 graph timestamp 300 diff 0 Cam",
            Duration::from_millis(1_100)
        ));
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), None);
    }

    #[test]
    fn tolerates_virtual_camera_clock_skew() {
        // Real DroidCam-shaped telemetry: the virtual driver stamps samples
        // at delivery, so the sample clock lands sub-milliseconds AHEAD of
        // the graph clock (negative diff). That is clock-read skew, not a
        // glitch — the estimate must survive it.
        let mut state = CameraTimingState::default();
        assert!(state.observe(
            "rf_camera_frame 0 1/10000000 5060045033252 1/30 0",
            Duration::ZERO
        ));
        let packets = [
            (5_060_045_033_252i64, 5_060_045_030_000i64, 1_807u64),
            (5_060_045_493_197, 5_060_045_490_000, 1_854),
            (5_060_045_958_321, 5_060_045_960_000, 1_900),
            (5_060_046_425_618, 5_060_046_430_000, 1_947),
            (5_060_046_890_447, 5_060_046_890_000, 1_993),
        ];
        feed_packets(&mut state, &packets);
        // max(graph - elapsed) = 5060026960000; first sample lands 1807ms
        // after that epoch — the observed first-packet arrival minus pipe
        // delay.
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), Some(1807));
    }

    #[test]
    fn rejects_sample_clock_beyond_skew_bound() {
        // A sample clock ahead of the graph clock by MORE than the skew
        // bound is a different epoch, not read jitter — still rejected.
        let mut state = CameraTimingState::default();
        assert!(state.observe(&stats_line(10_002_000_000), Duration::ZERO));
        feed_packets(&mut state, &JITTER_PACKETS[..2]);
        assert!(state.observe(
            &packet_line(10_010_000_000 + MAX_SAMPLE_SKEW_100NS + 1, 10_010_000_000),
            Duration::from_millis(1_001)
        ));
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), None);
    }

    #[test]
    fn rejection_reason_names_the_first_failure() {
        // A valid measurement reports no reason.
        let mut valid = CameraTimingState::default();
        assert!(valid.observe(&stats_line(10_002_000_000), Duration::ZERO));
        feed_packets(&mut valid, &JITTER_PACKETS);
        assert_eq!(valid.rejection_reason(STARTUP_LIMIT), None);

        // An untouched state ran out of packet observations.
        assert_eq!(
            CameraTimingState::default().rejection_reason(STARTUP_LIMIT),
            Some("insufficient-samples")
        );

        // Stats alone leave the packet clock unbound → insufficient samples.
        let mut stats_only = CameraTimingState::default();
        assert!(stats_only.observe(&stats_line(10_002_000_000), Duration::ZERO));
        assert_eq!(
            stats_only.rejection_reason(STARTUP_LIMIT),
            Some("insufficient-samples")
        );

        // Packets alone leave the media origin unknown → missing stats.
        let mut packets_only = CameraTimingState::default();
        feed_packets(&mut packets_only, &JITTER_PACKETS);
        assert_eq!(
            packets_only.rejection_reason(STARTUP_LIMIT),
            Some("missing-stats")
        );

        // The FIRST failure is the root cause: a negative timestamp recorded
        // before a malformed packet keeps its reason.
        let mut poisoned = CameraTimingState::default();
        assert!(poisoned.observe(&packet_line(-5, 10), Duration::ZERO));
        assert!(poisoned.observe(
            "[dshow @ 1] passing through packet of type video size 1 timestamp invalid orig timestamp 100 graph timestamp 200 diff 0 Cam",
            Duration::from_millis(1)
        ));
        assert_eq!(
            poisoned.rejection_reason(STARTUP_LIMIT),
            Some("negative-timestamp")
        );

        // Sample clock beyond the skew bound names itself.
        let mut skewed = CameraTimingState::default();
        assert!(skewed.observe(&stats_line(10_002_000_000), Duration::ZERO));
        feed_packets(&mut skewed, &JITTER_PACKETS[..2]);
        assert!(skewed.observe(
            &packet_line(10_010_000_000 + MAX_SAMPLE_SKEW_100NS + 1, 10_010_000_000),
            Duration::from_millis(1_001)
        ));
        assert_eq!(
            skewed.rejection_reason(STARTUP_LIMIT),
            Some("sample-clock-skew")
        );
    }

    #[test]
    fn rejects_unrelated_input_prefixes() {
        let mut state = CameraTimingState::default();
        // Same packet marker under a different demuxer or a different input
        // index is not camera timing telemetry.
        for line in [
            "[in#0/avfoundation @ 1] passing through packet of type video size 1 timestamp 1 orig timestamp 1 graph timestamp 2 diff 0 Cam",
            "[in#1/dshow @ 1] passing through packet of type video size 1 timestamp 1 orig timestamp 1 graph timestamp 2 diff 0 Cam",
            "[in#0/dshow @ 1] some other message timestamp 1 orig timestamp 1 graph timestamp 2 diff 0 Cam",
        ] {
            assert!(!state.observe(line, Duration::ZERO), "not consumed: {line}");
        }
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), None);
    }

    #[test]
    fn conflicting_first_frames_invalidate() {
        let mut state = CameraTimingState::default();
        assert!(state.observe(&stats_line(10_002_000_000), Duration::ZERO));
        assert!(state.observe(&stats_line(10_009_000_000), Duration::ZERO));
        feed_packets(&mut state, &JITTER_PACKETS);
        assert_eq!(state.first_frame_offset_ms(STARTUP_LIMIT), None);
    }
}
