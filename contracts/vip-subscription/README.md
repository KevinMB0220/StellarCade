# VIP / Subscription Contract

Manages VIP subscription plans and user subscriptions for the StellarCade platform. Admins create plans with a fixed price, duration, and an off-chain benefits commitment. Users subscribe or renew by paying the plan price; the contract forwards the payment to a treasury address and tracks each user's active subscription state on-chain.

---

## Methods

### `init(admin, treasury_contract)`

Initializes the contract. May only be called once.

| Parameter | Type | Description |
|---|---|---|
| `admin` | `Address` | The address authorized to define plans. Must sign. |
| `treasury_contract` | `Address` | The SEP-41 token contract that acts as the payment destination. |

**Errors:** `AlreadyInitialized`

---

### `define_plan(admin, plan_id, price, duration, benefits_hash)`

Defines a new VIP plan. Admin only.

| Parameter | Type | Description |
|---|---|---|
| `admin` | `Address` | Must match stored admin and sign. |
| `plan_id` | `u32` | Unique plan identifier. |
| `price` | `i128` | Token amount charged per subscription period. Must be > 0. |
| `duration` | `u64` | Subscription period length in seconds. Must be > 0. |
| `benefits_hash` | `BytesN<32>` | SHA-256 hash of the off-chain benefits document. |

**Errors:** `NotInitialized`, `NotAuthorized`, `PlanAlreadyExists`, `InvalidInput`

**Events:** `PlanDefined { plan_id, price, duration, benefits_hash }`

---

### `subscribe(user, plan_id)`

Subscribes `user` to `plan_id`. The user pays the plan price; tokens are transferred from `user` to the treasury contract. Rejected if the user already has a non-expired subscription (use `renew` instead).

| Parameter | Type | Description |
|---|---|---|
| `user` | `Address` | The subscriber. Must sign. |
| `plan_id` | `u32` | Plan to subscribe to. |

**Errors:** `NotInitialized`, `PlanNotFound`, `AlreadySubscribed`

**Events:** `Subscribed { user, plan_id, expires_at, amount_paid }`

**State written:** `Subscription(user) -> SubscriptionRecord { plan_id, expires_at = now + duration }`

---

### `renew(user, plan_id)`

Renews or extends `user`'s subscription. Requires an existing subscription record. If still active, the duration is added to the current `expires_at` (renewals always stack). If already expired, the new expiry is `now + duration`. The plan_id in the record is updated to the renewed plan, allowing cross-plan upgrades.

| Parameter | Type | Description |
|---|---|---|
| `user` | `Address` | The subscriber. Must sign. |
| `plan_id` | `u32` | Plan to renew under (may differ from current plan). |

**Errors:** `NotInitialized`, `PlanNotFound` (no subscription record or unknown plan)

**Events:** `Renewed { user, plan_id, expires_at, amount_paid }`

---

### `status_of(user) -> SubscriptionStatus`

Returns the current subscription status for `user`. Does not require admin or initialization (always safe to query).

```rust
pub struct SubscriptionStatus {
    pub has_subscription: bool, // true if a record exists
    pub plan_id: u32,           // 0 if no subscription
    pub expires_at: u64,        // Unix seconds; 0 if no subscription
    pub is_active: bool,        // true if expires_at > current ledger timestamp
}
```

---

## Events

| Event | Topics | Data | Emitted by |
|---|---|---|---|
| `PlanDefined` | `plan_id` | `price`, `duration`, `benefits_hash` | `define_plan` |
| `Subscribed` | `user`, `plan_id` | `expires_at`, `amount_paid` | `subscribe` |
| `Renewed` | `user`, `plan_id` | `expires_at`, `amount_paid` | `renew` |

---

## Storage

| Key | Tier | Type | TTL Policy |
|---|---|---|---|
| `Admin` | `instance()` | `Address` | Contract lifetime |
| `Treasury` | `instance()` | `Address` | Contract lifetime |
| `Plan(plan_id)` | `persistent()` | `PlanDefinition` | Bumped ~30 days on write |
| `Subscription(user)` | `persistent()` | `SubscriptionRecord` | Bumped ~30 days on every subscribe/renew |

`instance()` keys (Admin, Treasury) share a single ledger entry and TTL — cheap for immutable config. `persistent()` keys are independent ledger entries so per-plan and per-user TTLs do not interfere.

---

## Invariants

1. **Plan immutability** — A `plan_id` can only be defined once. `define_plan` returns `PlanAlreadyExists` on re-use.
2. **No double-subscribe** — `subscribe` rejects a call if `expires_at > now`. Use `renew` to extend an active subscription.
3. **Renewal stacking** — `renew` always extends from the later of `expires_at` or `now`, so back-to-back renewals never lose time.
4. **Payment first** — The token transfer occurs inside the same invocation that writes the subscription record, making the operation atomic.
5. **Reentrancy safety** — No state is written after the external token transfer. The subscription record is written before `TokenClient::transfer` returns, so a panicking token call cannot leave the contract in an inconsistent state.

---

## State Transitions

```
(no record) ──subscribe──▶ Active(expires_at = now + duration)
                                 │
              ──renew──▶ Active(expires_at = old_expires_at + duration)   [if still active]
                                 │
              ──time──▶  Expired (is_active = false, record still present)
                                 │
              ──renew──▶ Active(expires_at = now + duration)              [reactivates from now]
              ──subscribe▶ Active(expires_at = now + duration)            [starts fresh]
```

---

## Security & Validation

- **Role enforcement** — `define_plan` checks the caller matches the stored `admin` via `require_auth()` before any storage write.
- **Input validation** — `price` must be > 0 and `duration` must be > 0; both are rejected early with `InvalidInput`.
- **Overflow protection** — `expires_at` is computed with `u64::checked_add`; failure returns `Error::Overflow`.
- **Idempotency guards** — Duplicate plan definitions and double-subscriptions are rejected with distinct error codes for precise diagnostics.

---

## Integration Assumptions

- **Treasury contract** is a deployed SEP-41 token contract (e.g., USDC Stellar Asset Contract). All subscription payments are forwarded to its address via `TokenClient::transfer`.
- **Dependents (issues #25, #26, #27, #28, #36):** Downstream contracts may call `status_of` to gate VIP-only features. No cross-contract call is required — callers read the status view directly.
- **Off-chain services** listen for `PlanDefined`, `Subscribed`, and `Renewed` events to update user dashboards and apply benefits.
- **Expired subscriptions** remain as storage records (not deleted) so renewal history is auditable and `renew` can reactivate without a fresh `subscribe`.
