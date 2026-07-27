import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// Must run before any module that reads process.env at import time.
dotenv.config();

import { getTranscript } from "./controller/getTranscript.controller";
import { getSummary } from "./controller/getSummary.controller";

import meetingRoutes from "./routes/meeting.routes";
import transcriptRoutes from "./routes/transcript.routes";
import uploadRoutes from "./routes/upload.routes";
import aiRoutes from "./routes/ai.routes";
import summaryRoutes from "./routes/summary.routes";
import userRoutes from "./routes/user.routes";

import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error.middleware";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "AI Meeting Summarizer API Running",
    data: null,
  });
});

/* ===========================
   API Routes
=========================== */

app.use("/api/users", userRoutes);

app.use("/api/meetings", meetingRoutes);

app.use("/api/transcripts", transcriptRoutes);

app.use("/api", uploadRoutes);

app.use("/api", aiRoutes);

app.use("/api", summaryRoutes);

/* ===========================
   Dashboard APIs
=========================== */

// NOTE: GET /api/meetings is served by meetingRoutes above. Express
// matches in registration order, so re-registering it here would be
// unreachable. The two routes below are not covered by that router.

app.get("/api/meetings/:id/transcript", getTranscript);

app.get("/api/meetings/:id/summary", getSummary);

/* ===========================
   Fallbacks
=========================== */

app.use("/api", notFoundHandler);

app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
