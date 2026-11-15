import { Router } from "express";
import { getHealth, getReadiness } from "../controllers/w3-jobs.controller";

/**
 * Health with the job queue's state (track w3-jobs), mounted at
 * /api/health. The root GET /health (app.ts) stays the plain liveness
 * probe.
 */
const router = Router();

// Liveness plus queue: "up" | "down"; always 200.
router.get("/", getHealth);
// Readiness: 503 while the job queue is down.
router.get("/ready", getReadiness);

export default router;
