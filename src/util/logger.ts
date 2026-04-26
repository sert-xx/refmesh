export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const stderrLogger: Logger = {
  info: (msg) => process.stderr.write(`${msg}\n`),
  warn: (msg) => process.stderr.write(`WARN: ${msg}\n`),
  error: (msg) => process.stderr.write(`ERROR: ${msg}\n`),
};
