/**
 * Typed contracts for the transaction status tracking module.
 *
 * All external status strings from RPC providers or the backend API are
 * normalised to TxPhase values so consuming modules never inspect raw
 * provider data directly.
 */

// ---------------------------------------------------------------------------
// Lifecycle phase
// ---------------------------------------------------------------------------

/**
 * Canonical transaction lifecycle phases.
 *
 * IDLE        — no transaction is being tracked (initial state).
 * SUBMITTED   — tx hash received; awaiting network acknowledgement.
 * PENDING     — tx seen on chain; awaiting sufficient confirmations.
 * CONFIRMED   — tx included in a ledger with enough confirmations (terminal).
 * FAILED      — tx was rejected, timed-out, or encountered an error (terminal).
 */
export const TxPhase = {
  IDLE:      'IDLE',
  SUBMITTED: 'SUBMITTED',
  PENDING:   'PENDING',
  CONFIRMED: 'CONFIRMED',
  FAILED:    'FAILED',
} as const;

export type TxPhase = (typeof TxPhase)[keyof typeof TxPhase];

/** Phases from which no further transitions occur. */
export const TERMINAL_PHASES: ReadonlySet<TxPhase> = new Set([
  TxPhase.CONFIRMED,
  TxPhase.FAILED,
]);

// ---------------------------------------------------------------------------
// Raw provider status strings
// ---------------------------------------------------------------------------

/**
 * Provider/backend raw status strings that are normalised into TxPhase.
 * Add new variants here without touching the public API.
 */
export type RawTxStatus =
  // Soroban RPC "getTransaction" result statuses
  | 'NOT_FOUND'
  | 'SUCCESS'
  | 'FAILED'
  // Horizon transaction statuses (submitted via the REST API)
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'error'
  // Backend API custom statuses
  | 'submitted'
  | 'processing'
  // Generic fallback
  | string;

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

/**
 * Minimal adapter for injecting an RPC / API client into TxStatusService.
 * Callers provide a concrete implementation — the service never imports
 * network libraries directly.
 */
export interface TxStatusProvider {
  /**
   * Fetch the current on-chain / backend status of a transaction.
   * Must resolve with a RawTxStatus string, or reject on network errors.
   * Should NOT throw for "not found" — return 'NOT_FOUND' instead.
   */
  fetchStatus(hash: string): Promise<RawTxStatus>;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface TxStatusMeta {
  /** The transaction hash being tracked. */
  hash: string;
  /** Current normalised phase. */
  phase: TxPhase;
  /** Number of ledger confirmations observed (0 while pending). */
  confirmations: number;
  /** Epoch ms when track() was first called. */
  submittedAt: number;
  /** Epoch ms when CONFIRMED or FAILED was reached; undefined until then. */
  settledAt?: number;
  /** Structured error if phase is FAILED; undefined otherwise. */
  error?: TxStatusError;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TxStatusOptions {
  /** How often to poll for status updates (ms). Default: 3 000. */
  pollIntervalMs?: number;
  /**
   * Maximum poll attempts before the tracker gives up and transitions to
   * FAILED with TxTimeoutError. Default: 20 (~1 min at 3 s interval).
   */
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export class TxStatusError extends Error {
  public readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'TxStatusError';
  }
}

/** Thrown when track() is called with a missing or obviously invalid hash. */
export class TxValidationError extends TxStatusError {
  constructor(message?: string) {
    super('tx_validation_error', message ?? 'Transaction hash is required');
    this.name = 'TxValidationError';
  }
}

/** Emitted when the tracker exhausts its poll budget without reaching a terminal state. */
export class TxTimeoutError extends TxStatusError {
  constructor(hash: string, attempts: number) {
    super(
      'tx_timeout',
      `Transaction ${hash} did not settle after ${attempts} poll attempts`,
    );
    this.name = 'TxTimeoutError';
  }
}

/** Emitted when the provider reports an explicit on-chain or backend failure. */
export class TxRejectedError extends TxStatusError {
  constructor(hash: string, reason?: string) {
    super(
      'tx_rejected',
      reason ?? `Transaction ${hash} was rejected by the network`,
    );
    this.name = 'TxRejectedError';
  }
}

/** Thrown when no provider was supplied to TxStatusService. */
export class TxProviderMissingError extends TxStatusError {
  constructor() {
    super('tx_provider_missing', 'A TxStatusProvider is required but was not supplied');
    this.name = 'TxProviderMissingError';
  }
}
