# Stellarcade Smart Contracts

This folder contains the Soroban smart contracts for the Stellarcade platform.

## 📂 Structure

- `prize-pool/`: Manages user deposits, platform fees, and prize distributions.
- `random-generator/`: A provably fair RNG contract.
- `coin-flip/`: Logic for the classic head-or-tails game.
- `daily-trivia/`: One-attempt-per-round trivia game with reward settlement.
- `shared/`: Common types and utilities used across all contracts.

## 🛠 Prerequisites

- [Rust](https://www.rust-lang.org/)
- [Soroban CLI](https://soroban.stellar.org/docs/getting-started/setup)
- Target `wasm32-unknown-unknown`

## 🚀 Building & Testing

Building all contracts:

```bash
soroban contract build
```

Running tests for a specific contract:

```bash
cd prize-pool
cargo test
```

## 🔐 Security Considerations

- All contracts utilize the Soroban SDK's built-in authorization framework.
- Avoid large recursive calls and minimize storage footprints.
- Ensure all arithmetic operations are safe from overflows.

---

_For more details, see the README in each contract subdirectory._
