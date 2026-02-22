//! Stellarcade VIP/Subscription Contract
//!
//! Manages VIP subscription plans and user subscriptions on the StellarCade
//! platform. Admins define plans with a price, duration, and benefits hash.
//! Users subscribe or renew by paying via a treasury contract. The contract
//! tracks per-user subscription state and expiry.
//!
//! ## Storage Strategy
//! - `instance()`: Admin and TreasuryContract address. Small, fixed config
//!   shared across all entries in one ledger entry with a single TTL.
//! - `persistent()`: PlanDefinition per plan_id, SubscriptionRecord per user.
//!   Each is a separate ledger entry with its own TTL, bumped on every write.
//!
//! ## State Machine
//! A user subscription transitions as follows:
//!
//!   (none) --subscribe--> Active(expires_at)
//!   Active  --renew-->    Active(expires_at + duration)   [extends from now or expiry, whichever is later]
//!   Active  --time passes-> Expired (status reflects ledger timestamp)
//!
//! Renewal on an expired subscription reactivates it from `current_time + duration`.
//!
//! ## Invariants
//! - A plan_id can only be defined once (`define_plan` is idempotent-guarded).
//! - `subscribe` is rejected if the user already has an active or future subscription
//!   for that plan (use `renew` to extend).
//! - Arithmetic on timestamps uses `checked_add` to guard against overflow.
#![no_std]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, BytesN, Env,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Persistent storage TTL in ledgers (~30 days at 5 s/ledger).
/// Bumped on every write so plan and subscription data never expire.
pub const PERSISTENT_BUMP_LEDGERS: u32 = 518_400;

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAuthorized = 3,
    PlanNotFound = 4,
    PlanAlreadyExists = 5,
    AlreadySubscribed = 6,
    InvalidInput = 7,
    Overflow = 8,
}

// ---------------------------------------------------------------------------
// Storage Types
// ---------------------------------------------------------------------------

/// Discriminants for all storage keys.
///
/// Instance keys (Admin, Treasury): contract config, one ledger entry.
/// Persistent keys (Plan, Subscription): per-plan definitions and per-user
/// subscription records, each with their own TTL.
#[contracttype]
pub enum DataKey {
    // --- instance() ---
    Admin,
    Treasury,
    // --- persistent() ---
    /// Plan definition keyed by plan_id (u32).
    Plan(u32),
    /// Subscription record keyed by user Address.
    Subscription(Address),
}

/// Definition of a VIP subscription plan.
///
/// `benefits_hash` is a 32-byte SHA-256 hash of the off-chain benefits
/// document, providing a tamper-evident commitment without on-chain verbosity.
/// `price` is the token amount charged per subscription period.
/// `duration` is the subscription length in seconds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanDefinition {
    /// Token amount charged when subscribing or renewing.
    pub price: i128,
    /// Duration of one subscription period in seconds.
    pub duration: u64,
    /// SHA-256 hash of the off-chain benefits specification (32 bytes).
    pub benefits_hash: BytesN<32>,
}

/// Per-user subscription record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionRecord {
    /// The plan this subscription is for.
    pub plan_id: u32,
    /// Unix timestamp (seconds) at which this subscription expires.
    pub expires_at: u64,
}

/// Public view of a user's subscription status.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionStatus {
    /// Whether the user currently has a subscription record.
    pub has_subscription: bool,
    /// The plan_id if subscribed, or 0 if none.
    pub plan_id: u32,
    /// Expiry timestamp in seconds. 0 if not subscribed.
    pub expires_at: u64,
    /// Whether the subscription is currently active (not expired).
    pub is_active: bool,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct PlanDefined {
    #[topic]
    pub plan_id: u32,
    pub price: i128,
    pub duration: u64,
    pub benefits_hash: BytesN<32>,
}

#[contractevent]
pub struct Subscribed {
    #[topic]
    pub user: Address,
    #[topic]
    pub plan_id: u32,
    pub expires_at: u64,
    pub amount_paid: i128,
}

#[contractevent]
pub struct Renewed {
    #[topic]
    pub user: Address,
    #[topic]
    pub plan_id: u32,
    pub expires_at: u64,
    pub amount_paid: i128,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct VipSubscription;

#[contractimpl]
impl VipSubscription {
    // -----------------------------------------------------------------------
    // init
    // -----------------------------------------------------------------------

    /// Initialize the contract. May only be called once.
    ///
    /// `admin` is the only address authorized to define plans.
    /// `treasury_contract` is the address that receives subscription payments.
    pub fn init(env: Env, admin: Address, treasury_contract: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Treasury, &treasury_contract);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // define_plan
    // -----------------------------------------------------------------------

