use crate::constant::seeds;
use crate::errors::WagerError;
use crate::state::Config;
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [seeds::CONFIG],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub chain_authority: Signer<'info>,
    pub token_mint: Account<'info, Mint>,
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    required_stake: u64,
    staking_enabled: bool,
) -> Result<()> {
    require!(
        !staking_enabled || required_stake > 0,
        WagerError::InvalidWagerAmount
    );
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.chain_authority = ctx.accounts.chain_authority.key();
    config.token_mint = ctx.accounts.token_mint.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.required_stake = required_stake;
    config.staking_enabled = staking_enabled;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [seeds::CONFIG],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

pub fn update_config(
    ctx: Context<UpdateConfig>,
    authority: Pubkey,
    chain_authority: Pubkey,
    required_stake: u64,
    staking_enabled: bool,
) -> Result<()> {
    require!(
        !staking_enabled || required_stake > 0,
        WagerError::InvalidWagerAmount
    );
    let config = &mut ctx.accounts.config;
    config.authority = authority;
    config.chain_authority = chain_authority;
    config.required_stake = required_stake;
    config.staking_enabled = staking_enabled;
    Ok(())
}
