//! Stellarcade Daily Trivia Contract
//!
//! Players can submit one answer per round/day. Correct answers share a
//! fixed reward amount reserved for that round.
#![no_std]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    symbol_short, Address, Bytes, BytesN, Env, Symbol,
};

// ---------------------------------------------------------------------------
// External contract clients
// ---------------------------------------------------------------------------

#[contractclient(name = "PrizePoolClient")]
pub trait PrizePoolContract {
    fn reserve(env: Env, admin: Address, game_id: u64, amount: i128);
    fn release(env: Env, admin: Address, game_id: u64, amount: i128);
    fn payout(env: Env, admin: Address, to: Address, game_id: u64, amount: i128);
}

#[contractclient(name = "BalanceClient")]
pub trait UserBalanceContract {
    fn credit(env: Env, game: Address, user: Address, amount: i128, reason: Symbol);
    fn debit(env: Env, game: Address, user: Address, amount: i128, reason: Symbol);
    fn balance_of(env: Env, user: Address) -> i128;
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
    RoundAlreadyExists = 4,
    RoundNotFound = 5,
    RoundNotOpen = 6,
    RoundClosed = 7,
    AlreadySubmitted = 8,
    AlreadyClaimed = 9,
    NoRewardAvailable = 10,
    InvalidAmount = 11,
    Overflow = 12,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum RoundStatus {
    Open = 0,
    Closed = 1,
}

#[contracttype]
#[derive(Clone)]
pub struct RoundData {
    pub answer_commitment: BytesN<32>,
    pub reward_amount: i128,
    pub payout_per_winner: i128,
    pub winner_count: u32,
    pub status: RoundStatus,
    pub opened_at: u64,
    pub closed_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct Submission {
    pub answer_hash: BytesN<32>,
    pub correct: bool,
    pub claimed: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
    PrizePoolContract,
    BalanceContract,
    Round(u64),
    Submission(u64, Address),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct RoundOpened {
    #[topic]
    pub round_id: u64,
    pub reward_amount: i128,
}

#[contractevent]
pub struct AnswerSubmitted {
    #[topic]
    pub round_id: u64,
    pub player: Address,
    pub correct: bool,
}

#[contractevent]
pub struct RoundClosed {
    #[topic]
    pub round_id: u64,
    pub winners: u32,
    pub payout_per_winner: i128,
}

#[contractevent]
pub struct RewardClaimed {
    #[topic]
    pub round_id: u64,
    pub player: Address,
    pub amount: i128,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct DailyTrivia;

#[contractimpl]
impl DailyTrivia {
    pub fn init(
        env: Env,
        admin: Address,
        prize_pool_contract: Address,
        balance_contract: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::PrizePoolContract, &prize_pool_contract);
        env.storage()
            .instance()
            .set(&DataKey::BalanceContract, &balance_contract);
        Ok(())
    }

    pub fn open_round(
        env: Env,
        round_id: u64,
        answer_commitment: BytesN<32>,
        reward_amount: i128,
    ) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        require_positive(reward_amount)?;

        let key = DataKey::Round(round_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::RoundAlreadyExists);
        }

        let prize_pool = get_prize_pool(&env)?;
        let pool_client = PrizePoolClient::new(&env, &prize_pool);
        pool_client.reserve(&admin, &round_id, &reward_amount);

        let now = env.ledger().timestamp();
        let round = RoundData {
            answer_commitment,
            reward_amount,
            payout_per_winner: 0,
            winner_count: 0,
            status: RoundStatus::Open,
            opened_at: now,
            closed_at: 0,
        };
        env.storage().persistent().set(&key, &round);

        RoundOpened {
            round_id,
            reward_amount,
        }
        .publish(&env);
        Ok(())
    }

    pub fn submit_answer(
        env: Env,
        player: Address,
        round_id: u64,
        answer_payload: Bytes,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        player.require_auth();

        let key = DataKey::Round(round_id);
        let mut round: RoundData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::RoundNotFound)?;

        if round.status != RoundStatus::Open {
            return Err(Error::RoundClosed);
        }
        if env.ledger().timestamp() < round.opened_at {
            return Err(Error::RoundNotOpen);
        }

        let submission_key = DataKey::Submission(round_id, player.clone());
        if env.storage().persistent().has(&submission_key) {
            return Err(Error::AlreadySubmitted);
        }

        let answer_hash: BytesN<32> = env.crypto().sha256(&answer_payload).into();
        let correct = answer_hash == round.answer_commitment;

        if correct {
            round.winner_count = round
                .winner_count
                .checked_add(1)
                .ok_or(Error::Overflow)?;
            env.storage().persistent().set(&key, &round);
        }

        let submission = Submission {
            answer_hash,
            correct,
            claimed: false,
        };
        env.storage().persistent().set(&submission_key, &submission);

        AnswerSubmitted {
            round_id,
            player,
            correct,
        }
        .publish(&env);
        Ok(())
    }

