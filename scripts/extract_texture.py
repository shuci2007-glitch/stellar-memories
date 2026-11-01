"""
从视频原帧提取带面纹理。

思路:带面上的每个点 (u,v) 都知道自己在物体坐标系里的位置,
每帧又有估计好的位姿 —— 于是可以把它投影回那一帧的原图像素上取色。
多帧取平均,得到 (u,v) 域里的一张纹理图。

输出:
  - <kind>_tex.png    纹理图(带宽 × 环向)
  - <kind>_tex.npz    颜色数组 + 覆盖率 + 拟合参数
"""
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from estimate_pose import mobius_points, trefoil_points, rot_matrix, segment  # noqa: E402


def mobius_surface(n_u=256, n_v=48, R=58.0, w=24.0):
    """返回 (u,v) 网格上的点与法线"""
    u = (np.arange(n_u) / n_u) * 2 * np.pi
    v = np.linspace(-1, 1, n_v)
    U, V = np.meshgrid(u, v, indexing="ij")
    rr = R + V * w * np.cos(U * 0.5)
    P = np.stack([rr * np.cos(U), V * w * np.sin(U * 0.5), rr * np.sin(U)], axis=-1)

    def surf(du, dv):
        uu = (U + du) % (2 * np.pi)
        vv = np.clip(V + dv, -1, 1)
        r2 = R + vv * w * np.cos(uu * 0.5)
        return np.stack(
            [r2 * np.cos(uu), vv * w * np.sin(uu * 0.5), r2 * np.sin(uu)], axis=-1
        )

    du = surf(1e-3, 0) - surf(-1e-3, 0)
    dv = surf(0, 1e-3) - surf(0, -1e-3)
    N = np.cross(du, dv)
    N /= np.linalg.norm(N, axis=-1, keepdims=True) + 1e-9
    return U, V, P, N


def trefoil_surface(n_t=256, n_v=48, s=15.0, w=17.0):
    """三叶纽结上的绸带表面:返回 (t,v) 网格上的点与法线"""
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
    p0 = center(T - h)
    p1 = center(T + h)
    tang = p1 - p0
    tang /= np.linalg.norm(tang, axis=-1, keepdims=True) + 1e-9
    acc = p1 - 2 * c + p0
    acc -= (acc * tang).sum(-1, keepdims=True) * tang
    acc /= np.linalg.norm(acc, axis=-1, keepdims=True) + 1e-9
    P = c + V[..., None] * w * acc

    # 法线:沿 t 用周期性中心差分,沿 v 用中心差分
    Pu = (np.roll(P, -1, axis=0) - np.roll(P, 1, axis=0)) * 0.5
    Pv = np.empty_like(P)
    Pv[:, 1:-1] = (P[:, 2:] - P[:, :-2]) * 0.5
    Pv[:, 0] = P[:, 1] - P[:, 0]
    Pv[:, -1] = P[:, -1] - P[:, -2]
    N = np.cross(Pu, Pv)
    N /= np.linalg.norm(N, axis=-1, keepdims=True) + 1e-9
    return T, V, P, N


