/**
 * PSKT-1 · what to tell a human when a page will not read.
 *
 * G4 requires more than "it failed": every rejection must be *classified* and
 * carry an actionable retake instruction. That belongs in `core/` rather than in
 * one client because the CLI, the browser receiver and the acceptance suite all
 * have to say the same thing for the same physical cause -- and because a
 * message that names the wrong cause teaches the operator to do the wrong fix
 * (brighter light will not help a mirrored page).
 */

const ADVICE = {
  // ---- marker detection -------------------------------------------------
  'blank-image': {
    cause: 'the image is (almost) uniform -- nothing was printed, the lens was covered, or the scan was empty',
    do: 'check that this file is a page image; retake with the whole code inside the frame',
  },
  'no-square-candidates': {
    cause: 'no isolated square blob was found, so the corner markers are not resolvable -- usually defocus, extreme blur, or a print whose features are smaller than the camera can resolve',
    do: 'move closer or use 2x optical zoom, hold still, and wipe the lens; if the plate is FDM, print the next coarser nozzle profile',
  },
  'no-marker-size-cluster': {
    cause: 'squares were found but not four of the same size -- the page is partly out of frame or strongly perspective-distorted, so markers differ in apparent size',
    do: 'fit the whole page inside the frame including all four corners; keep the camera parallel to the page',
  },
  'too-few-candidates': {
    cause: 'fewer than four marker candidates survived',
    do: 'straighten the page and remove the glare: one corner marker is likely hidden by a reflection or a finger',
  },
  'quad-too-small-for-page-region': {
    cause: 'the four detected squares do not span the printed area -- they are probably data cells or echo-strip marks, not the page corners',
    do: 'move so the whole page is visible; do not crop into the code area',
  },
  'mirrored-image': {
    cause: 'the only consistent reading is a mirror image -- the page is face down, or the scan came from the back of the sheet',
    do: 'flip the page over (printed side up) and retake; this is not a focus problem',
  },
  'no-hollow-corner': {
    cause: 'four markers were found but none of them is hollow -- the orientation marker is unreadable (scuffed, over-exposed, or the wrong side of an FDM plate)',
    do: 'use the top face of the plate and retake without a direct reflection on the hollow corner',
  },
  'fourth-corner-out-of-frame': {
    cause: 'three corner markers were found, and the rectangle they imply puts the fourth corner outside the image -- the sheet is tilted or too close, so one corner never made it into the photo',
    do: 'back up and square the page to the frame until all four corners are visible, then retake; this is a framing problem, not a focus or cleaning problem',
  },
  'no-rectangular-quad': {
    cause: 'the marker candidates do not form a plausible rectangle',
    do: 'remove occlusions (fingers, page edges of a neighbour) and retake with the page flat',
  },
  // ---- geometry ---------------------------------------------------------
  'homography-degenerate': {
    cause: 'the four corners could not define a homography (they are collinear or duplicated)',
    do: 'do not shoot the page edge-on; keep it within about 35 degrees of face-on',
  },
  'quad-covers-little-of-the-photo': {
    cause: 'most of the reconstructed page falls outside the photo -- the frame does not contain the whole page',
    do: 'back up until the entire page, including the quiet margin, is inside the frame',
  },
  // ---- header echo strip ------------------------------------------------
  'echo-bad-magic': {
    cause: 'the header echo strip decoded but with the wrong magic -- the strip is damaged, or this image is a different code family',
    do: 'retake so the narrow strip above the lattice is fully in frame and in focus',
  },
  'echo-header-crc': {
    cause: 'the header echo strip failed its CRC -- usually a smudge or glare across the top margin',
    do: 'clean the plate surface / re-scan without the lamp reflection crossing the top strip',
  },
  'echo-short-header': {
    cause: 'not enough echo cells were readable to form a header (too few bits recovered)',
    do: 'move closer: the echo strip is the finest feature on the page and needs the most resolution',
  },
  'echo-unknown-profile-code': {
    cause: 'the header decoded but names a profile this build does not know',
    do: 'update the receiver, or check whether the page came from a different version',
  },
  'echo-version': {
    cause: 'the header declares an unsupported protocol version',
    do: 'use a receiver built for that version',
  },
  // ---- readout ----------------------------------------------------------
  'levels-length': {
    cause: 'the decoded lattice has the wrong number of cells for the manifest profile',
    do: 'check the profile/nozzle arguments -- the page was printed with a different geometry than the one being assumed',
  },
  // ---- frame / assembly ---------------------------------------------------
  // These are emitted by core/frame.js and core/protocol.js, not by the camera
  // stages, and until now they had no mapping at all: a page whose own Reed-Solomon
  // ran out of budget printed "unmapped failure (assemble: intra-fail)" and told the
  // user to retake the whole batch, when in fact one page is damaged and the others
  // are fine. Advice has to carry that difference or it sends people to the wrong work.
  'intra-fail': {
    cause: "this page's own error correction ran out of budget: too many cells inside the page are unreadable (a smudge, a crease, or out-of-focus area)",
    do: 're-scan or re-photo just this page -- the other pages are usable and the parity pages can also rebuild this one, so there is no need to reprint',
  },
  'bad-magic': {
    cause: 'a header decoded to a length/CRC that looked valid but its magic bytes are not PSK1 -- the byte stream being read is not a PSKT header at that offset',
    do: 'check that the input directory holds only one transfer, and that no unrelated file (or an image from another encoder) was mixed in',
  },
  'header-crc': {
    cause: "the page header failed its own CRC, so the geometry metadata (page index, profile, lengths) is not trustworthy and nothing was decoded from it",
    do: 'retake this page with the whole header echo strip and all four corners in frame and in focus -- a page cropped at the top margin fails here first',
  },
  'short-header': {
    cause: 'fewer bytes than the fixed header length were available to read',
    do: 'the input was cut short -- re-export the image (or re-copy the file) and check it is complete; partial files also cause this',
  },
  'other-session': {
    cause: 'this page belongs to a different transfer (session id) than the pages already collected, so mixing them would reconstruct the wrong file',
    do: 'separate the printouts: one scan should contain the pages of one transfer only, or re-scan each transfer on its own',
  },
  // ---- error-correction internals that reach the user ---------------------
  // These come out of core/rs.js and the frame length checks. They are reachable
  // through the same `REJECTED page N (reason)` line, so they need the same quality
  // of advice: the point of the message is to tell someone which of the two things
  // they can act on -- the photo, or their geometry assumption.
  'too-many-erasures': {
    cause: 'more cells were declared unreadable than this block can correct -- the erasure list alone exceeded the parity budget',
    do: 'supply the parity pages for this transfer (pskit receive picks them up automatically), or re-photo the page so fewer cells are lost at once',
  },
  'erasure-oob': {
    cause: 'an erasure position fell outside the block, which means the page geometry used to count cells does not match the page that was printed',
    do: 're-select the profile and nozzle that were actually used to print -- an assumed pitch different from the printed one produces exactly this',
  },
  'beyond-limit': {
    cause: "the block's errors plus erasures exceed what its Reed-Solomon parity can repair (2t + e must fit the parity symbols)",
    do: 'improve the read: better focus and no glare across that area; if it persists, print with a stronger profile (more parity per page) rather than reprinting the payload',
  },
  chien: {
    cause: 'the correction search found no error pattern consistent with the syndromes -- usually because the cells were mapped to symbol values using the wrong pitch, so the whole lattice is read at an offset',
    do: 'confirm the profile/nozzle the page was printed with; if it is right, re-scan at higher resolution -- a page read at too few pixels per cell corrupts every symbol, not just some',
  },
  short: {
    cause: 'the byte stream was shorter than this structure requires',
    do: 'the input file or image was truncated -- re-copy it and check its size against the manifest',
  },
  long: {
    cause: 'the byte stream was longer than this structure allows, so it was not framed where it should have been',
    do: 'check that the input contains only PSKT page images and no unrelated data file',
  },
  // ---- Reed-Solomon internals ---------------------------------------------
  // These name *why* correction failed, which is more actionable than the generic
  // intra-fail the page is rejected with, so they get their own advice too.
  'chien-mismatch': {
    cause: 'the error search produced positions but the corrected symbols did not reproduce the syndromes, so the corruption pattern is not decodable as errors of this code',
    do: 'treat the page as unreadable and re-photo it; a systematic mismatch like this usually means the cell grid was sampled at the wrong pitch (check profile/nozzle)',
  },
  'erasure-not-in-locator': {
    cause: 'a cell was declared unreadable that the locator polynomial does not contain, which cannot happen from noise alone -- the erasure list and the symbol stream disagree',
    do: 'report this as a decoder bug if it reproduces on an unscanned render; on real photos it means the page was read with the wrong geometry',
  },
  'forney-den0': {
    cause: 'the magnitude formula divided by a zero evaluator term, i.e. an error position was found at a point where the code has no support',
    do: 'same as erasure-not-in-locator: re-photo, and flag it if it survives a clean render',
  },
  'recheck-failed': {
    cause: 'correction produced a candidate codeword whose syndromes do not all vanish, so it was refused rather than accepted -- the receiver will not emit data it cannot prove',
    do: 'nothing to fix in the file: the refusal is correct. Supply the parity pages or re-photo the offending page',
  },
  // From core/decode/bootstrap.js: the browser path has no manifest, so it searches
  // candidate geometries. Both outcomes must carry advice -- decision 11 says a reason
  // without a physical cause and a re-shoot instruction is a failure of the receiver,
  // not of the paper.
  'no-candidate-geometry': {
    cause: '接收端手里没有任何可尝试的页面几何候选（profile/dpi/palette 的提示组合把已知剖面全排除了）',
    do: '把"剖面/dpi/色板"改回"自动"，或按打印时用的那一档手动指定后重试。',
  },
  'no-geometry-matched': {
    cause: '所有候选几何都没能让页头通过三重核对（magic + version + CRC16）：图上没有本工具的页码，或角标/分辨率差得太远，或页来自另一套剖面参数',
    do: '确认拍的是 PSKT 页且四个角标完整在画面内；纸面请用 300 dpi 以上扫描；若知道打印剖面就在下拉框里指定它（可少走十几秒的候选搜索）。',
  },
  'no-candidate': {
    cause: 'not one threshold across the header strip produced a header with the right magic and a valid CRC, so the strip is destroyed rather than merely mis-exposed (or the page is being read with the wrong geometry)',
    do: 're-photo this page so the narrow strip above the lattice is fully inside the frame and in focus; if it persists, confirm the profile and nozzle the page was printed with',
  },
};

/**
 * @param {{stage?:string, reason?:string}} failure
 * @returns {{cause:string, do:string, known:boolean, hint?:string}}
 */
export function advise(failure) {
  const key = failure.reason || 'unknown';
  const hit = ADVICE[key];
  if (hit) return { ...hit, known: true };
  // A reason we do not know must still produce guidance, and must announce that
  // it is unmapped so the gap shows up in test output instead of silently
  // borrowing somebody else's advice.
  return {
    cause: `unmapped failure (${failure.stage || '?'}: ${key})`,
    do: 'retake the photo with the whole page flat, in frame, and free of glare',
    known: false,
  };
}

/** All mapped reasons -- used by the acceptance suite to assert coverage. */
export function knownReasons() {
  return Object.keys(ADVICE).sort();
}
