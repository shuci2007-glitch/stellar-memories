import {loadMapAsset} from '../core/mapAssets';
import { earthSun } from "../core/earthSun";
import * as THREE from "three";

/**
 * 外层空间地球表征:离线国界线 + 经纬网 + 记忆坐标光点 + 大气轮廓。
 * 颜色与 MapView 的 maplibre 暗色样式对齐(water #0b1220 / land #28324a / line #5a6a86),
 * 使镜头交接时的交叉淡入不露换页痕迹。地球本地坐标:Y=北,球面点由 latLngToVector 定义。
 */

export function latLngToVector(lat: number, lng: number, radius = 1, out = new THREE.Vector3()): THREE.Vector3 {
  const la = THREE.MathUtils.degToRad(lat), lo = THREE.MathUtils.degToRad(lng);
  return out.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).multiplyScalar(radius);
}

const OCEAN = new THREE.Color("#0b1220");
const BORDER = new THREE.Color("#5a6a86");
const LAND_TINT = new THREE.Color("#28324a");
const ATMOS = new THREE.Color("#2c4a72");

export class EarthGlobe {
  readonly group = new THREE.Group();
  readonly radius: number;
  private ocean: THREE.Mesh;
  private land: THREE.Mesh | null = null;
  private borders: THREE.LineSegments | null = null;
  private graticule: THREE.LineSegments;
  private dots: THREE.Points | null = null;
  private atmosphere: THREE.Mesh;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  private opacity = 1;
  private surface: THREE.ShaderMaterial | null = null;
  private textures: THREE.Texture[] = [];
  private disposed = false;
  ready = false;

  constructor(radius = 46) {
    this.radius = radius;
    // 暗色海洋球体:接近平反光的深蓝,给国界线一个实体背景
    const oceanGeo = new THREE.SphereGeometry(radius, 64, 48);
    const oceanMat = new THREE.MeshBasicMaterial({ color: OCEAN, transparent: true });
    this.ocean = new THREE.Mesh(oceanGeo, oceanMat);
    this.group.add(this.ocean);
    this.disposables.push(oceanGeo, oceanMat);

    // 经纬网:每 30° 一圈,极淡
    const gpos: number[] = [];
    for (let lng = -180; lng < 180; lng += 30) {
      for (let lat = -80; lat < 80; lat += 4) {
        const a = latLngToVector(lat, lng, radius * 1.002);
        const b = latLngToVector(lat + 4, lng, radius * 1.002);
        gpos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      for (let lng = -180; lng < 180; lng += 4) {
        const a = latLngToVector(lat, lng, radius * 1.002);
        const b = latLngToVector(lat, lng + 4, radius * 1.002);
        gpos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute("position", new THREE.Float32BufferAttribute(gpos, 3));
    const gMat = new THREE.LineBasicMaterial({ color: LAND_TINT, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false });
    this.graticule = new THREE.LineSegments(gGeo, gMat);
    this.group.add(this.graticule);
    this.disposables.push(gGeo, gMat);

    // 大气轮廓:背面渲染的菲涅尔壳,只在边缘发亮
    const atmoGeo = new THREE.SphereGeometry(radius * 1.055, 64, 48);
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: ATMOS }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vNormal; varying vec3 vView;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); vNormal = normalize(normalMatrix * normal); vView = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uOpacity; varying vec3 vNormal; varying vec3 vView;
        void main(){ float rim = pow(1.0 - abs(dot(vNormal, vView)), 2.6); gl_FragColor = vec4(uColor * rim * 1.15, rim * 0.85 * uOpacity); }`,
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
    this.atmosphere.renderOrder = 6;
    this.group.add(this.atmosphere);
    this.disposables.push(atmoGeo, atmoMat);
    void this.loadSurface();
  }

  private async loadSurface() {
    const loader=new THREE.TextureLoader();
    const textures=await Promise.allSettled(["earth_day_4096.jpg","earth_night_4096.jpg","earth_bump_roughness_clouds_4096.jpg"].map(name=>loader.loadAsync(`/maps/earth/${name}`)));
    const loaded=textures.flatMap(result=>result.status==="fulfilled"?[result.value]:[]);
    if(this.disposed||loaded.length!==3){for(const texture of loaded)texture.dispose();return;}
    this.textures=loaded;
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:true,uniforms:{uDay:{value:loaded[0]},uNight:{value:loaded[1]},uRelief:{value:loaded[2]},uSun:{value:new THREE.Vector3().fromArray(earthSun())},uOpacity:{value:this.opacity}},
      vertexShader:`varying vec3 vLocal;void main(){vLocal=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`precision highp float;
        uniform sampler2D uDay,uNight,uRelief;uniform vec3 uSun;uniform float uOpacity;varying vec3 vLocal;
        void main(){
          vec3 n=normalize(vLocal);
          vec2 uv=vec2(atan(-n.z,n.x)/6.28318530718+.5,asin(n.y)/3.14159265359+.5);
          float cosine=dot(n,uSun),day=smoothstep(-.12,.12,cosine),night=1.-smoothstep(-.16,.02,cosine);
          float h=texture2D(uRelief,uv).r;
          float slope=texture2D(uRelief,uv+vec2(-1./4096.,0.)).r+texture2D(uRelief,uv+vec2(0.,1./2048.)).r-2.*h;
          float relief=clamp(1.+slope*1.02,.7,1.18);
          vec3 color=texture2D(uDay,uv).rgb*(.12+day*(.45+.43*sqrt(max(0.,cosine))))*relief+texture2D(uNight,uv).rgb*night*1.1;
          gl_FragColor=vec4(color,uOpacity);
        }`});
    this.surface=material;this.ocean.material=material;this.disposables.push(material);
    if(this.land)this.land.visible=false;
    this.graticule.visible=false;
  }

