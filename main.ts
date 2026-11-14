// Token Radar (radar-2): the sealed snapshot in, the ranked board and the dashboard out.
//
//   node main.ts [--input snapshot.json]
//
// The input defaults to the sealed path /input/snapshot.json; the output directory comes from
// MAKEFUN_OUTPUT_DIR and defaults to /output. The program writes:
//
//   board.json    the ranked board: every watchlist slug plus every rankable pre-token protocol
//                 below the floor, each with its implied value and its farm plan
//   data.js       the dashboard's dataset (window.RADAR): the board, the live set, the calibration
//                 and the model constants, so the page recomputes every row in place
//   dashboard/    the page itself, copied from the repo's dashboard/
//   screenshots/  the three renders, copied from the repo's screenshots/
//   dossier.json  byte-for-byte what the vendored buildDossier writes from dashboard/ + screenshots/
//
// The run is deterministic: the same snapshot always writes the same bytes (no clock, no random
// numbers, every sort fully tie-broken). The board gate runs before anything is written: a board
// that misses a watchlist slug, misranks a row or carries a bad farm step refuses the run.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** How many bytes of dashboard source the dossier's text may hold. */
const TEXT_MAX_BYTES = 65536;

/** Where the sealed snapshot lives when no --input is given. */
const DEFAULT_INPUT = '/input/snapshot.json';

/** Where the output goes when MAKEFUN_OUTPUT_DIR is not set. */
const DEFAULT_OUTPUT = '/output';

/** The --input value, or the sealed default. */
function inputPath(argv: string[]): string {
  const at = argv.indexOf('--input');
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1] as string;
  return DEFAULT_INPUT;
}

/** The output directory: MAKEFUN_OUTPUT_DIR, or the default. */
function outputDir(): string {
  const env = process.env.MAKEFUN_OUTPUT_DIR;
  return env !== undefined && env.length > 0 ? env : DEFAULT_OUTPUT;
}

/** This script's own directory: dashboard/ and screenshots/ sit beside it. */
function scriptDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Copy a directory tree, file by file, creating the destination as needed. */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

function main(): void {
  const input = inputPath(process.argv.slice(2));
  const out = resolve(outputDir());
  const here = scriptDir();

  if (!existsSync(input)) {
    console.error(`snapshot not found: ${input}`);
    process.exit(1);
  }

  const snapshot = parseSnapshot(readFileSync(input, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    console.error(`board refused: ${issue}`);
    process.exit(1);
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);
  writeFileSync(join(out, 'data.js'), dataScript(radar));

  const dashboardSrc = join(here, 'dashboard');
  const screenshotsSrc = join(here, 'screenshots');
  if (!existsSync(dashboardSrc)) {
    console.error('dashboard/ is missing: the page is what the judge reads');
    process.exit(1);
  }
  const shotCount = existsSync(screenshotsSrc)
    ? readdirSync(screenshotsSrc).filter((f) => !f.startsWith('.')).length
    : 0;
  if (shotCount < 3) {
    console.error(`screenshots/ holds ${shotCount} images: the dossier needs at least 3`);
    process.exit(1);
  }
  copyTree(dashboardSrc, join(out, 'dashboard'));
  copyTree(screenshotsSrc, join(out, 'screenshots'));

  writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES }));

  const dossierBytes = statSync(join(out, 'dossier.json')).size;
  console.log(
    `radar-2: ${board.length} rows (${radar.watchlist_size} watchlist, ${radar.early_size} early), ` +
      `${radar.live_size} live, dossier ${dossierBytes} bytes`,
  );
}

main();
