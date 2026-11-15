import type { Request, Response } from "express";
import { currentUserId } from "../middleware/auth.middleware";
import * as accountService from "../services/account/account.service";
import * as devicesService from "../services/account/devices.service";
import { sendSuccess } from "../types/api";
import { BadRequest } from "../types/errors";
import { asyncHandler } from "../utils/asyncHandler";
import { optionalString, requireParam, requireString } from "../utils/validate";

export const getSettings = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(res, await accountService.getAccount(currentUserId(req)), "Settings fetched")
);

export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw BadRequest("Send the settings to change as a JSON object");
  }

  return sendSuccess(
    res,
    await accountService.updateSettings(currentUserId(req), body as Record<string, unknown>),
    "Settings saved"
  );
});

export const listDevices = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(res, await devicesService.listDevices(currentUserId(req)), "Devices fetched")
);

/** The response holds the token; it is never shown again. */
export const createDevice = asyncHandler(async (req: Request, res: Response) => {
  const result = await devicesService.createDevice({
    userId: currentUserId(req),
    name: requireString(req.body?.name, "name", { maxLength: 80 }),
    kind: optionalString(req.body?.kind),
  });

  return sendSuccess(res, result, "Device token created; copy it now, it is shown once", 201);
});

export const revokeDevice = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(
    res,
    await devicesService.revokeDevice(currentUserId(req), requireParam(req.params.id, "device id")),
    "Device token revoked"
  )
);
