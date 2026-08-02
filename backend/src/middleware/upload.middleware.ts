import fs from "fs";
import multer, { MulterError } from "multer";
import path from "path";
import { NextFunction, Request, Response } from "express";
import { env } from "../lib/env";
import { AppError, BadRequest } from "../types/errors";
import {
  ALLOWED_MEDIA_EXTENSIONS,
  ALLOWED_MEDIA_MIME_TYPES,
} from "../utils/media";

// multer will not create the destination for us.
fs.mkdirSync(env.uploadDir, { recursive: true });
fs.mkdirSync(env.liveChunkDir, { recursive: true });

const storageIn = (directory: string) =>
  multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, directory);
    },

    filename: (_req, file, cb) => {
      // Strip characters that are unsafe in a Windows path.
      const safeName = file.originalname.replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );

      cb(null, `${Date.now()}-${safeName}`);
    },
  });

const storage = storageIn(env.uploadDir);

export const upload = multer({
  storage,

  limits: {
    fileSize: env.maxUploadBytes,
  },

  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();

    if (
      ALLOWED_MEDIA_MIME_TYPES.has(file.mimetype) ||
      ALLOWED_MEDIA_EXTENSIONS.has(extension)
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
 * Live capture chunks.
 *
 * Separate from `upload` because a chunk is a few seconds of webm
 * rather than a whole recording: it lands in its own directory (the
 * files are deleted once transcribed) and is capped far lower, so a
 * runaway client cannot fill the disk.
 */
export const uploadChunk = multer({
  storage: storageIn(env.liveChunkDir),

  limits: {
    fileSize: env.maxChunkBytes,
  },

  fileFilter: (_req, file, cb) => {
    // MediaRecorder emits audio/webm, and Chrome appends a codec
    // parameter, so match on the prefix rather than an exact type.
    if (
      file.mimetype.startsWith("audio/") ||
      file.mimetype.startsWith("video/")
    ) {
      cb(null, true);
      return;
    }

    cb(new Error(`Unsupported chunk type "${file.mimetype}".`));
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
        ? `File is too large. Maximum size is ${Math.round(
            env.maxUploadBytes / (1024 * 1024)
          )} MB.`
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
