/**
 * 3MF Core 1.4 XSD-subset checker -- the half of G8 that can run in process.
 *
 * Why this exists beside `selfCheck3MF()`: that one asks "did the writer emit what it meant",
 * and it parses deliberately narrowly -- `parseModelXml` says so itself: it only recognises the
 * shape our own writer produces, attribute order included. A schema asks the other question,
 * "would a conforming reader accept this as 3MF Core 1.4", and a checker built on the writer's
 * own parser would inherit its blindness: reorder two attributes, add one unknown attribute, or
 * bind the core namespace to a prefix and `parseModelXml` simply matches nothing while the file
 * has already become something a slicer may reject. So this file scans the XML itself, resolves
 * namespaces the way an XML parser does, and never consults the writer's intent.
 *
 * What it is NOT: schema conformance. There is no XSD engine here. The authority for every rule
 * below is the schema vendored in this repository, `ref/3mf-core-1.4.0.xsd` (3MF Core 1.4.0), and
 * the table is checked against it by tests/unit/threeMF-subset.test.mjs so it cannot drift. The
 * rules are the subset that can be decided from the bytes: package parts and their content-type
 * coverage, the three namespaces, element sequences and the mesh|components choice, attribute
 * value domains, document-wide id uniqueness, dangling `pid` references, triangle indices in range
 * and distinct, no DTD and no entity declarations.
 *
 * Provenance, including the wrong turn: the first version of this table was written from memory
 * and then "verified" against a schema fetched from the web
 * (3MFConsortium/3mf-samples/verifier/3mf.xsd). That file is a different, older shape -- it has
 * `materials`/`materialtype` instead of `pid`, no `name` on CT_Object, and `basematerial` instead
 * of `base` -- and it produced a false finding against our own emitter (recorded and withdrawn as
 * D40). The authoritative file had been sitting in `ref/` the whole time and docs/STATUS.md even
 * named it. Read the workspace before the web.
 *
 * Two schema details this checker honours rather than flattens: CT_Object (and friends) carry
 * `xs:anyAttribute namespace="##other"`, so a *prefixed* attribute from an extension namespace is
 * legal while an unqualified unknown one is a violation; and `xs:any namespace="##other"` after the
 * mesh choice means extension *elements* are legal too, so a non-core namespace is not by itself a
 * complaint.
 *
 * Every rule has a tamper case in `gateG8` (cli/pskit.mjs): a checker that cannot be shown to
 * fail is not a checker, and this repository has been burned by vacuous green often enough.
 *
 *   node tools/check-3mf.mjs out/page-000.3mf [--json]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  readZip,
  CONTENT_TYPES_PART,
  RELS_PART,
  MODEL_PART,
  CORE_NS,
  CONTENT_TYPES_NS,
  RELATIONSHIPS_NS,
  START_PART_REL_TYPE,
  MODEL_CONTENT_TYPE,
} from '../core/mesh/threeMF.js';

/* ------------------------------------------------------------------ value domains */

