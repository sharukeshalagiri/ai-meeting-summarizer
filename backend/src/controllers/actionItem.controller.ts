import { Request, Response } from "express";
import * as actionItemService from "../services/actionItem.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";
import { currentUserId } from "../middleware/auth.middleware";
import { assertActionItemOwner } from "../services/account/access.service";
import { withOwnerNames } from "../services/speakers/speakers.service";
import { optionalString, requireParam } from "../utils/validate";

export const getActionItems = asyncHandler(
  async (req: Request, res: Response) => {
    const items = await actionItemService.listActionItems(
      currentUserId(req),
      optionalString(req.query.status)
    );

    // Owners show the speakers' current names (read-time).
    return sendSuccess(res, await withOwnerNames(items), "Action items fetched");
  }
);

export const updateActionItemStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const id = requireParam(req.params.id, "action item id");
    // Another account's task is a 404, exactly like a missing one.
    await assertActionItemOwner(currentUserId(req), id);

    const item = await actionItemService.setStatus(
      id,
      optionalString(req.body?.status)
    );

    return sendSuccess(res, item, "Action item updated");
  }
);
