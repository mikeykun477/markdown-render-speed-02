// Driver for the markdown renderer: reads every case from
// $MAKEFUN_INPUT_DIR/cases.json (default /input), renders each one alone
// with parse() from parse.js, and writes $MAKEFUN_OUTPUT_DIR/html.json
// (default /output) as a JSON array of the HTML strings, one per case and
// in the cases' order.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
