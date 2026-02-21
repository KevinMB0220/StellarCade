# Coin Flip Game Contract

A 50/50 betting game integrated with the Random Generator contract for
provably fair outcomes.

## Public Interface

| Function | Description |
|----------|-------------|
| `init(admin, rng_contract, token, min_wager, max_wager, house_edge_bps)` | One-time setup |
| `place_bet(player, side, wager, game_id)` | Player places a bet (0=Heads, 1=Tails) |
| `resolve_bet(game_id)` | Resolve after RNG oracle fulfills the request |
| `get_game(game_id)` | View game state |

## End-to-End Game Flow

```
1. Admin deploys CoinFlip + RandomGenerator contracts
2. Admin calls rng.authorize(coin_flip_address) to whitelist the game
3. Admin calls coin_flip.init(...)

--- Per game ---

4. Player calls place_bet(player, HEADS, 100, game_id)
   → Tokens transfer from player to contract
   → RNG request submitted (request_id = game_id, max = 2)

5. Oracle calls rng.fulfill_random(oracle, game_id, server_seed)
   → Result computed: sha256(seed || id) % 2 → 0 or 1

6. Anyone calls resolve_bet(game_id)
   → Reads RNG result
   → If player's side matches: payout = 2 * wager - fee
   → If not: wager stays in contract (house keeps it)
```

## Settlement

- **Win payout**: `2 * wager - (wager * house_edge_bps / 10000)`
- **Loss**: wager stays in the contract
- House edge is configurable at init (e.g., 250 bps = 2.5%)

Example: 100 token wager at 250 bps edge → win pays 198 tokens.

## Security

- Wager min/max limits enforced
- Invalid side values (anything other than 0 or 1) rejected
- Duplicate game IDs rejected
- Double resolution rejected
- State updated before external token transfers (reentrancy-safe)
- RNG result must be fulfilled before resolution is allowed

## Running Tests

```bash
cd contracts/coin-flip
cargo test
```
