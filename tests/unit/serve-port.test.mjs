/**
 * The port-busy wording is the fix, so the wording is under test.
 *
 * tools/serve.mjs met a port that would not bind while nothing appeared to be listening: 8131 was
 * held as the local port of an outbound ESTABLISHED connection, which `netstat -ano | findstr
 * LISTENING` does not show and Get-NetTCPConnection did not report either, while bind still failed
 * with EADDRINUSE. The obvious message ("something is already on that port") is half true and sends
 * the user to look in the one place that will show them nothing. These assertions keep both causes
 * named, keep the command that actually reveals them (every state, not just LISTENING), and keep the
 * two behaviours distinct: a port nobody asked for may move, a port asked for explicitly may not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyMessage } from '../../tools/serve.mjs';

test('an explicitly requested port is not moved, and says so', () => {
  const m = busyMessage(8000, true, null);
  assert.match(m, /port 8000 will not bind/, 'must name the port that failed');
  assert.match(m, /not being moved behind your back/, 'must promise the explicit port is not silently changed');
  assert.doesNotMatch(m, /trying \d+/, 'must not offer a substitute port when one was requested');
});

test('a port nobody asked for moves, and says what it moved to', () => {
  const m = busyMessage(8000, false, 8001);
  assert.match(m, /trying 8001/, 'must name the next port it will use');
  assert.match(m, /--port was not given explicitly/, 'must justify why moving is safe');
});

test('both real causes are named, including the one netstat hides', () => {
  for (const explicit of [true, false]) {
    const m = busyMessage(8131, explicit, explicit ? null : 8132);
    assert.match(m, /listening on it/, 'cause (a): something is listening');
    assert.match(m, /outbound connection/i, 'cause (b): an outbound connection holding it as its local port');
    assert.match(m, /EADDRINUSE/, 'must name the error the user actually saw');
    assert.match(m, /netstat -ano \| findstr :8131/, 'must give the command that shows it');
    assert.match(m, /not just LISTENING/, 'must warn that a LISTENING filter will show nothing');
    // The old wording was the defect: half true, and it points at the one view that stays empty.
    assert.doesNotMatch(m, /something is already on that port/, 'the half-true wording must not come back');
  }
});
