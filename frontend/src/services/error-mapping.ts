/**
 * Standardized Error Mapping — core module.
 *
 * Converts raw provider errors (Soroban RPC, backend API, Freighter wallet,
 * Soroban contract invocation) into typed AppError values. Consuming modules
 * import only from this file; they never inspect raw provider payloads.
 *
 * ## Design constraints
 * - Every public function returns AppError — none throw.
 * - Detection is entirely duck-typed; this module has no runtime dependency
 *   on @stellar/stellar-sdk so it stays tree-shakeable for non-Stellar pages.
 * - Unknown/unrecognized inputs produce a safe UNKNOWN fallback rather than
 *   crashing the caller.
 */

import {
  AppError,
  AppErrorCode,
  ContractErrorCode,
  ContractName,
  ErrorDomain,
  ErrorMappingHint,
  ErrorSeverity,
  TelemetryEvent,
  type ContractName as ContractNameType,
} from '../types/errors';

// ---------------------------------------------------------------------------
// Internal catalog helpers
// ---------------------------------------------------------------------------

type ErrorTemplate = Omit<AppError, 'originalError' | 'context' | 'retryAfterMs'>;

function makeError(
  template: ErrorTemplate,
  raw: unknown,
  context?: Record<string, unknown>,
): AppError {
  return {
    ...template,
    originalError: raw,
    ...(context ? { context } : {}),
  };
}

// ---------------------------------------------------------------------------
// RPC error mapping
// ---------------------------------------------------------------------------

/**
 * Pattern-match known Soroban/Horizon RPC error shapes.
 *
 * Matches against:
 * - Fetch API network failures (TypeError: Failed to fetch)
 * - AbortController timeouts (AbortError)
 * - Soroban simulation error responses: { error: string }
 * - Horizon submission extras.result_codes
 * - Generic HTTP-level errors with a .status field
 */
export function mapRpcError(
  raw: unknown,
  context?: Record<string, unknown>,
): AppError {
  const msg = extractMessage(raw);
  const lower = msg.toLowerCase();

  // Network-level failures
  if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return makeError(
      {
        code: 'RPC_NODE_UNAVAILABLE',
        domain: ErrorDomain.RPC,
        severity: ErrorSeverity.RETRYABLE,
        message: 'Soroban RPC node is unreachable. Check your network connection.',
        retryAfterMs: 3000,
      },
      raw,
      context,
    );
  }

  if (lower.includes('abort') || lower.includes('timeout')) {
    return makeError(
      {
        code: 'RPC_CONNECTION_TIMEOUT',
        domain: ErrorDomain.RPC,
        severity: ErrorSeverity.RETRYABLE,
        message: 'RPC request timed out.',
        retryAfterMs: 5000,
      },
      raw,
      context,
    );
  }

  // Soroban simulation failure — shape: { error: "HostError: ..." }
  if (isObject(raw) && typeof (raw as Record<string, unknown>).error === 'string') {
    const errStr = (raw as Record<string, unknown>).error as string;
    if (errStr.includes('resource_limit_exceeded') || errStr.includes('cpu limit')) {
      return makeError(
        {
          code: 'RPC_RESOURCE_LIMIT_EXCEEDED',
          domain: ErrorDomain.RPC,
          severity: ErrorSeverity.FATAL,
          message: 'Transaction exceeds Soroban resource limits.',
        },
        raw,
        context,
      );
    }
    return makeError(
      {
        code: 'RPC_SIMULATION_FAILED',
        domain: ErrorDomain.RPC,
        severity: ErrorSeverity.FATAL,
        message: `Contract simulation failed: ${errStr.slice(0, 120)}`,
      },
      raw,
      context,
    );
  }

  // Horizon transaction submission — tx_failed / tx_too_late
  if (isObject(raw)) {
    const obj = raw as Record<string, unknown>;
    const codes = extractResultCodes(obj);
    if (codes !== null) {
      if (codes.includes('tx_too_late') || codes.includes('tx_bad_seq')) {
        return makeError(
          {
            code: 'RPC_TX_EXPIRED',
            domain: ErrorDomain.RPC,
            severity: ErrorSeverity.RETRYABLE,
            message: 'Transaction expired or sequence number mismatch. Rebuild and resubmit.',
            retryAfterMs: 1000,
          },
          raw,
          context,
        );
      }
      return makeError(
        {
          code: 'RPC_TX_REJECTED',
          domain: ErrorDomain.RPC,
          severity: ErrorSeverity.FATAL,
          message: `Transaction rejected by the network: ${codes.slice(0, 3).join(', ')}`,
        },
        raw,
        context,
      );
    }

    if (typeof obj.status === 'number' && obj.status === 400) {
      return makeError(
        {
          code: 'RPC_INVALID_RESPONSE',
          domain: ErrorDomain.RPC,
          severity: ErrorSeverity.FATAL,
          message: 'RPC returned an invalid or malformed response.',
        },
        raw,
        context,
      );
    }
  }

  return makeError(
    {
      code: 'RPC_UNKNOWN',
      domain: ErrorDomain.RPC,
      severity: ErrorSeverity.RETRYABLE,
      message: `Unrecognized RPC error: ${msg.slice(0, 120)}`,
      retryAfterMs: 2000,
    },
    raw,
    context,
  );
}