  /** 拉取离线国界并生成球面线段;失败时地球仍有球体/网格/大气,旅程不会黑屏 */
  async loadBorders(): Promise<boolean> {
    try {
      const data = (await loadMapAsset("earth-boundaries")) as { features: { geometry: { type: string; coordinates: unknown } }[] };
      const pos: number[] = [];
      const fillPos: number[] = [];
      const r = this.radius * 1.004;
      const pushBorder = (ring: number[][]) => {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = latLngToVector(ring[i][1], ring[i][0], r);
          const b = latLngToVector(ring[i + 1][1], ring[i + 1][0], r);
          pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      };
      const unwrapRing = (ring: number[][]) => {
        const result: THREE.Vector2[] = [];
        let previous = ring[0]?.[0] ?? 0;
        for (let i = 0; i < Math.max(0, ring.length - 1); i++) {
          let lng = ring[i][0];
          while (lng - previous > 180) lng -= 360;
          while (lng - previous < -180) lng += 360;
          result.push(new THREE.Vector2(lng, ring[i][1])); previous = lng;
        }
        return result;
      };
      const pushLand = (rings: number[][][]) => {
        if (!rings.length || rings[0].length < 4) return;
        const contour = unwrapRing(rings[0]);
        const holes = rings.slice(1).filter((ring) => ring.length >= 4).map(unwrapRing);
        const vertices = contour.concat(...holes);
        const triangles = THREE.ShapeUtils.triangulateShape(contour, holes);
        for (const triangle of triangles) {
          for (const index of triangle) {
            const p = vertices[index];
            const v = latLngToVector(p.y, p.x, this.radius * 1.0015);
            fillPos.push(v.x, v.y, v.z);
          }
        }
      };
      for (const f of data.features) {
        const g = f.geometry;
        if (g.type === "Polygon") {
          const polygon = g.coordinates as number[][][];
          polygon.forEach(pushBorder); pushLand(polygon);
        } else if (g.type === "MultiPolygon") {
          (g.coordinates as number[][][][]).forEach((polygon) => { polygon.forEach(pushBorder); pushLand(polygon); });
        }
      }
      const landGeo = new THREE.BufferGeometry();
      landGeo.setAttribute("position", new THREE.Float32BufferAttribute(fillPos, 3));
      const landMat = new THREE.MeshBasicMaterial({ color: LAND_TINT, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
      this.land = new THREE.Mesh(landGeo, landMat);
      this.land.renderOrder = 1;
      this.land.visible = !this.surface;
      this.group.add(this.land);
      this.disposables.push(landGeo, landMat);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({ color: BORDER, transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending, depthWrite: false });
      this.borders = new THREE.LineSegments(geo, mat);
      this.borders.renderOrder = 2;
      this.group.add(this.borders);
      this.disposables.push(geo, mat);
      this.setOpacity(this.opacity);
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  /** 记忆坐标:有 GPS 的照片在球面上的暖色光点 */
  setMemoryDots(points: { lat: number; lng: number }[]) {
    if (this.dots) {
      this.group.remove(this.dots);
      this.dots.geometry.dispose();
      (this.dots.material as THREE.Material).dispose();
      this.dots = null;
    }
    if (!points.length) return;
    const pos = new Float32Array(points.length * 3);
    const seed = new Float32Array(points.length);
    points.forEach((p, i) => {
      const v = latLngToVector(p.lat, p.lng, this.radius * 1.012);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      seed[i] = i;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: Math.min(devicePixelRatio, 2) }, uOpacity: { value: this.opacity } },
      vertexShader: /* glsl */ `
        attribute float aSeed; uniform float uTime; uniform float uPixelRatio; uniform float uOpacity; varying float vA;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.);
          float pulse = .72 + .28 * sin(uTime * 1.7 + aSeed * 1.93);
          gl_PointSize = uPixelRatio * 5.2 * pulse * clamp(150.0 / max(1.0, -mv.z), .5, 2.4);
          gl_Position = projectionMatrix * mv; vA = pulse * uOpacity; }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main(){ vec2 uv = gl_PointCoord - .5; float r = length(uv); if(r > .5) discard;
          float core = 1.0 - smoothstep(.0, .34, r); float halo = exp(-r * r * 10.0);
          vec3 col = mix(vec3(1.0, .84, .58), vec3(1.0), core);
          gl_FragColor = vec4(col, (core * .95 + halo * .4) * vA); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dots = new THREE.Points(geo, mat);
    this.dots.renderOrder = 4;
    this.group.add(this.dots);
    this.disposables.push(geo, mat);
    this.setOpacity(this.opacity);
  }

  tick(time: number) {
    if(this.surface)this.surface.uniforms.uSun.value.fromArray(earthSun());
    if (this.dots) (this.dots.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
  }

  /**
   * 把球面 (lat,lng) 转向相机所在的世界轴，同时让当地北向与屏幕上方一致。
   * 这样相机可从任意宇宙视角沿直线进入银河，仍能与 north-up 的 MapLibre 地球重合。
   */
  setOrientation(lat: number, lng: number, facing = new THREE.Vector3(0, 0, 1), upHint = new THREE.Vector3(0, 1, 0)) {
    const la = THREE.MathUtils.degToRad(lat), lo = THREE.MathUtils.degToRad(lng);
    const p = latLngToVector(lat, lng, 1);
    const n = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), Math.cos(la), Math.sin(la) * Math.sin(lo)).normalize();
    // East, north, outward must form a right-handed rotation basis (det = +1).
    const e = new THREE.Vector3().crossVectors(n, p).normalize();
    const face = facing.clone().normalize();
    const up = upHint.clone().addScaledVector(face, -upHint.dot(face));
    if (up.lengthSq() < 1e-4) up.set(0, 1, 0).addScaledVector(face, -face.y);
    if (up.lengthSq() < 1e-4) up.set(1, 0, 0).addScaledVector(face, -face.x);
    up.normalize();
    const right = new THREE.Vector3().crossVectors(up, face).normalize();
    up.crossVectors(face, right).normalize();
    const localBasis = new THREE.Matrix4().makeBasis(e, n, p);
    const worldBasis = new THREE.Matrix4().makeBasis(right, up, face);
    const rotation = worldBasis.multiply(localBasis.invert());
    this.group.quaternion.setFromRotationMatrix(rotation).normalize();
  }

  /** 地球在银河内部随接近过程渐显，避免 visible 开关造成突然跳出。 */
  setOpacity(value: number) {
    this.opacity = THREE.MathUtils.clamp(value, 0, 1);
    const ocean = this.ocean.material as THREE.MeshBasicMaterial;
    ocean.opacity = this.opacity;
    if(this.surface)this.surface.uniforms.uOpacity.value=this.opacity;
    ocean.depthWrite = this.opacity > 0.02;
    if (this.land) (this.land.material as THREE.MeshBasicMaterial).opacity = 0.72 * this.opacity;
    (this.graticule.material as THREE.LineBasicMaterial).opacity = 0.34 * this.opacity;
    if (this.borders) (this.borders.material as THREE.LineBasicMaterial).opacity = 0.62 * this.opacity;
    ((this.atmosphere.material as THREE.ShaderMaterial).uniforms.uOpacity).value = this.opacity;
    if (this.dots) ((this.dots.material as THREE.ShaderMaterial).uniforms.uOpacity).value = this.opacity;
  }

  /** 与 maplibre 无关:本球体在给定相机/视口下的屏幕半径(px),用于交接尺寸匹配 */
  screenRadiusFor(camera: THREE.PerspectiveCamera, viewportHeightPx: number): number {
    const center = this.group.getWorldPosition(new THREE.Vector3());
    const d = camera.position.distanceTo(center);
    const r = this.radius * (this.group.getWorldScale(new THREE.Vector3()).x || 1);
    const ratio = THREE.MathUtils.clamp(r / Math.max(0.001, d), 0, 0.999);
    const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
    return (viewportHeightPx / 2 / Math.tan(halfFov)) * Math.tan(Math.asin(ratio));
  }

  dispose() {
    this.disposed=true;for(const texture of this.textures)texture.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
  }
}
