/**
 * Input Validation Schemas for Game Operations
 *
 * Production-grade validation schemas for all Stellarcade game operations.
 * Each schema validates one logical unit of user input and returns a typed
 * discriminated union — callers never need a try/catch.
 *
 * ## Architecture
 * - Primitive validators live in `utils/v1/validation.ts` (reused here).
 * - This module adds contract-aligned constraints, operation-scoped compound
 *   schemas, and a parse API that consuming hooks/services can import directly.
 * - No React dependencies — fully UI-agnostic.
 *
 * ## Usage
 * ```ts
 * import { parseCoinFlipBet } from '@/services/input-validation-schemas';
 *
 * const result = parseCoinFlipBet({ wager: "50000000", side: "heads", walletAddress: "G..." });
 * if (result.success) {
 *   await client.placeBet(result.data);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 *
 * @module services/input-validation-schemas
 */

import {
  validateWager,
  validateGameId,
  validateBadgeId,
  validateStellarAddress,
  validateContractAddress,
  validateSha256Hash,
  validateEnum,
  validateString,
  validateNumber,
  isDefined,
  isNonEmptyString,
  isPositiveBigInt,
  isNonNegativeBigInt,
  isWalletConnected,
  ValidationErrorCode,
  type ValidationResult,
  type ValidationError,
  type WagerBounds,
} from '../utils/v1/validation';

// Re-export primitives so consumers can import everything from one place.
export {
  validateWager,
  validateGameId,
  validateBadgeId,
  validateStellarAddress,
  validateContractAddress,
  validateSha256Hash,
  validateEnum,
  validateString,
  validateNumber,
  isDefined,
  isNonEmptyString,
  isPositiveBigInt,
  isNonNegativeBigInt,
  isWalletConnected,
  ValidationErrorCode,
  type ValidationResult,
  type ValidationError,
  type WagerBounds,
};

// ── Contract-Aligned Constants ─────────────────────────────────────────────────

/**
 * Maximum u64 value. Game IDs and round IDs are u64 on-chain.
 * JavaScript BigInt supports arbitrary precision so this is safe.
 */
export const U64_MAX: bigint = 18_446_744_073_709_551_615n;

/**
 * Coin-flip side identifiers (HEADS = 0, TAILS = 1 in the contract).
 */
export const COIN_FLIP_SIDES = ['heads', 'tails'] as const;
export type CoinFlipSide = (typeof COIN_FLIP_SIDES)[number];

/** Maps a human-readable side to the contract's u32 representation. */
export const COIN_FLIP_SIDE_TO_U32: Record<CoinFlipSide, number> = {
  heads: 0,
  tails: 1,
};

/**
 * Default wager bounds for the Coin Flip contract (in stroops).
 * These mirror the deployed values; override via custom bounds when queried
 * on-chain.
 *
 * 1 XLM = 10_000_000 stroops.
 */
export const COIN_FLIP_WAGER_BOUNDS: Readonly<WagerBounds> = Object.freeze({
  min: 10_000_000n,    // 1 XLM
  max: 10_000_000_000n, // 1 000 XLM
});

/**
 * Amount bounds for PrizePool reservation and payout operations (in stroops).
 * Kept separate from COIN_FLIP_WAGER_BOUNDS so prize-pool limits can diverge
 * from coin-flip limits independently in the future.
 */
export const PRIZE_POOL_AMOUNT_BOUNDS: Readonly<WagerBounds> = Object.freeze({
  min: 10_000_000n,    // 1 XLM
  max: 10_000_000_000n, // 1 000 XLM
});

/**
 * Entry-fee bounds for the Pattern Puzzle contract.
 * min = 0n because free rounds (entry_fee = 0) are valid per the contract.
 */
export const PUZZLE_ENTRY_FEE_BOUNDS: Readonly<WagerBounds> = Object.freeze({
  min: 0n,
  max: 10_000_000_000n, // 1 000 XLM
});

/** Maximum bytes a Pattern Puzzle solution may contain (arbitrary client limit). */
export const PUZZLE_SOLUTION_MAX_BYTES = 1024;

