import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function createIntegrationSecrets(serialized: string) {
  const key = Buffer.from(serialized, "base64");
  if (key.length !== 32 || key.toString("base64") !== serialized)
    throw new Error("INVALID_INTEGRATION_ENCRYPTION_KEY");
  return {
    encrypt(context: string, value: string): string {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`jrc-integrations:v1:${context}`));
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    },
    decrypt(context: string, value: string): string {
      try {
        const [version, nonce, tag, ciphertext, extra] = value.split(".");
        if (version !== "v1" || !nonce || !tag || !ciphertext || extra)
          throw new Error();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(nonce, "base64url"),
        );
        decipher.setAAD(Buffer.from(`jrc-integrations:v1:${context}`));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("INTEGRATION_SECRET_UNAVAILABLE");
      }
    },
  };
}
export function verifyChatwootSignature(
  secret: string,
  raw: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  now = Date.now(),
): boolean {
  if (
    !timestamp ||
    !/^\d{10,12}$/u.test(timestamp) ||
    !signature ||
    !/^sha256=[a-f0-9]{64}$/u.test(signature)
  )
    return false;
  if (Math.abs(now - Number(timestamp) * 1000) > 300_000) return false;
  const expected = createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(raw)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
