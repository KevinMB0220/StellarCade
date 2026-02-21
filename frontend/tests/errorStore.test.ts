/**
 * Tests for the Zustand error store (errorStore.ts).
 *
 * The store is tested by calling its actions directly via `getState()` so
 * that we do not depend on React or any rendering environment.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useErrorStore } from '../src/store/errorStore';
import { ErrorDomain, ErrorSeverity } from '../src/types/errors';
import type { AppError } from '../src/types/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(code: string, message = 'test error'): AppError {
  return {
    code: code as AppError['code'],
    domain: ErrorDomain.UNKNOWN,
    severity: ErrorSeverity.FATAL,
    message,
  };
}

// Reset store to initial state before every test.
beforeEach(() => {
  useErrorStore.setState({ current: null, history: [] });
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('current is null', () => {
    expect(useErrorStore.getState().current).toBeNull();
  });

  it('history is empty', () => {
    expect(useErrorStore.getState().history).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// setError
// ---------------------------------------------------------------------------

describe('setError', () => {
  it('sets current to the provided error', () => {
    const err = makeError('UNKNOWN', 'first error');
    useErrorStore.getState().setError(err);
    expect(useErrorStore.getState().current).toBe(err);
  });

  it('prepends the error to history', () => {
    const a = makeError('UNKNOWN', 'a');
    const b = makeError('UNKNOWN', 'b');
    useErrorStore.getState().setError(a);
    useErrorStore.getState().setError(b);
    const { history } = useErrorStore.getState();
    expect(history[0]).toBe(b);
    expect(history[1]).toBe(a);
  });

  it('replaces current when called multiple times', () => {
    const a = makeError('UNKNOWN', 'a');
    const b = makeError('UNKNOWN', 'b');
    useErrorStore.getState().setError(a);
    useErrorStore.getState().setError(b);
    expect(useErrorStore.getState().current).toBe(b);
  });

  it('history accumulates all errors', () => {
    for (let i = 0; i < 5; i++) {
      useErrorStore.getState().setError(makeError('UNKNOWN', `error-${i}`));
    }
    expect(useErrorStore.getState().history).toHaveLength(5);
  });

  it('caps history at MAX_HISTORY (50)', () => {
    for (let i = 0; i < 60; i++) {
      useErrorStore.getState().setError(makeError('UNKNOWN', `error-${i}`));
    }
    expect(useErrorStore.getState().history).toHaveLength(50);
  });

  it('retains the 50 most recent errors when cap is exceeded', () => {
    for (let i = 0; i < 55; i++) {
      useErrorStore.getState().setError(makeError('UNKNOWN', `error-${i}`));
    }
    // Most recent (i=54) should be at index 0.
    expect(useErrorStore.getState().history[0].message).toBe('error-54');
    // Oldest retained (i=5) should be at index 49.
    expect(useErrorStore.getState().history[49].message).toBe('error-5');
  });

  it('preserves all AppError fields unchanged', () => {
    const err: AppError = {
      code: 'RPC_NODE_UNAVAILABLE',
      domain: ErrorDomain.RPC,
      severity: ErrorSeverity.RETRYABLE,
      message: 'node is down',
      retryAfterMs: 3000,
      context: { endpoint: 'https://rpc.example.com' },
      originalError: new Error('raw'),
    };
    useErrorStore.getState().setError(err);
    const stored = useErrorStore.getState().current!;
    expect(stored.code).toBe('RPC_NODE_UNAVAILABLE');
    expect(stored.domain).toBe(ErrorDomain.RPC);
    expect(stored.severity).toBe(ErrorSeverity.RETRYABLE);
    expect(stored.retryAfterMs).toBe(3000);
    expect(stored.context).toEqual({ endpoint: 'https://rpc.example.com' });
    expect(stored.originalError).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// clearError
// ---------------------------------------------------------------------------

describe('clearError', () => {
  it('sets current to null', () => {
    useErrorStore.getState().setError(makeError('UNKNOWN'));
    useErrorStore.getState().clearError();
    expect(useErrorStore.getState().current).toBeNull();
  });

  it('does not affect history', () => {
    useErrorStore.getState().setError(makeError('UNKNOWN', 'keep me'));
    useErrorStore.getState().clearError();
    expect(useErrorStore.getState().history).toHaveLength(1);
    expect(useErrorStore.getState().history[0].message).toBe('keep me');
  });

  it('is safe to call when current is already null', () => {
    expect(() => useErrorStore.getState().clearError()).not.toThrow();
    expect(useErrorStore.getState().current).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearHistory
// ---------------------------------------------------------------------------

describe('clearHistory', () => {
  it('empties the history array', () => {
    useErrorStore.getState().setError(makeError('UNKNOWN', 'a'));
    useErrorStore.getState().setError(makeError('UNKNOWN', 'b'));
    useErrorStore.getState().clearHistory();
    expect(useErrorStore.getState().history).toHaveLength(0);
  });

  it('does not affect current', () => {
    const err = makeError('UNKNOWN', 'current');
    useErrorStore.getState().setError(err);
    useErrorStore.getState().clearHistory();
    expect(useErrorStore.getState().current).toBe(err);
  });

  it('is safe to call on an already-empty history', () => {
    expect(() => useErrorStore.getState().clearHistory()).not.toThrow();
    expect(useErrorStore.getState().history).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Interaction between actions
// ---------------------------------------------------------------------------

describe('action interactions', () => {
  it('setError after clearError re-populates current', () => {
    const a = makeError('UNKNOWN', 'a');
    const b = makeError('UNKNOWN', 'b');
    useErrorStore.getState().setError(a);
    useErrorStore.getState().clearError();
    useErrorStore.getState().setError(b);
    expect(useErrorStore.getState().current).toBe(b);
  });

  it('setError after clearHistory continues building history from zero', () => {
    useErrorStore.getState().setError(makeError('UNKNOWN', 'old'));
    useErrorStore.getState().clearHistory();
    useErrorStore.getState().setError(makeError('UNKNOWN', 'new'));
    expect(useErrorStore.getState().history).toHaveLength(1);
    expect(useErrorStore.getState().history[0].message).toBe('new');
  });

  it('full reset via clearError + clearHistory yields initial state', () => {
    useErrorStore.getState().setError(makeError('UNKNOWN', 'x'));
    useErrorStore.getState().clearError();
    useErrorStore.getState().clearHistory();
    const { current, history } = useErrorStore.getState();
    expect(current).toBeNull();
    expect(history).toHaveLength(0);
  });
});
