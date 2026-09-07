/**
 * The 3MF XSD-subset checker must be able to fail -- every rule gets a tamper case, and one
 * positive case proves it resolves namespaces instead of matching the writer's exact text
 * (the whole reason this checker exists beside selfCheck3MF).
 *
 * The attribute table in tools/check-3mf.mjs follows the schema vendored in this repository,
 * `ref/3mf-core-1.4.0.xsd`, and these cases are what keeps the two in step. The first version of
 * that table was written from memory and then "verified" against a schema fetched from the web
 * (3MFConsortium/3mf-samples/verifier/3mf.xsd), which is an older shape with no `name` on
 * CT_Object -- it produced a false finding against our own emitter, recorded and withdrawn as D40.
 * The authoritative file had been in `ref/` the whole time. Hence the D40 regression guard below:
 * object/@name is legal and must stay legal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelXml, scanXml } from '../../tools/check-3mf.mjs';

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

const GOOD = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">
  <metadata name="pskt:profile">PL-D2</metadata>
  <resources>
    <basematerials id="1">
      <base name="ink" displaycolor="#11223344"/>
    </basematerials>
    <object id="2" type="model" pid="1" pindex="0">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
          <vertex x="0" y="0" z="1"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="2" v3="1"/>
          <triangle v1="0" v2="1" v3="3"/>
          <triangle v1="0" v2="3" v3="2"/>
          <triangle v1="1" v2="2" v3="3"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="2"/>
  </build>
</model>`;

test('the reference document passes and its counts are real, not zero', () => {
  const r = validateModelXml(GOOD);
  assert.deepEqual(r.issues, [], 'a Core 1.4 shaped document must be clean');
  assert.equal(r.ok, true);
  // Anti-vacuity: a checker that finds no elements would also report no issues.
  assert.equal(r.stats.objects, 1);
  assert.equal(r.stats.vertices, 4);
  assert.equal(r.stats.triangles, 4);
  assert.equal(r.stats.ids, 2, 'the basematerials id and the object id');
  assert.deepEqual(r.stats.materialIds, ['1']);
  assert.equal(r.stats.unit, 'millimeter');
});

test('a prefixed core namespace still passes -- it resolves, it does not pattern match', () => {
  // `model` has to be in the list too, or `</model>` stays unprefixed and the checker rightly
  // reports a mismatched close -- which it did on the first run of this test.
  const prefixed = GOOD.replace(`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">`, `<m:model xmlns:m="${CORE_NS}" unit="millimeter">`)
    .replace(/<(\/?)(metadata|resources|basematerials|base|object|mesh|vertices|vertex|triangles|triangle|build|item|model)\b/g, '<$1m:$2');
  const r = validateModelXml(prefixed);
  assert.deepEqual(r.issues, [], `prefix-bound namespaces are legal: ${r.issues.join(' | ')}`);
  assert.equal(r.stats.objects, 1);
});

test('unit may be omitted: the schema defaults it to millimeter', () => {
  const r = validateModelXml(GOOD.replace(' unit="millimeter"', ''));
  assert.deepEqual(r.issues, []);
  assert.equal(r.stats.unit, 'millimeter (schema default)');
});

test('what Core 1.4 allows must stay allowed: object/@name, extension attributes, all five object types', () => {
  // D40 regression guard. `name` IS declared on CT_Object (ref/3mf-core-1.4.0.xsd L97), so a
  // checker that flags it is accusing our own emitter of a violation it does not have -- which is
  // exactly what the first version of this checker did, on the authority of a web variant schema.
  const named = GOOD.replace('<object id="2" type="model"', '<object id="2" type="model" name="page-000" partnumber="PSKT-1"');
  assert.deepEqual(validateModelXml(named).issues, [], 'object/@name and @partnumber are Core 1.4 attributes');
  // `xs:anyAttribute namespace="##other"` (L100): a prefixed attribute from an extension namespace
  // is legal; the unqualified unknown one is in TAMPER above, so both sides are covered.
  const ext = GOOD.replace(
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">`,
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">`,
  ).replace('<object id="2" type="model"', '<object id="2" type="model" p:UUID="1e8f3a00-1111-2222-3333-444444444444"');
  assert.deepEqual(validateModelXml(ext).issues, [], 'extension attributes from another namespace are legal');
  // ST_ObjectType has five enumerations in 1.4.0 (L211-217); the web variant had two.
  for (const t of ['model', 'solidsupport', 'support', 'surface', 'other']) {
    assert.deepEqual(validateModelXml(GOOD.replace('type="model"', `type="${t}"`)).issues, [], `type="${t}" is a legal ST_ObjectType`);
  }
});

/**
 * Every rule, broken on purpose. The last column is what the issue must mention, so a rule that
 * fires for the wrong reason does not count as covered.
 */
