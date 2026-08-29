use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub chain_authority: Pubkey,
    pub token_mint: Pubkey,
    pub required_stake: u64,
    pub bump: u8,
}
