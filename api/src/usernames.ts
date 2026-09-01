import { z } from "zod";

const reservedUsernames = new Set([
  "admin",
  "bet1v1",
  "console",
  "maker",
  "opponent",
  "server"
]);

export const username = z.string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(16, "Username must be 16 characters or fewer")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "Use letters, numbers, underscores, or hyphens; start with a letter or number"
  )
  .refine(
    (value) => !reservedUsernames.has(value.toLowerCase()),
    "That username is reserved"
  );
