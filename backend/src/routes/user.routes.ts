import express from "express";
import {
  createUser,
  getUsers,
} from "../controller/user.controller";

const router = express.Router();

router.post("/", createUser);
router.get("/", getUsers);

export default router;