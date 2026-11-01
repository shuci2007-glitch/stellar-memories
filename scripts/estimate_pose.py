"""
位姿估计 v2:更快 + 代理模型比例也一起拟合。

要点:
  - 去掉光栅化后的膨胀(点云密度已经足够,不需要补洞)→ 快 2~3 倍;
  - 每帧两段式搜索:先宽范围粗搜,再在最优解附近细搜;
  - 代理模型的比例(R/w)先在首帧上拟合 —— 视频里的环带比例和默认猜测不一样,
    比例不对会把最优解带偏,IoU 上不去。
"""
import glob
import os
import sys
import time

import numpy as np
from PIL import Image
from scipy import ndimage

TARGET = 112


def mobius_points(n_u=320, n_v=100, R=58.0, w=24.0):
    u = (np.arange(n_u) / n_u) * 2 * np.pi
    v = np.linspace(-1, 1, n_v)
    U, V = np.meshgrid(u, v, indexing="ij")
    rr = R + V * w * np.cos(U * 0.5)
    # 注意 axis 必须是 -1:axis=1 会把新轴插到第 1 位,得到 (n_u,3,n_v),
    # reshape 之后点云会整个错乱(投影退化成一条直线)。
    return np.stack(
        [rr * np.cos(U), V * w * np.sin(U * 0.5), rr * np.sin(U)], axis=-1
    ).reshape(-1, 3)


def trefoil_points(n_t=520, n_v=60, s=15.0, w=17.0):
    """三叶纽结上的绸带(流动绸带图形的代理模型)"""
    t = (np.arange(n_t) / n_t) * 2 * np.pi
    v = np.linspace(-1, 1, n_v)
    h = 0.01
    def center(tt):
        tt = tt % (2 * np.pi)
        return np.stack([
            s * (np.sin(tt) + 2 * np.sin(2 * tt)),
            s * (np.cos(tt) - 2 * np.cos(2 * tt)),
            -s * np.sin(3 * tt),
        ], axis=-1)
    T, V = np.meshgrid(t, v, indexing="ij")
    c = center(T)
    p0 = center(T - h); p1 = center(T + h)
    tang = p1 - p0
    tang /= np.linalg.norm(tang, axis=-1, keepdims=True) + 1e-9
    acc = p1 - 2 * c + p0
    acc -= (acc * tang).sum(-1, keepdims=True) * tang
    acc /= np.linalg.norm(acc, axis=-1, keepdims=True) + 1e-9
    pts = c + V[..., None] * w * acc
    return pts.reshape(-1, 3)


def rot_matrix(yaw, pitch, roll):
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    cr, sr = np.cos(roll), np.sin(roll)
    Rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Ry = np.array([[cr, 0, sr], [0, 1, 0], [-sr, 0, cr]])
    return Rz @ Rx @ Ry


