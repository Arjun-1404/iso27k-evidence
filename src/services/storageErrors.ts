import { AppError } from "../errors.ts";
import { StorageError } from "../storage/types.ts";

/** Runs a storage call and turns a provider failure into a clean HTTP-shaped AppError. Anything that is
 *  already an AppError (e.g. "your org must reconnect Drive") passes straight through untouched. */
export async function withStorageErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StorageError) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "ALREADY_EXISTS" ? 409 : e.code === "PERMISSION_DENIED" ? 502 : e.retryable ? 503 : 502;
      throw new AppError(`Storage error: ${e.message}`, status, `STORAGE_${e.code}`);
    }
    throw e;
  }
}
