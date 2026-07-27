import { Request, Response } from "express";
import * as userService from "../services/user.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";
import { requireString } from "../utils/validate";

export const createUser = asyncHandler(
  async (req: Request, res: Response) => {
    const user = await userService.createUser({
      name: requireString(req.body?.name, "name", { maxLength: 120 }),
      email: requireString(req.body?.email, "email", { maxLength: 200 }),
    });

    return sendSuccess(res, user, "User created", 201);
  }
);

export const getUsers = asyncHandler(
  async (_req: Request, res: Response) => {
    const users = await userService.listUsers();

    return sendSuccess(res, users, "Users fetched");
  }
);
