import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/** All Session (express-session store) database access. */

export const find = (sid: string) =>
  prisma.session.findUnique({ where: { sid } });

export const upsert = (
  sid: string,
  data: Prisma.InputJsonValue,
  expiresAt: Date,
  userId: string | null
) =>
  prisma.session.upsert({
    where: { sid },
    create: { sid, data, expiresAt, userId },
    update: { data, expiresAt, userId },
  });

export const touch = (sid: string, expiresAt: Date) =>
  prisma.session.updateMany({ where: { sid }, data: { expiresAt } });

export const destroy = (sid: string) =>
  prisma.session.deleteMany({ where: { sid } });

/** Signs a user out everywhere except (optionally) this session. */
export const destroyForUser = (userId: string, exceptSid?: string) =>
  prisma.session.deleteMany({
    where: { userId, ...(exceptSid ? { sid: { not: exceptSid } } : {}) },
  });

export const deleteExpired = (now = new Date()) =>
  prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
