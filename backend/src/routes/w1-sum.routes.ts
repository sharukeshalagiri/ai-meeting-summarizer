import { Router } from "express";
import {
  getSummaryReview,
  resummarizeMeeting,
  reviewActionItem,
  updateMeetingMode,
} from "../controllers/w1-sum.controller";

/**
 * Summary intelligence endpoints (track w1-sum), mounted under
 * /api/meetings next to meeting.routes.ts. None of these paths overlap
 * the ones meeting.routes.ts defines.
 */
const router = Router();

router.get("/:id/summary-review", getSummaryReview);
router.patch("/:id/mode", updateMeetingMode);
router.post("/:id/resummarize", resummarizeMeeting);
router.post("/:id/action-items/:itemId/review", reviewActionItem);

export default router;
