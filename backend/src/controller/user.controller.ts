import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { sendSuccess } from "../types/api";
import { BadRequest } from "../types/errors";

export const createUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { name, email } = req.body;

    if (typeof name !== "string" || typeof email !== "string") {
      throw BadRequest("name and email are required");
    }

    const user = await prisma.user.create({
      data: { name, email },
    });

    return sendSuccess(res, user, "User created", 201);
  } catch (error) {
    return next(error);
  }
};

export const getUsers = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const users = await prisma.user.findMany();

    return sendSuccess(res, users, "Users fetched");
  } catch (error) {
    return next(error);
  }
};
