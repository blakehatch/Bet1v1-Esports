use crate::constant::{seeds, MATCHED, OPEN};
use crate::errors::WagerError;
use crate::event::WagerMatchedEvent;
use crate::state::{Config, UserStake, Wager};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct JoinWager<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [seeds::STAKE, opponent.key().as_ref()],
        bump = opponent_stake.bump,
        constraint = opponent_stake.owner == opponent.key()
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
    #[account(address = config.token_mint)]
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
}

pub fn join_wager(ctx: Context<JoinWager>) -> Result<()> {
    require!(ctx.accounts.wager.status == OPEN, WagerError::WagerNotOpen);
    require_keys_neq!(
        ctx.accounts.wager.maker,
        ctx.accounts.opponent.key(),
        WagerError::InvalidWagerParticipants
    );
    require!(
        ctx.accounts.wager.challenger == Pubkey::default()
            || ctx.accounts.wager.challenger == ctx.accounts.opponent.key(),
        WagerError::WagerReserved
    );
    require!(!ctx.accounts.opponent_stake.banned, WagerError::UserBanned);
    require!(
        ctx.accounts.opponent_stake.amount >= ctx.accounts.config.required_stake,
        WagerError::StakeRequired
    );
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
    ctx.accounts.wager.opponent = ctx.accounts.opponent.key();
    ctx.accounts.wager.status = MATCHED;
    ctx.accounts.opponent_stake.active_wagers = ctx
        .accounts
        .opponent_stake
        .active_wagers
        .checked_add(1)
        .ok_or(WagerError::MathOverflow)?;
    emit!(WagerMatchedEvent {
        wager_id: ctx.accounts.wager.wager_id,
        maker: ctx.accounts.wager.maker,
        opponent: ctx.accounts.wager.opponent,
    });
    Ok(())
}
