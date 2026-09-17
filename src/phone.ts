const E164 = /^\+\d{8,15}$/;

/** Normalize a spoken or SIP phone number to E.164 when the digits are usable. */
export function extractE164(value: string): string {
  const plusMatch = value.match(/\+\d{8,15}/);
  if (plusMatch) {
    return plusMatch[0];
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return value.trim();
}

export function isE164(value: string): boolean {
  return E164.test(value);
}
