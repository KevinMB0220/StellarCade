/**
 * Unit tests for input-validation-schemas service.
 *
 * Covers: round IDs, coin-flip predictions, pattern-puzzle solutions,
 * puzzle entry fees, compound schemas, and precondition guards.
 */

import { describe, it, expect } from 'vitest';
import {
  // Constants
  U64_MAX,
  COIN_FLIP_SIDES,
  COIN_FLIP_SIDE_TO_U32,
  COIN_FLIP_WAGER_BOUNDS,
  PUZZLE_ENTRY_FEE_BOUNDS,
  MAX_PLAYERS_PER_ROUND,
  PUZZLE_SOLUTION_MAX_BYTES,
  // Primitives
  ValidationErrorCode,
  validateWager,
  validateGameId,
  validateStellarAddress,
  // Round ID
  validateRoundId,
  // Coin Flip
  validateCoinFlipPrediction,
  // Pattern Puzzle
  validatePatternSolution,
  validatePatternCommitment,
  validatePuzzleEntryFee,
  // Compound schemas
  parseCoinFlipBet,
  parsePatternSubmission,
  parseCreatePuzzleRound,
  parsePrizePoolReservation,
  parsePrizePoolPayout,
  // Preconditions
  checkGamePreconditions,
} from '../../src/services/input-validation-schemas';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_WALLET = 'GABCDEFGHJKLMNPQRSTUVWXYZ234567ABCDEFGHJKLMNPQRSTUVWXYZ2';
const VALID_CONTRACT = 'CABCDEFGHJKLMNPQRSTUVWXYZ234567ABCDEFGHJKLMNPQRSTUVWXYZ2';
const VALID_HASH = 'a3f5c1d2e4b6789012345678901234567890abcdef1234567890abcdef123456';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const VALID_WAGER = 50_000_000n; // 5 XLM

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('U64_MAX is the correct value', () => {
    expect(U64_MAX).toBe(18_446_744_073_709_551_615n);
  });

  it('COIN_FLIP_SIDES contains heads and tails', () => {
    expect(COIN_FLIP_SIDES).toContain('heads');
    expect(COIN_FLIP_SIDES).toContain('tails');
    expect(COIN_FLIP_SIDES.length).toBe(2);
  });

  it('COIN_FLIP_SIDE_TO_U32 maps correctly', () => {
    expect(COIN_FLIP_SIDE_TO_U32.heads).toBe(0);
    expect(COIN_FLIP_SIDE_TO_U32.tails).toBe(1);
  });

  it('COIN_FLIP_WAGER_BOUNDS has correct min/max', () => {
    expect(COIN_FLIP_WAGER_BOUNDS.min).toBe(10_000_000n);
    expect(COIN_FLIP_WAGER_BOUNDS.max).toBe(10_000_000_000n);
  });

  it('PUZZLE_ENTRY_FEE_BOUNDS allows zero', () => {
    expect(PUZZLE_ENTRY_FEE_BOUNDS.min).toBe(0n);
  });

  it('MAX_PLAYERS_PER_ROUND matches contract constant', () => {
    expect(MAX_PLAYERS_PER_ROUND).toBe(500);
  });
});

// ── validateRoundId ───────────────────────────────────────────────────────────

describe('validateRoundId', () => {
  it('accepts valid string round ID', () => {
    const result = validateRoundId('7');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(7n);
  });

  it('accepts bigint input', () => {
    const result = validateRoundId(42n);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(42n);
  });

  it('accepts number input', () => {
    const result = validateRoundId(100);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(100n);
  });

  it('accepts zero', () => {
    const result = validateRoundId(0);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(0n);
  });

  it('accepts U64_MAX', () => {
    const result = validateRoundId(U64_MAX);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(U64_MAX);
  });

  it('rejects null', () => {
    const result = validateRoundId(null);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.Required);
  });

  it('rejects undefined', () => {
    const result = validateRoundId(undefined);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.Required);
  });

  it('rejects empty string', () => {
    const result = validateRoundId('');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.Required);
  });

  it('rejects negative value', () => {
    const result = validateRoundId(-1);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.OutOfRange);
  });

  it('rejects value exceeding U64_MAX', () => {
    const result = validateRoundId(U64_MAX + 1n);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.OutOfRange);
  });

  it('rejects non-numeric string', () => {
    const result = validateRoundId('abc');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.InvalidType);
  });

  it('sets field to roundId in errors', () => {
    const result = validateRoundId(null);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('roundId');
  });
});

