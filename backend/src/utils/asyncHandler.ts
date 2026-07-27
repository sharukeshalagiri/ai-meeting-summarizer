import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async route handler so a rejected promise reaches Express's
 * error middleware.
 *
 * Express 5 forwards rejections automatically, but wrapping keeps the
 * behaviour explicit and lets every controller drop its try/catch,
 * which is what kept them thin.
 */
export const asyncHandler =
  (
    handler: (
      req: Request,
      res: Response,
      next: NextFunction
    ) => Promise<unknown>
  ): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };
