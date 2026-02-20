//! Stellarcade Achievement/Badge Contract
//!
//! Manages the definition, evaluation, and awarding of achievement badges to
//! players on the StellarCade platform. Badges are defined by an admin with a
//! criteria hash (off-chain criteria commitment) and an optional on-chain reward
//! routed through the reward contract. The admin evaluates and awards badges;
//! badge holders are tracked per user.
//!
//! ## Storage Strategy
//! - `instance()`: Admin and RewardContract address. Small, fixed config shared
//!   across all entries in one ledger entry with a single TTL.
//! - `persistent()`: BadgeDefinition per badge_id, UserBadges per user.
//!   Each is a separate ledger entry with its own TTL, bumped on every write.
//!
//! ## Invariants
//! - A badge_id can only be defined once (`define_badge` is idempotent-guarded).
//! - A user can only hold each badge once (duplicate awards are rejected).
//! - `award_badge` requires the badge to be defined and the user not to already
//!   hold it, in that order, with no TOCTOU gap.
#![no_std]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, vec, Address, BytesN, Env,
    Vec,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Persistent storage TTL in ledgers (~30 days at 5 s/ledger).
/// Bumped on every write so badge and user data never expire.
pub const PERSISTENT_BUMP_LEDGERS: u32 = 518_400;

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    NotAuthorized      = 3,
    BadgeNotFound      = 4,
    BadgeAlreadyExists = 5,
    BadgeAlreadyAwarded = 6,
    InvalidInput       = 7,
}

// ---------------------------------------------------------------------------
// Storage Types
// ---------------------------------------------------------------------------

/// Discriminants for all storage keys.
///
/// Instance keys (Admin, RewardContract): contract config, one ledger entry.
/// Persistent keys (Badge, UserBadges): per-badge definitions and per-user
/// badge lists, each with their own TTL.
#[contracttype]
pub enum DataKey {
    // --- instance() ---
    Admin,
    RewardContract,
    // --- persistent() ---
    /// Badge definition keyed by badge_id (u64).
    Badge(u64),
    /// List of badge_ids awarded to a user, keyed by user Address.
    UserBadges(Address),
}

/// Definition of a badge, stored on-chain.
///
/// `criteria_hash` is a 32-byte SHA-256 hash of the off-chain criteria
/// document, providing a tamper-evident commitment without on-chain verbosity.
/// `reward` is an optional i128 amount to disburse via the reward contract
/// when the badge is awarded; 0 means no reward.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BadgeDefinition {
    /// SHA-256 hash of the off-chain criteria specification (32 bytes).
    pub criteria_hash: BytesN<32>,
    /// Token amount paid via `reward_contract` when badge is awarded. 0 = none.
    pub reward: i128,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct BadgeDefined {
    #[topic]
    pub badge_id: u64,
    pub criteria_hash: BytesN<32>,
    pub reward: i128,
}

#[contractevent]
pub struct UserEvaluated {
    #[topic]
    pub user: Address,
    #[topic]
    pub badge_id: u64,
}

#[contractevent]
pub struct BadgeAwarded {
    #[topic]
    pub user: Address,
    #[topic]
    pub badge_id: u64,
    pub reward: i128,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct AchievementBadge;

#[contractimpl]
impl AchievementBadge {
    // -----------------------------------------------------------------------
    // init
    // -----------------------------------------------------------------------

    /// Initialize the contract. May only be called once.
    ///
    /// `admin` is the only address authorized to define badges, evaluate users,
    /// and award badges. `reward_contract` is the address of the downstream
    /// contract that handles token payouts (e.g., PrizePool). It is stored for
    /// future integration but is not called directly in this contract.
    pub fn init(env: Env, admin: Address, reward_contract: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RewardContract, &reward_contract);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // define_badge
    // -----------------------------------------------------------------------

    /// Define a new achievement badge. Admin only.
    ///
    /// `badge_id` must be unique; re-defining an existing badge returns
    /// `BadgeAlreadyExists`. `criteria_hash` is the 32-byte SHA-256 hash of
    /// the off-chain criteria document. `reward` is the token amount awarded
    /// through the reward contract on badge issuance; use 0 for no reward.
    pub fn define_badge(
        env: Env,
        admin: Address,
        badge_id: u64,
        criteria_hash: BytesN<32>,
        reward: i128,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        require_admin(&env, &admin)?;

        if reward < 0 {
            return Err(Error::InvalidInput);
        }

        let key = DataKey::Badge(badge_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::BadgeAlreadyExists);
        }

        let definition = BadgeDefinition {
            criteria_hash: criteria_hash.clone(),
            reward,
        };
        env.storage().persistent().set(&key, &definition);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_BUMP_LEDGERS, PERSISTENT_BUMP_LEDGERS);

        BadgeDefined {
            badge_id,
            criteria_hash,
            reward,
        }
        .publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // evaluate_user
    // -----------------------------------------------------------------------

    /// Signal that a user has been evaluated against a badge's criteria.
    /// Admin only.
    ///
    /// This is an administrative action that emits an auditable event. It does
    /// not award the badge; call `award_badge` separately if the evaluation
    /// determines the user qualifies. The badge must exist.
    pub fn evaluate_user(env: Env, admin: Address, user: Address, badge_id: u64) -> Result<(), Error> {
        require_initialized(&env)?;
        require_admin(&env, &admin)?;

        // Badge must exist before an evaluation can be recorded.
        require_badge_exists(&env, badge_id)?;

        UserEvaluated {
            user,
            badge_id,
        }
        .publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // award_badge
    // -----------------------------------------------------------------------

    /// Award `badge_id` to `user`. Admin only.
    ///
    /// The badge must be defined. Each badge can only be awarded once per user;
    /// duplicate awards return `BadgeAlreadyAwarded`. The badge is appended to
    /// the user's persistent badge list, which is created on first award.
    ///
    /// If `badge.reward > 0`, a `BadgeAwarded` event is emitted with the
    /// reward amount so off-chain services can trigger the downstream payout
    /// via the reward contract.
    pub fn award_badge(env: Env, admin: Address, user: Address, badge_id: u64) -> Result<(), Error> {
        require_initialized(&env)?;
        require_admin(&env, &admin)?;

        let badge = require_badge_exists(&env, badge_id)?;

        // Guard against duplicate awards.
        let user_key = DataKey::UserBadges(user.clone());
        let mut badges: Vec<u64> = env
            .storage()
            .persistent()
            .get(&user_key)
            .unwrap_or_else(|| vec![&env]);

        for i in 0..badges.len() {
            if badges.get(i).unwrap() == badge_id {
                return Err(Error::BadgeAlreadyAwarded);
            }
        }

        badges.push_back(badge_id);
        env.storage().persistent().set(&user_key, &badges);
        env.storage()
            .persistent()
            .extend_ttl(&user_key, PERSISTENT_BUMP_LEDGERS, PERSISTENT_BUMP_LEDGERS);

        BadgeAwarded {
            user,
            badge_id,
            reward: badge.reward,
        }
        .publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // badges_of
    // -----------------------------------------------------------------------

    /// Return the list of badge IDs awarded to `user`.
    ///
    /// Returns an empty list if the user has not been awarded any badges.
    /// Does not require initialization — a user with no badges trivially has
    /// an empty list regardless of contract state.
    pub fn badges_of(env: Env, user: Address) -> Vec<u64> {
        let user_key = DataKey::UserBadges(user);
        env.storage()
            .persistent()
            .get(&user_key)
            .unwrap_or_else(|| vec![&env])
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

/// Fetch the badge definition or return `BadgeNotFound`.
fn require_badge_exists(env: &Env, badge_id: u64) -> Result<BadgeDefinition, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Badge(badge_id))
        .ok_or(Error::BadgeNotFound)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

    // ------------------------------------------------------------------
    // Test helpers
    // ------------------------------------------------------------------

    fn make_hash(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    fn setup(env: &Env) -> (AchievementBadgeClient<'_>, Address, Address) {
        let admin = Address::generate(env);
        let reward_contract = Address::generate(env);

        let contract_id = env.register(AchievementBadge, ());
        let client = AchievementBadgeClient::new(env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &reward_contract);

        (client, admin, reward_contract)
    }

    // ------------------------------------------------------------------
    // 1. init
    // ------------------------------------------------------------------

    #[test]
    fn test_init_rejects_reinit() {
        let env = Env::default();
        let (client, admin, reward_contract) = setup(&env);
        env.mock_all_auths();

        let result = client.try_init(&admin, &reward_contract);
        assert!(result.is_err());
    }

    #[test]
    fn test_uninit_privileged_calls_rejected() {
        let env = Env::default();
        let contract_id = env.register(AchievementBadge, ());
        let client = AchievementBadgeClient::new(&env, &contract_id);
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let hash = make_hash(&env, 1);

        assert!(client.try_define_badge(&admin, &1u64, &hash, &0i128).is_err());
        assert!(client.try_evaluate_user(&admin, &user, &1u64).is_err());
        assert!(client.try_award_badge(&admin, &user, &1u64).is_err());
    }

    // ------------------------------------------------------------------
    // 2. define_badge
    // ------------------------------------------------------------------

    #[test]
    fn test_define_badge_success() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 42);
        client.define_badge(&admin, &1u64, &hash, &500i128);
        // No panic = success
    }

    #[test]
    fn test_define_badge_duplicate_rejected() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 1);
        client.define_badge(&admin, &10u64, &hash, &0i128);

