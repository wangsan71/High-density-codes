/**
 * What to call a recovered file when the user downloads it.
 *
 * The printed header carries no filename: core/frame.js's layout is magic..length..pages..digest..crc16
 * and nothing else, so the receiver genuinely does not know what the sender called the file, and
 * inventing a name would be a claim the bytes cannot support. The honest default is therefore derived
 * from the bytes themselves -- `pskt-<length>B-<first 12 hex of the digest>.bin` -- and that is exactly
 * what both web receive paths used to hardcode.
 *
 * Hardcoding it is fine on a desktop and bad on a phone, which is why this module exists: iOS and
 * Android decide how to OPEN a file from its extension, so a user who sent report.pdf and scanned it
 * back gets something no app will claim, and then has to rename it inside the OS file manager to use
 * it (DEFECTS D62). The CLI never had this problem -- `receive --out <file>` lets the user name the
 * destination -- so the fix is to give the web paths the same ability without touching the protocol.
 *
 * The default is unchanged, byte for byte: an empty input still yields the digest-derived name. What
 * is added is a place for the user to type one, and this file is the whole policy for turning typed
 * text into a download name. That policy lives in core/ rather than in each page because a `download`
 * attribute is not a place to improvise: it has to end up a single path component, on every platform,
 * from text a human typed, and two copies of those rules would drift.
 *
 * Pure ESM, no node: builtins, no I/O: Node and the browser load this same file, and
 * tests/unit/naming.test.mjs pins the behaviour -- including that the default is still the old string.
 */

/**
 * Characters that cannot appear in a filename we hand to a browser.
 * `/` and `\` are path separators everywhere and this must stay a single component; the rest are
 * reserved on Windows, which is the platform this project is developed and tested on, so a name
 * containing them can fail at write time in ways the browser will not explain. Control characters
 * (U+0000-U+001F) are stripped because they are invisible: a name that looks fine and is not is
 * worse than one that looks mangled and is safe.
 */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/**
 * Reserved device names on Windows. A download called `NUL` or `COM1` does not become a file, and
 * the failure is silent enough to look like "the tool produced nothing". Cheap to refuse, so refused:
 * the caller falls back to the digest-derived name, which is always safe.
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Long enough for any real filename, short enough that no filesystem or URL length limit is hit. */
export const MAX_NAME_LEN = 120;

/**
 * The default name: derived from the bytes, because the bytes are all the receiver has.
 * Kept as one definition here so the two web paths cannot drift apart, and so the unit test can pin
 * the exact string the pages used to hardcode.
 */
export function digestName(byteLength, sha256Hex) {
  const hex = String(sha256Hex === undefined || sha256Hex === null ? '' : sha256Hex)
    .replace(/[^0-9a-fA-F]/g, '')
    .slice(0, 12);
  return `pskt-${byteLength}B-${hex}.bin`;
}

/**
 * Clean up what the user typed, or return '' when nothing usable is left.
 *
 * '' means "use the default", never "no name": callers must not be able to produce an empty download
 * attribute. Rules, in order, each with the reason it is there:
 *   1. strip characters that are path separators or platform-reserved (ILLEGAL above);
 *   2. collapse runs of whitespace and trim the ends -- a name typed on a phone keyboard arrives with
 *      stray spaces, and Windows ignores trailing spaces and dots anyway, so trimming them here means
 *      the name the user sees in the log is the name the file gets;
 *   3. trim leading dots: `..` and `.` are not filenames, and a leading dot makes the file hidden on
 *      unix-like systems, which on a phone looks like "the download disappeared";
 *   4. refuse Windows reserved device names;
 *   5. if it is too long, shorten the stem and KEEP THE EXTENSION -- truncating from the end would
 *      eat `.pdf`, and losing the extension is the exact failure this module exists to prevent;
 *   6. refuse a bare extension (`.pdf`) or an empty result: neither is a usable name.
 */
export function sanitizeFileName(text) {
  let s = String(text === undefined || text === null ? '' : text).replace(ILLEGAL, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[.\s]+$/, ''); // Windows discards trailing dots and spaces, so the name shown is the name written
  // Anything starting with a dot is refused: `.` and `..` are not names, `../../etc/passwd` becomes
  // `....etcpasswd` once the separators are stripped and still starts with a dot, and a leading dot
  // hides the file on unix-like systems -- on a phone that reads as "the download disappeared". A bare
  // extension (`.pdf`) lands here too and is handled by downloadName, which knows what it means.
  if (!s || s.startsWith('.')) return '';
  const dot = s.lastIndexOf('.');
  const stem = dot > 0 ? s.slice(0, dot) : s;
  const ext = dot > 0 ? s.slice(dot) : '';
  if (!stem || RESERVED.test(stem)) return '';
  // Shorten the stem, never the extension: eating `.pdf` is the exact failure this module prevents.
  if (stem.length + ext.length > MAX_NAME_LEN) s = stem.slice(0, Math.max(1, MAX_NAME_LEN - ext.length)) + ext;
  return s;
}

/**
 * The name to put in a download attribute.
 *
 * Returns the user's name when it survives sanitizeFileName, and the digest-derived default otherwise.
 * It never returns '' and never returns anything containing a path separator, whatever was typed --
 * tests/unit/naming.test.mjs asserts both over a list of deliberately hostile inputs.
 */
export function downloadName(opts) {
  const o = opts || {};
  const fallback = digestName(o.byteLength, o.sha256Hex);
  const cleaned = sanitizeFileName(o.userText);
  if (cleaned) return cleaned;
  // A bare extension is what a phone user types when they mean "make this openable": `.pdf`. Read it
  // as "the default name, with this extension", so the stem stays digest-derived and nothing is
  // invented -- the receiver still does not claim to know what the sender called the file.
  const ext = /^\.([A-Za-z0-9]{1,10})$/.exec(String(o.userText === undefined || o.userText === null ? '' : o.userText).trim());
  if (ext) return fallback.replace(/\.bin$/, `.${ext[1]}`);
  return fallback;
}
