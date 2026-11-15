import { prisma } from "../lib/prisma";

/** All User database access. */

/**
 * Columns safe to send to the client: never passwordHash. Every read
 * that leaves this layer for a response uses this select.
 */
export const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  displayName: true,
  timezone: true,
  defaultMode: true,
  transcriptionProvider: true,
  glossary: true,
  audioRetention: true,
  audioRetentionDays: true,
} as const;

export const findById = (id: string) =>
  prisma.user.findUnique({ where: { id }, select: publicUserSelect });

/** For sign-in only: the one read that includes the password hash. */
export const findCredentialsByEmail = (email: string) =>
  prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, passwordHash: true },
  });

export const findByEmail = (email: string) =>
  prisma.user.findUnique({ where: { email }, select: publicUserSelect });

export const create = (data: {
  name: string;
  email: string;
  passwordHash?: string | null;
}) => prisma.user.create({ data, select: publicUserSelect });

export const count = () => prisma.user.count();

export const findPasswordHash = async (id: string) =>
  (
    await prisma.user.findUnique({
      where: { id },
      select: { passwordHash: true },
    })
  )?.passwordHash ?? null;

export const setPasswordHash = (id: string, passwordHash: string) =>
  prisma.user.update({
    where: { id },
    data: { passwordHash },
    select: { id: true },
  });

export const updateSettings = (
  id: string,
  data: {
    name?: string;
    displayName?: string | null;
    timezone?: string | null;
    defaultMode?: string;
    transcriptionProvider?: string | null;
    glossary?: string[];
    audioRetention?: string;
    audioRetentionDays?: number | null;
  }
) => prisma.user.update({ where: { id }, data, select: publicUserSelect });

/** Users whose retention policy deletes recordings (retention job). */
export const findWithRetention = () =>
  prisma.user.findMany({
    where: { audioRetention: { not: "KEEP" } },
    select: { id: true, audioRetention: true, audioRetentionDays: true },
  });

/** The owner's settings that shape processing of one meeting. */
export const findSettingsByMeetingId = async (meetingId: string) =>
  (
    await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        user: {
          select: {
            id: true,
            displayName: true,
            timezone: true,
            transcriptionProvider: true,
            glossary: true,
          },
        },
      },
    })
  )?.user ?? null;

/** Same, for an upload whose meeting is only known by its file. */
export const findSettingsByAudioPath = async (audioPath: string) =>
  (
    await prisma.meeting.findFirst({
      where: { audioPath },
      select: {
        user: {
          select: {
            id: true,
            displayName: true,
            timezone: true,
            transcriptionProvider: true,
            glossary: true,
          },
        },
      },
    })
  )?.user ?? null;
