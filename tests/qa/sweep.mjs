// sweep.mjs - publication sweep: scans every file that would be published (tracked files plus
// untracked files that are not ignored) and fails if something that should not go public is in
// them. Run before the repo is made public and after any large edit: `npm run sweep`.
//
// It fails on:
//   - local Windows paths and cloud-sync folder names
//   - email addresses in text files (GitHub no-reply addresses are allowed)
//   - names of internal documents, and working-process language (task numbers, hand-over notes, ...)
//   - API keys and tokens
//   - any file over 500 KB, except the files named in SIZE_ALLOW
//   - file names with spaces or upper-case letters, and folders that must never be tracked
//   - absolute or Windows paths inside assets/manifest.json
//
// The patterns are written in pieces (see `w()`), so this file does not trip its own rules and
// is itself swept. Binary files are checked for size only: their text cannot be searched here,
// so anything inside a PDF or image (for example a credits page) has to be checked by hand.
//
// Usage: node tests/qa/sweep.mjs [--root=<dir>]   (exit 1 when anything is found)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = path.resolve(rootArg ? rootArg.slice(7) : path.join(HERE, '..', '..'));

const MAX_BYTES = 500 * 1024;
const SIZE_ALLOW = new Set(['rules/ahab-and-the-whale-rule-book-v4.pdf']); // the printed rule book, allowed on purpose
const EMAIL_ALLOW = ['info@wombatgamefactory.com']; // the public contact address, exact match only; any other email still fails
const w = (...parts) => parts.join(''); // keeps a pattern from matching its own source line

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.zip', '.mp3', '.mp4']);

const TEXT_RULES = [
  { id: 'local-path', re: new RegExp(`\\b[A-Za-z]:\\\\[A-Za-z0-9_.$-]|${w('C:', '/Users')}|${w('/Users', '/')}[a-z]|${w('/home', '/')}[a-z]`), why: 'a local Windows or home-folder path' },
  { id: 'sync-folder', re: new RegExp(`${w('Drop', 'box')}|${w('One', 'Drive')}|${w('Google ', 'Drive')}`, 'i'), why: 'a cloud-sync folder name' },
  { id: 'email', re: /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, why: 'an email address' },
  { id: 'internal-doc', re: new RegExp(['rules-' + 'spec', 'engine-' + 'api', 'balance-' + 'report', 'art-' + 'audit', 'analytics-' + 'events', 'web-game-' + 'docs', 'ahab-web-' + 'game', 'deleg' + 'ate'].join('|'), 'i'), why: 'the name of an internal document or of the build process' },
  { id: 'task-framing', re: new RegExp([`\\bT[0-9]{1,2}\\b`, `\\b${w('man', 'ager')}\\b`, `\\bnext ${w('wor', 'ker')}\\b`, `\\b${w('wor', 'ker')}s? (?:should|must|will|needs? to|wires?)\\b`, `\\bsub-?${w('ag', 'ent')}s?\\b`, `\\bthe ${w('des', 'igner')}(?:'s)? (?:asked|wants|wanted|said|ruled|decided|rule|ruling|call|decision)\\b`, `\\b${w('wayf', 'inder')}\\b`, `\\bticket [A-Z0-9-]+`, `\\bTODO\\b`, `\\bFIXME\\b`].join('|')), why: 'working-process language (task numbers, hand-over notes, to-dos)' },
  { id: 'first-name', re: /\bDean\b(?! Morris)/, skip: new Set(['README.md']), why: 'a personal name in a source file (credits belong in the README)' },
  { id: 'secret', re: new RegExp(`${w('AI', 'za')}[0-9A-Za-z_-]{30,}|${w('gh', 'p_')}[0-9A-Za-z]{30,}|${w('github_', 'pat_')}[0-9A-Za-z_]{30,}|${w('s', 'k-')}[0-9A-Za-z]{30,}|${w('xo', 'x')}[bp]-[0-9A-Za-z-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----`), why: 'something that looks like a secret key' },
];

function list() {
  try {
    const run = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    const files = [...new Set([...run('ls-files'), ...run('ls-files', '-o', '--exclude-standard')])];
    return { files, source: 'git ls-files (tracked + untracked, not ignored)' };
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!['.git', 'node_modules'].includes(e.name) && rel !== 'tests/tmp') walk(rel); } else out.push(rel);
      }
    };
    walk('');
    return { files: out, source: 'directory walk (not a git checkout)' };
  }
}

const { files, source } = list();
const findings = [];
const add = (file, line, rule, why, excerpt = '') => findings.push({ file, line, rule, why, excerpt: String(excerpt).trim().slice(0, 140) });
let scanned = 0; let binaries = 0;

for (const file of files.sort()) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue; // tracked but deleted in the working tree
  const size = fs.statSync(full).size;
  if (size > MAX_BYTES && !SIZE_ALLOW.has(file)) add(file, 0, 'size', `larger than ${MAX_BYTES / 1024} KB (${Math.round(size / 1024)} KB)`);
  if (/\s/.test(file)) add(file, 0, 'file-name', 'a space in the file name');
  if (/[A-Z]/.test(file) && !/^(README|LICENSE)(\.md)?$/.test(file)) add(file, 0, 'file-name', 'upper-case letters in the path (GitHub Pages is case-sensitive; keep names lower-case)');
  if (/(^|\/)(node_modules|bug-reports|test-results|tmp)\//.test(file) || /\.log$/.test(file)) add(file, 0, 'tracked-junk', 'a folder or file type that should be ignored, not published');

  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(full);
  const isBinary = BINARY_EXT.has(ext) || buf.subarray(0, 8000).includes(0);
  if (isBinary) { binaries++; continue; }
  scanned++;
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const rule of TEXT_RULES) {
      if (rule.skip && rule.skip.has(file)) continue;
      const subject = rule.id === 'email' ? EMAIL_ALLOW.reduce((t, a) => t.replace(new RegExp(`(?<![A-Za-z0-9._%+-])${a.replace(/[.]/g, '\\.')}(?![A-Za-z0-9-]|\\.[A-Za-z])`, 'g'), ' '), text) : text;
      if (rule.re.test(subject)) add(file, i + 1, rule.id, rule.why, text);
    }
  });
  if (file === 'assets/manifest.json') {
    const strings = [];
    const visit = (v, key) => { if (typeof v === 'string') strings.push([key, v]); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k); };
    try { visit(JSON.parse(buf.toString('utf8')), ''); } catch (e) { add(file, 0, 'manifest', `not valid JSON: ${e.message}`); }
    for (const [k, v] of strings) {
      if (/^([A-Za-z]:[\\/]|[\\/])/.test(v) || /\\/.test(v)) add(file, 0, 'manifest-path', `"${k}" holds an absolute or Windows path`, v);
    }
  }
}

if (findings.length) {
  console.log(`sweep: ${findings.length} finding(s) in ${source}:\n`);
  for (const f of findings) console.log(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}] ${f.why}${f.excerpt ? `\n      ${f.excerpt}` : ''}`);
  console.log('\nsweep: FAILED');
  process.exit(1);
}
console.log(`sweep: OK. ${files.length} files from ${source}: ${scanned} text files searched, ${binaries} binary files checked for size only.`);
console.log('sweep: binary files (PDF, images) are not searched for text; check any credits page by eye.');
