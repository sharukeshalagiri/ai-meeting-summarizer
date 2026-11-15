import { Router } from "express";
import {
  changePassword,
  login,
  logout,
  me,
  signup,
} from "../controllers/auth.controller";
import { requireUser } from "../middleware/auth.middleware";

/** /api/auth: the only routes reachable without a session. */
const router = Router();

router.post("/login", login);
router.post("/logout", logout);
router.get("/me", me);
router.post("/signup", signup);
router.post("/password", requireUser, changePassword);

export default router;
