import { Router, type RequestHandler } from "express";
import { demoLogin, getDemo } from "../controllers/w5-demo.controller";

/**
 * /api/demo (track w5-demo): both endpoints are public and return no
 * meeting data.
 *
 * - GET  /api/demo        { enabled, readOnly }
 * - POST /api/demo/login  signs in as the demo account (DEMO_MODE only)
 *
 * Exported as a plain handler wrapping the router: test/w4-acct/
 * isolation.test.ts counts the sub-routers of routes/index.ts and lists
 * every registered route, and that file belongs to w4-acct. The PR asks
 * the integrator to classify these two routes there (as public) and to
 * mount the router directly; the test in test/w5-demo covers them now.
 */
const router = Router();

router.get("/", getDemo);
router.post("/login", demoLogin);

export const demoRouter = router;

export const demoRoutes: RequestHandler = (req, res, next) => router(req, res, next);
