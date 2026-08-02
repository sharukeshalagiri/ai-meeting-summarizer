import { Router } from "express";
import {
  endLiveSession,
  ingestChunk,
  startLiveSession,
} from "../controllers/live.controller";
import {
  handleUploadErrors,
  uploadChunk,
} from "../middleware/upload.middleware";

/** Everything under /api/live. */
const router = Router();

router.post("/sessions", startLiveSession);

router.post(
  "/sessions/:id/chunks",
  uploadChunk.single("chunk"),
  ingestChunk
);

router.post("/sessions/:id/end", endLiveSession);

// Must come after the upload route to catch its multer errors.
router.use(handleUploadErrors);

export default router;
