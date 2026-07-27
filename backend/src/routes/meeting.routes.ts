import { Router } from "express";
import {
  summarizeMeeting,
  transcribeMeeting,
} from "../controllers/ai.controller";
import {
  createMeeting,
  getMeetingById,
  getMeetingSummary,
  getMeetingTranscript,
  getMeetings,
} from "../controllers/meeting.controller";
import {
  saveMeetingAudio,
  uploadMeetingAudio,
} from "../controllers/upload.controller";
import {
  handleUploadErrors,
  upload,
} from "../middleware/upload.middleware";

/**
 * Everything under /api/meetings.
 *
 * Previously these were spread across four routers all mounted on
 * /api, which made it easy to register a path that another router
 * already shadowed. One router per resource removes that class of bug.
 */
const router = Router();

router.post("/", createMeeting);
router.get("/", getMeetings);
router.get("/:id", getMeetingById);

router.get("/:id/transcript", getMeetingTranscript);
router.get("/:id/summary", getMeetingSummary);

// Upload only, so the client can drive each stage and show progress.
router.post("/:id/audio", upload.single("audio"), saveMeetingAudio);

// Single-request pipeline: upload + transcribe + summarize.
router.post("/:id/upload", upload.single("audio"), uploadMeetingAudio);

router.post("/:id/transcribe", transcribeMeeting);
router.post("/:id/summarize", summarizeMeeting);

// Must come after the upload routes to catch their multer errors.
router.use(handleUploadErrors);

export default router;
