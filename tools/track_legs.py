#!/usr/bin/env python3
"""
track_legs.py — solve caméra 2D des legs v7 pour le matchmove des cartes.

Pour chaque leg (720p24, 169 frames) on estime le mouvement image par image
(flux optique LK pyramidal + similarité RANSAC, contrôle forward-backward,
comme le point-tracker d'After Effects / Resolve), puis on propage chaque
ancre (point monde posé sur un mur / une verrière / une devanture à une frame
de seed) vers l'avant ET l'arrière du leg :

  - estimation LOCALE d'abord : features dans un rayon autour de la position
    courante de l'ancre (la carte suit le plan du mur, parallaxe correcte) ;
  - repli GLOBAL (plein cadre) quand la région sort de l'image ou manque de
    texture — l'ancre reste alors solidaire de la caméra.

Les legs étant masterisés last frame = first frame (cuts pixel-locked), chaque
ancre est aussi prolongée dans le leg suivant (`ext`) pour les cartes dont la
fenêtre de scroll déborde la couture.

Sortie : assets/tracks-v7.json — positions normalisées [0,1] + échelle
relative à la frame de seed, lissées (gaussienne σ≈1.1 frame).
"""
import cv2
import json
import math
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VID = os.path.join(ROOT, 'assets', 'vid', 'leg-%d.mp4')
OUT = os.path.join(ROOT, 'assets', 'tracks-v7.json')
DEBUG_DIR = os.environ.get('TRACK_DEBUG_DIR', '')

# leg (1-based) -> [(nom, frame de seed, x, y)] en coordonnées vidéo normalisées
# NB : legs 1-2 régénérés le 21/07 15:58 (119 et 155 frames) — seeds recalées.
ANCHORS = {
    1: [('kpi1', 118, 0.09, 0.42),    # façade de la rangée gauche
        ('kpi2', 118, 0.21, 0.58),    # pilastre gauche de la vitrine métal noir
        ('kpi3', 118, 0.60, 0.16),    # étage de la façade du bâtiment héros
        ('kpi4', 118, 0.88, 0.46)],   # rangée de droite
    2: [('ouvrir', 110, 0.36, 0.30)],       # verrière intérieure (mur porteur ouvert)
    3: [('eclairer', 126, 0.66, 0.56)],     # garde-corps mezzanine sous la verrière
    4: [('isoler', 150, 0.73, 0.33)],       # mur brique + laine entre montants
    5: [('reveler', 110, 0.66, 0.14)],      # bandeau de la devanture bleue
    6: [('temoignage', 55, 0.24, 0.35)],    # mur vert sapin (peinture en cours)
}

LK = dict(winSize=(21, 21), maxLevel=3,
          criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
LOCAL_RADIUS = 300          # px : rayon de la région suivie autour de l'ancre
FB_MAX = 0.9                # px : erreur forward-backward max
MIN_INLIERS = 10
SMOOTH_SIGMA = 1.1          # frames


def read_frames(path):
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY))
    cap.release()
    if not frames:
        sys.exit('impossible de lire ' + path)
    return frames


def step_similarity(fa, fb, mask=None):
    """Similarité (tx, ty, échelle, rotation) fa -> fb. Retourne (M 2x3, inliers)."""
    pts = cv2.goodFeaturesToTrack(fa, maxCorners=700, qualityLevel=0.008,
                                  minDistance=12, blockSize=7, mask=mask)
    if pts is None or len(pts) < MIN_INLIERS:
        return None, 0
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(fa, fb, pts, None, **LK)
    back, st2, _ = cv2.calcOpticalFlowPyrLK(fb, fa, nxt, None, **LK)
    d = np.linalg.norm(pts - back, axis=2).ravel()
    good = (st.ravel() == 1) & (st2.ravel() == 1) & (d < FB_MAX)
    if good.sum() < MIN_INLIERS:
        return None, int(good.sum())
    M, inl = cv2.estimateAffinePartial2D(pts[good], nxt[good], method=cv2.RANSAC,
                                         ransacReprojThreshold=2.0, maxIters=3000,
                                         confidence=0.995)
    if M is None:
        return None, 0
    return M, int(inl.sum()) if inl is not None else 0


def circle_mask(shape, cx, cy, r):
    m = np.zeros(shape, np.uint8)
    cv2.circle(m, (int(round(cx)), int(round(cy))), int(r), 255, -1)
    return m


def apply_M(M, p):
    return np.array([M[0, 0] * p[0] + M[0, 1] * p[1] + M[0, 2],
                     M[1, 0] * p[0] + M[1, 1] * p[1] + M[1, 2]])


def scale_of(M):
    return math.hypot(M[0, 0], M[1, 0])


def invert_similarity(M):
    A = np.vstack([M, [0, 0, 1]])
    return np.linalg.inv(A)[:2, :]


def solve_global_chain(frames):
    """M[t] : frame t -> t+1, plein cadre. Repli : mouvement constant."""
    n = len(frames)
    Ms, inls, fallbacks = [], [], 0
    prev = np.array([[1, 0, 0], [0, 1, 0]], np.float64)
    for t in range(n - 1):
        M, ninl = step_similarity(frames[t], frames[t + 1])
        if M is None:
            M, ninl = prev.copy(), 0
            fallbacks += 1
        Ms.append(M)
        inls.append(ninl)
        prev = M
    return Ms, inls, fallbacks


