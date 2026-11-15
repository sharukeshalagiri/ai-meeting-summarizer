import { prisma } from "../lib/prisma";

/** All DeviceToken database access. The token itself is never stored. */

const listSelect = {
  id: true,
  name: true,
  kind: true,
  prefix: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

export const create = (data: {
  userId: string;
  name: string;
  kind: string;
  tokenHash: string;
  prefix: string;
}) => prisma.deviceToken.create({ data, select: listSelect });

export const findByUser = (userId: string) =>
  prisma.deviceToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: listSelect,
  });

/** The device auth lookup: one indexed equality on the hash. */
export const findByHash = (tokenHash: string) =>
  prisma.deviceToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      revokedAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

/** Scoped by user, so revoking someone else's id changes nothing. */
export const revoke = (id: string, userId: string) =>
  prisma.deviceToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

export const findOwned = (id: string, userId: string) =>
  prisma.deviceToken.findFirst({ where: { id, userId }, select: listSelect });

export const markUsed = (id: string, at = new Date()) =>
  prisma.deviceToken.update({
    where: { id },
    data: { lastUsedAt: at },
    select: { id: true },
  });
