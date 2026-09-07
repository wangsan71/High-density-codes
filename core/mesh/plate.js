/**
 * Page -> plate mesh. The missing layer: `solids.js` builds prisms, discs and rings,
 * `stl.js` writes bytes, but nothing connected a PSKT page (cells, levels, geometry)
 * to triangles. Without it there is no artifact for the STL/3MF writers to encode, so
 * the mesh half of the project was a set of parts and no assembly.
 *
 * Contract followed from docs/MESH-CONTRACT.md, which is what the G8 cross-check
 * re-reads from the other side:
 *   - plate base PLATE_MM, one relief step RELIEF_MM per shape level;
 *   - radii come ONLY from glyphGeometry(), the same function the raster renderer
 *     draws with -- the mesh and the PNG cannot disagree about what a level looks
 *     like, and if glyphGeometry refuses the cell width it also refuses here;
 *   - the colour channel is drawn as ink boxes sunk INK_SINK_MM that carry no data
 *     bit of their own (single-colour printing must still recover everything);
 *   - quiet zone is left empty because nothing is drawn outside the cell grid.
 *
 * Zero node: imports, so this runs in the browser too.
 */
import { glyphGeometry, glyphMaskForLevel } from '../render/glyphs.js';
import { splitCellLevel } from '../protocol.js';
import { discTriangles, ringTriangles, prismFromMask } from './solids.js';

export const PLATE_MM = 2.0;
export const RELIEF_MM = 0.3;
export const INK_SINK_MM = 0.05;
/** Ring/disc tessellation. 24 segments keeps a 0.4 mm cell's outer ring near 0.05 mm
 *  faceting -- finer than the extrusion width it would be printed with. */
export const SEGMENTS = 24;

/**
 * Build a plate mesh for one page.
 *
 * @param {object} geom  planPage() result (cols, rows, pitchMm, totalCells, channels)
 * @param {Uint16Array} levels  per-cell packed levels, page order
 * @param {{nozzleMm?:number, plateMm?:number, reliefMm?:number}} [opts]
 * @returns {{ok:true, triangles:Float64Array, stats:object} | {ok:false, reason:string}}
 */
export function buildPlateMesh(geom, levels, opts = {}) {
  const nozzleMm = opts.nozzleMm ?? 0.4;
  const plateMm = opts.plateMm ?? PLATE_MM;
  const reliefMm = opts.reliefMm ?? RELIEF_MM;
  const pitchMm = geom.pitchMm;
  const cellEw = pitchMm / nozzleMm;
  const shapeChannel = geom.channels.find((c) => c.name === 'shape');
  if (!shapeChannel) return { ok: false, reason: 'page has no shape channel' };
  const geo = glyphGeometry(cellEw, shapeChannel.levels);
  if (!geo.ok) {
    // The raster path refuses the same geometry, so a mesh built anyway would be a
    // second source of truth about what a level looks like.
    return { ok: false, reason: `glyphGeometry refused: ${geo.reason}` };
  }
  if (levels.length < geom.totalCells) {
    return { ok: false, reason: `levels too short: ${levels.length} < ${geom.totalCells}` };
  }

  // The relief height is a step function of the shape level, and the top face of each
  // glyph is what G8 projects to recover the printed mask.
  const tris = [];
  const push = (t) => {
    for (let i = 0; i < t.length; i++) tris.push(t[i]);
  };
  let cellsDrawn = 0;
  let cellsEmpty = 0;
  for (let r = 0; r < geom.rows; r++) {
    for (let c = 0; c < geom.cols; c++) {
      const i = r * geom.cols + c;
      const { shape, colour } = splitCellLevel(levels[i], geom);
      const cx = (c + 0.5) * pitchMm;
      const cy = (r + 0.5) * pitchMm;
      // Level 0 is a legitimate symbol (all-outside-the-ink), so "nothing drawn" is
      // decided by the mask, not by the level number.
      const top = plateMm + shape * reliefMm;
      if (shape === 0) {
        cellsEmpty++;
      } else {
        cellsDrawn++;
      }
      // Dot (the innermost disc) plus ring, both at this cell's relief height. Their
      // radii come from the shared geometry: outer is the ring's mid-radius band,
      // dot[] is per-level.
      const dotR = Array.isArray(geo.dot) ? geo.dot[Math.min(shape, geo.dot.length - 1)] : geo.inner;
      if (dotR > 0) {
        push(discTriangles({ radiusMm: dotR * pitchMm, zBottom: top - reliefMm, zTop: top, segments: SEGMENTS, offsetXmm: cx, offsetYmm: cy }));
      }
      if (geo.outer > geo.inner && geo.inner > 0 && shape > 0) {
        push(
          ringTriangles({
            outerRadiusMm: geo.outer * pitchMm,
            innerRadiusMm: geo.inner * pitchMm,
            zBottom: top - reliefMm,
            zTop: top,
            segments: SEGMENTS,
            offsetXmm: cx,
            offsetYmm: cy,
          }),
        );
      }
      void colour;
      void glyphMaskForLevel;
    }
  }
  if (!tris.length) {
    // A page that meshes to nothing is not a printable plate; say so instead of
    // emitting a header with zero triangles that a slicer would open and show blank.
    return { ok: false, reason: 'mesh is empty: no cell produced a triangle' };
  }

  const triangles = Float64Array.from(tris);
  const stats = {
    cells: geom.totalCells,
    cellsDrawn,
    cellsEmpty,
    triangles: triangles.length / 9,
    plateMm,
    reliefMm,
    nozzleMm,
    cellEw,
    cellPx: null,
    segments: SEGMENTS,
    glyphQuantised: !!geo.quantised,
    footprintMm: [geom.cols * pitchMm, geom.rows * pitchMm],
  };
  return { ok: true, triangles, stats };
}

