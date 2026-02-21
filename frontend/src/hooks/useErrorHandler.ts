/**
 * useErrorHandler — React hook for error capture and dispatch.
 *
 * Wraps toAppError() + useErrorStore so call sites need only:
 *
 *   const { handleError } = useErrorHandler();
 *   try { ... } catch (e) { handleError(e, ErrorDomain.RPC, { gameId }) }
 *
 * The mapped AppError is both stored (for UI display) and returned (for
 * immediate imperative inspection). The hook is intentionally thin — all
 * business logic lives in error-mapping.ts and errorStore.ts.
 */

import { useCallback } from 'react';
import type { AppError, ErrorMappingHint } from '../types/errors';
import { toAppError } from '../services/error-mapping';
import { useErrorStore } from '../store/errorStore';

interface UseErrorHandlerReturn {
  /**
   * Map `raw` to an AppError, push it to the global store, and return it.
   * Pass `hint` when the domain is known at the call site (avoids auto-detection cost).
   */
  handleError: (
    raw: unknown,
    hint?: ErrorMappingHint,
    context?: Record<string, unknown>,
  ) => AppError;
  /** Clear the current error from the store (e.g. on modal dismiss). */
  clearError: () => void;
}

export function useErrorHandler(): UseErrorHandlerReturn {
  const setError = useErrorStore((s) => s.setError);
  const clearError = useErrorStore((s) => s.clearError);

  const handleError = useCallback(
    (raw: unknown, hint?: ErrorMappingHint, context?: Record<string, unknown>): AppError => {
      const err = toAppError(raw, hint, context);
      setError(err);
      return err;
    },
    [setError],
  );

  return { handleError, clearError };
}
