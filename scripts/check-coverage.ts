import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';

const MIN_LINES_PCT = 10;

async function check() {
  const files: string[] = [];
  for await (const f of glob('packages/*/coverage/lcov.info')) files.push(f);
  if (files.length === 0) {
    console.error('no lcov files found');
    process.exit(1);
  }
  let totalLines = 0;
  let coveredLines = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      if (line.startsWith('LF:')) totalLines += Number(line.slice(3));
      if (line.startsWith('LH:')) coveredLines += Number(line.slice(3));
    }
  }
  const pct = (coveredLines / totalLines) * 100;
  console.log(`Coverage: ${coveredLines}/${totalLines} lines (${pct.toFixed(2)}%)`);
  if (pct < MIN_LINES_PCT) {
    console.error(`Coverage ${pct.toFixed(2)}% below threshold ${MIN_LINES_PCT}%`);
    process.exit(1);
  }
}

check();
