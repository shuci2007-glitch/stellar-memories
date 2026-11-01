"""
从视频帧里把主体形状抠出来（分割实验）。

思路:主体是深色背景上的高亮发光体(白/金),用亮度阈值 + 连通域取最大块。
先用一张帧调参数,把掩膜存成 PNG 人工检查。
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage


def load_mask(path, thresh=150, min_ratio=0.02):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    lum = a.max(axis=2)                       # 取三通道最大值,发光体一定很亮
    mask = lum > thresh
    # 去掉左右两侧的 UI 面板和底部字幕:只保留中间主体区
    h, w = mask.shape
    mask[:, : int(w * 0.20)] = False
    mask[:, int(w * 0.90) :] = False
    mask[int(h * 0.88) :, :] = False
    # 取最大连通块
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask, 0
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    big = int(np.argmax(sizes)) + 1
    if sizes[big - 1] < mask.size * min_ratio:
        return mask, 0
    return lab == big, int(sizes[big - 1])


if __name__ == "__main__":
    src = sys.argv[1]
    out = sys.argv[2]
    th = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    im = Image.open(src).convert("RGB")
    mask, area = load_mask(src, th)
    vis = np.asarray(im).copy()
    vis[~mask] = (vis[~mask] * 0.25).astype(np.uint8)
    Image.fromarray(vis).save(out)
    print(f"阈值={th} 掩膜像素={area} 占比={area / mask.size:.3%}")
