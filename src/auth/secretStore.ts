import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Turns a plaintext secret (an OAuth refresh token) into an opaque reference safe to store in
 * `storage_connections.token_ref`, and back again. AesSecretStore below is the real, self-hosted
 * default — encryption needs no network access, so unlike a managed key vault it's fully tested here.
 * A cloud deployment can swap in Azure Key Vault or AWS Secrets Manager by implementing this same
 * interface (store the vault's own reference id as the "ciphertext" instead) without changing anything
 * that calls it.
 */
export interface SecretStore {
  encrypt(plaintext: string): string;
  decrypt(ref: string): string;
}

const ALGO = "aes-256-gcm";

/** AES-256-GCM, keyed by a 32-byte key supplied at construction. The ref format is
 *  `<iv>.<authTag>.<ciphertext>`, each part hex-encoded, so it's one opaque string to store. */
export class AesSecretStore implements SecretStore {
  private key: Buffer;

  constructor(keyHex: string) {
    const key = Buffer.from(keyHex, "hex");
    if (key.length !== 32) {
      throw new Error(`SECRET_ENCRYPTION_KEY must be 32 bytes, hex-encoded (64 hex characters) — got ${key.length} bytes. Generate one with: openssl rand -hex 32`);
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString("hex")}.${authTag.toString("hex")}.${ciphertext.toString("hex")}`;
  }

  decrypt(ref: string): string {
    const parts = ref.split(".");
    if (parts.length !== 3) throw new Error("Malformed secret reference.");
    const [ivHex, authTagHex, ciphertextHex] = parts;
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
    return plaintext.toString("utf8");
  }
}