    pub fn close_round(env: Env, round_id: u64) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        let key = DataKey::Round(round_id);
        let mut round: RoundData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::RoundNotFound)?;

        if round.status != RoundStatus::Open {
            return Err(Error::RoundNotOpen);
        }
        let now = env.ledger().timestamp();
        if now < round.opened_at {
            return Err(Error::RoundNotOpen);
        }

        let payout_per_winner = if round.winner_count == 0 {
            0
        } else {
            round
                .reward_amount
                .checked_div(round.winner_count as i128)
                .ok_or(Error::Overflow)?
        };

        if round.winner_count == 0 {
            let prize_pool = get_prize_pool(&env)?;
            let pool_client = PrizePoolClient::new(&env, &prize_pool);
            pool_client.release(&admin, &round_id, &round.reward_amount);
        }

        round.status = RoundStatus::Closed;
        round.closed_at = now;
        round.payout_per_winner = payout_per_winner;
        env.storage().persistent().set(&key, &round);

        RoundClosed {
            round_id,
            winners: round.winner_count,
            payout_per_winner,
        }
        .publish(&env);
        Ok(())
    }

    pub fn claim_reward(env: Env, player: Address, round_id: u64) -> Result<i128, Error> {
        require_initialized(&env)?;
        player.require_auth();

        let round: RoundData = env
            .storage()
            .persistent()
            .get(&DataKey::Round(round_id))
            .ok_or(Error::RoundNotFound)?;

        if round.status != RoundStatus::Closed {
            return Err(Error::RoundNotOpen);
        }

        let submission_key = DataKey::Submission(round_id, player.clone());
        let mut submission: Submission = env
            .storage()
            .persistent()
            .get(&submission_key)
            .ok_or(Error::NoRewardAvailable)?;

        if submission.claimed {
            return Err(Error::AlreadyClaimed);
        }

        if !submission.correct || round.payout_per_winner <= 0 {
            return Err(Error::NoRewardAvailable);
        }

        let prize_pool = get_prize_pool(&env)?;
        let pool_client = PrizePoolClient::new(&env, &prize_pool);
        let admin = get_admin(&env)?;
        pool_client.payout(&admin, &player, &round_id, &round.payout_per_winner);

        let balance_contract = get_balance_contract(&env)?;
        let balance_client = BalanceClient::new(&env, &balance_contract);
        let contract_addr = env.current_contract_address();

        let contract_balance = balance_client.balance_of(&contract_addr);
        if contract_balance < round.payout_per_winner {
            return Err(Error::InvalidAmount);
        }

        balance_client.debit(
            &contract_addr,
            &contract_addr,
            &round.payout_per_winner,
            &symbol_short!("payout"),
        );
        balance_client.credit(
            &contract_addr,
            &player,
            &round.payout_per_winner,
            &symbol_short!("win"),
        );

        submission.claimed = true;
        env.storage().persistent().set(&submission_key, &submission);

        RewardClaimed {
            round_id,
            player,
            amount: round.payout_per_winner,
        }
        .publish(&env);
        Ok(round.payout_per_winner)
    }

    pub fn get_round(env: Env, round_id: u64) -> Option<RoundData> {
        env.storage().persistent().get(&DataKey::Round(round_id))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn require_initialized(env: &Env) -> Result<(), Error> {
    if !env.storage().instance().has(&DataKey::Admin) {
        return Err(Error::NotInitialized);
    }
    Ok(())
}

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin = get_admin(env)?;
    admin.require_auth();
    Ok(admin)
}

fn require_positive(amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    Ok(())
}

fn get_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn get_prize_pool(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::PrizePoolContract)
        .ok_or(Error::NotInitialized)
}

