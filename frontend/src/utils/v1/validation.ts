/**
 * Reusable input validators and guards for Stellarcade frontend.
 *
 * All validators return typed parse results with clear failure reasons.
 * Validation rules are centralized here for consistency across the app.
 *
 * @module utils/v1/validation
 */

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Discriminated union for validation results.
 * Forces callers to handle both success and failure paths at the type level.
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: ValidationError };

/**
 * Structured validation error with machine-readable code.
 */
export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  field?: string;
  context?: Record<string, unknown>;
}

export enum ValidationErrorCode {
  Required = "REQUIRED",
  InvalidType = "INVALID_TYPE",
  OutOfRange = "OUT_OF_RANGE",
  InvalidFormat = "INVALID_FORMAT",
  InvalidEnum = "INVALID_ENUM",
  TooShort = "TOO_SHORT",
  TooLong = "TOO_LONG",
  InvalidAddress = "INVALID_ADDRESS",
  InvalidHash = "INVALID_HASH",
}

// ── Wager Validation ───────────────────────────────────────────────────────────

export interface WagerBounds {
  min: bigint;
  max: bigint;
}

/**
 * Default wager bounds (in stroops: 1 XLM = 10,000,000 stroops).
 * Min: 1 XLM, Max: 1000 XLM
 */
export const DEFAULT_WAGER_BOUNDS: Readonly<WagerBounds> = Object.freeze({
  min: 10_000_000n, // 1 XLM
  max: 10_000_000_000n, // 1000 XLM
});

/**
 * Validates a wager amount against configurable bounds.
 *
 * @param value - The wager amount (bigint or string/number to parse)
 * @param bounds - Optional custom bounds (defaults to DEFAULT_WAGER_BOUNDS)
 * @returns ValidationResult with parsed bigint or error
 *
 * @example
 * ```ts
 * const result = validateWager("50000000"); // 5 XLM
 * if (result.success) {
 *   console.log("Valid wager:", result.data);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export function validateWager(
  value: bigint | string | number | null | undefined,
  bounds: Readonly<WagerBounds> = DEFAULT_WAGER_BOUNDS
): ValidationResult<bigint> {
  if (value === null || value === undefined || value === "") {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: "Wager amount is required",
        field: "wager",
      },
    };
  }

  let parsed: bigint;
  try {
    parsed = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidType,
        message: "Wager must be a valid integer",
        field: "wager",
        context: { value },
      },
    };
  }

  if (parsed <= 0n) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.OutOfRange,
        message: "Wager must be greater than zero",
        field: "wager",
        context: { value: parsed.toString(), min: "1" },
      },
    };
  }

  if (parsed < bounds.min) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.OutOfRange,
        message: `Wager must be at least ${bounds.min} stroops`,
        field: "wager",
        context: { value: parsed.toString(), min: bounds.min.toString() },
      },
    };
  }

  if (parsed > bounds.max) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.OutOfRange,
        message: `Wager cannot exceed ${bounds.max} stroops`,
        field: "wager",
        context: { value: parsed.toString(), max: bounds.max.toString() },
      },
    };
  }

  return { success: true, data: parsed };
}

// ── ID Validation ──────────────────────────────────────────────────────────────

/**
 * Validates a game ID (u64 represented as bigint).
 *
 * @param value - The game ID to validate
 * @returns ValidationResult with parsed bigint or error
 *
 * @example
 * ```ts
 * const result = validateGameId("12345");
 * if (result.success) {
 *   console.log("Valid game ID:", result.data);
 * }
 * ```
 */
export function validateGameId(
  value: bigint | string | number | null | undefined
): ValidationResult<bigint> {
  if (value === null || value === undefined || value === "") {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: "Game ID is required",
        field: "gameId",
      },
    };
  }

  let parsed: bigint;
  try {
    parsed = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidType,
        message: "Game ID must be a valid integer",
        field: "gameId",
        context: { value },
      },
    };
  }

  if (parsed < 0n) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.OutOfRange,
        message: "Game ID must be non-negative",
        field: "gameId",
        context: { value: parsed.toString() },
      },
    };
  }

  return { success: true, data: parsed };
}

/**
 * Validates a badge ID (u64 represented as bigint).
 *
 * @param value - The badge ID to validate
 * @returns ValidationResult with parsed bigint or error
 */
export function validateBadgeId(
  value: bigint | string | number | null | undefined
): ValidationResult<bigint> {
  if (value === null || value === undefined || value === "") {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: "Badge ID is required",
        field: "badgeId",
      },
    };
  }

  let parsed: bigint;
  try {
    parsed = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidType,
        message: "Badge ID must be a valid integer",
        field: "badgeId",
        context: { value },
      },
    };
  }

  if (parsed < 0n) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.OutOfRange,
        message: "Badge ID must be non-negative",
        field: "badgeId",
        context: { value: parsed.toString() },
      },
    };
  }

  return { success: true, data: parsed };
}

