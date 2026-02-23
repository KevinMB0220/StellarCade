// @vitest-environment jsdom

/**
 * Unit tests for useWalletStatus hook.
 *
 * Tests cover: normal behavior, edge cases, and failure paths.
 * WalletSessionService is injected as a mock to avoid localStorage dependency.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWalletStatus } from "../../../src/hooks/v1/useWalletStatus";
import {
  WalletSessionState,
  ProviderNotFoundError,
  RejectedSignatureError,
  StaleSessionError,
  WalletSessionError,
} from "../../../src/types/wallet-session";
import type { WalletSessionMeta, WalletProviderInfo } from "../../../src/types/wallet-session";

// ── Mock service ───────────────────────────────────────────────────────────────

const MOCK_PROVIDER: WalletProviderInfo = { id: "mock", name: "MockWallet" };

const MOCK_META: WalletSessionMeta = {
  provider: MOCK_PROVIDER,
  address: "GABC123TESTADDRESS",
  network: "TESTNET",
  connectedAt: Date.now(),
};

type Subscriber = (
  state: WalletSessionState,
  meta?: WalletSessionMeta | null,
  error?: Error | null,
) => void;

class MockWalletSessionService {
  private subscriber: Subscriber | null = null;
  private _state: WalletSessionState = WalletSessionState.DISCONNECTED;
  private _meta: WalletSessionMeta | null = null;

  getState() {
    return this._state;
  }

  getMeta() {
    return this._meta;
  }

  subscribe(fn: Subscriber) {
    this.subscriber = fn;
    // Mirror real service: call subscriber immediately with current state
    fn(this._state, this._meta, null);
    return () => {
      this.subscriber = null;
    };
  }

  /** Test helper: push a state transition to the subscribed hook. */
  _emit(
    state: WalletSessionState,
    meta: WalletSessionMeta | null,
    error: Error | null = null,
  ) {
    this._state = state;
    this._meta = meta;
    if (this.subscriber) {
      this.subscriber(state, meta, error);
    }
  }

  setProviderAdapter = vi.fn();
  connect = vi.fn().mockResolvedValue(MOCK_META);
  disconnect = vi.fn().mockResolvedValue(undefined);
  reconnect = vi.fn().mockResolvedValue(MOCK_META);
}

let mockService: MockWalletSessionService;

beforeEach(() => {
  mockService = new MockWalletSessionService();
});

// ── Initial state ──────────────────────────────────────────────────────────────

describe("initial state", () => {
  it("starts DISCONNECTED with no address, network, or error", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    expect(result.current.status).toBe("DISCONNECTED");
    expect(result.current.address).toBeNull();
    expect(result.current.network).toBeNull();
    expect(result.current.provider).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("exposes correct capabilities when DISCONNECTED", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    expect(result.current.capabilities.isConnected).toBe(false);
    expect(result.current.capabilities.isConnecting).toBe(false);
    expect(result.current.capabilities.isReconnecting).toBe(false);
    expect(result.current.capabilities.canConnect).toBe(true);
  });

  it("reflects pre-connected service state on mount", () => {
    mockService._emit(WalletSessionState.CONNECTED, MOCK_META);

    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    expect(result.current.status).toBe("CONNECTED");
    expect(result.current.address).toBe(MOCK_META.address);
    expect(result.current.network).toBe(MOCK_META.network);
    expect(result.current.provider).toEqual(MOCK_PROVIDER);
  });
});

// ── State transitions ──────────────────────────────────────────────────────────

describe("state transitions", () => {
  it("transitions to CONNECTING when service emits CONNECTING", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(WalletSessionState.CONNECTING, null);
    });

    expect(result.current.status).toBe("CONNECTING");
    expect(result.current.capabilities.isConnecting).toBe(true);
    expect(result.current.capabilities.canConnect).toBe(false);
  });

  it("transitions to CONNECTED with meta after successful connect", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(WalletSessionState.CONNECTED, MOCK_META);
    });

    expect(result.current.status).toBe("CONNECTED");
    expect(result.current.capabilities.isConnected).toBe(true);
    expect(result.current.capabilities.canConnect).toBe(false);
    expect(result.current.address).toBe(MOCK_META.address);
    expect(result.current.network).toBe(MOCK_META.network);
    expect(result.current.error).toBeNull();
  });

  it("transitions to RECONNECTING when service emits RECONNECTING", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(WalletSessionState.RECONNECTING, null);
    });

    expect(result.current.status).toBe("RECONNECTING");
    expect(result.current.capabilities.isReconnecting).toBe(true);
    expect(result.current.capabilities.canConnect).toBe(false);
  });

  it("transitions back to DISCONNECTED after disconnect", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(WalletSessionState.CONNECTED, MOCK_META);
    });

    expect(result.current.status).toBe("CONNECTED");

    act(() => {
      mockService._emit(WalletSessionState.DISCONNECTED, null);
    });

    expect(result.current.status).toBe("DISCONNECTED");
    expect(result.current.address).toBeNull();
    expect(result.current.network).toBeNull();
  });
});

// ── Error states ───────────────────────────────────────────────────────────────

