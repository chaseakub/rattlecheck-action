import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { snapshot, newFindings, scannerPackage } from '../review-pr/review.mjs';

test('the default follows latest and an exact version selects that release', () => {
  assert.equal(scannerPackage(), 'rattlecheck@latest');
  assert.equal(scannerPackage('latest'), 'rattlecheck@latest');
  assert.equal(scannerPackage('0.3.0'), 'rattlecheck@0.3.0');
});

test('the version input rejects ranges, alternate sources and tags other than latest', () => {
  for (const version of ['', '0.3', '^0.3.0', '*', 'next', 'v0.3.0', '00.3.0', 'npm:another-package', 'file:../local']) {
    assert.throws(() => scannerPackage(version), /exact stable npm version/);
  }
});

test('overlays match installed SQL and preserve the source path for annotations', t => {
  const repo = mkdtempSync(path.join(tmpdir(), 'rattlecheck-layout-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q');
  for (const name of ['main/01.sql', 'main/02.sql', 'extra/02.sql', 'extra/03.sql', 'etc/config.toml']) {
    mkdirSync(path.join(repo, path.dirname(name)), { recursive: true });
    writeFileSync(path.join(repo, name), name);
  }
  git('add', '.');
  const tree = git('write-tree').toString().trim();
  const files = snapshot(repo, tree, { migrations: 'main', overlay: 'extra', config: 'etc/config.toml' });
  assert.deepEqual([...files.values()].map(f => f.source), ['main/01.sql', 'extra/02.sql', 'extra/03.sql', 'etc/config.toml']);
  assert.throws(() => snapshot(repo, tree, { migrations: '../main', config: 'etc/config.toml' }));
});

test('a moved finding, a new trigger target and a severity increase are distinct cases', () => {
  const finding = { rule: 'RC004', name: 'f', severity: 'high', message: 'writes to A', line: 2 };
  const warning = { ...finding, name: 'g', severity: 'warning' };
  const moved = { ...finding, line: 7 };
  const target = { ...finding, message: 'writes to B' };
  const increased = { ...warning, severity: 'high' };
  assert.deepEqual(newFindings([finding, warning], [moved, target, increased]), [target, increased]);
});