// ---------------------------------------------------------------------------
// API error mapping
// ---------------------------------------------------------------------------

/**
 * Map backend API responses and network failures to AppError.
 *
 * The Stellarcade backend emits two shapes:
 *   { error: { message, code, status } }   — from errorHandler.middleware.js
 *   { message }                             — from auth.middleware.js
 *
 * This function accepts either a raw Error from a failed fetch(), or a
 * structured response object parsed from the JSON body.
 */
export function mapApiError(
  raw: unknown,
  context?: Record<string, unknown>,
): AppError {
  // Network failure — fetch() threw before we received a response
  const msg = extractMessage(raw);
  if (
    raw instanceof TypeError ||
    msg.toLowerCase().includes('failed to fetch') ||
    msg.toLowerCase().includes('networkerror')
  ) {
    return makeError(
      {
        code: 'API_NETWORK_ERROR',
        domain: ErrorDomain.API,
        severity: ErrorSeverity.RETRYABLE,
        message: 'Cannot reach the Stellarcade API. Check your connection.',
        retryAfterMs: 3000,
      },
      raw,
      context,
    );
  }

  // Structured response body — extract status from either shape
  const status = extractStatus(raw);
  const backendMessage = extractBackendMessage(raw);

  switch (status) {
    case 400:
      return makeError(
        {
          code: 'API_VALIDATION_ERROR',
          domain: ErrorDomain.API,
          severity: ErrorSeverity.USER_ACTIONABLE,
          message: backendMessage ?? 'Request validation failed.',
        },
        raw,
        context,
      );
    case 401:
      return makeError(
        {
          code: 'API_UNAUTHORIZED',
          domain: ErrorDomain.API,
          severity: ErrorSeverity.USER_ACTIONABLE,
          message: backendMessage ?? 'Authentication required. Please sign in again.',
        },
        raw,
        context,
      );
    case 403:
      return makeError(
        {
          code: 'API_FORBIDDEN',
          domain: ErrorDomain.API,
          severity: ErrorSeverity.USER_ACTIONABLE,
          message: backendMessage ?? 'You do not have permission for this action.',
        },
        raw,
        context,
      );
    case 404:
      return makeError(
        {
          code: 'API_NOT_FOUND',
          domain: ErrorDomain.API,
          severity: ErrorSeverity.FATAL,
          message: backendMessage ?? 'The requested resource was not found.',
        },
        raw,
        context,
      );
    case 422:
      return makeError(
        {
          code: 'API_VALIDATION_ERROR',
          domain: ErrorDomain.API,
          severity: ErrorSeverity.USER_ACTIONABLE,
          message: backendMessage ?? 'Unprocessable request — check your inputs.',
        },
        raw,
        context,
      );
    case 429:
      return makeError(
        {
          code: 'API_RATE_LIMITED',
          domain: ErrorDomain.API,
          severity: ErrorSeverity.RETRYABLE,
          message: 'Too many requests. Please slow down.',
          retryAfterMs: 10_000,
        },
        raw,
        context,
      );
  }

  if (status !== null && status >= 500) {
    return makeError(
      {
        code: 'API_SERVER_ERROR',
        domain: ErrorDomain.API,
        severity: ErrorSeverity.RETRYABLE,
        message: backendMessage ?? 'Internal server error. Please try again shortly.',
        retryAfterMs: 5000,
      },
      raw,
      context,
    );
  }

  return makeError(
    {
      code: 'API_UNKNOWN',
      domain: ErrorDomain.API,
      severity: ErrorSeverity.RETRYABLE,
      message: backendMessage ?? `Unexpected API error: ${msg.slice(0, 120)}`,
      retryAfterMs: 2000,
    },
    raw,
    context,
  );
}

