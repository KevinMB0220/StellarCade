# Random Generator Contract

## Overview

This contract ensures that all game outcomes on Stellarcade are provably fair and verifiable by the player.

## How it Works

We use a commit-reveal scheme:

1. **Request**: The player provides a "Client Seed" when starting a game.
2. **Commit**: The contract combines the Client Seed with a secret "Server Seed" and a "Nonce".
3. **Outcome**: The hash of these values determines the game result.
4. **Reveal**: The Server Seed is revealed after the game, allowing the player to verify the hash matches.

## Functions

### `generate_random(...)`

Produces a verifiable 32-byte hash.

### `verify_fairness(...)`

Allows anyone to re-calculate and verify a past result.
