import { Router } from "express";
import {
  endLiveSession,
  ingestChunk,
  setRoster,
  startLiveSession,
} from "../controllers/live.controller";
import { requireLiveSessionAccess } from "../middleware/auth.middleware";
import { requireDeviceToken } from "../middleware/deviceAuth.middleware";
import { durationCaps } from "../middleware/rateLimit.middleware";
import {
  handleUploadErrors,
  uploadChunk,
} from "../middleware/upload.middleware";

/**
 * Everything under /api/live: the capture contract
 * (docs/CAPTURE_CONTRACT.md) plus the legacy web-page calls, which share
 * the same paths.
 */
const router = Router();

// One auth check for every recorder; see deviceAuth.middleware.ts.
router.use(requireDeviceToken);
// A session of another account is a 404 (before multer stores anything).
router.use("/sessions/:id", requireLiveSessionAccess);

router.post("/sessions", startLiveSession);

router.post(
  "/sessions/:id/chunks",
  // MAX_AUDIO_MINUTES, after auth so a 401/404 is never masked by a 413.
  durationCaps.live,
  // "audio" is the contract field name; "chunk" is the legacy one.
  uploadChunk.fields([
    { name: "audio", maxCount: 1 },
    { name: "chunk", maxCount: 1 },
  ]),
  ingestChunk
);

router.post("/sessions/:id/roster", setRoster);

router.post("/sessions/:id/end", endLiveSession);

// Must come after the upload route to catch its multer errors.
router.use(handleUploadErrors);

export default router;
