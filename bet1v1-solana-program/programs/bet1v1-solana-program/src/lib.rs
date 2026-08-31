use anchor_lang::prelude::*;

pub mod constant;
pub mod errors;
pub mod event;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("6L4UuN5zYFaZsLffmUuNKk9d5BtzusyK1xE5Z8Wr2CUY");

#[program]
pub mod bet1v1_solana_program {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, required_stake: u64) -> Result<()> {
        instructions::initialize_config(ctx, required_stake)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        authority: Pubkey,
        chain_authority: Pubkey,
        required_stake: u64,
    ) -> Result<()> {
        instructions::update_config(ctx, authority, chain_authority, required_stake)
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
        kill_value: u64,
    ) -> Result<()> {
        instructions::create_wager(ctx, wager_id, challenger, amount, payout_mode, kill_value)
    }

    pub fn join_wager(ctx: Context<JoinWager>) -> Result<()> {
        instructions::join_wager(ctx)
    }

    pub fn cancel_wager(ctx: Context<CancelWager>) -> Result<()> {
        instructions::cancel_wager(ctx)
    }

    pub fn settle_wager(ctx: Context<SettleWager>) -> Result<()> {
        instructions::settle_wager(ctx)
    }

    pub fn settle_kill(ctx: Context<SettleKill>, killer: Pubkey, sequence: u32) -> Result<()> {
        instructions::settle_kill(ctx, killer, sequence)
    }

    pub fn invalidate_wager(ctx: Context<InvalidateWager>) -> Result<()> {
        instructions::invalidate_wager(ctx)
    }

    pub fn ban_user(ctx: Context<BanUser>) -> Result<()> {
        instructions::ban_user(ctx)
    }
}