def segment(path, thresh=150):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    mask = a.max(axis=2) > thresh
    h, w = mask.shape
    mask[:, : int(w * 0.20)] = False
    mask[:, int(w * 0.90):] = False
    mask[int(h * 0.88):, :] = False
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def normalize_mask(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return np.zeros((TARGET, TARGET), bool)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    sub = mask[y0:y1, x0:x1]
    h, w = sub.shape
    s = TARGET / max(h, w)
    nh, nw = max(1, int(round(h * s))), max(1, int(round(w * s)))
    resized = np.asarray(
        Image.fromarray((sub * 255).astype(np.uint8)).resize((nw, nh), Image.BILINEAR)
    ) > 110
    canvas = np.zeros((TARGET, TARGET), bool)
    oy, ox = (TARGET - nh) // 2, (TARGET - nw) // 2
    canvas[oy:oy + nh, ox:ox + nw] = resized
    return canvas


def silhouette(pts, R):
    p = pts @ R.T
    xy = p[:, :2]
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    s = (TARGET - 2) / max((hi - lo).max(), 1e-6)
    q = (xy - (hi + lo) / 2) * s + TARGET / 2
    img = np.zeros((TARGET, TARGET), bool)
    xi = np.clip(q[:, 0].astype(np.int32), 0, TARGET - 1)
    yi = np.clip(q[:, 1].astype(np.int32), 0, TARGET - 1)
    img[yi, xi] = True
    return img


def iou(a, b):
    u = np.count_nonzero(a | b)
    return np.count_nonzero(a & b) / u if u else 0.0


def search(pts, target, yr, pr, rr):
    best = (-1.0, 0.0, 0.0, 0.0)
    for yaw in yr:
        for pitch in pr:
            for roll in rr:
                v = iou(silhouette(pts, rot_matrix(yaw, pitch, roll)), target)
                if v > best[0]:
                    best = (v, yaw, pitch, roll)
    return best


def main():
    src_dir, out_npz = sys.argv[1], sys.argv[2]
    kind = sys.argv[3] if len(sys.argv) > 3 else "mobius"
    if kind == "trefoil":
        grid = [(10.0, 12.0), (15.0, 17.0), (20.0, 22.0), (25.0, 28.0)]
        factory = lambda a, b: trefoil_points(n_t=320, n_v=60, s=a, w=b)
    else:
        grid = [(44.0, 14.0), (52.0, 20.0), (60.0, 26.0), (70.0, 32.0)]
        factory = lambda a, b: mobius_points(n_u=320, n_v=100, R=a, w=b)
    files = sorted(glob.glob(os.path.join(src_dir, "*.png")))
    obs = [normalize_mask(segment(f)) for f in files]
    D = np.deg2rad
    t0 = time.time()

    # ---------- 代理模型比例拟合(首帧,粗搜) ----------
    best_fit = None
    for R, w in grid:
        if True:
            pts = factory(R, w)
            v, yaw, pitch, roll = search(
                pts, obs[0],
                np.arange(0, 2 * np.pi, D(15)),
                np.arange(-np.pi / 2, np.pi / 2 + 1e-9, D(15)),
                np.arange(0, 2 * np.pi, D(30)),
            )
            print(f"  代理 R={R} w={w} -> IoU={v:.3f}  ({time.time() - t0:.0f}s)", flush=True)
            if best_fit is None or v > best_fit[0]:
                best_fit = (v, R, w, yaw, pitch, roll)
    v0, R0, w0, yaw, pitch, roll = best_fit
    print(f"选定代理 R={R0} w={w0}  首帧 IoU={v0:.3f}  ({time.time() - t0:.0f}s)", flush=True)

    pts = factory(R0, w0)
    poses = [(yaw, pitch, roll)]

    # ---------- 逐帧:宽粗搜 + 细搜 ----------
    for i in range(1, len(obs)):
        py, pp, pr0 = poses[-1]
        v, y2, p2, r2 = search(
            pts, obs[i],
            np.arange(py - D(70), py + D(70) + 1e-9, D(7)),
            np.arange(pp - D(50), pp + D(50) + 1e-9, D(7)),
            np.arange(pr0 - D(50), pr0 + D(50) + 1e-9, D(10)),
        )
        v, y3, p3, r3 = search(
            pts, obs[i],
            np.arange(y2 - D(8), y2 + D(8) + 1e-9, D(2)),
            np.arange(p2 - D(8), p2 + D(8) + 1e-9, D(2)),
            np.arange(r2 - D(10), r2 + D(10) + 1e-9, D(2.5)),
        )
        poses.append((y3, p3, r3))
        print(
            f"帧 {i:2d} IoU={v:.3f} yaw={np.rad2deg(y3):7.1f} pitch={np.rad2deg(p3):6.1f} "
            f"roll={np.rad2deg(r3):6.1f}  ({time.time() - t0:.0f}s)",
            flush=True,
        )

    np.savez(out_npz, poses=np.array(poses), obs=np.array(obs), proxy=np.array([R0, w0]))
    print("已保存:", out_npz, flush=True)


if __name__ == "__main__":
    main()
