import { Router } from "express";
import { summarizeMeeting } from "../controller/summary.controller";

const router = Router();

router.post(
  "/meetings/:id/summarize",
  summarizeMeeting
);

export default router;