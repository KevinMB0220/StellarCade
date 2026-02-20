# Prize Pool Contract

The Prize Pool is the shared treasury for Stellarcade. It holds SEP-41 tokens on behalf of game rounds, provides a reservation layer so funds are never double-spent, and issues payouts to verified winners. All other game contracts depend on this contract for settlement.

---

## Methods

### `init(admin: Address, token: Address) -> Result<(), Error>`

Initializes the contract. May only be called once; subsequent calls return `AlreadyInitialized`.

- `admin` — the address that controls privileged operations (`reserve`, `release`, `payout`). Must sign the transaction.
- `token` — a deployed SEP-41 token contract address (e.g., a Stellar Asset Contract). All fund and payout operations use this token exclusively.

---

### `fund(from: Address, amount: i128) -> Result<(), Error>`

Transfers `amount` tokens from `from` into the pool.

Any address may fund the pool (platform, admin, or a game contract forwarding a player's wager). `from` must sign an auth tree that covers both this invocation and the downstream `token.transfer` sub-call.

- Increments `available` by `amount`.
- Rejects `amount <= 0`.
- Emits: `Funded { from, amount }`.

---

### `reserve(admin: Address, game_id: u64, amount: i128) -> Result<(), Error>`

Earmarks `amount` tokens for a specific game. Admin only.

- Moves `amount` from `available` to a `Reservation(game_id)` entry.
- Returns `GameAlreadyReserved` if `game_id` already has a reservation (idempotency guard).
- Returns `InsufficientFunds` if `amount > available`.
- Emits: `Reserved { game_id, amount }`.

---

### `release(admin: Address, game_id: u64, amount: i128) -> Result<(), Error>`

Returns `amount` from a game's reservation back to the available pool. Admin only.

Used when a game ends without a winner, is cancelled, or has leftover funds after partial payouts. A partial release (`amount < remaining`) is valid and leaves the reservation active with the reduced balance.

- Returns `ReservationNotFound` if no reservation exists for `game_id`.
- Returns `PayoutExceedsReservation` if `amount > reservation.remaining`.
- Removes the reservation entry when `remaining` reaches zero.
- Emits: `Released { game_id, amount }`.

---

### `payout(admin: Address, to: Address, game_id: u64, amount: i128) -> Result<(), Error>`

Transfers `amount` tokens from a game's reservation to `to`. Admin only.

Multiple calls against the same `game_id` are permitted — this is required for multi-winner games where each winner claims separately. Each call decrements the reservation's `remaining`; the entry is removed when `remaining` hits zero.

- Returns `ReservationNotFound` if no reservation exists for `game_id`.
- Returns `PayoutExceedsReservation` if `amount > reservation.remaining`.
- All accounting state is updated **before** the external `token.transfer` call (reentrancy safety).
- Emits: `PaidOut { to, game_id, amount }`.

---

### `get_pool_state(env: Env) -> Result<PoolState, Error>`

Returns a snapshot of the pool's accounting state.

```rust
pub struct PoolState {
    pub available: i128, // tokens free to be reserved
    pub reserved:  i128, // tokens earmarked across all active games
}
```

Requires the contract to be initialized. No cross-contract calls — reads purely from this contract's persistent storage.

---

## Events

| Event | Topics | Data |
|---|---|---|
| `Funded` | `from: Address` | `amount: i128` |
| `Reserved` | `game_id: u64` | `amount: i128` |
| `Released` | `game_id: u64` | `amount: i128` |
| `PaidOut` | `to: Address`, `game_id: u64` | `amount: i128` |

---

## Error Codes

| Code | Value | Meaning |
|---|---|---|
| `AlreadyInitialized` | 1 | `init` called more than once |
| `NotInitialized` | 2 | Contract not initialized |
| `NotAuthorized` | 3 | Caller is not the admin |
| `InvalidAmount` | 4 | `amount <= 0` |
| `InsufficientFunds` | 5 | `available < amount` for a reserve |
| `GameAlreadyReserved` | 6 | `game_id` already has an active reservation |
| `ReservationNotFound` | 7 | No reservation exists for `game_id` |
| `PayoutExceedsReservation` | 8 | `amount > reservation.remaining` |
| `Overflow` | 9 | Arithmetic overflow in checked operation |

---

## Invariants

- `available + total_reserved == token.balance(contract_address)` at all times, assuming all token inflows go through `fund`. Direct transfers to the contract address bypassing `fund` will break this accounting.
- A `game_id` may only be reserved once. Once the reservation's `remaining` reaches zero (via payout or release), the entry is removed and the same `game_id` **cannot** be re-reserved.
- `payout + release` amounts against a single reservation can never exceed the originally reserved `total`.

---

## Storage

| Key | Storage Type | Description |
|---|---|---|
| `Admin` | `instance()` | Admin address |
| `Token` | `instance()` | SEP-41 token contract address |
| `Available` | `persistent()` | Running available balance |
| `TotalReserved` | `persistent()` | Sum of all active reservation amounts |
| `Reservation(game_id)` | `persistent()` | Per-game `ReservationData { total, remaining }` |

All persistent entries have their TTL bumped to ~30 days (`518_400` ledgers at 5 s/ledger) on every write.

---

## Integration Pattern for Game Contracts

```
Game round lifecycle:
  1. admin → prize_pool.fund(house_wallet, seed_amount)   # optional top-up
  2. player → prize_pool.fund(player, wager)              # player places wager
  3. admin → prize_pool.reserve(admin, game_id, wager)    # earmark for this game
  4a. [winner] admin → prize_pool.payout(admin, winner, game_id, reward)
  4b. [no winner / leftover] admin → prize_pool.release(admin, game_id, leftover)
```

Game contracts are expected to compute the winner and reward amount off-chain or within their own contract logic, then invoke `payout` as a final settlement step.

---

## Building and Testing

```bash
# From contracts/prize-pool/
cargo build --target wasm32-unknown-unknown --release
cargo test
cargo clippy -- -D warnings
cargo fmt
```
