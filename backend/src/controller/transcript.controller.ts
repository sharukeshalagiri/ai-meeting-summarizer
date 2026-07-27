import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { sendSuccess } from "../types/api";
import { BadRequest } from "../types/errors";

export const createTranscript = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { meetingId, content } = req.body;

    if (typeof meetingId !== "string" || typeof content !== "string") {
      throw BadRequest("meetingId and content are required");
    }

    const transcript = await prisma.transcript.create({
      data: { meetingId, content },
    });

    return sendSuccess(res, transcript, "Transcript created", 201);
  } catch (error) {
    return next(error);
  }
};

export const getTranscripts = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const transcripts = await prisma.transcript.findMany({
      include: { meeting: true },
    });

    return sendSuccess(res, transcripts, "Transcripts fetched");
  } catch (error) {
    return next(error);
  }
};
