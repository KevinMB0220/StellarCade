/**
 * useTxStatus — React hook for normalised transaction status tracking.
 *
 * Wraps TxStatusService so React components can track the full lifecycle of
 * a Stellar/Soroban on-chain transaction without managing polling or state
 * transitions directly.
 *
 * Usage example:
 *
 *   const provider: TxStatusProvider = {
 *     async fetchStatus(hash) {
 *       const res = await sorobanRpc.getTransaction(hash);
 *       return res.status;
 *     },
 *   };
 *
 *   function GameResult() {
 *     const { phase, meta, error, track } = useTxStatus(provider);
 *
 *     const handleSubmit = async () => {
 *       const hash = await wallet.submitTx(xdr);
 *       track(hash);
 *     };
 *
 *     if (phase === TxPhase.CONFIRMED) return <p>Transaction confirmed!</p>;
 *     if (phase === TxPhase.FAILED)    return <p>Failed: {error?.message}</p>;
 *     return <button onClick={handleSubmit}>Submit</button>;
 *   }
 *
 * The hook is UI-agnostic — it returns typed state only and performs no
 * rendering. Pass an optional `service` instance to share state across
 * multiple hook usages (e.g. a context provider pattern).
 */

import { useEffect, useRef, useState } from 'react';
import { TxStatusService } from '../../utils/v1/useTxStatus';
import type {
    TxPhase,
    TxStatusMeta,
    TxStatusProvider,
    TxStatusOptions,
    TxStatusError,
} from '../../types/tx-status';

// ---------------------------------------------------------------------------
// Public hook return type
// ---------------------------------------------------------------------------

export interface UseTxStatusReturn {
    /** Current lifecycle phase. IDLE until track() is called. */
    phase: TxPhase;
    /** Full metadata snapshot; null when phase is IDLE. */
    meta: TxStatusMeta | null;
    /** Populated when phase is FAILED; null otherwise. */
    error: TxStatusError | null;
    /**
     * Begin tracking a transaction hash.
     * Throws TxValidationError synchronously if hash is empty/null/undefined.
     * Safe to call multiple times — resets and restarts tracking each time.
     */
    track: (hash: string) => void;
    /** Cancel active polling without changing the current phase. */
    stop: () => void;
    /** Direct access to the underlying service (for testing or advanced use). */
    service: TxStatusService;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * @param provider  - Injectable RPC/API adapter. Required unless `service` is
 *                    supplied directly.
 * @param opts      - Polling options (pollIntervalMs, maxAttempts).
 * @param service   - Optional pre-constructed TxStatusService to share across
 *                    hook instances (e.g. from a React context).
 */
export function useTxStatus(
    provider?: TxStatusProvider | null,
    opts?: TxStatusOptions,
    service?: TxStatusService,
): UseTxStatusReturn {
    // Stable service reference — created once, never re-created on re-renders.
    const svcRef = useRef<TxStatusService | null>(service ?? null);
    if (!svcRef.current) {
        // provider is validated inside TxStatusService constructor
        svcRef.current = new TxStatusService(provider ?? null, opts);
    }
    const svc = svcRef.current;

    const [phase, setPhase] = useState<TxPhase>(svc.getPhase());
    const [meta, setMeta] = useState<TxStatusMeta | null>(svc.getMeta());
    const [error, setError] = useState<TxStatusError | null>(null);

    useEffect(() => {
        const unsubscribe = svc.subscribe((p, m, e) => {
            setPhase(p);
            setMeta(m);
            setError(e);
        });
        return () => {
            unsubscribe();
            svc.stop();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const track = (hash: string) => svc.track(hash);
    const stop = () => svc.stop();

    return { phase, meta, error, track, stop, service: svc };
}

export default useTxStatus;
