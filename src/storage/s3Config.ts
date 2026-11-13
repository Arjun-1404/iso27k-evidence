import { z } from "zod";
import { normalisePrefix, type S3Config } from "./s3.ts";

/**
 * What an organisation administrator types in to connect an S3-compatible service, checked for shape (not for whether the
 * service accepts it: that is `testS3Connection`). The same schema reads the stored copy back, so a stored value that
 * no longer fits (an older release, a damaged row) is noticed rather than half-used.
 */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const s3ConfigSchema = z.object({
  endpoint: z.preprocess(blankToUndefined, z.string().trim().max(300).optional()),
  region: z.string().trim().min(1, "Enter the region (for example us-east-1; many self-run services accept any value).").max(64).regex(/^[A-Za-z0-9-]+$/, "The region may only contain letters, digits and hyphens."),
  bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "The bucket name must be 3–63 characters: lowercase letters, digits, dots and hyphens."),
  accessKeyId: z.string().trim().min(1, "Enter the access key ID.").max(256).regex(/^\S+$/, "The access key ID can't contain spaces."),
  secretAccessKey: z.string().min(1, "Enter the secret access key.").max(512).regex(/^\S+$/, "The secret access key can't contain spaces."),
  forcePathStyle: z.boolean().default(false),
  prefix: z.string().max(200).default(""),
});

export type S3ConfigInput = z.input<typeof s3ConfigSchema>;

/** Input → the config the provider uses, or throws a ZodError / Error with a message for the administrator. */
export function parseS3Config(raw: unknown): S3Config {
  const v = s3ConfigSchema.parse(raw);
  const prefix = normalisePrefix(v.prefix);
  if (prefix === null) throw new Error("The folder inside the bucket can only contain plain folder names separated by /.");
  return { ...(v.endpoint ? { endpoint: v.endpoint } : {}), region: v.region, bucket: v.bucket, accessKeyId: v.accessKeyId, secretAccessKey: v.secretAccessKey, forcePathStyle: v.forcePathStyle, prefix };
}
