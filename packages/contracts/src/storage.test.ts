import { describe, expect, test } from "vitest"
import {
  ConnectionTestResultSchema,
  SaveGoogleDriveProfileInputSchema,
  SaveS3ProfileInputSchema,
  StorageProfileSchema,
  UploadJobSchema,
} from "./storage"

describe("Storage Contracts", () => {
  test("StorageProfileSchema successfully parses Rust JSON payloads with nulls", () => {
    // S3 profile serialized from Rust with null drive_config and local_config
    const s3Payload = {
      id: "s3-uuid-1234",
      name: "My AWS S3",
      kind: "s3",
      isDefault: true,
      s3Config: {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        bucket: "recordforge-bucket",
        prefix: "recordings",
        partSizeBytes: 8388608,
        forcePathStyle: false,
      },
      driveConfig: null,
      localConfig: null,
      hasCredentials: true,
      createdAt: "2026-08-21T10:00:00Z",
      updatedAt: "2026-08-21T10:00:00Z",
    }

    const parsedS3 = StorageProfileSchema.parse(s3Payload)
    expect(parsedS3.id).toBe("s3-uuid-1234")
    expect(parsedS3.kind).toBe("s3")
    expect(parsedS3.s3Config?.bucket).toBe("recordforge-bucket")
    expect(parsedS3.driveConfig).toBeNull()
    expect(parsedS3.localConfig).toBeNull()

    // Google Drive profile serialized from Rust with null s3_config and local_config
    const gdrivePayload = {
      id: "gdrive-uuid-5678",
      name: "My Google Drive",
      kind: "gdrive",
      isDefault: false,
      s3Config: null,
      driveConfig: {
        folderId: "root",
        folderName: "recordForge",
        accountEmail: "user@example.com",
        chunkSizeBytes: 5242880,
      },
      localConfig: null,
      hasCredentials: true,
      createdAt: "2026-08-21T10:00:00Z",
      updatedAt: "2026-08-21T10:00:00Z",
    }

    const parsedGdrive = StorageProfileSchema.parse(gdrivePayload)
    expect(parsedGdrive.id).toBe("gdrive-uuid-5678")
    expect(parsedGdrive.kind).toBe("gdrive")
    expect(parsedGdrive.driveConfig?.folderName).toBe("recordForge")
    expect(parsedGdrive.s3Config).toBeNull()
    expect(parsedGdrive.localConfig).toBeNull()

    // Local folder profile serialized from Rust
    const localPayload = {
      id: "local-uuid-9999",
      name: "Local Videos",
      kind: "local",
      isDefault: false,
      s3Config: null,
      driveConfig: null,
      localConfig: {
        destinationPath: "C:\\Users\\User\\Videos",
      },
      hasCredentials: true,
      createdAt: "2026-08-21T10:00:00Z",
      updatedAt: "2026-08-21T10:00:00Z",
    }

    const parsedLocal = StorageProfileSchema.parse(localPayload)
    expect(parsedLocal.id).toBe("local-uuid-9999")
    expect(parsedLocal.kind).toBe("local")
    expect(parsedLocal.localConfig?.destinationPath).toBe("C:\\Users\\User\\Videos")
  })

  test("SaveS3ProfileInputSchema accepts empty credentials for existing profile edits", () => {
    const editInput = {
      id: "s3-uuid-1234",
      name: "Updated Name",
      config: {
        endpoint: "https://s3.eu-central-1.amazonaws.com",
        region: "eu-central-1",
        bucket: "updated-bucket",
      },
      accessKeyId: "",
      secretAccessKey: "",
      isDefault: true,
    }

    const parsed = SaveS3ProfileInputSchema.parse(editInput)
    expect(parsed.name).toBe("Updated Name")
    expect(parsed.accessKeyId).toBe("")
    expect(parsed.secretAccessKey).toBe("")
    expect(parsed.config.prefix).toBe("")
    expect(parsed.config.forcePathStyle).toBe(false)
  })

  test("SaveGoogleDriveProfileInputSchema accepts valid input with default fields", () => {
    const input = {
      name: "Work Drive",
      config: {
        folderName: "Recordings",
      },
    }

    const parsed = SaveGoogleDriveProfileInputSchema.parse(input)
    expect(parsed.name).toBe("Work Drive")
    expect(parsed.config.folderId).toBe("root")
    expect(parsed.config.folderName).toBe("Recordings")
    expect(parsed.isDefault).toBe(false)
  })

  test("UploadJobSchema parses Rust JSON payloads with nullable fields", () => {
    const jobPayload = {
      id: "job-1",
      providerProfileId: "s3-uuid-1234",
      providerProfileName: null,
      providerKind: "s3",
      recordingId: null,
      exportId: null,
      localPath: "C:\\Videos\\recording.mp4",
      remotePath: "recordings/recording.mp4",
      state: "pending",
      bytesUploaded: 0,
      totalBytes: 1048576,
      speedBps: 0,
      remoteUrl: null,
      retryCount: 0,
      lastError: null,
      createdAt: "2026-08-21T10:00:00Z",
      updatedAt: "2026-08-21T10:00:00Z",
      completedAt: null,
    }

    const parsed = UploadJobSchema.parse(jobPayload)
    expect(parsed.id).toBe("job-1")
    expect(parsed.state).toBe("pending")
    expect(parsed.remoteUrl).toBeNull()
    expect(parsed.lastError).toBeNull()
  })

  test("ConnectionTestResultSchema parses results with nullable latencyMs and details", () => {
    const resultPayload = {
      ok: true,
      message: "Connection successful",
      latencyMs: null,
      details: null,
    }

    const parsed = ConnectionTestResultSchema.parse(resultPayload)
    expect(parsed.ok).toBe(true)
    expect(parsed.latencyMs).toBeNull()
  })
})
