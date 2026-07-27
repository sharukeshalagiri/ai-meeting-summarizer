import { Request, Response, NextFunction } from "express";
import * as meetingService from "../services/meeting.service";
import { sendSuccess } from "../types/api";

export const createMeeting = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const meeting = await meetingService.createMeeting(req.body);

    return sendSuccess(res, meeting, "Meeting created", 201);
  } catch (error) {
    return next(error);
  }
};

export const getMeetings = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const meetings = await meetingService.listMeetings();

    return sendSuccess(res, meetings, "Meetings fetched");
  } catch (error) {
    return next(error);
  }
};

export const getMeetingById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const meeting = await meetingService.getMeeting(
      req.params.id as string
    );

    return sendSuccess(res, meeting, "Meeting fetched");
  } catch (error) {
    return next(error);
  }
};