// ---------------------------------------------------------------------------
// Wallet error mapping
// ---------------------------------------------------------------------------

/**
 * Map Freighter / generic wallet provider errors to AppError.
 *
 * Freighter surfaces errors as thrown Error objects with specific message
 * strings. Detection is string-pattern-based since Freighter does not
 * export typed error classes.
 */
export function mapWalletError(
  raw: unknown,
  context?: Record<string, unknown>,
): AppError {
  const msg = extractMessage(raw).toLowerCase();

  if (
    msg.includes('freighter') && (msg.includes('not found') || msg.includes('not installed'))
    || msg.includes('extension not found')
    || msg.includes('no se encontró freighter')
  ) {
    return makeError(
      {
        code: 'WALLET_NOT_INSTALLED',
        domain: ErrorDomain.WALLET,
        severity: ErrorSeverity.USER_ACTIONABLE,
        message: 'Freighter wallet extension is not installed.',
      },
      raw,
      context,
    );
  }

  if (
    msg.includes('not connected')
    || msg.includes('wallet not connected')
    || msg.includes('no public key')
  ) {
    return makeError(
      {
        code: 'WALLET_NOT_CONNECTED',
        domain: ErrorDomain.WALLET,
        severity: ErrorSeverity.USER_ACTIONABLE,
        message: 'Wallet is not connected. Please connect your Freighter wallet.',
      },
      raw,
      context,
    );
  }

  if (
    msg.includes('user declined')
    || msg.includes('user rejected')
    || msg.includes('declined by user')
    || msg.includes('user denied')
  ) {
    return makeError(
      {
        code: 'WALLET_USER_REJECTED',
        domain: ErrorDomain.WALLET,
        severity: ErrorSeverity.USER_ACTIONABLE,
        message: 'Transaction was rejected by the user.',
      },
      raw,
      context,
    );
  }

  if (
    msg.includes('network mismatch')
    || msg.includes('wrong network')
    || msg.includes('network not supported')
  ) {
    return makeError(
      {
        code: 'WALLET_NETWORK_MISMATCH',
        domain: ErrorDomain.WALLET,
        severity: ErrorSeverity.USER_ACTIONABLE,
        message: 'Wallet is connected to the wrong Stellar network.',
      },
      raw,
      context,
    );
  }

  if (msg.includes('insufficient') && msg.includes('balance')) {
    return makeError(
      {
        code: 'WALLET_INSUFFICIENT_BALANCE',
        domain: ErrorDomain.WALLET,
        severity: ErrorSeverity.USER_ACTIONABLE,
        message: 'Insufficient wallet balance for this operation.',
      },
      raw,
      context,
    );
  }

  if (msg.includes('sign') && (msg.includes('fail') || msg.includes('error'))) {
    return makeError(
      {
        code: 'WALLET_SIGN_FAILED',
        domain: ErrorDomain.WALLET,
        severity: ErrorSeverity.RETRYABLE,
        message: 'Transaction signing failed.',
        retryAfterMs: 1000,
      },
      raw,
      context,
    );
  }

  return makeError(
    {
      code: 'WALLET_UNKNOWN',
      domain: ErrorDomain.WALLET,
      severity: ErrorSeverity.USER_ACTIONABLE,
      message: `Wallet error: ${extractMessage(raw).slice(0, 120)}`,
    },
    raw,
    context,
  );
}

// ---------------------------------------------------------------------------
// Contract error mapping
// ---------------------------------------------------------------------------

/**
 * Per-contract mapping of numeric error slot → ContractErrorCode.
 *
 * Numeric slots are contract-specific — slot 4 is InvalidAmount in PrizePool
 * but InvalidBound in RandomGenerator. All contracts share slots 1-3.
 */
const SHARED_CONTRACT_ERRORS: Record<number, ContractErrorCode> = {
  1: 'CONTRACT_ALREADY_INITIALIZED',
  2: 'CONTRACT_NOT_INITIALIZED',
  3: 'CONTRACT_NOT_AUTHORIZED',
};

