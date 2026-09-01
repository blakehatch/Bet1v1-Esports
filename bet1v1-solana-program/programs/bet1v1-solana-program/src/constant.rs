pub const OPEN: u8 = 0;
pub const MATCHED: u8 = 1;
pub const SETTLED: u8 = 2;
pub const CANCELLED: u8 = 3;
pub const WINNER_TAKE_ALL: u8 = 0;
pub const INCREMENTAL: u8 = 1;

pub mod seeds {
    pub const CONFIG: &[u8] = b"config";
    pub const STAKE: &[u8] = b"stake";
    pub const STAKE_VAULT: &[u8] = b"stake_vault";
    pub const WAGER: &[u8] = b"wager";
    pub const WAGER_VAULT: &[u8] = b"wager_vault";
}
