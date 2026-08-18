#!/usr/bin/env node
/**
 * Read the just-published package BACK from the registry and prove it is what
 * this build produced.
 *
 * ⛔ WHY THIS EXISTS: `npm publish` exiting 0 is not evidence that the registry
 * serves the right package. It has printed "Publishing to
 * https://registry.npmjs.org/" and then failed on the very next line. Until
 * this step existed, the Action's green tick meant "publish returned 0" and
 * nothing more — and the one bug it would have caught (#183: the published
 * package advertising eight coaches that no longer exist) shipped to users and
 * sat there undetected.
 *
 * The comparison is deliberately SELF-REFERENTIAL: the published manifest is
 * diffed against the dist/ this same job just built, not against a hardcoded
 * roster. A hardcoded list is a second source of truth that goes stale — and
 * one is about to, when the coach keys are renamed (GitLab #181/#199). This
 * check needs no edit for that.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const name = pkg.name;
// The workflow passes github.ref_name, which is the TAG ("v0.9.3"), not the
// version ("0.9.3"). Strip the prefix here rather than in YAML so the script is
// correct however it is invoked.
const expected = (process.env.EXPECTED_VERSION || pkg.version).replace(/^v/, '');

const die = (m) => { console.error(`[verify] ${m}`); process.exit(1); };
const say = (m) => console.log(`[verify] ${m}`);

// 1. Registry propagation is not instant. Poll, rather than fail on a race.
let live = '';
for (let i = 1; i <= 10; i++) {
  try {
    live = execFileSync('npm', ['view', `${name}@${expected}`, 'version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { live = ''; }
  if (live) break;
  say(`registry has not caught up yet (attempt ${i}/10) — waiting 10s`);
  execFileSync('sleep', ['10']);
}
if (!live) die(`${name}@${expected} is NOT on the registry after 100s. The publish did not take effect.`);
if (live !== expected) die(`registry reports ${live}, expected ${expected}.`);
say(`registry serves ${name}@${live}`);

// 2. Fetch the actual published artifact — not the local tree, the tarball a
//    user's `npm install` would get.
const dir = mkdtempSync(join(tmpdir(), 'verify-'));
// stderr ignored: `npm pack` writes a 60-line tarball-contents notice there,
// which would bury this check's actual verdict in the Action log.
const tgz = execFileSync('npm', ['pack', `${name}@${expected}`, '--pack-destination', dir], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}).trim().split('\n').pop();
execFileSync('tar', ['-xzf', join(dir, tgz), '-C', dir]);

// 3. The manifest ships in dist/, never src/ — package.json declares
//    "files": ["dist/"]. An earlier revision of the sibling script looked in
//    src/, found nothing, and reported a missing manifest for a healthy package.
const shippedPath = join(dir, 'package', 'dist', 'tool-manifest.json');
let shipped, built;
try { shipped = JSON.parse(readFileSync(shippedPath, 'utf8')); }
catch { die(`no dist/tool-manifest.json inside the published tarball (${shippedPath})`); }
try { built = JSON.parse(readFileSync('dist/tool-manifest.json', 'utf8')); }
catch { die('no dist/tool-manifest.json in the workspace — did `npm run build` run before this step?'); }

const a = JSON.stringify(shipped);
const b = JSON.stringify(built);
if (a !== b) {
  console.error('[verify] the PUBLISHED manifest differs from the one this job built.');
  const names = (m) => (m.tools || []).map((t) => t.name).sort();
  const s = names(shipped), t = names(built);
  console.error(`[verify]   published tools: ${s.join(', ') || '(none)'}`);
  console.error(`[verify]   built tools    : ${t.join(', ') || '(none)'}`);
  die('refusing to call this release good.');
}

const toolCount = (built.tools || []).length;
say(`published manifest is byte-identical to the built one (${toolCount} tools).`);
say(`${name}@${live} verified against the registry.`);
