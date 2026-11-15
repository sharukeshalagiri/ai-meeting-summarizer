import { Router } from "express";
import { emailMeeting, exportMeeting } from "../controllers/export.controller";
import { resolveSinceLastTime, setMeetingSeries } from "../controllers/series.controller";

/**
 * Per-meeting account features (exports, series, "Since last time"),
 * mounted under /api/meetings behind the owner guard. None of these
 * paths overlap the other meeting routers.
 */
const router = Router();

router.get("/:id/export", exportMeeting);
router.post("/:id/export/email", emailMeeting);
router.put("/:id/series", setMeetingSeries);
router.post("/:id/since-last-time/:itemId", resolveSinceLastTime);

export default router;