describe("error states", () => {
  it("maps ProviderNotFoundError to PROVIDER_MISSING status", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(
        WalletSessionState.DISCONNECTED,
        null,
        new ProviderNotFoundError(),
      );
    });

    expect(result.current.status).toBe("PROVIDER_MISSING");
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.code).toBe("provider_not_found");
    expect(result.current.error?.recoverable).toBe(false);
    expect(result.current.capabilities.canConnect).toBe(true);
  });

  it("maps RejectedSignatureError to PERMISSION_DENIED status", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(
        WalletSessionState.DISCONNECTED,
        null,
        new RejectedSignatureError(),
      );
    });

    expect(result.current.status).toBe("PERMISSION_DENIED");
    expect(result.current.error?.code).toBe("rejected_signature");
    expect(result.current.error?.recoverable).toBe(true);
    expect(result.current.capabilities.canConnect).toBe(true);
  });

  it("maps StaleSessionError to STALE_SESSION status", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(
        WalletSessionState.DISCONNECTED,
        null,
        new StaleSessionError(),
      );
    });

    expect(result.current.status).toBe("STALE_SESSION");
    expect(result.current.error?.code).toBe("stale_session");
    expect(result.current.error?.recoverable).toBe(true);
    expect(result.current.capabilities.canConnect).toBe(true);
  });

  it("maps generic WalletSessionError to ERROR status", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(
        WalletSessionState.DISCONNECTED,
        null,
        new WalletSessionError("custom_code", "Something went wrong"),
      );
    });

    expect(result.current.status).toBe("ERROR");
    expect(result.current.error?.code).toBe("custom_code");
    expect(result.current.error?.message).toBe("Something went wrong");
    expect(result.current.error?.recoverable).toBe(false);
  });

  it("maps unknown Error to ERROR status with recoverable=false", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(
        WalletSessionState.DISCONNECTED,
        null,
        new Error("network timeout"),
      );
    });

    expect(result.current.status).toBe("ERROR");
    expect(result.current.error?.code).toBe("unknown_error");
    expect(result.current.error?.message).toBe("network timeout");
    expect(result.current.error?.recoverable).toBe(false);
    expect(result.current.capabilities.canConnect).toBe(true);
  });

  it("clears error when transitioning to CONNECTED", () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    act(() => {
      mockService._emit(
        WalletSessionState.DISCONNECTED,
        null,
        new ProviderNotFoundError(),
      );
    });

    expect(result.current.error).not.toBeNull();

    act(() => {
      mockService._emit(WalletSessionState.CONNECTED, MOCK_META, null);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("CONNECTED");
  });
});

// ── Actions ────────────────────────────────────────────────────────────────────

describe("connect action", () => {
  it("calls service.connect without adapter", async () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(mockService.connect).toHaveBeenCalledWith(undefined);
    expect(mockService.setProviderAdapter).not.toHaveBeenCalled();
  });

  it("calls setProviderAdapter then connect when adapter provided", async () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    const adapter = {
      isAvailable: vi.fn().mockReturnValue(true),
      connect: vi.fn().mockResolvedValue({
        address: "GABC",
        provider: MOCK_PROVIDER,
        network: "TESTNET",
      }),
    };

    await act(async () => {
      await result.current.connect(adapter as any, { network: "TESTNET" });
    });

    expect(mockService.setProviderAdapter).toHaveBeenCalledWith(adapter);
    expect(mockService.connect).toHaveBeenCalledWith({ network: "TESTNET" });
  });

  it("propagates connect rejection", async () => {
    mockService.connect.mockRejectedValueOnce(new ProviderNotFoundError());

    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    await expect(
      act(async () => {
        await result.current.connect();
      }),
    ).rejects.toBeInstanceOf(ProviderNotFoundError);
  });
});

describe("disconnect action", () => {
  it("calls service.disconnect", async () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    await act(async () => {
      await result.current.disconnect();
    });

    expect(mockService.disconnect).toHaveBeenCalledOnce();
  });

  it("propagates disconnect rejection", async () => {
    mockService.disconnect.mockRejectedValueOnce(new Error("provider error"));

    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    await expect(
      act(async () => {
        await result.current.disconnect();
      }),
    ).rejects.toThrow("provider error");
  });
});

describe("refresh action", () => {
  it("calls service.reconnect", async () => {
    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockService.reconnect).toHaveBeenCalledOnce();
  });

  it("propagates stale session error on refresh", async () => {
    mockService.reconnect.mockRejectedValueOnce(new StaleSessionError());

    const { result } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    await expect(
      act(async () => {
        await result.current.refresh();
      }),
    ).rejects.toBeInstanceOf(StaleSessionError);
  });
});

// ── Subscription cleanup ───────────────────────────────────────────────────────

describe("subscription lifecycle", () => {
  it("unsubscribes from service on unmount", () => {
    const { unmount } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    // Subscriber is registered
    expect(mockService["subscriber"]).not.toBeNull();

    unmount();

    // After unmount subscriber is cleared
    expect(mockService["subscriber"]).toBeNull();
  });

  it("does not update state after unmount", () => {
    const { unmount } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    unmount();

    // Emitting after unmount should not throw
    expect(() => {
      mockService._emit(WalletSessionState.CONNECTED, MOCK_META);
    }).not.toThrow();
  });
});

// ── Stable references ──────────────────────────────────────────────────────────

describe("stable references", () => {
  it("returns stable action callbacks across re-renders", () => {
    const { result, rerender } = renderHook(() =>
      useWalletStatus(mockService as any),
    );

    const initialConnect = result.current.connect;
    const initialDisconnect = result.current.disconnect;
    const initialRefresh = result.current.refresh;

    rerender();

    expect(result.current.connect).toBe(initialConnect);
    expect(result.current.disconnect).toBe(initialDisconnect);
    expect(result.current.refresh).toBe(initialRefresh);
  });
});