/**
 * Maximum number of players per Pattern Puzzle round — enforced on-chain.
 * @see contracts/pattern-puzzle/src/lib.rs MAX_PLAYERS_PER_ROUND
 */
export const MAX_PLAYERS_PER_ROUND = 500;

// ── Round ID Validation ────────────────────────────────────────────────────────

/**
 * Validates a round ID (u64, represented as bigint).
 * Round IDs follow the same rules as game IDs: non-negative integers within
 * the u64 range.
 *
 * @param value - The round ID to validate
 * @returns ValidationResult with parsed bigint or error
 *
 * @example
 * ```ts
 * const result = validateRoundId("7");
 * if (result.success) console.log(result.data); // 7n
 * ```
 */
export function validateRoundId(
  value: bigint | string | number | null | undefined,
): ValidationResult<bigint> {
  const result = validateGameId(value);

  if (!result.success) {
    const MESSAGE_BY_CODE: Partial<Record<ValidationErrorCode, string>> = {
      [ValidationErrorCode.Required]:    'Round ID is required',
      [ValidationErrorCode.InvalidType]: 'Round ID must be a valid integer',
      [ValidationErrorCode.OutOfRange]:  'Round ID must be non-negative',
    };
    return {
      success: false,
      error: {
        ...result.error,
        field: 'roundId',
        message: MESSAGE_BY_CODE[result.error.code] ?? result.error.message,
      },
    };
  }

  if (result.data > U64_MAX) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.OutOfRange,
        message: 'Round ID exceeds maximum u64 value',
        field: 'roundId',
        context: { value: result.data.toString(), max: U64_MAX.toString() },
      },
    };
  }

  return result;
}

// ── Coin Flip Prediction Validation ───────────────────────────────────────────

/**
 * Validated, parsed coin-flip prediction with both the string label and
 * the u32 value the contract expects.
 */
export interface ParsedCoinFlipSide {
  /** String label ("heads" | "tails"). */
  label: CoinFlipSide;
  /** Contract u32 representation (0 = heads, 1 = tails). */
  contractValue: number;
}

/**
 * Validates a coin-flip prediction against the allowed sides.
 *
 * @param value - The prediction value to validate
 * @returns ValidationResult with `{ label, contractValue }` or error
 *
 * @example
 * ```ts
 * const result = validateCoinFlipPrediction("heads");
 * if (result.success) {
 *   await contract.placeBet({ side: result.data.contractValue, ... });
 * }
 * ```
 */
export function validateCoinFlipPrediction(
  value: string | null | undefined,
): ValidationResult<ParsedCoinFlipSide> {
  const enumResult = validateEnum(
    value as CoinFlipSide | null | undefined,
    COIN_FLIP_SIDES,
    'side',
  );

  if (!enumResult.success) {
    return enumResult as ValidationResult<ParsedCoinFlipSide>;
  }

  return {
    success: true,
    data: {
      label: enumResult.data,
      contractValue: COIN_FLIP_SIDE_TO_U32[enumResult.data],
    },
  };
}

// ── Pattern Puzzle Solution Validation ────────────────────────────────────────

/**
 * Validates a pattern puzzle solution string.
 * Solutions are arbitrary UTF-8 strings encoded as hex on-chain (Bytes).
 * Minimum length: 1 character. Maximum: PUZZLE_SOLUTION_MAX_BYTES bytes.
 *
 * @param value - The solution string to validate
 * @returns ValidationResult with the trimmed solution string or error
 *
 * @example
 * ```ts
 * const result = validatePatternSolution("RRBGBR");
 * if (result.success) submitSolution(result.data);
 * ```
 */