const TAMPER = [
  ['object carries an unqualified attribute the schema does not define', GOOD.replace('<object id="2" type="model"', '<object id="2" type="model" colour="red"'), /not allowed on <object>/],
  ['object id at the schema bound (ST_ResourceID is maxExclusive 2^31)', GOOD.replace('<object id="2"', '<object id="2147483648"'), /outside the schema's value domain/],
  ['a mesh with fewer than three vertices (CT_Vertices minOccurs=3)', GOOD.replace('          <vertex x="0" y="1" z="0"/>\n', '').replace('          <vertex x="0" y="0" z="1"/>\n', ''), /at least 3/],
  ['two elements share one id', GOOD.replace('<object id="2"', '<object id="1"'), /used twice/],
  ['id is not a positive integer', GOOD.replace('<object id="2"', '<object id="0"'), /not an xs:positiveInteger/],
  ['unit outside the ST_Unit enumeration', GOOD.replace('unit="millimeter"', 'unit="furlong"'), /outside the schema's value domain/],
  ['build placed before resources', GOOD.replace(/<resources>[\s\S]*<\/resources>\s*<build>/, '<build>'), /sequence|exactly one/],
  ['object pid points at nothing', GOOD.replace('pid="1"', 'pid="99"'), /refers to no <basematerials>/],
  ['triangle index beyond the vertex list', GOOD.replace('<triangle v1="1" v2="2" v3="3"/>', '<triangle v1="1" v2="2" v3="7"/>'), /out of range/],
  ['degenerate triangle (two vertices are the same point)', GOOD.replace('<triangle v1="1" v2="2" v3="3"/>', '<triangle v1="1" v2="1" v3="3"/>'), /degenerate/],
  ['unknown attribute on vertex', GOOD.replace('<vertex x="1" y="0" z="0"/>', '<vertex x="1" y="0" z="0" colour="red"/>'), /not allowed on <vertex>/],
  ['coordinate is NaN', GOOD.replace('<vertex x="1" y="0" z="0"/>', '<vertex x="1" y="0" z="NaN"/>'), /not a finite xs:double/],
  ['displaycolor outside ST_ColorValue', GOOD.replace('displaycolor="#11223344"', 'displaycolor="red"'), /outside the schema's value domain/],
  ['a DTD is declared', GOOD.replace('<model ', '<!DOCTYPE model [<!ENTITY x "y">]><model '), /document type|entity declaration/],
  ['root is in the wrong namespace', GOOD.replace(CORE_NS, 'http://example.invalid/3mf'), /not the 3MF core namespace/],
  ['an element is left unclosed', GOOD.replace('</build>', ''), /unclosed/],
  ['character data where only elements are allowed', GOOD.replace('<build>', '<build>stray text'), /element-only/],
  ['an item refers to an object id that does not exist', GOOD.replace('<item objectid="2"/>', '<item objectid="77"/>'), /refers to no object id/],
  ['two meshes inside one object', GOOD.replace('</mesh>', '</mesh><mesh><vertices/><triangles/></mesh>'), /exactly one of mesh \| components|not an element/],
  ['a bare ampersand in metadata text', GOOD.replace('>PL-D2<', '>PL&D2<'), /bare "&"|undefined entity/],
];

for (const [name, text, expected] of TAMPER) {
  test(`caught: ${name}`, () => {
    const r = validateModelXml(text);
    assert.equal(r.ok, false, `the checker accepted a document it should refuse: ${name}`);
    assert.ok(r.issues.length > 0, 'no issues were reported');
    const joined = r.issues.join(' | ');
    assert.match(joined, expected, `it refused, but not for the reason the rule exists for: ${joined}`);
  });
}

test('the scanner reports unbalanced markup and unterminated tags rather than guessing', () => {
  const a = scanXml('<model xmlns="x"><resources>');
  assert.ok(a.issues.some((i) => /unclosed/i.test(i)), a.issues.join(' | '));
  const b = scanXml('<model xmlns="x" <resources>');
  assert.ok(b.issues.length > 0, 'malformed attribute text must not be silently dropped');
  const c = scanXml('<?xml version="1.0"?><model/>');
  assert.deepEqual(c.issues, []);
});
