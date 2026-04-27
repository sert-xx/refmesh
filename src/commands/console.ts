import { spawn } from 'node:child_process';
import { type ConsoleServer, startConsoleServer } from '../console/server.js';
import { openStore } from '../db/store.js';
import { RefmeshValidationError } from '../util/errors.js';
import { stderrLogger } from '../util/logger.js';

export interface ConsoleCommandOptions {
  port: number;
  host: string;
  open: boolean;
}

export const DEFAULT_CONSOLE_HOST = '127.0.0.1';

export function validateConsoleOptions(opts: ConsoleCommandOptions): void {
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new RefmeshValidationError(
      `--port must be an integer in [0, 65535] (got: ${opts.port}).`,
    );
  }
  if (opts.host.length === 0) {
    throw new RefmeshValidationError('--host must not be empty.');
  }
  if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && opts.host !== '::1') {
    // Allow non-loopback bind only when the user explicitly types a public/private IP.
    // We still keep the per-request loopback check, so a non-loopback bind effectively
    // serves nothing — warn loudly rather than fail, in case the operator wants to
    // override the loopback gate by editing source.
    stderrLogger.warn(
      `--host=${opts.host} is non-loopback; remote requests will still be rejected by the server.`,
    );
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // Browser launcher missing — silently ignore; URL is already printed.
    });
    child.unref();
  } catch {
    // ignore: opening a browser is best-effort.
  }
}

export interface ConsoleHandle {
  server: ConsoleServer;
  shutdown(): Promise<void>;
}

export async function executeConsole(opts: ConsoleCommandOptions): Promise<ConsoleHandle> {
  validateConsoleOptions(opts);
  const store = openStore();
  let server: ConsoleServer;
  try {
    server = await startConsoleServer(store, { host: opts.host, port: opts.port });
  } catch (err) {
    store.close();
    throw err;
  }

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    try {
      await server.close();
    } finally {
      store.close();
    }
  };

  return { server, shutdown };
}

export async function runConsoleCommand(opts: ConsoleCommandOptions): Promise<void> {
  const handle = await executeConsole(opts);
  process.stdout.write(`refmesh console listening on ${handle.server.url}\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');
  if (opts.open) {
    openBrowser(handle.server.url);
  }

  // Graceful shutdown sequence:
  //   1. server.close() drains in-flight requests and stops accepting new ones
  //   2. handle.shutdown() closes the SQLite handle (statement cache + db)
  //   3. process.exit short-circuits Node's normal teardown so we don't risk
  //      replaying any close() side effects.
  await new Promise<never>((_resolve) => {
    let stopping = false;
    const stop = (code: number) => {
      if (stopping) return;
      stopping = true;
      void (async () => {
        try {
          await handle.shutdown();
        } catch {
          // best effort
        }
        process.exit(code);
      })();
    };
    process.once('SIGINT', () => stop(130));
    process.once('SIGTERM', () => stop(143));
  });
}
