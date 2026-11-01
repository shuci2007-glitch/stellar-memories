"""
离线查看重建出来的网格:三视图(俯视/正视/斜视)渲染成 PNG,
不用开 WebGL 就能检查形状对不对。
用法:python scripts/view_mesh.py <mesh文件> <输出png>
"""
import sys, os
import numpy as np
from PIL import Image
path = sys.argv[1]; out = sys.argv[2]
with open(path, "rb") as f:
    assert f.read(5) == b"STLM1"
    nv, nf = np.frombuffer(f.read(8), np.int32)
    verts = np.frombuffer(f.read(nv*12), np.float32).reshape(nv,3)
    f.read(nv*12)          # normals
    f.read(nv*12)          # colors
    faces = np.frombuffer(f.read(nf*12), np.int32).reshape(nf,3)
print("verts", nv, "faces", nf)
V = verts - verts.mean(axis=0)
r = np.linalg.norm(V, axis=1).max()
W=H=560
img = np.zeros((H,W,3), np.uint8)
def put(x,y,c):
    if 0<=x<W and 0<=y<H: img[y,x] = np.minimum(255, img[y,x].astype(int)+c).astype(np.uint8)
views = [(1,0),(0,1),(0.7,0.5)]
for (ax,az) in views:
    pass
# 三视图:俯视(XZ) 正视(XY) 斜视
ca, sa = np.cos(np.deg2rad(35)), np.sin(np.deg2rad(35))
projs = [(V[:,0], V[:,2]), (V[:,0], V[:,1]), (V[:,0]*ca - V[:,2]*sa, V[:,1]*0.8 + (V[:,0]*sa+V[:,2]*ca)*0.45)]
for k,(a,b) in enumerate(projs):
    ox = k*(W//3) + W//6
    oy = H//2
    sc = (W//3 - 20)/(2*r)
    for i in range(len(V)):
        x = int(ox + a[i]*sc); y = int(oy - b[i]*sc)
        put(x,y,(70,110,190))
        put(x+1,y,(35,55,95))
# 网格线
for k,(a,b) in enumerate(projs):
    ox = k*(W//3) + W//6; oy = H//2; sc=(W//3-20)/(2*r)
    for tri in faces[::7]:
        for i in range(3):
            x1=int(ox+a[tri[i]]*sc); y1=int(oy-b[tri[i]]*sc)
            x2=int(ox+a[tri[(i+1)%3]]*sc); y2=int(oy-b[tri[(i+1)%3]]*sc)
            n=max(abs(x2-x1),abs(y2-y1),1)
            for t in range(n):
                put(x1+(x2-x1)*t//n, y1+(y2-y1)*t//n,(120,90,40))
Image.fromarray(img).save(out)
print("saved", out)
