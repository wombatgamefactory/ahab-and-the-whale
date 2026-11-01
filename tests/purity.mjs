// purity.mjs - src/engine and src/bots touch no DOM, console, storage, clock or Math.random.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './lib.mjs';

const { check, done } = suite('purity');
const root = fileURLToPath(new URL('../src/', import.meta.url));
const BANNED = [/\bdocument\./, /\bwindow\./, /\bconsole\./, /\blocalStorage\b/, /\bsessionStorage\b/, /Math\.random/, /\bDate\b/, /\bperformance\./, /\bsetTimeout\b/];

for (const dir of ['engine', 'bots']) {
  for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(join(root, dir, file), 'utf8');
    const hits = BANNED.filter((re) => re.test(text)).map(String);
    check(`${dir}/${file} is pure`, hits.length === 0, hits.join(' '));
  }
}
done();
