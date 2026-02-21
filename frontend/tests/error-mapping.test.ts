/**
 * Tests for src/services/error-mapping.ts
 *
 * All external dependencies (RPC, wallet, API, contract) are simulated by
 * passing shaped plain objects and Error instances — no live network calls.
 */

import { describe, it, expect } from 'vitest';
import {
  mapRpcError,
  mapApiError,
  mapWalletError,
  mapContractError,
  toAppError,
  validatePreconditions,
  enrichForTelemetry,
  formatForLog,
} from '../src/services/error-mapping';
import { ContractName, ErrorDomain, ErrorSeverity } from '../src/types/errors';

// ---------------------------------------------------------------------------
// mapRpcError
// ---------------------------------------------------------------------------

describe('mapRpcError', () => {
  it('maps "Failed to fetch" TypeError to RPC_NODE_UNAVAILABLE (retryable)', () => {
    const err = new TypeError('Failed to fetch');
    const result = mapRpcError(err);
    expect(result.code).toBe('RPC_NODE_UNAVAILABLE');
    expect(result.domain).toBe(ErrorDomain.RPC);
    expect(result.severity).toBe(ErrorSeverity.RETRYABLE);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.originalError).toBe(err);
  });

  it('maps AbortError to RPC_CONNECTION_TIMEOUT', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const result = mapRpcError(err);
    expect(result.code).toBe('RPC_CONNECTION_TIMEOUT');
    expect(result.severity).toBe(ErrorSeverity.RETRYABLE);
  });

  it('maps timeout message to RPC_CONNECTION_TIMEOUT', () => {
    const result = mapRpcError(new Error('Request timeout exceeded'));
    expect(result.code).toBe('RPC_CONNECTION_TIMEOUT');
  });

  it('maps Soroban simulation error object to RPC_SIMULATION_FAILED', () => {
    const raw = { error: 'HostError: contract panicked' };
    const result = mapRpcError(raw);
    expect(result.code).toBe('RPC_SIMULATION_FAILED');
    expect(result.severity).toBe(ErrorSeverity.FATAL);
  });

  it('maps resource_limit_exceeded simulation error to RPC_RESOURCE_LIMIT_EXCEEDED', () => {
    const raw = { error: 'HostError: resource_limit_exceeded cpu limit' };
    const result = mapRpcError(raw);
    expect(result.code).toBe('RPC_RESOURCE_LIMIT_EXCEEDED');
    expect(result.severity).toBe(ErrorSeverity.FATAL);
  });

  it('maps Horizon tx_too_late result code to RPC_TX_EXPIRED (retryable)', () => {
    const raw = {
      response: {
        data: {
          extras: {
            result_codes: { transaction: 'tx_too_late' },
          },
        },
      },
    };
    const result = mapRpcError(raw);
    expect(result.code).toBe('RPC_TX_EXPIRED');
    expect(result.severity).toBe(ErrorSeverity.RETRYABLE);
  });

  it('maps Horizon tx_failed result code to RPC_TX_REJECTED', () => {
    const raw = {
      response: {
        data: {
          extras: {
            result_codes: { transaction: 'tx_failed', operations: ['op_no_trust'] },
          },
        },
      },
    };
    const result = mapRpcError(raw);
    expect(result.code).toBe('RPC_TX_REJECTED');
    expect(result.severity).toBe(ErrorSeverity.FATAL);
  });

  it('attaches caller-provided context', () => {
    const result = mapRpcError(new Error('Failed to fetch'), { requestId: 'abc123' });
    expect(result.context?.requestId).toBe('abc123');
  });

  it('falls back to RPC_UNKNOWN for unrecognized shapes', () => {
    const result = mapRpcError({ someWeirdField: true });
    expect(result.code).toBe('RPC_UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// mapApiError
// ---------------------------------------------------------------------------

describe('mapApiError', () => {
  it('maps TypeError (network offline) to API_NETWORK_ERROR (retryable)', () => {
    const result = mapApiError(new TypeError('Failed to fetch'));
    expect(result.code).toBe('API_NETWORK_ERROR');
    expect(result.severity).toBe(ErrorSeverity.RETRYABLE);
  });

  it('maps status 401 to API_UNAUTHORIZED (user_actionable)', () => {
    // Backend { error: { message, code, status } } shape — message is preserved verbatim
    const result = mapApiError({ error: { message: 'Invalid token', code: 'AUTH_FAIL', status: 401 } });
    expect(result.code).toBe('API_UNAUTHORIZED');
    expect(result.severity).toBe(ErrorSeverity.USER_ACTIONABLE);
    expect(result.message).toBe('Invalid token');
  });

  it('maps status 403 to API_FORBIDDEN', () => {
    const result = mapApiError({ error: { message: 'Forbidden', code: 'FORBIDDEN', status: 403 } });
    expect(result.code).toBe('API_FORBIDDEN');
  });

  it('maps status 404 to API_NOT_FOUND (fatal)', () => {
    const result = mapApiError({ error: { message: 'Not found', code: 'NOT_FOUND', status: 404 } });
    expect(result.code).toBe('API_NOT_FOUND');
    expect(result.severity).toBe(ErrorSeverity.FATAL);
  });

  it('maps status 422 to API_VALIDATION_ERROR', () => {
    const result = mapApiError({ error: { message: 'Validation failed', status: 422 } });
    expect(result.code).toBe('API_VALIDATION_ERROR');
    expect(result.severity).toBe(ErrorSeverity.USER_ACTIONABLE);
  });

  it('maps status 429 to API_RATE_LIMITED (retryable)', () => {
    const result = mapApiError({ status: 429 });
    expect(result.code).toBe('API_RATE_LIMITED');
    expect(result.severity).toBe(ErrorSeverity.RETRYABLE);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('maps status 500 to API_SERVER_ERROR (retryable)', () => {
    const result = mapApiError({ error: { message: 'Internal Server Error', status: 500 } });
    expect(result.code).toBe('API_SERVER_ERROR');
    expect(result.severity).toBe(ErrorSeverity.RETRYABLE);
  });

  it('maps status 503 to API_SERVER_ERROR', () => {
    const result = mapApiError({ status: 503 });
    expect(result.code).toBe('API_SERVER_ERROR');
  });

  it('preserves backend message in result.message', () => {
    // The implementation uses backendMessage ?? fallback, so backend message wins
    const result = mapApiError({ error: { message: 'No token provided', status: 401 } });
    expect(result.message).toBe('No token provided');
  });

  it('handles { message } plain shape (auth middleware format)', () => {
    const result = mapApiError({ message: 'No token provided', status: 401 });
    expect(result.code).toBe('API_UNAUTHORIZED');
  });

  it('falls back to API_UNKNOWN for unrecognized shape', () => {
    const result = mapApiError({ randomField: 'value' });
    expect(result.code).toBe('API_UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// mapWalletError
// ---------------------------------------------------------------------------

describe('mapWalletError', () => {
  it('maps "not found" message to WALLET_NOT_INSTALLED', () => {
    const result = mapWalletError(new Error('Freighter not found'));
    expect(result.code).toBe('WALLET_NOT_INSTALLED');
    expect(result.severity).toBe(ErrorSeverity.USER_ACTIONABLE);
  });

  it('maps Spanish Freighter message to WALLET_NOT_INSTALLED', () => {
    const result = mapWalletError(new Error('No se encontró Freighter'));
    expect(result.code).toBe('WALLET_NOT_INSTALLED');
  });

  it('maps "wallet not connected" to WALLET_NOT_CONNECTED', () => {
    const result = mapWalletError(new Error('Wallet not connected'));
    expect(result.code).toBe('WALLET_NOT_CONNECTED');
    expect(result.severity).toBe(ErrorSeverity.USER_ACTIONABLE);
  });

  it('maps "User declined" to WALLET_USER_REJECTED', () => {
    const result = mapWalletError(new Error('User declined access'));
    expect(result.code).toBe('WALLET_USER_REJECTED');
    expect(result.severity).toBe(ErrorSeverity.USER_ACTIONABLE);
  });

  it('maps "user rejected" to WALLET_USER_REJECTED', () => {
    const result = mapWalletError(new Error('Transaction user rejected'));
    expect(result.code).toBe('WALLET_USER_REJECTED');
  });

  it('maps "network mismatch" to WALLET_NETWORK_MISMATCH', () => {
    const result = mapWalletError(new Error('Network mismatch'));
    expect(result.code).toBe('WALLET_NETWORK_MISMATCH');
  });

  it('maps insufficient balance message to WALLET_INSUFFICIENT_BALANCE', () => {
    const result = mapWalletError(new Error('Insufficient balance for transaction'));
    expect(result.code).toBe('WALLET_INSUFFICIENT_BALANCE');
  });

  it('maps sign error to WALLET_SIGN_FAILED', () => {
    const result = mapWalletError(new Error('Sign error: hardware error'));
    expect(result.code).toBe('WALLET_SIGN_FAILED');
  });

  it('falls back to WALLET_UNKNOWN for unrecognized messages', () => {
    const result = mapWalletError(new Error('Something unexpected happened in the wallet'));
    expect(result.code).toBe('WALLET_UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// mapContractError — PrizePool
// ---------------------------------------------------------------------------

describe('mapContractError — prize_pool', () => {
  const contract = ContractName.PRIZE_POOL;

  it.each([
    [1, 'CONTRACT_ALREADY_INITIALIZED', ErrorSeverity.FATAL],
    [2, 'CONTRACT_NOT_INITIALIZED',     ErrorSeverity.FATAL],
    [3, 'CONTRACT_NOT_AUTHORIZED',      ErrorSeverity.USER_ACTIONABLE],
    [4, 'CONTRACT_INVALID_AMOUNT',      ErrorSeverity.USER_ACTIONABLE],
    [5, 'CONTRACT_INSUFFICIENT_FUNDS',  ErrorSeverity.USER_ACTIONABLE],
    [6, 'CONTRACT_GAME_ALREADY_RESERVED',     ErrorSeverity.FATAL],
    [7, 'CONTRACT_RESERVATION_NOT_FOUND',     ErrorSeverity.FATAL],
    [8, 'CONTRACT_PAYOUT_EXCEEDS_RESERVATION', ErrorSeverity.FATAL],
    [9, 'CONTRACT_OVERFLOW',            ErrorSeverity.FATAL],
  ] as const)('maps numeric code %i to %s (%s)', (numeric, code, severity) => {
    const result = mapContractError({ code: numeric }, contract);
    expect(result.code).toBe(code);
    expect(result.severity).toBe(severity);
    expect(result.domain).toBe(ErrorDomain.CONTRACT);
  });

  it('maps XDR diagnostic string "Error(Contract, #5)" to correct code', () => {
    const raw = new Error('HostError: Error(Contract, #5)');
    const result = mapContractError(raw, contract);
    expect(result.code).toBe('CONTRACT_INSUFFICIENT_FUNDS');
  });

  it('maps unknown numeric code to CONTRACT_UNKNOWN', () => {
    const result = mapContractError({ code: 99 }, contract);
    expect(result.code).toBe('CONTRACT_UNKNOWN');
    expect(result.severity).toBe(ErrorSeverity.FATAL);
  });
});

// ---------------------------------------------------------------------------
// mapContractError — RandomGenerator
// ---------------------------------------------------------------------------

describe('mapContractError — random_generator', () => {
  const contract = ContractName.RANDOM_GENERATOR;

  it.each([
    [4, 'CONTRACT_INVALID_BOUND'],
    [5, 'CONTRACT_DUPLICATE_REQUEST_ID'],
    [6, 'CONTRACT_REQUEST_NOT_FOUND'],
    [7, 'CONTRACT_ALREADY_FULFILLED'],
    [8, 'CONTRACT_UNAUTHORIZED_CALLER'],
  ] as const)('maps numeric code %i to %s', (numeric, code) => {
    const result = mapContractError({ code: numeric }, contract);
    expect(result.code).toBe(code);
  });

  it('shared slots (1-3) map the same as other contracts', () => {
    expect(mapContractError({ code: 1 }, contract).code).toBe('CONTRACT_ALREADY_INITIALIZED');
    expect(mapContractError({ code: 2 }, contract).code).toBe('CONTRACT_NOT_INITIALIZED');
    expect(mapContractError({ code: 3 }, contract).code).toBe('CONTRACT_NOT_AUTHORIZED');
  });

  it('extracts code from full diagnostic string with whitespace', () => {
    // Soroban may format as "Error( Contract , #7 )"
    const result = mapContractError('Error( Contract , #7 )', contract);
    expect(result.code).toBe('CONTRACT_ALREADY_FULFILLED');
  });
});

// ---------------------------------------------------------------------------
// toAppError — auto-detection
// ---------------------------------------------------------------------------

describe('toAppError', () => {
  it('routes "Failed to fetch" to RPC_NODE_UNAVAILABLE via hint', () => {
    const result = toAppError(new TypeError('Failed to fetch'), ErrorDomain.RPC);
    expect(result.code).toBe('RPC_NODE_UNAVAILABLE');
  });

  it('routes status-400 body to API_VALIDATION_ERROR via hint', () => {
    const result = toAppError({ error: { status: 400, message: 'Bad input' } }, ErrorDomain.API);
    expect(result.code).toBe('API_VALIDATION_ERROR');
  });

  it('auto-detects wallet error from message keywords', () => {
    const result = toAppError(new Error('User declined access'));
    expect(result.code).toBe('WALLET_USER_REJECTED');
  });

  it('auto-detects contract error from XDR string', () => {
    const result = toAppError('Error(Contract, #3)');
    expect(result.domain).toBe(ErrorDomain.CONTRACT);
    expect(result.code).toBe('CONTRACT_NOT_AUTHORIZED');
  });

  it('falls back to UNKNOWN for unrecognized input', () => {
    const result = toAppError({ completely: 'unrelated' });
    expect(result.code).toBe('UNKNOWN');
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
    expect(result.severity).toBe(ErrorSeverity.FATAL);
  });

  it('returns UNKNOWN for null input', () => {
    const result = toAppError(null);
    expect(result.code).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for undefined input', () => {
    const result = toAppError(undefined);
    expect(result.code).toBe('UNKNOWN');
  });

  it('treats a plain number as a potential contract error code → CONTRACT_UNKNOWN', () => {
    // extractContractErrorCode() accepts bare numbers (bare Soroban slot IDs),
    // so 42 auto-detects as CONTRACT domain and returns CONTRACT_UNKNOWN (slot not in any map).
    const result = toAppError(42);
    expect(result.code).toBe('CONTRACT_UNKNOWN');
    expect(result.domain).toBe(ErrorDomain.CONTRACT);
  });

  it('attaches context when provided', () => {
    const result = toAppError(new Error('Failed to fetch'), ErrorDomain.RPC, { gameId: 'g1' });
    expect(result.context?.gameId).toBe('g1');
  });

  it('preserves originalError', () => {
    const raw = new Error('some error');
    const result = toAppError(raw);
    expect(result.originalError).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// validatePreconditions
// ---------------------------------------------------------------------------

describe('validatePreconditions', () => {
  it('returns WALLET_NOT_CONNECTED when requireWallet is true', () => {
    const err = validatePreconditions({ requireWallet: true });
    expect(err?.code).toBe('WALLET_NOT_CONNECTED');
    expect(err?.severity).toBe(ErrorSeverity.USER_ACTIONABLE);
  });

  it('returns null when requireWallet is false', () => {
    const err = validatePreconditions({ requireWallet: false });
    expect(err).toBeNull();
  });

  it('returns WALLET_NETWORK_MISMATCH when networks differ', () => {
    const err = validatePreconditions({
      expectedNetwork: 'Test SDF Network ; September 2015',
      currentNetwork: 'Public Global Stellar Network ; September 2015',
    });
    expect(err?.code).toBe('WALLET_NETWORK_MISMATCH');
  });

  it('returns null when networks match', () => {
    const net = 'Test SDF Network ; September 2015';
    const err = validatePreconditions({ expectedNetwork: net, currentNetwork: net });
    expect(err).toBeNull();
  });

  it('returns CONTRACT_NOT_INITIALIZED for blank contract address', () => {
    const err = validatePreconditions({ contractAddress: '   ' });
    expect(err?.code).toBe('CONTRACT_NOT_INITIALIZED');
    expect(err?.severity).toBe(ErrorSeverity.FATAL);
  });

  it('returns null for a non-blank contract address', () => {
    const err = validatePreconditions({ contractAddress: 'CABC123' });
    expect(err).toBeNull();
  });

  it('returns null when no options are set', () => {
    expect(validatePreconditions({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrichForTelemetry
// ---------------------------------------------------------------------------

describe('enrichForTelemetry', () => {
  const base = toAppError(new Error('Failed to fetch'), ErrorDomain.RPC);

  it('produces a TelemetryEvent with all required fields', () => {
    const event = enrichForTelemetry(base);
    expect(event.errorCode).toBe(base.code);
    expect(event.domain).toBe(base.domain);
    expect(event.severity).toBe(base.severity);
    expect(typeof event.timestamp).toBe('number');
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it('attaches correlationId and userId when provided', () => {
    const event = enrichForTelemetry(base, {
      correlationId: 'req-abc',
      userId: 'user-xyz',
    });
    expect(event.correlationId).toBe('req-abc');
    expect(event.userId).toBe('user-xyz');
  });

  it('merges error.context with opts.context', () => {
    const errWithCtx = toAppError(new Error('Failed to fetch'), ErrorDomain.RPC, { a: 1 });
    const event = enrichForTelemetry(errWithCtx, { context: { b: 2 } });
    expect(event.context?.a).toBe(1);
    expect(event.context?.b).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// formatForLog
// ---------------------------------------------------------------------------

describe('formatForLog', () => {
  it('produces a single-line string with domain, code, severity, and message', () => {
    const err = toAppError(new Error('Failed to fetch'), ErrorDomain.RPC);
    const line = formatForLog(err);
    expect(line).toContain('[RPC]');
    expect(line).toContain('RPC_NODE_UNAVAILABLE');
    expect(line).toContain('retryable');
  });

  it('includes context when present', () => {
    const err = toAppError(new TypeError('Failed to fetch'), ErrorDomain.RPC, { reqId: '99' });
    const line = formatForLog(err);
    expect(line).toContain('ctx:');
    expect(line).toContain('reqId');
  });

  it('omits context section when context is empty', () => {
    const err = toAppError(new Error('User declined'), ErrorDomain.WALLET);
    const line = formatForLog(err);
    expect(line).not.toContain('ctx:');
  });
});
