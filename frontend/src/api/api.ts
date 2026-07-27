import axios from "axios";
import type { ApiResponse } from "../types/api";

export const api = axios.create({
  baseURL: "http://localhost:5000/api",
});

/**
 * Turns any failure into a sentence worth showing a user. The backend
 * sends { success, message, data }, so prefer its message.
 */
export const getErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    if (error.code === "ECONNABORTED") {
      return (
        "The request timed out. The recording may be too long to " +
        "process in one go."
      );
    }

    const data = error.response?.data as ApiResponse<unknown> | undefined;

    if (data && typeof data.message === "string" && data.message) {
      return data.message;
    }

    if (!error.response) {
      return (
        "Could not reach the server. Please check that the backend is " +
        "running on port 5000."
      );
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
};

/** Unwraps the envelope, raising the server's message on failure. */
const unwrap = <T>(payload: ApiResponse<T>): T => {
  if (!payload.success || payload.data === null) {
    throw new Error(payload.message || "Request failed");
  }

  return payload.data;
};

export const getData = async <T>(
  url: string,
  config?: Parameters<typeof api.get>[1]
): Promise<T> => {
  const res = await api.get<ApiResponse<T>>(url, config);

  return unwrap(res.data);
};

export const postData = async <T>(
  url: string,
  body?: unknown,
  config?: Parameters<typeof api.post>[2]
): Promise<T> => {
  const res = await api.post<ApiResponse<T>>(url, body, config);

  return unwrap(res.data);
};
