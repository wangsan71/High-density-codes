#!/usr/bin/env python3
"""PSKT-1 independent reference decoder / conformance verifier.

    python ref/decode.py [--fixture tests/conformance.json] [--verbose] [--strict-gaps]

WHAT THIS IS
------------
A second, independent implementation of the PSKT-1 *readout*, written from the
rules published in ``tests/conformance.json``'s ``meta`` block (plus docs/PLAN.md
section 9) and nothing else.  It re-derives every answer in that file and exits
non-zero if the two implementations ever disagree.

INDEPENDENCE RULE (for whoever maintains this next)
---------------------------------------------------
This file must never be patched by reading ``core/*.js``.  If a check here fails,
either the JS is wrong or the *documented rules in `meta`* are not the rules the
JS actually uses -- both are findings, and both are fixed by repairing `meta`
and re-emitting the fixture (``node tools/emit-conformance.mjs``).  Copying a bit
order out of the JS into this file makes the cross-check worthless.

Where a rule could not be read out of `meta`, this file does NOT guess silently:
it records a ``SPEC GAP`` (printed in the summary, and fatal under
``--strict-gaps``).  Gaps found in this revision are listed in ref/README.md.

Exit codes: 0 = every implemented vector passed; 1 = at least one mismatch (or a
gap under --strict-gaps); 2 = the fixture could not be read / is self-contradictory.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import math
import os
import re
import struct
import sys
import zlib

# --------------------------------------------------------------------------------------
# tiny helpers
# --------------------------------------------------------------------------------------


def unhex(s: str) -> bytes:
    return bytes.fromhex(s)


def hx(b: bytes) -> str:
    return b.hex()


def first_diff(expected: bytes, actual: bytes) -> int:
    """Index of the first differing byte; -1 when equal; len(common prefix) on length diff."""
    if expected == actual:
        return -1
    n = min(len(expected), len(actual))
    for i in range(n):
        if expected[i] != actual[i]:
            return i
    return n


def describe_bytes(expected: bytes, actual: bytes, show: int = 16) -> str:
    d = first_diff(expected, actual)
    if d < 0:
        return "identical"
    lo = max(0, d - 4)
    return (
        f"first differing offset {d} of {len(expected)}/{len(actual)} bytes: "
        f"expected {hx(expected[lo:lo + show])} got {hx(actual[lo:lo + show])}"
    )


class SpecGap(Exception):
    """The documented rules in `meta` do not determine the answer; refuse to guess."""


class Reject(Exception):
    """A decoder refusal, which is the *expected* outcome for some vectors."""


# --------------------------------------------------------------------------------------
# CRC (generic, driven by meta.crc's parameter table)
# --------------------------------------------------------------------------------------


def reflect_bits(value: int, width: int) -> int:
    out = 0
    for i in range(width):
        if (value >> i) & 1:
            out |= 1 << (width - 1 - i)
    return out


def crc_calc(data: bytes, width: int, poly: int, init: int, refin: bool, refout: bool, xorout: int) -> int:
    """Bit-serial CRC from the Rocksoft parameter model.

    Two conventions are implemented -- the two this protocol uses.  Anything else
    raises rather than silently producing a third opinion.
    """
    mask = (1 << width) - 1
    if not refin and not refout:
        # direct / MSB-first, polynomial in normal form
        crc = init & mask
        top = 1 << (width - 1)
        for byte in data:
            crc ^= (byte << (width - 8)) & mask
            for _ in range(8):
                crc = ((crc << 1) ^ poly) & mask if (crc & top) else (crc << 1) & mask
        return (crc ^ xorout) & mask
    if refin and refout:
        # reversed / LSB-first, polynomial reversed
        rpoly = reflect_bits(poly, width)
        crc = reflect_bits(init, width) & mask
        for byte in data:
            crc ^= byte
            for _ in range(8):
                crc = (crc >> 1) ^ rpoly if (crc & 1) else (crc >> 1)
        out = reflect_bits(crc, width) & mask
        return (out ^ xorout) & mask
    raise SpecGap(f"crc: refin={refin}/refout={refout} mix is not implemented by this reference")


# --------------------------------------------------------------------------------------
# SHA-256 (FIPS 180-4, from the spec, not from hashlib -- hashlib is only a witness)
# --------------------------------------------------------------------------------------

_SHA_K = (
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x723B19F4, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C197E3, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
)


def _rotr(x: int, n: int) -> int:
    return ((x >> n) | (x << (32 - n))) & 0xFFFFFFFF


def sha256_bytes(data: bytes) -> bytes:
    h0 = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19]
    ml = (len(data) * 8) & 0xFFFFFFFFFFFFFFFF
    pad = bytearray(data)
    pad.append(0x80)
    while len(pad) % 64 != 56:
        pad.append(0x00)
    pad += struct.pack(">Q", ml)
    H = list(h0)
    for off in range(0, len(pad), 64):
        w = list(struct.unpack(">16I", bytes(pad[off:off + 64])))
        for i in range(16, 64):
            x, y = w[i - 15], w[i - 2]
            s0 = _rotr(x, 7) ^ _rotr(x, 18) ^ (x >> 3)
            s1 = _rotr(y, 17) ^ _rotr(y, 19) ^ (y >> 10)
            w.append((w[i - 16] + s0 + w[i - 7] + s1) & 0xFFFFFFFF)
        a, b, c, d, e, f, g, hh = H
        for i in range(64):
            S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25)
            ch = (e & f) ^ ((e ^ 0xFFFFFFFF) & g)
            t1 = (hh + S1 + ch + _SHA_K[i] + w[i]) & 0xFFFFFFFF
            S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22)
            maj = (a & b) ^ (a & c) ^ (b & c)
            t2 = (S0 + maj) & 0xFFFFFFFF
            hh, g, f, e, d, c, b, a = g, f, e, (d + t1) & 0xFFFFFFFF, d, c, b, (a + t1 + t2) & 0xFFFFFFFF
        for i, v in enumerate((a, b, c, d, e, f, g, hh)):
            H[i] = (H[i] + v) & 0xFFFFFFFF
    return struct.pack(">8I", *H)


# --------------------------------------------------------------------------------------
# ChaCha20 (RFC 8439)
# --------------------------------------------------------------------------------------

_CHACHA_CONST = (0x61707865, 0x3320646E, 0x79622D32, 0x6B206574)


def _rotl32(x: int, n: int) -> int:
    return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF


def _chacha_block(key: bytes, counter: int, nonce: tuple) -> bytes:
    state = list(_CHACHA_CONST) + list(struct.unpack("<8I", key)) + [counter & 0xFFFFFFFF] + list(nonce)
    x = list(state)
    for _ in range(10):
        for a, b, c, d in ((0, 4, 8, 12), (1, 5, 9, 13), (2, 6, 10, 14), (3, 7, 11, 15),
                           (0, 5, 10, 15), (1, 6, 11, 12), (2, 7, 8, 13), (3, 4, 9, 14)):
            x[a] = (x[a] + x[b]) & 0xFFFFFFFF
            x[d] = _rotl32(x[d] ^ x[a], 16)
            x[c] = (x[c] + x[d]) & 0xFFFFFFFF
            x[b] = _rotl32(x[b] ^ x[c], 12)
            x[a] = (x[a] + x[b]) & 0xFFFFFFFF
            x[d] = _rotl32(x[d] ^ x[a], 8)
            x[c] = (x[c] + x[d]) & 0xFFFFFFFF
            x[b] = _rotl32(x[b] ^ x[c], 7)
    return struct.pack("<16I", *[((x[i] + state[i]) & 0xFFFFFFFF) for i in range(16)])


IntWords = tuple


def chacha20(key: bytes, nonce: bytes, counter: int, data: bytes) -> bytes:
    assert len(key) == 32 and len(nonce) == 12, "RFC 8439 sizes"
    nw = struct.unpack("<3I", nonce)
    out = bytearray(len(data))
    for blk in range((len(data) + 63) // 64):
        ks = _chacha_block(key, counter + blk, nw)
        base = blk * 64
        for i in range(min(64, len(data) - base)):
            out[base + i] = data[base + i] ^ ks[i]
    return bytes(out)


# --------------------------------------------------------------------------------------
# GF(2^8) and Reed-Solomon
# --------------------------------------------------------------------------------------


class GF:
    def __init__(self, prim_poly: int, alpha: int):
        self.poly = prim_poly
        self.alpha = alpha
        self.exp = [0] * 512
        self.log = [0] * 256
        x = 1
        for i in range(255):
            self.exp[i] = x
            self.log[x] = i
            x = self._carryless_mul(x, alpha)
        if x != 1:
            raise SpecGap(f"gf256: generator {alpha} is not primitive under polynomial {prim_poly}")
        for i in range(255, 512):
            self.exp[i] = self.exp[i - 255]

    def _carryless_mul(self, a: int, b: int) -> int:
        r = 0
        for i in range(8):
            if (b >> i) & 1:
                r ^= a
            a <<= 1
            if a & 0x100:
                a ^= self.poly
        return r & 0xFF

    def mul(self, a: int, b: int) -> int:
        if a == 0 or b == 0:
            return 0
        return self.exp[self.log[a] + self.log[b]]

    def div(self, a: int, b: int) -> int:
        if b == 0:
            raise ZeroDivisionError("divide by zero in GF(2^8)")
        if a == 0:
            return 0
        return self.exp[(self.log[a] - self.log[b]) % 255]

    def inv(self, a: int) -> int:
        if a == 0:
            raise ZeroDivisionError("no inverse for 0")
        return self.exp[255 - self.log[a]]

    def powx(self, a: int, e: int) -> int:
        if a == 0:
            return 0
        return self.exp[(self.log[a] * e) % 255]


def polymul_asc(gf: GF, a, b) -> list:
    out = [0] * (len(a) + len(b) - 1)
    for i, ca in enumerate(a):
        if ca:
            for j, cb in enumerate(b):
                if cb:
                    out[i + j] ^= gf.mul(ca, cb)
    return out


def rs_generator(gf: GF, nsym: int, fcr: int = 0) -> list:
    """g(x) = prod (x + alpha^(fcr+i)); coefficients in descending power order, monic."""
    g = [1]
    for i in range(nsym):
        root = gf.exp[(fcr + i) % 255]
        ng = [0] * (len(g) + 1)
        for j, c in enumerate(g):
            ng[j] ^= c
            ng[j + 1] ^= gf.mul(c, root)
        g = ng
    return g


def rs_encode(gf: GF, data: bytes, nsym: int, fcr: int = 0) -> bytes:
    """Systematic: parity = (data * x^nsym) mod g(x)."""
    g = rs_generator(gf, nsym, fcr)
    msg = list(data) + [0] * nsym
    for i in range(len(data)):
        coef = msg[i]
        if coef:
            for j in range(1, len(g)):
                if g[j]:
                    msg[i + j] ^= gf.mul(g[j], coef)
    return bytes(msg[len(data):])


def rs_syndromes(gf: GF, cw, nsym: int, fcr: int = 0) -> list:
    """S_i = C(alpha^(fcr+i)) where C(x) = sum_j cw[j] x^(n-1-j), i.e. X_j = alpha^(n-1-j)."""
    out = []
    for i in range(nsym):
        root = gf.exp[(fcr + i) % 255]
        acc = 0
        for v in cw:
            acc = gf.mul(acc, root) ^ v
        out.append(acc)
    return out


def gf_solve(gf: GF, A, b):
    """Square linear solve over GF(2^8); None when the matrix is singular."""
    n = len(b)
    if any(len(r) != n for r in A):
        return None
    M = [list(A[i]) + [b[i]] for i in range(n)]
    for col in range(n):
        piv = None
        for r in range(col, n):
            if M[r][col]:
                piv = r
                break
        if piv is None:
            return None
        M[col], M[piv] = M[piv], M[col]
        inv = gf.inv(M[col][col])
        for j in range(col, n + 1):
            M[col][j] = gf.mul(M[col][j], inv)
        for r in range(n):
            if r != col and M[r][col]:
                f = M[r][col]
                for j in range(col, n + 1):
                    M[r][j] ^= gf.mul(f, M[col][j])
    return [M[i][n] for i in range(n)]


def rs_decode(gf: GF, cw: bytes, nsym: int, erasures=(), fcr: int = 0):
    """Return (ok, corrected_codeword, reason).

    Pettersson-style: erasure locator -> modified syndromes -> PGZ linear solve ->
    Chien search -> Vandermonde solve for the symbol values, and finally *re-verify*
    that every syndrome is zero.  A decoder that cannot prove its own answer is not
    allowed to hand back bytes, so every path that is not fully verified is a refusal.
    """
    n = len(cw)
    if n > 255:
        return False, None, f"codeword of {n} symbols exceeds the GF(2^8) limit of 255"
    if nsym <= 0 or nsym >= n:
        return False, None, f"nsym={nsym} is not a valid parity size for n={n}"
    epos = sorted(set(erasures))
    if any((j < 0 or j >= n) for j in epos):
        return False, None, "erasure position out of range"
    E = len(epos)
    eset = set(epos)
    if E > nsym:
        return False, None, f"{E} erasures exceed nsym={nsym} (rule 2*t+e<=nsym)"

    rec = bytearray(cw)
    for j in epos:
        rec[j] = 0
    S = rs_syndromes(gf, rec, nsym, fcr)
    if E == 0 and not any(S):
        return True, bytes(cw), None

    le = [1]
    for j in epos:
        le = polymul_asc(gf, le, [1, gf.exp[(n - 1 - j) % 255]])
    mlen = nsym - E
    M = []
    for k in range(mlen):
        acc = 0
        for i in range(E + 1):
            acc ^= gf.mul(le[i], S[k + i])
        M.append(acc)

    nu_max = (nsym - E) // 2
    for nu in range(nu_max, -1, -1):
        if 2 * nu + E > nsym:
            continue
        lam = []
        if nu:
            A = [[M[k + i] for i in range(1, nu + 1)] for k in range(nu)]
            sol = gf_solve(gf, A, [M[k] for k in range(nu)])
            if sol is None:
                continue
            lam = sol
        ok_res = True
        for k in range(nu, mlen - nu):
            acc = M[k]
            for i in range(1, nu + 1):
                acc ^= gf.mul(lam[i - 1], M[k + i])
            if acc:
                ok_res = False
                break
        if not ok_res:
            continue
        lfull = [1] + lam
        roots = []
        for j in range(n):
            if j in eset:
                continue
            xj_inv = gf.exp[(255 - ((n - 1 - j) % 255)) % 255]
            v = 0
            for c in reversed(lfull):
                v = gf.mul(v, xj_inv) ^ c
            if v == 0:
                roots.append(j)
        if len(roots) != nu:
            continue
        pos = epos + roots
        s = len(pos)
        if s > nsym:
            continue
        xs = [gf.exp[(n - 1 - j) % 255] for j in pos]
        A = [[gf.powx(xs[m], k) for m in range(s)] for k in range(s)]
        Z = gf_solve(gf, A, [S[k] for k in range(s)])
        if Z is None:
            continue
        out = bytearray(rec)
        for m, j in enumerate(pos):
            out[j] ^= Z[m]
        if any(rs_syndromes(gf, out, nsym, fcr)):
            continue
        changed = sum(1 for i in range(n) if out[i] != cw[i])
        if changed > nu + E:
            continue
        return True, bytes(out), None
    return False, None, f"no codeword within 2*t+e<=nsym={nsym} (e={E}, t<={nu_max})"


# --------------------------------------------------------------------------------------
# interleave permutation
# --------------------------------------------------------------------------------------


def is_prime(x: int) -> bool:
    if x < 2:
        return False
    if x % 2 == 0:
        return x == 2
    f = 3
    while f * f <= x:
        if x % f == 0:
            return False
        f += 2
    return True


def default_step(n: int) -> int:
    """meta.cellPacking.interleave: smallest prime >= n>>1 that is coprime with n,
    else the smallest coprime, else 1.  (The prime scan is bounded by n -- see the
    SPEC GAP note about that bound in ref/README.md.)"""
    if n <= 1:
        return 1
    for p in range(n >> 1, n):
        if is_prime(p) and math.gcd(p, n) == 1:
            return p
    for p in range(1, n):
        if math.gcd(p, n) == 1:
            return p
    return 1


def perm_tables(n: int, step: int):
    fwd = [(i * step) % n for i in range(n)]
    inv = [0] * n
    for i, f in enumerate(fwd):
        inv[f] = i
    return fwd, inv


def interleave(raw, n: int, step: int):
    fwd, _ = perm_tables(n, step)
    return [raw[fwd[i]] for i in range(n)]


def deinterleave(printed, n: int, step: int):
    _, inv = perm_tables(n, step)
    return [printed[inv[i]] for i in range(n)]


def interleave_checksum(fwd) -> int:
    total = 0
    for v in fwd:
        total = (total + v * 31) & 0xFFFFFFFF
    return total


# --------------------------------------------------------------------------------------
# cell packing
# --------------------------------------------------------------------------------------


def unpack_flat(cells, bits_per_cell: int, nbytes: int) -> bytes:
    """meta.cellPacking.rule, single stream: the byte stream's bits are taken
    MSB-first and grouped into cells of bitsPerCell bits (primary channel first)."""
    out = bytearray(nbytes)
    acc = 0
    nb = 0
    o = 0
    for v in cells:
        if v < 0 or v >= (1 << bits_per_cell):
            raise SpecGap(f"cell value {v} does not fit {bits_per_cell} bits")
        acc = (acc << bits_per_cell) | v
        nb += bits_per_cell
        while nb >= 8:
            nb -= 8
            if o < nbytes:
                out[o] = (acc >> nb) & 0xFF
                o += 1
                if o >= nbytes:
                    return bytes(out)
    return bytes(out)


def unpack_channels(cells, bits_per_cell: int, channels, stream_lens) -> bytes:
    """One independent bit-stream per channel: channel c (bits_c wide, occupying the
    bits_c most-significant-free positions of the cell, primary first) carries the
    c-th stream of `stream_lens` bytes, MSB-first.  Streams start at cell 0."""
    slices = []
    for c, ln in zip(channels, stream_lens):
        b = c["bits"]
        want = ln * 8
        have = len(cells) * b
        if want > have:
            raise SpecGap(f"channel {c['name']}: {want} bits needed but only {have} cell bits exist")
        acc = 0
        nb = 0
        out = bytearray(ln)
        o = 0
        shift = bits_per_cell - b
        for v in cells:
            acc = (acc << b) | ((v >> shift) & ((1 << b) - 1))
            nb += b
            while nb >= 8:
                nb -= 8
                out[o] = (acc >> nb) & 0xFF
                o += 1
                if o >= ln:
                    break
            if o >= ln:
                break
        slices.append(bytes(out))
    return b"".join(slices)


def pack_channels_to_cells(codeword: bytes, bits_per_cell: int, channels, stream_lens, ncells: int):
    """Inverse of unpack_channels / unpack_flat, used to re-render a page's cells."""
    cells = [0] * ncells
    if len(channels) == 1 and stream_lens == [len(codeword)]:
        bits = []
        for byte in codeword:
            bits += [(byte >> (7 - i)) & 1 for i in range(8)]
        it = iter(bits)
        for i in range(ncells):
            v = 0
            for _ in range(bits_per_cell):
                v = (v << 1) | next(it, 0)
            cells[i] = v
        return cells
    off = 0
    pos = bits_per_cell
    for c, ln in zip(channels, stream_lens):
        pos -= c["bits"]
        bits = []
        for byte in codeword[off:off + ln]:
            bits += [(byte >> (7 - i)) & 1 for i in range(8)]
        it = iter(bits)
        for i in range(ncells):
            v = 0
            for _ in range(c["bits"]):
                v = (v << 1) | next(it, 0)
            cells[i] |= v << pos
            if all(1 for _ in [0]) and False:
                pass
        # stop writing once the stream is exhausted (the remaining cells keep 0)
        off += ln
    return cells


