import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAsyncAction } from "../../../src/hooks/v1/useAsyncAction";

describe("useAsyncAction Hook", () => {
  it("initializes in idle state", () => {
    const { result } = renderHook(() => useAsyncAction(async () => "success"));
    
    expect(result.current.status).toBe("idle");
    expect(result.current.isIdle).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("handles successful execution", async () => {
    const action = vi.fn().mockResolvedValue("result data");
    const onSuccess = vi.fn();
    
    const { result } = renderHook(() => useAsyncAction(action, { onSuccess }));
    
    let promise: Promise<any>;
    await act(async () => {
      promise = result.current.run();
    });

    expect(result.current.status).toBe("success");
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data).toBe("result data");
    expect(onSuccess).toHaveBeenCalledWith("result data");
    
    const resolvedValue = await promise!;
    expect(resolvedValue).toBe("result data");
  });

  it("handles failed execution", async () => {
    const error = new Error("Mock failure");
    const action = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    
    const { result } = renderHook(() => useAsyncAction(action, { onError }));
    
    await act(async () => {
      try {
        await result.current.run();
      } catch (e) {
        // Expected
      }
    });

    expect(result.current.status).toBe("error");
    expect(result.current.isError).toBe(true);
    expect(result.current.error).toBe(error);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("prevents concurrent execution when configured", async () => {
    let resolveAction: (val: string) => void;
    const action = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveAction = resolve;
    }));
    
    const { result } = renderHook(() => useAsyncAction(action, { preventConcurrent: true }));
    
    act(() => {
      result.current.run();
    });
    
    expect(result.current.status).toBe("loading");
    expect(action).toHaveBeenCalledTimes(1);
    
    // Attempt second run while loading
    let secondRunResult: any;
    await act(async () => {
      secondRunResult = await result.current.run();
    });
    
    expect(action).toHaveBeenCalledTimes(1); // Should NOT have been called again
    expect(secondRunResult).toBeUndefined();
    
    // Resolve first run
    await act(async () => {
      resolveAction!("done");
    });
    
    expect(result.current.status).toBe("success");
  });

  it("allows concurrent execution when preventConcurrent is false", async () => {
    const action = vi.fn().mockImplementation(() => Promise.resolve("done"));
    
    const { result } = renderHook(() => useAsyncAction(action, { preventConcurrent: false }));
    
    await act(async () => {
      result.current.run();
      result.current.run();
    });
    
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("handles race conditions by only processing the latest run", async () => {
    const action = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve("first"), 50)))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve("second"), 10)));
    
    const { result } = renderHook(() => useAsyncAction(action, { preventConcurrent: false }));
    
    let firstPromise: Promise<any>;
    let secondPromise: Promise<any>;

    // We use act to wrap the calls that trigger state updates
    await act(async () => {
      firstPromise = result.current.run();
      secondPromise = result.current.run();
    });

    await act(async () => {
      await Promise.allSettled([firstPromise!, secondPromise!]);
    });

    // The state should reflect the SECOND run because it was the most recent call
    expect(result.current.data).toBe("second");
    expect(result.current.status).toBe("success");
  });

  it("resets state correctly", async () => {
    const action = vi.fn().mockResolvedValue("data");
    const { result } = renderHook(() => useAsyncAction(action));
    
    await act(async () => {
      await result.current.run();
    });
    
    expect(result.current.isSuccess).toBe(true);
    
    act(() => {
      result.current.reset();
    });
    
    expect(result.current.status).toBe("idle");
    expect(result.current.data).toBeNull();
  });
});