def main():
    frames_dir, poses_npz, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    kind = sys.argv[4] if len(sys.argv) > 4 else "mobius"
    data = np.load(poses_npz)
    poses = data["poses"]
    proxy = data["proxy"] if "proxy" in data else np.array([58.0, 24.0])
    R0, w0 = float(proxy[0]), float(proxy[1])
    files = sorted(glob.glob(os.path.join(frames_dir, "*.png")))

    if kind == "trefoil":
        U, V, P, N = trefoil_surface(n_t=256, n_v=48, s=R0, w=w0)
        # 代理模型的投影尺寸 → 换算每帧的像素尺度
        proxy_pts = trefoil_points(n_t=320, n_v=60, s=R0, w=w0)
    else:
        U, V, P, N = mobius_surface(R=R0, w=w0)
        proxy_pts = mobius_points(n_u=320, n_v=100, R=R0, w=w0)
    samples = [[] for _ in range(P.shape[0] * P.shape[1])]   # 每个采样点收各帧颜色

    for k, f in enumerate(files):
        im = Image.open(f).convert("RGB")
        rgb = np.asarray(im, np.float32) / 255.0
        m = segment(f)
        ys, xs = np.nonzero(m)
        if len(xs) == 0:
            continue
        cx, cy = xs.mean(), ys.mean()
        obs_size = max(xs.max() - xs.min() + 1, ys.max() - ys.min() + 1)
        Rm = rot_matrix(*poses[k])
        q = proxy_pts @ Rm.T
        span = max(np.ptp(q[:, 0]), np.ptp(q[:, 1]))
        s = obs_size / max(span, 1e-6)

        pc = P.reshape(-1, 3) @ Rm.T
        nc = (N.reshape(-1, 3) @ Rm.T)[:, 2]
        px = np.round(cx + pc[:, 0] * s).astype(int)
        py = np.round(cy - pc[:, 1] * s).astype(int)
        h, w = m.shape
        ok = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        ok &= nc > 0.02                      # 只取正面朝向的点
        idx = np.nonzero(ok)[0]
        if len(idx) == 0:
            continue
        inside = m[py[idx], px[idx]]
        idx = idx[inside]
        if len(idx) == 0:
            continue
        cols = rgb[py[idx], px[idx]]
        for n, ci in enumerate(idx):
            samples[int(ci)].append(cols[n])

    # 逐点取中位数:位姿有噪声时,均值会把肋骨条纹抹平,中位数不会
    color = np.zeros(P.shape, np.float64)
    good = np.zeros(P.shape[:2], bool)
    flat = color.reshape(-1, 3)
    flat_good = good.reshape(-1)
    for i, lst in enumerate(samples):
        if not lst:
            continue
        flat[i] = np.median(np.asarray(lst), axis=0)
        flat_good[i] = True

    # 没被任何帧看到的点:逐列沿 v 方向线性插值(比二维最近邻平滑,不会出块状台阶)
    nu, nv = P.shape[0], P.shape[1]
    empty_cols = []
    for j in range(nv):
        idx = np.arange(nu)
        vis = good[:, j]
        if not vis.any():
            empty_cols.append(j)
            continue
        for c in range(3):
            color[~vis, j, c] = np.interp(idx[~vis], idx[vis], color[vis, j, c])
    # 整列都没有可见数据的:从最近的非空列复制一份
    for j in empty_cols:
        src = next((jj for jj in range(nv) if jj not in empty_cols), None)
        if src is not None:
            color[:, j] = color[:, src]
    good[:] = True
    # 逐列(u 方向)做对比度归一:视频里带子受光不均,不归一的话肋骨条纹会糊成一片。
    # 但列与列之间必须平滑过渡,否则会在列边界出现台阶状接缝、把肋骨条纹切成一块块。
    from scipy.ndimage import gaussian_filter1d
    lum = color @ np.array([0.299, 0.587, 0.114])
    los = np.array([lum[:, j].min() for j in range(color.shape[1])])
    his = np.array([lum[:, j].max() for j in range(color.shape[1])])
    los = gaussian_filter1d(los, 12)   # 跨列平滑,去掉接缝
    his = gaussian_filter1d(his, 12)
    for j in range(color.shape[1]):
        lo, hi = los[j], his[j]
        if hi - lo < 1e-4:
            continue
        col = lum[:, j]
        target = (col - lo) / (hi - lo)
        scale = np.where(col > 1e-4, target * 0.95 + 0.15, 1.0) / np.maximum(col, 1e-4)
        color[:, j] *= scale[:, None]
    color = np.clip(color, 0, 1)

    # 轻度平滑:逐帧取色会有单帧错位造成的台阶/块状伪影。
    # 肋骨条纹是沿 u(环向/纽结向)走的长条,所以沿 u 用很小的高斯(sigma≈1)只抹平台阶,
    # 沿 v(带宽)稍大一点让跨带过渡更顺。不会把条纹抹没。
    if os.environ.get("TEX_SMOOTH", "1") != "0":
        sigma_u = float(os.environ.get("TEX_SU", "1.0"))
        sigma_v = float(os.environ.get("TEX_SV", "0.8"))
        from scipy.ndimage import gaussian_filter
        for c in range(3):
            color[:, :, c] = gaussian_filter(color[:, :, c], sigma=(sigma_u, sigma_v))

    print(f"纹理覆盖: {good.mean():.1%}  参数 R={R0} w={w0}", flush=True)

    os.makedirs(out_dir, exist_ok=True)
    tex = np.clip(color, 0, 1)
    img = Image.fromarray((tex * 255).astype(np.uint8))
    img = img.transpose(Image.FLIP_TOP_BOTTOM)   # v 轴方向与贴图一致
    img.save(os.path.join(out_dir, f"{kind}_tex.png"))
    np.savez(
        os.path.join(out_dir, f"{kind}_tex.npz"),
        tex=tex,
        R=R0,
        w=w0,
        coverage=good.mean(),
    )
    print("已写出纹理:", os.path.join(out_dir, f"{kind}_tex.png"), flush=True)


if __name__ == "__main__":
    main()
