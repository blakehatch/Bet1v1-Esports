use super::wager_helpers::{
    increment_active_wagers, match_wager, open_wager, require_wager_access, validate_join,
    validate_wager_terms,
};
use crate::constant::{seeds, CANCELLED, MATCHED, OPEN, SETTLED, WINNER_TAKE_ALL};
use crate::errors::WagerError;
use crate::event::{WagerCreatedEvent, WagerMatchedEvent, WagerSettledEvent};
use crate::state::{Config, UserStake, Wager};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
#[instruction(wager_id: u64)]
pub struct CreateSolWager<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = maker,
        space = 8 + UserStake::INIT_SPACE,
        seeds = [seeds::STAKE, maker.key().as_ref()],
        bump,
        constraint = maker_stake.owner == Pubkey::default() || maker_stake.owner == maker.key()
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
    #[account(mut)]
    pub maker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_sol_wager(
    ctx: Context<CreateSolWager>,
    wager_id: u64,
    challenger: Pubkey,
    amount: u64,
    payout_mode: u8,
    increment_value: u64,
) -> Result<()> {
    validate_wager_terms(amount, payout_mode, increment_value, true)?;
    let maker_stake = &mut ctx.accounts.maker_stake;
    require_wager_access(
        maker_stake,
        ctx.accounts.maker.key(),
        ctx.bumps.maker_stake,
        &ctx.accounts.config,
    )?;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.maker.to_account_info(),
                to: ctx.accounts.wager.to_account_info(),
            },
        ),
        amount,
    )?;
    let wager = &mut ctx.accounts.wager;
    open_wager(
        wager,
        wager_id,
        ctx.accounts.maker.key(),
        challenger,
        amount,
        Pubkey::default(),
        payout_mode,
        increment_value,
        ctx.bumps.wager,
    );
    increment_active_wagers(maker_stake)?;
    emit!(WagerCreatedEvent {
        wager_id,
        maker: wager.maker,
        challenger,
        amount,
        payout_mode,
        increment_value,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct JoinSolWager<'info> {
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
        bump = wager.bump,
        constraint = wager.token_mint == Pubkey::default() @ WagerError::InvalidWagerToken
    )]
    pub wager: Account<'info, Wager>,
    #[account(mut)]
    pub opponent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn join_sol_wager(ctx: Context<JoinSolWager>) -> Result<()> {
    let opponent_stake = &mut ctx.accounts.opponent_stake;
    validate_join(
        &ctx.accounts.wager,
        ctx.accounts.opponent.key(),
        opponent_stake,
        ctx.bumps.opponent_stake,
        &ctx.accounts.config,
    )?;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.opponent.to_account_info(),
                to: ctx.accounts.wager.to_account_info(),
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

#[derive(Accounts)]
pub struct CancelSolWager<'info> {
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
        has_one = maker,
        constraint = wager.token_mint == Pubkey::default() @ WagerError::InvalidWagerToken
    )]
    pub wager: Account<'info, Wager>,
    #[account(mut)]
    pub maker: Signer<'info>,
}

pub fn cancel_sol_wager(ctx: Context<CancelSolWager>) -> Result<()> {
    require!(ctx.accounts.wager.status == OPEN, WagerError::WagerNotOpen);
    let amount = ctx.accounts.wager.amount;
    ctx.accounts.wager.sub_lamports(amount)?;
    ctx.accounts.maker.add_lamports(amount)?;
    ctx.accounts.wager.status = CANCELLED;
    ctx.accounts.maker_stake.active_wagers = ctx
        .accounts
        .maker_stake
        .active_wagers
        .checked_sub(1)
        .ok_or(WagerError::MathOverflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct DeclineSolWager<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = chain_authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [seeds::STAKE, wager.maker.as_ref()], bump = maker_stake.bump, constraint = maker_stake.owner == wager.maker)]
    pub maker_stake: Account<'info, UserStake>,
    #[account(mut, seeds = [seeds::WAGER, &wager.wager_id.to_le_bytes()], bump = wager.bump, constraint = wager.token_mint == Pubkey::default() @ WagerError::InvalidWagerToken)]
    pub wager: Account<'info, Wager>,
    /// CHECK: Address is constrained to the maker and only receives refunded lamports.
    #[account(mut, address = wager.maker)]
    pub maker: UncheckedAccount<'info>,
    pub chain_authority: Signer<'info>,
}