def pack_flat_to_cells(codeword: bytes, bits_per_cell: int, ncells: int):
    cells = [0] * ncells
    bits = []
    for byte in codeword:
        bits += [(byte >> (7 - i)) & 1 for i in range(8)]
    it = iter(bits)
    for i in range(ncells):
        v = 0
        for _ in range(bits_per_cell):
            v = (v << 1) | next(it, 0)
        cells[i] = v
    return cells


# --------------------------------------------------------------------------------------
# PSZ1 compression container
# --------------------------------------------------------------------------------------

PSZ_MAGIC = b"PSZ1"


def container_split(blob: bytes, report: "Report", vecid: str, expected_method=None, expected_rawlen=None):
    """Split a PSZ1 container into (method, rawLength, body).

    meta.compression.container says: 4-byte magic, u8 method, u32be original length,
    then the payload -- i.e. a 9-byte header.  The containers in the fixture have a
    10-byte header: the u32 original length is little-endian at offset 6 and offset 5
    is an undocumented 0x00.  That is a documented-vs-emitted contradiction, recorded
    as a SPEC GAP; we read the layout that the emitted bytes actually use.
    """
    if blob[:4] != PSZ_MAGIC:
        raise Reject(f"bad container magic {blob[:4]!r}")
    method = blob[4]
    doc_len_be = int.from_bytes(blob[5:9], "big")
    obs_len_le = int.from_bytes(blob[6:10], "little")
    if doc_len_be == (expected_rawlen if expected_rawlen is not None else doc_len_be) and len(blob) >= 9:
        header = 9
        rawlen = doc_len_be
    else:
        report.gap(
            vecid,
            "meta.compression.container documents '4-byte magic, u8 method, u32be original length, then the "
            "payload' (9-byte header), but every container in this fixture has a 10-byte header whose length "
            "field is u32 **little**-endian at offset 6, with an undocumented always-zero byte at offset 5",
        )
        header = 10
        rawlen = obs_len_le
    if expected_rawlen is not None and rawlen != expected_rawlen:
        raise Reject(f"container length field says {rawlen}, vector says rawLength {expected_rawlen}")
    if expected_method is not None and method != expected_method:
        raise Reject(f"container method {method}, vector says {expected_method}")
    if header + rawlen > len(blob) and method == 0 and rawlen != len(blob) - header:
        raise Reject(f"container body shorter than its declared length")
    return method, rawlen, blob[header:]


