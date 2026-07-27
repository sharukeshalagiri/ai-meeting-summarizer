import { useCallback, useEffect, useState } from "react";
import { getData, getErrorMessage } from "../api/api";

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-runs the request, e.g. from a Retry or Refresh button. */
  refetch: () => Promise<void>;
  setData: (value: T) => void;
}

/**
 * Shared loading/error/retry handling so every page reports failures
 * the same way instead of repeating the same try/catch.
 */
export function useFetch<T>(url: string): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guards against setting state after the URL changed or the
    // component unmounted.
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);

      try {
        const result = await getData<T>(url);
        if (!cancelled) setData(result);
      } catch (err) {
        console.error(err);
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [url]);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      setData(await getData<T>(url));
    } catch (err) {
      console.error(err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [url]);

  return { data, loading, error, refetch, setData };
}
