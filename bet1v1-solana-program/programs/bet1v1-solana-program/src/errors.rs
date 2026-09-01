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
    #[msg("Staking is disabled")]
    StakingDisabled,
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
    #[msg("Wager is not a reserved challenge")]
    WagerNotReserved,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid payout mode")]
    InvalidPayoutMode,
    #[msg("Invalid incremental payout value")]
    InvalidIncrementValue,
    #[msg("Invalid score sequence")]
    InvalidScoreSequence,
}
