// Entry driver for markdown-render-speed-02.
//
// The grader runs `node main.ts` (Node 22) with the cases mounted at
// $MAKEFUN_INPUT_DIR (default /input) and expects the rendered HTML at
// $MAKEFUN_OUTPUT_DIR/html.json (default /output): a JSON array of
// strings, one per case, in the same order as cases.json. Each case is
// rendered on its own by parse() from ./parse.js — no state is shared
// between cases, so the output for one case can never leak into another.
//
// Env overrides exist so the same driver can be run outside a container
// for a local check: set MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR to
// point at a directory holding cases.json / to receive html.json.

import { parse } from './parse.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const inputRoot = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputRoot = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const source = readFileSync(join(inputRoot, 'cases.json'), 'utf8');
const cases = JSON.parse(source) as Case[];

const html: string[] = [];
for (const item of cases) {
  html.push(parse(item.markdown));
}

mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, 'html.json'), JSON.stringify(html));
