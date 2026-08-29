use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct UserStake {
    pub owner: Pubkey,
    pub amount: u64,
    pub active_wagers: u32,
    pub banned: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Wager {
    pub wager_id: u64,
    pub maker: Pubkey,
    pub challenger: Pubkey,
    pub opponent: Pubkey,
    pub amount: u64,
    pub token_mint: Pubkey,
    pub winner: Pubkey,
    pub status: u8,
    pub bump: u8,
}
