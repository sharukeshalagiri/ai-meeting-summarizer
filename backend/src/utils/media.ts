/**
 * Accepted upload formats.
 *
 * Sets rather than arrays: lookup is by membership, and keeping the
 * list here means the frontend's accept attribute and the server's
 * filter have one source of truth to track.
 */
export const ALLOWED_MEDIA_MIME_TYPES = new Set([
  // audio
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "application/ogg",
  "audio/webm",
  "audio/flac",
  // video
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
  "video/mpeg",
]);

/**
 * Browsers report media types inconsistently — .mkv and .m4a often
 * arrive as application/octet-stream or an empty string — so the
 * extension is checked before a file is rejected.
 */
export const ALLOWED_MEDIA_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".flac",
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
]);
