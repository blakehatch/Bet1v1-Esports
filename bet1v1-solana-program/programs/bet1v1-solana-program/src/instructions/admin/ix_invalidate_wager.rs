use crate::constant::{seeds, CANCELLED, MATCHED};
use crate::errors::WagerError;
use crate::state::{Config, UserStake, Wager};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct InvalidateWager<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [seeds::WAGER, &wager.wager_id.to_le_bytes()],
        bump = wager.bump
    )]
    pub wager: Box<Account<'info, Wager>>,
    #[account(
        mut,
        seeds = [seeds::STAKE, wager.maker.as_ref()],
        bump = maker_stake.bump,
        constraint = maker_stake.owner == wager.maker
    )]
    pub maker_stake: Box<Account<'info, UserStake>>,
    #[account(
        mut,
        seeds = [seeds::STAKE, wager.opponent.as_ref()],
        bump = opponent_stake.bump,
        constraint = opponent_stake.owner == wager.opponent
    )]
    pub opponent_stake: Box<Account<'info, UserStake>>,
    #[account(
        mut,
        seeds = [seeds::WAGER_VAULT, &wager.wager_id.to_le_bytes()],
        bump,
        token::mint = token_mint,
        token::authority = wager
    )]
    pub wager_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.token_mint)]
    pub token_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = token_mint,
        constraint = maker_token.owner == wager.maker
    )]
    pub maker_token: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = token_mint,
        constraint = opponent_token.owner == wager.opponent
    )]
    pub opponent_token: Box<Account<'info, TokenAccount>>,
    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn invalidate_wager(ctx: Context<InvalidateWager>) -> Result<()> {
    require!(
        ctx.accounts.signer.key() == ctx.accounts.config.authority
            || ctx.accounts.signer.key() == ctx.accounts.config.chain_authority,
        WagerError::Unauthorized
    );
    require!(
        ctx.accounts.wager.status == MATCHED,
        WagerError::WagerNotMatched
    );
    let wager_id = ctx.accounts.wager.wager_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[seeds::WAGER, &wager_id, &[ctx.accounts.wager.bump]];
    for (from, to, amount) in [
        (
            ctx.accounts.wager_vault.to_account_info(),
            ctx.accounts.maker_token.to_account_info(),
            ctx.accounts.wager.maker_remaining,
        ),
        (
            ctx.accounts.wager_vault.to_account_info(),
            ctx.accounts.opponent_token.to_account_info(),
            ctx.accounts.wager.opponent_remaining,
        ),
    ] {
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from,
                    to,
                    authority: ctx.accounts.wager.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;
    }
    ctx.accounts.wager.status = CANCELLED;
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
    Ok(())
}
