//! Stellarcade Prize Pool Contract
//!
//! Acts as the shared treasury for all game payouts and fee routing.
//! Holds SEP-41 tokens deposited by funders, reserves amounts for active
//! games, and transfers winnings to verified recipients.
//!
//! ## Storage Strategy
//! - `instance()`: Admin, Token address. Small, fixed-size contract config;
//!   all instance keys share one ledger entry and TTL.
//! - `persistent()`: Available, TotalReserved, and per-game Reservation entries.
//!   Each is a separate ledger entry with its own TTL, bumped on every write,
//!   so cost does not scale with total contract state.
//!
//! ## Invariant
//! `available + total_reserved == token.balance(contract_address)` at all
//! times, assuming all token inflows go through `fund`. Any direct transfer
//! to the contract address bypassing `fund` breaks this invariant.
#![no_std]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, Env,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Persistent storage TTL in ledgers (~30 days at 5 s/ledger).
/// Bumped on every write so active game data never expires mid-round.
pub const PERSISTENT_BUMP_LEDGERS: u32 = 518_400;

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized      = 1,
    NotInitialized          = 2,
    NotAuthorized           = 3,
    InvalidAmount           = 4,
    InsufficientFunds       = 5,
    GameAlreadyReserved     = 6,
    ReservationNotFound     = 7,
    PayoutExceedsReservation = 8,
    Overflow                = 9,
}

// ---------------------------------------------------------------------------
// Storage Types
// ---------------------------------------------------------------------------

/// Discriminants for all storage keys.
///
/// Instance keys (Admin, Token): contract config, one ledger entry.
/// Persistent keys (Available, TotalReserved, Reservation): accounting
/// counters and per-game entries, each with their own TTL.
#[contracttype]
pub enum DataKey {
    // --- instance() ---
    Admin,
    Token,
    // --- persistent() ---
    /// Tokens currently available to be reserved for new games.
    Available,
    /// Running sum of all active per-game reservations.
    TotalReserved,
    /// Per-game reservation keyed by game_id.
    Reservation(u64),
}

/// Per-game reservation record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservationData {
    /// Original reserved amount; stored for auditability.
    pub total: i128,
    /// Amount remaining to be paid out or released.
    /// Starts equal to `total`; decremented by `payout` and `release`.
    pub remaining: i128,
}

/// Snapshot of the pool's accounting state returned by `get_pool_state`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolState {
    /// Tokens free to be earmarked for new games.
    pub available: i128,
    /// Tokens currently earmarked across all active reservations.
    pub reserved: i128,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct Funded {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent]
pub struct Reserved {
    #[topic]
    pub game_id: u64,
    pub amount: i128,
}

#[contractevent]
pub struct Released {
    #[topic]
    pub game_id: u64,
    pub amount: i128,
}

#[contractevent]
pub struct PaidOut {
    #[topic]
    pub to: Address,
    #[topic]
    pub game_id: u64,
    pub amount: i128,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct PrizePool;

#[contractimpl]
impl PrizePool {
    // -----------------------------------------------------------------------
    // init
    // -----------------------------------------------------------------------

    /// Initialize the prize pool. May only be called once.
    ///
    /// `token` must be a deployed SEP-41 contract address (e.g., the USDC
    /// Stellar Asset Contract). All `fund` and `payout` operations transfer
    /// tokens through this contract exclusively.
    pub fn init(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);

        // Seed persistent counters so downstream reads never encounter None.
        set_persistent_i128(&env, DataKey::Available, 0);
        set_persistent_i128(&env, DataKey::TotalReserved, 0);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // fund
    // -----------------------------------------------------------------------