// ── Enum Validation ────────────────────────────────────────────────────────────

/**
 * Validates that a value is one of the allowed enum values.
 *
 * @param value - The value to validate
 * @param allowedValues - Array of allowed values
 * @param fieldName - Name of the field for error messages
 * @returns ValidationResult with the validated value or error
 *
 * @example
 * ```ts
 * const result = validateEnum("heads", ["heads", "tails"], "side");
 * if (result.success) {
 *   console.log("Valid side:", result.data);
 * }
 * ```
 */
export function validateEnum<T extends string>(
  value: T | null | undefined,
  allowedValues: readonly T[],
  fieldName: string = "value"
): ValidationResult<T> {
  if (value === null || value === undefined || value === "") {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: `${fieldName} is required`,
        field: fieldName,
      },
    };
  }

  if (!allowedValues.includes(value)) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidEnum,
        message: `${fieldName} must be one of: ${allowedValues.join(", ")}`,
        field: fieldName,
        context: { value, allowedValues: [...allowedValues] },
      },
    };
  }

  return { success: true, data: value };
}

// ── Stellar Address Validation ─────────────────────────────────────────────────

/**
 * Validates a Stellar public key (G... address).
 *
 * @param value - The address to validate
 * @returns ValidationResult with the validated address or error
 *
 * @example
 * ```ts
 * const result = validateStellarAddress("GABC...");
 * if (result.success) {
 *   console.log("Valid address:", result.data);
 * }
 * ```
 */
export function validateStellarAddress(
  value: string | null | undefined
): ValidationResult<string> {
  if (!value || value.trim() === "") {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: "Stellar address is required",
        field: "address",
      },
    };
  }

  const trimmed = value.trim();

  // Basic format check: starts with G, 56 characters
  if (!trimmed.startsWith("G")) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidAddress,
        message: "Stellar address must start with 'G'",
        field: "address",
        context: { value: trimmed },
      },
    };
  }

  if (trimmed.length !== 56) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidAddress,
        message: "Stellar address must be exactly 56 characters",
        field: "address",
        context: { value: trimmed, length: trimmed.length },
      },
    };
  }

  // Check for valid base32 characters (A-Z, 2-7)
  if (!/^[A-Z2-7]{56}$/.test(trimmed)) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidAddress,
        message: "Stellar address contains invalid characters",
        field: "address",
        context: { value: trimmed },
      },
    };
  }

  return { success: true, data: trimmed };
}

// ── Contract Address Validation ────────────────────────────────────────────────

/**
 * Validates a Stellar contract address (C... address).
 *
 * @param value - The contract address to validate
 * @returns ValidationResult with the validated address or error
 */
export function validateContractAddress(
  value: string | null | undefined
): ValidationResult<string> {
  if (!value || value.trim() === "") {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: "Contract address is required",
        field: "contractAddress",
      },
    };
  }

  const trimmed = value.trim();

  // Contract addresses start with C
  if (!trimmed.startsWith("C")) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidAddress,
        message: "Contract address must start with 'C'",
        field: "contractAddress",
        context: { value: trimmed },
      },
    };
  }

  if (trimmed.length !== 56) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidAddress,
        message: "Contract address must be exactly 56 characters",
        field: "contractAddress",
        context: { value: trimmed, length: trimmed.length },
      },
    };
  }

  if (!/^[A-Z2-7]{56}$/.test(trimmed)) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidAddress,
        message: "Contract address contains invalid characters",
        field: "contractAddress",
        context: { value: trimmed },
      },
    };
  }

  return { success: true, data: trimmed };
}

// ── Hash Validation ────────────────────────────────────────────────────────────

/**
 * Validates a SHA-256 hash (64-character lowercase hex string).
 * Used for badge criteria hashes and other cryptographic hashes.
 *
 * @param value - The hash to validate
 * @returns ValidationResult with the validated hash or error
 *
 * @example
 * ```ts
 * const result = validateSha256Hash("a3f5...c1d2");
 * if (result.success) {
 *   console.log("Valid hash:", result.data);
 * }
 * ```
 */
export function validateSha256Hash(
  value: string | null | undefined
): ValidationResult<string> {
  if (!value || value.trim() === "") {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: "Hash is required",
        field: "hash",
      },
    };
  }

  const trimmed = value.trim().toLowerCase();

  if (trimmed.length !== 64) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidHash,
        message: "SHA-256 hash must be exactly 64 characters",
        field: "hash",
        context: { value: trimmed, length: trimmed.length },
      },
    };
  }

  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidHash,
        message: "Hash must contain only hexadecimal characters (0-9, a-f)",
        field: "hash",
        context: { value: trimmed },
      },
    };
  }

  return { success: true, data: trimmed };
}