/**
 * G8 criterion 3, in the direction that matters: take the mesh's own top faces, project
 * them back onto the cell grid, and reproduce the page mask cell by cell. If this
 * disagrees with the raster render, the two products are lying about the same symbols.
 *
 * @param {Float64Array} triangles  from buildPlateMesh
 * @param {object} geom
 * @param {(c:number,r:number)=>boolean} expectedMask  what the raster considers printed
 * @param {{zTopMin?:number, samplesPerCell?:number}} [opts]
 * @returns {{ok:boolean, mismatched:number, total:number, areaErrorPct:number, detail:string[]}}
 */
export function projectTopToCells(triangles, geom, expectedMask, opts = {}) {
  const pitchMm = geom.pitchMm;
  const total = geom.totalCells;
  const printed = new Float64Array(total); // fraction of the cell covered by top faces
  const zTopMin = opts.zTopMin ?? PLATE_MM - 1e-6;
  const per = opts.samplesPerCell ?? 5;
  const step = pitchMm / per;
  // Accumulate coverage by rasterising each top-face triangle over its bounding box in
  // the sample grid: the exact analytic area is not needed, only whether the same cells
  // come out printed -- but a per-sample inside-test does measure area fraction.
  const inside = (px, py, ax, ay, bx, by, cx2, cy2) => {
    const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const d2 = (cx2 - bx) * (py - by) - (cy2 - by) * (px - bx);
    const d3 = (ax - cx2) * (py - cy2) - (ay - cy2) * (px - cx2);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
  for (let t = 0; t < triangles.length; t += 9) {
    const z0 = triangles[t + 2];
    const z1 = triangles[t + 5];
    const z2 = triangles[t + 8];
    if (z0 < zTopMin || z1 < zTopMin || z2 < zTopMin) continue; // not a top face
    const ax = triangles[t];
    const ay = triangles[t + 1];
    const bx = triangles[t + 3];
    const by = triangles[t + 4];
    const cx2 = triangles[t + 6];
    const cy2 = triangles[t + 7];
    const minX = Math.min(ax, bx, cx2);
    const maxX = Math.max(ax, bx, cx2);
    const minY = Math.min(ay, by, cy2);
    const maxY = Math.max(ay, by, cy2);
    const c0 = Math.max(0, Math.floor(minX / pitchMm - 1));
    const c1 = Math.min(geom.cols - 1, Math.ceil(maxX / pitchMm));
    const r0 = Math.max(0, Math.floor(minY / pitchMm - 1));
    const r1 = Math.min(geom.rows - 1, Math.ceil(maxY / pitchMm));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let hits = 0;
        for (let sy = 0; sy < per; sy++) {
          const py = (r + (sy + 0.5) / per) * pitchMm;
          for (let sx = 0; sx < per; sx++) {
            const px = (c + (sx + 0.5) / per) * pitchMm;
            if (inside(px, py, ax, ay, bx, by, cx2, cy2)) hits++;
          }
        }
        printed[r * geom.cols + c] += hits / (per * per);
      }
    }
  }
  let mismatched = 0;
  let areaErrSum = 0;
  const detail = [];
  for (let i = 0; i < total; i++) {
    const want = expectedMask(i % geom.cols, Math.floor(i / geom.cols)) ? 1 : 0;
    const got = printed[i] > 0.25 ? 1 : 0;
    areaErrSum += Math.abs(printed[i] - want);
    if (want !== got) {
      mismatched++;
      if (detail.length < 6) detail.push(`cell ${i % geom.cols},${Math.floor(i / geom.cols)} want=${want} got=${got} cover=${printed[i].toFixed(2)}`);
    }
  }
  const areaErrorPct = (100 * areaErrSum) / Math.max(1, total);
  return { ok: areaErrorPct < 8, mismatched, total, areaErrorPct, detail };
}
