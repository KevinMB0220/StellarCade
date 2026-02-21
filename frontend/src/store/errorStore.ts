/**
 * Global error store — Zustand slice for application-wide error state.
 *
 * Consumers read `current` to display the most recent error, and `history`
 * for an audit trail (e.g. a debug panel). The store is framework-agnostic:
 * it can be read synchronously via `useErrorStore.getState()` in non-React
 * contexts (services, tests) and reactively via the hook in components.
 */

import { create } from 'zustand';
import type { AppError } from '../types/errors';

/** Maximum number of errors retained in history before the oldest is dropped. */
const MAX_HISTORY = 50;

interface ErrorState {
  /** The most recently recorded error, or null if none is active. */
  current: AppError | null;
  /** Chronological list of all recorded errors (newest first), capped at MAX_HISTORY. */
  history: AppError[];
  /** Record an error as current and prepend it to history. */
  setError: (error: AppError) => void;
  /** Clear the current error without affecting history. */
  clearError: () => void;
  /** Wipe the full history. */
  clearHistory: () => void;
}

export const useErrorStore = create<ErrorState>()((set) => ({
  current: null,
  history: [],

  setError: (error) =>
    set((state) => ({
      current: error,
      // Prepend newest; cap at MAX_HISTORY to bound memory usage.
      history: [error, ...state.history].slice(0, MAX_HISTORY),
    })),

  clearError: () => set({ current: null }),

  clearHistory: () => set({ history: [] }),
}));
