"""Diagnostic for ref/decode.py's Reed-Solomon decoder.

Why this file exists: the decoder reported "no codeword within 2*t+e<=nsym" for
every case with *unknown* errors, while encoding verified fine. The cause was an
orientation, not an algorithm -- the PGZ system solved in rs_decode returns the
locator coefficients in reciprocal order, so the polynomial [1]+lam has its roots
at X_j, while the textbook ascending form has them at X_j^-1. Evaluating at
X_j^-1 (as the code originally did) found no roots at all, and every error case
fell through to a refusal. A refusal is the safe direction, which is why no test
caught it as a crash -- it looked like a limitation of the decoder.

Run:  python ref/probe_rs.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import decode as R  # noqa: E402

GF_POLY, ALPHA, FCR = 0x11D, 2, 0
fails = []


def note(ok, msg):
    print(f"  {'ok  ' if ok else 'FAIL'} {msg}")
    if not ok:
        fails.append(msg)


def word(gf, k, nsym, seed=7):
    data = bytes((i * seed + 3) & 0xFF for i in range(k))
    return data, data + R.rs_encode(gf, data, nsym)


def eval_asc(gf, poly, x):
    v = 0
    for c in reversed(poly):
        v = gf.mul(v, x) ^ c
    return v


def main():
    gf = R.GF(GF_POLY, ALPHA)

    # ---- 1. the orientation fact this whole file is about -------------------
    k, nsym = 20, 10
    data, cw = word(gf, k, nsym)
    n = len(cw)
    err = {3: 0x5A, 11: 0xC3}
    recv = bytearray(cw)
    for p, v in err.items():
        recv[p] ^= v
    S = R.rs_syndromes(gf, bytes(recv), nsym, FCR)
    lam = R.gf_solve(gf, [[S[i + j] for j in range(1, 3)] for i in range(2)], S[:2])
    if lam is None:
        note(False, "PGZ solve returned nothing for a 2-error word")
    else:
        lfull = [1] + lam
        at_X = all(eval_asc(gf, lfull, gf.exp[(n - 1 - j) % 255]) == 0 for j in err)
        at_Xinv = all(eval_asc(gf, lfull, gf.exp[(255 - ((n - 1 - j) % 255)) % 255]) == 0 for j in err)
        note(at_X and not at_Xinv,
             f"solved locator roots are at X_j, not X_j^-1 (at_X={at_X}, at_X^-1={at_Xinv})")
        true_lam = [1]
        for j in err:
            true_lam = R.polymul_asc(gf, true_lam, [1, gf.exp[(n - 1 - j) % 255]])
        note(all(eval_asc(gf, true_lam, gf.exp[(255 - ((n - 1 - j) % 255)) % 255]) == 0 for j in err),
             "textbook prod(1 - X_j x) still has roots at X_j^-1 (both conventions coexist)")

    # ---- 2. the decoder must actually correct --------------------------------
    ok, out, why = R.rs_decode(gf, bytes(recv), nsym, [], FCR)
    note(ok and out == cw, f"2 unknown errors with nsym=10 -> exact codeword ({why})")

    one = bytearray(cw)
    one[n - 1] ^= 0x9D
    ok, out, why = R.rs_decode(gf, bytes(one), nsym, [], FCR)
    note(not ok or out == cw, f"single unknown error either fixes exactly or refuses ({why})")

    # ---- 3. erasures: 3 known-bad positions, nothing else wrong --------------
    erased_positions = [0, 5, 19]
    rec = bytearray(cw)
    for p in erased_positions:
        rec[p] = 0
    ok, out, why = R.rs_decode(gf, bytes(rec), nsym, erased_positions, FCR)
    note(ok and out == cw, f"3 erasures with nsym=10 -> exact codeword ({why})")

    # ---- 4. mixed: 2 erasures + 1 error with nsym=8 needs 2*1+2 = 4 <= 8 -----
    k2, ns2 = 20, 8
    _, cw2 = word(gf, k2, ns2)
    n2 = len(cw2)
    er = [2, 17]
    rec2 = bytearray(cw2)
    for p in er:
        rec2[p] = 0
    rec2[9] ^= 0x77
    ok, out, why = R.rs_decode(gf, bytes(rec2), ns2, er, FCR)
    note(ok and out == cw2, f"2 erasures + 1 error with nsym=8 -> exact codeword ({why})")

    # ---- 5. beyond budget must refuse, not invent ----------------------------
    k3, ns3 = 20, 6
    _, cw3 = word(gf, k3, ns3)
    rec3 = bytearray(cw3)
    for delta, p in enumerate([1, 4, 7, 10, 13], start=1):
        rec3[p] ^= 0x31 * delta % 256 or 1
    ok, out, _ = R.rs_decode(gf, bytes(rec3), ns3, [], FCR)
    note(not ok, f"5 unknown errors with nsym=6 (budget 3) is refused, not guessed (ok={ok})")

    print("probe_rs.py: " + ("FAIL" if fails else "PASS"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
