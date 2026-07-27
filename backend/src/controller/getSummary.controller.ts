import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { sendSuccess } from "../types/api";
import { NotFound } from "../types/errors";

export const getSummary = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const meetingId = req.params.id as string;

    const summary = await prisma.summary.findUnique({
      where: { meetingId },
    });

    if (!summary) {
      throw NotFound("Summary not found");
    }

    return sendSuccess(res, summary, "Summary fetched");
  } catch (error) {
    return next(error);
  }
};
