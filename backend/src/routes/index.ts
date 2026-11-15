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
import { authMiddleware } from "../lib/auth/session";
import {
  requireMeetingAccess,
  requireUser,
} from "../middleware/auth.middleware";
import { accountRoutes, deviceRoutes, seriesRoutes } from "./account.routes";
import authRoutes from "./auth.routes";
import liveRoutes from "./live.routes";
import meetingExtrasRoutes from "./meetingExtras.routes";
import meetingRoutes from "./meeting.routes";
import transcriptRoutes from "./transcript.routes";
import userRoutes from "./user.routes";
import w1SumRoutes from "./w1-sum.routes";
import w2SpkRoutes from "./w2-spk.routes";
import w3JobsRoutes from "./w3-jobs.routes";
import w3JobsHealthRoutes from "./w3-jobs-health.routes";

/**
 * Single place where the API surface is assembled, so the full set of
 * routes can be seen at a glance.
 *
 * Auth (w4-acct), in this order:
 * 1. Sessions (cookie) are read for every request.
 * 2. Public: /auth (sign in, sign up, me) and /health.
 * 3. /live: device auth (a per-user Bearer token, or the session).
 * 4. Everything else requires a signed-in user, and every
 *    /meetings/:id/... path first checks the meeting is theirs (404
 *    otherwise), whichever router serves it. Lists are scoped by user
 *    in their services and repositories.
 */
const router = Router();

router.use(authMiddleware());

router.use("/auth", authRoutes);
// w3-jobs: health with the queue state, and readiness (503 while it is down).
router.use("/health", w3JobsHealthRoutes);

router.use("/live", liveRoutes);

router.use(requireUser);
router.use("/meetings/:id", requireMeetingAccess);

router.use("/users", userRoutes);
router.use("/meetings", meetingRoutes);
router.use("/transcripts", transcriptRoutes);

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

// w3-jobs: process, retry and the progress stream under /meetings.
router.use("/meetings", w3JobsRoutes);

// w4-acct: settings, devices, series + prep, and per-meeting exports.
router.use("/account", accountRoutes);
router.use("/devices", deviceRoutes);
router.use("/series", seriesRoutes);
router.use("/meetings", meetingExtrasRoutes);

export default router;
