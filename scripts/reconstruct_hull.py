"""
视觉外壳重建:用估计出的每帧位姿,把视频里的轮廓刻成真 3D 体积,再抽出表面。

原理(shape-from-silhouette):
  一个空间点如果在每一帧的轮廓里都"看起来在物体内部",它就属于物体。
  于是把物体坐标系里的体素逐帧投影回各帧图像,取所有帧的交集 = 视觉外壳。

输出:
  - 重建网格(位置/法线/顶点色/索引) —— 顶点色来自视频原帧,外观就是原图形
  - 表面采样点 —— 照片光点要落在这张真实表面上
"""
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from estimate_pose import mobius_points, rot_matrix, segment  # noqa: E402


def build(frames_dir, poses_npz, out_dir, kind="mobius", grid=170, bound=110.0,
          samples=1400):
    data = np.load(poses_npz)
    poses = data["poses"]
    files = sorted(glob.glob(os.path.join(frames_dir, "*.png")))

    # ---- 逐帧:原图掩膜 + 观测中心 + 观测尺寸 ----
    masks, cents, sizes = [], [], []
    for f in files:
        im = Image.open(f).convert("RGB")
        a = np.asarray(im)
        m = segment(f)
        masks.append(m)
        ys, xs = np.nonzero(m)
        cents.append((xs.mean(), ys.mean()))
        sizes.append(max(xs.max() - xs.min() + 1, ys.max() - ys.min() + 1))

    # ---- 代理模型:用来把物体坐标系的尺度换算到每帧像素 ----
    # 必须用拟合位姿时的那组 (R,w),否则换算出的像素尺度对不上,刻出来的东西会错位
    pxy = data["proxy"] if "proxy" in data else np.array([58.0, 24.0])
    proxy = mobius_points(n_u=420, n_v=90, R=float(pxy[0]), w=float(pxy[1]))
    print("使用代理参数:", pxy, flush=True)
    scales = []
    for k in range(len(files)):
        R = rot_matrix(*poses[k])
        p = proxy @ R.T
        span = max(np.ptp(p[:, 0]), np.ptp(p[:, 1]))
        scales.append(sizes[k] / max(span, 1e-6))

    # ---- 体素雕刻 ----
    # 用「被多少帧包含」代替严格交集:位姿有噪声时,严格交集会把体积掏空。
    ax = np.linspace(-bound, bound, grid)
    X, Y, Z = np.meshgrid(ax, ax, ax, indexing="ij")
    voxels = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1)
    hit_count = np.zeros(len(voxels), np.uint8)
    for k in range(len(files)):
        Rm = rot_matrix(*poses[k])
        s = scales[k]
        cx, cy = cents[k]
        chunk = 400_000
        for i in range(0, len(voxels), chunk):
            v = voxels[i:i + chunk]
            p = v @ Rm.T
            ix = np.round(cx + p[:, 0] * s).astype(int)
            iy = np.round(cy - p[:, 1] * s).astype(int)
            h, w = masks[k].shape
            inside = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
            hit = np.zeros(len(v), dtype=bool)
            if inside.any():
                hit[inside] = masks[k][iy[inside], ix[inside]]
            hit_count[i:i + chunk] += hit
        print(f"  雕刻第 {k + 1}/{len(files)} 帧", flush=True)

    frac = hit_count / len(files)
    for thr in (0.95, 0.9, 0.85, 0.8):
        n = int((frac >= thr).sum())
        print(f"  阈值 {thr:.2f} -> 体素 {n} ({n / len(voxels):.3%})", flush=True)
    thr = float(os.environ.get("HULL_THR", "0.85"))
    occ = frac >= thr
    print("采用阈值:", thr, "体素数:", int(occ.sum()), flush=True)

    vol = occ.reshape(grid, grid, grid).astype(np.float32)
    print("视觉外壳体素数:", int(occ.sum()), flush=True)

    # ---- 抽表面 ----
    from skimage import measure

    verts, faces, normals, _ = measure.marching_cubes(vol, level=0.5)
    verts = verts * (2 * bound / (grid - 1)) - bound
    verts = verts[:, ::-1].copy()  # z 轴翻转,让坐标轴与图像一致
    print("网格:", len(verts), "顶点 /", len(faces), "三角面", flush=True)

    # ---- 顶点色:挑一个正面朝向且最正对的帧取色 ----
    colors = np.zeros((len(verts), 3), np.float32)
    filled = np.zeros(len(verts), bool)
    norms = normals / (np.linalg.norm(normals, axis=1, keepdims=True) + 1e-9)
    best = np.full(len(verts), -1.0)
    frames_rgb = []
    for f in files:
        frames_rgb.append(np.asarray(Image.open(f).convert("RGB"), np.float32) / 255.0)
    for k in range(len(files)):
        R = rot_matrix(*poses[k])
        s = scales[k]
        cx, cy = cents[k]
        nk = norms @ R.T
        facing = nk[:, 2]           # 相机在 +Z,法线朝 +Z 为正面
        p = verts @ R.T
        px = np.round(cx + p[:, 0] * s).astype(int)
        py = np.round(cy - p[:, 1] * s).astype(int)
        h, w = masks[k].shape
        ok = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        good = ok & (facing > best) & (facing > 0.05)
        if good.any():
            best[good] = facing[good]
            colors[good] = frames_rgb[k][py[good], px[good]]
            filled[good] = True
    colors[~filled] = np.array([0.95, 0.88, 0.72], np.float32)
    print("顶点色覆盖率:", f"{filled.mean():.1%}", flush=True)

    # ---- 归一化到应用的世界尺度 ----
    c = verts.mean(axis=0)
    verts = verts - c
    radius = np.linalg.norm(verts, axis=1).max()
    target = 92.0
    verts = verts * (target / radius)
    colors = np.clip(colors * 1.15, 0, 1.6)

    # ---- 表面采样点(照片光点用) ----
    tri = verts[faces]
    e1 = tri[:, 1] - tri[:, 0]
    e2 = tri[:, 2] - tri[:, 0]
    area = 0.5 * np.linalg.norm(np.cross(e1, e2), axis=1)
    w = area / max(area.sum(), 1e-9)
    pick = np.random.choice(len(faces), size=samples, p=w)
    r1 = np.random.rand(samples)
    r2 = np.random.rand(samples)
    sq = np.sqrt(r1)
    pts = (
        tri[pick, 0]
        + sq[:, None] * (1 - r2)[:, None] * e1[pick]
        + sq[:, None] * r2[:, None] * e2[pick]
    ).astype(np.float32)

    os.makedirs(out_dir, exist_ok=True)
    mesh_path = os.path.join(out_dir, f"{kind}.mesh")
    with open(mesh_path, "wb") as f:
        f.write(b"STLM1")
        f.write(np.array([len(verts), len(faces)], np.int32).tobytes())
        f.write(verts.astype(np.float32).tobytes())
        f.write(normals.astype(np.float32).tobytes())
        f.write(colors.astype(np.float32).tobytes())
        f.write(faces.astype(np.int32).tobytes())
    np.save(os.path.join(out_dir, f"{kind}.samples.npy"), pts)
    print("已写出:", mesh_path, flush=True)
    print("采样点:", pts.shape, flush=True)


if __name__ == "__main__":
    build(
        sys.argv[1],
        sys.argv[2],
        sys.argv[3],
        kind=sys.argv[4] if len(sys.argv) > 4 else "mobius",
    )
