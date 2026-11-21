import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

export const OPERATOR_EMAIL = "operator@example.com";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
jwk.kid = "test-key";
jwk.alg = "RS256";
jwk.use = "sig";

export const TEST_JWKS = { keys: [jwk] };

export function signIdToken(
  claims: Record<string, unknown>,
  key: KeyObject = privateKey,
): string {
  const header = { alg: "RS256", typ: "JWT", kid: "test-key" };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function operatorIdToken(
  email = OPERATOR_EMAIL,
  overrides: Record<string, unknown> = {},
): string {
  return signIdToken({
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    exp: Math.floor(Date.now() / 1000) + 3600,
    email,
    email_verified: true,
    ...overrides,
  });
}