def container_decode(blob: bytes, report: "Report", vecid: str) -> bytes:
    method, rawlen, body = container_split(blob, report, vecid)
    if method == 0:
        # "0 stored": the body is the original bytes, NOT a deflate stream.
        if len(body) != rawlen:
            raise Reject(f"stored container: body {len(body)} bytes != declared {rawlen}")
        return body
    if method == 1:
        d = zlib.decompressobj(-15)
        out = d.decompress(body) + d.flush()
        if d.unused_data:
            raise Reject(f"deflate container has {len(d.unused_data)} trailing bytes")
        if len(out) != rawlen:
            raise Reject(f"deflate container inflated to {len(out)}, declared {rawlen}")
        return out
    raise Reject(f"unknown compression method {method}")


# --------------------------------------------------------------------------------------
# header
# --------------------------------------------------------------------------------------

_NO_FIELD = object()


def classify_layout_row(off: int, ln: int, meaning: str):
    m = meaning.lower()
    table = [
        ("magic", "magic"),
        ("truncated sha-256", "digest"),
        ("crc-16", "crc"),
        ("session id", "sessionId"),
        ("nozzle", "nozzle"),
        ("profile code", "profile"),
        ("data bytes per page", "dataBytesPerPage"),
        ("total pages", "totalPages"),
        ("data pages", "dataPages"),
        ("page index", "pageIndex"),
        ("payload length", "payloadLen"),
        ("intra-page k", "intraK"),
        ("intra-page nsym", "intraNsym"),
        ("block pad", "blockPad"),
        ("version", "version"),
        ("flags", "flags"),
        ("kind", "kind"),
    ]
    name = None
    for needle, cand in table:
        if needle in m:
            name = cand
            break
    if name is None:
        raise SpecGap(f"headerLayout row ({off},{ln},'{meaning}') is not understood by this reference decoder")
    ann = re.search(r"\(u(8|16|32)be", m)
    width = int(ann.group(1)) if ann else None
    if width is not None and width // 8 != ln and not (name == "magic"):
        raise SpecGap(f"headerLayout row ({off},{ln},'{meaning}'): annotated width {width} contradicts length {ln}")
    if name == "magic":
        typ = ("bytes",)
    elif name in ("sessionId", "digest"):
        typ = ("bytes",)
    elif name == "profile":
        typ = ("profile",)
    elif name == "nozzle":
        typ = ("nozzle",)
    elif name == "crc":
        typ = ("crc",)
    else:
        typ = ("uint",)
    return name, typ[0]


