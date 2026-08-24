import { z } from "zod"
import {
  audioDeviceSchema,
  benchmarkReportSchema,
  captureSourceSchema,
  diagnosticsReportSchema,
  encoderInfoSchema,
  libraryRecordingSchema,
  recordingConfigSchema,
  recordingMarkerSchema,
  recordingProfileSchema,
  recordingStatsSchema,
  recordingStatusSchema,
  recoveryScanResultSchema,
  recordingSmartZoomSchema,
  videoDeviceSchema,
} from "@recordforge/contracts"
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
  RecordingSmartZoom,
  RecordingStats,
  RecordingStatus,
  RecoveryScanResult,
  VideoDevice,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export async function listCaptureSources(): Promise<CaptureSource[]> {
  return invokeValidated("list_capture_sources", undefined, z.array(captureSourceSchema))
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  return invokeValidated("list_audio_devices", undefined, z.array(audioDeviceSchema))
}

export async function listVideoDevices(): Promise<VideoDevice[]> {
  return invokeValidated("list_video_devices", undefined, z.array(videoDeviceSchema))
}

export async function listBuiltinProfiles(): Promise<RecordingProfile[]> {
  return invokeValidated("list_builtin_profiles", undefined, z.array(recordingProfileSchema))
}

export async function getRecordingSmartZoom(
  recordingId: string,
): Promise<RecordingSmartZoom | null> {
  return invokeValidated(
    "get_recording_smart_zoom",
    { recordingId },
    recordingSmartZoomSchema.nullable(),
  )
}

export async function startRecording(config: RecordingConfig): Promise<string> {
  return invokeValidated(
    "start_recording",
    { config: recordingConfigSchema.parse(config) },
    z.string(),
  )
}

export async function prepareRecording(
  config: RecordingConfig,
  countdownSeconds: number,
): Promise<string> {
  return invokeValidated(
    "prepare_recording",
    { config: recordingConfigSchema.parse(config), countdownSeconds },
    z.string(),
  )
}

export async function confirmRecordingStart(sessionId: string): Promise<void> {
  return invokeValidated<void>("confirm_recording_start", { sessionId })
}

export async function cancelRecordingStart(sessionId: string): Promise<void> {
  return invokeValidated<void>("cancel_recording_start", { sessionId })
}

export async function pauseRecording(): Promise<RecordingStatus> {
  return invokeValidated("pause_recording", undefined, recordingStatusSchema)
}

export async function resumeRecording(): Promise<RecordingStatus> {
  return invokeValidated("resume_recording", undefined, recordingStatusSchema)
}

export async function stopRecording(): Promise<RecordingStats> {
  return invokeValidated("stop_recording", undefined, recordingStatsSchema)
}

export async function discardRecording(): Promise<void> {
  return invokeValidated<void>("discard_recording")
}

export async function getRecordingStatus(): Promise<RecordingStatus> {
  return invokeValidated("recording_status", undefined, recordingStatusSchema)
}

export async function insertMarker(label: string): Promise<RecordingMarker> {
  return invokeValidated("insert_marker", { label }, recordingMarkerSchema)
}

export async function detectHardwareEncoders(): Promise<EncoderInfo[]> {
  return invokeValidated("detect_hardware_encoders", undefined, z.array(encoderInfoSchema))
}

export async function getDiagnosticsReport(): Promise<DiagnosticsReport> {
  return invokeValidated("get_diagnostics_report", undefined, diagnosticsReportSchema)
}

export async function scanRecoverySessions(): Promise<RecoveryScanResult[]> {
  return invokeValidated("scan_recovery_sessions", undefined, z.array(recoveryScanResultSchema))
}

export async function recoverSession(sessionId: string): Promise<LibraryRecording> {
  return invokeValidated("recover_session", { sessionId }, libraryRecordingSchema)
}

export async function deleteRecoverySession(sessionId: string): Promise<void> {
  return invokeValidated<void>("delete_recovery_session", { sessionId })
}

export async function runBenchmark(): Promise<BenchmarkReport> {
  return invokeValidated("run_encoder_benchmark", undefined, benchmarkReportSchema)
}

export async function openFloatingControls(): Promise<void> {
  return invokeValidated<void>("open_floating_controls")
}

export async function openRegionPicker(): Promise<void> {
  return invokeValidated<void>("open_region_picker")
}

export async function cancelRegionPicker(): Promise<void> {
  return invokeValidated<void>("cancel_region_picker")
}

export async function showMainWindow(): Promise<void> {
  return invokeValidated<void>("show_main_window")
}

export async function openBoundaryOverlay(): Promise<void> {
  return invokeValidated<void>("open_boundary_overlay")
}

export async function hideBoundaryOverlay(): Promise<void> {
  return invokeValidated<void>("hide_boundary_overlay")
}

export async function hideFloatingControls(): Promise<void> {
  return invokeValidated<void>("hide_floating_controls")
}
