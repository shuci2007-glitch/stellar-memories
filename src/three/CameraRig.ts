import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Official orbit input; only cinematic flights are owned by this adapter. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; target: THREE.Vector3; elapsed: number; duration: number } | null = null;
  private desiredDistance: number | null = null;
  constructor(aspect: number, private canvas: HTMLCanvasElement) {
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 3000);
    this.camera.position.set(65, 112, 150);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, {enableDamping:true, dampingFactor:0.12, autoRotate:false, enableZoom:false, enableRotate:true, enablePan:true, rotateSpeed:0.55, minDistance:6, maxDistance:620, minPolarAngle:0.18, maxPolarAngle:Math.PI-0.18});
    this.controls.mouseButtons.LEFT = -1 as THREE.MOUSE;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.addEventListener('start', this.cancel);
    canvas.addEventListener('wheel', this.wheel, {passive:false});
    this.controls.update();
  }
  cancel = () => { this.flight = null; this.desiredDistance = null; };
  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.controls.enabled) return;
    this.flight = null;
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1);
    this.desiredDistance = THREE.MathUtils.clamp((this.desiredDistance ?? this.getRadius()) * Math.exp(delta * 0.0012), 6, 620);
  };
  resize(aspect: number) { this.camera.aspect=aspect; this.camera.updateProjectionMatrix(); }
  getRadius() { return this.camera.position.distanceTo(this.controls.target); }
  setPose(theta: number, phi: number, radius: number) {
    this.cancel(); this.controls.target.set(0,0,0);
    this.camera.position.setFromSpherical(new THREE.Spherical(radius,phi,theta)); this.controls.update();
  }
  flyTo(target: THREE.Vector3, radius: number, duration=850) {
    this.cancel();
    const offset=this.camera.position.clone().sub(this.controls.target).normalize().multiplyScalar(radius);
    this.flight={from:this.camera.position.clone(),to:target.clone().add(offset),fromTarget:this.controls.target.clone(),target:target.clone(),elapsed:0,duration};
  }
  /** 精确回到一个完整位姿(位置+目标),用于照片聚焦后的原路返回 */
  flyToPose(pos: THREE.Vector3, target: THREE.Vector3, duration=900) {
    this.cancel();
    this.flight={from:this.camera.position.clone(),to:pos.clone(),fromTarget:this.controls.target.clone(),target:target.clone(),elapsed:0,duration};
  }
  flyToOverview(duration=900) { this.flyTo(new THREE.Vector3(),172,duration); }
  update(dt: number) {
    const f=this.flight;
    if(f) { f.elapsed+=dt*1000; const t=Math.min(1,f.elapsed/f.duration); const e=t*t*(3-2*t);
      this.camera.position.lerpVectors(f.from,f.to,e); this.controls.target.lerpVectors(f.fromTarget,f.target,e);
      if(t===1) this.flight=null;
    } else if(this.desiredDistance!==null) {
      const current=this.getRadius(); const next=THREE.MathUtils.lerp(current,this.desiredDistance,1-Math.exp(-dt*14));
      this.camera.position.sub(this.controls.target).multiplyScalar(next/current).add(this.controls.target);
      if(Math.abs(next-this.desiredDistance)<0.005) this.desiredDistance=null;
    }
    this.controls.update(dt);
  }
  dispose() { this.cancel(); this.controls.removeEventListener('start',this.cancel); this.controls.dispose(); this.canvas.removeEventListener('wheel',this.wheel); }
}
