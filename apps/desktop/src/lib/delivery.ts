import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  DELIVERY_PROGRESS_EVENT,
  deliveryProgressSchema,
  mediaJobSchema,
  type DeliveryProgress,
  type JobDeliveryKind,
  type MediaJob,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

/**
 * Re-run one post-export delivery on a completed export — the durable job
 * request carries the spec, so a failed share/publish retries without
 * re-rendering.
 */
export async function retryExportDelivery(jobId: string, kind: JobDeliveryKind): Promise<MediaJob> {
  return invokeValidated("retry_export_delivery", { jobId, kind }, mediaJobSchema)
}

/** Byte-level progress for whichever delivery a job is currently running. */
export function onDeliveryProgress(
  handler: (progress: DeliveryProgress) => void,
): Promise<UnlistenFn> {
  return listen<unknown>(DELIVERY_PROGRESS_EVENT, (event) => {
    const parsed = deliveryProgressSchema.safeParse(event.payload)
    if (parsed.success) handler(parsed.data)
  })
}
