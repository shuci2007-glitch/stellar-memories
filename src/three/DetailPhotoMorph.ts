import * as THREE from "three";

/** One spatial transition mask shared by the photograph and its particles. */
export class DetailPhotoMorph {
  private readonly size = 128;
  private readonly values = new Float32Array(this.size * this.size);
  private readonly from = new Float32Array(this.values.length);
  private readonly coverage = new Float32Array(this.values.length).fill(1);
  private readonly fromCoverage = new Float32Array(this.values.length).fill(1);
  private readonly pixels = new Uint8Array(this.values.length * 4);
  private elapsed = 0;
  private target = false;
  private moving = false;
  readonly texture = new THREE.DataTexture(this.pixels, this.size, this.size, THREE.RGBAFormat);

  constructor() {
    for(let i=0;i<this.values.length;i++){this.pixels[i*4+1]=255;this.pixels[i*4+3]=255;}
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  setTarget(particle: boolean) {
    if (particle === this.target) return;
    this.from.set(this.values); // Reversals begin from the current visible mask.
    this.fromCoverage.set(this.coverage);
    this.target = particle;
    this.elapsed = 0;
    this.moving = true;
  }

  update(dt: number, aspect: number) {
    if (!this.moving) return;
    this.elapsed += dt;
    const diagonal = Math.hypot(aspect, 1);
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      const i = y * this.size + x;
      const radius = Math.hypot((x / (this.size - 1) * 2 - 1) * aspect, y / (this.size - 1) * 2 - 1) / diagonal;
      const t = THREE.MathUtils.smootherstep(this.elapsed - radius * 0.72, 0, 0.38);
      const value = this.from[i] + ((this.target ? 1 : 0) - this.from[i]) * t;
      this.values[i] = value;
      this.pixels[i * 4] = Math.round(value * 255);
      // Green: the silhouette closes from the outside in, independently of the
      // red channel's center-out particle wave, but on the same clock.
      const ellipseRadius=Math.hypot(x/(this.size-1)*2-1,y/(this.size-1)*2-1);
      const feather=1-THREE.MathUtils.smoothstep(ellipseRadius,.88,1);
      const shapeDelay=(1-Math.min(1,ellipseRadius/Math.SQRT2))*.72;
      const shapeT=THREE.MathUtils.smootherstep(this.elapsed-shapeDelay,0,.38);
      this.coverage[i]=THREE.MathUtils.lerp(this.fromCoverage[i],this.target?feather:1,shapeT);
      this.pixels[i*4+1]=Math.round(this.coverage[i]*255);
      this.pixels[i * 4 + 3] = 255;
    }
    this.texture.needsUpdate = true;
    this.moving = this.elapsed < 1.1;
  }

  /** Opening enlargement and spatial dissolve share the host animation clock. */
  seekOpening(progress: number, aspect: number) {
    this.target = true;
    this.from.fill(0);
    this.fromCoverage.fill(1);
    this.elapsed = THREE.MathUtils.clamp(progress,0,1)*1.1;
    this.moving = true;
    this.update(0,aspect);
  }

  dispose() { this.texture.dispose(); }
  /** Same local dissolve and elliptical feather for the immediate thumbnail. */
  previewAlpha(output: Uint8ClampedArray) {
    for(let y=0;y<this.size;y++)for(let x=0;x<this.size;x++){
      const i=y*this.size+x,local=this.values[i];
      const dot=(x%2===0&&y%2===0)?0.88:0.06;
      output[i*4+3]=Math.round(255*this.coverage[i]*((1-local)+local*dot));
    }
  }
}

export function detailPhotoMaterial(photo: THREE.Texture, mask: THREE.Texture) {
  return new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { uPhoto: { value: photo }, uReveal: { value: mask } },
    vertexShader: `varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform sampler2D uPhoto; uniform sampler2D uReveal; varying vec2 vUv;
      void main(){ vec4 color=texture2D(uPhoto,vUv); vec2 reveal=texture2D(uReveal,vUv).rg;
        gl_FragColor=vec4(color.rgb,color.a*(1.-reveal.r)*reveal.g);
        #include <colorspace_fragment>
      }`,
  });
}
