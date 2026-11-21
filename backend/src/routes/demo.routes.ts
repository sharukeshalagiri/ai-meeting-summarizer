import { Router } from "express";
import { demoLogin, getDemo } from "../controllers/demo.controller";

/**
 * /api/demo: both endpoints are public and return no
 * meeting data.
 *
 * - GET  /api/demo        { enabled, readOnly }
 * - POST /api/demo/login  signs in as the demo account (DEMO_MODE only)
 *
 * Mounted directly in routes/index.ts; test/accounts/isolation.test.ts
 * classifies both routes as public.
 */
const router = Router();

router.get("/", getDemo);
router.post("/login", demoLogin);

export const demoRouter = router;
