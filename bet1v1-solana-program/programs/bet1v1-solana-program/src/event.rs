use anchor_lang::prelude::*;

#[event]
pub struct WagerCreatedEvent {
    pub wager_id: u64,
    pub maker: Pubkey,
    pub challenger: Pubkey,
    pub amount: u64,
    pub payout_mode: u8,
    pub increment_value: u64,
}

#[event]
pub struct WagerMatchedEvent {
    pub wager_id: u64,
    pub maker: Pubkey,
    pub opponent: Pubkey,
}

#[event]
pub struct WagerSettledEvent {
    pub wager_id: u64,
    pub winner: Pubkey,
    pub payout: u64,
}

#[event]
pub struct IncrementPaidEvent {
    pub wager_id: u64,
    pub beneficiary: Pubkey,
    pub debited_player: Pubkey,
    pub amount: u64,
    pub sequence: u32,
    pub settled: bool,
}

#[event]
pub struct UserBannedEvent {
    pub user: Pubkey,
    pub slashed_amount: u64,
}
