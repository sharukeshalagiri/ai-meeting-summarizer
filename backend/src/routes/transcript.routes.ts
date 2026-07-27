import express from "express";
import {
  createTranscript,
  getTranscripts,
} from "../controller/transcript.controller";

const router = express.Router();

router.post("/", createTranscript);
router.get("/", getTranscripts);

export default router;