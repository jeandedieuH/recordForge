# Phase 0 Baseline Metrics

> **Status:** To be measured on baseline machine  
> **Scope:** Captures current prototype performance before any architectural changes  
> **Machine:** See [baseline-machine.md](baseline-machine.md)

---

## 1. Application Lifecycle

| Metric | Value | Notes |
| -------- | ------- | ------- |
| Cold startup to main window visible | _[measure]_ ms | |
| Startup with recovery scan (0 sessions) | _[measure]_ ms | |
| Startup with recovery scan (5 sessions) | _[measure]_ ms | |
| React initial render (LCP) | _[measure]_ ms | |
| Idle CPU usage | _[measure]_ % | After 30s idle |
| Idle memory (working set) | _[measure]_ MB | |
| IPC round-trip (`recording_status`) | _[measure]_ ms | Average of 100 calls |

---

## 2. Capture Performance

### 2.1 Display capture — 1080p30 Balanced profile

| Metric | Value | Notes |
| -------- | ------- | ------- |
| Capture engine | ddagrab / gdigrab | Which engine was selected |
| Duration | _[measure]_ min | Target: 5 min initial baseline |
| Frames processed | _[measure]_ | From FFmpeg stderr |
| Frame drops | _[measure]_ % | |
| Average FPS | _[measure]_ | |
| Speed ratio | _[measure]_ × | |
| CPU usage (average) | _[measure]_ % | |
| CPU usage (peak) | _[measure]_ % | |
| Memory (average) | _[measure]_ MB | |
| Memory (peak) | _[measure]_ MB | |
| Disk write (total) | _[measure]_ MB | |
| Disk write rate (average) | _[measure]_ MB/s | |
| A/V drift | _[measure]_ ms | Measured by FFprobe comparison |
| Output file size | _[measure]_ MB | |
| Output duration | _[measure]_ s | |

### 2.2 Display capture — 720p30 Low Impact profile

| Metric | Value | Notes |
| -------- | ------- | ------- |
| Duration | _[measure]_ min | |
| Frame drops | _[measure]_ % | |
| CPU usage (average) | _[measure]_ % | |
| Memory (average) | _[measure]_ MB | |

### 2.3 Window capture

| Metric | Value | Notes |
| -------- | ------- | ------- |
| Works with static window | _[yes/no]_ | |
| Tracks window movement | _[yes/no]_ | Expected: NO (P0.2) |
| Handles occlusion correctly | _[yes/no]_ | Expected: NO (P0.2) |
| Handles minimized window | _[yes/no]_ | Expected: NO (P0.2) |

### 2.4 Audio

| Metric | Value | Notes |
| -------- | ------- | ------- |
| Microphone capture works | _[yes/no]_ | |
| System audio works (without Stereo Mix) | _[yes/no]_ | Native WASAPI loopback; manual validation pending |
| Mic and system audio are separate tracks | _[yes/no]_ | Separate AAC streams; manual validation pending |

---

## 3. Recovery

| Metric | Value | Notes |
| -------- | ------- | ------- |
| Force-quit at 10s (first segment) | _[recovered bytes]_ | Expected: 0 (P0.1) |
| Force-quit at 2 min (after pause/resume) | _[recovered bytes]_ | |
| Recovery scan time (5 sessions) | _[measure]_ ms | |
| Recovery concat time (3 segments) | _[measure]_ ms | |

---

## 4. Library

| Metric | Value | Notes |
| -------- | ------- | ------- |
| Load 10 recordings | _[measure]_ ms | |
| Load 100 recordings | _[measure]_ ms | |
| Library shows real data | _[yes/no]_ | Expected: Falls back to mock (P1.2) |
| Library pagination | _[yes/no]_ | Expected: NO |

---

## 5. Media Preparation

| Metric | Value | Notes |
| -------- | ------- | ------- |
| Probe (30s 1080p30) | _[measure]_ ms | |
| Proxy generation (30s → 540p) | _[measure]_ s | |
| Thumbnail sprite (30s, 5s interval) | _[measure]_ s | |
| Waveform generation (30s) | _[measure]_ s | |
| Total prepare job (30s recording) | _[measure]_ s | |

---

## 6. Export

| Metric | Value | Notes |
| -------- | ------- | ------- |
| Stream copy 30s 1080p30 | _[measure]_ s | |
| Export UI connected | _[yes/no]_ | Expected: disconnected (P1.4) |
| Export shows progress | _[yes/no]_ | |
| Export cancellable | _[yes/no]_ | Expected: NO |

---

## Measurement Protocol

1. Close all non-essential applications
2. Set power plan to "Balanced"
3. Wait 30 seconds after app startup
4. Run each measurement 3 times; report median
5. Capture FFmpeg stderr for frame/speed stats
6. Use Task Manager or `Get-Process` for CPU/memory
7. Record ambient temperature for thermal reference
