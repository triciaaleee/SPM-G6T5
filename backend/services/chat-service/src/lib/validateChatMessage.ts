// E2-15: validation for POST /api/chat/:eventId/messages.

const MAX_BODY_LENGTH = 2000;

export interface ValidationResult {
  valid: boolean;
  error?: string;
  value?: string;
}

export function validateMessageBody(input: unknown): ValidationResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { valid: false, error: "Message cannot be empty." };
  }
  const trimmed = input.trim();
  if (trimmed.length > MAX_BODY_LENGTH) {
    return { valid: false, error: `Message is too long (max ${MAX_BODY_LENGTH} characters).` };
  }
  return { valid: true, value: trimmed };
}
