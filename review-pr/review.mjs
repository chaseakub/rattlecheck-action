import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileAnnotation } from '../run.mjs';

export function scannerPackage(version = 'latest') {
  if (version !== 'latest' && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error('rattlecheck-version must be latest or an exact stable npm version (for example, 1.2.3).');
  }
  return `rattlecheck@${version}`;
}

function git(repo, args) {
  return execFileSync('git', ['--literal-pathspecs', '-C', repo, ...args], { maxBuffer: 32 * 1024 * 1024 });
}

function relativePath(value) {
  if (!value || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.split('/').includes('..')) {
    throw new Error('Expected a normalized repository-relative path.');
  }
  return value;
}

// Read tracked blobs only. Each snapshot has exactly the layout the CLI expects.
export function snapshot(repo, revision, { migrations, overlay, config }) {
  const dirs = [relativePath(migrations)];
  if (overlay) dirs.push(relativePath(overlay));
  const scannerConfig = 'rattlecheck.config.json';
  const tree = git(repo, ['ls-tree', '-rz', '--full-tree', revision, '--', ...dirs, relativePath(config), scannerConfig]);
  const entries = new Map();
  for (const record of tree.toString().split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, , oid] = record.slice(0, tab).split(' ');
    const source = record.slice(tab + 1);
    entries.set(source, { mode, oid, source });
  }
  const selected = new Map();
  function add(destination, entry) {
    if (!['100644', '100755'].includes(entry.mode)) throw new Error('Migration inputs must be regular files.');
    selected.set(destination, entry);
  }
  for (const dir of dirs) {
    if (entries.has(dir)) throw new Error('Expected a migration directory, found a file or link.');
    for (const entry of entries.values()) {
      if (path.posix.dirname(entry.source) === dir && entry.source.endsWith('.sql')) {
        add('supabase/migrations/' + path.posix.basename(entry.source), entry);
      }
    }
  }
  if (entries.has(config)) add('supabase/config.toml', entries.get(config));
  if (entries.has(scannerConfig)) add(scannerConfig, entries.get(scannerConfig));
  return selected;
}

const severity = { warning: 0, high: 1, critical: 2 };
const key = f => JSON.stringify([f.rule, f.object, f.name, f.detail, f.message]);

export function newFindings(before, after) {
  const ranks = new Map();
  for (const f of before) ranks.set(key(f), Math.max(ranks.get(key(f)) ?? 0, severity[f.severity] ?? 0));
  return after.filter(f => (severity[f.severity] ?? 0) > (ranks.get(key(f)) ?? 0));
}

function readReport(repo, temp, side, selected, cli, env) {
  const root = path.join(temp, side);
  for (const [dest, entry] of selected) {
    const target = path.join(root, dest);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, git(repo, ['cat-file', 'blob', entry.oid]));
  }
  if (![...selected.keys()].some(f => f.endsWith('.sql'))) {
    if (side === 'base') return { findings: [] };
    throw new Error('The proposed migration directory contains no SQL.');
  }
  const reportFile = path.join(temp, side + '.json');
  const run = spawnSync(process.execPath, [cli, root, '--json', '--out', reportFile], { cwd: temp, env });
  if (![0, 1].includes(run.status) && !(side === 'base' && run.status === 3)) {
    throw new Error('RattleCheck could not complete the ' + side + ' review (exit ' + run.status + ').');
  }
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  if (report.schema !== 'rattlecheck.report/v1' || !Array.isArray(report.findings)) throw new Error('Unexpected RattleCheck report.');
  if (side === 'proposed' && !(report.coverage.ok && report.doors.checked > 0)) throw new Error('No reviewable objects in proposed SQL.');
  return report;
}

function main() {
  const { GITHUB_WORKSPACE: repo, PR_EVENT, PR_BASE, RUNNER_TEMP, MIGRATIONS, OVERLAY, SUPABASE_CONFIG } = process.env;
  if (PR_EVENT !== 'pull_request' || !/^[a-f0-9]{40}$/.test(PR_BASE)) throw new Error('Use this action on a pull_request event.');
  const packageSpec = scannerPackage(process.env.RATTLECHECK_VERSION);
  const layout = { migrations: MIGRATIONS, overlay: OVERLAY, config: SUPABASE_CONFIG };
  const base = snapshot(repo, PR_BASE, layout);
  const proposed = snapshot(repo, 'HEAD', layout);
  if (base.size === proposed.size && [...base].every(([name, f]) => proposed.get(name)?.oid === f.oid)) {
    console.log('No changes to this migration history or its configuration.');
    return 0;
  }
  const temp = mkdtempSync(path.join(RUNNER_TEMP, 'rattlecheck-pr-'));
  try {
    const env = { PATH: process.env.PATH, HOME: temp };
    console.log('Installing %s from npm.', packageSpec);
    execFileSync('npm', ['install', '--prefix', temp, '--registry=https://registry.npmjs.org/', '--ignore-scripts',
      '--no-audit', '--no-fund', '--no-save', '--no-package-lock', packageSpec], { cwd: temp, env, stdio: 'pipe' });
    const cli = path.join(temp, 'node_modules/rattlecheck/bin/rattlecheck.js');
    const before = readReport(repo, temp, 'base', base, cli, env);
    const after = readReport(repo, temp, 'proposed', proposed, cli, env);
    const findings = newFindings(before.findings, after.findings);
    console.log('RattleCheck %s checked %d objects. New high or critical findings: %d.',
      after.tool.version, after.doors.checked, findings.length);
    for (const f of findings) {
      const file = proposed.get(f.file)?.source;
      if (file) {
        const annotation = fileAnnotation(repo, repo, { ...f, file });
        if (annotation) console.log(annotation);
      }
      console.log(JSON.stringify({ rule: f.rule, severity: f.severity, name: f.name, file, line: f.line }));
    }
    return findings.length ? 1 : 0;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  try { process.exitCode = main(); }
  catch (error) { console.error('Migration review failed:', error.message); process.exitCode = 2; }
}
