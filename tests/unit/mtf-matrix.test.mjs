/**
 * tools/mtf-matrix.mjs -- labelling, the per-capture verdict, and the self-test.
 *
 * G10 (the nozzle x parameter matrix) needs a real printer, so the tool cannot be
 * accepted by a gate here. What *can* be pinned is everything up to the pixels: which
 * nozzle a file name claims, when a capture is allowed to come back coarser, and that the
 * whole path still works end to end on captures this machine can make (the plate rendered
 * as a printer with each nozzle's extrusion width would print it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nozzleFromLabel,
  parseLabelArg,
  labelsFromJson,
  judgeCapture,
  buildMatrix,
  formatMatrix,
  summarise,
  selftest,
} from '../../tools/mtf-matrix.mjs';

test('mtf-matrix: a file name names a nozzle, or names nothing', () => {
  const yes = {
    'n02.png': '0.2',
    'nozzle-0.4.png': '0.4',
    'nozzle_06.png': '0.6',
    'ew070.png': '0.6',
    'ew-0.95.png': '0.8',
    '0.26.png': '0.2',
    '0.45.png': '0.4',
    'print-0.8mm.png': '0.8',
  };
  for (const [name, want] of Object.entries(yes)) {
    assert.equal(nozzleFromLabel(name), want, `${name} -> ${want}`);
  }
  // A guess here would turn a mislabelled capture into a passing row, so anything that is
  // not exactly one known nozzle must come back null.
  for (const name of ['photo.png', 'IMG_2043.png', '0.5.png', 'n13.png', '1.0mm.png', 'capture.png']) {
    assert.equal(nozzleFromLabel(name), null, `${name} must not resolve to a nozzle`);
  }
  assert.equal(nozzleFromLabel('0.2-and-0.4.png'), null, 'two nozzles in one name is ambiguous');
  assert.equal(nozzleFromLabel(null), null);
});

test('mtf-matrix: an explicit --label beats a misleading file name', () => {
  assert.deepEqual(parseLabelArg('0.4=n04.png'), { file: 'n04.png', nozzle: '0.4' });
  assert.deepEqual(parseLabelArg('n04.png=0.4'), { file: 'n04.png', nozzle: '0.4' });
  // The documented form is NOZZLE=FILE and the left side wins: otherwise a user could not
  // correct a capture whose name lies about the nozzle.
  assert.deepEqual(parseLabelArg('0.8=n04.png'), { file: 'n04.png', nozzle: '0.8' });
  assert.throws(() => parseLabelArg('n04.png'), /NOZZLE=FILE/);
  assert.throws(() => parseLabelArg('photo.png=IMG_2.png'), /does not name a nozzle/);
});

test('mtf-matrix: the sidecar map works in both directions', () => {
  const a = labelsFromJson('{"0.4":"n04.png","0.8":"n08.png"}');
  assert.equal(a.get('n04.png'), '0.4');
  assert.equal(a.get('n08.png'), '0.8');
  const b = labelsFromJson('{"n04.png":"0.4"}');
  assert.equal(b.get('n04.png'), '0.4');
  assert.equal(labelsFromJson('{"what.png":"maybe"}').size, 0, 'an unknown value must not become a label');
});

test('mtf-matrix: only the finest nozzle may come back coarser, and only with a reason', () => {
  const recFor = (id, ownRungResolved) => ({
    ok: true,
    floorMm: 0.45,
    nozzle: { id, why: 'because' },
    nozzles: [
      { id: '0.2', ewMm: 0.26, tested: true, rungResolved: ownRungResolved },
      { id: '0.4', ewMm: 0.45, tested: true, rungResolved: true },
    ],
  });
  const m = { ok: true, registration: 'markers', coverage: 1 };
  // printed at 0.2, resolves 0.2 -> its own name
  assert.equal(judgeCapture(m, recFor('0.2', true), '0.2').verdict, 'names-itself');
  // printed at 0.2, resolves 0.4, and the 0.26 rung really came back filled -> allowed
  assert.equal(judgeCapture(m, recFor('0.4', false), '0.2').verdict, 'allowed-coarser');
  // the same, but the reader does NOT say the rung was filled -> not allowed
  assert.equal(judgeCapture(m, recFor('0.4', true), '0.2').verdict, 'mismatch');
  // a coarser nozzle never gets that allowance
  assert.equal(judgeCapture(m, recFor('0.2', false), '0.8').verdict, 'mismatch');
  // unlabelled / unregistered / unreadable are reported as themselves
  assert.equal(judgeCapture(m, recFor('0.4', true), null).verdict, 'unlabelled');
  assert.equal(judgeCapture({ ok: false, stage: 'markers', reason: 'no-hollow-corner' }, null, '0.4').verdict, 'unregistered');
  assert.equal(judgeCapture(null, null, '0.4').verdict, 'unreadable');
  assert.equal(judgeCapture(m, { ok: false, reason: 'no nozzle' }, '0.4').verdict, 'mismatch');
});

test('mtf-matrix: the table and the exit code follow the rows', () => {
  const m = { ok: true, registration: 'markers', coverage: 0.98 };
  const rec = (id) => ({ ok: true, floorMm: 0.45, nozzle: { id, why: 'w' }, nozzles: [] });
  const rows = buildMatrix([
    { file: 'n04.png', printed: '0.4', measurement: m, rec: rec('0.4') },
    { file: 'n06.png', printed: '0.6', measurement: m, rec: rec('0.4') },
    { file: 'photo.png', printed: null, measurement: m, rec: rec('0.4') },
  ]);
  assert.deepEqual(rows.map((r) => r.verdict), ['names-itself', 'mismatch', 'unlabelled']);
  const table = formatMatrix(rows);
  assert.match(table, /^capture\s+printed\s+recommends/m, 'header');
  assert.equal(table.split('\n').length, 5, 'header + rule + three rows');
  const s = summarise(rows);
  assert.deepEqual(
    { total: s.total, labelled: s.labelled, named: s.named, failed: s.failed, exitCode: s.exitCode },
    { total: 3, labelled: 2, named: 1, failed: 1, exitCode: 1 },
    'a labelled mismatch fails, an unlabelled capture does not',
  );
  assert.equal(summarise(rows.filter((r) => r.verdict !== 'mismatch')).exitCode, 0);
});

test('mtf-matrix: the self-test names all four nozzles and both controls hold', () => {
  const st = selftest();
  assert.deepEqual(st.problems, [], 'no problems');
  assert.equal(st.ok, true);
  assert.equal(st.rows.length, 4, 'one row per nozzle');
  for (const row of st.rows) {
    assert.equal(row.printed, row.recommended, `${row.file} must name its own nozzle`);
    assert.ok(row.verdict === 'names-itself' || row.verdict === 'allowed-coarser', row.verdict);
  }
  // The controls live inside selftest(): EW 1.40 must resolve nothing, and the pristine
  // render must resolve at least one rung. If either stopped holding, problems would be
  // non-empty -- which is why the assertion above is on problems, not just on ok.
});
