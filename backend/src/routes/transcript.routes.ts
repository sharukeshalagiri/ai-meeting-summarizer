import { Router } from "express";
import {
  createTranscript,
  getTranscripts,
} from "../controllers/transcript.controller";

const router = Router();

router.post("/", createTranscript);
router.get("/", getTranscripts);

export default router;
