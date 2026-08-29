use crate::constant::seeds;
use crate::event::UserBannedEvent;
use crate::state::{Config, UserStake};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct BanUser<'info> {
    #[account(
        seeds = [seeds::CONFIG],
        bump = config.bump,
        has_one = authority
    )]
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
    #[account(mut, token::mint = token_mint)]
    pub treasury_token: Account<'info, TokenAccount>,
    pub user: SystemAccount<'info>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn ban_user(ctx: Context<BanUser>) -> Result<()> {
    let amount = ctx.accounts.stake.amount;
    let signer_seeds: &[&[u8]] = &[seeds::CONFIG, &[ctx.accounts.config.bump]];
    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.treasury_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;
    }
    ctx.accounts.stake.amount = 0;
    ctx.accounts.stake.banned = true;
    emit!(UserBannedEvent {
        user: ctx.accounts.user.key(),
        slashed_amount: amount,
    });
    Ok(())
}
