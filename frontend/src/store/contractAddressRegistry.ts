/**
 * Contract Address Registry
 *
 * Centralises lookup of deployed Soroban contract addresses. All addresses are
 * validated on construction so callers can rely on a fail-fast, early-error
 * model rather than discovering bad addresses at RPC call time.
 *
 * In a browser environment addresses come from `VITE_*_CONTRACT_ID` env vars.
 * In test environments use `ContractAddressRegistry.fromObject(...)`.
 */

import { SorobanClientError } from "../types/errors";

/** Keys for every Soroban contract deployed by StellarCade. */
export interface ContractAddresses {
  prizePool: string;
  achievementBadge: string;
  accessControl: string;
  coinFlip: string;
  randomGenerator: string;
}

/**
 * Soroban contract addresses start with 'C' and are 56 characters long
 * (base32-encoded contract ID).
 */
const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

function isValidContractAddress(addr: string): boolean {
  return CONTRACT_ADDRESS_RE.test(addr);
}

export class ContractAddressRegistry {
  private readonly addresses: ContractAddresses;

  constructor(addresses: ContractAddresses) {
    this.addresses = addresses;
  }

  /**
   * Build a registry from `VITE_*_CONTRACT_ID` environment variables.
   * Throws `SorobanClientError` (ContractAddressNotFound) for any missing var.
   *
   * Must be called in a Vite/browser context where `import.meta.env` is
   * available.  In Node test environments, use `fromObject` instead.
   */
  static fromEnv(): ContractAddressRegistry {
    // Read env vars from process.env (works in Node/test, and in Vite builds
    // where VITE_* vars are available as process.env.VITE_*).
    // In the browser at runtime, Vite replaces process.env.VITE_* references
    // during the build, so this also works in production bundles.
    const e: Record<string, string | undefined> =
      typeof process !== "undefined" ? process.env : {};

    const required: Array<[keyof ContractAddresses, string]> = [
      ["prizePool", "VITE_PRIZE_POOL_CONTRACT_ID"],
      ["achievementBadge", "VITE_ACHIEVEMENT_BADGE_CONTRACT_ID"],
      ["accessControl", "VITE_ACCESS_CONTROL_CONTRACT_ID"],
      ["coinFlip", "VITE_COIN_FLIP_CONTRACT_ID"],
      ["randomGenerator", "VITE_RANDOM_GENERATOR_CONTRACT_ID"],
    ];

    const resolved: Partial<ContractAddresses> = {};

    for (const [key, envVar] of required) {
      const value = e[envVar];
      if (!value || value === "C...") {
        throw SorobanClientError.addressNotFound(key);
      }
      resolved[key] = value;
    }

    const registry = new ContractAddressRegistry(resolved as ContractAddresses);
    registry.validate();
    return registry;
  }

  /**
   * Build a registry from a plain object — useful in tests and server-side
   * rendering contexts where `import.meta.env` is unavailable.
   */
  static fromObject(addresses: ContractAddresses): ContractAddressRegistry {
    const registry = new ContractAddressRegistry(addresses);
    registry.validate();
    return registry;
  }

  /**
   * Look up a contract address by name.
   *
   * @throws {SorobanClientError} with code `ContractAddressNotFound` when the
   *   address is missing or is still the placeholder value `"C..."`.
   */
  getAddress(contractName: keyof ContractAddresses): string {
    const addr = this.addresses[contractName];
    if (!addr || addr === "C...") {
      throw SorobanClientError.addressNotFound(contractName);
    }
    return addr;
  }

  /**
   * Validate all stored addresses.
   *
   * Checks that every address is present and matches the Soroban contract
   * address format (56-char, starts with 'C').
   *
   * @throws {SorobanClientError} with code `ContractAddressNotFound` on the
   *   first invalid address found.
   */
  validate(): void {
    for (const [key, addr] of Object.entries(this.addresses)) {
      if (!addr || addr === "C...") {
        throw SorobanClientError.addressNotFound(key);
      }
      if (!isValidContractAddress(addr)) {
        throw SorobanClientError.invalidParam(
          key,
          `"${addr}" is not a valid Soroban contract address (must be 56 chars, start with 'C')`
        );
      }
    }
  }

  /** Returns a shallow copy of all stored addresses (safe to expose in logs). */
  toObject(): Readonly<ContractAddresses> {
    return { ...this.addresses };
  }
}
