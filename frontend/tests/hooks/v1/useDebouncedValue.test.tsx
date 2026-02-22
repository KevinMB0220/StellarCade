// @vitest-environment happy-dom

/**
 * Unit tests for useDebouncedValue hook.
 *
 * Covers normal behavior, edge cases, flush/cancel, leading edge,
 * stability across re-renders, and cleanup on unmount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "../../../src/hooks/v1/useDebouncedValue";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

// ── Initialization ─────────────────────────────────────────────────────────────

describe("useDebouncedValue - initialization", () => {
  it("initializes debouncedValue with the initial value", () => {
    const { result } = renderHook(() => useDebouncedValue("hello"));

    expect(result.current.debouncedValue).toBe("hello");
  });

  it("initializes isPending to false", () => {
    const { result } = renderHook(() => useDebouncedValue("hello"));

    expect(result.current.isPending).toBe(false);
  });

  it("works with number initial value", () => {
    const { result } = renderHook(() => useDebouncedValue(42));

    expect(result.current.debouncedValue).toBe(42);
    expect(result.current.isPending).toBe(false);
  });

  it("works with object initial value", () => {
    const obj = { key: "value" };
    const { result } = renderHook(() => useDebouncedValue(obj));

    expect(result.current.debouncedValue).toBe(obj);
    expect(result.current.isPending).toBe(false);
  });
});

// ── Debounce Timing ────────────────────────────────────────────────────────────

describe("useDebouncedValue - debounce timing", () => {
  it("does not update debouncedValue immediately when value changes", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "initial" } }
    );

    act(() => {
      rerender({ value: "updated" });
    });

    expect(result.current.debouncedValue).toBe("initial");
  });

  it("sets isPending to true immediately when value changes", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "initial" } }
    );

    act(() => {
      rerender({ value: "updated" });
    });

    expect(result.current.isPending).toBe(true);
  });

  it("updates debouncedValue after the delay has elapsed", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "initial" } }
    );

    act(() => {
      rerender({ value: "updated" });
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.debouncedValue).toBe("updated");
    expect(result.current.isPending).toBe(false);
  });

  it("does not update before the delay elapses", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "initial" } }
    );

    act(() => {
      rerender({ value: "updated" });
    });

    act(() => {
      vi.advanceTimersByTime(299);
    });

    expect(result.current.debouncedValue).toBe("initial");
    expect(result.current.isPending).toBe(true);
  });

  it("resets the timer on rapid value changes — only the last value is emitted", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "a" } }
    );

    act(() => {
      rerender({ value: "b" });
    });

    act(() => {
      vi.advanceTimersByTime(200);
      rerender({ value: "c" });
    });

    // Timer was reset — still pending after original 300ms from "b"
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.debouncedValue).toBe("a"); // still old

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.debouncedValue).toBe("c"); // latest value emitted
    expect(result.current.isPending).toBe(false);
  });

  it("respects a custom delay of 500ms", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 500 }),
      { initialProps: { value: "start" } }
    );

    act(() => {
      rerender({ value: "end" });
    });

    act(() => {
      vi.advanceTimersByTime(499);
    });

    expect(result.current.debouncedValue).toBe("start");

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(result.current.debouncedValue).toBe("end");
  });

  it("handles zero delay — emits after timer flush", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 0 }),
      { initialProps: { value: "first" } }
    );

    act(() => {
      rerender({ value: "second" });
    });

    act(() => {
      vi.runAllTimers();
    });

    expect(result.current.debouncedValue).toBe("second");
  });
});

// ── flush() ────────────────────────────────────────────────────────────────────

describe("useDebouncedValue - flush()", () => {
  it("flush() immediately emits the current value", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "old" } }
    );

    act(() => {
      rerender({ value: "new" });
    });

    expect(result.current.debouncedValue).toBe("old");

    act(() => {
      result.current.flush();
    });

    expect(result.current.debouncedValue).toBe("new");
    expect(result.current.isPending).toBe(false);
  });

  it("flush() cancels the pending timer — timer does not fire again", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "a" } }
    );

    act(() => {
      rerender({ value: "b" });
      result.current.flush();
    });

    // Advance time — no second update should occur
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(result.current.debouncedValue).toBe("b");
    expect(result.current.isPending).toBe(false);
  });

  it("flush() is safe to call when no timer is pending", () => {
    const { result } = renderHook(() => useDebouncedValue("stable"));

    expect(() => {
      act(() => {
        result.current.flush();
      });
    }).not.toThrow();

    expect(result.current.debouncedValue).toBe("stable");
  });
});

// ── cancel() ──────────────────────────────────────────────────────────────────

describe("useDebouncedValue - cancel()", () => {
  it("cancel() prevents the pending timer from emitting", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "original" } }
    );

    act(() => {
      rerender({ value: "changed" });
    });

    act(() => {
      result.current.cancel();
    });

    act(() => {
      vi.advanceTimersByTime(400);
    });

    // Value stays at original — timer was cancelled
    expect(result.current.debouncedValue).toBe("original");
    expect(result.current.isPending).toBe(false);
  });

  it("cancel() resets isPending to false immediately", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "x" } }
    );

    act(() => {
      rerender({ value: "y" });
    });

    expect(result.current.isPending).toBe(true);

    act(() => {
      result.current.cancel();
    });

    expect(result.current.isPending).toBe(false);
  });

  it("cancel() is safe to call when no timer is pending", () => {
    const { result } = renderHook(() => useDebouncedValue("stable"));

    expect(() => {
      act(() => {
        result.current.cancel();
      });
    }).not.toThrow();
  });
});

// ── leading option ─────────────────────────────────────────────────────────────

describe("useDebouncedValue - leading option", () => {
  it("emits the value immediately on the leading edge when leading: true", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300, leading: true }),
      { initialProps: { value: "initial" } }
    );

    act(() => {
      rerender({ value: "first-change" });
    });

    // Should have emitted immediately without waiting for the timer
    expect(result.current.debouncedValue).toBe("first-change");
    expect(result.current.isPending).toBe(false);
  });

  it("suppresses intermediate rapid changes after leading edge fires", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300, leading: true }),
      { initialProps: { value: "a" } }
    );

    act(() => {
      rerender({ value: "b" }); // leading edge → emits "b" immediately
    });

    act(() => {
      rerender({ value: "c" }); // within delay → suppressed until timer
    });

    // Still "b" from the leading edge; "c" not emitted yet
    expect(result.current.debouncedValue).toBe("b");

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.debouncedValue).toBe("c");
  });

  it("without leading option, first change does not emit immediately", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300, leading: false }),
      { initialProps: { value: "a" } }
    );

    act(() => {
      rerender({ value: "b" });
    });

    expect(result.current.debouncedValue).toBe("a"); // not immediately
  });
});

// ── Stability ──────────────────────────────────────────────────────────────────

describe("useDebouncedValue - reference stability", () => {
  it("flush reference is stable across re-renders", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value),
      { initialProps: { value: "a" } }
    );

    const firstFlush = result.current.flush;

    act(() => {
      rerender({ value: "b" });
    });

    expect(result.current.flush).toBe(firstFlush);
  });

  it("cancel reference is stable across re-renders", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value),
      { initialProps: { value: "a" } }
    );

    const firstCancel = result.current.cancel;

    act(() => {
      rerender({ value: "b" });
    });

    expect(result.current.cancel).toBe(firstCancel);
  });
});

// ── Unmount cleanup ────────────────────────────────────────────────────────────

describe("useDebouncedValue - unmount cleanup", () => {
  it("does not update state after unmount (no React warning)", () => {
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "a" } }
    );

    act(() => {
      rerender({ value: "b" });
    });

    expect(result.current.isPending).toBe(true);

    // Unmount while timer is still pending
    unmount();

    // Running timers after unmount should not throw or warn
    expect(() => {
      act(() => {
        vi.runAllTimers();
      });
    }).not.toThrow();
  });
});

// ── Non-string types ──────────────────────────────────────────────────────────

describe("useDebouncedValue - non-string types", () => {
  it("works with numbers", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 200 }),
      { initialProps: { value: 0 } }
    );

    act(() => {
      rerender({ value: 99 });
    });

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.debouncedValue).toBe(99);
  });

  it("works with objects (by reference)", () => {
    const obj1 = { count: 1 };
    const obj2 = { count: 2 };

    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 200 }),
      { initialProps: { value: obj1 } }
    );

    act(() => {
      rerender({ value: obj2 });
    });

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.debouncedValue).toBe(obj2);
  });

  it("works with boolean values", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 100 }),
      { initialProps: { value: false } }
    );

    act(() => {
      rerender({ value: true });
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.debouncedValue).toBe(true);
  });
});

// ── Invalid / edge inputs ─────────────────────────────────────────────────────

describe("useDebouncedValue - edge cases", () => {
  it("handles undefined as a valid value type", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string | undefined }) =>
        useDebouncedValue(value, { delay: 100 }),
      { initialProps: { value: "defined" as string | undefined } }
    );

    act(() => {
      rerender({ value: undefined });
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.debouncedValue).toBeUndefined();
  });

  it("does not change debouncedValue when value prop stays the same", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, { delay: 300 }),
      { initialProps: { value: "stable" } }
    );

    act(() => {
      rerender({ value: "stable" });
    });

    // isPending may be briefly true due to effect running, but value is unchanged
    act(() => {
      vi.runAllTimers();
    });

    expect(result.current.debouncedValue).toBe("stable");
  });

  it("uses default delay of 300ms when no options provided", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value),
      { initialProps: { value: "start" } }
    );

    act(() => {
      rerender({ value: "end" });
    });

    act(() => {
      vi.advanceTimersByTime(299);
    });

    expect(result.current.debouncedValue).toBe("start");

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(result.current.debouncedValue).toBe("end");
  });
});
