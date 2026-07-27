import express from "express";
import {
  upload,
  handleUploadErrors,
} from "../middleware/upload.middleware";
import {
  uploadMeetingAudio,
  saveMeetingAudio,
} from "../controller/upload.controller";

const router = express.Router();

// Single-request pipeline: upload + transcribe + summarize.
router.post(
  "/meetings/:id/upload",
  upload.single("audio"),
  uploadMeetingAudio
);

// Upload only, so the client can drive each stage and show progress.
router.post(
  "/meetings/:id/audio",
  upload.single("audio"),
  saveMeetingAudio
);

router.use(handleUploadErrors);

export default router;
