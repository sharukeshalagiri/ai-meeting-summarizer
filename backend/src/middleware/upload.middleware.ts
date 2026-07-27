import multer, { MulterError } from "multer";
import fs from "fs";
import path from "path";
import { Request, Response, NextFunction } from "express";
import { AppError, BadRequest } from "../types/errors";

const UPLOAD_DIR = "uploads/meetings";

// multer will not create the destination for us.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

const allowedTypes = [
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
];

// Browsers report media types inconsistently — .mkv and .m4a often
// arrive as application/octet-stream or an empty string — so fall
// back to the extension before rejecting a file.
const allowedExtensions = [
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
];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (_req, file, cb) => {
    // Strip characters that are unsafe in a Windows path.
    const safeName = file.originalname.replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );

    cb(null, Date.now() + "-" + safeName);
  },
});

export const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE,
  },

  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();

    if (
      allowedTypes.includes(file.mimetype) ||
      allowedExtensions.includes(extension)
    ) {
      cb(null, true);
      return;
    }

    cb(
      new Error(
        `Unsupported file type "${file.mimetype || extension}". ` +
          `Upload an audio or video file.`
      )
    );
  },
});

/**
 * Translates multer failures into AppErrors, then hands them to the
 * central error handler so every response shares one shape.
 */
export const handleUploadErrors = (
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (err instanceof MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `File is too large. Maximum size is ${
            MAX_FILE_SIZE / (1024 * 1024)
          } MB.`
        : `Upload failed: ${err.message}`;

    return next(BadRequest(message));
  }

  if (err instanceof AppError) {
    return next(err);
  }

  if (err instanceof Error) {
    return next(BadRequest(err.message));
  }

  return next(err);
};
