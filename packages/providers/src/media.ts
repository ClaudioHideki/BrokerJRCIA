export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export type MediaKind = "image" | "audio" | "video" | "document" | "sticker";
export interface BinaryMedia {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  kind: MediaKind;
  caption?: string;
}
export class MediaError extends Error {
  constructor(
    readonly code: string,
    readonly retrySafe = false,
  ) {
    super(code);
  }
}
const types: Record<string, MediaKind> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "sticker",
  "audio/aac": "audio",
  "audio/mp4": "audio",
  "audio/mpeg": "audio",
  "audio/amr": "audio",
  "audio/ogg": "audio",
  "video/mp4": "video",
  "video/3gpp": "video",
  "application/pdf": "document",
  "text/plain": "document",
  "application/msword": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "document",
};
export function mediaKind(mimeType: string): MediaKind {
  const kind = types[mimeType.toLowerCase().split(";")[0]!.trim()];
  if (!kind) throw new MediaError("MEDIA_TYPE_UNSUPPORTED");
  return kind;
}
export function safeMediaName(value: string): string {
  return (
    value
      .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120) || "arquivo"
  );
}
export function validateMedia(media: BinaryMedia): void {
  if (
    !(media.bytes instanceof Uint8Array) ||
    !media.bytes.length ||
    media.bytes.length > MAX_MEDIA_BYTES
  )
    throw new MediaError("MEDIA_SIZE_LIMIT");
  if (mediaKind(media.mimeType) !== media.kind)
    throw new MediaError("MEDIA_TYPE_UNSUPPORTED");
  if (
    (media.kind === "image" && media.bytes.length > 5 * 1024 * 1024) ||
    (media.kind === "sticker" && media.bytes.length > 500 * 1024)
  )
    throw new MediaError("MEDIA_SIZE_LIMIT");
  if (media.caption && media.caption.length > 1024)
    throw new MediaError("MEDIA_CAPTION_LIMIT");
}
export async function readMediaBytes(
  response: Response,
  maximum = MAX_MEDIA_BYTES,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maximum) {
    await response.body?.cancel();
    throw new MediaError("MEDIA_SIZE_LIMIT");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MediaError("MEDIA_DOWNLOAD_FAILED", true);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new MediaError("MEDIA_SIZE_LIMIT");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new MediaError("MEDIA_DOWNLOAD_FAILED", true);
  return new Uint8Array(Buffer.concat(chunks));
}