pub fn decline_sol_wager(ctx: Context<DeclineSolWager>) -> Result<()> {
    require!(ctx.accounts.wager.status == OPEN, WagerError::WagerNotOpen);
    require!(
        ctx.accounts.wager.challenger != Pubkey::default(),
        WagerError::WagerNotReserved
    );
    let amount = ctx.accounts.wager.amount;
    ctx.accounts.wager.sub_lamports(amount)?;
    ctx.accounts.maker.add_lamports(amount)?;
    ctx.accounts.wager.status = CANCELLED;
    ctx.accounts.wager.maker_remaining = 0;
    ctx.accounts.maker_stake.active_wagers = ctx
        .accounts
        .maker_stake
        .active_wagers
        .checked_sub(1)
        .ok_or(WagerError::MathOverflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct SettleSolWager<'info> {
    #[account(
        seeds = [seeds::CONFIG],
        bump = config.bump,
        has_one = chain_authority
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [seeds::WAGER, &wager.wager_id.to_le_bytes()],
        bump = wager.bump,
        constraint = wager.token_mint == Pubkey::default() @ WagerError::InvalidWagerToken
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
    #[account(mut)]
    pub winner: SystemAccount<'info>,
    pub chain_authority: Signer<'info>,
}

pub fn settle_sol_wager(ctx: Context<SettleSolWager>) -> Result<()> {
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
    ctx.accounts.wager.sub_lamports(payout)?;
    ctx.accounts.winner.add_lamports(payout)?;
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

#[derive(Accounts)]
pub struct SettleSolIncrement<'info> {
    #[account(
        seeds = [seeds::CONFIG],
        bump = config.bump,
        has_one = chain_authority
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [seeds::WAGER, &wager.wager_id.to_le_bytes()],
        bump = wager.bump,
        constraint = wager.token_mint == Pubkey::default() @ WagerError::InvalidWagerToken
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
    /// CHECK: Address is constrained to the wager maker and only receives lamports.
    #[account(mut, address = wager.maker)]
    pub maker: UncheckedAccount<'info>,
    /// CHECK: Address is constrained to the wager opponent and only receives lamports.
    #[account(mut, address = wager.opponent)]
    pub opponent: UncheckedAccount<'info>,
    pub chain_authority: Signer<'info>,
}

pub fn settle_sol_increment(
    ctx: Context<SettleSolIncrement>,
    beneficiary: Pubkey,
    sequence: u32,
) -> Result<()> {
    let wager = &ctx.accounts.wager;
    require!(wager.status == MATCHED, WagerError::WagerNotMatched);
    require!(
        wager.payout_mode == crate::constant::INCREMENTAL,
        WagerError::InvalidPayoutMode
    );
    require!(
        beneficiary == wager.maker || beneficiary == wager.opponent,
        WagerError::InvalidWagerWinner
    );
    let expected_sequence = wager
        .maker_score
        .checked_add(wager.opponent_score)
        .and_then(|value| value.checked_add(1))
        .ok_or(WagerError::MathOverflow)?;
    require!(
        sequence == expected_sequence,
        WagerError::InvalidScoreSequence
    );

    let beneficiary_is_maker = beneficiary == wager.maker;
    let debited_player = if beneficiary_is_maker {
        wager.opponent
    } else {
        wager.maker
    };
    let debited_remaining = if beneficiary_is_maker {
        wager.opponent_remaining
    } else {
        wager.maker_remaining
    };
    let beneficiary_remaining = if beneficiary_is_maker {
        wager.maker_remaining
    } else {
        wager.opponent_remaining
    };
    let payout = wager.increment_value.min(debited_remaining);
    require!(payout > 0, WagerError::InvalidIncrementValue);
    let settled = payout == debited_remaining;
    let transfer_amount = if settled {
        payout
            .checked_add(beneficiary_remaining)
            .ok_or(WagerError::MathOverflow)?
    } else {
        payout
    };
    ctx.accounts.wager.sub_lamports(transfer_amount)?;
    if beneficiary_is_maker {
        ctx.accounts.maker.add_lamports(transfer_amount)?;
    } else {
        ctx.accounts.opponent.add_lamports(transfer_amount)?;
    }

    let wager = &mut ctx.accounts.wager;
    if beneficiary_is_maker {
        wager.maker_score = wager
            .maker_score
            .checked_add(1)
            .ok_or(WagerError::MathOverflow)?;
        wager.opponent_remaining = wager
            .opponent_remaining
            .checked_sub(payout)
            .ok_or(WagerError::MathOverflow)?;
    } else {
        wager.opponent_score = wager
            .opponent_score
            .checked_add(1)
            .ok_or(WagerError::MathOverflow)?;
        wager.maker_remaining = wager
            .maker_remaining
            .checked_sub(payout)
            .ok_or(WagerError::MathOverflow)?;
    }
    if settled {
        wager.maker_remaining = 0;
        wager.opponent_remaining = 0;
        wager.winner = beneficiary;
        wager.status = SETTLED;
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
            wager_id: wager.wager_id,
            winner: beneficiary,
            payout: transfer_amount,
        });
    }
    emit!(crate::event::IncrementPaidEvent {
        wager_id: wager.wager_id,
        beneficiary,
        debited_player,
        amount: payout,
        sequence,
        settled,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InvalidateSolWager<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [seeds::WAGER, &wager.wager_id.to_le_bytes()],
        bump = wager.bump,
        constraint = wager.token_mint == Pubkey::default() @ WagerError::InvalidWagerToken
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
    /// CHECK: Address is constrained to the wager maker and only receives lamports.
    #[account(mut, address = wager.maker)]
    pub maker: UncheckedAccount<'info>,
    /// CHECK: Address is constrained to the wager opponent and only receives lamports.
    #[account(mut, address = wager.opponent)]
    pub opponent: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

pub fn invalidate_sol_wager(ctx: Context<InvalidateSolWager>) -> Result<()> {
    require!(
        ctx.accounts.signer.key() == ctx.accounts.config.authority
            || ctx.accounts.signer.key() == ctx.accounts.config.chain_authority,
        WagerError::Unauthorized
    );
    require!(
        ctx.accounts.wager.status == MATCHED,
        WagerError::WagerNotMatched
    );
    let maker_refund = ctx.accounts.wager.maker_remaining;
    let opponent_refund = ctx.accounts.wager.opponent_remaining;
    ctx.accounts.wager.sub_lamports(maker_refund)?;
    ctx.accounts.maker.add_lamports(maker_refund)?;
    ctx.accounts.wager.sub_lamports(opponent_refund)?;
    ctx.accounts.opponent.add_lamports(opponent_refund)?;
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