def local_step(frames, t_from, t_to, p, global_M):
    """Similarité locale autour de p (dans la frame t_from) ; repli global."""
    h, w = frames[0].shape
    if -80 <= p[0] <= w + 80 and -80 <= p[1] <= h + 80:
        mask = circle_mask((h, w), p[0], p[1], LOCAL_RADIUS)
        M, ninl = step_similarity(frames[t_from], frames[t_to], mask=mask)
        if M is not None:
            return M, True
    return global_M, False


def track_anchor(frames, seed_f, p0, global_Ms, start_p=None):
    """Trajectoire de l'ancre sur tout le leg (avant + arrière depuis la seed).
    start_p : si fourni, seed_f doit être 0 et on démarre à cette position
    (prolongement `ext` dans le leg suivant)."""
    n = len(frames)
    pos = np.zeros((n, 2))
    scl = np.ones(n)
    p_seed = np.array(start_p if start_p is not None else p0, np.float64)
    pos[seed_f] = p_seed
    local_used = 0

    p, s = p_seed.copy(), 1.0
    for t in range(seed_f, n - 1):
        M, was_local = local_step(frames, t, t + 1, p, global_Ms[t])
        local_used += was_local
        p = apply_M(M, p)
        s *= scale_of(M)
        pos[t + 1] = p
        scl[t + 1] = s

    p, s = p_seed.copy(), 1.0
    for t in range(seed_f, 0, -1):
        M, was_local = local_step(frames, t - 1, t, p, global_Ms[t - 1])
        local_used += was_local
        Minv = invert_similarity(M)
        p = apply_M(Minv, p)
        s /= scale_of(M)
        pos[t - 1] = p
        scl[t - 1] = s

    return pos, scl, local_used / max(1, n - 1)


def gaussian_smooth(a, sigma):
    r = max(1, int(round(sigma * 3)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.pad(a, (r, r), mode='edge')
    return np.convolve(pad, k, mode='valid')


def smooth_track(pos, scl, seed_f):
    x = gaussian_smooth(pos[:, 0], SMOOTH_SIGMA)
    y = gaussian_smooth(pos[:, 1], SMOOTH_SIGMA)
    ls = gaussian_smooth(np.log(np.clip(scl, 1e-3, 1e3)), SMOOTH_SIGMA)
    s = np.exp(ls - ls[seed_f])          # re-normalise : s[seed] = 1
    return x, y, s


def dump_debug(frames, name, x, y, every=24):
    if not DEBUG_DIR:
        return
    os.makedirs(DEBUG_DIR, exist_ok=True)
    for t in range(0, len(frames), every):
        img = cv2.cvtColor(frames[t], cv2.COLOR_GRAY2BGR)
        cv2.drawMarker(img, (int(x[t]), int(y[t])), (0, 0, 255),
                       cv2.MARKER_CROSS, 26, 3)
        cv2.imwrite(os.path.join(DEBUG_DIR, '%s-f%03d.jpg' % (name, t)), img)


def main():
    all_frames = {i: read_frames(VID % i) for i in range(1, 7)}
    chains = {}
    print('--- chaînes caméra globales ---')
    for i in range(1, 7):
        Ms, inls, fb = solve_global_chain(all_frames[i])
        chains[i] = Ms
        print('leg %d : %d pas, inliers médian %d, replis %d'
              % (i, len(Ms), int(np.median(inls)), fb))

    legs_out = []
    print('--- ancres ---')
    for i in range(1, 7):
        frames = all_frames[i]
        h, w = frames[0].shape
        n = len(frames)
        anchors_out = {}
        for (name, seed_f, nx, ny) in ANCHORS.get(i, []):
            p0 = (nx * w, ny * h)
            pos, scl, local_ratio = track_anchor(frames, seed_f, p0, chains[i])
            x, y, s = smooth_track(pos, scl, seed_f)
            dump_debug(frames, 'leg%d-%s' % (i, name), x, y)
            entry = {
                'x': [round(float(v) / w, 4) for v in x],
                'y': [round(float(v) / h, 4) for v in y],
                's': [round(float(v), 4) for v in s],
            }
            # prolongement dans le leg suivant (couture pixel-locked)
            if i < 6:
                nf = all_frames[i + 1]
                p_end = (float(x[-1]), float(y[-1]))
                epos, escl, _ = track_anchor(nf, 0, p_end, chains[i + 1],
                                             start_p=p_end)
                ex, ey, es = smooth_track(epos, escl, 0)
                s_end = float(s[-1])
                entry['ext'] = {
                    'x': [round(float(v) / w, 4) for v in ex],
                    'y': [round(float(v) / h, 4) for v in ey],
                    's': [round(float(v) * s_end, 4) for v in es],
                }
            anchors_out[name] = entry
            span_x = (float(x.min()) / w, float(x.max()) / w)
            span_y = (float(y.min()) / h, float(y.max()) / h)
            print('leg %d %-11s local %3d%%  x[%.2f..%.2f] y[%.2f..%.2f] '
                  's[%.2f..%.2f]' % (i, name, round(local_ratio * 100),
                                     span_x[0], span_x[1], span_y[0], span_y[1],
                                     float(s.min()), float(s.max())))
        legs_out.append({'n': n, 'anchors': anchors_out})

    with open(OUT, 'w') as f:
        json.dump({'version': 'v7', 'legs': legs_out}, f, separators=(',', ':'))
    print('écrit :', OUT, '(%.1f Ko)' % (os.path.getsize(OUT) / 1024))


if __name__ == '__main__':
    main()
