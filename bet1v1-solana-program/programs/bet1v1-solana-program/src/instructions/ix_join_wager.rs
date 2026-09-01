use super::wager_helpers::{match_wager, validate_join};
use crate::constant::seeds;
use crate::event::WagerMatchedEvent;
use crate::state::{Config, UserStake, Wager};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct JoinWager<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = opponent,
        space = 8 + UserStake::INIT_SPACE,
        seeds = [seeds::STAKE, opponent.key().as_ref()],
        bump,
        constraint = opponent_stake.owner == Pubkey::default() || opponent_stake.owner == opponent.key()
    )]
    pub opponent_stake: Account<'info, UserStake>,
    #[account(
        mut,
        seeds = [seeds::WAGER, &wager.wager_id.to_le_bytes()],
        bump = wager.bump
    )]
    pub wager: Account<'info, Wager>,
    #[account(
        mut,
        seeds = [seeds::WAGER_VAULT, &wager.wager_id.to_le_bytes()],
        bump,
        token::mint = token_mint,
        token::authority = wager
    )]
    pub wager_vault: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub token_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = opponent
    )]
    pub opponent_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub opponent: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn join_wager(ctx: Context<JoinWager>) -> Result<()> {
    let opponent_stake = &mut ctx.accounts.opponent_stake;
    validate_join(
        &ctx.accounts.wager,
        ctx.accounts.opponent.key(),
        opponent_stake,
        ctx.bumps.opponent_stake,
        &ctx.accounts.config,
    )?;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.opponent_token.to_account_info(),
                to: ctx.accounts.wager_vault.to_account_info(),
                authority: ctx.accounts.opponent.to_account_info(),
            },
        ),
        ctx.accounts.wager.amount,
    )?;
    match_wager(
        &mut ctx.accounts.wager,
        opponent_stake,
        ctx.accounts.opponent.key(),
    )?;
    emit!(WagerMatchedEvent {
        wager_id: ctx.accounts.wager.wager_id,
        maker: ctx.accounts.wager.maker,
        opponent: ctx.accounts.wager.opponent,
    });
    Ok(())
}
