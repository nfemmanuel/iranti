// Media storage backend — OD-4.
//
// StorageBackend is the interface; LocalFsStorageBackend is the default impl.
// This mirrors the GraphBackend pattern exactly: interface + default local impl
// + a module-level singleton, so an S3 backend slots in by reassigning the
// exported `storage` value without touching callers.
//
// Object refs use a portable scheme:
//   local:  file://<relative-path-under-IRANTI_MEDIA_ROOT>
//   S3:     s3://bucket/key   (future — interface is ready, impl is not)
//
// Disk layout:
//   <IRANTI_MEDIA_ROOT>/<tenant>/<entityType>/<entityId>/<normalizedKey>/<uuid>.<ext>

import { createWriteStream } from "node:fs";
import { mkdir, unlink, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PutOptions {
  mime: string;
  ext?: string;   // e.g. "png"; inferred from mime if omitted
  tenant?: string;
  entityType: string;
  entityId: string;
  normalizedKey: string;
}

export interface PutResult {
  ref: string;      // portable ref stored in media_objects.object_url
  sizeBytes: number;
}

export interface StorageBackend {
  /** Store bytes; return a portable ref and size. */
  put(bytes: Buffer, opts: PutOptions): Promise<PutResult>;
  /** Retrieve bytes by ref. Throws if not found. */
  get(ref: string): Promise<Buffer>;
  /** Delete stored bytes. Non-fatal if ref does not exist. */
  delete(ref: string): Promise<void>;
  /** Resolve a portable ref to an absolute URL / path callers can use. */
  resolveUrl(ref: string): string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

function extFromMime(mime: string, hint?: string): string {
  if (hint) return hint.replace(/^\./, "");
  return MIME_TO_EXT[mime] ?? "bin";
}

// ---------------------------------------------------------------------------
// LocalFsStorageBackend
// ---------------------------------------------------------------------------

export class LocalFsStorageBackend implements StorageBackend {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(bytes: Buffer, opts: PutOptions): Promise<PutResult> {
    const tenant = opts.tenant ?? "default";
    const ext = extFromMime(opts.mime, opts.ext);
    const uuid = randomUUID();
    // Colons are illegal in Windows path components — encode as double-underscore.
    // The ref carries the same encoding so _absPath is consistent.
    const safeKey = opts.normalizedKey.replace(/:/g, "__");
    // Relative path inside the media root — this is what goes in object_url.
    const relPath = join(tenant, opts.entityType, opts.entityId, safeKey, `${uuid}.${ext}`);
    const absPath = join(this.root, relPath);

    await mkdir(join(this.root, tenant, opts.entityType, opts.entityId, safeKey), { recursive: true });

    await pipeline(Readable.from(bytes), createWriteStream(absPath));

    return { ref: `file://${relPath.replace(/\\/g, "/")}`, sizeBytes: bytes.length };
  }

  async get(ref: string): Promise<Buffer> {
    const absPath = this._absPath(ref);
    return readFile(absPath);
  }

  async delete(ref: string): Promise<void> {
    try {
      await unlink(this._absPath(ref));
    } catch (err: unknown) {
      // Non-fatal: file already gone is fine.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  resolveUrl(ref: string): string {
    return this._absPath(ref);
  }

  private _absPath(ref: string): string {
    if (!ref.startsWith("file://")) throw new Error(`Unsupported ref scheme: ${ref}`);
    const relPath = ref.slice("file://".length);
    return join(this.root, relPath);
  }
}

// ---------------------------------------------------------------------------
// Singleton — selected by IRANTI_MEDIA_BACKEND env var
// ---------------------------------------------------------------------------

function buildStorage(): StorageBackend {
  const backend = process.env["IRANTI_MEDIA_BACKEND"] ?? "local";
  if (backend === "local") {
    const root = process.env["IRANTI_MEDIA_ROOT"] ?? "./media";
    return new LocalFsStorageBackend(root);
  }
  // S3 backend: interface is ready; implementation deferred to Phase-5 cloud.
  throw new Error(`IRANTI_MEDIA_BACKEND="${backend}" is not yet implemented. Supported: local`);
}

// Lazy singleton — defers buildStorage() (and its env-var throw) to first use,
// so a misconfigured backend does not crash the MCP server at import time.
let _storage: StorageBackend | undefined;

function getStorage(): StorageBackend {
  if (!_storage) _storage = buildStorage();
  return _storage;
}

export const storage: StorageBackend = {
  put: (bytes, opts) => getStorage().put(bytes, opts),
  get: (ref) => getStorage().get(ref),
  delete: (ref) => getStorage().delete(ref),
  resolveUrl: (ref) => getStorage().resolveUrl(ref),
};
