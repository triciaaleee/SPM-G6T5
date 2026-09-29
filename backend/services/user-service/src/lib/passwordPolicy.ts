/**
 * E1-1 AC3 password strength rule (issue #8). Team-chosen — the customer
 * gave no requirement. The check and the sentence that states it live
 * side by side so the message the user reads can't drift from what's
 * actually enforced.
 *
 * The frontend mirrors this rule for live feedback
 * (frontend/src/lib/passwordPolicy.ts), but this file is the source of
 * truth: any change here must be copied there.
 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * bcrypt only hashes the first 72 bytes and silently ignores the rest, so
 * a longer password would give a false sense of strength — two passwords
 * sharing their first 72 bytes would both unlock the account.
 */
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_RULE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include at least one letter and one number.`;

export const PASSWORD_TOO_LONG = `Password must be at most ${PASSWORD_MAX_BYTES} characters.`;

/** Returns the message to show the user, or null if the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    return PASSWORD_TOO_LONG;
  }
  const meetsRule =
    [...password].length >= PASSWORD_MIN_LENGTH && /\p{L}/u.test(password) && /\p{N}/u.test(password);
  return meetsRule ? null : PASSWORD_RULE;
}