const CONTRACT_ERROR_MAPS: Record<ContractNameType, Record<number, ContractErrorCode>> = {
  prize_pool: {
    ...SHARED_CONTRACT_ERRORS,
    4: 'CONTRACT_INVALID_AMOUNT',
    5: 'CONTRACT_INSUFFICIENT_FUNDS',
    6: 'CONTRACT_GAME_ALREADY_RESERVED',
    7: 'CONTRACT_RESERVATION_NOT_FOUND',
    8: 'CONTRACT_PAYOUT_EXCEEDS_RESERVATION',
    9: 'CONTRACT_OVERFLOW',
  },
  random_generator: {
    ...SHARED_CONTRACT_ERRORS,
    4: 'CONTRACT_INVALID_BOUND',
    5: 'CONTRACT_DUPLICATE_REQUEST_ID',
    6: 'CONTRACT_REQUEST_NOT_FOUND',
    7: 'CONTRACT_ALREADY_FULFILLED',
    8: 'CONTRACT_UNAUTHORIZED_CALLER',
  },
  access_control: {
    ...SHARED_CONTRACT_ERRORS,
  },
  pattern_puzzle: {
    ...SHARED_CONTRACT_ERRORS,
    4: 'CONTRACT_NOT_FOUND' as ContractErrorCode,
    5: 'CONTRACT_GAME_ALREADY_RESERVED' as ContractErrorCode,
  },
  coin_flip: {
    ...SHARED_CONTRACT_ERRORS,
  },
};

const CONTRACT_ERROR_SEVERITY: Record<ContractErrorCode, ErrorSeverity> = {
  CONTRACT_ALREADY_INITIALIZED:      ErrorSeverity.FATAL,
  CONTRACT_NOT_INITIALIZED:          ErrorSeverity.FATAL,
  CONTRACT_NOT_AUTHORIZED:           ErrorSeverity.USER_ACTIONABLE,
  CONTRACT_INVALID_AMOUNT:           ErrorSeverity.USER_ACTIONABLE,
  CONTRACT_INSUFFICIENT_FUNDS:       ErrorSeverity.USER_ACTIONABLE,
  CONTRACT_GAME_ALREADY_RESERVED:    ErrorSeverity.FATAL,
  CONTRACT_RESERVATION_NOT_FOUND:    ErrorSeverity.FATAL,
  CONTRACT_PAYOUT_EXCEEDS_RESERVATION: ErrorSeverity.FATAL,
  CONTRACT_OVERFLOW:                 ErrorSeverity.FATAL,
  CONTRACT_INVALID_BOUND:            ErrorSeverity.USER_ACTIONABLE,
  CONTRACT_DUPLICATE_REQUEST_ID:     ErrorSeverity.FATAL,
  CONTRACT_REQUEST_NOT_FOUND:        ErrorSeverity.FATAL,
  CONTRACT_ALREADY_FULFILLED:        ErrorSeverity.FATAL,
  CONTRACT_UNAUTHORIZED_CALLER:      ErrorSeverity.USER_ACTIONABLE,
  CONTRACT_UNKNOWN:                  ErrorSeverity.FATAL,
};

const CONTRACT_ERROR_MESSAGES: Record<ContractErrorCode, string> = {
  CONTRACT_ALREADY_INITIALIZED:      'Contract is already initialized.',
  CONTRACT_NOT_INITIALIZED:          'Contract has not been initialized.',
  CONTRACT_NOT_AUTHORIZED:           'Caller is not authorized to perform this action.',
  CONTRACT_INVALID_AMOUNT:           'Amount must be greater than zero.',
  CONTRACT_INSUFFICIENT_FUNDS:       'Insufficient funds in the prize pool.',
  CONTRACT_GAME_ALREADY_RESERVED:    'Funds are already reserved for this game.',
  CONTRACT_RESERVATION_NOT_FOUND:    'No active reservation found for this game.',
  CONTRACT_PAYOUT_EXCEEDS_RESERVATION: 'Payout amount exceeds the reserved funds.',
  CONTRACT_OVERFLOW:                 'Arithmetic overflow detected in contract.',
  CONTRACT_INVALID_BOUND:            'Randomness bound must be at least 2.',
  CONTRACT_DUPLICATE_REQUEST_ID:     'A randomness request with this ID already exists.',
  CONTRACT_REQUEST_NOT_FOUND:        'Randomness request not found or not yet fulfilled.',
  CONTRACT_ALREADY_FULFILLED:        'This randomness request has already been fulfilled.',
  CONTRACT_UNAUTHORIZED_CALLER:      'This contract is not authorized to request randomness.',
  CONTRACT_UNKNOWN:                  'Unknown contract error.',
};

/**
 * Extract the numeric Soroban contract error code from common SDK error shapes.
 *
 * The Stellar SDK encodes contract errors as:
 *   "Error(Contract, #N)"           — XDR diagnostic string
 *   "HostError: Error(Contract, #N)" — simulation response prefix
 *   { code: N }                      — pre-parsed form
 */
