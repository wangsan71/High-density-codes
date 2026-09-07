/**
 * The attribute table in tools/check-3mf.mjs, compared with the schema it claims to follow.
 *
 * Why this file exists: the tamper cases in threeMF-subset.test.mjs prove that a rule the table
 * already contains will fire. They cannot prove the table was copied correctly -- and that is what
 * went wrong in the round that produced D40/D41, when the table was written from memory and then
 * "verified" against a schema fetched off the web that turned out to be an older variant. The
 * checker declared every .3mf we had ever emitted invalid. So this test reads the vendored
 * authority, ref/3mf-core-1.4.0.xsd, with the checker's own scanXml, and compares the two sets
 * element by element, attribute by attribute, in both directions: nothing invented, nothing
 * missing, nothing in the wrong order.
 *
 * Reading an XSD with a 3MF-shaped scanner produces style complaints (an xs:documentation carries
 * character data, which a 3MF element would not be allowed to). Those are ignored on purpose; only
 * the node list is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanXml, XSD_TABLE } from '../../tools/check-3mf.mjs';

const XSD = new URL('../../ref/3mf-core-1.4.0.xsd', import.meta.url);
const { nodes } = scanXml(readFileSync(XSD, 'utf8'));
const { ELEMENTS, REQUIRED, OBJECT_TYPE, UNIT_ENUM } = XSD_TABLE;

/* ------------------------------------------------------------------ read the XSD */

// Walk with a stack so every xs:attribute / xs:element is attributed to the type that declares it.
const types = new Map(); // CT_* -> { attrs:[{name, required}], refs:[name...], enums:[] }
const simpleTypes = new Map(); // ST_* -> [enumeration values]
const globalElements = new Map(); // element name -> type name
{
  const stack = [];
  for (const n of nodes) {
    if (n.kind === 'close') {
      stack.pop();
      continue;
    }
    if (n.kind !== 'open' && n.kind !== 'selfclose') continue;
    const enclosingType = [...stack].reverse().find((s) => s.local === 'complexType' || s.local === 'simpleType');
    if (n.local === 'complexType' && n.attrs.name) {
      types.set(n.attrs.name, { attrs: [], refs: [], xmlRefs: [] });
    } else if (n.local === 'simpleType' && n.attrs.name) {
      simpleTypes.set(n.attrs.name, []);
    } else if (n.local === 'element' && n.attrs.name && n.attrs.type && stack.length === 1) {
      // Top-level xs:element declarations: the schema's element table. Inner ones use ref=, not name=.
      globalElements.set(n.attrs.name, n.attrs.type);
    } else if (enclosingType) {
      const t = enclosingType.local === 'complexType' ? types.get(enclosingType.attrs.name) : null;
      const st = enclosingType.local === 'simpleType' ? simpleTypes.get(enclosingType.attrs.name) : null;
      if (n.local === 'attribute' && n.attrs.name && t) t.attrs.push({ name: n.attrs.name, required: n.attrs.use === 'required' });
      // `<xs:attribute ref="xml:lang"/>` is how the schema pulls in the xml namespace; it has no
      // name=, so it is tracked separately and the table's 'xml:lang' entry is justified by it.
      if (n.local === 'attribute' && n.attrs.ref && t) t.xmlRefs.push(n.attrs.ref);
      if (n.local === 'element' && n.attrs.ref && t) t.refs.push(n.attrs.ref);
      if (n.local === 'enumeration' && n.attrs.value && st) st.push(n.attrs.value);
    }
    if (n.kind === 'open') stack.push({ local: n.local, attrs: n.attrs });
  }
}

const attrsOf = (el) => (types.get(globalElements.get(el)) || { attrs: [] }).attrs;
const refsOf = (el) => (types.get(globalElements.get(el)) || { refs: [] }).refs;
const xmlRefsOf = (el) => (types.get(globalElements.get(el)) || { xmlRefs: [] }).xmlRefs;
const sortSet = (a) => [...a].sort();

test('the XSD was actually read: the counts a vacuous parse could not produce', () => {
  assert.equal(globalElements.size, 16, 'Core 1.4.0 declares exactly sixteen global elements');
  assert.deepEqual(
    sortSet(globalElements.keys()),
    sortSet(['metadatagroup', 'model', 'resources', 'build', 'basematerials', 'base', 'object', 'mesh', 'vertices', 'vertex', 'triangles', 'triangle', 'components', 'component', 'metadata', 'item']),
  );
  // The attribute that D40 was withdrawn over: it is right here in the authority.
  assert.deepEqual(attrsOf('object').map((a) => a.name), ['id', 'type', 'thumbnail', 'partnumber', 'name', 'pid', 'pindex']);
  assert.deepEqual(attrsOf('object').filter((a) => a.required).map((a) => a.name), ['id']);
  assert.equal(simpleTypes.get('ST_ObjectType').length, 5);
  assert.equal(simpleTypes.get('ST_Unit').length, 6);
  assert.ok(xmlRefsOf('model').includes('xml:lang'), 'CT_Model pulls in xml:lang by reference');
});

test('the element table matches the schema in both directions: nothing invented, nothing missing', () => {
  assert.deepEqual(sortSet(Object.keys(ELEMENTS)), sortSet(globalElements.keys()));
});

test('every attribute set matches exactly, and required attributes are the required ones', () => {
  for (const el of globalElements.keys()) {
    const fromXsd = sortSet(attrsOf(el).map((a) => a.name));
    // xml:lang arrives as a reference, not a declaration, so it is compared separately.
    const fromTable = sortSet(Object.keys(ELEMENTS[el].attrs).filter((a) => a !== 'xml:lang'));
    assert.deepEqual(fromTable, fromXsd, `<${el}>: the table's attribute set differs from ${globalElements.get(el)}`);
    const tableHasXmlLang = 'xml:lang' in ELEMENTS[el].attrs;
    assert.equal(tableHasXmlLang, xmlRefsOf(el).includes('xml:lang'), `<${el}>: xml:lang in the table but not referenced by the schema (or the reverse)`);
    const requiredXsd = sortSet(attrsOf(el).filter((a) => a.required).map((a) => a.name));
    assert.deepEqual(sortSet(REQUIRED[el] || []), requiredXsd, `<${el}>: the required-attribute list differs from ${globalElements.get(el)}`);
  }
});

test('child order matches the schema sequences, and elements with no children declare none', () => {
  for (const el of globalElements.keys()) {
    const refs = refsOf(el);
    const seq = ELEMENTS[el].sequence;
    if (refs.length) {
      // Document order of the xs:element refs is the schema's order: sequence first, then the
      // members of any choice, which is the order the checker's sequence rule expects.
      assert.deepEqual(seq || [], refs, `<${el}>: the table's child order differs from ${globalElements.get(el)}`);
    } else {
      assert.equal(seq, undefined, `<${el}>: the table declares a child order the schema does not have`);
    }
  }
  // The choice rule is the one thing the ref list flattens, so pin it where the schema has one.
  assert.deepEqual(ELEMENTS.object.choice, ['mesh', 'components'], 'CT_Object is a choice of mesh | components');
  assert.equal(ELEMENTS.model.choice, undefined);
});

test('the enumerations match the schema value for value', () => {
  assert.deepEqual(sortSet(OBJECT_TYPE), sortSet(simpleTypes.get('ST_ObjectType')), 'ST_ObjectType');
  assert.deepEqual(sortSet(UNIT_ENUM), sortSet(simpleTypes.get('ST_Unit')), 'ST_Unit');
});
