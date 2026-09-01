use crate::constant::{seeds, INCREMENTAL, MATCHED, SETTLED};
use crate::errors::WagerError;
use crate::event::{IncrementPaidEvent, WagerSettledEvent};
use crate::state::{Config, UserStake, Wager};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct SettleIncrement<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = chain_authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [seeds::WAGER, &wager.wager_id.to_le_bytes()], bump = wager.bump)]
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
    #[account(mut, token::mint = token_mint, constraint = maker_token.owner == wager.maker)]
    pub maker_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = token_mint, constraint = opponent_token.owner == wager.opponent)]
    pub opponent_token: Account<'info, TokenAccount>,
    pub chain_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn settle_increment(
    ctx: Context<SettleIncrement>,
    beneficiary: Pubkey,
    sequence: u32,
) -> Result<()> {
    let wager = &ctx.accounts.wager;
    require!(wager.status == MATCHED, WagerError::WagerNotMatched);
    require!(
        wager.payout_mode == INCREMENTAL,
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
    let wager_id = wager.wager_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[seeds::WAGER, &wager_id, &[wager.bump]];
    let destination = if beneficiary_is_maker {
        ctx.accounts.maker_token.to_account_info()
    } else {
        ctx.accounts.opponent_token.to_account_info()
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.wager_vault.to_account_info(),
                to: destination,
                authority: ctx.accounts.wager.to_account_info(),
            },
            &[signer_seeds],
        ),
        transfer_amount,
    )?;

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
            payout: transfer_amount
        });
    }
    emit!(IncrementPaidEvent {
        wager_id: wager.wager_id,
        beneficiary,
        debited_player,
        amount: payout,
        sequence,
        settled,
    });
    Ok(())
}
