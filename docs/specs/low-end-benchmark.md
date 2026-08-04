# Low-End Benchmark Specification

> **Status:** Draft — Phase 0  
> **Scope:** Baseline machine definition, capture matrix, pass/fail thresholds for Windows 10  
> **Owner:** `docs/benchmarks`

---

## 1. Baseline Machine Definition

### Target: Windows 10 low-end desktop/laptop

| Component | Minimum Spec | Notes |
| ----------- | ------------- | ------- |
| **OS** | Windows 10 21H2+ (64-bit) | Primary target platform |
| **CPU** | Intel Core i5-8250U / AMD Ryzen 5 2500U (4C/8T) | Typical 2018-era laptop CPU |
| **GPU** | Intel UHD 620 / AMD Vega 8 (integrated) | No dedicated GPU required |
| **RAM** | 8 GB DDR4 | Typical low-end config |
| **Storage** | SATA SSD 256 GB | NVMe not required; HDD is below minimum |
| **Display** | 1920×1080 @ 60Hz | Single monitor baseline |
| **Display Scaling** | 100% or 125% | Common Windows 10 DPI settings |
| **Microphone** | Built-in laptop mic or USB headset | WASAPI capture endpoint |
| **Webcam** | Built-in 720p or USB 1080p | Optional; tested separately |
| **Power Plan** | "Balanced" (not "Power Saver") | Representative of typical use |
| **Thermal** | Laptop thermal throttling expected | Tests must account for sustained load |

### Software environment

| Component | Version |
| ----------- | --------- |
| Windows | 10 21H2+ |
| FFmpeg | 6.x+ (bundled) |
| .NET Desktop Runtime | Not required |
| Visual C++ Redistributable | Bundled by Tauri |

---

## 2. Capture Performance Matrix

### 2.1 Display capture scenarios

| Scenario | Resolution | FPS | Duration | Target | Fail |
| ---------- | ----------- | ----- | ---------- | -------- | ------ |
| Sustained display | 1080p | 30 | 30 min | ≤ 5% frame drops, A/V drift ≤ 1 frame (33ms) | > 5% drops or > 66ms drift |
| Long-form display | 720p | 30 | 120 min | ≤ 3% frame drops | > 5% drops |
| High-end display | 1080p | 60 | 10 min | ≤ 10% drops on baseline (if enabled) | Disable if > 10% |
| System resource load | 1080p | 30 | 30 min | CPU < 30%, Memory < 500 MB | CPU > 50% or Memory > 1 GB |
| Disk throughput | 1080p | 30 | 30 min | Sustained write < 50 MB/s | Write stalls > 1s |

### 2.2 Window and region capture

| Scenario | Target | Fail |
| ---------- | -------- | ------ |
| Window capture (static) | No black frames, correct bounds | Visible artifacts |
| Window capture (moving) | Tracks window position | Frozen/stale position |
| Window capture (minimized) | Graceful handling (pause or last frame) | Crash or corrupt output |
| Window capture (occluded) | Correct content (not desktop crop) | Shows occluding window content |
| Region capture (mixed DPI) | Correct coordinates and scale | Offset or distortion |
| Region capture (non-16:9) | Preserved aspect ratio | Stretched/squished output |

### 2.3 Audio capture

| Scenario | Target | Fail |
| ---------- | -------- | ------ |
| Microphone only | Clean capture, no underruns | Clicks, pops, silence |
| System audio only (WASAPI) | Loopback capture works without Stereo Mix | No system-audio stream |
| Mic + system (separate) | Independent streams in the MP4 | Mixed into a single stream |
| A/V sync | Drift ≤ 1 frame over 30 min | Drift > 2 frames |
| Device hot-unplug | Warning + continue recording | Crash |

### 2.4 Webcam capture

| Scenario | Target | Fail |
| ---------- | -------- | ------ |
| 720p sidecar | A/V sync within 1 frame | > 2 frame drift |
| Webcam + screen | Both streams captured independently | One blocks the other |

---

## 3. Recovery and Crash Benchmarks

| Scenario | Target | Fail |
| ---------- | -------- | ------ |
| Force-quit at 1 min (first segment) | At least 30s recovered | Nothing recovered |
| Force-quit at 5 min (multiple segments) | All finalized segments recovered | Any finalized segment lost |
| Force-quit at 30 min | All finalized segments recovered | Any finalized segment lost |
| App crash during finalization | Manifest + segments preserved | Manifest corrupt |
| Power loss during recording | Manifest + validated segments preserved | Data loss beyond current segment |
| Recovery scan startup time | < 2s for 10 sessions | > 5s |

---

## 4. Timeline and Library Scale Tests

| Scenario | Target | Fail |
| ---------- | -------- | ------ |
| Library: 100 recordings | Load < 200ms | > 500ms |
| Library: 1,000 recordings | Load < 500ms, scroll 60fps | > 1s or jank |
| Library: 10,000 recordings | Load < 2s, sort/search < 100ms, scroll 60fps | > 5s or visible lag |
| Timeline: 5 min project | Open < 500ms, seek < 50ms | > 1s |
| Timeline: 30 min project | Open < 1s, seek < 100ms | > 2s |
| Timeline: 60 min project | Open < 2s, seek < 100ms, playback 16.6ms frame budget | > 3s or dropped frames |

---

## 5. Export Benchmarks

| Scenario | Target | Fail |
| ---------- | -------- | ------ |
| 5 min 1080p30 simple trim | < 2× real-time (< 10 min) | > 4× real-time |
| 5 min 1080p30 full composite | < 4× real-time (< 20 min) | > 8× real-time |
| Export during recording | No visible impact on recording | Frame drops > 5% |
| Export cancellation cleanup | No orphan `.partial` files | Partial files remain |

---

## 6. Upload Benchmarks

| Scenario | Target | Fail |
| ---------- | -------- | ------ |
| 100 MB local copy | < 10s on SATA SSD | > 30s |
| 1 GB S3 multipart | Resume after network interruption | Re-upload entire file |
| 1 GB S3 multipart | Resume after app restart | Re-upload entire file |
| 1 GB Google Drive resumable | Resume after app restart | Re-upload entire file |
| Invalid credentials | Actionable error within 5s | Hang or generic error |

---

## 7. Application Lifecycle Benchmarks

| Scenario | Target | Fail |
| ---------- | -------- | ------ |
| Cold startup to ready | < 3s | > 5s |
| Startup with recovery scan | < 5s (10 sessions) | > 10s |
| React initial render | < 500ms (LCP) | > 1s |
| Idle CPU usage | < 1% | > 5% |
| Idle memory | < 150 MB | > 300 MB |
| IPC round-trip (status query) | < 10ms | > 50ms |

---

## 8. Measurement Methodology

### Tools

- **CPU/Memory**: Windows Task Manager, `Get-Process` PowerShell, Rust `sysinfo` crate
- **Frame drops**: FFmpeg stderr `frame=`, `drop=` counters
- **A/V drift**: FFprobe stream analysis + manual verification
- **Disk I/O**: Windows Resource Monitor or `fsutil`
- **Timing**: Rust `std::time::Instant`, browser `Performance.now()`

### Test protocol

1. Close all non-essential applications
2. Set power plan to "Balanced"
3. Wait 30s after startup for thermal stabilization
4. Run each scenario 3 times; report median
5. Record CPU/memory at 1-second intervals during capture tests
6. Log FFmpeg stderr for frame/speed/stats extraction
