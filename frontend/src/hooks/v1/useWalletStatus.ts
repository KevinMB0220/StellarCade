/**
 * useWalletStatus — unified wallet connection state hook (v1).
 *
 * Wraps WalletSessionService and exposes a normalized WalletStatus,
 * capability flags, typed error info, and action callbacks.
 *
 * @module hooks/v1/useWalletStatus
 */

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import WalletSessionService, {
  WalletProviderAdapter,
} from "../../services/wallet-session-service";
import {
  WalletSessionState,
  WalletSessionError,
  ProviderNotFoundError,
  RejectedSignatureError,
  StaleSessionError,
} from "../../types/wallet-session";
import type { WalletSessionMeta, WalletProviderInfo } from "../../types/wallet-session";

// ── Public types ───────────────────────────────────────────────────────────────

/**
 * Normalized wallet status that extends the internal session state with
 * specific error states so consumers can react without inspecting raw errors.
 */
export type WalletStatus =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "PROVIDER_MISSING"
  | "PERMISSION_DENIED"
  | "STALE_SESSION"
  | "ERROR";

/** Derived boolean flags for common UI conditions. */
export interface WalletCapabilities {
  isConnected: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  /** True when it makes sense to offer a connect action to the user. */
  canConnect: boolean;
}

/** Typed error surface exposed by the hook. */
export interface WalletStatusError {
  code: string;
  message: string;
  /** Whether retrying (e.g. re-connecting) may resolve the error. */
  recoverable: boolean;
}

export interface UseWalletStatusReturn {
  status: WalletStatus;
  address: string | null;
  network: string | null;
  provider: WalletProviderInfo | null;
  capabilities: WalletCapabilities;
  error: WalletStatusError | null;
  connect: (
    adapter?: WalletProviderAdapter,
    opts?: { network?: string },
  ) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Re-validates and restores a stored session (wraps service.reconnect). */
  refresh: () => Promise<void>;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function deriveStatus(
  sessionState: WalletSessionState,
  error: Error | null,
): WalletStatus {
  switch (sessionState) {
    case WalletSessionState.CONNECTING:
      return "CONNECTING";
    case WalletSessionState.CONNECTED:
      return "CONNECTED";
    case WalletSessionState.RECONNECTING:
      return "RECONNECTING";
    default:
      // DISCONNECTED — refine with error type
      if (!error) return "DISCONNECTED";
      if (error instanceof ProviderNotFoundError) return "PROVIDER_MISSING";
      if (error instanceof RejectedSignatureError) return "PERMISSION_DENIED";
      if (error instanceof StaleSessionError) return "STALE_SESSION";
      return "ERROR";
  }
}

function deriveCapabilities(status: WalletStatus): WalletCapabilities {
  return {
    isConnected: status === "CONNECTED",
    isConnecting: status === "CONNECTING",
    isReconnecting: status === "RECONNECTING",
    canConnect:
      status === "DISCONNECTED" ||
      status === "PROVIDER_MISSING" ||
      status === "PERMISSION_DENIED" ||
      status === "STALE_SESSION" ||
      status === "ERROR",
  };
}

function mapToStatusError(error: Error | null): WalletStatusError | null {
  if (!error) return null;
  if (error instanceof ProviderNotFoundError) {
    return { code: error.code, message: error.message, recoverable: false };
  }
  if (error instanceof RejectedSignatureError) {
    return { code: error.code, message: error.message, recoverable: true };
  }
  if (error instanceof StaleSessionError) {
    return { code: error.code, message: error.message, recoverable: true };
  }
  if (error instanceof WalletSessionError) {
    return { code: error.code, message: error.message, recoverable: false };
  }
  return {
    code: "unknown_error",
    message: error.message ?? "Unknown error",
    recoverable: false,
  };
}

// ── Hook ───────────────────────────────────────────────────────────────────────

/**
 * Unified wallet connection state hook.
 *
 * @param service - Optional pre-constructed WalletSessionService. When omitted
 *   a new instance is created and owned by the hook.
 *
 * @example
 * ```tsx
 * function WalletButton() {
 *   const { status, address, capabilities, connect, disconnect } = useWalletStatus();
 *
 *   if (capabilities.isConnected) {
 *     return <button onClick={disconnect}>Disconnect {address}</button>;
 *   }
 *   return (
 *     <button disabled={!capabilities.canConnect} onClick={() => connect(freighterAdapter)}>
 *       Connect Wallet
 *     </button>
 *   );
 * }
 * ```
 */
export function useWalletStatus(
  service?: WalletSessionService,
): UseWalletStatusReturn {
  const svcRef = useRef<WalletSessionService | null>(service ?? null);
  if (!svcRef.current) {
    svcRef.current = new WalletSessionService();
  }

  const [sessionState, setSessionState] = useState<WalletSessionState>(
    svcRef.current.getState(),
  );
  const [meta, setMeta] = useState<WalletSessionMeta | null>(
    svcRef.current.getMeta(),
  );
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const unsubscribe = svcRef.current!.subscribe((s, m, e) => {
      setSessionState(s);
      setMeta(m ?? null);
      setError(e ?? null);
    });
    return () => unsubscribe();
  }, []);

  const status = useMemo(
    () => deriveStatus(sessionState, error),
    [sessionState, error],
  );

  const capabilities = useMemo(() => deriveCapabilities(status), [status]);

  const statusError = useMemo(() => mapToStatusError(error), [error]);

  const connect = useCallback(
    async (
      adapter?: WalletProviderAdapter,
      opts?: { network?: string },
    ): Promise<void> => {
      if (adapter) svcRef.current!.setProviderAdapter(adapter);
      await svcRef.current!.connect(opts);
    },
    [],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    await svcRef.current!.disconnect();
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    await svcRef.current!.reconnect();
  }, []);

  return {
    status,
    address: meta?.address ?? null,
    network: meta?.network ?? null,
    provider: meta?.provider ?? null,
    capabilities,
    error: statusError,
    connect,
    disconnect,
    refresh,
  };
}

export default useWalletStatus;