    /// Transfer `amount` tokens from `from` into the pool.
    ///
    /// Any address may fund the pool (house top-up, admin, or a game contract
    /// forwarding a player's wager). The caller must sign an auth tree covering
    /// both this invocation and the downstream `token.transfer` sub-call.
    pub fn fund(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        require_initialized(&env)?;

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        from.require_auth();

        let token = get_token(&env);
        TokenClient::new(&env, &token).transfer(&from, env.current_contract_address(), &amount);

        let new_available = get_available(&env)
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        set_persistent_i128(&env, DataKey::Available, new_available);

        Funded { from, amount }.publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // reserve
    // -----------------------------------------------------------------------

    /// Earmark `amount` tokens from the available pool for a specific game.
    ///
    /// Moves `amount` from `available` into a `Reservation(game_id)` entry.
    /// Calling reserve with a `game_id` that already has a reservation returns
    /// `GameAlreadyReserved` — this is the idempotency guard preventing a
    /// buggy game contract from double-drawing from the pool.
    pub fn reserve(
        env: Env,
        admin: Address,
        game_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        require_admin(&env, &admin)?;

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let res_key = DataKey::Reservation(game_id);
        if env.storage().persistent().has(&res_key) {
            return Err(Error::GameAlreadyReserved);
        }

        let available = get_available(&env);
        if amount > available {
            return Err(Error::InsufficientFunds);
        }

        let new_available = available.checked_sub(amount).ok_or(Error::Overflow)?;
        set_persistent_i128(&env, DataKey::Available, new_available);

        let new_total_reserved = get_total_reserved(&env)
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        set_persistent_i128(&env, DataKey::TotalReserved, new_total_reserved);

        let reservation = ReservationData { total: amount, remaining: amount };
        env.storage().persistent().set(&res_key, &reservation);
        env.storage()
            .persistent()
            .extend_ttl(&res_key, PERSISTENT_BUMP_LEDGERS, PERSISTENT_BUMP_LEDGERS);

        Reserved { game_id, amount }.publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // release
    // -----------------------------------------------------------------------

    /// Return `amount` from a game's reservation back to the available pool.
    ///
    /// Used when a game ends with leftover funds (e.g., no winner, partial
    /// payout remainder, or game cancelled). A partial release (`amount <
    /// remaining`) is valid. When `remaining` reaches zero the reservation
    /// entry is removed to avoid stale storage.
    pub fn release(
        env: Env,
        admin: Address,
        game_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        require_admin(&env, &admin)?;

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let res_key = DataKey::Reservation(game_id);
        let mut reservation: ReservationData = env
            .storage()
            .persistent()
            .get(&res_key)
            .ok_or(Error::ReservationNotFound)?;

        if amount > reservation.remaining {
            return Err(Error::PayoutExceedsReservation);
        }

        reservation.remaining = reservation
            .remaining
            .checked_sub(amount)
            .ok_or(Error::Overflow)?;

        let new_available = get_available(&env)
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        set_persistent_i128(&env, DataKey::Available, new_available);

        let new_total_reserved = get_total_reserved(&env)
            .checked_sub(amount)
            .ok_or(Error::Overflow)?;
        set_persistent_i128(&env, DataKey::TotalReserved, new_total_reserved);

        if reservation.remaining == 0 {
            env.storage().persistent().remove(&res_key);
        } else {
            env.storage().persistent().set(&res_key, &reservation);
            env.storage()
                .persistent()
                .extend_ttl(&res_key, PERSISTENT_BUMP_LEDGERS, PERSISTENT_BUMP_LEDGERS);
        }

        Released { game_id, amount }.publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // payout
    // -----------------------------------------------------------------------

    /// Transfer `amount` tokens to `to` from a game's reservation. Admin only.
    ///
    /// Multiple calls against the same `game_id` are permitted (e.g., one call
    /// per winner in a multi-winner game). Each call decrements `remaining`; the
    /// reservation is removed when `remaining` hits zero.
    ///
    /// All accounting state is updated BEFORE the external `token.transfer` to
    /// eliminate reentrancy risk: if the token call panics, state reflects the
    /// attempted debit, preventing a retry from double-paying.
    pub fn payout(
        env: Env,
        admin: Address,
        to: Address,
        game_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        require_admin(&env, &admin)?;

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let res_key = DataKey::Reservation(game_id);
        let mut reservation: ReservationData = env
            .storage()
            .persistent()
            .get(&res_key)
            .ok_or(Error::ReservationNotFound)?;

        if amount > reservation.remaining {
            return Err(Error::PayoutExceedsReservation);
        }

        reservation.remaining = reservation
            .remaining
            .checked_sub(amount)
            .ok_or(Error::Overflow)?;

        let new_total_reserved = get_total_reserved(&env)
            .checked_sub(amount)
            .ok_or(Error::Overflow)?;

        // Update all state before the external token transfer (reentrancy safety).
        set_persistent_i128(&env, DataKey::TotalReserved, new_total_reserved);

        if reservation.remaining == 0 {
            env.storage().persistent().remove(&res_key);
        } else {
            env.storage().persistent().set(&res_key, &reservation);
            env.storage()
                .persistent()
                .extend_ttl(&res_key, PERSISTENT_BUMP_LEDGERS, PERSISTENT_BUMP_LEDGERS);
        }

        let token = get_token(&env);
        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);

        PaidOut { to, game_id, amount }.publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // get_pool_state
    // -----------------------------------------------------------------------

    /// Returns a point-in-time snapshot of the pool's accounting state.
    pub fn get_pool_state(env: Env) -> Result<PoolState, Error> {
        require_initialized(&env)?;
        Ok(PoolState {
            available: get_available(&env),
            reserved: get_total_reserved(&env),
        })
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn require_initialized(env: &Env) -> Result<(), Error> {
    if !env.storage().instance().has(&DataKey::Admin) {
        return Err(Error::NotInitialized);
    }
    Ok(())
}

/// Verify that `caller` is the stored admin and has signed the invocation.
fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    caller.require_auth();
    if caller != &admin {
        return Err(Error::NotAuthorized);
    }
    Ok(())
}

fn get_token(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Token)
        .expect("PrizePool: token not set")
}

fn get_available(env: &Env) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Available)
        .unwrap_or(0)
}

fn get_total_reserved(env: &Env) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::TotalReserved)
        .unwrap_or(0)
}

