/**
 * useDebouncedValue - reusable debounce hook.
 *
 * Delays propagating a value until the input has stopped changing for a
 * configurable period. Suitable for search fields, filter inputs, and
 * debounced validation triggers.
 *
 * @module hooks/v1/useDebouncedValue
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DebouncedValueOptions {
  /**
   * Debounce delay in milliseconds.
   * @default 300
   */
  delay?: number;
  /**
   * When true, emit the incoming value immediately on the leading edge of the
   * first change, then suppress further emissions until the delay expires.
   * Useful for showing instant feedback while still debouncing rapid updates.
   * @default false
   */
  leading?: boolean;
}

export interface UseDebouncedValueReturn<T> {
  /** The debounced (delayed) output value. */
  debouncedValue: T;
  /**
   * True while a debounce timer is pending and the debounced value has not yet
   * caught up to the latest input value.
   */
  isPending: boolean;
  /**
   * Immediately emit the current input value and cancel any pending timer.
   * Use this to force synchronous resolution, e.g. on form submit.
   */
  flush: () => void;
  /**
   * Cancel any pending timer without emitting the latest value.
   * The debounced value stays at its last emitted state.
   */
  cancel: () => void;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

/**
 * Returns a debounced snapshot of `value` that only updates after the input
 * has been stable for `delay` milliseconds.
 *
 * @param value - The input value to debounce. Any type is supported.
 * @param options - Optional configuration (delay, leading).
 * @returns `{ debouncedValue, isPending, flush, cancel }`
 *
 * @example
 * ```typescript
 * // Basic search input debounce
 * function SearchBar() {
 *   const [query, setQuery] = useState("");
 *   const { debouncedValue, isPending } = useDebouncedValue(query, { delay: 400 });
 *
 *   useEffect(() => {
 *     if (debouncedValue) fetchResults(debouncedValue);
 *   }, [debouncedValue]);
 *
 *   return (
 *     <>
 *       <input value={query} onChange={e => setQuery(e.target.value)} />
 *       {isPending && <Spinner />}
 *     </>
 *   );
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Flush on form submit
 * function FilterForm() {
 *   const [filter, setFilter] = useState("");
 *   const { debouncedValue, flush } = useDebouncedValue(filter, { delay: 300 });
 *
 *   const handleSubmit = (e: React.FormEvent) => {
 *     e.preventDefault();
 *     flush(); // Ensure latest value is used immediately
 *     applyFilter(debouncedValue);
 *   };
 * }
 * ```
 */
export function useDebouncedValue<T>(
  value: T,
  options: DebouncedValueOptions = {}
): UseDebouncedValueReturn<T> {
  const { delay = 300, leading = false } = options;

  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  const [isPending, setIsPending] = useState(false);

  // Always holds the latest value so timer callbacks never capture stale closures.
  const latestValueRef = useRef<T>(value);
  // Holds the active timer ID so we can clear it without triggering re-renders.
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Tracks whether the leading edge emission has fired for the current burst.
  const leadingFiredRef = useRef(false);
  // Skip debounce logic on initial mount — value is already reflected in state.
  const isMountedRef = useRef(false);

  // Keep latestValueRef current on every render.
  latestValueRef.current = value;

  useEffect(() => {
    // On initial mount the value is already set via useState(value); nothing to do.
    if (!isMountedRef.current) {
      isMountedRef.current = true;
      return;
    }

    // Leading edge: emit immediately on the first change of a burst.
    if (leading && !leadingFiredRef.current) {
      leadingFiredRef.current = true;
      setDebouncedValue(value);
      setIsPending(false);
    } else {
      setIsPending(true);
    }

    // Clear any existing timer before starting a new one.
    clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      setDebouncedValue(latestValueRef.current);
      setIsPending(false);
      // Reset the leading-edge flag so the next burst fires immediately again.
      leadingFiredRef.current = false;
    }, delay);

    return () => {
      clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delay, leading]);

  // Cleanup on unmount: cancel any pending timer to prevent state updates on
  // an unmounted component.
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
    };
  }, []);

  /**
   * Immediately resolve the debounced value to the latest input and cancel any
   * pending timer. Safe to call when no timer is active.
   */
  const flush = useCallback(() => {
    clearTimeout(timerRef.current);
    setDebouncedValue(latestValueRef.current);
    setIsPending(false);
    leadingFiredRef.current = false;
  }, []);

  /**
   * Cancel any pending timer without changing the debounced value.
   * `isPending` is reset to false.
   */
  const cancel = useCallback(() => {
    clearTimeout(timerRef.current);
    setIsPending(false);
    leadingFiredRef.current = false;
  }, []);

  return { debouncedValue, isPending, flush, cancel };
}
