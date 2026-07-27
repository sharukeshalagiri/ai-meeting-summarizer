import express from "express";
import { transcribeMeeting } from "../controller/ai.controller";

const router = express.Router();

router.post(
  "/meetings/:id/transcribe",
  transcribeMeeting
);

export default router;