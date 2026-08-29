use crate::constant::{seeds, CANCELLED, OPEN};
use crate::errors::WagerError;
use crate::event::WagerCreatedEvent;
use crate::state::{Config, UserStake, Wager};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
#[instruction(wager_id: u64)]
pub struct CreateWager<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [seeds::STAKE, maker.key().as_ref()],
        bump = maker_stake.bump,
        constraint = maker_stake.owner == maker.key()
    )]
    pub maker_stake: Account<'info, UserStake>,
    #[account(
        init,
        payer = maker,
        space = 8 + Wager::INIT_SPACE,
        seeds = [seeds::WAGER, &wager_id.to_le_bytes()],
        bump
    )]
    pub wager: Account<'info, Wager>,
    #[account(
        init,
        payer = maker,
        seeds = [seeds::WAGER_VAULT, &wager_id.to_le_bytes()],
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
        token::authority = maker
    )]
    pub maker_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub maker: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn create_wager(
    ctx: Context<CreateWager>,
    wager_id: u64,
    challenger: Pubkey,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, WagerError::InvalidWagerAmount);
    require!(!ctx.accounts.maker_stake.banned, WagerError::UserBanned);
    require!(
        ctx.accounts.maker_stake.amount >= ctx.accounts.config.required_stake,
        WagerError::StakeRequired
    );
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.maker_token.to_account_info(),
                to: ctx.accounts.wager_vault.to_account_info(),
                authority: ctx.accounts.maker.to_account_info(),
            },
        ),
        amount,
    )?;
    let wager = &mut ctx.accounts.wager;
    wager.wager_id = wager_id;
    wager.maker = ctx.accounts.maker.key();
    wager.challenger = challenger;
    wager.opponent = Pubkey::default();
    wager.amount = amount;
    wager.token_mint = ctx.accounts.token_mint.key();
    wager.winner = Pubkey::default();
    wager.status = OPEN;
    wager.bump = ctx.bumps.wager;
    ctx.accounts.maker_stake.active_wagers = ctx
        .accounts
        .maker_stake
        .active_wagers
        .checked_add(1)
        .ok_or(WagerError::MathOverflow)?;
    emit!(WagerCreatedEvent {
        wager_id,
        maker: wager.maker,
        challenger,
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelWager<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [seeds::STAKE, maker.key().as_ref()],
        bump = maker_stake.bump,
        constraint = maker_stake.owner == maker.key()
    )]
    pub maker_stake: Account<'info, UserStake>,
    #[account(
        mut,
        seeds = [seeds::WAGER, &wager.wager_id.to_le_bytes()],
        bump = wager.bump,
        has_one = maker
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
        token::authority = maker
    )]
    pub maker_token: Account<'info, TokenAccount>,
    pub maker: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn cancel_wager(ctx: Context<CancelWager>) -> Result<()> {
    require!(ctx.accounts.wager.status == OPEN, WagerError::WagerNotOpen);
    let wager_id = ctx.accounts.wager.wager_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[seeds::WAGER, &wager_id, &[ctx.accounts.wager.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.wager_vault.to_account_info(),
                to: ctx.accounts.maker_token.to_account_info(),
                authority: ctx.accounts.wager.to_account_info(),
            },
            &[signer_seeds],
        ),
        ctx.accounts.wager.amount,
    )?;
    ctx.accounts.wager.status = CANCELLED;
    ctx.accounts.maker_stake.active_wagers = ctx
        .accounts
        .maker_stake
        .active_wagers
        .checked_sub(1)
        .ok_or(WagerError::MathOverflow)?;
    Ok(())
}