// ── validateCoinFlipPrediction ─────────────────────────────────────────────────

describe('validateCoinFlipPrediction', () => {
  it('accepts "heads" and maps to contractValue 0', () => {
    const result = validateCoinFlipPrediction('heads');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.label).toBe('heads');
      expect(result.data.contractValue).toBe(0);
    }
  });

  it('accepts "tails" and maps to contractValue 1', () => {
    const result = validateCoinFlipPrediction('tails');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.label).toBe('tails');
      expect(result.data.contractValue).toBe(1);
    }
  });

  it('rejects invalid side', () => {
    const result = validateCoinFlipPrediction('edge' as never);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.InvalidEnum);
  });

  it('rejects null', () => {
    const result = validateCoinFlipPrediction(null);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.Required);
  });

  it('rejects empty string', () => {
    const result = validateCoinFlipPrediction('');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.Required);
  });

  it('is case-sensitive (rejects "Heads")', () => {
    const result = validateCoinFlipPrediction('Heads');
    expect(result.success).toBe(false);
  });
});

// ── validatePatternSolution ────────────────────────────────────────────────────

describe('validatePatternSolution', () => {
  it('accepts a non-empty solution string', () => {
    const result = validatePatternSolution('RRBGBR');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('RRBGBR');
  });

  it('trims surrounding whitespace', () => {
    const result = validatePatternSolution('  RRBGBR  ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('RRBGBR');
  });

  it('rejects empty string', () => {
    const result = validatePatternSolution('');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.Required);
  });

  it('rejects null', () => {
    const result = validatePatternSolution(null);
    expect(result.success).toBe(false);
  });

  it('rejects solution exceeding max bytes', () => {
    const oversized = 'A'.repeat(PUZZLE_SOLUTION_MAX_BYTES + 1);
    const result = validatePatternSolution(oversized);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.TooLong);
  });

  it('accepts solution at exactly max bytes', () => {
    const maxSize = 'A'.repeat(PUZZLE_SOLUTION_MAX_BYTES);
    const result = validatePatternSolution(maxSize);
    expect(result.success).toBe(true);
  });
});

// ── validatePatternCommitment ──────────────────────────────────────────────────

describe('validatePatternCommitment', () => {
  it('accepts a valid SHA-256 hash', () => {
    const result = validatePatternCommitment(VALID_HASH);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(VALID_HASH);
  });

  it('normalises to lowercase', () => {
    const result = validatePatternCommitment(VALID_HASH.toUpperCase());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(VALID_HASH);
  });

  it('rejects hash with wrong length', () => {
    const result = validatePatternCommitment('abc123');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ValidationErrorCode.InvalidHash);
      expect(result.error.field).toBe('commitmentHash');
    }
  });

  it('rejects null', () => {
    const result = validatePatternCommitment(null);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ValidationErrorCode.Required);
      expect(result.error.field).toBe('commitmentHash');
    }
  });
});

// ── validatePuzzleEntryFee ────────────────────────────────────────────────────

describe('validatePuzzleEntryFee', () => {
  it('accepts zero for free rounds', () => {
    const result = validatePuzzleEntryFee(0);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(0n);
  });

  it('accepts zero as bigint', () => {
    const result = validatePuzzleEntryFee(0n);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(0n);
  });

  it('accepts valid non-zero fee', () => {
    const result = validatePuzzleEntryFee(10_000_000n); // 1 XLM
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(10_000_000n);
  });

  it('rejects negative fee', () => {
    const result = validatePuzzleEntryFee(-1);
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = validatePuzzleEntryFee(null);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.Required);
  });

  it('rejects fee above max bound', () => {
    const result = validatePuzzleEntryFee(PUZZLE_ENTRY_FEE_BOUNDS.max + 1n);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.OutOfRange);
  });

  it('respects custom bounds', () => {
    const customBounds = { min: 0n, max: 100_000n };
    const result = validatePuzzleEntryFee(50_000, customBounds);
    expect(result.success).toBe(true);
  });

  it('rejects zero when custom bounds require min > 0', () => {
    const customBounds = { min: 1_000_000n, max: 10_000_000_000n };
    const result = validatePuzzleEntryFee(0, customBounds);
    expect(result.success).toBe(false);
  });
});

