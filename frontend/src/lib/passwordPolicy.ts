/**
 * Mirror of backend/services/user-service/src/lib/passwordPolicy.ts (E1-1
 * AC3), for live feedback while typing. The backend is the source of
 * truth and re-checks on submit — keep the two in step when the rule
 * changes.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_RULE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include at least one letter and one number.`;

export interface PasswordRequirement {
  label: string;
  met: boolean;
}

/** Each part of the rule separately, so the form can tick them off as they're met. */
export function passwordRequirements(password: string): PasswordRequirement[] {
  return [
    { label: `At least ${PASSWORD_MIN_LENGTH} characters`, met: [...password].length >= PASSWORD_MIN_LENGTH },
    { label: "At least one letter", met: /\p{L}/u.test(password) },
    { label: "At least one number", met: /\p{N}/u.test(password) },
  ];
}

export function passwordTooLong(password: string): boolean {
  return new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES;
}
