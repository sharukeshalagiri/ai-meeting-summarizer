/**
 * Error carrying an HTTP status, so services can signal intent
 * (404, 400, 502...) without depending on Express.
 */
export class AppError extends Error {
  public readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

export const NotFound = (message: string) => new AppError(message, 404);

export const BadRequest = (message: string) => new AppError(message, 400);

/** Upstream dependency (Whisper, Gemini) failed or is unreachable. */
export const UpstreamError = (message: string) =>
  new AppError(message, 502);

/**
 * Turns Prisma's connection/constraint failures into messages a user
 * can act on, instead of leaking internal codes.
 */
export const toUserMessage = (error: unknown): AppError => {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    const code = (error as { code?: string }).code;

    // Connection failures arrive as PrismaClientInitializationError
    // with no `code`, and their message embeds source snippets, so
    // match on the name and never forward the raw text.
    if (
      error.name === "PrismaClientInitializationError" ||
      code === "P1001" ||
      code === "P1002" ||
      code === "P1017"
    ) {
      return new AppError(
        "Cannot reach the database right now. Please try again " +
          "shortly.",
        503
      );
    }

    // Malformed queries also embed the offending source in `message`.
    if (error.name === "PrismaClientValidationError") {
      return new AppError("That request was not valid.", 400);
    }

    // Prisma: record not found
    if (code === "P2025") {
      return new AppError("The requested record no longer exists.", 404);
    }

    // Prisma: unique constraint violation
    if (code === "P2002") {
      return new AppError("That record already exists.", 409);
    }

    // Prisma: foreign key constraint violation
    if (code === "P2003") {
      return new AppError("Referenced record does not exist.", 400);
    }

    // Any other Prisma failure: the message may contain queries or
    // file paths, so return something generic. The real error is
    // still logged server-side.
    if (error.name.startsWith("Prisma")) {
      return new AppError(
        "Something went wrong while saving your data. Please try " +
          "again.",
        500
      );
    }

    return new AppError(error.message, 500);
  }

  return new AppError("Something went wrong. Please try again.", 500);
};