const POSINT = /^[1-9][0-9]*$/; // xs:positiveInteger
const NONNEGINT = /^(0|[1-9][0-9]*)$/; // xs:nonNegativeInteger
// ST_ResourceID and ST_ResourceIndex are those two with maxExclusive 2^31 (ref/3mf-core-1.4.0.xsd
// L201-208), so an id or index that big is a schema violation, not just an oddity.
const resourceId = (v) => POSINT.test(v) && Number(v) < 2147483648;
const resourceIndex = (v) => NONNEGINT.test(v) && Number(v) < 2147483648;
// xs:double's lexical space, minus the two values 3MF forbids in coordinates.
const DOUBLE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const UNIT_ENUM = ['millimeter', 'inch', 'foot', 'meter', 'micron', 'centimeter'];
// ST_ObjectType, all five enumerations (ref/3mf-core-1.4.0.xsd L211-217). The web variant of the
// schema only allows model|support; this table follows the vendored 1.4.0.
const OBJECT_TYPE = ['model', 'solidsupport', 'support', 'surface', 'other'];
const COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const LANG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;
// CT_Metadata/@name is xs:QName (L153). Only its lexical shape is checked: a strict validator also
// requires the prefix to be namespace-declared, and 3MF metadata names conventionally are not
// (`pskt:profile`, `slic3r:...`, `Application`), so enforcing that would flag every real-world file
// including ours -- a deliberate, documented leniency, not an oversight.
const QNAME = /^([A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*$/;
// CT_Transform: twelve doubles, "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32".
const TRANSFORM = (v) => {
  const parts = String(v).trim().split(/\s+/);
  return parts.length === 12 && parts.every((p) => DOUBLE.test(p) && Number.isFinite(Number(p)));
};
const ANYSTR = () => true;
const isDouble = (v) => DOUBLE.test(String(v).trim()) && Number.isFinite(Number(v)) && !/INF|NaN/i.test(String(v));

/**
 * Element table for the subset we emit or must tolerate. `attrs` lists every attribute the
 * schema allows on that element; anything else is a violation, because these complex types do
 * not carry `xs:anyAttribute` -- an unknown unqualified attribute is exactly what makes a file
 * that our own writer happily produced invalid for everybody else.
 */
const ELEMENTS = {
  model: {
    // CT_Model (L37-48): unit defaults to millimeter, plus xml:lang and the two extension lists.
    attrs: {
      unit: (v) => UNIT_ENUM.includes(v),
      'xml:lang': (v) => LANG.test(v),
      requiredextensions: ANYSTR,
      recommendedextensions: ANYSTR,
    },
    sequence: ['metadata', 'resources', 'build'],
  },
  // CT_Metadata (L151-156): name required, preserve and type optional.
  metadata: { attrs: { name: (v) => QNAME.test(v), preserve: (v) => v === 'true' || v === 'false', type: ANYSTR }, text: true },
  resources: {
    attrs: {},
    // CT_Resources in Core 1.4.0 (ref/3mf-core-1.4.0.xsd L50-57) is basematerials* then object*.
    // texture2d / colorgroup / texture2dgroup / compositematerials / multiproperties belong to the
    // Materials & Properties extension schema, not to core, so they are not listed here: a core
    // reader is not required to accept them, and pretending otherwise would hide a real problem.
    sequence: ['basematerials', 'object'],
  },
  basematerials: { attrs: { id: resourceId }, sequence: ['base'] },
  base: { attrs: { name: ANYSTR, displaycolor: (v) => COLOR.test(v) } },
  // CT_MetadataGroup (L78-81): metadata*, and it is the only child object/item may carry.
  metadatagroup: { attrs: {}, sequence: ['metadata'] },
  object: {
    attrs: {
      id: resourceId,
      type: (v) => OBJECT_TYPE.includes(v),
      thumbnail: ANYSTR,
      partnumber: ANYSTR,
      name: ANYSTR,
      pid: resourceId,
      pindex: resourceIndex,
    },
    // CT_Object (L84-101): metadatagroup?, then exactly one of mesh | components, then any
    // extension elements from another namespace.
    sequence: ['metadatagroup', 'mesh', 'components'],
    choice: ['mesh', 'components'],
  },
  mesh: { attrs: {}, sequence: ['vertices', 'triangles'] },
  vertices: { attrs: {}, sequence: ['vertex'] },
  vertex: { attrs: { x: isDouble, y: isDouble, z: isDouble } },
  triangles: { attrs: {}, sequence: ['triangle'] },
  triangle: {
    attrs: {
      v1: resourceIndex,
      v2: resourceIndex,
      v3: resourceIndex,
      pid: resourceId,
      p1: resourceIndex,
      p2: resourceIndex,
      p3: resourceIndex,
    },
  },
  components: { attrs: {}, sequence: ['component'] },
  component: { attrs: { objectid: resourceId, transform: TRANSFORM } },
  build: { attrs: {}, sequence: ['item'] },
  // CT_Item (L158-165): metadatagroup?, objectid required, transform, partnumber.
  item: { attrs: { objectid: resourceId, transform: TRANSFORM, partnumber: ANYSTR }, sequence: ['metadatagroup'] },
};
const REQUIRED = {
  object: ['id'],
  vertex: ['x', 'y', 'z'],
  triangle: ['v1', 'v2', 'v3'],
  item: ['objectid'],
  component: ['objectid'],
  base: ['name', 'displaycolor'],
  basematerials: ['id'],
  colorgroup: ['id'],
  color: ['color'],
  metadata: ['name'],
};
/** Elements whose content is character data rather than child elements. */
const TEXT_ELEMENTS = new Set(['metadata']);

/* ------------------------------------------------------------------ xml scanning */

/** Find the end of a tag, honouring quotes: a `>` inside an attribute value is not the end. */
function tagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

function parseAttrs(src, where, issues) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const value = m[3] !== undefined ? m[3] : m[4];
    if (Object.prototype.hasOwnProperty.call(attrs, name)) issues.push(`${where}: duplicate attribute "${name}"`);
    attrs[name] = value;
  }
  // Anything left over is an attribute this parser could not read -- an XSD validator would not
  // shrug at it, so neither does this one.
  const stripped = src.replace(/[\w:.-]+\s*=\s*("([^"]*)"|'([^']*)')/g, '');
  if (stripped.trim()) issues.push(`${where}: unparsable attribute text "${stripped.trim().slice(0, 40)}"`);
  return attrs;
}

