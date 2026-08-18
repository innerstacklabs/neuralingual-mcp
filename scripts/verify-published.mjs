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

// ⛔ EVERY registry read below is retried, and that is not belt-and-braces.
//
// This step runs AFTER `npm publish`. The version is already public and npm
// versions are immutable, so re-running the workflow dies at `npm publish` with
// EPUBLISHCONFLICT and never reaches this check again. A spurious failure here
// therefore reds a release that shipped perfectly, PERMANENTLY.
//
// The first cut of this script retried `npm view` ten times and then fetched the
// tarball exactly once — but registry METADATA goes live before the CDN tarball
// path is reliably warm, so the unretried call was precisely the one most likely
// to lose the race. False negatives are the expensive direction here; slowness
// is not.
const retry = (label, fn, attempts = 10, waitS = 10) => {
  for (let i = 1; i <= attempts; i++) {
    try {
      const out = fn();
      if (out) return out;
    } catch { /* fall through to the wait */ }
    if (i === attempts) break;            // no pointless sleep after the last try
    say(`${label} not ready (attempt ${i}/${attempts}) — waiting ${waitS}s`);
    execFileSync('sleep', [String(waitS)]);
  }
  return '';
};

// 1. Registry propagation is not instant. Poll, rather than fail on a race.
const live = retry('registry metadata', () =>
  execFileSync('npm', ['view', `${name}@${expected}`, 'version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim());
if (!live) die(`${name}@${expected} is NOT on the registry after ~90s. The publish did not take effect.`);
if (live !== expected) die(`registry reports ${live}, expected ${expected}.`);
say(`registry serves ${name}@${live}`);

// 2. Fetch the actual published artifact — not the local tree, the tarball a
//    user's `npm install` would get.
const dir = mkdtempSync(join(tmpdir(), 'verify-'));
// --prefer-online because npm may serve this from the local _cacache, and a
// cache hit could compare a locally-produced artifact against itself — a check
// that verifies nothing while reporting success.
// stderr ignored: `npm pack` writes a 60-line tarball-contents notice there,
// which would bury this check's actual verdict in the Action log.
const tgz = retry('published tarball', () =>
  execFileSync('npm', ['pack', `${name}@${expected}`, '--prefer-online', '--pack-destination', dir], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim().split('\n').pop());
if (!tgz) die(`could not download the published tarball for ${name}@${expected} after ~90s.
[verify] The package IS published and immutable — this is a VERIFICATION failure, not a publish
[verify] failure. Do not re-run the workflow (it will die at npm publish with EPUBLISHCONFLICT).
[verify] Re-run this check alone:  EXPECTED_VERSION=${expected} node scripts/verify-published.mjs`);
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

// The manifest alone is narrower than "verify the published package": package.json
// declares "files": ["dist/"] and two bins (dist/cli.js, dist/user-mcp.js), so a
// stale CLI or a dropped file would sail through a matching manifest. Compare the
// shipped FILE LIST against the built one too.
const shippedFiles = execFileSync('tar', ['-tzf', join(dir, tgz)], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f.startsWith('package/dist/') && !f.endsWith('/'))
  .map((f) => f.replace(/^package\//, ''))
  .sort();
const builtFiles = execFileSync('find', ['dist', '-type', 'f'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).sort();

const missing = builtFiles.filter((f) => !shippedFiles.includes(f));
const extra = shippedFiles.filter((f) => !builtFiles.includes(f));
if (missing.length || extra.length) {
  if (missing.length) console.error(`[verify] built but NOT shipped: ${missing.join(', ')}`);
  if (extra.length) console.error(`[verify] shipped but NOT built: ${extra.join(', ')}`);
  die('the published file list does not match what this job built.');
}

for (const bin of Object.values(pkg.bin || {})) {
  if (!shippedFiles.includes(bin)) die(`declared bin "${bin}" is NOT in the published tarball.`);
}

const toolCount = (built.tools || []).length;
say(`manifest byte-identical (${toolCount} tools); ${shippedFiles.length} dist files match; bins present.`);
say(`${name}@${live} verified against the registry.`);
