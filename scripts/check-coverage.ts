import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';

const MIN_LINES_PCT = 65;

function countExecutableLines(source: string): number {
  return source.split('\n').filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith('//')) return false;
    if (t.startsWith('*')) return false;
    if (t === '/*' || t === '*/') return false;
    return true;
  }).length;
}

async function collectSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const f of glob('packages/*/src/**/*.ts')) {
    if (f.endsWith('.d.ts')) continue;
    files.push(resolve(f));
  }
  return files;
}

async function collectLcovFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const f of glob('packages/*/coverage/lcov.info')) files.push(resolve(f));
  return files;
}

function parseLcov(lcovPath: string): Map<string, { lines: Set<number>; covered: Set<number> }> {
  const text = readFileSync(lcovPath, 'utf8');
  const baseDir = dirname(dirname(lcovPath)); // strip /coverage/lcov.info → package root
  const result = new Map<string, { lines: Set<number>; covered: Set<number> }>();
  let currentSF: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      currentSF = resolve(baseDir, line.slice(3));
      if (!result.has(currentSF)) {
        result.set(currentSF, { lines: new Set(), covered: new Set() });
      }
    } else if (line.startsWith('DA:') && currentSF) {
      const comma = line.indexOf(',', 3);
      if (comma === -1) continue;
      const lineNum = Number(line.slice(3, comma));
      const count = Number(line.slice(comma + 1));
      const entry = result.get(currentSF)!;
      entry.lines.add(lineNum);
      if (count > 0) entry.covered.add(lineNum);
    } else if (line.startsWith('end_of_record')) {
      currentSF = null;
    }
  }
  return result;
}

async function check(): Promise<void> {
  const sourceFiles = await collectSourceFiles();
  if (sourceFiles.length === 0) {
    console.error('no source files found');
    process.exit(1);
  }
  const lcovFiles = await collectLcovFiles();
  if (lcovFiles.length === 0) {
    console.error('no lcov files found — run pnpm test:coverage first');
    process.exit(1);
  }
  const coverage = new Map<string, { lines: Set<number>; covered: Set<number> }>();
  for (const lcov of lcovFiles) {
    for (const [path, stats] of parseLcov(lcov)) {
      const existing = coverage.get(path);
      if (existing) {
        for (const l of stats.lines) existing.lines.add(l);
        for (const l of stats.covered) existing.covered.add(l);
      } else {
        coverage.set(path, {
          lines: new Set(stats.lines),
          covered: new Set(stats.covered),
        });
      }
    }
  }

  let totalLines = 0;
  let coveredLines = 0;
  const uncovered: { file: string; lines: number }[] = [];
  for (const src of sourceFiles) {
    const lc = coverage.get(src);
    if (lc && lc.lines.size > 0) {
      totalLines += lc.lines.size;
      coveredLines += lc.covered.size;
    } else {
      const lines = countExecutableLines(readFileSync(src, 'utf8'));
      totalLines += lines;
      uncovered.push({ file: relative(process.cwd(), src), lines });
    }
  }

  const pct = (coveredLines / totalLines) * 100;
  console.log(`Coverage: ${coveredLines}/${totalLines} lines (${pct.toFixed(2)}%)`);
  if (uncovered.length > 0) {
    console.log(`\nUncovered files (${uncovered.length}):`);
    for (const u of uncovered.sort((a, b) => b.lines - a.lines)) {
      console.log(`  ${u.lines.toString().padStart(5)}  ${u.file}`);
    }
  }
  if (pct < MIN_LINES_PCT) {
    console.error(`\nCoverage ${pct.toFixed(2)}% below threshold ${MIN_LINES_PCT}%`);
    process.exit(1);
  }
}

check();
