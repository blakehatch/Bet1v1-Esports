use crate::constant::{seeds, MATCHED, SETTLED, WINNER_TAKE_ALL};
use crate::errors::WagerError;
use crate::event::WagerSettledEvent;
use crate::state::{Config, UserStake, Wager};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct SettleWager<'info> {
    #[account(
        seeds = [seeds::CONFIG],
        bump = config.bump,
        has_one = chain_authority
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [seeds::WAGER, &wager.wager_id.to_le_bytes()],
        bump = wager.bump
    )]
    pub wager: Account<'info, Wager>,
    #[account(
        mut,
        seeds = [seeds::STAKE, wager.maker.as_ref()],
        bump = maker_stake.bump,
        constraint = maker_stake.owner == wager.maker
    )]
    pub maker_stake: Account<'info, UserStake>,
    #[account(
        mut,
        seeds = [seeds::STAKE, wager.opponent.as_ref()],
        bump = opponent_stake.bump,
        constraint = opponent_stake.owner == wager.opponent
    )]
    pub opponent_stake: Account<'info, UserStake>,
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
        constraint = winner_token.owner == winner.key()
    )]
    pub winner_token: Account<'info, TokenAccount>,
    pub winner: SystemAccount<'info>,
    pub chain_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn settle_wager(ctx: Context<SettleWager>) -> Result<()> {
    require!(
        ctx.accounts.wager.status == MATCHED,
        WagerError::WagerNotMatched
    );
    require!(
        ctx.accounts.wager.payout_mode == WINNER_TAKE_ALL,
        WagerError::InvalidPayoutMode
    );
    require!(
        ctx.accounts.winner.key() == ctx.accounts.wager.maker
            || ctx.accounts.winner.key() == ctx.accounts.wager.opponent,
        WagerError::InvalidWagerWinner
    );
    let payout = ctx
        .accounts
        .wager
        .amount
        .checked_mul(2)
        .ok_or(WagerError::MathOverflow)?;
    let wager_id = ctx.accounts.wager.wager_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[seeds::WAGER, &wager_id, &[ctx.accounts.wager.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.wager_vault.to_account_info(),
                to: ctx.accounts.winner_token.to_account_info(),
                authority: ctx.accounts.wager.to_account_info(),
            },
            &[signer_seeds],
        ),
        payout,
    )?;
    ctx.accounts.wager.winner = ctx.accounts.winner.key();
    ctx.accounts.wager.status = SETTLED;
    ctx.accounts.wager.maker_remaining = 0;
    ctx.accounts.wager.opponent_remaining = 0;
    ctx.accounts.maker_stake.active_wagers = ctx
        .accounts
        .maker_stake
        .active_wagers
        .checked_sub(1)
        .ok_or(WagerError::MathOverflow)?;
    ctx.accounts.opponent_stake.active_wagers = ctx
        .accounts
        .opponent_stake
        .active_wagers
        .checked_sub(1)
        .ok_or(WagerError::MathOverflow)?;
    emit!(WagerSettledEvent {
        wager_id: ctx.accounts.wager.wager_id,
        winner: ctx.accounts.winner.key(),
        payout,
    });
    Ok(())
}
