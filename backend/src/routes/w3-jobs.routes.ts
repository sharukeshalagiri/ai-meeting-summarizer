import { Router } from "express";
import {
  getMeetingEvents,
  retryMeetingProcessing,
  startMeetingProcessing,
} from "../controllers/meeting.controller";

/**
 * Background-processing endpoints (track w3-jobs), mounted under
 * /api/meetings next to meeting.routes.ts. None of these paths overlap
 * the ones meeting.routes.ts or w1-sum.routes.ts define.
 */
const router = Router();

// Queue the whole pipeline for an uploaded recording (202).
router.post("/:id/process", startMeetingProcessing);
// Resume a failed or stalled pipeline from the right step (202).
router.post("/:id/retry", retryMeetingProcessing);
// Progress as Server-Sent Events.
router.get("/:id/events", getMeetingEvents);

export default router;