function extractContractErrorCode(raw: unknown): number | null {
  // Pre-parsed numeric code on the object
  if (isObject(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.code === 'number') return obj.code;
  }

  // Extract from XDR diagnostic string: "Error(Contract, #4)"
  const str = typeof raw === 'string' ? raw : extractMessage(raw);
  const match = /Error\s*\(\s*Contract\s*,\s*#(\d+)\s*\)/.exec(str);
  if (match) return parseInt(match[1], 10);

  // Fallback: bare numeric string
  if (typeof raw === 'number') return raw;

  return null;
}

/**
 * Map a raw Soroban contract invocation error to AppError.
 *
 * `contractName` is required to disambiguate numeric error slots that mean
 * different things in different contracts.
 */
export function mapContractError(
  raw: unknown,
  contractName: ContractNameType,
  context?: Record<string, unknown>,
): AppError {
  const numeric = extractContractErrorCode(raw);
  const errorMap = CONTRACT_ERROR_MAPS[contractName] ?? {};

  const code: ContractErrorCode =
    numeric !== null ? (errorMap[numeric] ?? 'CONTRACT_UNKNOWN') : 'CONTRACT_UNKNOWN';

  return makeError(
    {
      code,
      domain: ErrorDomain.CONTRACT,
      severity: CONTRACT_ERROR_SEVERITY[code],
      message: CONTRACT_ERROR_MESSAGES[code],
    },
    raw,
    context,
  );
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * Convert any unknown thrown value to AppError.
 *
 * Domain auto-detection order:
 *   1. CONTRACT — if raw contains "Error(Contract, #N)" pattern
 *   2. WALLET   — if raw message contains wallet-specific keywords
 *   3. RPC      — if raw message contains RPC/network keywords
 *   4. API      — if raw has an HTTP status code
 *   5. Fallback to UNKNOWN
 *
 * Pass a `hint` to skip auto-detection when the call site knows the domain.
 */
export function toAppError(
  raw: unknown,
  hint?: ErrorMappingHint,
  context?: Record<string, unknown>,
): AppError {
  if (hint === ErrorDomain.RPC)      return mapRpcError(raw, context);
  if (hint === ErrorDomain.API)      return mapApiError(raw, context);
  if (hint === ErrorDomain.WALLET)   return mapWalletError(raw, context);
  if (hint === ErrorDomain.CONTRACT) {
    return mapContractError(raw, ContractName.COIN_FLIP, context);
  }

  // Auto-detect
  const msg = extractMessage(raw).toLowerCase();

  if (extractContractErrorCode(raw) !== null || msg.includes('error(contract')) {
    return mapContractError(raw, ContractName.COIN_FLIP, context);
  }

  const walletKeywords = ['freighter', 'user declined', 'user rejected', 'not connected', 'wallet'];
  if (walletKeywords.some((k) => msg.includes(k))) {
    return mapWalletError(raw, context);
  }

  const rpcKeywords = ['simulation', 'failed to fetch', 'networkerror', 'soroban', 'horizon'];
  if (rpcKeywords.some((k) => msg.includes(k)) || hasStatus(raw)) {
    // Distinguish RPC (no HTTP body shape) from API (has HTTP body shape)
    if (hasBackendBody(raw)) return mapApiError(raw, context);
    return mapRpcError(raw, context);
  }

  if (extractStatus(raw) !== null) {
    return mapApiError(raw, context);
  }

  return makeError(
    {
      code: 'UNKNOWN',
      domain: ErrorDomain.UNKNOWN,
      severity: ErrorSeverity.FATAL,
      message: `Unexpected error: ${extractMessage(raw).slice(0, 200)}`,
    },
    raw,
    context,
  );
}

// ---------------------------------------------------------------------------
// Precondition validators
// ---------------------------------------------------------------------------

export interface PreconditionOptions {
  /** Fail if no wallet public key is present. */
  requireWallet?: boolean;
  /** Fail if networkPassphrase does not match expected value. */
  expectedNetwork?: string;
  currentNetwork?: string;
  /** Fail if contract address is missing or empty. */
  contractAddress?: string;
}

/**
 * Validate common preconditions before making side-effect calls.
 * Returns the first failing AppError, or null if all preconditions pass.
 */
export function validatePreconditions(
  opts: PreconditionOptions,
): AppError | null {
  if (opts.requireWallet) {
    return {
      code: 'WALLET_NOT_CONNECTED',
      domain: ErrorDomain.WALLET,
      severity: ErrorSeverity.USER_ACTIONABLE,
      message: 'Wallet must be connected before this action.',
    };
  }

  if (
    opts.expectedNetwork !== undefined &&
    opts.currentNetwork !== undefined &&
    opts.currentNetwork !== opts.expectedNetwork
  ) {
    return {
      code: 'WALLET_NETWORK_MISMATCH',
      domain: ErrorDomain.WALLET,
      severity: ErrorSeverity.USER_ACTIONABLE,
      message: `Wrong network. Expected "${opts.expectedNetwork}", got "${opts.currentNetwork}".`,
    };
  }

  if (opts.contractAddress !== undefined && opts.contractAddress.trim() === '') {
    return {
      code: 'CONTRACT_NOT_INITIALIZED',
      domain: ErrorDomain.CONTRACT,
      severity: ErrorSeverity.FATAL,
      message: 'Contract address is not configured.',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

/**
 * Enrich an AppError into a structured payload suitable for logging pipelines
 * and analytics tools (e.g. Datadog, Sentry, PostHog).
 */
export function enrichForTelemetry(
  error: AppError,
  opts: {
    correlationId?: string;
    userId?: string;
    context?: Record<string, unknown>;
  } = {},
): TelemetryEvent {
  return {
    errorCode: error.code,
    domain: error.domain,
    severity: error.severity,
    message: error.message,
    timestamp: Date.now(),
    ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
    ...(opts.userId ? { userId: opts.userId } : {}),
    context: { ...error.context, ...opts.context },
  };
}

/**
 * Produce a single log-line string from an AppError.
 * Suitable for console.error() calls and structured loggers.
 */
export function formatForLog(error: AppError): string {
  const parts: string[] = [
    `[${error.domain.toUpperCase()}]`,
    error.code,
    `(${error.severity})`,
    error.message,
  ];
  if (error.context && Object.keys(error.context).length > 0) {
    parts.push(`| ctx:${JSON.stringify(error.context)}`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Private utilities
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Safely extract a string message from any thrown value. */
function extractMessage(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message;
  if (isObject(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (isObject(obj.error) && typeof (obj.error as Record<string, unknown>).message === 'string') {
      return (obj.error as Record<string, unknown>).message as string;
    }
    if (typeof obj.error === 'string') return obj.error;
  }
  return String(raw);
}

/**
 * Extract HTTP status from a raw error object.
 * Handles both { status } and { error: { status } } shapes.
 */
function extractStatus(raw: unknown): number | null {
  if (!isObject(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.status === 'number') return obj.status;
  if (isObject(obj.error) && typeof (obj.error as Record<string, unknown>).status === 'number') {
    return (obj.error as Record<string, unknown>).status as number;
  }
  return null;
}

function hasStatus(raw: unknown): boolean {
  return extractStatus(raw) !== null;
}

/**
 * Extract the human-readable message from a Stellarcade backend error body.
 * Backend emits either:
 *   { error: { message, code, status } }
 *   { message }
 */
function extractBackendMessage(raw: unknown): string | null {
  if (!isObject(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (isObject(obj.error) && typeof (obj.error as Record<string, unknown>).message === 'string') {
    return (obj.error as Record<string, unknown>).message as string;
  }
  if (typeof obj.message === 'string') return obj.message;
  return null;
}

/**
 * Return true when the raw object looks like a Stellarcade API response body
 * (has { error: { ... } } or { message: ... } shape) rather than a raw RPC response.
 */
function hasBackendBody(raw: unknown): boolean {
  if (!isObject(raw)) return false;
  const obj = raw as Record<string, unknown>;
  return isObject(obj.error) || typeof obj.message === 'string';
}

/**
 * Extract Horizon result_codes from a bad response extras payload.
 * Handles: { response: { data: { extras: { result_codes: { transaction } } } } }
 */
function extractResultCodes(obj: Record<string, unknown>): string[] | null {
  try {
    const response = obj.response as Record<string, unknown> | undefined;
    const data = response?.data as Record<string, unknown> | undefined;
    const extras = data?.extras as Record<string, unknown> | undefined;
    const codes = extras?.result_codes as Record<string, unknown> | undefined;
    if (!codes) return null;
    const all: string[] = [];
    for (const v of Object.values(codes)) {
      if (typeof v === 'string') all.push(v);
      if (Array.isArray(v)) all.push(...(v as string[]));
    }
    return all.length > 0 ? all : null;
  } catch {
    return null;
  }
}
