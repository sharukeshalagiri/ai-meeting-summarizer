import { Router } from "express";
import {
  acceptSpeakerSuggestion,
  getSpeakers,
  renameSpeaker,
} from "../controllers/speakers.controller";

/**
 * Speaker endpoints, mounted under /api/meetings next to
 * meeting.routes.ts. None of these paths overlap existing ones.
 */
const router = Router();

router.get("/:id/speakers", getSpeakers);
router.patch("/:id/speakers/:key", renameSpeaker);
router.post("/:id/speakers/:key/accept", acceptSpeakerSuggestion);

export default router;