/**
 * Minimal XML scanner: nodes in document order with namespace resolution. Deliberately strict
 * about the things a conforming reader must not have to guess: unbalanced tags, bare `&`,
 * character data where the schema allows only elements.
 */
export function scanXml(text) {
  const issues = [];
  const nodes = [];
  const stack = []; // open elements: { local, uri, bindings }
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      if (text.slice(i).trim()) issues.push(`character data after the last element: "${text.slice(i).trim().slice(0, 30)}"`);
      break;
    }
    const before = text.slice(i, lt);
    if (before.trim()) {
      const top = stack[stack.length - 1];
      if (!top || !TEXT_ELEMENTS.has(top.local)) {
        issues.push(`character data inside <${top ? top.local : '(nothing)'}>, which the schema declares element-only: "${before.trim().slice(0, 30)}"`);
      }
    }
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(before)) {
      issues.push(`bare "&" or undefined entity reference in character data at offset ${lt}`);
    }
    const gt = tagEnd(text, lt + 1);
    if (gt < 0) {
      issues.push(`unterminated markup at offset ${lt}`);
      break;
    }
    const body = text.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('?')) {
      nodes.push({ kind: 'pi', raw: body.slice(1, -1).trim(), offset: lt });
      continue;
    }
    if (body.startsWith('!--')) {
      if (!body.endsWith('--')) issues.push(`malformed comment at offset ${lt}`);
      nodes.push({ kind: 'comment', offset: lt });
      continue;
    }
    if (body.startsWith('!DOCTYPE') || body.startsWith('!ENTITY')) {
      issues.push(`document type / entity declaration at offset ${lt}: 3MF forbids DTDs, and a reader that resolves entities would be reading a different document than the one on disk`);
      nodes.push({ kind: 'doctype', offset: lt });
      continue;
    }
    if (body.startsWith('![CDATA[')) {
      const close = text.indexOf(']]>', gt);
      if (close < 0) issues.push(`unterminated CDATA at offset ${lt}`);
      const top = stack[stack.length - 1];
      if (!top || !TEXT_ELEMENTS.has(top.local)) issues.push(`CDATA section inside <${top ? top.local : '(nothing)'}>, which the schema declares element-only`);
      i = close < 0 ? i : close + 3;
      nodes.push({ kind: 'cdata', offset: lt });
      continue;
    }
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const top = stack.pop();
      if (!top) issues.push(`closing tag </${name}> with nothing open`);
      else if (top.raw !== name) issues.push(`element <${top.raw}> is closed by </${name}>`);
      // `local` has to be resolved here too: the tree walk and the geometry pass match closing
      // tags by local name, and leaving it undefined silently made every object look unclosed.
      const cc = name.indexOf(':');
      nodes.push({ kind: 'close', raw: name, local: cc < 0 ? name : name.slice(cc + 1), offset: lt });
      continue;
    }
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const nameMatch = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(inner.trim());
    if (!nameMatch) {
      issues.push(`markup at offset ${lt} does not start with an element name`);
      continue;
    }
    const raw = nameMatch[1];
    const attrs = parseAttrs(inner.slice(nameMatch[0].length), `<${raw}>`, issues);
    const colon = raw.indexOf(':');
    const prefix = colon < 0 ? '' : raw.slice(0, colon);
    const local = colon < 0 ? raw : raw.slice(colon + 1);
    // Namespace bindings: xmlns="..." is the default, xmlns:p="..." binds a prefix. Both are
    // inherited, so a prefixed core namespace is legal and must be resolved rather than
    // pattern-matched -- that is the whole point of not reusing the writer's parser.
    const bindings = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'xmlns') bindings[''] = v;
      else if (k.startsWith('xmlns:')) bindings[k.slice(6)] = v;
    }
    const scope = Object.assign({}, stack.length ? stack[stack.length - 1].scope : {}, bindings);
    const uri = scope[prefix] || '';
    nodes.push({ kind: selfClose ? 'selfclose' : 'open', raw, local, prefix, uri, attrs, scope, offset: lt, depth: stack.length });
    if (!selfClose) stack.push({ raw, local, uri });
  }
  if (stack.length) issues.push(`unclosed element(s) at end of document: ${stack.map((s) => `<${s.raw}>`).join(', ')}`);
  return { nodes, issues };
}

