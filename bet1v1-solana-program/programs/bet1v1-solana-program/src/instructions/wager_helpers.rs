use crate::constant::{INCREMENTAL, MATCHED, OPEN, WINNER_TAKE_ALL};
use crate::errors::WagerError;
use crate::state::{Config, UserStake, Wager};
use anchor_lang::prelude::*;

pub fn validate_wager_terms(
    amount: u64,
    payout_mode: u8,
    increment_value: u64,
    incremental_supported: bool,
) -> Result<()> {
    require!(amount > 0, WagerError::InvalidWagerAmount);
    require!(
        payout_mode == WINNER_TAKE_ALL || (incremental_supported && payout_mode == INCREMENTAL),
        WagerError::InvalidPayoutMode
    );
    require!(
        (payout_mode == WINNER_TAKE_ALL && increment_value == 0)
            || (payout_mode == INCREMENTAL && increment_value > 0 && increment_value <= amount),
        WagerError::InvalidIncrementValue
    );
    Ok(())
}

pub fn require_wager_access(
    stake: &mut Account<UserStake>,
    owner: Pubkey,
    bump: u8,
    config: &Account<Config>,
) -> Result<()> {
    if stake.owner == Pubkey::default() {
        stake.owner = owner;
        stake.bump = bump;
    }
    require!(!stake.banned, WagerError::UserBanned);
    require!(
        !config.staking_enabled || stake.amount >= config.required_stake,
        WagerError::StakeRequired
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn open_wager(
    wager: &mut Account<Wager>,
    wager_id: u64,
    maker: Pubkey,
    challenger: Pubkey,
    amount: u64,
    token_mint: Pubkey,
    payout_mode: u8,
    increment_value: u64,
    bump: u8,
) {
    wager.wager_id = wager_id;
    wager.maker = maker;
    wager.challenger = challenger;
    wager.opponent = Pubkey::default();
    wager.amount = amount;
    wager.token_mint = token_mint;
    wager.winner = Pubkey::default();
    wager.status = OPEN;
    wager.payout_mode = payout_mode;
    wager.increment_value = increment_value;
    wager.maker_remaining = amount;
    wager.opponent_remaining = amount;
    wager.maker_score = 0;
    wager.opponent_score = 0;
    wager.bump = bump;
}

pub fn increment_active_wagers(stake: &mut Account<UserStake>) -> Result<()> {
    stake.active_wagers = stake
        .active_wagers
        .checked_add(1)
        .ok_or(WagerError::MathOverflow)?;
    Ok(())
}

pub fn validate_join(
    wager: &Account<Wager>,
    opponent: Pubkey,
    opponent_stake: &mut Account<UserStake>,
    stake_bump: u8,
    config: &Account<Config>,
) -> Result<()> {
    require!(wager.status == OPEN, WagerError::WagerNotOpen);
    require_keys_neq!(wager.maker, opponent, WagerError::InvalidWagerParticipants);
    require!(
        wager.challenger == Pubkey::default() || wager.challenger == opponent,
        WagerError::WagerReserved
    );
    require_wager_access(opponent_stake, opponent, stake_bump, config)
}

pub fn match_wager(
    wager: &mut Account<Wager>,
    opponent_stake: &mut Account<UserStake>,
    opponent: Pubkey,
) -> Result<()> {
    wager.opponent = opponent;
    wager.status = MATCHED;
    increment_active_wagers(opponent_stake)
}
