import * as THREE from "three";
import { tmThumb } from "../core/types";

/** 缩略图纹理 LRU 池:离开范围即 dispose,防 GPU 泄漏 */
export class TexturePool {
  private generation=0;
  private cache = new Map<number, THREE.Texture>();
  private pending = new Set<number>();
  constructor(private max = 150) {}

  get(id: number): THREE.Texture | null {
    const hit = this.cache.get(id);
    if (hit) {
      // LRU touch
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    if (this.pending.has(id)) return null;
    this.pending.add(id);
    const generation=this.generation;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if(generation!==this.generation) return;
      this.pending.delete(id);
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      this.cache.set(id, tex);
      if (this.cache.size > this.max) {
        const first = this.cache.keys().next().value;
        if (first !== undefined) {
          const old = this.cache.get(first);
          old?.dispose();
          this.cache.delete(first);
        }
      }
    };
    img.onerror = () => {
      this.pending.delete(id);
    };
    img.src = tmThumb(id);
    return null;
  }

  clear() {
    this.generation++; this.pending.clear();
    for (const t of this.cache.values()) t.dispose();
    this.cache.clear();
  }
}
