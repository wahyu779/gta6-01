// AZURE BAY — a sun-soaked two-island coastal city joined by a bridge,
// built as an open-world crime game on vendored three.js r160.
// The game is this directory's game/ folder, plain static files a desktop
// browser loads offline (game/index.html and its ES modules, no network
// request), and this program hands it in: it copies game/ and screenshots/
// from beside this file to /output and writes /output/dossier.json, the
// summary the judge reads, with the vendored make.fun library.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Node 22, standard library only — the grader runs `node main.ts`, so no
// Deno APIs anywhere in this file. (That is a hard rule, not a style
// choice: the Deno namespace — env / mkdir / copyFile — throws
// ReferenceError under Node and the entry is rejected before it is judged.)

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const SHOT_MAX_BYTES = 262144; // the scorer's per-screenshot cap

// The four final shots (see shots.json): each must exist and fit the cap.
function listShots() {
  const dir = join(here, 'screenshots');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .sort();
}

function checkShots(names) {
  if (names.length === 0) {
    throw new Error('no screenshots in screenshots/ — take them first (see shots.json)');
  }
  for (const name of names) {
    const bytes = statSync(join(here, 'screenshots', name)).size;
    if (bytes > SHOT_MAX_BYTES) {
      throw new Error(`screenshot ${name} is ${bytes} bytes, over the ${SHOT_MAX_BYTES} byte cap`);
    }
  }
}

// Never remove outDir itself: in the grader /output is a Docker mount
// point and deleting it from inside the container fails EBUSY.
function freshOutput() {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
}

function copyEntry() {
  cpSync(join(here, 'game'), join(outDir, 'game'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  if (existsSync(join(here, 'screenshots'))) {
    cpSync(join(here, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });
  }
}

// Fail fast, with a plain message, when the screenshots are missing or any
// one of them is over the scorer's byte cap: buildDossier would refuse the
// entry anyway, but only after copying the whole game tree.
const shotNames = listShots();
checkShots(shotNames);
freshOutput();
copyEntry();

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes
// the bytes; the others refuse an entry the scorer would refuse (more than
// 4 screenshots or one over 256 KiB; more than 993 files in game/ or
// 48 MiB of game files, in all, or a path under game/ over 1000 bytes:
// game/ counts beside /output's own 1000-entry cap, its screenshots/ and
// dossier.json).
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

console.log(`dossier written to ${join(outDir, 'dossier.json')}`);