        let result = client.try_define_badge(&admin, &10u64, &hash, &0i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_define_badge_negative_reward_rejected() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 2);
        let result = client.try_define_badge(&admin, &1u64, &hash, &-1i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_define_badge_non_admin_rejected() {
        let env = Env::default();
        let (client, _, _) = setup(&env);
        env.mock_all_auths();

        let non_admin = Address::generate(&env);
        let hash = make_hash(&env, 3);
        let result = client.try_define_badge(&non_admin, &1u64, &hash, &0i128);
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 3. evaluate_user
    // ------------------------------------------------------------------

    #[test]
    fn test_evaluate_user_success() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 5);
        client.define_badge(&admin, &1u64, &hash, &0i128);

        let user = Address::generate(&env);
        client.evaluate_user(&admin, &user, &1u64);
        // No panic = success
    }

    #[test]
    fn test_evaluate_user_undefined_badge_rejected() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let user = Address::generate(&env);
        // badge 999 not defined
        let result = client.try_evaluate_user(&admin, &user, &999u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_evaluate_user_non_admin_rejected() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 6);
        client.define_badge(&admin, &1u64, &hash, &0i128);

        let non_admin = Address::generate(&env);
        let user = Address::generate(&env);
        let result = client.try_evaluate_user(&non_admin, &user, &1u64);
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 4. award_badge
    // ------------------------------------------------------------------

    #[test]
    fn test_award_badge_success() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 7);
        client.define_badge(&admin, &1u64, &hash, &100i128);

        let user = Address::generate(&env);
        client.award_badge(&admin, &user, &1u64);

        let badges = client.badges_of(&user);
        assert_eq!(badges.len(), 1);
        assert_eq!(badges.get(0).unwrap(), 1u64);
    }

    #[test]
    fn test_award_badge_undefined_badge_rejected() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let user = Address::generate(&env);
        let result = client.try_award_badge(&admin, &user, &999u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_award_badge_duplicate_rejected() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 8);
        client.define_badge(&admin, &1u64, &hash, &0i128);

        let user = Address::generate(&env);
        client.award_badge(&admin, &user, &1u64);

        let result = client.try_award_badge(&admin, &user, &1u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_award_badge_non_admin_rejected() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 9);
        client.define_badge(&admin, &2u64, &hash, &0i128);

        let non_admin = Address::generate(&env);
        let user = Address::generate(&env);
        let result = client.try_award_badge(&non_admin, &user, &2u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_award_multiple_badges_to_same_user() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let user = Address::generate(&env);

        for id in 1u64..=3 {
            let hash = make_hash(&env, id as u8);
            client.define_badge(&admin, &id, &hash, &0i128);
            client.award_badge(&admin, &user, &id);
        }

        let badges = client.badges_of(&user);
        assert_eq!(badges.len(), 3);
        assert_eq!(badges.get(0).unwrap(), 1u64);
        assert_eq!(badges.get(1).unwrap(), 2u64);
        assert_eq!(badges.get(2).unwrap(), 3u64);
    }

    #[test]
    fn test_same_badge_different_users() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 10);
        client.define_badge(&admin, &1u64, &hash, &50i128);

        let user_a = Address::generate(&env);
        let user_b = Address::generate(&env);

        client.award_badge(&admin, &user_a, &1u64);
        client.award_badge(&admin, &user_b, &1u64);

        assert_eq!(client.badges_of(&user_a).len(), 1);
        assert_eq!(client.badges_of(&user_b).len(), 1);
    }

    // ------------------------------------------------------------------
    // 5. badges_of
    // ------------------------------------------------------------------

    #[test]
    fn test_badges_of_returns_empty_for_new_user() {
        let env = Env::default();
        let (client, _, _) = setup(&env);

        let user = Address::generate(&env);
        let badges = client.badges_of(&user);
        assert_eq!(badges.len(), 0);
    }

    // ------------------------------------------------------------------
    // 6. Full lifecycle
    // ------------------------------------------------------------------

    #[test]
    fn test_full_lifecycle() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);
        env.mock_all_auths();

        let user = Address::generate(&env);

        // Define two badges.
        client.define_badge(&admin, &1u64, &make_hash(&env, 11), &200i128);
        client.define_badge(&admin, &2u64, &make_hash(&env, 12), &0i128);

        // Evaluate user against badge 1 (just auditing).
        client.evaluate_user(&admin, &user, &1u64);

        // Award badge 1.
        client.award_badge(&admin, &user, &1u64);

        // Evaluate and award badge 2.
        client.evaluate_user(&admin, &user, &2u64);
        client.award_badge(&admin, &user, &2u64);

        let badges = client.badges_of(&user);
        assert_eq!(badges.len(), 2);
        assert_eq!(badges.get(0).unwrap(), 1u64);
        assert_eq!(badges.get(1).unwrap(), 2u64);

        // Duplicate award must fail.
        assert!(client.try_award_badge(&admin, &user, &1u64).is_err());
    }
}
