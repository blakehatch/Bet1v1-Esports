use crate::constant::seeds;
use crate::errors::WagerError;
use crate::state::{Config, UserStake};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct StakeTokens<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserStake::INIT_SPACE,
        seeds = [seeds::STAKE, user.key().as_ref()],
        bump
    )]
    pub stake: Account<'info, UserStake>,
    #[account(
        init_if_needed,
        payer = user,
        seeds = [seeds::STAKE_VAULT, user.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = config
    )]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(address = config.token_mint)]
    pub token_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user
    )]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn stake_tokens(ctx: Context<StakeTokens>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.config.staking_enabled,
        WagerError::StakingDisabled
    );
    require!(amount > 0, WagerError::InvalidWagerAmount);
    let stake = &mut ctx.accounts.stake;
    if stake.owner == Pubkey::default() {
        stake.owner = ctx.accounts.user.key();
        stake.bump = ctx.bumps.stake;
    }
    require!(!stake.banned, WagerError::UserBanned);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token.to_account_info(),
                to: ctx.accounts.stake_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;
    stake.amount = stake
        .amount
        .checked_add(amount)
        .ok_or(WagerError::MathOverflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct UnstakeTokens<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [seeds::STAKE, user.key().as_ref()],
        bump = stake.bump,
        constraint = stake.owner == user.key()
    )]
    pub stake: Account<'info, UserStake>,
    #[account(
        mut,
        seeds = [seeds::STAKE_VAULT, user.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = config
    )]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(address = config.token_mint)]
    pub token_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user
    )]
    pub user_token: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn unstake_tokens(ctx: Context<UnstakeTokens>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.stake.banned, WagerError::UserBanned);
    require!(
        ctx.accounts.stake.active_wagers == 0,
        WagerError::ActiveWagers
    );
    require!(amount > 0, WagerError::InvalidWagerAmount);
    require!(
        ctx.accounts.stake.amount >= amount,
        WagerError::InsufficientStake
    );
    let signer_seeds: &[&[u8]] = &[seeds::CONFIG, &[ctx.accounts.config.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.stake_vault.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
    )?;
    ctx.accounts.stake.amount = ctx
        .accounts
        .stake
        .amount
        .checked_sub(amount)
        .ok_or(WagerError::MathOverflow)?;
    Ok(())
}
