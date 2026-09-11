import * as THREE from "three";

/**
 * 统一旅程控制器:唯一的镜头飞行进度与朝向拥有者。
 *  - 路径用 CatmullRom + 三方内置弧长参数化,速度按路程推进,起步/巡航/制动平滑;
 *  - 朝向看向前瞻点,与目的地锚点混合,固定 up,克制滚转;
 *  - 旅程期间独占相机(OrbitControls 关闭),打断时从当前实际位姿重新起航;
 *  - token 语义:旧回调不会落地,最后一次意图胜出。
 */

export type JourneyPhase = "turn" | "accelerate" | "cruise" | "decelerate" | "arrived";
export type JourneyDestination = "overview" | "earth" | "shelf" | "timeline" | "album" | "pose";

export interface JourneyRequest {
  destination: JourneyDestination;
  /** 途经点(世界坐标):[起点起航弧, …, 目的地外侧];最后一段必须是可操作视角 */
  waypoints: THREE.Vector3[];
  /** 末端注视锚点(通常为目的地中心);null=纯路径前瞻 */
  focus?: THREE.Vector3 | null;
  /** 全程保持面向的起始主题；提供时从它平滑过渡到 focus/lookAt，不再朝路径后方转头 */
  startFocus?: THREE.Vector3 | null;
  /** 到达时相机看向的精确目标点;默认取 focus */
  lookAt?: THREE.Vector3 | null;
  /** 末端注视点混合开始的路程比例(0..1) */
  focusBlend?: number;
  /** 巡航速度(世界单位/秒);时长 = 路程/速度,clamp 到 [minDuration,maxDuration] */
  speed?: number;
  minDuration?: number;
  maxDuration?: number;
  /** 起点初始朝向;省略时保持相机当前朝向 */
  fromQuaternion?: THREE.Quaternion | null;
  /** 到达时 up 的滚转修正(弧度,克制) */
  endRoll?: number;
  /** 相册连续缩放：保持起始视线/FOV，返回时可连续恢复保存的朝向。 */
  preserveView?: boolean;
  endQuaternion?: THREE.Quaternion;
  onArrive?: () => void;
  /** 接近目的地(路程比例 > 0.72)时回调一次,用于预热 */
  onNear?: () => void;
}

interface ActiveJourney extends JourneyRequest {
  curve: THREE.CatmullRomCurve3;
  length: number;
  distance: number;
  nearFired: boolean;
  fromQuat: THREE.Quaternion;
  duration: number;
  elapsed: number;
  fromFov: number;
  currentPhase: JourneyPhase;
}

const BASE_FOV = 45;

export class JourneyController {
  private active: ActiveJourney | null = null;
  private token = 0;
  private lookQuat = new THREE.Quaternion();
  private tmpMat = new THREE.Matrix4();
  private tmpPos = new THREE.Vector3();
  private tmpAhead = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();

  get activeDestination(): JourneyDestination | null { return this.active?.destination ?? null; }
  get phase(): JourneyPhase { return this.active?.currentPhase ?? "arrived"; }
  /** 0..1 路程进度(无旅程时 1) */
  get progress(): number {
    if (!this.active) return 1;
    return Math.min(1, this.active.distance / Math.max(0.001, this.active.length));
  }

