// Media ingest pipeline — OD-4.
//
// ingestMedia(bytes, mime, entity, key?) orchestrates:
//   1. storage.put  — persist bytes, get a portable ref.
//   2. writeMediaObject — write the media_objects row synchronously.
//      The row is committed (bytes safe) before vision runs.
//   3. Vision step fires fire-and-forget (same off-response-path pattern
//      as semantic extraction in attend.ts). If vision is off or fails,
//      description_text stays null and visionStatus = "failed".
//
// Return value: the row id, returned synchronously before vision completes.
// Callers should not wait on vision; the description lands asynchronously.

import { normalizeKey } from "../library/keys.js";
import { storage } from "./storage.js";
import { vision } from "./vision.js";
import {
  writeMediaObject,
  updateMediaDescription,
  markVisionFailed,
} from "../library/media.js";

// Sane default to guard against very large uploads (100 MB). Callers can
// bypass by constructing the ingest pipeline directly, but the MCP tool
// enforces this.
export const MEDIA_MAX_BYTES = Number(process.env["IRANTI_MEDIA_MAX_BYTES"] ?? 100 * 1024 * 1024);

export interface IngestMediaInput {
  bytes: Buffer;
  mime: string;
  entityType: string;
  entityId: string;
  key?: string;          // semantic slot; normalized via normalizeKey
  tenantId?: string;
  project?: string;      // Layer 0 (D6): dedicated project scope
  ext?: string;          // file extension hint (inferred from mime if omitted)
}

export interface IngestMediaResult {
  id: string;
  objectUrl: string;
  key: string;
  sizeBytes: number;
}

export async function ingestMedia(input: IngestMediaInput): Promise<IngestMediaResult> {
  if (input.bytes.length > MEDIA_MAX_BYTES) {
    throw new Error(
      `Media object exceeds size limit (${input.bytes.length} > ${MEDIA_MAX_BYTES} bytes).`,
    );
  }

  const tenantId = input.tenantId ?? "default";
  const rawKey = input.key ?? deriveKey(input.mime);
  const key = normalizeKey(rawKey);

  // Compute SHA-256 for provenance; stored in metadata.
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  // 1. Store bytes — put is the durable anchor; if this fails, nothing is written.
  const { ref, sizeBytes } = await storage.put(input.bytes, {
    mime: input.mime,
    ext: input.ext,
    tenant: tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    normalizedKey: key,
  });

  // 2. Write the row synchronously so the object is retrievable immediately.
  const row = await writeMediaObject({
    tenantId,
    project: input.project ?? "default",
    entityType: input.entityType,
    entityId: input.entityId,
    key,
    objectUrl: ref,
    mimeType: input.mime,
    metadata: {
      sha256,
      bytes: sizeBytes,
      visionStatus: "pending",
      rawKey: rawKey !== key ? rawKey : undefined,
    },
  });

  // 3. Vision step — fire-and-forget, never blocks the caller.
  void (async () => {
    const result = await vision.describe(input.bytes, input.mime);
    if (result) {
      await updateMediaDescription(
        row.id,
        result.description,
        result.tags,
        process.env["IRANTI_VISION_MODEL"] ?? "llava",
      );
    } else {
      await markVisionFailed(row.id);
    }
  })().catch((err: unknown) =>
    console.error("[iranti] media vision error:", err),
  );

  return { id: row.id, objectUrl: ref, key, sizeBytes };
}

// Derive a generic semantic key from the mime type when the caller omits one.
function deriveKey(mime: string): string {
  const [type, subtype = "file"] = mime.split("/");
  if (type === "image") return `image:${subtype}`;
  if (type === "application" && subtype === "pdf") return "document:pdf";
  return `file:${subtype}`;
}