class Header:
    def __init__(self, meta, report):
        self.meta = meta
        self.report = report
        self.length = meta["headerLength"]
        rows = []
        cursor = 0
        for off, ln, meaning in meta["headerLayout"]:
            if off != cursor:
                raise SpecGap(f"headerLayout is not contiguous at offset {cursor} (row says {off})")
            name, typ = classify_layout_row(off, ln, meaning)
            rows.append((name, off, ln, typ, meaning))
            cursor += ln
        if cursor != self.length:
            raise SpecGap(f"headerLayout covers {cursor} bytes but meta.headerLength is {self.length}")
        self.rows = rows
        self.crc_row = next(r for r in rows if r[0] == "crc")
        stated = meta.get("headerCrc")
        if stated:
            # Preferred: the fixture states the span as data. The prose form once
            # said "over bytes 0..53" and a reader could take it either as closed
            # or half-open, which is not a spec.
            self.crc_lo, self.crc_hi = stated["covers"][0], stated["covers"][1]
            fld = stated["field"]
            if fld[0] != self.crc_row[1] or fld != [self.crc_row[1], self.crc_row[1] + self.crc_row[2]]:
                raise SpecGap(f"meta.headerCrc.field {fld} contradicts the CRC row at {self.crc_row[1]} ({self.crc_row[2]} bytes)")
        else:
            span = re.search(r"over bytes (\d+)\.\.(\d+)", self.crc_row[4])
            if not span:
                raise SpecGap(f"headerLayout CRC row does not state its covered range: '{self.crc_row[4]}'")
            self.crc_lo, self.crc_hi = int(span.group(1)), int(span.group(2)) + 1
        if self.crc_hi + 2 != self.length or self.crc_lo != 0:
            raise SpecGap(f"CRC covers 0..{self.crc_hi} which does not line up with a {self.length}-byte header")
        self.profile_by_code = {v: k for k, v in meta["profileCodes"].items()}
        self.digest_len = meta["digestLength"]

    def crc_params(self):
        p = self.meta["crc"]["crc16"]
        return p

    def decode(self, blob: bytes, check_crc: bool = True) -> dict:
        if len(blob) != self.length:
            raise Reject(f"header is {len(blob)} bytes, expected {self.length}")
        p = self.crc_params()
        got = crc_calc(blob[self.crc_lo:self.crc_hi], 16, p["poly"], p["init"], p["refin"], p["refout"], p["xorout"])
        want = int.from_bytes(blob[self.crc_row[1]:self.crc_row[1] + 2], "big")
        if check_crc and got != want:
            raise Reject(f"header-crc: CRC-16/{p['name']} over bytes {self.crc_lo}..{self.crc_hi - 1} is {got:04x}, header says {want:04x}")
        out = {}
        for name, off, ln, typ, meaning in self.rows:
            raw = blob[off:off + ln]
            if typ == "uint":
                out[name] = int.from_bytes(raw, "big")
            elif typ == "bytes":
                out[name] = hx(raw)
            elif typ == "profile":
                code = raw[0]
                if code not in self.profile_by_code:
                    raise Reject(f"unknown profile code {code}")
                out[name] = self.profile_by_code[code]
            elif typ == "nozzle":
                out[name] = f"{raw[0] / 10:.10g}"
            elif typ == "crc":
                out[name] = int.from_bytes(raw, "big")
        magic_hex = re.search(r"0x([0-9a-fA-F]{2,8})", next(r[4] for r in self.rows if r[0] == "magic"))
        if magic_hex and int(magic_hex.group(1), 16) != int.from_bytes(blob[:4], "big"):
            raise Reject("header magic does not match the value documented in headerLayout")
        if len(unhex(out["digest"])) != self.digest_len:
            raise Reject(f"digest field is {len(out['digest'])} bytes, meta.digestLength says {self.digest_len}")
        return out

    def encode(self, fields: dict) -> bytes:
        blob = bytearray(self.length)
        for name, off, ln, typ, meaning in self.rows:
            if typ == "uint":
                v = int(fields[name])
                blob[off:off + ln] = v.to_bytes(ln, "big")
            elif typ == "bytes":
                raw = unhex(fields[name])
                if len(raw) != ln:
                    raise Reject(f"field {name}: {len(raw)} bytes given, layout says {ln}")
                blob[off:off + ln] = raw
            elif typ == "profile":
                blob[off] = self.meta["profileCodes"][fields[name]]
            elif typ == "nozzle":
                blob[off] = int(round(float(fields[name]) * 10))
            elif typ == "crc":
                pass
        p = self.crc_params()
        crc = crc_calc(bytes(blob[self.crc_lo:self.crc_hi]), 16, p["poly"], p["init"], p["refin"], p["refout"], p["xorout"])
        blob[self.crc_row[1]:self.crc_row[1] + 2] = crc.to_bytes(2, "big")
        return bytes(blob)


# --------------------------------------------------------------------------------------
# intra-page + inter-page structure
# --------------------------------------------------------------------------------------


def intra_decode(gf: GF, codeword: bytes, k: int, nsym: int, blocks: int, report, vecid):
    """blocks RS(k+nsym, k) codewords, contents concatenated then parities concatenated."""
    need = blocks * (k + nsym)
    if len(codeword) != need:
        raise SpecGap(
            f"{vecid}: page codeword is {len(codeword)} bytes but intra{{k={k},nsym={nsym},blocks={blocks}}} "
            f"implies {need}; meta does not say how a page codeword's total length is derived"
        )
    content = bytearray()
    corrected_blocks = 0
    bad = []
    for b in range(blocks):
        cw = codeword[b * k:(b + 1) * k] + codeword[blocks * k + b * nsym:blocks * k + (b + 1) * nsym]
        S = rs_syndromes(gf, cw, nsym)
        if any(S):
            ok, fixed, why = rs_decode(gf, cw, nsym)
            if not ok:
                bad.append((b, why))
                continue
            corrected_blocks += 1
            cw = fixed
        content += cw[:k]
    if bad:
        return None, bad, corrected_blocks
    return bytes(content), None, corrected_blocks


def intra_verify_encode(gf: GF, codeword: bytes, k: int, nsym: int, blocks: int):
    """Re-encode every block and compare the parity region (proves the systematic layout)."""
    for b in range(blocks):
        data = codeword[b * k:(b + 1) * k]
        want = codeword[blocks * k + b * nsym:blocks * k + (b + 1) * nsym]
        got = rs_encode(gf, data, nsym)
        if got != want:
            return f"block {b}: recomputed parity {hx(got)} != page parity {hx(want)} ({describe_bytes(want, got)})"
    return None


# --------------------------------------------------------------------------------------
# the verifier
# --------------------------------------------------------------------------------------


class Report:
    def __init__(self, verbose: bool):
        self.verbose = verbose
        self.groups = {}
        self.order = []
        self.failures = []
        self.skips = []
        self.gaps = []
        self.notes = []
        self.aspects = 0

    def begin(self, group):
        if group not in self.groups:
            self.groups[group] = [0, 0]
            self.order.append(group)

    def check(self, group, vecid, aspect, *rest):
        """
        Two accepted forms, because a check that compares is the common case:

            check(group, vecid, aspect, ok[, detail])
            check(group, vecid, aspect, expected, actual[, detail])

        The second form used to be a silent bug at several call sites: passing
        `True` as `ok` and the real condition as `detail` records a pass no matter
        what the decoder did. A boolean plus a non-string second argument is
        therefore read as a comparison, and a bare non-boolean `ok` is not trusted.
        """
        self.begin(group)
        g = self.groups[group]
        detail = ""
        if len(rest) >= 2 and not isinstance(rest[1], str):
            expected, actual = rest[0], rest[1]
            ok = expected == actual
            if len(rest) > 2:
                detail = str(rest[2])
            elif not ok:
                detail = f"expected {expected!r}, got {actual!r}"
        else:
            ok = bool(rest[0]) if rest else False
            if len(rest) > 1:
                detail = str(rest[1])
            if rest and not isinstance(rest[0], bool):
                # A truthy non-boolean (an int count, say) is almost always a
                # call site that meant to compare. Refuse to pretend it passed.
                detail = (detail + " " if detail else "") + f"[uncompared value {rest[0]!r} -- call site should use eq()]"
                ok = False
        g[1] += 1
        self.aspects += 1
        if ok:
            g[0] += 1
        else:
            self.failures.append(f"FAIL {vecid}: {aspect} -- {detail}")
        if self.verbose:
            print(f"  {'ok  ' if ok else 'FAIL'} {group:13s} {vecid:34s} {aspect}" + ("" if ok else f" -- {detail}"))

    def eq(self, group, vecid, aspect, expected, actual):
        if isinstance(expected, (bytes, bytearray)) and isinstance(actual, (bytes, bytearray)):
            ok = bytes(expected) == bytes(actual)
            detail = describe_bytes(bytes(expected), bytes(actual)) if not ok else ""
        else:
            ok = expected == actual
            detail = f"expected {expected!r}, got {actual!r}" if not ok else ""
        self.check(group, vecid, aspect, ok, detail)
        return ok

    def skip(self, vecid, group, reason):
        self.skips.append((vecid, group, reason))

    def gap(self, vecid, what):
        key = (vecid, what)
        if key not in [(g[0], g[1]) for g in self.gaps]:
            self.gaps.append(key)

    def note(self, text):
        if text not in self.notes:
            self.notes.append(text)


