// Scratch inspector for tests/conformance.json -- checks the emitter produced
// self-consistent vectors (no nulls where a value is required, JS-side RS/decode
// claims actually true) before a Python implementation is asked to agree.
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('tests/conformance.json', 'utf8'));
const ids = d.vectors.map((v) => v.id);
console.log('vectors', ids.length, 'unique ids', new Set(ids).size === ids.length);
const nulls = d.vectors.filter((v) => /:null\b/.test(JSON.stringify(v)));
console.log('vectors with null fields:', nulls.map((v) => v.id).join(', ') || 'none');
console.log('rs-erase ok flags:', d.vectors.filter((v) => v.kind === 'rs-erase').map((v) => v.ok).join(','));
console.log('rs-error expected set:', d.vectors.filter((v) => v.kind === 'rs-error').map((v) => (v.expected ? 'yes' : 'NO')).join(','));
console.log('rs-fail outcomes:', d.vectors.filter((v) => v.kind === 'rs-fail').map((v) => v.expectedOutcome).join(','));
console.log('page-decode:', d.vectors.filter((v) => v.kind === 'page-decode').map((v) => `${v.expectedOutcome}:${v.expectedContent ? v.expectedContent.length / 2 + 'B' : 'null'}`).join('  '));
console.log('page-unpack codeword lens:', d.vectors.filter((v) => v.kind === 'page-unpack').map((v) => v.codeword.length / 2).join(','));
console.log('transfers:', d.vectors.filter((v) => v.kind === 'transfer').map((v) => `${v.id} pages=${v.pages.length} data=${v.dataPages} enc=${!!v.passphrase}`).join('  '));
const sizes = d.vectors.map((v) => [v.id, JSON.stringify(v).length]).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log('biggest:', sizes.map(([k, n]) => `${k}=${(n / 1024).toFixed(0)}KB`).join(' '));
// a vector whose JS-side self-check says false is a bug in the emitter, not the protocol
const selfFalse = d.vectors.filter((v) => v.ok === false || v.roundTrips === false);
console.log('failed self-checks:', selfFalse.map((v) => v.id).join(', ') || 'none');
