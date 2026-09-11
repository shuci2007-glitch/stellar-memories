import * as THREE from "three";
import type { PhotoParticleSphere } from "./PhotoParticleSphere";

/** Transition-only adapter. At progress 1 the destination shader is unchanged. */
export class SpherePhotoBridge {
  progress = 0;
  closing = false;
  ready = false;
  private started = false;
  private ended = false;
  private formed = false;
  private uniforms = { uSphereBridge: { value: 0 }, uBridgeRect: { value: new THREE.Vector4(1, 1, 0, 0) } };
  private positions: Float32Array;
  private colors: Float32Array;
  private planeProjection: THREE.Matrix4 | null = null;
  private sourceRect?: DOMRect;
  private sourcePlaneHeight = 1;
  constructor(readonly id: number, readonly sphere: PhotoParticleSphere, camera: THREE.Camera,
    private onFormed: () => void, private onClosed: () => void, sourceRect?: DOMRect) {
    sphere.points.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    const source = sphere.points.geometry.getAttribute("position");
    const normals = sphere.points.geometry.getAttribute("aNormal");
    const curvature = Number(sphere.points.material.uniforms.uCurvature.value);
    const planeHeight = Number(sphere.points.material.uniforms.uPlaneHeight.value);
    if(curvature < .001) {
      this.planeProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(sphere.points.matrixWorld);
      this.sourceRect = sourceRect; this.sourcePlaneHeight = planeHeight;
    }
    this.positions = new Float32Array(source.count * 3);
    this.colors = (sphere.points.geometry.getAttribute("aColor").array as Float32Array).slice();
    const v = new THREE.Vector3();
    for (let i = 0; i < source.count; i++) {
      v.fromBufferAttribute(source, i);
      v.lerp(new THREE.Vector3(normals.getX(i)*2.21,normals.getY(i)*planeHeight*.5,0),1-curvature);
      v.applyMatrix4(sphere.points.matrixWorld).project(camera);
      if (sourceRect) {
        v.x = ((v.x + 1) * .5 * sourceRect.width + sourceRect.left) / window.innerWidth * 2 - 1;
        v.y = 1 - ((1 - v.y) * .5 * sourceRect.height + sourceRect.top) / window.innerHeight * 2;
      }
      v.toArray(this.positions, i * 3);
    }
  }
  get fromPlane() { return this.planeProjection !== null; }

  installPhoto(mesh: THREE.Mesh<THREE.PlaneGeometry,THREE.ShaderMaterial>) {
    if(!this.planeProjection)return;
    const r=this.sourceRect;
    Object.assign(mesh.material.uniforms,{uPhotoBridge:this.uniforms.uSphereBridge,uSourceProjection:{value:this.planeProjection},uSourceRect:{value:r?new THREE.Vector4(r.width/window.innerWidth,r.height/window.innerHeight,(r.left+r.width/2)/window.innerWidth*2-1,1-(r.top+r.height/2)/window.innerHeight*2):new THREE.Vector4(1,1,0,0)}});
    const shader=mesh.material.vertexShader,end=shader.lastIndexOf("}");
    mesh.material.vertexShader="uniform float uPhotoBridge; uniform mat4 uSourceProjection; uniform vec4 uSourceRect;\n"+shader.slice(0,end)+"vec4 start=uSourceProjection*vec4(position.xy,0.,1.); vec3 origin=start.xyz/start.w; origin.xy=origin.xy*uSourceRect.xy+uSourceRect.zw; gl_Position=vec4(mix(origin,gl_Position.xyz/gl_Position.w,uPhotoBridge),1.);}";
    mesh.material.needsUpdate=true;
  }

  install(points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>) {
    const count = points.geometry.getAttribute("position").count;
    const sourceCount = this.positions.length / 3;
    const position = new Float32Array(count * 3), color = new Float32Array(count * 3);
    const plane = points.geometry.getAttribute("aPlane");
    const uv = points.geometry.getAttribute("aTarget");
    const destinationColors=points.geometry.getAttribute("aColor");
    for (let i = 0; i < count; i++) {
      const j = Math.floor(i * sourceCount / count) * 3;
      position.set(this.positions.subarray(j, j + 3), i * 3);
      color.set(this.colors.subarray(j, j + 3), i * 3);
      // 平面照片以同一照片坐标对应目标粒子，避免按数组序号交叉飞行、重组。
      if(this.planeProjection && (plane||uv)) {
        const v=new THREE.Vector3(plane?plane.getX(i):(uv.getX(i)-.5)*4.42,plane?plane.getY(i):(.5-uv.getY(i))*this.sourcePlaneHeight,0).applyMatrix4(this.planeProjection);
        if(this.sourceRect){const r=this.sourceRect;v.x=((v.x+1)*.5*r.width+r.left)/window.innerWidth*2-1;v.y=1-((1-v.y)*.5*r.height+r.top)/window.innerHeight*2;}
        v.toArray(position,i*3);
        color[i*3]=destinationColors.getX(i);color[i*3+1]=destinationColors.getY(i);color[i*3+2]=destinationColors.getZ(i);
      }
    }
    points.geometry.setAttribute("aBridgePosition", new THREE.BufferAttribute(position, 3));
    points.geometry.setAttribute("aBridgeColor", new THREE.BufferAttribute(color, 3));
    const material = points.material;
    Object.assign(material.uniforms, this.uniforms);
    const end = material.vertexShader.lastIndexOf("}");
    material.vertexShader = `attribute vec3 aBridgePosition; attribute vec3 aBridgeColor;
      uniform float uSphereBridge; uniform vec4 uBridgeRect;
` + material.vertexShader.slice(0, end) + `
      vec3 destination = gl_Position.xyz / gl_Position.w;
      destination.xy = destination.xy * uBridgeRect.xy + uBridgeRect.zw;
      gl_Position = vec4(mix(aBridgePosition, destination, uSphereBridge), 1.);
      vColor = mix(aBridgeColor, vColor, uSphereBridge);
      ${this.fromPlane ? "" : "vAlpha = mix(.55, vAlpha, uSphereBridge);"}
    }`;
    material.needsUpdate = true;
    points.frustumCulled = false;
  }
  setRect(rect: DOMRect, width: number, height: number) {
    this.uniforms.uBridgeRect.value.set(rect.width / width, rect.height / height,
      (rect.left + rect.width / 2) / width * 2 - 1, 1 - (rect.top + rect.height / 2) / height * 2);
  }
  tick(dt: number) {
    if (!this.ready || this.ended) return;
    if (!this.started) { this.started = true; this.sphere.points.visible = false; }
    this.progress = THREE.MathUtils.clamp(this.progress + dt / 1.1 * (this.closing ? -1 : 1), 0, 1);
    const p = this.progress;
    this.uniforms.uSphereBridge.value = p*p*p*(p*(p*6-15)+10);
    if (p === 1 && !this.formed) { this.formed = true; this.onFormed(); }
    if (p === 0 && this.closing) { this.ended = true; this.sphere.points.visible = true; this.onClosed(); }
  }
  close() { this.closing = true; if (!this.ready) this.finish(); }
  finish() {
    if (this.ended) return;
    this.ended = true; this.sphere.points.visible = true; this.onClosed();
  }
}
const bridges = new Map<number, SpherePhotoBridge>();
export function setSpherePhotoBridge(id: number, bridge: SpherePhotoBridge) { bridges.set(id, bridge); }
export function getSpherePhotoBridge(id: number) { return bridges.get(id); }
export function clearSpherePhotoBridge(id: number) { bridges.delete(id); }
