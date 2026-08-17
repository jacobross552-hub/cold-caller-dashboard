/**
 * Single-user password login.
 *
 * The dashboard can spend real money (the "start calling" button bills Twilio
 * and ElevenLabs) and holds prospect names and phone numbers, so it is never
 * served without a session cookie.
 *
 * Uses Web Crypto rather than node:crypto so the same code runs in both the
 * middleware (edge runtime) and normal route handlers.
 */

const COOKIE_NAME = "ccd_session";
const SESSION_DAYS = 30;

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(sig));
}

/** Constant-time comparison, so a wrong cookie can't be brute-forced by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(secret: string): Promise<string> {
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({ exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 }),
    ),
  );
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expected = await sign(payload, secret);
  if (!timingSafeEqual(signature, expected)) return false;

  try {
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

/** Compare the submitted password without leaking length via timing. */
export async function passwordMatches(
  submitted: string,
  expected: string,
): Promise<boolean> {
  const key = await hmacKey("password-compare");
  const digest = async (value: string) =>
    b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
  return timingSafeEqual(await digest(submitted), await digest(expected));
}

export { COOKIE_NAME, SESSION_DAYS };
