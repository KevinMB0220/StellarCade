//! Stellarcade Streak Bonus Contract
//!
//! Tracks user activity streaks and allows claiming bonuses when streak thresholds
//! are met. Admin sets reward contract and rules; users record activity and claim.
#![no_std]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    RewardContract,
    Rules,
    UserData(Address),
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreakRules {
    pub min_streak_to_claim: u32,
    pub reward_per_streak: i128,
    /// Max seconds between activities to count as same streak (e.g. 86400 = 24h).
    pub streak_window_secs: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserStreakData {
    pub last_activity_ts: u64,
    pub current_streak: u32,
    pub last_claimed_streak: u32,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAuthorized = 3,
    InvalidConfig = 4,
    NothingToClaim = 5,
    Overflow = 6,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct Initialized {
    pub admin: Address,
    pub reward_contract: Address,
}

#[contractevent]
pub struct ActivityRecorded {
    #[topic]
    pub user: Address,
    pub activity_type: Symbol,
    pub ts: u64,
    pub new_streak: u32,
}

#[contractevent]
pub struct StreakBonusClaimed {
    #[topic]
    pub user: Address,
    pub streak: u32,
    pub amount: i128,
}

#[contractevent]
pub struct RulesReset {
    pub min_streak_to_claim: u32,
    pub reward_per_streak: i128,
    pub streak_window_secs: u64,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct StreakBonus;

#[contractimpl]
impl StreakBonus {
    /// Initialize with admin and reward contract address. Call once.
    pub fn init(env: Env, admin: Address, reward_contract: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RewardContract, &reward_contract);
        let default_rules = StreakRules {
            min_streak_to_claim: 3,
            reward_per_streak: 1_000_000i128, // e.g. 1 unit in 6 decimals
            streak_window_secs: 86400,         // 24h
        };
        env.storage().instance().set(&DataKey::Rules, &default_rules);
        Initialized {
            admin,
            reward_contract,
        }
        .publish(&env);
        Ok(())
    }

    /// Record an activity for a user. Caller must be the user (require_auth) or admin.
    pub fn record_activity(
        env: Env,
        caller: Address,
        user: Address,
        activity_type: Symbol,
        ts: u64,
    ) -> Result<u32, Error> {
        caller.require_auth();
        require_admin_or_self(&env, &caller, &user)?;

        let rules: StreakRules = env
            .storage()
            .instance()
            .get(&DataKey::Rules)
            .ok_or(Error::NotInitialized)?;

        let key = DataKey::UserData(user.clone());
        let mut data: UserStreakData = env
            .storage()
            .instance()
            .get(&key)
            .unwrap_or(UserStreakData {
                last_activity_ts: 0,
                current_streak: 0,
                last_claimed_streak: 0,
            });

        let new_streak = if data.last_activity_ts == 0 {
            1u32
        } else if ts > data.last_activity_ts
            && ts.saturating_sub(data.last_activity_ts) <= rules.streak_window_secs
        {
            data.current_streak
                .checked_add(1)
                .ok_or(Error::Overflow)?
        } else {
            1u32
        };

        data.last_activity_ts = ts;
        data.current_streak = new_streak;
        env.storage().instance().set(&key, &data);

        ActivityRecorded {
            user: user.clone(),
            activity_type,
            ts,
            new_streak,
        }
        .publish(&env);
        Ok(new_streak)
    }

    /// Return the current streak count for a user.
    pub fn current_streak(env: Env, user: Address) -> u32 {
        let key = DataKey::UserData(user);
        env.storage()
            .instance()
            .get(&key)
            .map(|d: UserStreakData| d.current_streak)
            .unwrap_or(0)
    }

    /// Claim streak bonus for the current streak. User must authorize. Updates last_claimed_streak.
    pub fn claim_streak_bonus(env: Env, user: Address) -> Result<i128, Error> {
        user.require_auth();

        let rules: StreakRules = env
            .storage()
            .instance()
            .get(&DataKey::Rules)
            .ok_or(Error::NotInitialized)?;

        let key = DataKey::UserData(user.clone());
        let mut data: UserStreakData = env
            .storage()
            .instance()
            .get(&key)
            .ok_or(Error::NothingToClaim)?;

        if data.current_streak < rules.min_streak_to_claim {
            return Err(Error::NothingToClaim);
        }
        if data.current_streak <= data.last_claimed_streak {
            return Err(Error::NothingToClaim);
        }

        let amount = (data.current_streak as i128)
            .checked_mul(rules.reward_per_streak)
            .ok_or(Error::Overflow)?;

        data.last_claimed_streak = data.current_streak;
        env.storage().instance().set(&key, &data);

        StreakBonusClaimed {
            user: user.clone(),
            streak: data.current_streak,
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    /// Reset streak rules. Admin only.
    pub fn reset_rules(env: Env, admin: Address, config: StreakRules) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        if config.streak_window_secs == 0 {
            return Err(Error::InvalidConfig);
        }
        env.storage().instance().set(&DataKey::Rules, &config);
        RulesReset {
            min_streak_to_claim: config.min_streak_to_claim,
            reward_per_streak: config.reward_per_streak,
            streak_window_secs: config.streak_window_secs,
        }
        .publish(&env);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    if *caller != admin {
        return Err(Error::NotAuthorized);
    }
    Ok(())
}

fn require_admin_or_self(env: &Env, caller: &Address, user: &Address) -> Result<(), Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    if caller != user && *caller != admin {
        return Err(Error::NotAuthorized);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test;
