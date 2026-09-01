export const hasPlatformAccess = (
  amount: bigint,
  requiredStake: bigint,
  banned: boolean,
  stakingEnabled: boolean
) => !banned && (!stakingEnabled || amount >= requiredStake);
