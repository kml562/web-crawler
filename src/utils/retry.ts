import { delay } from "./delay.js";
import { logger } from "./logger.js";

export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 2000
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        const wait = baseDelayMs * Math.pow(2, i);
        logger.warn(`Attempt ${i + 1} failed, retrying in ${wait}ms...`);
        await delay(wait, wait + 500);
      }
    }
  }
  throw lastError;
}