/* ------------------------------------------------------------------ model part */

/**
 * Validate `3D/3dmodel.model` against the Core 1.4 subset. Returns issues plus the counts the
 * gate prints, so a pass is never just a silent absence of complaints.
 */
export function validateModelXml(text) {
  const issues = [];
  const { nodes, issues: scanIssues } = scanXml(text);
  issues.push(...scanIssues);

  const pis = nodes.filter((n) => n.kind === 'pi');
  if (pis.length && pis[0].raw.startsWith('xml ')) {
    const v = /version\s*=\s*"([^"]*)"/.exec(pis[0].raw);
    if (!v || !/^1\.[01]$/.test(v[1])) issues.push(`XML declaration says version "${v ? v[1] : '?'}"; 3MF is an XML 1.0 format`);
  } else if (!pis.length) {
    issues.push('no XML declaration: 3MF parts are UTF-8 XML and say so');
  }
  if (pis.length > 1) issues.push(`${pis.length} processing instructions; a 3MF model part carries only the XML declaration`);

  const opens = nodes.filter((n) => n.kind === 'open' || n.kind === 'selfclose');
  const root = opens.find((n) => n.depth === 0 && n.kind !== 'close');
  if (!root) return { ok: false, issues: issues.length ? issues : ['no root element'], stats: null };
  if (root.uri !== CORE_NS) {
    issues.push(`root <${root.raw}> is in namespace "${root.uri || '(none)'}", not the 3MF core namespace "${CORE_NS}"`);
  }
  if (root.local !== 'model') issues.push(`root element is <${root.local}>, not <model>`);

  // Walk the tree with an explicit stack so sequence/choice rules are checked per parent.
  const ids = new Map(); // id value -> element name, document-wide
  const materialIds = new Set(); // ids that a pid may reference
  const objects = [];
  const path = [];
  const childrenOf = new Map(); // path key -> [local names in order]
  for (const n of nodes) {
    if (n.kind === 'open' || n.kind === 'selfclose') {
      const parent = path[path.length - 1];
      const key = parent ? parent.key : '';
      const list = childrenOf.get(key) || [];
      list.push(n.local);
      childrenOf.set(key, list);
      const where = `<${n.raw}> at ${n.offset}`;
      const spec = ELEMENTS[n.local];
      // CT_Object and CT_Model end with `xs:any namespace="##other"`, so an element from an
      // extension namespace is legal and is not a complaint. What is a violation is an element
      // claiming the core namespace (or none) that the core schema does not define: that is the
      // difference between an extension and a misspelling.
      if (!spec && (!n.uri || n.uri === CORE_NS)) {
        issues.push(`${where}: <${n.local}> is not an element the 3MF core schema defines here`);
      }
      if (spec) {
        for (const req of REQUIRED[n.local] || []) {
          if (!(req in n.attrs)) issues.push(`${where}: required attribute "${req}" is missing`);
        }
        for (const [a, v] of Object.entries(n.attrs)) {
          if (a === 'xmlns' || a.startsWith('xmlns:')) continue;
          if (a === 'xml:lang' && n.local !== 'model') continue; // xml:lang is allowed anywhere by XML
          // `xs:anyAttribute namespace="##other"` makes an attribute whose prefix resolves to an
          // extension namespace legal (the production extension's UUID is the usual case). An
          // unqualified unknown attribute stays a violation, and that is the case that matters:
          // it is what a hand-edited or wrongly templated file produces.
          const ac = a.indexOf(':');
          if (ac > 0 && a.slice(0, ac) !== 'xml' && (n.scope[a.slice(0, ac)] || '') !== CORE_NS) continue;
          const check = spec.attrs[a];
          if (!check) {
            issues.push(`${where}: attribute "${a}" is not allowed on <${n.local}> by the core schema`);
          } else if (!check(v)) {
            issues.push(`${where}: attribute "${a}"="${v}" is outside the schema's value domain`);
          }
        }
      }
      if (n.attrs.id !== undefined) {
        if (!POSINT.test(n.attrs.id)) issues.push(`${where}: id="${n.attrs.id}" is not an xs:positiveInteger`);
        else if (ids.has(n.attrs.id)) issues.push(`${where}: id ${n.attrs.id} is used twice (already on <${ids.get(n.attrs.id)}>); ids are unique document-wide`);
        else ids.set(n.attrs.id, n.local);
        if (n.local === 'basematerials') materialIds.add(n.attrs.id);
      }
      if (n.local === 'object') objects.push({ node: n, where });
      if (n.kind === 'open') path.push({ local: n.local, uri: n.uri, raw: n.raw, key: `${key}/${n.local}#${(childrenOf.get(key) || []).length}` });
    } else if (n.kind === 'close') {
      const top = path.pop();
      if (!top) issues.push(`</${n.raw}> at ${n.offset} closes nothing`);
    }
  }

  // Sequence and choice rules, from the recorded child order of every element that has them.
  for (const [key, list] of childrenOf) {
    const parentLocal = key ? /\/([A-Za-z]+)#\d+$/.exec(key)?.[1] : null;
    const spec = parentLocal ? ELEMENTS[parentLocal] : ELEMENTS.model;
    if (!spec) continue;
    if (spec.sequence) {
      const order = spec.sequence;
      let last = -1;
      for (const child of list) {
        const at = order.indexOf(child);
        if (at < 0) continue; // already reported as an unknown element
        if (at < last) {
          issues.push(`<${parentLocal || 'model'}>: <${child}> appears after <${order[last]}>; the schema's sequence is ${order.filter((x) => list.includes(x)).join(', ')}`);
          break;
        }
        last = at;
      }
      if (parentLocal === 'model') {
        const counts = list.reduce((a, x) => ((a[x] = (a[x] || 0) + 1), a), {});
        if ((counts.resources || 0) !== 1) issues.push(`model must contain exactly one <resources>, found ${counts.resources || 0}`);
        if ((counts.build || 0) !== 1) issues.push(`model must contain exactly one <build>, found ${counts.build || 0}`);
      }
      if (parentLocal === 'mesh') {
        const counts = list.reduce((a, x) => ((a[x] = (a[x] || 0) + 1), a), {});
        if ((counts.vertices || 0) !== 1) issues.push(`mesh must contain exactly one <vertices>, found ${counts.vertices || 0}`);
        if ((counts.triangles || 0) !== 1) issues.push(`mesh must contain exactly one <triangles>, found ${counts.triangles || 0}`);
      }
    }
    if (spec.choice) {
      const present = list.filter((x) => spec.choice.includes(x));
      if (present.length !== 1) issues.push(`<${parentLocal}>: the schema allows exactly one of ${spec.choice.join(' | ')}, found ${present.length ? present.join(', ') : 'none'}`);
    }
  }

  // Geometry: a pid must point at a material group that exists, triangle indices must be in
  // range, and a triangle's three vertices must be distinct -- a degenerate triangle is not a
  // mesh defect a slicer reports, it is one it silently drops, which changes the printed part.
  for (const o of objects) {
    if (o.node.attrs.pid !== undefined && !materialIds.has(o.node.attrs.pid)) {
      issues.push(`${o.where}: pid="${o.node.attrs.pid}" refers to no <basematerials> in this document`);
    }
  }
  // Triangle index checks need the attribute values, which the child-name map does not carry.
  const perObjectVertices = [];
  {
    let current = null;
    for (const n of nodes) {
      if ((n.kind === 'open' || n.kind === 'selfclose') && n.local === 'object') current = { v: 0, t: [], hasMesh: false, where: `<object id="${n.attrs.id}">` };
      if (current && (n.kind === 'open' || n.kind === 'selfclose') && n.local === 'mesh') current.hasMesh = true;
      if (n.kind === 'close' && n.local === 'object' && current) {
        perObjectVertices.push(current);
        current = null;
      }
      if (!current) continue;
      if ((n.kind === 'selfclose') && n.local === 'vertex') current.v++;
      if ((n.kind === 'selfclose') && n.local === 'triangle') current.t.push(n);
    }
  }
  for (const o of perObjectVertices) {
    // CT_Vertices requires at least 3 vertex entries, CT_Triangles at least 1 (XSD L110-125).
    if (o.hasMesh && o.v < 3) issues.push(`${o.where}: <vertices> has ${o.v} entries; CT_Vertices requires at least 3`);
    if (o.hasMesh && o.t.length < 1) issues.push(`${o.where}: <triangles> is empty; CT_Triangles requires at least 1`);
    for (const t of o.t) {
      const idx = [t.attrs.v1, t.attrs.v2, t.attrs.v3].map((x) => Number(x));
      for (const [k, v] of idx.entries()) {
        if (!Number.isInteger(v) || v < 0) issues.push(`${o.where}: triangle v${k + 1}="${t.attrs['v' + (k + 1)]}" is not a non-negative integer`);
        else if (v >= o.v) issues.push(`${o.where}: triangle v${k + 1}=${v} is out of range for ${o.v} vertices`);
      }
      if (new Set(idx).size !== 3) issues.push(`${o.where}: degenerate triangle (${idx.join(',')}) -- two or three of its vertices are the same point`);
    }
  }
  for (const n of nodes) {
    if ((n.kind === 'selfclose' || n.kind === 'open') && n.local === 'item') {
      if (n.attrs.objectid !== undefined && !ids.has(n.attrs.objectid)) {
        issues.push(`<item> at ${n.offset}: objectid="${n.attrs.objectid}" refers to no object id in this document`);
      }
    }
    if ((n.kind === 'selfclose' || n.kind === 'open') && n.local === 'vertex') {
      for (const axis of ['x', 'y', 'z']) {
        const v = n.attrs[axis];
        if (v === undefined) continue;
        if (!isDouble(v)) issues.push(`<vertex> at ${n.offset}: ${axis}="${v}" is not a finite xs:double`);
        else if (Math.abs(Number(v)) > 1e32) issues.push(`<vertex> at ${n.offset}: ${axis}="${v}" exceeds the coordinate magnitude a slicer can represent`);
      }
    }
  }

  const unit = root.attrs.unit;
  return {
    ok: issues.length === 0,
    issues,
    stats: {
      unit: unit === undefined ? 'millimeter (schema default)' : unit,
      objects: perObjectVertices.length,
      vertices: perObjectVertices.reduce((a, o) => a + o.v, 0),
      triangles: perObjectVertices.reduce((a, o) => a + o.t.length, 0),
      ids: ids.size,
      materialIds: [...materialIds],
      nodes: nodes.length,
    },
  };
}

