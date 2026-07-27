import { prisma } from "../lib/prisma";

/** All User database access. */

export const findAll = () =>
  prisma.user.findMany({ orderBy: { createdAt: "asc" } });

export const create = (data: { name: string; email: string }) =>
  prisma.user.create({ data });

/**
 * The MVP is single-user: this backs the fallback that lets clients
 * create a meeting without supplying a userId. It becomes obsolete
 * once real authentication lands.
 */
export const findFirst = () =>
  prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
