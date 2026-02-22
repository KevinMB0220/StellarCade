/**
 * Tests for TxStatusService (utils/v1/useTxStatus.ts).
 *
 * All RPC calls are replaced with a deterministic MockTxStatusProvider so tests
 * are synchronous and have no external dependencies.
 *
 * Test matrix:
 *  - Happy path: IDLE → SUBMITTED → PENDING → CONFIRMED
 *  - Provider returns FAILED → terminates with TxRejectedError
 *  - maxAttempts exhausted → terminates with TxTimeoutError
 *  - Invalid hash (null / undefined / empty string) → TxValidationError
 *  - subscribe() emits current state immediately (sync)
 *  - stop() cancels in-flight polling
 *  - Duplicate track() calls reset state without leaking timers
 *  - Multiple subscribers all receive updates
 *  - normaliseStatus() maps all recognised raw strings correctly
 *  - Missing provider → TxProviderMissingError
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TxStatusService, normaliseStatus } from '../../../src/utils/v1/useTxStatus';
import {
    TxPhase,
    TxValidationError,
    TxTimeoutError,
    TxRejectedError,
    TxProviderMissingError,
    type TxStatusProvider,
    type RawTxStatus,
} from '../../../src/types/tx-status';

// ---------------------------------------------------------------------------
// Mock provider helpers
// ---------------------------------------------------------------------------

/** Build a provider that returns a fixed sequence of statuses, then loops on the last. */
function makeSequenceProvider(statuses: RawTxStatus[]): TxStatusProvider {
    let call = 0;
    return {
        async fetchStatus(_hash: string): Promise<RawTxStatus> {
            const idx = Math.min(call++, statuses.length - 1);
            return statuses[idx];
        },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all pending timers and micro-tasks. */
async function flushTimers(): Promise<void> {
    vi.runAllTimers();
    // Allow micro-task queue (await inside poll) to drain
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// normaliseStatus unit tests
// ---------------------------------------------------------------------------

describe('normaliseStatus', () => {
    it.each<[RawTxStatus, TxPhase]>([
        ['SUCCESS', TxPhase.CONFIRMED],
        ['confirmed', TxPhase.CONFIRMED],
        ['FAILED', TxPhase.FAILED],
        ['failed', TxPhase.FAILED],
        ['error', TxPhase.FAILED],
        ['NOT_FOUND', TxPhase.PENDING],
        ['submitted', TxPhase.PENDING],
        ['processing', TxPhase.PENDING],
        ['pending', TxPhase.PENDING],
        ['unknown_raw', TxPhase.PENDING], // conservative fallback
    ])('maps %s → %s', (raw, expected) => {
        expect(normaliseStatus(raw)).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// TxStatusService tests
// ---------------------------------------------------------------------------

describe('TxStatusService', () => {
    const HASH = 'abc123def456';

    // ── constructor ────────────────────────────────────────────────────────────

    it('throws TxProviderMissingError when provider is null', () => {
        expect(() => new TxStatusService(null)).toThrow(TxProviderMissingError);
    });

    it('throws TxProviderMissingError when provider is undefined', () => {
        expect(() => new TxStatusService(undefined)).toThrow(TxProviderMissingError);
    });

    it('starts in IDLE phase with null meta', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        expect(svc.getPhase()).toBe(TxPhase.IDLE);
        expect(svc.getMeta()).toBeNull();
    });

    // ── input validation ───────────────────────────────────────────────────────

    it('throws TxValidationError for null hash', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        expect(() => svc.track(null as any)).toThrow(TxValidationError);
    });

    it('throws TxValidationError for undefined hash', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        expect(() => svc.track(undefined as any)).toThrow(TxValidationError);
    });

    it('throws TxValidationError for empty string hash', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        expect(() => svc.track('')).toThrow(TxValidationError);
    });

    it('throws TxValidationError for whitespace-only hash', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        expect(() => svc.track('   ')).toThrow(TxValidationError);
    });

    it('does not mutate state when validation fails', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        try { svc.track(''); } catch (_) { /* expected */ }
        expect(svc.getPhase()).toBe(TxPhase.IDLE);
        expect(svc.getMeta()).toBeNull();
    });

    // ── subscribe() ────────────────────────────────────────────────────────────

    it('subscribe() emits current state immediately (sync)', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        const calls: TxPhase[] = [];
        svc.subscribe((p) => calls.push(p));
        // Should have received IDLE synchronously on subscribe
        expect(calls).toEqual([TxPhase.IDLE]);
    });

    it('subscribe() returns an unsubscribe function', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        const calls: TxPhase[] = [];
        const unsub = svc.subscribe((p) => calls.push(p));
        expect(typeof unsub).toBe('function');
        unsub();
        // Calling track now should NOT add more entries
        svc.track(HASH);
        expect(calls).toEqual([TxPhase.IDLE]); // only the initial emit
    });

    it('late subscribers receive current error in initial emit if FAILED', async () => {
        const svc = new TxStatusService(
            makeSequenceProvider(['FAILED']),
            { pollIntervalMs: 100 },
        );
        svc.track(HASH);
        await flushTimers(); // service reaches FAILED
        expect(svc.getPhase()).toBe(TxPhase.FAILED);

        let receivedError: any = null;
        svc.subscribe((_p, _m, e) => { receivedError = e; });
        expect(receivedError).toBeInstanceOf(TxRejectedError);
    });

    it('invalid subscriber throws TxValidationError', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        expect(() => svc.subscribe(null as any)).toThrow(TxValidationError);
    });

    // ── track() state transitions ──────────────────────────────────────────────

    it('transitions to SUBMITTED immediately on track()', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']), {
            pollIntervalMs: 1000,
        });
        const phases: TxPhase[] = [];
        svc.subscribe((p) => phases.push(p));
        svc.track(HASH);
        // IDLE (subscribe) + SUBMITTED (after track)
        expect(phases).toContain(TxPhase.SUBMITTED);
        expect(svc.getMeta()?.hash).toBe(HASH);
        expect(svc.getMeta()?.submittedAt).toBeTypeOf('number');
    });

    it('transitions PENDING → CONFIRMED on SUCCESS response', async () => {
        const svc = new TxStatusService(
            makeSequenceProvider(['NOT_FOUND', 'SUCCESS']),
            { pollIntervalMs: 100, maxAttempts: 10 },
        );
        const phases: TxPhase[] = [];
        svc.subscribe((p) => phases.push(p));
        svc.track(HASH);

        // First poll → PENDING
        await flushTimers();
        // Second poll → CONFIRMED
        await flushTimers();

        expect(phases).toContain(TxPhase.PENDING);
        expect(phases).toContain(TxPhase.CONFIRMED);
        expect(svc.getMeta()?.settledAt).toBeTypeOf('number');
    });

    it('transitions to FAILED with TxRejectedError on FAILED response', async () => {
        const svc = new TxStatusService(
            makeSequenceProvider(['FAILED']),
            { pollIntervalMs: 100, maxAttempts: 10 },
        );
        const errors: unknown[] = [];
        svc.subscribe((_p, _m, e) => { if (e) errors.push(e); });
        svc.track(HASH);
        await flushTimers();

        expect(svc.getPhase()).toBe(TxPhase.FAILED);
        expect(errors[0]).toBeInstanceOf(TxRejectedError);
    });

    it('sets settledAt when reaching FAILED', async () => {
        const svc = new TxStatusService(
            makeSequenceProvider(['FAILED']),
            { pollIntervalMs: 100, maxAttempts: 5 },
        );
        svc.track(HASH);
        await flushTimers();
        expect(svc.getMeta()?.settledAt).toBeTypeOf('number');
    });

    // ── maxAttempts / timeout ──────────────────────────────────────────────────

    it('fails with TxTimeoutError when maxAttempts is exhausted', async () => {
        const svc = new TxStatusService(
            makeSequenceProvider(['NOT_FOUND']), // never settles
            { pollIntervalMs: 100, maxAttempts: 3 },
        );
        const errors: unknown[] = [];
        svc.subscribe((_p, _m, e) => { if (e) errors.push(e); });
        svc.track(HASH);

        // Flush 4 polls (3 attempts + budget-check on 4th)
        for (let i = 0; i < 5; i++) await flushTimers();

        expect(svc.getPhase()).toBe(TxPhase.FAILED);
        expect(errors[0]).toBeInstanceOf(TxTimeoutError);
    });

    // ── terminal state stops polling ───────────────────────────────────────────

    it('stops polling after reaching CONFIRMED (no extra subscriber calls)', async () => {
        const provider = makeSequenceProvider(['SUCCESS']);
        const fetchSpy = vi.spyOn(provider, 'fetchStatus');

        const svc = new TxStatusService(provider, { pollIntervalMs: 100, maxAttempts: 10 });
        svc.track(HASH);
        await flushTimers(); // → CONFIRMED

        const callCountAfterConfirm = fetchSpy.mock.calls.length;
        // Flush timers again — polling must NOT fire again
        await flushTimers();
        expect(fetchSpy.mock.calls.length).toBe(callCountAfterConfirm);
    });

    // ── stop() ────────────────────────────────────────────────────────────────

    it('stop() cancels in-flight polling', async () => {
        const provider = makeSequenceProvider(['NOT_FOUND', 'NOT_FOUND', 'SUCCESS']);
        const fetchSpy = vi.spyOn(provider, 'fetchStatus');

        const svc = new TxStatusService(provider, { pollIntervalMs: 100, maxAttempts: 10 });
        svc.track(HASH);
        await flushTimers(); // first poll fires → PENDING
        svc.stop();
        await flushTimers(); // no further polls after stop
        const callsBeforeDrain = fetchSpy.mock.calls.length;
        await flushTimers();
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeDrain);
    });

    // ── duplicate track() calls ────────────────────────────────────────────────

    it('duplicate track() resets state cleanly without leaking intervals', async () => {
        const provider = makeSequenceProvider(['NOT_FOUND']);
        const fetchSpy = vi.spyOn(provider, 'fetchStatus');

        const svc = new TxStatusService(provider, { pollIntervalMs: 100, maxAttempts: 10 });
        svc.track(HASH);
        await flushTimers(); // first poll
        svc.track('newHash456'); // restart

        expect(svc.getMeta()?.hash).toBe('newHash456');
        expect(svc.getPhase()).toBe(TxPhase.SUBMITTED);

        await flushTimers(); // only ONE poll for the new hash
        // The spy should not grow unboundedly — no timer leak
        const callCount = fetchSpy.mock.calls.length;
        await flushTimers();
        // At most one additional call (from the new hash's first poll)
        expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(callCount + 1);
    });

    // ── multiple subscribers ───────────────────────────────────────────────────

    it('all subscribers receive the same state update', async () => {
        const svc = new TxStatusService(
            makeSequenceProvider(['SUCCESS']),
            { pollIntervalMs: 100, maxAttempts: 10 },
        );
        const a: TxPhase[] = [];
        const b: TxPhase[] = [];
        const c: TxPhase[] = [];
        svc.subscribe((p) => a.push(p));
        svc.subscribe((p) => b.push(p));
        svc.subscribe((p) => c.push(p));
        svc.track(HASH);
        await flushTimers();

        const lastA = a[a.length - 1];
        const lastB = b[b.length - 1];
        const lastC = c[c.length - 1];
        expect(lastA).toBe(lastB);
        expect(lastB).toBe(lastC);
        expect(lastA).toBe(TxPhase.CONFIRMED);
    });

    // ── network errors during polling ──────────────────────────────────────────

    it('retries after a provider network error without crashing', async () => {
        let attempt = 0;
        const provider: TxStatusProvider = {
            async fetchStatus() {
                attempt++;
                if (attempt === 1) throw new Error('Network unreachable');
                return 'SUCCESS';
            },
        };
        const svc = new TxStatusService(provider, { pollIntervalMs: 100, maxAttempts: 5 });
        svc.track(HASH);

        await flushTimers(); // attempt 1 → network error → retry scheduled
        await flushTimers(); // attempt 2 → SUCCESS

        expect(svc.getPhase()).toBe(TxPhase.CONFIRMED);
    });

    // ── meta integrity ─────────────────────────────────────────────────────────

    it('meta.confirmations defaults to 0 and meta.hash matches track() input', () => {
        const svc = new TxStatusService(
            makeSequenceProvider(['NOT_FOUND']),
            { pollIntervalMs: 100 },
        );
        svc.track(HASH);
        const meta = svc.getMeta();
        expect(meta?.hash).toBe(HASH);
        expect(meta?.confirmations).toBe(0);
        expect(meta?.submittedAt).toBeTypeOf('number');
        expect(meta?.settledAt).toBeUndefined();
    });

    it('getMeta() returns null before track() is called', () => {
        const svc = new TxStatusService(makeSequenceProvider(['NOT_FOUND']));
        expect(svc.getMeta()).toBeNull();
    });
});