/* ------------------------------------------------------------------ package */

function textOf(entry) {
  return new TextDecoder('utf-8', { fatal: false }).decode(entry.data);
}

/** Normalize an OPC part name / relationship target to the form the zip entry names use. */
function partName(target) {
  let t = String(target).trim();
  if (t.startsWith('/')) t = t.slice(1);
  return t.replace(/\\/g, '/');
}

/**
 * Validate a whole `.3mf` package. The package rules are OPC's, and they are where a file that
 * opens fine in one slicer disappears in another: a part nobody declared a content type for, or
 * a start part relationship pointing somewhere else.
 */
export function validate3MF(bytes) {
  const issues = [];
  let entries;
  try {
    entries = readZip(bytes);
  } catch (e) {
    return { ok: false, issues: [`zip unreadable: ${e.message}`], stats: null };
  }
  const names = entries.map((e) => e.name);
  for (const part of [CONTENT_TYPES_PART, RELS_PART, MODEL_PART]) {
    if (!names.includes(part)) issues.push(`required part "${part}" is missing (have: ${names.join(', ')})`);
  }
  for (const n of names) {
    if (n.startsWith('/') || n.includes('\\') || n.split('/').includes('..')) issues.push(`part name "${n}" is not a legal relative OPC part name`);
    for (let k = 0; k < n.length; k++) {
      const c = n.charCodeAt(k);
      if (c < 0x20 || c > 0x7e) {
        issues.push(`part name "${n}" contains a non-printable-ASCII character`);
        break;
      }
    }
  }

  const byName = new Map(entries.map((e) => [e.name, e]));
  const ct = byName.get(CONTENT_TYPES_PART);
  const rels = byName.get(RELS_PART);
  const model = byName.get(MODEL_PART);

  if (ct) {
    const text = textOf(ct);
    const { nodes, issues: ctIssues } = scanXml(text);
    issues.push(...ctIssues.map((s) => `[Content_Types].xml: ${s}`));
    const root = nodes.find((n) => (n.kind === 'open' || n.kind === 'selfclose') && n.depth === 0);
    if (!root || root.uri !== CONTENT_TYPES_NS || root.local !== 'Types') {
      issues.push(`[Content_Types].xml: root is <${root ? root.local : '?' }> in "${root ? root.uri : ''}", expected <Types> in "${CONTENT_TYPES_NS}"`);
    }
    const defaults = new Map();
    const overrides = new Map();
    for (const n of nodes) {
      if (n.kind !== 'selfclose' && n.kind !== 'open') continue;
      if (n.local === 'Default' && n.attrs.Extension) defaults.set(String(n.attrs.Extension).toLowerCase(), n.attrs.ContentType);
      if (n.local === 'Override' && n.attrs.PartName) overrides.set(partName(n.attrs.PartName), n.attrs.ContentType);
    }
    for (const name of names) {
      if (name === CONTENT_TYPES_PART) continue; // the content-type part is never typed by itself
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      if (!overrides.has(name) && !defaults.has(ext)) {
        issues.push(`[Content_Types].xml: part "${name}" has no content type (needs a Default for ".${ext}" or an Override)`);
      }
    }
    const modelType = overrides.get(MODEL_PART) || defaults.get('model');
    if (modelType !== MODEL_CONTENT_TYPE) {
      issues.push(`[Content_Types].xml: the model part is typed "${modelType || '(nothing)'}", expected "${MODEL_CONTENT_TYPE}"`);
    }
    if (!rels) issues.push(`_rels/.rels is missing`);
  }

  if (rels) {
    const text = textOf(rels);
    const { nodes, issues: rIssues } = scanXml(text);
    issues.push(...rIssues.map((s) => `_rels/.rels: ${s}`));
    const root = nodes.find((n) => (n.kind === 'open' || n.kind === 'selfclose') && n.depth === 0);
    if (!root || root.uri !== RELATIONSHIPS_NS || root.local !== 'Relationships') {
      issues.push(`_rels/.rels: root is <${root ? root.local : '?'}> in "${root ? root.uri : ''}", expected <Relationships> in "${RELATIONSHIPS_NS}"`);
    }
    const seenIds = new Set();
    let startPoint = 0;
    for (const n of nodes) {
      if (n.local !== 'Relationship' || (n.kind !== 'selfclose' && n.kind !== 'open')) continue;
      const id = n.attrs.Id;
      if (!id) issues.push('_rels/.rels: a Relationship has no Id');
      else if (seenIds.has(id)) issues.push(`_rels/.rels: relationship Id "${id}" is used twice`);
      else seenIds.add(id);
      if (!n.attrs.Type) issues.push('_rels/.rels: a Relationship has no Type');
      if (!n.attrs.Target) issues.push('_rels/.rels: a Relationship has no Target');
      if (n.attrs.TargetMode && n.attrs.TargetMode !== 'Internal' && n.attrs.TargetMode !== 'External') {
        issues.push(`_rels/.rels: TargetMode="${n.attrs.TargetMode}" is not Internal or External`);
      }
      if (n.attrs.TargetMode !== 'External' && n.attrs.Target && !names.includes(partName(n.attrs.Target))) {
        issues.push(`_rels/.rels: Target "${n.attrs.Target}" does not exist in the package`);
      }
      if (n.attrs.Type === START_PART_REL_TYPE) {
        startPoint++;
        if (partName(n.attrs.Target || '') !== MODEL_PART) {
          issues.push(`_rels/.rels: the 3MF start part points at "${n.attrs.Target}", expected "${MODEL_PART}"`);
        }
      }
      if (/^https?:\/\//i.test(n.attrs.Target || '') && n.attrs.TargetMode !== 'External') {
        issues.push(`_rels/.rels: Target "${n.attrs.Target}" looks like an external URL but is not marked TargetMode="External"`);
      }
    }
    if (startPoint !== 1) issues.push(`_rels/.rels: expected exactly one start-part relationship (${START_PART_REL_TYPE}), found ${startPoint}`);
  }

  let modelResult = null;
  if (model) {
    modelResult = validateModelXml(textOf(model));
    issues.push(...modelResult.issues.map((s) => `3D/3dmodel.model: ${s}`));
  }

  return {
    ok: issues.length === 0,
    issues,
    stats: {
      parts: names.length,
      partNames: names,
      bytes: bytes.length,
      model: modelResult ? modelResult.stats : null,
    },
  };
}