// ── parseCoinFlipBet ──────────────────────────────────────────────────────────

describe('parseCoinFlipBet', () => {
  const validInput = {
    wager: VALID_WAGER,
    side: 'tails',
    walletAddress: VALID_WALLET,
  };

  it('returns parsed bet for valid input', () => {
    const result = parseCoinFlipBet(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.wager).toBe(VALID_WAGER);
      expect(result.data.side.label).toBe('tails');
      expect(result.data.side.contractValue).toBe(1);
      expect(result.data.walletAddress).toBe(VALID_WALLET);
    }
  });

  it('fails when wager is missing', () => {
    const result = parseCoinFlipBet({ ...validInput, wager: null });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('wager');
  });

  it('fails when wager is below minimum', () => {
    const result = parseCoinFlipBet({ ...validInput, wager: 100n });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.OutOfRange);
  });

  it('fails when side is invalid', () => {
    const result = parseCoinFlipBet({ ...validInput, side: 'edge' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.InvalidEnum);
  });

  it('fails when walletAddress is null', () => {
    const result = parseCoinFlipBet({ ...validInput, walletAddress: null });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('walletAddress');
  });

  it('respects custom wager bounds', () => {
    const result = parseCoinFlipBet({
      ...validInput,
      wager: 500n,
      wagerBounds: { min: 100n, max: 1000n },
    });
    expect(result.success).toBe(true);
  });

  it('reports wager error before side error (field priority)', () => {
    const result = parseCoinFlipBet({ wager: null, side: 'invalid', walletAddress: null });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('wager');
  });
});

// ── parsePatternSubmission ────────────────────────────────────────────────────

describe('parsePatternSubmission', () => {
  const validInput = {
    roundId: '3',
    solution: 'RRBGBR',
    entryFee: '10000000',
    walletAddress: VALID_WALLET,
  };

  it('returns parsed submission for valid input', () => {
    const result = parsePatternSubmission(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roundId).toBe(3n);
      expect(result.data.solution).toBe('RRBGBR');
      expect(result.data.entryFee).toBe(10_000_000n);
      expect(result.data.walletAddress).toBe(VALID_WALLET);
    }
  });

  it('accepts free round (entryFee = 0)', () => {
    const result = parsePatternSubmission({ ...validInput, entryFee: '0' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.entryFee).toBe(0n);
  });

  it('fails when roundId is invalid', () => {
    const result = parsePatternSubmission({ ...validInput, roundId: '-1' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('roundId');
  });

  it('fails when solution is empty', () => {
    const result = parsePatternSubmission({ ...validInput, solution: '' });
    expect(result.success).toBe(false);
  });

  it('fails when entryFee is invalid', () => {
    const result = parsePatternSubmission({ ...validInput, entryFee: 'abc' });
    expect(result.success).toBe(false);
  });

  it('fails when walletAddress is invalid', () => {
    const result = parsePatternSubmission({ ...validInput, walletAddress: 'bad-address' });
    expect(result.success).toBe(false);
  });
});

// ── parseCreatePuzzleRound ────────────────────────────────────────────────────

describe('parseCreatePuzzleRound', () => {
  const validInput = {
    roundId: '1',
    commitmentHash: VALID_HASH,
    entryFee: '0',
  };

  it('returns parsed round for valid input', () => {
    const result = parseCreatePuzzleRound(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roundId).toBe(1n);
      expect(result.data.commitmentHash).toBe(VALID_HASH);
      expect(result.data.entryFee).toBe(0n);
    }
  });

  it('fails when commitmentHash is malformed', () => {
    const result = parseCreatePuzzleRound({ ...validInput, commitmentHash: 'short' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ValidationErrorCode.InvalidHash);
  });

  it('fails when roundId is missing', () => {
    const result = parseCreatePuzzleRound({ ...validInput, roundId: null });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('roundId');
  });
});

// ── parsePrizePoolReservation ─────────────────────────────────────────────────

describe('parsePrizePoolReservation', () => {
  it('returns parsed reservation for valid input', () => {
    const result = parsePrizePoolReservation({ gameId: '99', amount: VALID_WAGER });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gameId).toBe(99n);
      expect(result.data.amount).toBe(VALID_WAGER);
    }
  });

  it('fails when gameId is negative', () => {
    const result = parsePrizePoolReservation({ gameId: '-1', amount: VALID_WAGER });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('gameId');
  });

  it('fails when amount is below minimum', () => {
    const result = parsePrizePoolReservation({ gameId: '1', amount: 1n });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('amount');
  });

  it('fails when amount is missing', () => {
    const result = parsePrizePoolReservation({ gameId: '1', amount: null });
    expect(result.success).toBe(false);
  });
});

