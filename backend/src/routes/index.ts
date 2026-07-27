import { Router } from "express";
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

export default router;
