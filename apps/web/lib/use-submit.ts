"use client";

import { useCallback, useState } from "react";
import { api, ApiRequestError } from "./fetcher";

/** Shared submit state for forms: loading, top-level error, field errors and a success notice. */
export function useSubmit() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});

  const submit = useCallback(
    async <T = unknown>(url: string, init: { method?: string; body?: unknown }, successMessage?: string): Promise<T | null> => {
      setLoading(true);
      setError(undefined);
      setSuccess(undefined);
      setFields({});
      try {
        const res = await api<T>(url, init);
        if (successMessage) setSuccess(successMessage);
        return res ?? ({} as T);
      } catch (err) {
        if (err instanceof ApiRequestError) {
          setError(err.body.message);
          setFields(err.body.fields ?? {});
        } else setError("Something went wrong. Please try again.");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { submit, loading, error, success, fields, setError, setSuccess };
}
