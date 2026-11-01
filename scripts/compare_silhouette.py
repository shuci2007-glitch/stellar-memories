"""
诊断:把代理模型在拟合位姿下的轮廓(红)和视频观测轮廓(绿)叠在一起。
IoU 上不去时,看一眼就知道是比例不对、还是模型太薄、还是掩膜把辉光算进去了。
"""
import glob
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from estimate_pose import mobius_points, rot_matrix, segment, normalize_mask, TARGET  # noqa: E402


def model_silhouette(pts, R):
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


def main():
    frames_dir, poses_npz, out_png = sys.argv[1], sys.argv[2], sys.argv[3]
    data = np.load(poses_npz)
    poses = data["poses"]
    proxy = data["proxy"] if "proxy" in data else np.array([58.0, 24.0])
    files = sorted(glob.glob(os.path.join(frames_dir, "*.png")))
    pts = mobius_points(R=float(proxy[0]), w=float(proxy[1]))

    pick = list(range(0, len(files), max(1, len(files) // 8)))[:8]
    cols = 4
    rows = (len(pick) + cols - 1) // cols
    canvas = Image.new("RGB", (cols * TARGET, rows * TARGET), (8, 8, 12))
    for n, i in enumerate(pick):
        obs = normalize_mask(segment(files[i]))
        sil = model_silhouette(pts, rot_matrix(*poses[i]))
        rgb = np.zeros((TARGET, TARGET, 3), np.uint8)
        rgb[obs] = (40, 200, 90)          # 绿 = 观测
        rgb[sil & ~obs] = (230, 60, 60)   # 红 = 模型多出来的
        rgb[sil & obs] = (220, 220, 120)  # 黄 = 重合
        canvas.paste(Image.fromarray(rgb), ((n % cols) * TARGET, (n // cols) * TARGET))
    canvas = canvas.resize((cols * TARGET * 2, rows * TARGET * 2), Image.NEAREST)
    canvas.save(out_png)
    print("已保存:", out_png, " 代理参数:", proxy)


if __name__ == "__main__":
    main()