  /** 从相机当前实际位姿起航;任何旧旅程立即作废(token 语义) */
  begin(rig: { camera: THREE.PerspectiveCamera; controls: { enabled: boolean; target: THREE.Vector3; update: (dt?: number) => void } }, request: JourneyRequest): number {
    const myToken = ++this.token;
    const camera = rig.camera;
    // 起点之外至少一个途经点(起点相机位姿由 begin 内部追加)
    if (request.waypoints.length < 1) throw new Error("journey needs >= 1 waypoint");
    // 起点永远是相机此刻的真实位置,不瞬移、不回预设起点
    const points = [camera.position.clone(), ...request.waypoints.map((p) => p.clone())];
    const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.42);
    const length = Math.max(1, curve.getLength());
    const speed = request.speed ?? 200;
    const duration = THREE.MathUtils.clamp(length / speed, request.minDuration ?? 2.2, request.maxDuration ?? 5.2);
    rig.controls.enabled = false;
    this.active = {
      ...request,
      waypoints: points,
      curve,
      length,
      distance: 0,
      nearFired: false,
      fromQuat: (request.fromQuaternion ?? camera.quaternion).clone(),
      duration,
      elapsed: 0,
      fromFov: camera.fov,
      currentPhase: "turn",
    };
    return myToken;
  }

  /** 取消当前旅程(相机停在当前插值状态,由调用方决定 controls 恢复) */
  cancel(): void {
    this.token++;
    this.active = null;
  }

  /** 每帧推进;返回是否仍处于旅程中 */
  update(dt: number, camera: THREE.PerspectiveCamera): boolean {
    const j = this.active;
    if (!j) return false;
    j.elapsed += dt;
    // 时间直接映射到归一化路程。旧实现把小于 1 的 speedFactor 再积分，
    // elapsed 到时后往往只走完部分路径便触发到达，造成最后一刻停顿/跳位。
    const u = Math.min(1, j.elapsed / j.duration);
    const easeIn = THREE.MathUtils.smoothstep(u, 0, 0.18);
    const easeOut = 1 - THREE.MathUtils.smoothstep(u, 0.7, 1);
    const speedFactor = 0.16 + 0.84 * easeIn * (0.3 + 0.7 * easeOut);
    const travel = u * u * u * (u * (u * 6 - 15) + 10);
    j.distance = j.length * travel;
    const s = j.distance / j.length;
    j.curve.getPointAt(Math.min(1, s), this.tmpPos);
    camera.position.copy(this.tmpPos);

    // —— 朝向:普通航行看路径前方；主题拉远则始终看着主题，避免镜头转身看向后退方向 ——
    if (j.startFocus) {
      const endFocus = j.focus ?? j.lookAt ?? j.startFocus;
      const focusT = THREE.MathUtils.smoothstep(s, 0.34, 0.94);
      this.tmpAhead.copy(j.startFocus).lerp(endFocus, focusT);
    } else {
      const lookAheadDist = Math.min(j.length, j.distance + Math.max(24, j.length * 0.08));
      j.curve.getPointAt(Math.min(1, lookAheadDist / j.length), this.tmpAhead);
      const focusBlendStart = j.focusBlend ?? 0.62;
      const focusWeight = j.focus
        ? THREE.MathUtils.smoothstep(s, focusBlendStart, Math.min(1, focusBlendStart + 0.3))
        : 0;
      if (j.focus && focusWeight > 0) this.tmpAhead.lerp(j.focus, focusWeight * 0.9);
    }
    this.tmpDir.copy(this.tmpAhead).sub(camera.position);
    if (j.preserveView) {
      camera.quaternion.copy(j.fromQuat);
      if (j.endQuaternion) camera.quaternion.slerp(j.endQuaternion, travel);
    } else if (this.tmpDir.lengthSq() > 0.0001) {
      this.tmpDir.normalize();
      // Matrix4.lookAt(eye, target, up):相机 -Z 指向注视方向
      this.tmpMat.lookAt(camera.position, this.tmpAhead, camera.up);
      this.lookQuat.setFromRotationMatrix(this.tmpMat);
      // 从起航朝向平滑转向前瞻四元数:随路程推进加深,大弯不甩
      const turnT = Math.min(1, j.elapsed * 1.6 + s * 0.8);
      camera.quaternion.copy(j.fromQuat).slerp(this.lookQuat, turnT);
    }

    // 阶段推进(供 UI/调试)
    const prevPhase = j.currentPhase;
    j.currentPhase = s < 0.16 ? "turn" : s < 0.68 ? (speedFactor > 0.85 ? "cruise" : "accelerate") : "decelerate";
    if (j.currentPhase !== prevPhase && j.currentPhase === "decelerate") { /* decelerate 起点标记 */ }
    if (!j.nearFired && s > 0.72) {
      j.nearFired = true;
      j.onNear?.();
    }

    // FOV 只辅助速度感:巡航小幅打开,到达前回落
    const fovTarget = BASE_FOV + 5 * Math.sin(Math.PI * Math.min(1, s)) * (j.destination === "timeline" ? 1.4 : 1);
    if (j.preserveView) camera.fov = j.fromFov;
    else camera.fov += (fovTarget - camera.fov) * Math.min(1, dt * 3);
    camera.updateProjectionMatrix();

    if (u >= 1 || j.distance >= j.length - 0.01) {
      this.active = null;
      j.curve.getPointAt(1, camera.position);
      // 精确落位:视线指向终点注视点
      const finalLook = j.lookAt ?? j.focus;
      if (finalLook && !j.preserveView) {
        this.tmpMat.lookAt(camera.position, finalLook, camera.up);
        camera.quaternion.setFromRotationMatrix(this.tmpMat);
      }
      camera.fov = j.preserveView ? j.fromFov : BASE_FOV;
      camera.updateProjectionMatrix();
      j.onArrive?.();
      return false;
    }
    return true;
  }

  /** 旅程结束后把 OrbitControls 的 target 对齐到注视点,恢复手动漫游 */
  static handBack(controls: { target: THREE.Vector3; update: (dt?: number) => void }, lookTarget: THREE.Vector3): void {
    controls.target.copy(lookTarget);
    controls.update();
  }
}
