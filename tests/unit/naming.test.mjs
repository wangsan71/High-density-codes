/**
 * core/naming.js: the download-name policy behind DEFECTS D62.
 *
 * The first test is a positive control rather than a feature test, and it is the one that matters most.
 * Both web receive paths used to hardcode `pskt-<len>B-<digest12>.bin`; the fix adds an OPTIONAL name.
 * If the default moved by one byte, every user who leaves the box empty -- which is what the page told
 * them to do until today -- would get a differently named file, and nothing else in the suite would
 * notice, because the pages themselves cannot be loaded in process (no browser on this machine).
 *
 * The hostile-input test is the other half of the reason this policy lives in core/ instead of in each
 * page: a `download` attribute built from typed text has to end up a single path component on every
 * platform, and two copies of those rules would drift until one of them shipped a traversal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadName, digestName, sanitizeFileName, MAX_NAME_LEN } from '../../core/naming.js';

test('naming: with nothing typed, the name is byte-for-byte what the pages used to hardcode', () => {
  assert.equal(digestName(204800, '32ec480521da27d2'), 'pskt-204800B-32ec480521da.bin');
  // A longer digest is cut to 12 hex chars, and non-hex characters are dropped rather than encoded.
  assert.equal(digestName(204800, '32ec480521da27d2ffffffffffffffff'), 'pskt-204800B-32ec480521da.bin');
  assert.equal(digestName(7, 'abc'), 'pskt-7B-abc.bin');
  for (const userText of [undefined, null, '', '   ', '\t\n']) {
    assert.equal(
      downloadName({ byteLength: 204800, sha256Hex: '32ec480521da27d2', userText }),
      'pskt-204800B-32ec480521da.bin',
      `the default moved for userText=${JSON.stringify(userText)}`
    );
  }
});

test('naming: a name the user types survives, extension and unicode included', () => {
  assert.equal(downloadName({ byteLength: 1, sha256Hex: 'aa', userText: 'report.pdf' }), 'report.pdf');
  assert.equal(sanitizeFileName('报告-2024.pdf'), '报告-2024.pdf'); // non-ASCII is not "illegal"
  assert.equal(sanitizeFileName('  my  file.tar.gz  '), 'my file.tar.gz'); // runs collapsed, ends trimmed
  assert.equal(sanitizeFileName('scan 001.PNG'), 'scan 001.PNG'); // case is the user's business
  assert.equal(sanitizeFileName('a b.pdf'), 'a b.pdf'); // a space inside a filename is legal
});

test('naming: nothing typed can become a path, a device name, or an empty download attribute', () => {
  const hostile = [
    '../../etc/passwd', '..\\windows\\system32\\x.dll', '/etc/passwd', 'C:\\boot.ini',
    '.', '..', '...', '.pdf', '.hidden',
    'a<b>c:d"e|f?g*h.pdf', 'bad\u0000name\u001f.pdf', '\u007f.pdf',
    'NUL', 'con.txt', 'COM1', 'lpt9.pdf',
    '   ', '', 'x'.repeat(400) + '.pdf',
  ];
  for (const userText of hostile) {
    const name = downloadName({ byteLength: 12, sha256Hex: 'deadbeefcafe', userText });
    const at = `userText=${JSON.stringify(userText.slice(0, 40))}`;
    assert.ok(name.length > 0, `empty download attribute for ${at}`);
    assert.ok(!/[\\/]/.test(name), `a path separator survived ${at}: ${name}`);
    assert.ok(!name.includes('..'), `traversal survived ${at}: ${name}`);
    assert.ok(!name.startsWith('.'), `a hidden-file name survived ${at}: ${name}`);
    assert.ok(name.length <= MAX_NAME_LEN, `over-long name ${at}: ${name.length} > ${MAX_NAME_LEN}`);
    assert.ok(!/[<>:"|?*\u0000-\u001f\u007f]/.test(name), `an illegal character survived ${at}: ${name}`);
  }
  // Truncation must keep the extension: losing it is the exact failure this module exists to prevent.
  const long = downloadName({ byteLength: 12, sha256Hex: 'deadbeefcafe', userText: 'x'.repeat(400) + '.pdf' });
  assert.ok(long.endsWith('.pdf'), `truncation ate the extension: ${long.slice(-12)}`);
  assert.equal(long.length, MAX_NAME_LEN);
  // Refusals fall back to the digest name rather than to something the bytes do not support.
  assert.equal(downloadName({ byteLength: 12, sha256Hex: 'deadbeefcafe', userText: 'NUL' }), 'pskt-12B-deadbeefcafe.bin');
  assert.equal(downloadName({ byteLength: 12, sha256Hex: 'deadbeefcafe', userText: '../../etc/passwd' }), 'pskt-12B-deadbeefcafe.bin');
});

test('naming: a bare extension means "the default name, but openable"', () => {
  // What a phone user types when the downloaded file will not open: not a name, an extension. The stem
  // stays digest-derived, so the receiver still claims nothing it cannot know from the bytes.
  assert.equal(downloadName({ byteLength: 12, sha256Hex: 'deadbeefcafe', userText: '.pdf' }), 'pskt-12B-deadbeefcafe.pdf');
  assert.equal(downloadName({ byteLength: 12, sha256Hex: 'deadbeefcafe', userText: ' .PNG ' }), 'pskt-12B-deadbeefcafe.PNG');
  // An extension that is not alphanumeric is not an extension; fall back instead of guessing.
  assert.equal(downloadName({ byteLength: 12, sha256Hex: 'deadbeefcafe', userText: '.p f' }), 'pskt-12B-deadbeefcafe.bin');
});

test('naming: a receiver that KNOWS the payload is an image may say so, and it moves only the fallback', () => {
  // Round 278 (D96): the browser receiver decodes a .psk image payload into a PNG, and a phone decides how
  // to open a file from its extension -- so the default name should be openable. Measured before the fix:
  // "将保存为 pskt-815B-403fea4f59a6.bin" for a picture the same page had just turned into a 96x64 PNG.
  assert.equal(
    downloadName({ byteLength: 815, sha256Hex: '403fea4f59a69ea5', defaultExt: 'png' }),
    'pskt-815B-403fea4f59a6.png',
  );
  // A name the user typed still wins, and so does a bare extension they typed.
  assert.equal(
    downloadName({ byteLength: 815, sha256Hex: '403fea4f59a69ea5', defaultExt: 'png', userText: 'report.pdf' }),
    'report.pdf',
  );
  assert.equal(
    downloadName({ byteLength: 815, sha256Hex: '403fea4f59a69ea5', defaultExt: 'png', userText: '.jpg' }),
    'pskt-815B-403fea4f59a6.jpg',
  );
  // A hostile or malformed hint is REFUSED, not sanitised: it cannot smuggle a path or a hidden name into
  // a download attribute, and it cannot change the default the pages have always produced.
  for (const defaultExt of ['../x', 'a/b', '..', '.png', 'p ng', 'A'.repeat(11), '', null, undefined]) {
    assert.equal(
      downloadName({ byteLength: 815, sha256Hex: '403fea4f59a69ea5', defaultExt }),
      'pskt-815B-403fea4f59a6.bin',
      'defaultExt=' + JSON.stringify(defaultExt) + ' must not change the default',
    );
  }
});