class Pskt:
    def __init__(self, meta):
        self.meta = meta
        g = meta["gf256"]
        self.gf = GF(g["primitivePolynomial"], g["generator"])
        self.fcr = g["firstConsecutiveRoot"]
        self.flags = meta["flags"]
        self.header = Header(meta, None)

    # ---- crc ----
    def crc(self, which: str, data: bytes) -> int:
        p = self.meta["crc"][which]
        width = 16 if which == "crc16" else 32
        return crc_calc(data, width, p["poly"], p["init"], p["refin"], p["refout"], p["xorout"])

    # ---- payload stream -> plaintext, following the header flags ----
    def payload_from_stream(self, stream: bytes, hdr: dict, vec: dict, report: Report, vecid: str) -> bytes:
        out = stream
        flags = hdr["flags"]
        if flags & self.flags["CIPHER"]:
            if not vec.get("passphrase"):
                raise SpecGap(f"{vecid}: FLAGS.CIPHER is set but the fixture carries no passphrase")
            salt = out[:16]
            nonce = out[16:28]
            ct = out[28:]
            key = hashlib.pbkdf2_hmac("sha256", vec["passphrase"].encode("utf-8"), salt,
                                      int(vec.get("kdfIterations", 150000)), 32)
            out = chacha20(key, nonce, 1, ct)
        elif vec.get("passphrase"):
            report.gap(
                vecid,
                "the vector declares a passphrase and kdfIterations, but no page header sets FLAGS.CIPHER "
                "and the reconstructed page stream *is* the plaintext payload: nothing printed on the page "
                "tells a decoder to decrypt, so the CIPHER/ChaCha20/PBKDF2 leg is not covered end-to-end",
            )
        if flags & self.flags["COMPRESSED"]:
            out = container_decode(out, report, vecid)
        elif out[:4] == PSZ_MAGIC:
            report.note(
                f"{vecid}: the recovered stream starts with PSZ1 but FLAGS.COMPRESSED is clear; "
                "the container path was taken anyway"
            )
            out = container_decode(out, report, vecid)
        return out

    # ---- a page's cells -> its 220/2390-byte page codeword ----
    def page_codeword(self, cells, bits_per_cell, channels, mode, content_len, parity_len):
        n = len(cells)
        step = default_step(n)
        if mode == "unequal":
            if len(channels) != 2:
                raise SpecGap(
                    f"ecc.mode 'unequal' with {len(channels)} channels: meta never says how more than two "
                    f"channel streams are split"
                )
            raw = deinterleave(cells, n, step)
            body = unpack_channels(raw, bits_per_cell, channels, [content_len, parity_len])
        elif mode == "native":
            total = content_len + parity_len
            raw = deinterleave(cells, n, step)
            body = unpack_flat(raw, bits_per_cell, total)
        else:
            raise SpecGap(f"ecc.mode {mode!r} is not described anywhere in meta.cellPacking")
        return body, step


def unpack_transfer_pages(pskt: Pskt, vec: dict, report: Report, vecid: str, drop=()):
    """Every page -> {pageIndex: intra content bytes}.  Also returns the header of page 0-ish."""
    meta = pskt.meta
    net = vec["ecc"]["dataBytes"]
    par = vec["ecc"]["parityBytes"]
    contents = {}
    hdrs = {}
    corrected_total = 0
    for idx, p in enumerate(vec["pages"]):
        blob = unhex(p["header"])
        hdr = pskt.header.decode(blob)
        if hdr["pageIndex"] != idx:
            raise SpecGap(
                f"{vecid}: pages[{idx}].header carries pageIndex {hdr['pageIndex']}; the fixture does not state "
                "that the pages array is in pageIndex order, so page order is ambiguous"
            )
        hdrs[idx] = hdr
    if not hdrs:
        raise Reject(f"{vecid}: no pages at all")
    ref = hdrs[min(hdrs)]
    n_total = ref["totalPages"]
    k_data = ref["dataPages"]
    parity_pages = n_total - k_data
    blocks = derive_blocks(vecid, ref, vec)
    for idx, p in enumerate(vec["pages"]):
        if idx in drop:
            continue
        hdr = hdrs[idx]
        cells = p["levels"]
        if len(cells) != vec["totalCells"]:
            raise Reject(f"{vecid}: pages[{idx}] has {len(cells)} cells, vector says {vec['totalCells']}")
        cw, step = pskt.page_codeword(cells, vec["bitsPerCell"], vec["channels"], vec["ecc"]["mode"], net, par)
        content, bad, corrected = intra_decode(pskt.gf, cw, ref["intraK"], ref["intraNsym"], blocks, report, vecid)
        corrected_total += corrected
        if content is None:
            raise Reject(f"{vecid}: pages[{idx}] intra-page RS failed: {bad}")
        why = intra_verify_encode(pskt.gf, cw, ref["intraK"], ref["intraNsym"], blocks)
        if why:
            report.check("rs-layout", vecid, f"pages[{idx}] intra parity re-encodes", False, why)
        contents[idx] = content[:hdr["dataBytesPerPage"]]
    return contents, ref, n_total, k_data, parity_pages, corrected_total


def derive_blocks(vecid: str, hdr: dict, vec: dict) -> int:
    """`blocks` is not a header field.  Derive it the only way the layout allows."""
    k = hdr["intraK"]
    nsym = hdr["intraNsym"]
    db = hdr["dataBytesPerPage"]
    if k <= 0:
        raise Reject(f"{vecid}: intraK is 0")
    if db % k:
        raise SpecGap(
            f"{vecid}: dataBytesPerPage {db} is not a multiple of intraK {k}; the layout note describes only "
            "whole blocks, so a trailing partial block is undefined"
        )
    blocks = db // k
    if blocks != vec["ecc"]["intra"]["blocks"]:
        raise Reject(
            f"{vecid}: header implies {blocks} intra blocks (dataBytesPerPage/intraK), ecc.intra.blocks says "
            f"{vec['ecc']['intra']['blocks']}"
        )
    if blocks * nsym != vec["ecc"]["parityBytes"]:
        raise Reject(f"{vecid}: blocks*intraNsym = {blocks * nsym}, parityBytes = {vec['ecc']['parityBytes']}")
    return blocks


