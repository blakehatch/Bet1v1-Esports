use anchor_lang::error_code;

#[error_code]
pub enum WagerError {
    #[msg("Invalid wager amount")]
    InvalidWagerAmount,
    #[msg("Invalid wager token")]
    InvalidWagerToken,
    #[msg("Invalid wager id")]
    InvalidWagerId,
    #[msg("Invalid wager")]
    InvalidWager,
    #[msg("Invalid wager maker")]
    InvalidWagerMaker,
    #[msg("Invalid wager participants")]
    InvalidWagerParticipants,
    #[msg("Invalid wager winner")]
    InvalidWagerWinner,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("User is banned")]
    UserBanned,
    #[msg("Required stake is not met")]
    StakeRequired,
    #[msg("Insufficient staked tokens")]
    InsufficientStake,
    #[msg("Stake is locked by an active wager")]
    ActiveWagers,
    #[msg("Wager is not open")]
    WagerNotOpen,
    #[msg("Wager is not matched")]
    WagerNotMatched,
    #[msg("Wager is reserved for another player")]
    WagerReserved,
    #[msg("Math overflow")]
    MathOverflow,
}
