//! Unit tests for Streak Bonus contract.
use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, Symbol};

fn setup(env: &Env) -> (StreakBonusClient<'_>, Address, Address, Address) {
    let admin = Address::generate(env);
    let reward = Address::generate(env);
    let user = Address::generate(env);
    let contract_id = env.register(StreakBonus, ());
    let client = StreakBonusClient::new(env, &contract_id);
    env.mock_all_auths();
    client.init(&admin, &reward);
    (client, admin, reward, user)
}

#[test]
fn test_init_succeeds() {
    let env = Env::default();
    let (_, _, _, _) = setup(&env);
}

#[test]
fn test_init_rejects_reinit() {
    let env = Env::default();
    let (client, admin, reward, _) = setup(&env);
    env.mock_all_auths();
    let result = client.try_init(&admin, &reward);
    assert!(result.is_err());
}

#[test]
fn test_record_activity_starts_streak() {
    let env = Env::default();
    let (client, _, _, user) = setup(&env);
    env.mock_all_auths();
    let streak = client.record_activity(&user, &user, &Symbol::new(&env, "play"), &1000u64);
    assert_eq!(streak, 1);
    assert_eq!(client.current_streak(&user), 1);
}

#[test]
fn test_record_activity_within_window_increments_streak() {
    let env = Env::default();
    let (client, _, _, user) = setup(&env);
    env.mock_all_auths();
    client.record_activity(&user, &user, &Symbol::new(&env, "play"), &1000u64);
    let streak = client.record_activity(&user, &user, &Symbol::new(&env, "play"), &2000u64);
    assert_eq!(streak, 2);
    assert_eq!(client.current_streak(&user), 2);
}

#[test]
fn test_record_activity_outside_window_resets_streak() {
    let env = Env::default();
    let (client, _, _, user) = setup(&env);
    env.mock_all_auths();
    client.record_activity(&user, &user, &Symbol::new(&env, "play"), &1000u64);
    // 86400+ seconds later (default window 24h)
    let streak = client.record_activity(&user, &user, &Symbol::new(&env, "play"), &90000u64);
    assert_eq!(streak, 1);
    assert_eq!(client.current_streak(&user), 1);
}

#[test]
fn test_current_streak_zero_for_unknown_user() {
    let env = Env::default();
    let (client, _, _, _) = setup(&env);
    let unknown = Address::generate(&env);
    assert_eq!(client.current_streak(&unknown), 0);
}

#[test]
fn test_claim_requires_min_streak() {
    let env = Env::default();
    let (client, _, _, user) = setup(&env);
    env.mock_all_auths();
    client.record_activity(&user, &user, &Symbol::new(&env, "play"), &1000u64);
    // default min_streak_to_claim is 3
    let result = client.try_claim_streak_bonus(&user);
    assert!(result.is_err());
}

#[test]
fn test_claim_succeeds_when_streak_met() {
    let env = Env::default();
    let (client, _, _, user) = setup(&env);
    env.mock_all_auths();
    client.record_activity(&user, &user, &Symbol::new(&env, "play"), &1000u64);
    client.record_activity(&user, &user, &Symbol::new(&env, "play"), &2000u64);
    client.record_activity(&user, &user, &Symbol::new(&env, "play"), &3000u64);
    let amount = client.claim_streak_bonus(&user);
    assert!(amount > 0);
}

#[test]
fn test_claim_twice_same_streak_rejected() {
    let env = Env::default();
    let (client, _, _, user) = setup(&env);
    env.mock_all_auths();
    client.record_activity(&user, &user, &Symbol::new(&env, "play"), &1000u64);
    client.record_activity(&user, &user, &Symbol::new(&env, "play"), &2000u64);
    client.record_activity(&user, &user, &Symbol::new(&env, "play"), &3000u64);
    let _ = client.claim_streak_bonus(&user);
    let result = client.try_claim_streak_bonus(&user);
    assert!(result.is_err());
}

#[test]
fn test_reset_rules_admin_only() {
    let env = Env::default();
    let (client, admin, _, _user) = setup(&env);
    env.mock_all_auths();
    let new_rules = StreakRules {
        min_streak_to_claim: 1,
        reward_per_streak: 2_000_000,
        streak_window_secs: 3600,
    };
    client.reset_rules(&admin, &new_rules);
}

#[test]
fn test_reset_rules_rejects_zero_window() {
    let env = Env::default();
    let (client, admin, _, _) = setup(&env);
    env.mock_all_auths();
    let bad_rules = StreakRules {
        min_streak_to_claim: 1,
        reward_per_streak: 0,
        streak_window_secs: 0,
    };
    let result = client.try_reset_rules(&admin, &bad_rules);
    assert!(result.is_err());
}

#[test]
fn test_admin_can_record_activity_for_user() {
    let env = Env::default();
    let (client, admin, _, user) = setup(&env);
    env.mock_all_auths();
    let streak = client.record_activity(&admin, &user, &Symbol::new(&env, "play"), &1000u64);
    assert_eq!(streak, 1);
    assert_eq!(client.current_streak(&user), 1);
}