export function validatePatternSolution(
  value: string | null | undefined,
): ValidationResult<string> {
  // Perform the basic string checks (required, min length) first.
  const stringResult = validateString(value, 'solution', { minLength: 1 });
  if (!stringResult.success) return stringResult;

  // validateString uses string.length (UTF-16 code units). Solutions are stored
  // as Bytes on-chain, so we must enforce the limit against UTF-8 byte length.
  const byteLength = new TextEncoder().encode(stringResult.data).length;
  if (byteLength > PUZZLE_SOLUTION_MAX_BYTES) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.TooLong,
        message: `Solution cannot exceed ${PUZZLE_SOLUTION_MAX_BYTES} bytes`,
        field: 'solution',
        context: { byteLength, max: PUZZLE_SOLUTION_MAX_BYTES },
      },
    };
  }

  return stringResult;
}

/**
 * Validates a pattern commitment hash (SHA-256 of the correct pattern).
 * Used by admin when creating a puzzle round.
 */
export function validatePatternCommitment(
  value: string | null | undefined,
): ValidationResult<string> {
  const result = validateSha256Hash(value);
  if (!result.success) {
    return {
      success: false,
      error: { ...result.error, field: 'commitmentHash' },
    };
  }
  return result;
}

// ── Puzzle Entry Fee Validation ────────────────────────────────────────────────

/**
 * Validates a puzzle round entry fee (may be 0 for free rounds).
 * Delegates to validateWager but with puzzle-specific bounds and field name.
 *
 * @param value - Entry fee in stroops
 * @param bounds - Optional custom bounds (defaults to PUZZLE_ENTRY_FEE_BOUNDS)
 * @returns ValidationResult with parsed bigint or error
 */
export function validatePuzzleEntryFee(
  value: bigint | string | number | null | undefined,
  bounds: Readonly<WagerBounds> = PUZZLE_ENTRY_FEE_BOUNDS,
): ValidationResult<bigint> {
  // Free rounds (0n) are valid — handle before delegating to validateWager.
  if (value !== null && value !== undefined && value !== '') {
    let parsed: bigint;
    try {
      parsed = typeof value === 'bigint' ? value : BigInt(value);
    } catch {
      return {
        success: false,
        error: {
          code: ValidationErrorCode.InvalidType,
          message: 'Entry fee must be a valid integer',
          field: 'entryFee',
          context: { value },
        },
      };
    }

    if (parsed === 0n) {
      if (bounds.min <= 0n) {
        return { success: true, data: 0n };
      }
      // 0 is below the custom min — fall through to validateWager
    }
  }

  const result = validateWager(value, bounds);
  if (!result.success) {
    return {
      success: false,
      error: { ...result.error, field: 'entryFee' },
    };
  }
  return result;
}

// ── Compound Schemas ───────────────────────────────────────────────────────────

// --- Coin Flip ---

export interface CoinFlipBetInput {
  wager: bigint | string | number | null | undefined;
  side: string | null | undefined;
  walletAddress: string | null | undefined;
  /** Optional custom wager bounds. Defaults to COIN_FLIP_WAGER_BOUNDS. */
  wagerBounds?: WagerBounds;
}

export interface ParsedCoinFlipBet {
  wager: bigint;
  side: ParsedCoinFlipSide;
  walletAddress: string;
}

/**
 * Compound validator for placing a coin-flip bet.
 * Validates all three required fields in one call. Fails on the first
 * invalid field so the error always targets a specific field.
 *
 * @param input - Bet parameters to validate
 * @returns ValidationResult with fully-typed parsed parameters or error
 *
 * @example
 * ```ts
 * const result = parseCoinFlipBet({ wager: "50000000", side: "heads", walletAddress: "G..." });
 * if (result.success) {
 *   await client.coinFlip_placeBet(result.data.wager, result.data.side.contractValue);
 * }
 * ```
 */
export function parseCoinFlipBet(input: CoinFlipBetInput): ValidationResult<ParsedCoinFlipBet> {
  const wagerResult = validateWager(input.wager, input.wagerBounds ?? COIN_FLIP_WAGER_BOUNDS);
  if (!wagerResult.success) return wagerResult;

  const sideResult = validateCoinFlipPrediction(input.side);
  if (!sideResult.success) return sideResult;

  const addressResult = validateStellarAddress(input.walletAddress);
  if (!addressResult.success) {
    return { success: false, error: { ...addressResult.error, field: 'walletAddress' } };
  }

  return {
    success: true,
    data: {
      wager: wagerResult.data,
      side: sideResult.data,
      walletAddress: addressResult.data,
    },
  };
}

