import { Router } from "express";
import {
  getActionItems,
  updateActionItemStatus,
} from "../controllers/actionItem.controller";
import { getOverview } from "../controllers/analytics.controller";
import {
  askQuestion,
  getConversation,
  searchSegments,
} from "../controllers/search.controller";
import liveRoutes from "./live.routes";
import meetingRoutes from "./meeting.routes";
import transcriptRoutes from "./transcript.routes";
import userRoutes from "./user.routes";
import w1SumRoutes from "./w1-sum.routes";
import w2SpkRoutes from "./w2-spk.routes";

/**
 * Single place where the API surface is assembled, so the full set of
 * routes can be seen at a glance.
 */
const router = Router();

router.use("/users", userRoutes);
router.use("/meetings", meetingRoutes);
router.use("/transcripts", transcriptRoutes);
router.use("/live", liveRoutes);

router.get("/analytics", getOverview);

router.get("/action-items", getActionItems);
router.patch("/action-items/:id", updateActionItemStatus);

router.get("/search", searchSegments);
router.post("/chat", askQuestion);
router.get("/chat/:id", getConversation);

// w1-sum: mode, re-summarize and action item review under /meetings.
router.use("/meetings", w1SumRoutes);

// w2-spk: speakers (list, rename, accept a name suggestion) under /meetings.
router.use("/meetings", w2SpkRoutes);

export default router;