    /// Define a new VIP subscription plan. Admin only.
    ///
    /// `plan_id` must be unique; re-defining an existing plan returns
    /// `PlanAlreadyExists`. `price` must be positive. `duration` must be
    /// positive (in seconds). `benefits_hash` is the 32-byte SHA-256 hash of
    /// the off-chain benefits document.
    pub fn define_plan(
        env: Env,
        admin: Address,
        plan_id: u32,
        price: i128,
        duration: u64,
        benefits_hash: BytesN<32>,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        require_admin(&env, &admin)?;

        if price <= 0 {
            return Err(Error::InvalidInput);
        }
        if duration == 0 {
            return Err(Error::InvalidInput);
        }

        let key = DataKey::Plan(plan_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::PlanAlreadyExists);
        }

        let plan = PlanDefinition {
            price,
            duration,
            benefits_hash: benefits_hash.clone(),
        };
        env.storage().persistent().set(&key, &plan);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_BUMP_LEDGERS,
            PERSISTENT_BUMP_LEDGERS,
        );

        PlanDefined {
            plan_id,
            price,
            duration,
            benefits_hash,
        }
        .publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // subscribe
    // -----------------------------------------------------------------------

    /// Subscribe `user` to `plan_id`. The user pays the plan price via the
    /// treasury contract.
    ///
    /// Rejected if the user already has an active (non-expired) subscription.
    /// Use `renew` to extend an active subscription. A user whose subscription
    /// has already expired may call `subscribe` again to start fresh.
    pub fn subscribe(env: Env, user: Address, plan_id: u32) -> Result<(), Error> {
        require_initialized(&env)?;

        user.require_auth();

        let plan = require_plan_exists(&env, plan_id)?;

        // Reject if the user already has a non-expired subscription.
        let sub_key = DataKey::Subscription(user.clone());
        if let Some(existing) = get_subscription(&env, &sub_key) {
            let now = env.ledger().timestamp();
            if existing.expires_at > now {
                return Err(Error::AlreadySubscribed);
            }
        }

        // Charge the user by transferring tokens to the treasury.
        let treasury = get_treasury(&env);
        TokenClient::new(&env, &treasury).transfer(&user, &treasury, &plan.price);

        let now = env.ledger().timestamp();
        let expires_at = now.checked_add(plan.duration).ok_or(Error::Overflow)?;

        let record = SubscriptionRecord {
            plan_id,
            expires_at,
        };
        env.storage().persistent().set(&sub_key, &record);
        env.storage().persistent().extend_ttl(
            &sub_key,
            PERSISTENT_BUMP_LEDGERS,
            PERSISTENT_BUMP_LEDGERS,
        );

        Subscribed {
            user,
            plan_id,
            expires_at,
            amount_paid: plan.price,
        }
        .publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // renew
    // -----------------------------------------------------------------------

    /// Renew `user`'s subscription to `plan_id`. The user pays the plan price.
    ///
    /// If the subscription is still active the duration is added to the current
    /// `expires_at` (so renewals always stack). If already expired, the new
    /// expiry is `now + duration`. The plan_id in the record is updated to
    /// match the renewed plan (allowing cross-plan renewal).
    ///
    /// Rejected if no subscription record exists for the user.
    pub fn renew(env: Env, user: Address, plan_id: u32) -> Result<(), Error> {
        require_initialized(&env)?;

        user.require_auth();

        let plan = require_plan_exists(&env, plan_id)?;

        let sub_key = DataKey::Subscription(user.clone());
        let existing = get_subscription(&env, &sub_key).ok_or(Error::PlanNotFound)?;

        let now = env.ledger().timestamp();
        // Extend from the current expiry if still active, otherwise from now.
        let base = if existing.expires_at > now {
            existing.expires_at
        } else {
            now
        };
        let expires_at = base.checked_add(plan.duration).ok_or(Error::Overflow)?;

        // Charge the user.
        let treasury = get_treasury(&env);
        TokenClient::new(&env, &treasury).transfer(&user, &treasury, &plan.price);

        let record = SubscriptionRecord {
            plan_id,
            expires_at,
        };
        env.storage().persistent().set(&sub_key, &record);
        env.storage().persistent().extend_ttl(
            &sub_key,
            PERSISTENT_BUMP_LEDGERS,
            PERSISTENT_BUMP_LEDGERS,
        );

        Renewed {
            user,
            plan_id,
            expires_at,
            amount_paid: plan.price,
        }
        .publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // status_of
    // -----------------------------------------------------------------------

    /// Return the subscription status for `user`.
    ///
    /// Returns a `SubscriptionStatus` with `has_subscription = false` if the
    /// user has never subscribed. If a record exists, `is_active` reflects
    /// whether the current ledger timestamp is before `expires_at`.
    pub fn status_of(env: Env, user: Address) -> SubscriptionStatus {
        let sub_key = DataKey::Subscription(user);
        match get_subscription(&env, &sub_key) {
            None => SubscriptionStatus {
                has_subscription: false,
                plan_id: 0,
                expires_at: 0,
                is_active: false,
            },
            Some(record) => {
                let now = env.ledger().timestamp();
                SubscriptionStatus {
                    has_subscription: true,
                    plan_id: record.plan_id,
                    expires_at: record.expires_at,
                    is_active: record.expires_at > now,
                }
            }
        }
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

/// Fetch the plan definition or return `PlanNotFound`.
fn require_plan_exists(env: &Env, plan_id: u32) -> Result<PlanDefinition, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Plan(plan_id))
        .ok_or(Error::PlanNotFound)
}

fn get_treasury(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Treasury)
        .expect("VipSubscription: treasury not set")
}

fn get_subscription(env: &Env, key: &DataKey) -> Option<SubscriptionRecord> {
    env.storage().persistent().get(key)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::{StellarAssetClient, TokenClient},
        Address, BytesN, Env,
    };

