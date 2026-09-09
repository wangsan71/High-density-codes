/**
 * Physical representation for binary paper modules.
 *
 * Unlike the ring-and-dot glyph alphabet, a module is either blank (0) or a
 * solid square (1). The outer rows and columns are timing/registration modules:
 * they carry an alternating pattern, are rendered the same way on every page,
 * and are excluded from the data decision as known erasures.
 */

/** Fixed timing value for a module, or null when it carries payload data. */
export function moduleTimingLevel(c, r) {
  if (r === 0) return c & 1;
  if (c === 0) return (r + 1) & 1;
  return null;
}

/** True when the renderer and reader must use the fixed pattern instead of payload bits. */