// --- Pattern Puzzle: Submit Solution ---

export interface PatternSubmissionInput {
  roundId: bigint | string | number | null | undefined;
  solution: string | null | undefined;
  entryFee: bigint | string | number | null | undefined;
  walletAddress: string | null | undefined;
  /** Optional custom entry-fee bounds. Defaults to PUZZLE_ENTRY_FEE_BOUNDS. */
  entryFeeBounds?: WagerBounds;
}

export interface ParsedPatternSubmission {
  roundId: bigint;
  solution: string;
  entryFee: bigint;
  walletAddress: string;
}

/**
 * Compound validator for submitting a Pattern Puzzle solution.
 *
 * @param input - Submission parameters to validate
 * @returns ValidationResult with fully-typed parsed parameters or error
 *
 * @example
 * ```ts
 * const result = parsePatternSubmission({
 *   roundId: "3",
 *   solution: "RRBGBR",
 *   entryFee: "10000000",
 *   walletAddress: "G...",
 * });
 * if (result.success) await contract.submitSolution(result.data);
 * ```
 */
export function parsePatternSubmission(
  input: PatternSubmissionInput,
): ValidationResult<ParsedPatternSubmission> {
  const roundResult = validateRoundId(input.roundId);
  if (!roundResult.success) return roundResult;

  const solutionResult = validatePatternSolution(input.solution);
  if (!solutionResult.success) return solutionResult;

  const feeResult = validatePuzzleEntryFee(input.entryFee, input.entryFeeBounds);
  if (!feeResult.success) return feeResult;

  const addressResult = validateStellarAddress(input.walletAddress);
  if (!addressResult.success) {
    return { success: false, error: { ...addressResult.error, field: 'walletAddress' } };
  }

  return {
    success: true,
    data: {
      roundId: roundResult.data,
      solution: solutionResult.data,
      entryFee: feeResult.data,
      walletAddress: addressResult.data,
    },
  };
}

// --- Pattern Puzzle: Create Round ---

export interface CreatePuzzleRoundInput {
  roundId: bigint | string | number | null | undefined;
  commitmentHash: string | null | undefined;
  entryFee: bigint | string | number | null | undefined;
  entryFeeBounds?: WagerBounds;
}

export interface ParsedCreatePuzzleRound {
  roundId: bigint;
  commitmentHash: string;
  entryFee: bigint;
}

/**
 * Compound validator for the admin creating a new Pattern Puzzle round.
 */
export function parseCreatePuzzleRound(
  input: CreatePuzzleRoundInput,
): ValidationResult<ParsedCreatePuzzleRound> {
  const roundResult = validateRoundId(input.roundId);
  if (!roundResult.success) return roundResult;

  const hashResult = validatePatternCommitment(input.commitmentHash);
  if (!hashResult.success) return hashResult;

  const feeResult = validatePuzzleEntryFee(input.entryFee, input.entryFeeBounds);
  if (!feeResult.success) return feeResult;

  return {
    success: true,
    data: {
      roundId: roundResult.data,
      commitmentHash: hashResult.data,
      entryFee: feeResult.data,
    },
  };
}

// --- Prize Pool: Reserve ---

export interface PrizePoolReservationInput {
  gameId: bigint | string | number | null | undefined;
  amount: bigint | string | number | null | undefined;
  amountBounds?: WagerBounds;
}

export interface ParsedPrizePoolReservation {
  gameId: bigint;
  amount: bigint;
}

/**
 * Compound validator for reserving a prize-pool slot for a new game.
 *
 * @param input - Reservation parameters
 * @returns ValidationResult with parsed gameId and amount or error
 */
