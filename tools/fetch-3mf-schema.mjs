#!/usr/bin/env node
/**
 * Fetch the official 3MF Core XSD into ref/, so schema claims can be checked against
 * text instead of against someone's memory of the spec.
 *
 * Why this exists as a tool rather than a one-off: the mesh contract originally
 * specified a `zUp` attribute and a `<unit millimeter="millimeter">` form, and two
 * agents argued from recollection about whether those were legal. The published core
 * schema settles it in one line -- CT_Model allows exactly `unit`, `xml:lang`,
 * `requiredextensions`, `recommendedextensions` (plus any other-namespace attribute),
 * and ST_Unit enumerates micron/millimeter/centimeter/inch/foot/meter. Arguing about
 * that again should not require anyone to browse the spec, so the file is vendored and
 * its provenance is recorded in a header comment.
 *
 * The schema also fixes ordering, which is normative and not stylistic:
 *   CT_Model     : metadata* -> resources -> build
 *   CT_Resources : (basematerials | any-extension)* then object*
 *   CT_Vertices  : at least 3 vertex
 *   CT_Triangles : at least 1 triangle
 * Those are what ref/verify_model.py checks against this file.
 *
 * Usage: node tools/fetch-3mf-schema.mjs [--out ref/3mf-core-1.4.0.xsd]
 * Idempotent: re-running rewrites the file from the same URL. Exit 1 if the expected
 * content is not found -- a silently empty vendored schema would be worse than none.
 */
import { writeFileSync } from 'node:fs';

const URL = 'https://raw.githubusercontent.com/3MFConsortium/spec_core/master/3MF%20Core%20Specification.md';
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'ref/3mf-core-1.4.0.xsd';

const res = await fetch(URL);
if (!res.ok) {
  console.error(`fetch-3mf-schema: HTTP ${res.status} from ${URL}`);
  process.exit(1);
}
const text = await res.text();
const heading = text.indexOf('## Appendix B.1');
if (heading < 0) {
  console.error('fetch-3mf-schema: no "Appendix B.1" in the fetched document -- did the spec move?');
  process.exit(1);
}
const open = text.indexOf('```xml', heading);
const close = text.indexOf('```', open + 6);
if (open < 0 || close < 0) {
  console.error('fetch-3mf-schema: no xml code block after Appendix B.1');
  process.exit(1);
}
const xsd = `${text.slice(open + 6, close).trim()}\n`;

// Guard against storing a truncated or wrong-section file.
const need = ['<xs:schema', 'CT_Model', 'ST_Unit', 'name="triangles"', 'elementFormDefault'];
const missing = need.filter((s) => !xsd.includes(s));
if (missing.length) {
  console.error(`fetch-3mf-schema: extracted block is missing ${missing.join(', ')} -- refusing to write`);
  process.exit(1);
}

// Pull the facts the validator will rely on, and echo them so a change upstream is
// visible in this tool's output rather than discovered during a failure months later.
const modelAttrs = [...(xsd.match(/<xs:complexType name="CT_Model">[\s\S]*?<\/xs:complexType>/)[0]
  .matchAll(/<xs:attribute (?:name|ref)="(?:xml:)?([A-Za-z]+)"/g))].map((m) => m[1]);
const units = [...(xsd.match(/<xs:simpleType name="ST_Unit">[\s\S]*?<\/xs:simpleType>/)[0]
  .matchAll(/<xs:enumeration value="([a-z]+)"/g))].map((m) => m[1]);
const objAttrs = [...(xsd.match(/<xs:complexType name="CT_Object">[\s\S]*?<\/xs:complexType>/)[0]
  .matchAll(/<xs:attribute name="([A-Za-z]+)"/g))].map((m) => m[1]);

const header = [
  '<!--',
  `  3MF Core schema, Appendix B.1.1, retrieved ${new Date().toISOString().slice(0, 10)} by tools/fetch-3mf-schema.mjs`,
  `  from ${URL}`,
  '  Published version at time of retrieval: 1.4.0 (2025-02-06).',
  '  Verbatim except for this comment. Do not edit by hand -- re-run the tool.',
  '',
  `  Facts a human needed from it:`,
  `    CT_Model attributes : ${modelAttrs.join(', ')}   (note: no zUp)`,
  `    ST_Unit enum        : ${units.join(', ')}`,
  `    CT_Object attributes: ${objAttrs.join(', ')}`,
  `    elementFormDefault  : unqualified`,
  `    CT_Resources order  : basematerials/any-extension before object`,
  `    CT_Model order      : metadata, resources, build`,
  '-->',
  '',
].join('\n');

writeFileSync(out, header + xsd);
console.log(`wrote ${out}: ${xsd.length} bytes of schema`);
console.log(`  CT_Model attrs : ${modelAttrs.join(', ')}`);
console.log(`  ST_Unit        : ${units.join(', ')}`);
console.log(`  CT_Object attrs: ${objAttrs.join(', ')}`);
