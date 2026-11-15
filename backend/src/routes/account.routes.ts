import { Router } from "express";
import {
  createDevice,
  getSettings,
  listDevices,
  revokeDevice,
  updateSettings,
} from "../controllers/account.controller";
import { createSeries, getPrep, listSeries, renameSeries } from "../controllers/series.controller";

/** Settings page. Mounted at /api/account. */
export const accountRoutes = Router();
accountRoutes.get("/settings", getSettings);
accountRoutes.patch("/settings", updateSettings);

/** Devices page: per-user recorder tokens. Mounted at /api/devices. */
export const deviceRoutes = Router();
deviceRoutes.get("/", listDevices);
deviceRoutes.post("/", createDevice);
deviceRoutes.post("/:id/revoke", revokeDevice);

/** Meeting series and the Prep view. Mounted at /api/series. */
export const seriesRoutes = Router();
seriesRoutes.get("/", listSeries);
seriesRoutes.post("/", createSeries);
seriesRoutes.patch("/:id", renameSeries);
seriesRoutes.get("/:id/prep", getPrep);