def assemble_payload(pskt: Pskt, vec: dict, report: Report, vecid: str, drop=()) -> bytes:
    contents, ref, n_total, k_data, parity_pages, corrected = unpack_transfer_pages(
        pskt, vec, report, vecid, drop)
    net = ref["dataBytesPerPage"]
    if ref["blockPad"]:
        # documented only as "pad each to netBytesPerPage, strip blockPad"; no vector exercises it
        pass
    # ---- inter-page RS, one codeword per byte offset, pages in pageIndex order ----
    if corrected and not drop:
        report.note(f"{vecid}: {corrected} intra block(s) needed symbol correction on a nominally clean page")
    missing = [i for i in range(n_total) if i not in contents]
    if len(missing) > parity_pages:
        raise Reject(
            f"{vecid}: {len(missing)} pages missing but only {parity_pages} parity pages "
            f"(rule 2*t+e<=nsym with e>{parity_pages})"
        )
    streams = {}
    for i in range(n_total):
        buf = contents.get(i, b"")
        if len(buf) > net:
            raise Reject(f"{vecid}: page {i} content {len(buf)} > dataBytesPerPage {net}")
        streams[i] = buf + b"\x00" * (net - len(buf))
    out_cols = bytearray()
    for j in range(net):
        col = bytearray()
        for i in range(n_total):
            col += bytes([streams[i][j]])
        if not missing:
            out_cols += col[:k_data]
            continue
        ok, fixed, why = rs_decode(pskt.gf, bytes(col), parity_pages, erasures=missing, fcr=pskt.fcr)
        if not ok:
            raise Reject(f"{vecid}: inter-page RS failed at column {j}: {why}")
        out_cols += fixed[:k_data]
    data = bytes(out_cols)
    # prove the inter-page code really is systematic RS(k_data, n_total) over these pages
    if not missing:
        for j in range(0, net, max(1, net // 32)):
            col = bytes(streams[i][j] for i in range(n_total))
            want = col[k_data:]
            got = rs_encode(pskt.gf, col[:k_data], parity_pages, pskt.fcr)
            if got != want:
                report.check(
                    "transfer", vecid, f"inter-page parity re-encodes (col {j})", False,
                    f"column {j}: recomputed {hx(got)} != parity pages {hx(want)}")
                break
        else:
            report.check("transfer", vecid, f"inter-page parity re-encodes ({net} columns, sampled)", True, "")
    pad = ref["blockPad"]
    if len(data) < pad:
        raise Reject(f"{vecid}: blockPad {pad} longer than the assembled stream")
    data = data[:len(data) - pad] if pad else data
    plen = ref["payloadLen"]
    if plen > len(data):
        raise Reject(f"{vecid}: payloadLen {plen} exceeds the assembled {len(data)} bytes (blockPad?)")
    stream = data[:plen]
    return pskt.payload_from_stream(stream, ref, vec, report, vecid)


# --------------------------------------------------------------------------------------
# per-kind handlers
# --------------------------------------------------------------------------------------


def h_crc(pskt, vec, report):
    algo = vec["algo"]
    data = unhex(vec["input"])
    got = pskt.crc(algo, data)
    report.eq("crc", vec["id"], f"{algo}({len(data)} bytes)", vec["expected"], got)


def h_sha256(pskt, vec, report):
    data = unhex(vec["input"])
    got = sha256_bytes(data)
    report.eq("sha256", vec["id"], f"sha256({len(data)} bytes)", unhex(vec["expected"]), got)
    report.eq("sha256", vec["id"], "witness: hashlib agrees", hashlib.sha256(data).digest(), got)
    if "inputLength" in vec:
        report.check("sha256", vec["id"], "inputLength matches the decoded hex", vec["inputLength"], len(data))


def h_deflate(pskt, vec, report):
    blob = unhex(vec["container"])
    want = unhex(vec["input"])
    method, rawlen, body = container_split(blob, report, vec["id"], vec["method"], vec["rawLength"])
    report.eq("deflate", vec["id"], "container magic", PSZ_MAGIC, blob[:4])
    if method == 0:
        report.eq("deflate", vec["id"], "stored body == input", want, body)
        report.note(
            f"{vec['id']}: the vector's own `note` says to INFLATE the container body, but method 0 stores the "
            "payload verbatim -- inflating it raises. The per-vector note is wrong for method 0."
        )
    else:
        d = zlib.decompressobj(-15)
        out = d.decompress(body) + d.flush()
        report.eq("deflate", vec["id"], "inflate(container body) == input", want, out)
        report.eq("deflate", vec["id"], "container length field", vec["rawLength"], rawlen)


def h_deflateraw(pskt, vec, report):
    stream = unhex(vec["stream"])
    want = unhex(vec["input"])
    d = zlib.decompressobj(-15)
    out = d.decompress(stream) + d.flush()
    report.eq("deflate-raw", vec["id"], "zlib(-15) inflate == input", want, out)
    report.check("deflate-raw", vec["id"], "no trailing bytes", 0, len(d.unused_data))


def h_chacha20(pskt, vec, report):
    key, nonce = unhex(vec["key"]), unhex(vec["nonce"])
    pt = unhex(vec["plaintext"])
    ct = unhex(vec["ciphertext"])
    got = chacha20(key, nonce, vec["counter"], pt)
    report.eq("chacha20", vec["id"], "encrypt", ct, got)
    report.eq("chacha20", vec["id"], "re-XOR returns the plaintext", pt, chacha20(key, nonce, vec["counter"], got))


def h_pbkdf2(pskt, vec, report):
    got = hashlib.pbkdf2_hmac("sha256", vec["passphrase"].encode("utf-8"), unhex(vec["salt"]),
                              int(vec["iterations"]), int(vec["dkLen"]))
    report.eq("pbkdf2", vec["id"], f"PBKDF2-HMAC-SHA256 i={vec['iterations']} dk={vec['dkLen']}",
              unhex(vec["expected"]), got)
    enc = pskt.meta["encryption"]
    report.check("pbkdf2", vec["id"], "meta declares the same KDF", enc["kdf"],
                 "PBKDF2-HMAC-SHA256, 150000 iterations, 32-byte output, salt = the 16 bytes at the head of the payload")


def h_rs_encode(pskt, vec, report):
    data = unhex(vec["data"])
    parity = rs_encode(pskt.gf, data, vec["nsym"], pskt.fcr)
    report.eq("rs-encode", vec["id"], f"parity k={vec['k']} nsym={vec['nsym']}", unhex(vec["expectedParity"]), parity)
    report.eq("rs-encode", vec["id"], "codeword == data||parity", unhex(vec["codeword"]), data + parity)
    report.check("rs-encode", vec["id"], "len(data) == k", vec["k"], len(data))


def h_rs_erase(pskt, vec, report):
    cw = unhex(vec["codeword"])
    ok, fixed, why = rs_decode(pskt.gf, cw, vec["nsym"], erasures=vec["erasures"], fcr=pskt.fcr)
    if not ok:
        report.check("rs-erase", vec["id"], "decode", False, why)
        return
    report.eq("rs-erase", vec["id"], f"recover (e={len(vec['erasures'])}, nsym={vec['nsym']})",
              unhex(vec["expected"]), fixed)


def h_rs_error(pskt, vec, report):
    cw = unhex(vec["codeword"])
    ok, fixed, why = rs_decode(pskt.gf, cw, vec["nsym"], fcr=pskt.fcr)
    if not ok:
        report.check("rs-error", vec["id"], "decode", False, why)
        return
    report.eq("rs-error", vec["id"], f"recover (t={len(vec['errorsAt'])}, nsym={vec['nsym']})",
              unhex(vec["expected"]), fixed)
    d = first_diff(unhex(vec["codeword"]), unhex(vec["expected"]))
    report.note(f"{vec['id']}: errors were at {vec['errorsAt']}; my correction touched offsets starting at {d}")


def h_rs_fail(pskt, vec, report):
    cw = unhex(vec["codeword"])
    ok, fixed, why = rs_decode(pskt.gf, cw, vec["nsym"], fcr=pskt.fcr)
    if vec["expectedOutcome"] != "fail":
        raise SpecGap(f"{vec['id']}: expectedOutcome {vec['expectedOutcome']!r} is not 'fail'")
    report.check("rs-fail", vec["id"], "decoder REFUSES", (False, None) == (ok, fixed) or not ok,
                 "" if not ok else f"mine returned {hx(fixed)[:64]}... where the fixture refuses ({why})")
    if vec.get("decoded") is not None and ok:
        report.eq("rs-fail", vec["id"], "matches fixture 'decoded'", unhex(vec["decoded"]), fixed)


def h_interleave(pskt, vec, report):
    n = vec["n"]
    step = default_step(n)
    report.eq("interleave", vec["id"], f"defaultStep({n})", vec["step"], step)
    fwd, inv = perm_tables(n, vec["step"])
    sample = 24
    report.eq("interleave", vec["id"], "fwd sample", vec["fwdSample"], fwd[:sample])
    report.eq("interleave", vec["id"], "inv sample", vec["invSample"], inv[:sample])
    report.eq("interleave", vec["id"], "checksum", vec["checksum"], interleave_checksum(fwd))
    report.check("interleave", vec["id"], "fwd is a bijection", n, len(set(fwd)))


def h_header(pskt, vec, report):
    blob = unhex(vec["bytes"])
    hdr = pskt.header.decode(blob)
    for name, want in vec["fields"].items():
        got = hdr.get(name, _NO_FIELD)
        report.eq("header", vec["id"], f"decode {name}", want, got)
    re_blob = pskt.header.encode(vec["fields"])
    report.eq("header", vec["id"], "re-encode == bytes", blob, re_blob)
    report.check("header", vec["id"], "crcValid flag agrees with my CRC", True, vec["crcValid"])


def h_header_crc(pskt, vec, report):
    blob = unhex(vec["bytes"])
    try:
        pskt.header.decode(blob)
    except Reject as exc:
        report.check("header-crc", vec["id"], "rejected", vec["reason"] in str(exc), str(exc))
        return
    report.check("header-crc", vec["id"], "rejected", False, "my header decoder ACCEPTED a header the fixture rejects")


def _levels_of(pskt_doc, vec, report):
    src = vec["levelsFrom"]
    m = re.match(r"^(.*?):pages\[(\d+)\]\.levels$", src)
    if not m:
        raise SpecGap(f"{vec['id']}: levelsFrom {src!r} is not '<transferId>:pages[i].levels'")
    tid, idx = m.group(1), int(m.group(2))
    parent = pskt_doc.get(tid)
    if parent is None:
        raise SpecGap(f"{vec['id']}: levelsFrom names unknown vector {tid!r}")
    return parent, parent["pages"][idx]["levels"]


def h_page_unpack(pskt, vec, report, doc_by_id):
    parent, printed = _levels_of(doc_by_id, vec, report)
    n = len(printed)
    di = vec["deinterleave"]
    report.eq("page-unpack", vec["id"], "deinterleave n", n, di["n"])
    step = default_step(n)
    report.eq("page-unpack", vec["id"], f"defaultStep({n})", di["step"], step)
    if vec["contentErasedCount"] or vec["parityErasedCount"]:
        raise SpecGap(
            f"{vec['id']}: contentErasedCount={vec['contentErasedCount']} parityErasedCount={vec['parityErasedCount']} "
            "but the fixture gives no cell-erasure map, so whole-byte erasures cannot be re-implemented here"
        )
    cw, _ = pskt.page_codeword(printed, vec["bitsPerCell"], vec["channels"], parent["ecc"]["mode"],
                               vec["dataBytes"], vec["parityBytes"])
    want = unhex(vec["codeword"])
    report.eq("page-unpack", vec["id"], f"de-interleave + unpack ({parent['ecc']['mode']})", want, cw)
    report.check("page-unpack", vec["id"], "codeword == dataBytes+parityBytes",
                 vec["dataBytes"] + vec["parityBytes"], len(want))
    report.check("page-unpack", vec["id"], "bitsPerCell == sum(channel bits)", vec["bitsPerCell"],
                 sum(c["bits"] for c in vec["channels"]))
    report.check("page-unpack", vec["id"], "cell capacity >= codeword bits", True,
                 n * vec["bitsPerCell"] >= len(want) * 8,
                 f"{n} cells x {vec['bitsPerCell']} bits = {n * vec['bitsPerCell']} < {len(want) * 8}")
    # and the inverse direction: re-pack + re-interleave must give back the printed page
    if parent["ecc"]["mode"] == "unequal":
        cells = pack_channels_to_cells(want, vec["bitsPerCell"], vec["channels"],
                                       [vec["dataBytes"], vec["parityBytes"]], n)
    else:
        cells = pack_flat_to_cells(want, vec["bitsPerCell"], n)
    report.eq("page-unpack", vec["id"], "re-pack + interleave == printed levels", printed,
              interleave(cells, n, step))


def h_page_decode(pskt, vec, report):
    cw = unhex(vec["codeword"])
    k, nsym, blocks = vec["intra"]["k"], vec["intra"]["nsym"], vec["intra"]["blocks"]
    report.eq("page-decode", vec["id"], "blocks derived from the codeword", blocks,
              len(cw) // (k + nsym) if len(cw) % (k + nsym) == 0 else -1)
    content, bad, corrected = intra_decode(pskt.gf, cw, k, nsym, blocks, report, vec["id"])
    if content is None:
        report.check("page-decode", vec["id"], "recover", False, str(bad))
        return
    report.eq("page-decode", vec["id"], f"intra decode k={k} nsym={nsym} blocks={blocks}",
              unhex(vec["expectedContent"]), content)
    report.check("page-decode", vec["id"], "okBlocks", vec["okBlocks"], blocks - len(bad or []))
    report.check("page-decode", vec["id"], "no symbol correction needed on a clean page", 0, corrected)
    why = intra_verify_encode(pskt.gf, cw, k, nsym, blocks)
    report.check("page-decode", vec["id"], "every block's parity re-encodes from its content", True, why or "")


def _check_transfer_headers(pskt, vec, report):
    hdr = pskt.header.decode(unhex(vec["pages"][0]["header"]))
    meta = pskt.meta
    report.eq("transfer", vec["id"], "header profile", meta["profileCodes"][vec["profile"]],
              meta["profileCodes"][hdr["profile"]])
    if vec["nozzle"] is not None:
        report.eq("transfer", vec["id"], "header nozzle code", int(round(float(vec["nozzle"]) * 10)),
                  int(round(float(hdr["nozzle"]) * 10)))
    report.eq("transfer", vec["id"], "header totalPages", len(vec["pages"]), hdr["totalPages"])
    report.eq("transfer", vec["id"], "header dataPages", vec["dataPages"], hdr["dataPages"])
    report.eq("transfer", vec["id"], "header parityPages", vec["parityPages"], hdr["totalPages"] - hdr["dataPages"])
    report.eq("transfer", vec["id"], "header payloadLen", len(unhex(vec["payload"])), hdr["payloadLen"])
    report.eq("transfer", vec["id"], "header intraK", vec["ecc"]["intra"]["k"], hdr["intraK"])
    report.eq("transfer", vec["id"], "header intraNsym", vec["ecc"]["intra"]["nsym"], hdr["intraNsym"])
    report.eq("transfer", vec["id"], "header dataBytesPerPage", vec["ecc"]["dataBytes"], hdr["dataBytesPerPage"])
    report.eq("transfer", vec["id"], "header blockPad", vec["ecc"]["blockPad"], hdr["blockPad"])
    pay = unhex(vec["payload"])
    digest = sha256_bytes(pay)[:meta["digestLength"]]
    report.eq("transfer", vec["id"], "header digest == sha256(payload)[:digestLength]", hx(digest), hdr["digest"])
    report.eq("transfer", vec["id"], "header sessionId == sha256(payload)[:8]", hx(sha256_bytes(pay)[:8]),
              hdr["sessionId"])
    report.eq("transfer", vec["id"], "payloadSha256", vec["payloadSha256"], hx(sha256_bytes(pay)))
    kinds = [pskt.header.decode(unhex(p["header"]))["kind"] for p in vec["pages"]]
    want_kinds = [0] * vec["dataPages"] + [1] * vec["parityPages"]
    report.eq("transfer", vec["id"], "page kinds (0 data, 1 parity)", want_kinds, kinds)
    return hdr


def h_transfer(pskt, vec, report):
    _check_transfer_headers(pskt, vec, report)
    pay = unhex(vec["payload"])
    got = assemble_payload(pskt, vec, report, vec["id"])
    report.eq("transfer", vec["id"], "end-to-end payload", pay, got)
    report.eq("transfer", vec["id"], "end-to-end sha256", vec["payloadSha256"], hx(sha256_bytes(got)))


def h_transfer_loss(pskt, vec, report, doc_by_id):
    parent = doc_by_id.get(vec["from"])
    if parent is None:
        raise SpecGap(f"{vec['id']}: 'from' names unknown vector {vec['from']!r}")
    pay = assemble_payload(pskt, parent, report, vec["id"], drop=set(vec["droppedPages"]))
    report.eq("transfer-loss", vec["id"], f"recover with pages {vec['droppedPages']} withheld",
              vec["expectedPayloadSha256"], hx(sha256_bytes(pay)))
    if "expectedPayload" in vec:
        report.eq("transfer-loss", vec["id"], "payload bytes", unhex(vec["expectedPayload"]), pay)


def h_geometry(pskt, vec, report):
    """Partial on purpose: the fixture states pixel/mm numbers but `meta` documents no
    rule for choosing pitch, sheet size or net capacity, so only the internal
    arithmetic is checkable here (see the SPEC GAP list)."""
    ok = True
    report.eq("geometry", vec["id"], "cols*rows == totalCells", vec["totalCells"], vec["cols"] * vec["rows"])
    report.eq("geometry", vec["id"], "bitsPerCell == sum(channel bits)", vec["bitsPerCell"],
              sum(c["bits"] for c in vec["channels"]))
    quiet_rule = 5 * vec["cellPx"]  # QUIET_CELLS = 5, docs/STATUS.md decision 1
    report.eq("geometry", vec["id"], "quietPx == 5*cellPx (STATUS decision 1)", quiet_rule, vec["quietPx"])
    report.eq("geometry", vec["id"], "canvas.w == cols*cellPx + 2*quietPx", vec["canvasPx"]["w"],
              vec["cols"] * vec["cellPx"] + 2 * vec["quietPx"])
    report.eq("geometry", vec["id"], "canvas.h == rows*cellPx + 2*quietPx", vec["canvasPx"]["h"],
              vec["rows"] * vec["cellPx"] + 2 * vec["quietPx"])
    report.check("geometry", vec["id"], "every fiducial ring == cellPx", vec["cellPx"],
                 max(f["ringPx"] for f in vec["fiducials"]) if vec["fiducials"] else 0)
    dpi = vec["dpi"]
    got_w = vec["sheetOrPlateMm"]["wMm"] / 25.4 * dpi
    got_h = vec["sheetOrPlateMm"]["hMm"] / 25.4 * dpi
    report.check("geometry", vec["id"], "canvas == sheet mm @ dpi (+/-0.5px)", True,
                 abs(got_w - vec["canvasPx"]["w"]) <= 0.5 and abs(got_h - vec["canvasPx"]["h"]) <= 0.5,
                 f"sheet {got_w:.2f}x{got_h:.2f}px vs canvas {vec['canvasPx']['w']}x{vec['canvasPx']['h']}")
    px = vec["pitchMm"] / 25.4 * dpi
    report.check("geometry", vec["id"], "cellPx == round(pitchMm @ dpi) (+/-0.5px)", True,
                 abs(px - vec["cellPx"]) <= 0.5, f"pitch {px:.2f}px vs cellPx {vec['cellPx']}")
    cap = vec["totalCells"] * vec["bitsPerCell"] // 8
    report.check("geometry", vec["id"], "capacity >= netBytesPerPage", True, cap >= vec["netBytesPerPage"],
                 f"{cap} bytes of cell bits, net {vec['netBytesPerPage']}")
    profile = vec["profile"]
    if profile in pskt.meta["profileCodes"]:
        report.check("geometry", vec["id"], "profile has a code in meta.profileCodes", True, True)
    else:
        ok = False
        report.check("geometry", vec["id"], "profile has a code in meta.profileCodes", False, profile)
    report.gap(vec["id"], "kind 'geometry' states pixel/mm/capacity results but `meta` documents no rule to "
                          "derive pitchMm, sheet size, netBytesPerPage or the glyph geometry, so only internal "
                          "arithmetic is verified here")


# --------------------------------------------------------------------------------------
# meta self-consistency (cheap, and it is what makes the rest interpretable)
# --------------------------------------------------------------------------------------


def check_meta(pskt, meta, report):
    g = meta["gf256"]
    report.check("meta", "meta", "gf256 generator is primitive (order 255)",
                 len(set(pskt.gf.exp[:255])) == 255,
                 f"order {len(set(pskt.gf.exp[:255]))}")
    # x^8+x^4+x^3+x^2+1 = 0x11D. The name of this check and the constant have to
    # agree; they once did not, which is the kind of thing the JS side catches only
    # because this file is written independently.
    report.eq("meta", "meta", "gf256 primitive polynomial is x^8+x^4+x^3+x^2+1", 0x11D, g["primitivePolynomial"])
    report.eq("meta", "meta", "crc16 check value on '123456789'", meta["crc"]["crc16"]["check"],
              pskt.crc("crc16", b"123456789"))
    report.eq("meta", "meta", "crc32 check value on '123456789'", meta["crc"]["crc32"]["check"],
              pskt.crc("crc32", b"123456789"))
    report.eq("meta", "meta", "crc32 agrees with zlib", zlib.crc32(b"the quick brown fox") & 0xFFFFFFFF,
              pskt.crc("crc32", b"the quick brown fox"))
    report.eq("meta", "meta", "headerLength == sum(headerLayout lengths)", meta["headerLength"],
              sum(r[1] for r in meta["headerLayout"]))
    report.check("meta", "meta", "flags are disjoint single bits",
                 all(v & (v - 1) == 0 for v in meta["flags"].values()),
                 f"flags {meta['flags']}")
    report.check("meta", "meta", "profile codes are 0..len-1 with no duplicates",
                 sorted(meta["profileCodes"].values()) == list(range(len(meta["profileCodes"]))),
                 str(meta["profileCodes"]))
    # RS sanity: an empty erasure decode of a freshly encoded word must be clean
    data = bytes(range(32))
    cw = data + rs_encode(pskt.gf, data, 10, pskt.fcr)
    ok, fixed, why = rs_decode(pskt.gf, cw, 10, fcr=pskt.fcr)
    report.check("meta", "meta", "RS round-trip sanity (k=32,nsym=10)", bool(ok), why or "")
    bad = bytearray(cw)
    bad[3] ^= 0x5E
    bad[17] ^= 0x2B
    ok, fixed, why = rs_decode(pskt.gf, bytes(bad), 10, fcr=pskt.fcr)
    report.check("meta", "meta", "RS corrects 2 unknown errors with nsym=10",
                 bool(ok) and fixed == cw, why or "")
    ok, fixed, why = rs_decode(pskt.gf, bytes(bad), 10, erasures=(3,), fcr=pskt.fcr)
    report.check("meta", "meta", "RS corrects 1 erasure + 1 error with nsym=10",
                 bool(ok) and fixed == cw, why or "")
    # and refuses when 2*t+e > nsym
    wild = bytearray(cw)
    for i in range(0, 20):
        wild[i] ^= 0x9C
    ok, _, _ = rs_decode(pskt.gf, bytes(wild), 10, fcr=pskt.fcr)
    report.check("meta", "meta", "RS refuses a word with 20 errors and nsym=10", not ok,
                 "decoded anyway -- the capacity rule is not being enforced")


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------

HANDLERS = {
    "crc": h_crc,
    "sha256": h_sha256,
    "deflate": h_deflate,
    "deflate-raw": h_deflateraw,
    "chacha20": h_chacha20,
    "pbkdf2": h_pbkdf2,
    "rs-encode": h_rs_encode,
    "rs-erase": h_rs_erase,
    "rs-error": h_rs_error,
    "rs-fail": h_rs_fail,
    "interleave": h_interleave,
    "header": h_header,
    "header-crc": h_header_crc,
    "page-unpack": h_page_unpack,
    "page-decode": h_page_decode,
    "transfer": h_transfer,
    "transfer-loss": h_transfer_loss,
    "geometry": h_geometry,
}


def run(fixture_path: str, verbose: bool = False, strict_gaps: bool = False) -> int:
    with open(fixture_path, "rb") as fh:
        doc = json.loads(fh.read().decode("utf-8"))
    meta = doc["meta"]
    vectors = doc["vectors"]
    pskt = Pskt(meta)
    report = Report(verbose)
    by_id = {v["id"]: v for v in vectors}

    check_meta(pskt, meta, report)

    for vec in vectors:
        kind = vec.get("kind", "?")
        handler = HANDLERS.get(kind)
        if handler is None:
            report.skip(vec["id"], kind, "this reference has no handler for that vector kind")
            continue
        try:
            if len(inspect.signature(handler).parameters) == 4:
                handler(pskt, vec, report, by_id)
            else:
                handler(pskt, vec, report)
        except SpecGap as gap:
            report.gap(vec["id"], str(gap))
        except Reject as rej:
            # a Reject that escapes a handler means the vector was supposed to
            # work and did not: that is a failure, not a skip.
            report.check(kind, vec["id"], "decodes without rejection", False, str(rej))
        except Exception as exc:  # noqa: BLE001 -- a crash must be reported, never hidden
            report.check(kind, vec["id"], "handler ran without crashing", False,
                         f"{type(exc).__name__}: {exc}")

    width = max((len(g) for g in report.order), default=6)
    print(f"{'group'.ljust(width)}  ok/total")
    for group in report.order:
        good, total = report.groups[group]
        flag = "" if good == total else "   <-- "
        print(f"  {group.ljust(width)}  {good}/{total}{flag}")
    print(f"\n{report.aspects} checks over {len(vectors)} vectors, {len(by_id)} unique ids")
    if report.failures:
        print(f"\n{len(report.failures)} FAILURE(S):")
        for line in report.failures:
            print("  " + line)
    if report.gaps:
        print(f"\n{len(report.gaps)} SPEC GAP(s) -- the fixture did not say enough to check this:")
        for vecid, what in report.gaps:
            print(f"  {vecid}: {what}")
    if report.skips:
        print(f"\n{len(report.skips)} SKIPPED vector(s) -- never counted as passes:")
        for vecid, group, why in report.skips:
            print(f"  {vecid} ({group}): {why}")
    for note in report.notes:
        print(f"  note: {note}")

    failed = bool(report.failures) or bool(report.skips)
    if strict_gaps and report.gaps:
        failed = True
    verdict = "FAIL" if failed else "PASS"
    if report.failures:
        verdict = f"FAIL ({len(report.failures)} mismatch(es))"
    elif report.skips:
        verdict = f"FAIL ({len(report.skips)} vector(s) unchecked)"
    elif report.gaps:
        verdict = f"PASS with {len(report.gaps)} spec gap(s)"
    else:
        verdict = "PASS"
    print(f"\n{os.path.basename(fixture_path)}: {verdict}")
    return 1 if failed else 0


def main(argv=None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Independently verify tests/conformance.json (see the module docstring's independence rule).")
    ap.add_argument("--fixture", default=os.path.join(here, "..", "tests", "conformance.json"))
    ap.add_argument("-v", "--verbose", action="store_true", help="print every individual check")
    ap.add_argument("--strict-gaps", action="store_true", help="exit non-zero if the fixture left anything underspecified")
    args = ap.parse_args(argv)
    return run(args.fixture, args.verbose, args.strict_gaps)


if __name__ == "__main__":
    sys.exit(main())