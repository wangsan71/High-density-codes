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
