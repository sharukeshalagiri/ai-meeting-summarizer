import { Response } from "express";

/**
 * Every /api response uses this envelope so clients can rely on a
 * single shape regardless of which route they hit.
 */
export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T | null;
}

export const sendSuccess = <T>(
  res: Response,
  data: T,
  message = "OK",
  status = 200
): Response => {
  const body: ApiResponse<T> = {
    success: true,
    message,
    data,
  };

  return res.status(status).json(body);
};

export const sendError = (
  res: Response,
  message: string,
  status = 500
): Response => {
  const body: ApiResponse<never> = {
    success: false,
    message,
    data: null,
  };

  return res.status(status).json(body);
};