/* ------------------------------------------------------------------ cli */

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

function main(argv) {
  const files = argv.filter((a) => !a.startsWith('--'));
  const json = argv.includes('--json');
  if (!files.length) {
    console.log('usage: node tools/check-3mf.mjs FILE.3mf [...] [--json]');
    console.log('  checks the 3MF Core 1.4 subset this repository can decide from the bytes;');
    console.log('  it is not schema conformance (no XSD on this machine) -- see docs/ACCEPTANCE.md G8.');
    return 0;
  }
  let bad = 0;
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(f));
    const r = validate3MF(bytes);
    if (json) {
      console.log(JSON.stringify({ file: f, ...r }, null, 2));
    } else {
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${f}  ${r.stats ? `${r.stats.parts} parts, ${r.stats.model ? `${r.stats.model.objects} objects / ${r.stats.model.triangles} triangles / ${r.stats.model.vertices} vertices` : ''}` : ''}`);
      for (const i of r.issues.slice(0, 20)) console.log(`       - ${i}`);
      if (r.issues.length > 20) console.log(`       ... and ${r.issues.length - 20} more`);
    }
    if (!r.ok) bad++;
  }
  if (bad) {
    console.log(`3MF subset check: ${bad}/${files.length} file(s) failed`);
    return 1;
  }
  console.log(`3MF subset check: ${files.length} file(s) clean`);
  return 0;
}

if (isMain) process.exitCode = main(process.argv.slice(2));
