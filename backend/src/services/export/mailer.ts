import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../lib/env";
import { AppError } from "../../types/errors";

/**
 * SMTP for "email this summary" (nodemailer). Configured only through
 * SMTP_* env vars; with no SMTP_HOST the feature answers 503 and
 * nothing is sent. Tests install a mock transport (setTransportForTests)
 * and never reach a real server.
 */

let transport: Transporter | null = null;
let override: Transporter | null = null;

export const emailConfigured = () => Boolean(override || env.smtpHost);

export const getTransport = (): Transporter => {
  if (override) return override;
  if (!env.smtpHost) {
    throw new AppError("Email is not set up on this server (SMTP_HOST).", 503);
  }

  transport ??= nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    ...(env.smtpUser ? { auth: { user: env.smtpUser, pass: env.smtpPassword ?? "" } } : {}),
  });

  return transport;
};

/** Tests only: route mail to a mock (e.g. nodemailer's jsonTransport). */
export const setTransportForTests = (next: Transporter | null) => {
  override = next;
};
