import { Request, Response } from "express";
import * as actionItemService from "../services/actionItem.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";
import { optionalString, requireParam } from "../utils/validate";

export const getActionItems = asyncHandler(
  async (req: Request, res: Response) => {
    const items = await actionItemService.listActionItems(
      optionalString(req.query.status)
    );

    return sendSuccess(res, items, "Action items fetched");
  }
);

export const updateActionItemStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const item = await actionItemService.setStatus(
      requireParam(req.params.id, "action item id"),
      optionalString(req.body?.status)
    );

    return sendSuccess(res, item, "Action item updated");
  }
);
