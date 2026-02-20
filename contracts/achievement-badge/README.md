# Achievement/Badge Contract

Manages the definition, evaluation, and awarding of achievement badges to
players on the StellarCade platform.

## Overview

Badges represent accomplishments earned by players. Each badge has an off-chain
criteria document committed to on-chain as a SHA-256 hash, and an optional token
reward amount paid via the reward contract when the badge is awarded.

Only the admin may define badges, evaluate users, or award badges. Badge
holdings are tracked per user in persistent storage.

## Methods

### `init(admin: Address, reward_contract: Address) → Result<(), Error>`

Initialize the contract. May only be called once.

- `admin` — the address authorized to perform all privileged operations.
- `reward_contract` — the address of the downstream payout contract (e.g.
  PrizePool). Stored for integration; not called directly by this contract.

Emits no event. Returns `AlreadyInitialized` if called more than once.

---

### `define_badge(admin, badge_id, criteria_hash, reward) → Result<(), Error>`

Define a new badge. Admin only.

- `badge_id: u64` — unique identifier for this badge.
- `criteria_hash: BytesN<32>` — SHA-256 hash of the off-chain criteria document.
- `reward: i128` — token amount emitted in `BadgeAwarded` for downstream payout.
  Use `0` for no reward.

Returns `BadgeAlreadyExists` if `badge_id` is already defined.
Returns `InvalidInput` if `reward < 0`.

**Event:** `BadgeDefined { badge_id, criteria_hash, reward }`

---

### `evaluate_user(admin, user, badge_id) → Result<(), Error>`

Record that `user` has been evaluated against `badge_id`'s criteria. Admin only.

This is a pure audit step — it does not award the badge. The badge must exist.
Call `award_badge` separately once the evaluation confirms qualification.

Returns `BadgeNotFound` if `badge_id` is not defined.

**Event:** `UserEvaluated { user, badge_id }`

---

### `award_badge(admin, user, badge_id) → Result<(), Error>`

Award `badge_id` to `user`. Admin only.

- The badge must be defined.
- Each badge can only be awarded once per user.
- The badge is appended to the user's persistent badge list.

Returns `BadgeNotFound` if the badge is undefined.
Returns `BadgeAlreadyAwarded` if the user already holds this badge.

**Event:** `BadgeAwarded { user, badge_id, reward }`

If `reward > 0`, off-chain services should trigger a payout through
`reward_contract` using the emitted reward amount.

---

### `badges_of(user: Address) → Vec<u64>`

Return the list of badge IDs awarded to `user` in award order. Returns an
empty list if the user has no badges. Does not require initialization.

---

## Events

| Event | Topics | Data | Description |
|-------|--------|------|-------------|
| `BadgeDefined` | `badge_id` | `criteria_hash`, `reward` | New badge created |
| `UserEvaluated` | `user`, `badge_id` | — | User evaluated against badge criteria |
| `BadgeAwarded` | `user`, `badge_id` | `reward` | Badge granted to user |

---

## Storage

| Key | Kind | Type | Description |
|-----|------|------|-------------|
| `Admin` | instance | `Address` | Contract administrator |
| `RewardContract` | instance | `Address` | Downstream payout contract |
| `Badge(badge_id)` | persistent | `BadgeDefinition` | Badge definition |
| `UserBadges(user)` | persistent | `Vec<u64>` | Badge IDs held by user |

Persistent entries have their TTL bumped to `518_400` ledgers (~30 days) on
every write, so active data never expires.

---

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 1 | `AlreadyInitialized` | `init` called more than once |
| 2 | `NotInitialized` | Privileged method called before `init` |
| 3 | `NotAuthorized` | Caller is not the stored admin |
| 4 | `BadgeNotFound` | `badge_id` does not exist |
| 5 | `BadgeAlreadyExists` | `badge_id` already defined |
| 6 | `BadgeAlreadyAwarded` | User already holds this badge |
| 7 | `InvalidInput` | Negative reward or other invalid parameter |

---

## Invariants

1. `Admin` and `RewardContract` are set exactly once on `init`.
2. Each `badge_id` maps to at most one `BadgeDefinition` (no re-definition).
3. Each `(user, badge_id)` pair is recorded at most once in `UserBadges`.
4. `reward >= 0` for all stored `BadgeDefinition` entries.

---

## Integration Assumptions

- **Off-chain reward disbursement**: When `BadgeAwarded` with `reward > 0` is
  observed, an off-chain service or game orchestrator must call the
  `reward_contract` (e.g., `PrizePool.payout`) to transfer tokens to the user.
  This contract stores the `reward_contract` address for reference but does not
  call it directly, keeping cross-contract surface minimal.
- **Criteria documents**: The `criteria_hash` field commits to an off-chain
  document. Consumers must independently store and publish the full criteria;
  this contract only guarantees tamper-evidence via the hash.
- **Admin key management**: A single admin key controls all privileged
  operations. Dependent services should plan for admin rotation by deploying a
  multi-sig or governance contract as the admin address.
- **Depends on**: Issues #25, #26, #27, #28, #36 for stable integration with
  the broader StellarCade platform.
