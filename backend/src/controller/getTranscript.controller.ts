import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { sendSuccess } from "../types/api";
import { NotFound } from "../types/errors";

export const getTranscript = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const meetingId = req.params.id as string;

    const transcript = await prisma.transcript.findUnique({
      where: { meetingId },
    });

    if (!transcript) {
      throw NotFound("Transcript not found");
    }

    return sendSuccess(res, transcript, "Transcript fetched");
  } catch (error) {
    return next(error);
  }
};
