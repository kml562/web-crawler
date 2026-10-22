const reset = "\x1b[0m";
const colors = {
  info: "\x1b[36m",    // cyan
  success: "\x1b[32m", // green
  warn: "\x1b[33m",    // yellow
  error: "\x1b[31m",   // red
};

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

export const logger = {
  info(msg: string) {
    console.log(`${colors.info}[${timestamp()}] INFO${reset}  ${msg}`);
  },
  success(msg: string) {
    console.log(`${colors.success}[${timestamp()}] OK${reset}    ${msg}`);
  },
  warn(msg: string) {
    console.warn(`${colors.warn}[${timestamp()}] WARN${reset}  ${msg}`);
  },
  error(msg: string, err?: unknown) {
    console.error(`${colors.error}[${timestamp()}] ERROR${reset} ${msg}`);
    if (err instanceof Error) console.error("  ", err.message);
  },
};
