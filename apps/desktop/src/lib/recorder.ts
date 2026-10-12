import { z } from "zod"
import {
  audioDeviceSchema,
  benchmarkReportSchema,
  cameraCapturePlanSchema,
  captureSourceSchema,
  diagnosticsReportSchema,
  encoderInfoSchema,
  libraryRecordingSchema,
  permissionKindSchema,
  privacyPaneSchema,
  recordingConfigSchema,
  recordingMarkerSchema,
  recordingProfileSchema,
  recordingStatsSchema,
  recordingStatusSchema,
  recoveryScanResultSchema,
  recordingSmartZoomSchema,
  recordingStorageInfoSchema,
  systemPermissionsReportSchema,
  videoDeviceSchema,
} from "@recordforge/contracts"
import type {
  AudioDevice,
  BenchmarkReport,
  CameraCapturePlan,
  CaptureSource,
  DiagnosticsReport,
  EncoderInfo,
  LibraryRecording,
  PermissionKind,
  PrivacyPane,
  RecordingConfig,
  RecordingMarker,
  RecordingProfile,
  RecordingSmartZoom,
  RecordingStats,
  RecordingStatus,
  RecordingStorageInfo,
  RecoveryScanResult,
  SystemPermissionsReport,
  VideoDevice,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export async function listCaptureSources(): Promise<CaptureSource[]> {
  return invokeValidated("list_capture_sources", undefined, z.array(captureSourceSchema))
}

// Truthful OS permission snapshot — the macOS recording modal renders the
// missing-grant banner from this; other platforms report all-granted.
export async function getSystemPermissions(): Promise<SystemPermissionsReport> {
  return invokeValidated("get_system_permissions", undefined, systemPermissionsReportSchema)
}

// Fire the OS prompt where one exists, then re-read the report.
export async function requestSystemPermission(
  kind: PermissionKind,
): Promise<SystemPermissionsReport> {
  return invokeValidated(
    "request_system_permission",
    { kind: permissionKindSchema.parse(kind) },
    systemPermissionsReportSchema,
  )
}

// Deep-link to System Settings → Privacy & Security on macOS.
export async function openPrivacySettings(pane: PrivacyPane): Promise<void> {
  return invokeValidated<void>("open_privacy_settings", {
    pane: privacyPaneSchema.parse(pane),
  })
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

export async function planCameraTiers(deviceId: string): Promise<CameraCapturePlan[]> {
  return invokeValidated("plan_camera_tiers", { deviceId }, z.array(cameraCapturePlanSchema))
}

export async function getRecordingStorageInfo(): Promise<RecordingStorageInfo> {
  return invokeValidated("get_recording_storage_info", undefined, recordingStorageInfoSchema)
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

// Teleprompter (Pro) — capture-protected floating notes window.
export async function openTeleprompter(): Promise<void> {
  return invokeValidated<void>("open_teleprompter")
}

export async function closeTeleprompter(): Promise<void> {
  return invokeValidated<void>("close_teleprompter")
}

export async function teleprompterIsOpen(): Promise<boolean> {
  return invokeValidated("teleprompter_is_open", {}, z.boolean())
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

export async function openWebcamPreview(): Promise<void> {
  return invokeValidated<void>("open_webcam_preview")
}

export async function hideWebcamPreview(): Promise<void> {
  return invokeValidated<void>("hide_webcam_preview")
}
