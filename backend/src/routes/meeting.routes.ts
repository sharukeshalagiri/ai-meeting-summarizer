import express from "express";
import {
  createMeeting,
  getMeetings,
  getMeetingById,
} from "../controller/meeting.controller";

const router = express.Router();

router.post("/", createMeeting);
router.get("/", getMeetings);
router.get("/:id", getMeetingById);

export default router;