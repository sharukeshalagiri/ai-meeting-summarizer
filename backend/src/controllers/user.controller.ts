import { Request, Response } from "express";
import { currentUserId } from "../middleware/auth.middleware";
import * as userService from "../services/user.service";
import { sendSuccess } from "../types/api";
import { AppError } from "../types/errors";
import { asyncHandler } from "../utils/asyncHandler";

/** Replaced by POST /auth/signup; kept so old clients get a clear answer. */
export const createUser = asyncHandler(async () => {
  throw new AppError("Create accounts with POST /api/auth/signup.", 410);
});

export const getUsers = asyncHandler(
  async (req: Request, res: Response) => {
    const users = await userService.listUsers(currentUserId(req));

    return sendSuccess(res, users, "Users fetched");
  }
);
