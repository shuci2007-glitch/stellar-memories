"""
视频里主体形状的运动分析:
逐帧分割 → 统计面积/质心/包围盒 → 输出掩膜蒙太奇图。
先搞清楚它是怎么转的,再决定重建策略。
"""
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def segment(path, thresh=150):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    lum = a.max(axis=2)
    mask = lum > thresh
    h, w = mask.shape
    mask[:, : int(w * 0.20)] = False
    mask[:, int(w * 0.90):] = False
    mask[int(h * 0.88):, :] = False
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask, 0
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    big = int(np.argmax(sizes)) + 1
    return (lab == big), int(sizes[big - 1])


def main():
    src_dir = sys.argv[1]
    out_png = sys.argv[2]
    files = sorted(glob.glob(os.path.join(src_dir, "*.png")))
    masks = []
    print(f"{len(files)} 帧")
    for i, f in enumerate(files):
        m, area = segment(f)
        ys, xs = np.nonzero(m)
        if len(xs) == 0:
            print(f"{i:3d} 空掩膜")
            masks.append(m)
            continue
        print(
            f"{i:3d} 面积={area:6d} 质心=({xs.mean():6.1f},{ys.mean():6.1f}) "
            f"包围盒 x[{xs.min():4d},{xs.max():4d}] y[{ys.min():4d},{ys.max():4d}] "
            f"宽高比={(xs.max()-xs.min())/max(1,(ys.max()-ys.min())):.2f}"
        )
        masks.append(m)

    # 拼蒙太奇:每行 6 帧
    cols = 6
    rows = (len(masks) + cols - 1) // cols
    th, tw = 200, 340
    canvas = Image.new("RGB", (cols * tw, rows * th), (10, 10, 14))
    for i, m in enumerate(masks):
        im = Image.fromarray((m * 255).astype(np.uint8)).resize((tw, th))
        canvas.paste(im.convert("RGB"), ((i % cols) * tw, (i // cols) * th))
    canvas.save(out_png)
    print("蒙太奇:", out_png)


if __name__ == "__main__":
    main()