export function parsePrizePoolReservation(
  input: PrizePoolReservationInput,
): ValidationResult<ParsedPrizePoolReservation> {
  const gameIdResult = validateGameId(input.gameId);
  if (!gameIdResult.success) return gameIdResult;

  const amountResult = validateWager(input.amount, input.amountBounds ?? PRIZE_POOL_AMOUNT_BOUNDS);
  if (!amountResult.success) {
    return {
      success: false,
      error: { ...amountResult.error, field: 'amount' },
    };
  }

  return {
    success: true,
    data: {
      gameId: gameIdResult.data,
      amount: amountResult.data,
    },
  };
}

// --- Prize Pool: Payout ---

export interface PrizePoolPayoutInput {
  gameId: bigint | string | number | null | undefined;
  amount: bigint | string | number | null | undefined;
  recipient: string | null | undefined;
  amountBounds?: WagerBounds;
}

export interface ParsedPrizePoolPayout {
  gameId: bigint;
  amount: bigint;
  recipient: string;
}

/**
 * Compound validator for issuing a prize-pool payout.
 *
 * @param input - Payout parameters
 * @returns ValidationResult with parsed parameters or error
 */
export function parsePrizePoolPayout(
  input: PrizePoolPayoutInput,
): ValidationResult<ParsedPrizePoolPayout> {
  const gameIdResult = validateGameId(input.gameId);
  if (!gameIdResult.success) return gameIdResult;

  const amountResult = validateWager(input.amount, input.amountBounds ?? PRIZE_POOL_AMOUNT_BOUNDS);
  if (!amountResult.success) {
    return {
      success: false,
      error: { ...amountResult.error, field: 'amount' },
    };
  }

  const recipientResult = validateStellarAddress(input.recipient);
  if (!recipientResult.success) {
    return { success: false, error: { ...recipientResult.error, field: 'recipient' } };
  }

  return {
    success: true,
    data: {
      gameId: gameIdResult.data,
      amount: amountResult.data,
      recipient: recipientResult.data,
    },
  };
}

// ── Precondition Guards ───────────────────────────────────────────────────────

/**
 * Aggregated precondition payload returned by checkGamePreconditions.
 */
export interface PreconditionCheckResult {
  /** True only if ALL preconditions pass. */
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Checks all standard preconditions required before any game operation:
 * wallet connectivity, network support, and contract address presence.
 *
 * Returns a list of ALL failing preconditions rather than stopping at the
 * first failure — callers can surface every issue at once.
 *
 * @param walletAddress - Connected wallet's public key (or null if not connected)
 * @param networkPassphrase - Active network passphrase (or null if unknown)
 * @param expectedPassphrase - Required network passphrase
 * @param contractAddress - Target contract address (or null if not configured)
 * @returns PreconditionCheckResult with valid flag and list of errors
 *
 * @example
 * ```ts
 * const check = checkGamePreconditions(wallet.address, wallet.network, TESTNET, prizePoolAddr);
 * if (!check.valid) {
 *   check.errors.forEach(e => toast.error(e.message));
 *   return;
 * }
 * ```
 */
export function checkGamePreconditions(
  walletAddress: string | null | undefined,
  networkPassphrase: string | null | undefined,
  expectedPassphrase: string,
  contractAddress: string | null | undefined,
): PreconditionCheckResult {
  const errors: ValidationError[] = [];

  if (!isWalletConnected(walletAddress)) {
    errors.push({
      code: ValidationErrorCode.Required,
      message: 'Wallet is not connected. Connect a wallet before playing.',
      field: 'walletAddress',
    });
  }

  if (!networkPassphrase || networkPassphrase !== expectedPassphrase) {
    errors.push({
      code: ValidationErrorCode.InvalidFormat,
      message: `Network mismatch. Expected "${expectedPassphrase}", got "${networkPassphrase ?? 'unknown'}".`,
      field: 'network',
      context: { expected: expectedPassphrase, actual: networkPassphrase ?? null },
    });
  }

  if (!contractAddress) {
    errors.push({
      code: ValidationErrorCode.Required,
      message: 'Contract address is not configured.',
      field: 'contractAddress',
    });
  } else {
    const addrResult = validateContractAddress(contractAddress);
    if (!addrResult.success) {
      errors.push(addrResult.error);
    }
  }

  return { valid: errors.length === 0, errors };
}
