import { Router } from "express";
import {
  endLiveSession,
  ingestChunk,
  setRoster,
  startLiveSession,
} from "../controllers/live.controller";
import { requireDeviceToken } from "../middleware/deviceAuth.middleware";
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

router.post("/sessions", startLiveSession);

router.post(
  "/sessions/:id/chunks",
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
