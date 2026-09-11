import * as THREE from "three";

/** 相机原地生成的时间隧道。曲线与视觉均使用局部坐标。 */
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const NEBULA_COLORS = ["#302070", "#162d74", "#50206f", "#12305d", "#58337f"];
const STREAM_COUNT = 190;

interface TunnelPhoto {
  id: number;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  ghosts: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[];
  texture: THREE.Texture | null;
  t: number;
  angle: number;
  radius: number;
  phase: number;
}

export class TimeTunnel {
  readonly group = new THREE.Group();
  readonly curve: THREE.CatmullRomCurve3;
  readonly length: number;
  private nebulae: THREE.Sprite[] = [];
  private streams: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private streamSeeds: number[][] = [];
  private photoGroup = new THREE.Group();
  private photos: TunnelPhoto[] = [];
  private time = 0;
  private readonly placeholder = new THREE.DataTexture(new Uint8Array([32,43,85,255]),1,1);
  private frames: { pos: THREE.Vector3; quat: THREE.Quaternion }[] = [];
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(
    _entrance = new THREE.Vector3(),
    _direction = new THREE.Vector3(0, 0, -1),
    _photoIds: number[] = [],
    private maxPhotos = 44,
  ) {
    const dir = new THREE.Vector3(0, 0, -1);
    this.placeholder.needsUpdate=true;
    this.placeholder.colorSpace=THREE.SRGBColorSpace;
    this.disposables.push(this.placeholder);
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3(1, 0, 0);
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const bend = THREE.MathUtils.smoothstep(t, 0.18, 1);
      const sway = bend * (Math.sin(t * Math.PI * 1.18) * 32 + Math.sin(t * Math.PI * 2.4 + 0.7) * 10);
      const lift = bend * (Math.sin(t * Math.PI * 0.82 + 0.25) * 17 - t * 9);
      points.push(
        new THREE.Vector3()
          .addScaledVector(dir, t * 620)
          .addScaledVector(side, sway)
          .addScaledVector(up, lift),
      );
    }
    this.curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.5);
    this.length = this.curve.getLength();

    const frameCount = 260;
    for (let i = 0; i <= frameCount; i++) {
      const t = i / frameCount;
      const pos = this.curve.getPointAt(t);
      const tangent = this.curve.getTangentAt(t).normalize();
      const normal = new THREE.Vector3().crossVectors(tangent, up).normalize();
      if (normal.lengthSq() < 0.1) normal.set(1, 0, 0);
      const binormal = new THREE.Vector3().crossVectors(normal, tangent).normalize();
      const basis = new THREE.Matrix4().makeBasis(normal, binormal, tangent.clone().negate());
      this.frames.push({ pos, quat: new THREE.Quaternion().setFromRotationMatrix(basis) });
    }

    const rng = mulberry32(0x7a11be);
    const glowTexture = makeNebulaTexture();
    for (let i = 0; i < 116; i++) {
      const frame = this.localFrameAt(rng());
      const angle = rng() * Math.PI * 2;
      const radius = 28 + rng() * 58;
      const offset = new THREE.Vector3(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius * 0.72,
        (rng() - 0.5) * 26,
      );
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture,
        color: new THREE.Color(NEBULA_COLORS[Math.floor(rng() * NEBULA_COLORS.length)]),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        rotation: rng() * Math.PI * 2,
      }));
      sprite.userData.baseOpacity = 0.11 + rng() * 0.13;
      sprite.position.copy(frame.pos).add(offset.applyQuaternion(frame.quat));
      sprite.scale.setScalar(54 + rng() * 108);
      this.nebulae.push(sprite);
      this.group.add(sprite);
    }
    this.disposables.push(glowTexture);

    // 有真实截面的锥形光流，替代 WebGL 固定 1px 的 LineSegments。
    const streamGeometry = new THREE.CylinderGeometry(0.06, 0.52, 1, 6, 1, true);
    const streamMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.streams = new THREE.InstancedMesh(streamGeometry, streamMaterial, STREAM_COUNT);
    this.streams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.streams.frustumCulled = false;
    for (let i = 0; i < STREAM_COUNT; i++) {
      this.streamSeeds.push([rng(), rng(), rng(), rng(), rng()]);
      const color = rng() < 0.28
        ? new THREE.Color("#f4ba68")
        : rng() < 0.56
          ? new THREE.Color("#82bfff")
          : new THREE.Color("#c6d8ff");
      this.streams.setColorAt(i, color);
    }
    this.streams.instanceColor!.needsUpdate = true;
    this.group.add(this.streams, this.photoGroup);
    this.disposables.push(streamGeometry, streamMaterial);
  }

  /** 把局部隧道入口和 -Z 方向贴到当前相机，不改相机本身。 */
  placeAt(origin: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3) {
    const direction = forward.clone().normalize();
    const stableUp = up.clone().normalize();
    if (Math.abs(direction.dot(stableUp)) > 0.96) stableUp.set(0, 1, 0);
    this.group.position.copy(origin);
    this.group.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(origin, origin.clone().add(direction), stableUp),
    );
    this.group.updateMatrixWorld(true);
  }

  private localFrameAt(t: number) {
    const f = THREE.MathUtils.clamp(t, 0, 1) * (this.frames.length - 1);
    const i = Math.min(this.frames.length - 2, Math.floor(f));
    const a = this.frames[i];
    const b = this.frames[i + 1];
    return {
      pos: a.pos.clone().lerp(b.pos, f - i),
      quat: a.quat.clone().slerp(b.quat, f - i),
    };
  }

  /** 沿中心线的世界位姿。 */
  frameAt(t: number): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    const local = this.localFrameAt(t);
    this.group.updateMatrixWorld(true);
    local.pos.applyMatrix4(this.group.matrixWorld);
    local.quat.premultiply(this.group.quaternion);
    return local;
  }

  setPhotos(items: { id: number; texture: THREE.Texture | null; aspect: number }[]) {
    const list = items.slice(0, this.maxPhotos);
    if (this.photos.length === list.length && this.photos.every((photo, index) => photo.id === list[index].id)) {
      // Admit one new image per frame instead of uploading an entire batch.
      for(let index=0;index<this.photos.length;index++){
        if(this.photos[index].texture!==list[index].texture){
          this.applyPhotoTexture(this.photos[index],list[index].texture);
          break;
        }
      }
      return;
    }
    this.clearPhotos();
    const rng = mulberry32(0x51ab19);
    list.forEach((item, index) => {
      const t = 0.055 + (index / Math.max(1, list.length)) * 0.9 + (rng() - 0.5) * 0.012;
      const aspect = Number.isFinite(item.aspect) && item.aspect > 0 ? item.aspect : 1;
      const height = 6.8 + rng() * 5.4;
      const geometry = new THREE.PlaneGeometry(height * aspect, height, 28, 16);
      geometry.userData.rest = new Float32Array(geometry.getAttribute('position').array);
      (geometry.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(),Math.hypot(height*aspect,height)*.7);
      const material = this.makePhotoMaterial(item.texture, 0.92);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 31;
      const ghosts = [0.16, 0.07].map((opacity, ghostIndex) => {
        const ghost = new THREE.Mesh(geometry, this.makePhotoMaterial(item.texture, opacity));
        ghost.renderOrder = 29 - ghostIndex;
        this.photoGroup.add(ghost);
        return ghost;
      });
      this.photoGroup.add(mesh);
      this.photos.push({
        id: item.id,
        mesh,
        ghosts,
        texture: item.texture,
        t,
        angle: rng() * Math.PI * 2,
        radius: 12 + rng() * 21,
        phase: rng() * Math.PI * 2,
      });
    });
  }

  private makePhotoMaterial(texture: THREE.Texture | null, opacity: number) {
    return new THREE.MeshBasicMaterial({
      map: texture ?? this.placeholder,
      color: texture ? new THREE.Color("#cbd7eb") : new THREE.Color("#202b55"),
      transparent: true,
      opacity: texture ? opacity : opacity * 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  private applyPhotoTexture(photo: TunnelPhoto, texture: THREE.Texture | null) {
    if (photo.texture === texture) return;
    photo.texture = texture;
    for (const material of [photo.mesh.material, ...photo.ghosts.map((ghost) => ghost.material)]) {
      material.map = texture ?? this.placeholder;
      material.color.set(texture ? "#cbd7eb" : "#202b55");
      // Both placeholder and photograph use the same shader variant. Texture
      // arrival must not recompile every photograph and its two trails mid-flight.
    }
  }

  /** 真实位移 + 涡流偏移 + 两层照片拖影，共同形成流动和失重感。 */
  update(dt: number, travelProgress: number, revealProgress = travelProgress) {
    this.time += dt;
    const reveal = THREE.MathUtils.smoothstep(revealProgress, 0, 0.12)
      * (1 - THREE.MathUtils.smoothstep(revealProgress, 0.78, 1));
    this.streams.material.opacity = 0.68 * reveal;
    for (const nebula of this.nebulae) {
      (nebula.material as THREE.SpriteMaterial).opacity =
        (nebula.userData.baseOpacity as number) * (0.35 + 0.65 * reveal);
    }

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const center = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const localY = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < this.streamSeeds.length; i++) {
      const seed = this.streamSeeds[i];
      const headDistance = (seed[3] * this.length + this.time * (34 + seed[2] * 78)) % this.length;
      const streamLength = 15 + seed[2] * 42;
      const a = this.localFrameAt(headDistance / this.length);
      const b = this.localFrameAt(Math.max(0, headDistance - streamLength) / this.length);
      const angle = seed[0] * Math.PI * 2 + (headDistance / this.length) * 2.15
        + this.time * (0.08 + seed[4] * 0.12);
      const radius = 10 + seed[1] * 34;
      const offsetA = new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.76, 0)
        .applyQuaternion(a.quat);
      const offsetB = new THREE.Vector3(Math.cos(angle - 0.12) * radius, Math.sin(angle - 0.12) * radius * 0.76, 0)
        .applyQuaternion(b.quat);
      const pa = a.pos.add(offsetA);
      const pb = b.pos.add(offsetB);
      center.copy(pa).add(pb).multiplyScalar(0.5);
      direction.copy(pa).sub(pb);
      const segmentLength = Math.max(0.1, direction.length());
      quaternion.setFromUnitVectors(localY, direction.normalize());
      const width = 0.72 + seed[4] * 1.85;
      scale.set(width, segmentLength, width);
      matrix.compose(center, quaternion, scale);
      this.streams.setMatrixAt(i, matrix);
    }
    this.streams.instanceMatrix.needsUpdate = true;

    for (const photo of this.photos) {
      // Continuous counter-flow toward the viewer. Recycle beyond the entrance
      // with an edge fade so a new photograph never pops into the visible lane.
      const flowT=((photo.t-this.time*(.075+(photo.phase%1)*.035))%1+1)%1;
      const frame = this.localFrameAt(flowT);
      const near = 1-THREE.MathUtils.smoothstep(Math.abs(flowT-travelProgress)*this.length,12,100);
      const flowFade=THREE.MathUtils.smoothstep(flowT,0,.025)*(1-THREE.MathUtils.smoothstep(flowT,.96,1));
      const softness=.3+.7*near;
      const phase=photo.phase;
      const swirl = photo.angle + Math.sin(this.time*.19+phase)*.1 + photo.t * 2.1;
      const pulse = photo.radius + Math.sin(this.time * 0.42 + phase) * .7 * softness;
      const offset = new THREE.Vector3(
        Math.cos(swirl) * pulse + Math.sin(this.time*.33+phase*1.7)*.7*softness,
        Math.sin(swirl) * pulse * 0.72 + Math.sin(this.time*.48+phase)*1.2*softness,
        Math.sin(this.time*.25+phase*2.3)*.55*softness)
        .applyQuaternion(frame.quat);
      photo.mesh.position.copy(frame.pos).add(offset);
      photo.mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().lookAt(photo.mesh.position, frame.pos, new THREE.Vector3(0, 1, 0).applyQuaternion(frame.quat)),
      );
      photo.mesh.rotateZ(Math.sin(this.time * 0.28 + phase) * 0.065 * softness);
      photo.mesh.rotateY(Math.sin(this.time*.31+phase*1.4)*.04*softness);
      // A traveling cloth wave: one side is held relatively steady while the
      // free edge rises, falls and curls. Each photograph has its own wind phase.
      const geometry=photo.mesh.geometry;
      const positions=geometry.getAttribute('position') as THREE.BufferAttribute;
      const uv=geometry.getAttribute('uv');
      const rest=geometry.userData.rest as Float32Array;
      const amplitude=geometry.parameters.height*(.10+.12*near);
      for(let i=0;i<positions.count;i++){
        const u=uv.getX(i),y=uv.getY(i)*2-1;
        const free=Math.pow(u,.8);
        const wind=this.time*(3.2+(phase%1)*.8)+phase;
        const wave=u*Math.PI*3.2-wind+y*.7;
        const gust=.85+.15*Math.sin(this.time*.65+phase);
        const bend=(Math.sin(wave)+.28*Math.sin(u*Math.PI*6.4-wind*1.35-y*.9))*free*amplitude*gust;
        const flutter=Math.sin(wave+1.2)*free*geometry.parameters.height*.025;
        positions.setXYZ(i,rest[i*3]-.035*geometry.parameters.width*free*(1-Math.cos(wave)),rest[i*3+1]+flutter,rest[i*3+2]+bend);
      }
      positions.needsUpdate=true;
      const tangent = this.curve.getTangentAt(flowT).normalize();
      photo.ghosts.forEach((ghost, index) => {
        ghost.position.copy(photo.mesh.position).addScaledVector(tangent, 2.4 + index * 2.8);
        ghost.quaternion.copy(photo.mesh.quaternion);
        ghost.scale.setScalar(1 + (index + 1) * 0.055);
        ghost.material.opacity = (index === 0 ? 0.045 : 0.018) * reveal * flowFade * (photo.texture ? 1 : 0.35);
      });
      photo.mesh.material.opacity =
        0.78 * reveal * flowFade * (photo.texture ? 1 : 0.38);
    }
  }

  private clearPhotos() {
    for (const photo of this.photos) {
      this.photoGroup.remove(photo.mesh, ...photo.ghosts);
      photo.mesh.geometry.dispose();
      photo.mesh.material.dispose();
      for (const ghost of photo.ghosts) ghost.material.dispose();
    }
    this.photos = [];
  }

  dispose() {
    this.clearPhotos();
    for (const nebula of this.nebulae) nebula.material.dispose();
    this.nebulae = [];
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
    this.group.clear();
  }
}

function makeNebulaTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255,255,255,0.62)");
  gradient.addColorStop(0.28, "rgba(255,255,255,0.19)");
  gradient.addColorStop(0.72, "rgba(255,255,255,0.045)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const rng = mulberry32(0x9cc2a7);
  for (let i = 0; i < 1100; i++) {
    context.fillStyle = `rgba(255,255,255,${rng() * 0.05})`;
    context.fillRect(rng() * 256, rng() * 256, 1 + rng() * 2, 1 + rng() * 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
