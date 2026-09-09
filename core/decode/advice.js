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
  'no-contrast': {
    cause:
      'the ink and the paper were not separable in this capture: more than half the picture binarises as ink, against 25-35% for a healthy page. Three things do this -- over-exposure, a glare band, or shooting from so far that the cells smear into one another. It is NOT a framing problem: the corners can be perfectly in frame and still invisible.',
    do: 'lower the exposure (drag the brightness down before shooting), turn the flash off and move away from the reflection; then get closer or use 2x optical zoom so the code fills the frame. If you are scanning, switch auto-contrast/despeckle off. Reframing alone will not help',
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
  'echo-no-contrast': {
    cause:
      'the header echo strip had no usable contrast in this capture: its two levels sit only ~15% apart (a readable strip is 50%+). The strip is the finest feature on the page -- 1-bit cells half a data cell wide -- so it is the first thing a coarse or soft capture loses, well before the code area does.',
    do: 'get closer or use 2x optical zoom, make sure the top margin is inside the frame and in focus, and if the page still will not read use a coarser profile (600 dpi or a plate) or scan at 300 dpi instead of photographing',
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
  'digest-mismatch': {
    cause:
      'the bytes that came back do not hash to the digest the transfer declared, so the receiver refuses to write them -- the one failure this project never papers over (a wrong payload is worse than no payload)',
    do: 'supply the missing or unreadable pages (the parity pages rebuild them), or re-photograph the pages that failed; if the transfer was encrypted, check the passphrase is the one that was used',
  },
  'other-session': {
    cause: 'this page belongs to a different transfer (session id) than the pages already collected, so mixing them would reconstruct the wrong file',
    do: 'separate the printouts: one scan should contain the pages of one transfer only, or re-scan each transfer on its own',
  },
  // ---- the recalibrated re-read seam (core/decode/recalibrate.js) -----------
  // Neither of these is a page fault: they say why a page its own code rejected could not be offered
  // a second read. Both mean the caller wired the seam wrongly, so the advice points at the wiring --
  // telling the user to re-scan here would send them to the wrong work, which is exactly the failure
  // this table exists to prevent.
  'no-geometry': {
    cause: 'the re-read needs the page geometry recovered for this frame and the caller did not pass it, so the rejected page could not be re-decided',
    do: 'wiring: pass { geom } to feedPageWithRecalibration (bootstrapDecode returns it as boot.geom); the printout is not at fault',
  },
  'no-rho': {
    cause: 'the decode result carried no per-cell rho measurements, so there was nothing to calibrate a second read on',
    do: 'wiring: hand the helper a real decodePage result (it now carries rho and colourLevels); a hand-built page object does not',
  },
  // ---- the bootstrap search's generic per-candidate failure ------------------
  // This one is older than its entry. core/decode/bootstrap.js has always recorded a candidate
  // whose page read gave nothing more specific as `reason: r.reason || 'fail'`, and round 65 added
  // a second producer when it started CATCHING a candidate that threw (D55) instead of letting the
  // exception escape to the caller -- a crash mid-receive is not a refusal. The advice scanner only
  // sees bare literals, so the expression form kept this reason invisible while operators were
  // already receiving generic advice for it: the guard was right and the gap was old. It is
  // per-candidate, not per-page -- the search continues, and when every candidate ends here the
  // page-level reason is no-geometry-matched, which has its own entry below.
  'fail': {
    cause: 'one candidate geometry could not read this page and gave no more specific reason (or threw while trying), so the bootstrap search moved on to the next candidate',
    do: 'nothing to act on for a single candidate -- that is the search reporting progress. Only if EVERY candidate ends here (reported as no-geometry-matched) is the page unreadable: then check the image is one whole uncropped page, in focus, and that the profile/dpi chosen when sending matches the printout',
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
 * 手机连拍界面用的中文一句话（英文的 cause/do 仍给 CLI 与报告用）。
 *
 * 为什么放在同一张表里：界面文案与 CLI 文案说的是同一件物理事实，分成两处就会各自漂移 ——
 * 本仓已经吃过一次亏（D66：core 早就算出「缺的是口令」，三个 UI 各说各话）。这里只覆盖
 * **手机连拍那条路真的会遇到的 reason**，其余仍走英文。
 */
const ZH = {
  'no-contrast': '照片没有墨/纸对比度（过曝、反光，或离得太远把格子拍糊了）：降曝光、关闪光、避开反光，再靠近一点重拍 —— 重新取景没用。',
  'echo-no-contrast': '页顶那条回显条（页上最细的特征）糊了：靠近一点、让页顶边进画面并对上焦；还是不行就改用更粗的档（板材 PL-G）或换成扫描仪 300 dpi。',
  'no-square-candidates': '一个方形角标都认不出来：多半是失焦/太糊，或者打印的特征比相机能分辨的更小。靠近、2× 变焦、擦镜头；板材档请换更粗的喷嘴档。',
  'no-marker-size-cluster': '找到了方块但不是四个同样大的：页面有一部分在画面外，或者透视太强。把整页（含四角）框进画面，相机尽量与纸面平行。',
  'no-hollow-corner': '四个角标都找到了，但没有一个是空心的（朝向标）：朝向标被磨花、过曝，或拍的是板材的反面。用正面重拍，别让空心角反光。',
  'no-rectangular-quad': '角标候选凑不出一个像样的矩形：可能有手指/页边遮挡。清掉遮挡、把纸放平再拍。',
  'fourth-corner-out-of-frame': '只找到三个角标，第四个按矩形推算落在画面外：退一点、把整页框进去再拍 —— 这是取景问题，不是对焦或清洁问题。',
  'blank-image': '这张图基本是均匀的：可能是拍到了空白、镜头被挡，或者文件不是页图。确认拍的是页，并把整页框进画面。',
  'too-few-candidates': '留下的角标候选不足四个：大概率有一个角标被反光或手指挡住了。把页放平、去掉反光再拍。',
  'mirrored-image': '唯一自洽的读法是镜像：页放反了，或扫的是背面。翻到正面重拍 —— 这不是对焦问题。',
  'echo-bad-magic': '回显条读出来的字节魔数不对：条带受损，或者这一页不是本工具的码。先确认印的是 PSKT 页，再重拍一次页顶那条。',
  'echo-header-crc': '回显条 CRC 没过：通常是页顶留边上有污渍或反光。把页顶那条完整拍进画面、对焦好再拍。',
  'echo-short-header': '回显条可读的格子太少，凑不齐一个头：这是页上最细的特征，需要最多分辨率 —— 靠近一点。',
  'no-geometry-matched': '所有候选几何都读不出这一页：确认拍的是完整未裁切的一页、对上焦，并核对打印时用的剖面/dpi。',
  'intra-fail': '这一页自己的纠错预算用完了（页内太多格子读不出：污渍、折痕或局部失焦）。只重拍这一页就行 —— 其它页可用，校验页也能把它补回来，不用重印。',
  'digest-mismatch': '还原出的字节与声明的摘要不符 ⇒ 按硬约束**一个字节都不写**。请补拍缺的页或重拍读不出的页；如果你填了口令，确认它是对的。',
};

/**
 * @param {{stage?:string, reason?:string}} failure
 * @returns {{cause:string, do:string, known:boolean, hint?:string, zh?:string}}
 */
export function advise(failure) {
  const key = failure.reason || 'unknown';
  const hit = ADVICE[key];
  if (hit) return { ...hit, known: true, ...(ZH[key] ? { zh: ZH[key] } : {}) };
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

/** The reasons with a Chinese one-liner for the phone UI (see ZH). */
export function localizedReasons() {
  return Object.keys(ZH).sort();
}
