use anchor_lang::prelude::*;

pub mod constant;
pub mod errors;
pub mod event;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("8rqv4B1Sw4xweu4kWEHGnqoTQbQvRKuxSturDsz32i4v");

#[program]
pub mod bet1v1_solana_program {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        required_stake: u64,
        staking_enabled: bool,
    ) -> Result<()> {
        instructions::initialize_config(ctx, required_stake, staking_enabled)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        authority: Pubkey,
        chain_authority: Pubkey,
        required_stake: u64,
        staking_enabled: bool,
    ) -> Result<()> {
        instructions::update_config(
            ctx,
            authority,
            chain_authority,
            required_stake,
            staking_enabled,
        )
    }

    pub fn stake_tokens(ctx: Context<StakeTokens>, amount: u64) -> Result<()> {
        instructions::stake_tokens(ctx, amount)
    }

    pub fn unstake_tokens(ctx: Context<UnstakeTokens>, amount: u64) -> Result<()> {
        instructions::unstake_tokens(ctx, amount)
    }

    pub fn create_wager(
        ctx: Context<CreateWager>,
        wager_id: u64,
        challenger: Pubkey,
        amount: u64,
        payout_mode: u8,
        increment_value: u64,
    ) -> Result<()> {
        instructions::create_wager(
            ctx,
            wager_id,
            challenger,
            amount,
            payout_mode,
            increment_value,
        )
    }

    pub fn join_wager(ctx: Context<JoinWager>) -> Result<()> {
        instructions::join_wager(ctx)
    }

    pub fn create_sol_wager(
        ctx: Context<CreateSolWager>,
        wager_id: u64,
        challenger: Pubkey,
        amount: u64,
        payout_mode: u8,
        increment_value: u64,
    ) -> Result<()> {
        instructions::create_sol_wager(
            ctx,
            wager_id,
            challenger,
            amount,
            payout_mode,
            increment_value,
        )
    }

    pub fn join_sol_wager(ctx: Context<JoinSolWager>) -> Result<()> {
        instructions::join_sol_wager(ctx)
    }

    pub fn cancel_sol_wager(ctx: Context<CancelSolWager>) -> Result<()> {
        instructions::cancel_sol_wager(ctx)
    }

    pub fn decline_sol_wager(ctx: Context<DeclineSolWager>) -> Result<()> {
        instructions::decline_sol_wager(ctx)
    }

    pub fn settle_sol_wager(ctx: Context<SettleSolWager>) -> Result<()> {
        instructions::settle_sol_wager(ctx)
    }

    pub fn settle_sol_increment(
        ctx: Context<SettleSolIncrement>,
        beneficiary: Pubkey,
        sequence: u32,
    ) -> Result<()> {
        instructions::settle_sol_increment(ctx, beneficiary, sequence)
    }

    pub fn invalidate_sol_wager(ctx: Context<InvalidateSolWager>) -> Result<()> {
        instructions::invalidate_sol_wager(ctx)
    }

    pub fn cancel_wager(ctx: Context<CancelWager>) -> Result<()> {
        instructions::cancel_wager(ctx)
    }

    pub fn decline_wager(ctx: Context<DeclineWager>) -> Result<()> {
        instructions::decline_wager(ctx)
    }

    pub fn settle_wager(ctx: Context<SettleWager>) -> Result<()> {
        instructions::settle_wager(ctx)
    }

    pub fn settle_increment(
        ctx: Context<SettleIncrement>,
        beneficiary: Pubkey,
        sequence: u32,
    ) -> Result<()> {
        instructions::settle_increment(ctx, beneficiary, sequence)
    }

    pub fn invalidate_wager(ctx: Context<InvalidateWager>) -> Result<()> {
        instructions::invalidate_wager(ctx)
    }

    pub fn ban_user(ctx: Context<BanUser>) -> Result<()> {
        instructions::ban_user(ctx)
    }
}
