# Streak Bonus Contract

Tracks user activity streaks and allows claiming bonuses when streak thresholds are met. Admin configures reward contract and rules; users (or admin) record activity; users claim bonuses.

## Methods

| Method | Description | Authorization |
|--------|-------------|---------------|
| `init(admin, reward_contract)` | Initialize. Call once. | `admin` (require_auth) |
| `record_activity(caller, user, activity_type, ts)` | Record an activity; updates streak. | `caller` = user (self) or admin |
| `current_streak(user)` | Return current streak count. | Anyone (view) |
| `claim_streak_bonus(user)` | Claim bonus for current streak. | `user` (require_auth) |
| `reset_rules(admin, config)` | Update streak rules. | Admin only |

## Storage

- **Instance:** `Admin`, `RewardContract`, `Rules` (StreakRules), `UserData(Address)` → UserStreakData.
- **UserStreakData:** `last_activity_ts`, `current_streak`, `last_claimed_streak`.
- **StreakRules:** `min_streak_to_claim`, `reward_per_streak`, `streak_window_secs`.

## Events

- `Initialized { admin, reward_contract }`
- `ActivityRecorded { user, activity_type, ts, new_streak }`
- `StreakBonusClaimed { user, streak, amount }`
- `RulesReset { min_streak_to_claim, reward_per_streak, streak_window_secs }`

## Invariants

- Streak increments when activities are within `streak_window_secs`; otherwise resets to 1.
- User can only claim when `current_streak >= min_streak_to_claim` and `current_streak > last_claimed_streak`.
- After claim, `last_claimed_streak` is set to current streak (no double claim for same streak).
- `reset_rules` rejects `streak_window_secs == 0`.

## Integration

- Depends on a **reward contract** address (e.g. treasury or token contract) for disbursement; actual transfer can be done off-chain or via a separate disbursement contract that reacts to `StreakBonusClaimed` events.
- Can integrate with cross-contract handler (#25) and other platform contracts for stable flows.
