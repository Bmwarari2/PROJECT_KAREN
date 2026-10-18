'use client';
import * as React from 'react';
import { api, ApiProblem } from './api';

/** Minimal data hook: fetch on mount / key change, expose reload. No caching of personal data. */
export function useApi<T>(path: string | null) {
  const [data, setData] = React.useState<T | undefined>(undefined);
  const [error, setError] = React.useState<ApiProblem | null>(null);
  const [loading, setLoading] = React.useState(!!path);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    api<T>(path)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(e instanceof ApiProblem ? e : new ApiProblem(0, 'error', String(e), {})))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
