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

export default router;