// ── parsePrizePoolPayout ──────────────────────────────────────────────────────

describe('parsePrizePoolPayout', () => {
  it('returns parsed payout for valid input', () => {
    const result = parsePrizePoolPayout({
      gameId: '5',
      amount: VALID_WAGER,
      recipient: VALID_WALLET,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gameId).toBe(5n);
      expect(result.data.amount).toBe(VALID_WAGER);
      expect(result.data.recipient).toBe(VALID_WALLET);
    }
  });

  it('fails when recipient is missing', () => {
    const result = parsePrizePoolPayout({ gameId: '5', amount: VALID_WAGER, recipient: null });
    expect(result.success).toBe(false);
  });

  it('fails when gameId is invalid', () => {
    const result = parsePrizePoolPayout({
      gameId: 'abc',
      amount: VALID_WAGER,
      recipient: VALID_WALLET,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('gameId');
  });
});

// ── checkGamePreconditions ────────────────────────────────────────────────────

describe('checkGamePreconditions', () => {
  it('returns valid=true when all preconditions pass', () => {
    const result = checkGamePreconditions(
      VALID_WALLET,
      TESTNET_PASSPHRASE,
      TESTNET_PASSPHRASE,
      VALID_CONTRACT,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when wallet is not connected', () => {
    const result = checkGamePreconditions(
      null,
      TESTNET_PASSPHRASE,
      TESTNET_PASSPHRASE,
      VALID_CONTRACT,
    );
    expect(result.valid).toBe(false);
    const walletError = result.errors.find((e) => e.field === 'walletAddress');
    expect(walletError).toBeDefined();
  });

  it('fails when network does not match', () => {
    const result = checkGamePreconditions(
      VALID_WALLET,
      'Public Global Stellar Network ; September 2015',
      TESTNET_PASSPHRASE,
      VALID_CONTRACT,
    );
    expect(result.valid).toBe(false);
    const netError = result.errors.find((e) => e.field === 'network');
    expect(netError).toBeDefined();
  });

  it('fails when contract address is missing', () => {
    const result = checkGamePreconditions(
      VALID_WALLET,
      TESTNET_PASSPHRASE,
      TESTNET_PASSPHRASE,
      null,
    );
    expect(result.valid).toBe(false);
    const addrError = result.errors.find((e) => e.field === 'contractAddress');
    expect(addrError).toBeDefined();
  });

  it('fails when contract address is invalid format', () => {
    const result = checkGamePreconditions(
      VALID_WALLET,
      TESTNET_PASSPHRASE,
      TESTNET_PASSPHRASE,
      'INVALID_ADDRESS',
    );
    expect(result.valid).toBe(false);
  });

  it('collects ALL failing preconditions, not just the first', () => {
    const result = checkGamePreconditions(null, 'wrong-network', TESTNET_PASSPHRASE, null);
    expect(result.valid).toBe(false);
    // All three conditions should fail
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('reports wallet, network, and contract errors independently', () => {
    const result = checkGamePreconditions(null, 'wrong', TESTNET_PASSPHRASE, null);
    const fields = result.errors.map((e) => e.field);
    expect(fields).toContain('walletAddress');
    expect(fields).toContain('network');
    expect(fields).toContain('contractAddress');
  });
});

// ── Re-exported primitives ────────────────────────────────────────────────────

describe('re-exported primitive validators', () => {
  it('validateWager is re-exported and functional', () => {
    const result = validateWager(50_000_000n);
    expect(result.success).toBe(true);
  });

  it('validateGameId is re-exported and functional', () => {
    const result = validateGameId('42');
    expect(result.success).toBe(true);
  });

  it('validateStellarAddress is re-exported and functional', () => {
    const result = validateStellarAddress(VALID_WALLET);
    expect(result.success).toBe(true);
  });
});