/// Write an i128 to persistent storage and extend its TTL in one step.
fn set_persistent_i128(env: &Env, key: DataKey, value: i128) {
    env.storage().persistent().set(&key, &value);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_BUMP_LEDGERS, PERSISTENT_BUMP_LEDGERS);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{StellarAssetClient, TokenClient},
        Address, Env,
    };

    // ------------------------------------------------------------------
    // Test helpers
    // ------------------------------------------------------------------

    /// Deploy a fresh token contract and return its address plus an admin client
    /// for minting. The token admin is separate from the prize pool admin so
    /// tests can mint independently of prize pool auth.
    fn create_token<'a>(env: &'a Env, token_admin: &Address) -> (Address, StellarAssetClient<'a>) {
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_client = StellarAssetClient::new(env, &token_contract.address());
        (token_contract.address(), token_client)
    }

    /// Register a PrizePool contract, initialize it, and return the client plus
    /// supporting addresses. Tokens are pre-minted to `funder` for convenience.
    fn setup(
        env: &Env,
    ) -> (
        PrizePoolClient,
        Address, // admin
        Address, // funder
        Address, // token address
    ) {
        let admin = Address::generate(env);
        let funder = Address::generate(env);
        let token_admin = Address::generate(env);

        let (token_addr, token_sac) = create_token(env, &token_admin);

        let contract_id = env.register(PrizePool, ());
        let client = PrizePoolClient::new(env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &token_addr);

        // Give the funder a starting balance to work with.
        token_sac.mint(&funder, &10_000i128);

        (client, admin, funder, token_addr)
    }

    /// Return a `TokenClient` for balance assertions.
    fn token_client<'a>(env: &'a Env, token: &Address) -> TokenClient<'a> {
        TokenClient::new(env, token)
    }

    // ------------------------------------------------------------------
    // 1. Initialize contract once; reject re-init
    // ------------------------------------------------------------------

    #[test]
    fn test_init_rejects_reinit() {
        let env = Env::default();
        let (client, admin, _, token_addr) = setup(&env);
        env.mock_all_auths();

        let result = client.try_init(&admin, &token_addr);
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 2. Fund pool and verify balance update
    // ------------------------------------------------------------------

    #[test]
    fn test_fund_increases_available() {
        let env = Env::default();
        let (client, _, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &1_000i128);

        let state = client.get_pool_state();
        assert_eq!(state.available, 1_000);
        assert_eq!(state.reserved, 0);
    }

    #[test]
    fn test_fund_zero_rejected() {
        let env = Env::default();
        let (client, _, funder, _) = setup(&env);
        env.mock_all_auths();

        let result = client.try_fund(&funder, &0i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_fund_negative_rejected() {
        let env = Env::default();
        let (client, _, funder, _) = setup(&env);
        env.mock_all_auths();

        let result = client.try_fund(&funder, &-1i128);
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 3. Reserve path updates state correctly
    // ------------------------------------------------------------------

    #[test]
    fn test_reserve_moves_available_to_reserved() {
        let env = Env::default();
        let (client, admin, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &1u64, &600i128);

        let state = client.get_pool_state();
        assert_eq!(state.available, 400);
        assert_eq!(state.reserved, 600);
    }

    #[test]
    fn test_reserve_same_game_id_rejected() {
        let env = Env::default();
        let (client, admin, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &42u64, &100i128);

        let result = client.try_reserve(&admin, &42u64, &100i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_reserve_exceeding_available_rejected() {
        let env = Env::default();
        let (client, admin, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &500i128);

        let result = client.try_reserve(&admin, &1u64, &501i128);
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 4. Release path updates state correctly
    // ------------------------------------------------------------------

    #[test]
    fn test_release_returns_funds_to_available() {
        let env = Env::default();
        let (client, admin, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &1u64, &600i128);
        client.release(&admin, &1u64, &600i128);

        let state = client.get_pool_state();
        assert_eq!(state.available, 1_000);
        assert_eq!(state.reserved, 0);
    }

    #[test]
    fn test_partial_release_leaves_reservation() {
        let env = Env::default();
        let (client, admin, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &1u64, &600i128);
        client.release(&admin, &1u64, &200i128); // return 200, leave 400 reserved

        let state = client.get_pool_state();
        assert_eq!(state.available, 600);  // 400 original + 200 released
        assert_eq!(state.reserved, 400);   // 600 - 200
    }

    #[test]
    fn test_release_nonexistent_reservation_rejected() {
        let env = Env::default();
        let (client, admin, _, _) = setup(&env);
        env.mock_all_auths();

        let result = client.try_release(&admin, &99u64, &100i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_release_exceeding_remaining_rejected() {
        let env = Env::default();
        let (client, admin, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &1u64, &500i128);

        let result = client.try_release(&admin, &1u64, &501i128);
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 5. Reject payout above reservation
    // ------------------------------------------------------------------

    #[test]
    fn test_payout_exceeding_reservation_rejected() {
        let env = Env::default();
        let (client, admin, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &1u64, &300i128);

        let winner = Address::generate(&env);
        let result = client.try_payout(&admin, &winner, &1u64, &301i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_payout_nonexistent_reservation_rejected() {
        let env = Env::default();
        let (client, admin, _, _) = setup(&env);
        env.mock_all_auths();

        let winner = Address::generate(&env);
        let result = client.try_payout(&admin, &winner, &99u64, &100i128);
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 6. Happy-path payout transfers tokens and updates state
    // ------------------------------------------------------------------

    #[test]
    fn test_payout_transfers_tokens_to_winner() {
        let env = Env::default();
        let (client, admin, funder, token_addr) = setup(&env);
        env.mock_all_auths();

        let winner = Address::generate(&env);
        let tc = token_client(&env, &token_addr);

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &1u64, &500i128);
        client.payout(&admin, &winner, &1u64, &500i128);

        // Tokens must have moved to the winner.
        assert_eq!(tc.balance(&winner), 500);

        // Reservation is fully consumed; state reflects the debit.
        let state = client.get_pool_state();
        assert_eq!(state.available, 500);
        assert_eq!(state.reserved, 0);
    }

    #[test]
    fn test_multiple_partial_payouts_same_game() {
        let env = Env::default();
        let (client, admin, funder, token_addr) = setup(&env);
        env.mock_all_auths();

        let winner1 = Address::generate(&env);
        let winner2 = Address::generate(&env);
        let tc = token_client(&env, &token_addr);

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &7u64, &600i128);

        // Two winners each receive 300 from the same reservation.
        client.payout(&admin, &winner1, &7u64, &300i128);
        client.payout(&admin, &winner2, &7u64, &300i128);

        assert_eq!(tc.balance(&winner1), 300);
        assert_eq!(tc.balance(&winner2), 300);

        let state = client.get_pool_state();
        assert_eq!(state.available, 400);
        assert_eq!(state.reserved, 0);
    }

    // ------------------------------------------------------------------
    // 7. Unauthorized caller paths fail
    // ------------------------------------------------------------------

    #[test]
    fn test_reserve_by_non_admin_rejected() {
        let env = Env::default();
        let (client, _, funder, _) = setup(&env);
        env.mock_all_auths();

        // funder is not admin
        client.fund(&funder, &1_000i128);
        let result = client.try_reserve(&funder, &1u64, &100i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_payout_by_non_admin_rejected() {
        let env = Env::default();
        let (client, admin, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &1u64, &500i128);

        let winner = Address::generate(&env);
        // funder tries to payout — not admin
        let result = client.try_payout(&funder, &winner, &1u64, &500i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_release_by_non_admin_rejected() {
        let env = Env::default();
        let (client, admin, funder, _) = setup(&env);
        env.mock_all_auths();

        client.fund(&funder, &1_000i128);
        client.reserve(&admin, &1u64, &500i128);

        let result = client.try_release(&funder, &1u64, &500i128);
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 8. get_pool_state requires initialization
    // ------------------------------------------------------------------

    #[test]
    fn test_get_pool_state_before_init_rejected() {
        let env = Env::default();
        let contract_id = env.register(PrizePool, ());
        let client = PrizePoolClient::new(&env, &contract_id);

        let result = client.try_get_pool_state();
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 9. Full lifecycle: fund → reserve → partial payout → release remainder
    // ------------------------------------------------------------------

    #[test]
    fn test_full_lifecycle() {
        let env = Env::default();
        let (client, admin, funder, token_addr) = setup(&env);
        env.mock_all_auths();

        let winner = Address::generate(&env);
        let tc = token_client(&env, &token_addr);

        client.fund(&funder, &2_000i128);

        // Two games; game 1 has a winner, game 2 is cancelled.
        client.reserve(&admin, &1u64, &1_000i128);
        client.reserve(&admin, &2u64, &1_000i128);

        // Game 1: single winner takes the pot.
        client.payout(&admin, &winner, &1u64, &1_000i128);

        // Game 2: cancelled, all funds returned.
        client.release(&admin, &2u64, &1_000i128);

        assert_eq!(tc.balance(&winner), 1_000);

        // Pool should be back to 1_000 available (released game 2 funds).
        let state = client.get_pool_state();
        assert_eq!(state.available, 1_000);
        assert_eq!(state.reserved, 0);
    }
}
