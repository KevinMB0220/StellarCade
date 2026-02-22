/**
 * TxStatusService — pure (non-React) utility for tracking the lifecycle of
 * a Stellar/Soroban on-chain transaction.
 *
 * Tracks the lifecycle:
 *   IDLE → SUBMITTED → PENDING → CONFIRMED | FAILED
 *
 * Usage example:
 *
 *   const provider: TxStatusProvider = {
 *     async fetchStatus(hash) {
 *       const res = await rpcClient.getTransaction(hash);
 *       return res.status; // 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | ...
 *     },
 *   };
 *
 *   const svc = new TxStatusService(provider, { pollIntervalMs: 3000, maxAttempts: 20 });
 *   svc.subscribe((phase, meta, err) => console.log(phase, meta, err));
 *   await svc.track('a1b2c3...');
 *
 * The service is injected with a `TxStatusProvider` adapter so RPC/API
 * dependencies are deterministic in tests and swappable at runtime.
 */

import {
    TxPhase,
    TERMINAL_PHASES,
    TxStatusMeta,
    TxStatusOptions,
    TxStatusProvider,
    TxStatusError,
    TxValidationError,
    TxTimeoutError,
    TxRejectedError,
    TxProviderMissingError,
    RawTxStatus,
} from '../../types/tx-status';

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_ATTEMPTS = 20;

// ---------------------------------------------------------------------------
// Subscriber type
// ---------------------------------------------------------------------------

export type TxStatusSubscriber = (
    phase: TxPhase,
    meta: TxStatusMeta | null,
    error: TxStatusError | null,
) => void;

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a raw provider status string into a canonical TxPhase.
 *
 * Raw string mapping:
 *  NOT_FOUND / submitted / processing → PENDING  (tx known but not settled)
 *  SUCCESS   / confirmed              → CONFIRMED
 *  FAILED    / failed / error         → FAILED
 *  anything else                      → PENDING  (conservative fallback)
 */
export function normaliseStatus(raw: RawTxStatus): TxPhase {
    switch (raw.toLowerCase()) {
        case 'success':
        case 'confirmed':
            return TxPhase.CONFIRMED;

        case 'failed':
        case 'error':
            return TxPhase.FAILED;

        case 'not_found':
        case 'submitted':
        case 'processing':
        case 'pending':
        default:
            return TxPhase.PENDING;
    }
}

// ---------------------------------------------------------------------------
// TxStatusService
// ---------------------------------------------------------------------------

export class TxStatusService {
    private readonly provider: TxStatusProvider;
    private readonly pollIntervalMs: number;
    private readonly maxAttempts: number;

    private phase: TxPhase = TxPhase.IDLE;
    private meta: TxStatusMeta | null = null;
    private subscribers: Set<TxStatusSubscriber> = new Set();

    // Polling state
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private attempts = 0;
    private stopped = false;

    constructor(provider: TxStatusProvider | null | undefined, opts?: TxStatusOptions) {
        if (!provider) throw new TxProviderMissingError();
        this.provider = provider;
        this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /**
     * Begin tracking a transaction hash.
     * Cancels any in-progress tracking before starting fresh.
     * Throws TxValidationError synchronously if `hash` is invalid.
     */
    public track(hash: unknown): void {
        // Input validation — guard before any state mutation
        if (typeof hash !== 'string' || hash.trim() === '') {
            throw new TxValidationError();
        }
        const cleanHash = hash.trim();

        // Cancel any running poll
        this.stop();

        // Reset state
        this.stopped = false;
        this.attempts = 0;
        this.phase = TxPhase.SUBMITTED;
        this.meta = {
            hash: cleanHash,
            phase: TxPhase.SUBMITTED,
            confirmations: 0,
            submittedAt: Date.now(),
        };

        this.notify(null);
        this.schedulePoll(cleanHash);
    }

    /**
     * Cancel any active polling. Safe to call if already stopped or idle.
     */
    public stop(): void {
        this.stopped = true;
        if (this.pollTimer !== null) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /**
     * Subscribe to state changes. The subscriber is called immediately with
     * the current state, then on every subsequent change.
     * Returns an unsubscribe function.
     */
    public subscribe(fn: TxStatusSubscriber): () => void {
        if (typeof fn !== 'function') {
            throw new TxValidationError('Subscriber must be a function');
        }
        this.subscribers.add(fn);
        // Emit current state immediately
        try {
            fn(this.phase, this.meta, this.meta?.error ?? null);
        } catch (e) {
            console.error('[TxStatusService] Subscriber threw on initial call', e);
        }
        return () => {
            this.subscribers.delete(fn);
        };
    }

    /** Synchronous snapshot of the current phase. */
    public getPhase(): TxPhase {
        return this.phase;
    }

    /** Synchronous snapshot of the current metadata, or null when IDLE. */
    public getMeta(): TxStatusMeta | null {
        return this.meta;
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private schedulePoll(hash: string): void {
        if (this.stopped) return;

        this.pollTimer = setTimeout(() => {
            void this.poll(hash);
        }, this.pollIntervalMs);
    }

    private async poll(hash: string): Promise<void> {
        if (this.stopped) return;

        this.attempts += 1;

        // Budget exhausted → timeout
        if (this.attempts > this.maxAttempts) {
            const err = new TxTimeoutError(hash, this.maxAttempts);
            this.transitionTo(TxPhase.FAILED, err);
            return;
        }

        let rawStatus: RawTxStatus;
        try {
            rawStatus = await this.provider.fetchStatus(hash);
        } catch (e) {
            // Network / provider error — treat as PENDING and retry
            this.schedulePoll(hash);
            return;
        }

        const phase = normaliseStatus(rawStatus);

        if (phase === TxPhase.FAILED) {
            const err = new TxRejectedError(hash);
            this.transitionTo(TxPhase.FAILED, err);
            return;
        }

        if (phase === TxPhase.CONFIRMED) {
            this.transitionTo(TxPhase.CONFIRMED, null);
            return;
        }

        // Still pending — keep polling
        this.transitionTo(TxPhase.PENDING, null);
        this.schedulePoll(hash);
    }

    private transitionTo(phase: TxPhase, error: TxStatusError | null): void {
        const isTerminal = TERMINAL_PHASES.has(phase);

        this.phase = phase;
        if (this.meta) {
            this.meta = {
                ...this.meta,
                phase,
                ...(isTerminal ? { settledAt: Date.now() } : {}),
                ...(error ? { error } : {}),
            };
        }

        if (isTerminal) {
            this.stop();
        }

        this.notify(error);
    }

    private notify(error: TxStatusError | null): void {
        for (const s of this.subscribers) {
            try {
                s(this.phase, this.meta, error);
            } catch (e) {
                console.error('[TxStatusService] Subscriber threw', e);
            }
        }
    }
}

export default TxStatusService;
