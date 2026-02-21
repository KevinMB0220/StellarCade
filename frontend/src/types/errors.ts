/**
 * Stellarcade domain error catalog.
 *
 * All external failure surfaces (Soroban RPC, backend API, wallet provider,
 * smart contract logic) are mapped to typed AppError values so consuming
 * modules never inspect raw provider errors directly.
 */

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export const ErrorDomain = {
  RPC:      'rpc',
  API:      'api',
  WALLET:   'wallet',
  CONTRACT: 'contract',
  UNKNOWN:  'unknown',
} as const;

export type ErrorDomain = (typeof ErrorDomain)[keyof typeof ErrorDomain];

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export const ErrorSeverity = {
  /** Transient failure — caller may retry after a delay. */
  RETRYABLE: 'retryable',
  /** User must take an explicit action (connect wallet, switch network, etc.). */
  USER_ACTIONABLE: 'user_actionable',
  /** Non-recoverable — no retry or user action will resolve it. */
  FATAL: 'fatal',
} as const;

export type ErrorSeverity = (typeof ErrorSeverity)[keyof typeof ErrorSeverity];

// ---------------------------------------------------------------------------
// Error codes — one union per domain
// ---------------------------------------------------------------------------

export type RpcErrorCode =
  | 'RPC_NODE_UNAVAILABLE'
  | 'RPC_CONNECTION_TIMEOUT'
  | 'RPC_SIMULATION_FAILED'
  | 'RPC_TX_REJECTED'
  | 'RPC_TX_EXPIRED'
  | 'RPC_RESOURCE_LIMIT_EXCEEDED'
  | 'RPC_INVALID_RESPONSE'
  | 'RPC_UNKNOWN';

export type ApiErrorCode =
  | 'API_NETWORK_ERROR'
  | 'API_UNAUTHORIZED'
  | 'API_FORBIDDEN'
  | 'API_NOT_FOUND'
  | 'API_VALIDATION_ERROR'
  | 'API_RATE_LIMITED'
  | 'API_SERVER_ERROR'
  | 'API_UNKNOWN';

export type WalletErrorCode =
  | 'WALLET_NOT_INSTALLED'
  | 'WALLET_NOT_CONNECTED'
  | 'WALLET_USER_REJECTED'
  | 'WALLET_NETWORK_MISMATCH'
  | 'WALLET_INSUFFICIENT_BALANCE'
  | 'WALLET_SIGN_FAILED'
  | 'WALLET_UNKNOWN';

/**
 * Contract error codes cover all numeric variants across deployed Stellarcade
 * contracts. Codes are disambiguated by ContractName before mapping — numeric
 * slot 4 means InvalidAmount in PrizePool but InvalidBound in RandomGenerator.
 */
export type ContractErrorCode =
  | 'CONTRACT_ALREADY_INITIALIZED'
  | 'CONTRACT_NOT_INITIALIZED'
  | 'CONTRACT_NOT_AUTHORIZED'
  | 'CONTRACT_INVALID_AMOUNT'
  | 'CONTRACT_INSUFFICIENT_FUNDS'
  | 'CONTRACT_GAME_ALREADY_RESERVED'
  | 'CONTRACT_RESERVATION_NOT_FOUND'
  | 'CONTRACT_PAYOUT_EXCEEDS_RESERVATION'
  | 'CONTRACT_OVERFLOW'
  | 'CONTRACT_INVALID_BOUND'
  | 'CONTRACT_DUPLICATE_REQUEST_ID'
  | 'CONTRACT_REQUEST_NOT_FOUND'
  | 'CONTRACT_ALREADY_FULFILLED'
  | 'CONTRACT_UNAUTHORIZED_CALLER'
  | 'CONTRACT_UNKNOWN';

export type AppErrorCode =
  | RpcErrorCode
  | ApiErrorCode
  | WalletErrorCode
  | ContractErrorCode
  | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Core AppError
// ---------------------------------------------------------------------------

export interface AppError {
  /** Structured code for programmatic branching — never parse `message` for logic. */
  code: AppErrorCode;
  domain: ErrorDomain;
  severity: ErrorSeverity;
  /**
   * Human-readable description intended for developer tooling and logs.
   * Do NOT render this string directly in user-facing UI without sanitisation.
   */
  message: string;
  /** The raw error that was mapped, preserved for debugging and logging. */
  originalError?: unknown;
  /** Caller-provided enrichment (e.g. gameId, requestId, walletAddress). */
  context?: Record<string, unknown>;
  /** For RETRYABLE errors: suggested minimum wait before retrying (ms). */
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** Hint passed to toAppError() when the domain cannot be auto-detected. */
export type ErrorMappingHint = ErrorDomain;

/**
 * Named identifiers for each deployed Stellarcade Soroban contract.
 * Required by mapContractError() to disambiguate shared numeric error slots.
 */
export const ContractName = {
  PRIZE_POOL:        'prize_pool',
  RANDOM_GENERATOR:  'random_generator',
  ACCESS_CONTROL:    'access_control',
  PATTERN_PUZZLE:    'pattern_puzzle',
  COIN_FLIP:         'coin_flip',
} as const;

export type ContractName = (typeof ContractName)[keyof typeof ContractName];

/** Structured payload for telemetry/logging pipelines. */
export interface TelemetryEvent {
  errorCode: AppErrorCode;
  domain: ErrorDomain;
  severity: ErrorSeverity;
  message: string;
  timestamp: number;
  correlationId?: string;
  userId?: string;
  context?: Record<string, unknown>;
}