    // ------------------------------------------------------------------
    // Test helpers
    // ------------------------------------------------------------------

    fn make_hash(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    /// Deploy a fresh SEP-41 token contract and return its address plus an admin
    /// client for minting.
    fn create_token<'a>(env: &'a Env, token_admin: &Address) -> (Address, StellarAssetClient<'a>) {
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let sac = StellarAssetClient::new(env, &token_contract.address());
        (token_contract.address(), sac)
    }

    /// Register a VipSubscription contract, initialize it, and return the client
    /// plus supporting addresses. The treasury IS the token contract so that
    /// we can verify token balances directly against the treasury address.
    fn setup(
        env: &Env,
    ) -> (
        VipSubscriptionClient,
        Address,            // admin
        Address,            // treasury (= token contract address)
        StellarAssetClient, // token SAC for minting
    ) {
        let admin = Address::generate(env);
        let token_admin = Address::generate(env);

        let (treasury_addr, token_sac) = create_token(env, &token_admin);

        let contract_id = env.register(VipSubscription, ());
        let client = VipSubscriptionClient::new(env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury_addr);

        (client, admin, treasury_addr, token_sac)
    }

    /// Set the ledger timestamp to `ts`.
    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: 25,
            sequence_number: env.ledger().sequence(),
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 1,
            min_persistent_entry_ttl: 1,
            max_entry_ttl: 6_312_000,
        });
    }

    // ------------------------------------------------------------------
    // 1. init
    // ------------------------------------------------------------------

    #[test]
    fn test_init_rejects_reinit() {
        let env = Env::default();
        let (client, admin, treasury, _) = setup(&env);
        env.mock_all_auths();

        let result = client.try_init(&admin, &treasury);
        assert!(result.is_err());
    }

    #[test]
    fn test_uninit_calls_rejected() {
        let env = Env::default();
        let contract_id = env.register(VipSubscription, ());
        let client = VipSubscriptionClient::new(&env, &contract_id);
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let hash = make_hash(&env, 1);
        assert!(client
            .try_define_plan(&admin, &1u32, &100i128, &86400u64, &hash)
            .is_err());
    }

    // ------------------------------------------------------------------
    // 2. define_plan
    // ------------------------------------------------------------------

    #[test]
    fn test_define_plan_success() {
        let env = Env::default();
        let (client, admin, _, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 1);
        client.define_plan(&admin, &1u32, &1000i128, &86400u64, &hash);
        // No panic = success
    }

    #[test]
    fn test_define_plan_duplicate_rejected() {
        let env = Env::default();
        let (client, admin, _, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 2);
        client.define_plan(&admin, &1u32, &1000i128, &86400u64, &hash);

        let result = client.try_define_plan(&admin, &1u32, &1000i128, &86400u64, &hash);
        assert!(result.is_err());
    }

    #[test]
    fn test_define_plan_zero_price_rejected() {
        let env = Env::default();
        let (client, admin, _, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 3);
        let result = client.try_define_plan(&admin, &1u32, &0i128, &86400u64, &hash);
        assert!(result.is_err());
    }

    #[test]
    fn test_define_plan_negative_price_rejected() {
        let env = Env::default();
        let (client, admin, _, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 4);
        let result = client.try_define_plan(&admin, &1u32, &-1i128, &86400u64, &hash);
        assert!(result.is_err());
    }

    #[test]
    fn test_define_plan_zero_duration_rejected() {
        let env = Env::default();
        let (client, admin, _, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 5);
        let result = client.try_define_plan(&admin, &1u32, &1000i128, &0u64, &hash);
        assert!(result.is_err());
    }

    #[test]
    fn test_define_plan_non_admin_rejected() {
        let env = Env::default();
        let (client, _, _, _) = setup(&env);
        env.mock_all_auths();

        let non_admin = Address::generate(&env);
        let hash = make_hash(&env, 6);
        let result = client.try_define_plan(&non_admin, &1u32, &1000i128, &86400u64, &hash);
        assert!(result.is_err());
    }

    // ------------------------------------------------------------------
    // 3. subscribe
    // ------------------------------------------------------------------

    #[test]
    fn test_subscribe_success() {
        let env = Env::default();
        let (client, admin, treasury, token_sac) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 7);
        client.define_plan(&admin, &1u32, &500i128, &86400u64, &hash);

        let user = Address::generate(&env);
        token_sac.mint(&user, &500i128);

        set_time(&env, 1_000_000);
        client.subscribe(&user, &1u32);

        let status = client.status_of(&user);
        assert!(status.has_subscription);
        assert_eq!(status.plan_id, 1);
        assert_eq!(status.expires_at, 1_000_000 + 86_400);
        assert!(status.is_active);

        // Treasury received the payment.
        let tc = TokenClient::new(&env, &treasury);
        assert_eq!(tc.balance(&treasury), 500);
    }

    #[test]
    fn test_subscribe_unknown_plan_rejected() {
        let env = Env::default();
        let (client, _, _, _) = setup(&env);
        env.mock_all_auths();

        let user = Address::generate(&env);
        let result = client.try_subscribe(&user, &999u32);
        assert!(result.is_err());
    }

    #[test]
    fn test_subscribe_duplicate_active_rejected() {
        let env = Env::default();
        let (client, admin, _, token_sac) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 8);
        client.define_plan(&admin, &1u32, &100i128, &86400u64, &hash);

        let user = Address::generate(&env);
        token_sac.mint(&user, &1000i128);

        set_time(&env, 1_000_000);
        client.subscribe(&user, &1u32);

        // Second subscribe while active — must fail.
        let result = client.try_subscribe(&user, &1u32);
        assert!(result.is_err());
    }

    #[test]
    fn test_subscribe_after_expiry_succeeds() {
        let env = Env::default();
        let (client, admin, _, token_sac) = setup(&env);
        env.mock_all_auths();

        let duration: u64 = 86_400;
        let hash = make_hash(&env, 9);
        client.define_plan(&admin, &1u32, &100i128, &duration, &hash);

        let user = Address::generate(&env);
        token_sac.mint(&user, &1000i128);

        set_time(&env, 1_000_000);
        client.subscribe(&user, &1u32);

        // Advance past expiry.
        set_time(&env, 1_000_000 + duration + 1);
        client.subscribe(&user, &1u32);

        let status = client.status_of(&user);
        assert!(status.is_active);
        assert_eq!(status.expires_at, 1_000_000 + duration + 1 + duration);
    }

    // ------------------------------------------------------------------
    // 4. renew
    // ------------------------------------------------------------------

    #[test]
    fn test_renew_active_subscription_stacks() {
        let env = Env::default();
        let (client, admin, _, token_sac) = setup(&env);
        env.mock_all_auths();

        let duration: u64 = 86_400;
        let hash = make_hash(&env, 10);
        client.define_plan(&admin, &1u32, &100i128, &duration, &hash);

        let user = Address::generate(&env);
        token_sac.mint(&user, &1000i128);

        set_time(&env, 1_000_000);
        client.subscribe(&user, &1u32);

        // Renew while still active — expiry extends from original expires_at.
        set_time(&env, 1_000_000 + 1000);
        client.renew(&user, &1u32);

        let status = client.status_of(&user);
        // base = 1_000_000 + 86_400; new expiry = base + 86_400
        assert_eq!(status.expires_at, 1_000_000 + duration + duration);
        assert!(status.is_active);
    }

    #[test]
    fn test_renew_expired_subscription_reactivates() {
        let env = Env::default();
        let (client, admin, _, token_sac) = setup(&env);
        env.mock_all_auths();

        let duration: u64 = 86_400;
        let hash = make_hash(&env, 11);
        client.define_plan(&admin, &1u32, &100i128, &duration, &hash);

        let user = Address::generate(&env);
        token_sac.mint(&user, &1000i128);

        set_time(&env, 1_000_000);
        client.subscribe(&user, &1u32);

        // Advance past expiry.
        let renew_at = 1_000_000 + duration + 500;
        set_time(&env, renew_at);
        client.renew(&user, &1u32);

        let status = client.status_of(&user);
        assert_eq!(status.expires_at, renew_at + duration);
        assert!(status.is_active);
    }

    #[test]
    fn test_renew_no_subscription_rejected() {
        let env = Env::default();
        let (client, admin, _, _) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 12);
        client.define_plan(&admin, &1u32, &100i128, &86400u64, &hash);

        let user = Address::generate(&env);
        let result = client.try_renew(&user, &1u32);
        assert!(result.is_err());
    }

    #[test]
    fn test_renew_charges_user() {
        let env = Env::default();
        let (client, admin, treasury, token_sac) = setup(&env);
        env.mock_all_auths();

        let hash = make_hash(&env, 13);
        client.define_plan(&admin, &1u32, &300i128, &86400u64, &hash);

        let user = Address::generate(&env);
        token_sac.mint(&user, &1000i128);

        set_time(&env, 1_000_000);
        client.subscribe(&user, &1u32); // pays 300
        client.renew(&user, &1u32); // pays another 300

        let tc = TokenClient::new(&env, &treasury);
        assert_eq!(tc.balance(&treasury), 600);
    }

    // ------------------------------------------------------------------
    // 5. status_of
    // ------------------------------------------------------------------

    #[test]
    fn test_status_of_no_subscription() {
        let env = Env::default();
        let (client, _, _, _) = setup(&env);

        let user = Address::generate(&env);
        let status = client.status_of(&user);
        assert!(!status.has_subscription);
        assert_eq!(status.plan_id, 0);
        assert_eq!(status.expires_at, 0);
        assert!(!status.is_active);
    }

    #[test]
    fn test_status_of_expired() {
        let env = Env::default();
        let (client, admin, _, token_sac) = setup(&env);
        env.mock_all_auths();

        let duration: u64 = 86_400;
        let hash = make_hash(&env, 14);
        client.define_plan(&admin, &1u32, &100i128, &duration, &hash);

        let user = Address::generate(&env);
        token_sac.mint(&user, &500i128);

        set_time(&env, 1_000_000);
        client.subscribe(&user, &1u32);

        // Advance past expiry.
        set_time(&env, 1_000_000 + duration + 1);

        let status = client.status_of(&user);
        assert!(status.has_subscription);
        assert!(!status.is_active);
    }

    // ------------------------------------------------------------------
    // 6. Full lifecycle
    // ------------------------------------------------------------------

    #[test]
    fn test_full_lifecycle() {
        let env = Env::default();
        let (client, admin, treasury, token_sac) = setup(&env);
        env.mock_all_auths();

        let duration: u64 = 30 * 24 * 3600; // 30 days
        let hash_basic = make_hash(&env, 20);
        let hash_pro = make_hash(&env, 21);

        // Define two plans.
        client.define_plan(&admin, &1u32, &500i128, &duration, &hash_basic);
        client.define_plan(&admin, &2u32, &1500i128, &duration, &hash_pro);

        let user = Address::generate(&env);
        token_sac.mint(&user, &10_000i128);

        // Subscribe to basic.
        set_time(&env, 1_000_000);
        client.subscribe(&user, &1u32);

        let status = client.status_of(&user);
        assert_eq!(status.plan_id, 1);
        assert!(status.is_active);

        // Renew with pro plan (cross-plan renewal).
        client.renew(&user, &2u32);

        let status2 = client.status_of(&user);
        assert_eq!(status2.plan_id, 2);
        // New expiry = original expires_at + pro duration
        assert_eq!(status2.expires_at, 1_000_000 + duration + duration);
        assert!(status2.is_active);

        // Verify treasury received payments for subscribe + renew.
        let tc = TokenClient::new(&env, &treasury);
        assert_eq!(tc.balance(&treasury), 500 + 1500);

        // Advance past expiry, status should become inactive.
        set_time(&env, status2.expires_at + 1);
        let status3 = client.status_of(&user);
        assert!(!status3.is_active);

        // Subscribe again (fresh start on expired).
        client.subscribe(&user, &1u32);
        let status4 = client.status_of(&user);
        assert!(status4.is_active);
        assert_eq!(status4.plan_id, 1);
    }
}
