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
import summaryPipelineRoutes from "./summaryPipeline.routes";
import speakersRoutes from "./speakers.routes";
import processingRoutes from "./processing.routes";
import healthRoutes from "./health.routes";
import { demoSearch } from "../controllers/demo.controller";
import { demoReadOnly } from "../middleware/demo.middleware";
import { durationCaps, rateLimit } from "../middleware/rateLimit.middleware";
import { demoRouter } from "./demo.routes";

/**
 * Single place where the API surface is assembled, so the full set of
 * routes can be seen at a glance.
 *
 * Auth, in this order:
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
// Rate limits (per user, else per IP), then the demo account is
// read-only on every route below (middleware/demo.middleware.ts).
router.use(rateLimit);
router.use(demoReadOnly);

router.use("/auth", authRoutes);
// Health with the queue state, and readiness (503 while it is down).
router.use("/health", healthRoutes);
// Demo status and the "Try the demo" sign-in (public).
router.use("/demo", demoRouter);

// MAX_AUDIO_MINUTES for live chunks is checked in live.routes.ts, after device auth.
router.use("/live", liveRoutes);

router.use(requireUser);
router.use("/meetings/:id", requireMeetingAccess);
// MAX_AUDIO_MINUTES, checked before work starts on a recording.
router.post("/meetings/:id/transcribe", durationCaps.recording);
router.post("/meetings/:id/process", durationCaps.recording);
router.post("/meetings/:id/retry", durationCaps.recording);
router.post("/meetings/:id/upload", durationCaps.singleRequestUpload);

router.use("/users", userRoutes);
router.use("/meetings", meetingRoutes);
router.use("/transcripts", transcriptRoutes);

router.get("/analytics", getOverview);

router.get("/action-items", getActionItems);
router.patch("/action-items/:id", updateActionItemStatus);

// The demo account gets a keyword search (no Gemini call).
router.get("/search", demoSearch);
router.get("/search", searchSegments);
router.post("/chat", askQuestion);
router.get("/chat/:id", getConversation);

// Mode, re-summarize and action item review under /meetings.
router.use("/meetings", summaryPipelineRoutes);

// Speakers (list, rename, accept a name suggestion) under /meetings.
router.use("/meetings", speakersRoutes);

// Process, retry and the progress stream under /meetings.
router.use("/meetings", processingRoutes);

// Settings, devices, series + prep, and per-meeting exports.
router.use("/account", accountRoutes);
router.use("/devices", deviceRoutes);
router.use("/series", seriesRoutes);
router.use("/meetings", meetingExtrasRoutes);

export default router;
