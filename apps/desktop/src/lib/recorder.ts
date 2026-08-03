import { invoke } from "@tauri-apps/api/core"
import type {
  AudioDevice,
  BenchmarkReport,
  CaptureSource,
  DiagnosticsReport,
  EncoderInfo,
  LibraryRecording,
  RecordingConfig,
  RecordingMarker,
  RecordingProfile,
  RecordingStats,
  RecordingStatus,
  RecoveryScanResult,
  VideoDevice,
} from "@recordforge/contracts"

export async function listCaptureSources(): Promise<CaptureSource[]> {
  return invoke("list_capture_sources")
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  return invoke("list_audio_devices")
}

export async function listVideoDevices(): Promise<VideoDevice[]> {
  return invoke("list_video_devices")
}

export async function listBuiltinProfiles(): Promise<RecordingProfile[]> {
  return invoke("list_builtin_profiles")
}

export async function startRecording(config: RecordingConfig): Promise<string> {
  return invoke("start_recording", { config })
}

export async function pauseRecording(): Promise<RecordingStatus> {
  return invoke("pause_recording")
}

export async function resumeRecording(): Promise<RecordingStatus> {
  return invoke("resume_recording")
}

export async function stopRecording(): Promise<RecordingStats> {
  return invoke("stop_recording")
}

export async function getRecordingStatus(): Promise<RecordingStatus> {
  return invoke("recording_status")
}

export async function insertMarker(label: string): Promise<RecordingMarker> {
  return invoke("insert_marker", { label })
}

export async function detectHardwareEncoders(): Promise<EncoderInfo[]> {
  return invoke("detect_hardware_encoders")
}

export async function getDiagnosticsReport(): Promise<DiagnosticsReport> {
  return invoke("get_diagnostics_report")
}

export async function scanRecoverySessions(): Promise<RecoveryScanResult[]> {
  return invoke("scan_recovery_sessions")
}

export async function recoverSession(sessionId: string): Promise<LibraryRecording> {
  return invoke("recover_session", { sessionId })
}

export async function deleteRecoverySession(sessionId: string): Promise<void> {
  return invoke("delete_recovery_session", { sessionId })
}

export async function runBenchmark(): Promise<BenchmarkReport> {
  return invoke("run_encoder_benchmark")
}

export async function openFloatingControls(): Promise<void> {
  return invoke("open_floating_controls")
}

export async function openBoundaryOverlay(): Promise<void> {
  return invoke("open_boundary_overlay")
}

export async function hideBoundaryOverlay(): Promise<void> {
  return invoke("hide_boundary_overlay")
}

export async function hideFloatingControls(): Promise<void> {
  return invoke("hide_floating_controls")
}
