/**
 * Australian phone-number normalisation.
 *
 * Lead lists arrive with numbers written every possible way — "02 4956 1234",
 * "0412 345 678", "+61412345678", "(02) 4956-1234". ElevenLabs needs E.164.
 * Normalising on import also gives duplicate detection for free, since the
 * phone column is UNIQUE.
 */

export interface NormalisedPhone {
  ok: boolean;
  e164?: string;
  reason?: string;
  kind?: "mobile" | "landline";
}

export function normaliseAuPhone(input: string): NormalisedPhone {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, reason: "empty" };

  // Strip everything that isn't a digit or a leading +.
  let digits = raw.replace(/[^\d+]/g, "");

  // 0011 is Australia's international dialling prefix — treat it as "+".
  if (digits.startsWith("0011")) digits = "+" + digits.slice(4);

  if (digits.startsWith("+")) {
    if (!digits.startsWith("+61")) {
      return { ok: false, reason: "not an Australian number" };
    }
    digits = "0" + digits.slice(3);
  } else if (digits.startsWith("61") && digits.length >= 11) {
    digits = "0" + digits.slice(2);
  }

  // At this point we want a 10-digit national number starting with 0.
  if (!digits.startsWith("0")) {
    // Bare 8-digit landline with no area code — can't safely guess the state.
    if (digits.length === 8) {
      return { ok: false, reason: "missing area code" };
    }
    return { ok: false, reason: "unrecognised format" };
  }

  if (digits.length !== 10) {
    return {
      ok: false,
      reason: `expected 10 digits, got ${digits.length}`,
    };
  }

  const isMobile = digits.startsWith("04");
  const isLandline = /^0[2378]/.test(digits);

  if (!isMobile && !isLandline) {
    return { ok: false, reason: `unsupported prefix ${digits.slice(0, 2)}` };
  }

  return {
    ok: true,
    e164: "+61" + digits.slice(1),
    kind: isMobile ? "mobile" : "landline",
  };
}

/** Render E.164 back into readable Australian format for the UI. */
export function formatAuPhone(e164: string): string {
  if (!e164.startsWith("+61")) return e164;
  const national = "0" + e164.slice(3);
  if (national.startsWith("04")) {
    return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
  }
  return `(${national.slice(0, 2)}) ${national.slice(2, 6)} ${national.slice(6)}`;
}