// ── String Validation ──────────────────────────────────────────────────────────

export interface StringConstraints {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternDescription?: string;
}

/**
 * Validates a string against length and pattern constraints.
 *
 * @param value - The string to validate
 * @param fieldName - Name of the field for error messages
 * @param constraints - Optional length and pattern constraints
 * @returns ValidationResult with the validated string or error
 *
 * @example
 * ```ts
 * const result = validateString("username", "username", {
 *   minLength: 3,
 *   maxLength: 20,
 *   pattern: /^[a-z0-9_]+$/,
 *   patternDescription: "lowercase letters, numbers, and underscores"
 * });
 * ```
 */
export function validateString(
  value: string | null | undefined,
  fieldName: string,
  constraints: StringConstraints = {}
): ValidationResult<string> {
  if (value === null || value === undefined) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: `${fieldName} is required`,
        field: fieldName,
      },
    };
  }

  const trimmed = value.trim();

  if (trimmed === "" && constraints.minLength !== 0) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: `${fieldName} cannot be empty`,
        field: fieldName,
      },
    };
  }

  if (constraints.minLength !== undefined && trimmed.length < constraints.minLength) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.TooShort,
        message: `${fieldName} must be at least ${constraints.minLength} characters`,
        field: fieldName,
        context: { value: trimmed, minLength: constraints.minLength },
      },
    };
  }

  if (constraints.maxLength !== undefined && trimmed.length > constraints.maxLength) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.TooLong,
        message: `${fieldName} cannot exceed ${constraints.maxLength} characters`,
        field: fieldName,
        context: { value: trimmed, maxLength: constraints.maxLength },
      },
    };
  }

  if (constraints.pattern && !constraints.pattern.test(trimmed)) {
    const desc = constraints.patternDescription || "the required format";
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidFormat,
        message: `${fieldName} must match ${desc}`,
        field: fieldName,
        context: { value: trimmed },
      },
    };
  }

  return { success: true, data: trimmed };
}

// ── Numeric Range Validation ───────────────────────────────────────────────────

export interface NumericBounds {
  min?: number;
  max?: number;
}

/**
 * Validates a number against optional min/max bounds.
 *
 * @param value - The number to validate
 * @param fieldName - Name of the field for error messages
 * @param bounds - Optional min/max bounds
 * @returns ValidationResult with the validated number or error
 *
 * @example
 * ```ts
 * const result = validateNumber(5, "difficulty", { min: 1, max: 10 });
 * ```
 */
export function validateNumber(
  value: number | string | null | undefined,
  fieldName: string,
  bounds: NumericBounds = {}
): ValidationResult<number> {
  if (value === null || value === undefined || value === "") {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.Required,
        message: `${fieldName} is required`,
        field: fieldName,
      },
    };
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (isNaN(parsed)) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.InvalidType,
        message: `${fieldName} must be a valid number`,
        field: fieldName,
        context: { value },
      },
    };
  }

  if (bounds.min !== undefined && parsed < bounds.min) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.OutOfRange,
        message: `${fieldName} must be at least ${bounds.min}`,
        field: fieldName,
        context: { value: parsed, min: bounds.min },
      },
    };
  }

  if (bounds.max !== undefined && parsed > bounds.max) {
    return {
      success: false,
      error: {
        code: ValidationErrorCode.OutOfRange,
        message: `${fieldName} cannot exceed ${bounds.max}`,
        field: fieldName,
        context: { value: parsed, max: bounds.max },
      },
    };
  }

  return { success: true, data: parsed };
}

// ── Helper Predicates ──────────────────────────────────────────────────────────

/**
 * Type guard to check if a value is defined (not null or undefined).
 *
 * @example
 * ```ts
 * if (isDefined(wallet)) {
 *   // TypeScript knows wallet is not null/undefined here
 *   console.log(wallet.address);
 * }
 * ```
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Type guard to check if a value is a non-empty string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Type guard to check if a value is a positive bigint.
 */
export function isPositiveBigInt(value: unknown): value is bigint {
  return typeof value === "bigint" && value > 0n;
}

/**
 * Type guard to check if a value is a non-negative bigint.
 */
export function isNonNegativeBigInt(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n;
}

/**
 * Checks if a wallet is connected and has a valid address.
 * Used as a precondition check before transaction operations.
 *
 * @param walletAddress - The wallet address to check
 * @returns true if wallet is connected with valid address
 */
export function isWalletConnected(walletAddress: string | null | undefined): walletAddress is string {
  return isDefined(walletAddress) && isNonEmptyString(walletAddress);
}
