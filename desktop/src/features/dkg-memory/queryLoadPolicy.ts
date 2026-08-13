/**
 * DKG reads can fan out into several triple-store operations. Keep them
 * user-driven and cache the successful result briefly instead of polling or
 * multiplying an overloaded upstream with automatic retries.
 */
export const DKG_READ_STALE_TIME_MS = 30_000;

export const dkgReadQueryPolicy = {
  retry: false,
  refetchInterval: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  staleTime: DKG_READ_STALE_TIME_MS,
} as const;
