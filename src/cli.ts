#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import {
  executeArchive,
  executePrune,
  executeUnarchive,
  renderArchiveResult,
  renderPruneResult,
  renderUnarchiveResult,
} from './commands/archive.js';
import { runConsoleCommand } from './commands/console.js';
import {
  executeRegister,
  parseAndValidate,
  readRegisterInput,
  renderRegisterSummary,
} from './commands/register.js';
import {
  type SearchOptions,
  executeSearch,
  renderSearchJson,
  renderSearchText,
} from './commands/search.js';
import { runTypesCommand } from './commands/types.js';
import { openHybridStores } from './db/connection.js';
import { RefmeshRuntimeError, RefmeshValidationError } from './util/errors.js';
import { stderrLogger } from './util/logger.js';

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, '../package.json'), join(here, '../../package.json')];
    for (const path of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // try next
      }
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

function handleError(err: unknown): never {
  if (err instanceof RefmeshValidationError) {
    stderrLogger.error(err.message);
    for (const d of err.details) {
      stderrLogger.error(`  - ${d}`);
    }
    process.exit(2);
  }
  if (err instanceof RefmeshRuntimeError) {
    stderrLogger.error(err.message);
    process.exit(1);
  }
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  stderrLogger.error(`Unexpected error: ${msg}`);
  process.exit(1);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('refmesh')
    .description(
      'Knowledge graph construction CLI for autonomous coding agents. Stores Concepts and References as a Kùzu graph DB.',
    )
    .version(readPackageVersion(), '-v, --version');

  program
    .command('types')
    .description('Print available edge types and the register input JSON schema.')
    .option('--format <format>', 'Output format: text | json', 'text')
    .action(async (opts: { format: string }) => {
      try {
        const format = opts.format === 'json' ? 'json' : 'text';
        process.stdout.write(`${runTypesCommand({ format })}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command('register')
    .description('Register knowledge JSON (from stdin or -f <path>) into the graph DB.')
    .option('-f, --file <path>', 'Read JSON from a file instead of stdin')
    .action(async (opts: { file?: string }) => {
      try {
        const raw = await readRegisterInput({ file: opts.file });
        const input = parseAndValidate(raw);
        const stores = await openHybridStores();
        const summary = await executeRegister(stores, input);
        process.stdout.write(`${renderRegisterSummary(summary)}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command('search')
    .description(
      'Search concepts by natural-language query (vector) and traverse related nodes (graph).',
    )
    .argument('<query>', 'natural-language query (embedded into a vector for semantic search)')
    .option('--depth <n>', 'Traversal depth from matched concepts', '1')
    .option('--limit <n>', 'Maximum number of matched concepts from vector search', '5')
    .option('--threshold <value>', 'Minimum cosine similarity [0,1] for matched concepts', '0.3')
    .option(
      '--freshness-weight <value>',
      'Weight of freshness in the final score [0,1] (0 = ignore time)',
      '0',
    )
    .option('--half-life <days>', 'Half-life of freshness decay in days', '180')
    .option('--max-age <days>', 'Exclude concepts older than this many days')
    .option(
      '--demote-deprecated <value>',
      'Multiplier applied to concepts targeted by DEPRECATES/REPLACES (0 = exclude, 1 = no penalty)',
      '0.5',
    )
    .option(
      '--reinforcement-weight <value>',
      'Weight of access-count reinforcement [0,1] (must satisfy freshness + reinforcement <= 1)',
      '0',
    )
    .option('--include-archived', 'Include archived concepts in results', false)
    .option('--format <format>', 'Output format: text | json', 'text')
    .action(
      async (
        query: string,
        opts: {
          depth: string;
          limit: string;
          threshold: string;
          freshnessWeight: string;
          halfLife: string;
          maxAge?: string;
          demoteDeprecated: string;
          reinforcementWeight: string;
          includeArchived: boolean;
          format: string;
        },
      ) => {
        try {
          const options: SearchOptions = {
            depth: Number.parseInt(opts.depth, 10),
            limit: Number.parseInt(opts.limit, 10),
            threshold: Number.parseFloat(opts.threshold),
            freshnessWeight: Number.parseFloat(opts.freshnessWeight),
            halfLifeDays: Number.parseFloat(opts.halfLife),
            maxAgeDays: opts.maxAge !== undefined ? Number.parseFloat(opts.maxAge) : undefined,
            demoteDeprecated: Number.parseFloat(opts.demoteDeprecated),
            reinforcementWeight: Number.parseFloat(opts.reinforcementWeight),
            includeArchived: opts.includeArchived,
            format: opts.format === 'json' ? 'json' : 'text',
          };
          const stores = await openHybridStores();
          const result = await executeSearch(stores, query, options);
          const output =
            options.format === 'json' ? renderSearchJson(result) : renderSearchText(result);
          process.stdout.write(`${output}\n`);
        } catch (err) {
          handleError(err);
        }
      },
    );

  program
    .command('archive')
    .description('Archive a Concept (logical hide; excluded from search by default).')
    .argument('<id>', 'Concept id to archive')
    .option('--reason <text>', 'Reason for archiving (free text)')
    .action(async (id: string, opts: { reason?: string }) => {
      try {
        const stores = await openHybridStores();
        const result = await executeArchive(stores, id, { reason: opts.reason });
        process.stdout.write(`${renderArchiveResult(result)}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command('unarchive')
    .description('Unarchive a previously archived Concept.')
    .argument('<id>', 'Concept id to unarchive')
    .action(async (id: string) => {
      try {
        const stores = await openHybridStores();
        const result = await executeUnarchive(stores, id);
        process.stdout.write(`${renderUnarchiveResult(result)}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command('prune')
    .description(
      'Delete stale Concepts (lastSeenAt older than cutoff and touchCount below threshold). Dry-run by default.',
    )
    .requiredOption('--older-than <days>', 'Age threshold in days (lastSeenAt < now - N days)')
    .option('--max-touches <n>', 'Only prune concepts touched at most this many times', '1')
    .option('--include-archived', 'Also prune archived concepts', false)
    .option('--apply', 'Actually delete instead of dry-run', false)
    .action(
      async (opts: {
        olderThan: string;
        maxTouches: string;
        includeArchived: boolean;
        apply: boolean;
      }) => {
        try {
          const stores = await openHybridStores();
          const result = await executePrune(stores, {
            olderThanDays: Number.parseFloat(opts.olderThan),
            maxTouches: Number.parseInt(opts.maxTouches, 10),
            includeArchived: opts.includeArchived,
            apply: opts.apply,
          });
          process.stdout.write(`${renderPruneResult(result)}\n`);
        } catch (err) {
          handleError(err);
        }
      },
    );

  program
    .command('console')
    .description(
      'Start a local read-only dashboard to inspect the graph DB in a browser (loopback only).',
    )
    .option('--port <n>', 'Port to bind (0 = auto-pick a free port)', '0')
    .option(
      '--host <host>',
      'Host to bind (default 127.0.0.1; loopback enforced per-request)',
      '127.0.0.1',
    )
    .option('--no-open', 'Do not open a browser automatically')
    .action(async (opts: { port: string; host: string; open: boolean }) => {
      try {
        await runConsoleCommand({
          port: Number.parseInt(opts.port, 10),
          host: opts.host,
          open: opts.open,
        });
      } catch (err) {
        handleError(err);
      }
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}

// Allow: (a) direct execution as `node dist/cli.js` and (b) npm bin invocation.
// `npm install -g` exposes `refmesh` as a symlink, so process.argv[1] points at
// the symlink path while import.meta.url resolves to the real file. Resolve both
// through realpath before comparing to avoid a silent no-op when run via the bin.
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    const resolvedArgv = realpathSync(process.argv[1]);
    const resolvedSelf = fileURLToPath(import.meta.url);
    return resolvedArgv === resolvedSelf;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch(handleError);
}