fn get_balance_contract(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::BalanceContract)
        .ok_or(Error::NotInitialized)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl, contracttype, testutils::Address as _, Address, Env, IntoVal,
    };

    #[contract]
    pub struct MockPrizePool;

    #[contracttype]
    pub enum PoolKey {
        Reserved(u64),
        Paid(u64),
        Released(u64),
    }

    #[contractimpl]
    impl MockPrizePool {
        pub fn reserve(env: Env, _admin: Address, game_id: u64, amount: i128) {
            env.storage().persistent().set(&PoolKey::Reserved(game_id), &amount);
        }

        pub fn release(env: Env, _admin: Address, game_id: u64, amount: i128) {
            env.storage().persistent().set(&PoolKey::Released(game_id), &amount);
        }

        pub fn payout(env: Env, _admin: Address, _to: Address, game_id: u64, amount: i128) {
            env.storage().persistent().set(&PoolKey::Paid(game_id), &amount);
        }
    }

    #[contract]
    pub struct MockBalance;

    #[contracttype]
    pub enum BalanceKey {
        Balance(Address),
    }

    #[contractimpl]
    impl MockBalance {
        pub fn set_balance(env: Env, user: Address, amount: i128) {
            env.storage()
                .persistent()
                .set(&BalanceKey::Balance(user), &amount);
        }

        pub fn credit(env: Env, _game: Address, user: Address, amount: i128, _reason: Symbol) {
            let bal = Self::balance_of(env.clone(), user.clone());
            env.storage()
                .persistent()
                .set(&BalanceKey::Balance(user), &(bal + amount));
        }

        pub fn debit(env: Env, _game: Address, user: Address, amount: i128, _reason: Symbol) {
            let bal = Self::balance_of(env.clone(), user.clone());
            if bal < amount {
                panic!("insufficient balance");
            }
            env.storage()
                .persistent()
                .set(&BalanceKey::Balance(user), &(bal - amount));
        }

        pub fn balance_of(env: Env, user: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&BalanceKey::Balance(user))
                .unwrap_or(0)
        }
    }

    fn setup(
        env: &Env,
    ) -> (
        DailyTriviaClient<'_>,
        Address,
        Address,
        Address,
        MockBalanceClient<'_>,
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);
        let player = Address::generate(env);
        let balance_id = env.register(MockBalance, ());
        let balance_client = MockBalanceClient::new(env, &balance_id);

        let pool_id = env.register(MockPrizePool, ());

        let trivia_id = env.register(DailyTrivia, ());
        let trivia_client = DailyTriviaClient::new(env, &trivia_id);
        trivia_client.init(&admin, &pool_id, &balance_id);

        let contract_addr = trivia_id.clone();
        balance_client.set_balance(&contract_addr, &1_000);

        (trivia_client, admin, player, trivia_id, balance_client)
    }

    fn hash_answer(env: &Env, payload: &Bytes) -> BytesN<32> {
        env.crypto().sha256(payload).into()
    }

    #[test]
    fn test_round_open_close_lifecycle() {
        let env = Env::default();
        let (client, _admin, _player, _trivia_id, _balance) = setup(&env);

        let commitment = hash_answer(&env, &Bytes::from_array(&env, &[1, 2, 3]));
        client.open_round(&1, &commitment, &100);

        let round = client.get_round(&1).unwrap();
        assert_eq!(round.status, RoundStatus::Open);

        client.close_round(&1);
        let round = client.get_round(&1).unwrap();
        assert_eq!(round.status, RoundStatus::Closed);
    }

    #[test]
    fn test_one_entry_per_round() {
        let env = Env::default();
        let (client, _admin, player, _trivia_id, _balance) = setup(&env);

        let payload = Bytes::from_array(&env, &[9]);
        let commitment = hash_answer(&env, &payload);
        client.open_round(&2, &commitment, &100);

        client.submit_answer(&player, &2, &payload);
        let result = client.try_submit_answer(&player, &2, &payload);
        assert!(result.is_err());
    }

    #[test]
    fn test_correct_answer_eligible_for_reward() {
        let env = Env::default();
        let (client, _admin, player, _trivia_id, balance) = setup(&env);

        let payload = Bytes::from_array(&env, &[7, 7]);
        let commitment = hash_answer(&env, &payload);
        client.open_round(&3, &commitment, &100);

        client.submit_answer(&player, &3, &payload);
        client.close_round(&3);

        let reward = client.claim_reward(&player, &3);
        assert_eq!(reward, 100);
        assert_eq!(balance.balance_of(&player), 100);
    }

    #[test]
    fn test_wrong_answer_gets_no_reward() {
        let env = Env::default();
        let (client, _admin, player, _trivia_id, _balance) = setup(&env);

        let commitment = hash_answer(&env, &Bytes::from_array(&env, &[1]));
        client.open_round(&4, &commitment, &100);

        let wrong = Bytes::from_array(&env, &[2]);
        client.submit_answer(&player, &4, &wrong);
        client.close_round(&4);

        let result = client.try_claim_reward(&player, &4);
        assert!(result.is_err());
    }

    #[test]
    fn test_double_claim_rejected() {
        let env = Env::default();
        let (client, _admin, player, _trivia_id, _balance) = setup(&env);

        let payload = Bytes::from_array(&env, &[4, 4]);
        let commitment = hash_answer(&env, &payload);
        client.open_round(&5, &commitment, &100);

        client.submit_answer(&player, &5, &payload);
        client.close_round(&5);

        client.claim_reward(&player, &5);
        let result = client.try_claim_reward(&player, &5);
        assert!(result.is_err());
    }

    #[test]
    fn test_unauthorized_admin_calls_rejected() {
        let env = Env::default();
        let (client, _admin, _player, trivia_id, _balance) = setup(&env);

        let other = Address::generate(&env);
        let commitment = hash_answer(&env, &Bytes::from_array(&env, &[8]));

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &other,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &trivia_id,
                fn_name: "open_round",
                args: soroban_sdk::vec![
                    &env,
                    6u64.into_val(&env),
                    commitment.into_val(&env),
                    100i128.into_val(&env)
                ],
                sub_invokes: &[],
            },
        }]);

        let result = client.try_open_round(&6, &commitment, &100);
        assert!(result.is_err());
    }
}
