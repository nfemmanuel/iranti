// iranti_ingest_media — OD-4.
//
// Accept raw bytes (base64) or a local file path, plus a mime type and
// entity address, then store the object and kick off async vision tagging.
// Returns the media object id, portable ref, and key before vision completes.

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { ingestMedia, MEDIA_MAX_BYTES } from "../../media/index.js";

export const ingestMediaInputSchema = {
  entityType: z.string().min(1).describe("Entity type, e.g. 'project', 'user'."),
  entityId: z.string().min(1).describe("Entity id within the type."),
  key: z
    .string()
    .optional()
    .describe(
      "Semantic slot for this media object, e.g. 'screenshot:login-flow'. " +
        "Normalized via normalizeKey. Defaults to a mime-derived key if omitted.",
    ),
  mime: z
    .string()
    .min(1)
    .describe("IANA media type, e.g. 'image/png', 'application/pdf'."),
  // One of bytes or filePath must be provided.
  bytes: z
    .string()
    .optional()
    .describe("Base64-encoded raw bytes of the object."),
  filePath: z
    .string()
    .optional()
    .describe("Absolute path to a local file to ingest. Used instead of bytes."),
  tenantId: z.string().optional().describe("Tenant scope; defaults to 'default'."),
};

export const ingestMediaInput = z.object(ingestMediaInputSchema).refine(
  (d) => d.bytes !== undefined || d.filePath !== undefined,
  { message: "Either bytes or filePath must be provided." },
);

export type IngestMediaInput = z.infer<typeof ingestMediaInput>;

export async function ingestMediaTool(input: IngestMediaInput) {
  let buf: Buffer;

  if (input.filePath) {
    buf = await readFile(input.filePath);
  } else {
    buf = Buffer.from(input.bytes!, "base64");
  }

  if (buf.length > MEDIA_MAX_BYTES) {
    throw new Error(
      `Media object exceeds the size limit of ${MEDIA_MAX_BYTES} bytes. ` +
        `Received: ${buf.length} bytes.`,
    );
  }

  const result = await ingestMedia({
    bytes: buf,
    mime: input.mime,
    entityType: input.entityType,
    entityId: input.entityId,
    key: input.key,
    tenantId: input.tenantId,
  });

  return {
    id: result.id,
    objectUrl: result.objectUrl,
    key: result.key,
    sizeBytes: result.sizeBytes,
    note: "Object stored. Vision tagging is running asynchronously — description and tags will appear shortly.",
  };
}
