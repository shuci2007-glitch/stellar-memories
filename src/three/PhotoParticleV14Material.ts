import * as THREE from "three";
import { PHOTO_PARTICLE_DEFAULTS, type PhotoParticleSettings } from "../core/PhotoParticleSettings";
import type { PhotoParticleFieldData } from "./PhotoParticleField";

const VERTEX = /* glsl */ `
precision highp float;
attribute vec3 aPlane;attribute vec3 aSphere;attribute vec3 aColor;attribute vec4 aSeeds;
attribute float aSize;attribute float aBrightness;attribute float aStart;attribute vec3 aScatterDir;
attribute float aReactivity;attribute float aCenterWeight;attribute vec3 aDisturbance;
uniform float uTime;uniform float uDpr;uniform float uPointSize;uniform float uMorph;uniform float uDepth;
uniform float uBreathe;uniform float uWave;uniform float uScatter;uniform float uCurvature;uniform float uOpacity;
uniform float uDetail;uniform sampler2D uReveal;uniform vec2 uPhotoSize;
varying vec3 vColor;varying float vAlpha;varying float vBrightness;varying float vExposure;
float smoother(float t){t=clamp(t,0.,1.);return t*t*t*(t*(t*6.-15.)+10.);}
void main(){
 float local=smoother((uMorph-aStart)/.28);
 vec2 photoUv=aPlane.xy/uPhotoSize+.5;
 if(uDetail>.5) local=texture2D(uReveal,photoUv).r;
 vec3 plane=vec3(aPlane.xy,aPlane.z*uDepth*local);
 vec3 sphereNormal=normalize(aSphere+vec3(0.,0.,.00001));
 vec3 sphere=aSphere+sphereNormal*aPlane.z*uDepth*.18*local;
 vec3 p=mix(plane,sphere,uCurvature);
 float wave1=sin(uTime*.95+aPlane.x*1.25+aPlane.y*.90);
 float wave2=cos(uTime*.72+aPlane.x*.68-aPlane.y*1.08);
 vec3 localZ=normalize(mix(vec3(0.,0.,1.),sphereNormal,uCurvature));
 p+=localZ*((wave1*.70+wave2*.30)*uWave*local);
 p.x+=sin(uTime*.60+aPlane.y*1.4)*uWave*.10*local;
 p.y+=cos(uTime*.54+aPlane.x*1.1)*uWave*.08*local;
 p+=localZ*(sin(uTime*.72+aSeeds.x*18.)*uBreathe*(.35+aSeeds.y*.65)*aCenterWeight*local);
 float scattered=uScatter*uScatter*(3.-2.*uScatter);
 p+=aScatterDir*scattered*(.82+aSeeds.z*.52)*local+aDisturbance*mix(1.,local,uDetail);
 if(uDetail>.5){float lift=sin(local*3.14159265);p+=vec3(cos(aSeeds.y*6.283)*.07,sin(aSeeds.y*6.283)*.07,.16+aSeeds.z*.12)*lift;}
 vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
 float perspective=clamp(4.7/max(-mv.z,.001),.48,2.8);
 gl_PointSize=uDpr*uPointSize*aSize*perspective*mix(1.,.72,uCurvature);
 vec3 viewNormal=normalize(normalMatrix*sphereNormal);float facing=smoothstep(-.18,.3,dot(normalize(-mv.xyz),viewNormal));
 vColor=aColor;vAlpha=local*uOpacity*mix(1.,.16+.84*facing,uCurvature);vBrightness=aBrightness;vExposure=mix(1.,.58,uCurvature);
 if(uDetail>.5){vAlpha*=texture2D(uReveal,photoUv).g;}
}`;

const FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vColor;varying float vAlpha;varying float vBrightness;varying float vExposure;uniform float uGlow;uniform float uDetail;
void main(){
 vec2 p=gl_PointCoord-.5;float r=length(p);float core=1.-smoothstep(.07,.45,r);
 float lum=dot(vColor,vec3(.2126,.7152,.0722));float brightHot=smoothstep(.70,1.,lum);
 float localGlow=uGlow*(1.-brightHot*.32);float halo=exp(-r*r*8.)*localGlow;
 float alpha=max(core,halo)*vAlpha;if(alpha<.012)discard;
 vec3 color=vColor*vBrightness*(1.-brightHot*.24)*vExposure;color=mix(color,vec3(1.),brightHot*.025);
 if(uDetail>.5){color=vColor*min(vBrightness,1.)*(1.-brightHot*.25);alpha*=1.-brightHot*.12;}
 gl_FragColor=vec4(color,alpha*.92);
}`;

const BLEND: Pick<THREE.ShaderMaterialParameters, "blending" | "blendEquation" | "blendSrc" | "blendDst"> = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneFactor,
};

export class PhotoParticleV14 {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly field: PhotoParticleFieldData;
  private readonly material: THREE.ShaderMaterial;
  private readonly disturbance: Float32Array;
  private readonly targetDisturbance: Float32Array;
  private settings: PhotoParticleSettings;
  private pointer = new THREE.Vector2(1e6, 1e6);
  private pointerActive = false;

  constructor(field: PhotoParticleFieldData, settings: PhotoParticleSettings = { ...PHOTO_PARTICLE_DEFAULTS }) {
    this.field = field;
    this.settings = { ...settings };
    const geometry = new THREE.BufferGeometry();
    this.disturbance = new Float32Array(field.count * 3);
    this.targetDisturbance = new Float32Array(field.count * 3);
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(field.count * 3), 3));
    geometry.setAttribute("aPlane", new THREE.BufferAttribute(field.plane, 3));
    geometry.setAttribute("aSphere", new THREE.BufferAttribute(field.sphere, 3));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(field.color, 3));
    geometry.setAttribute("aSeeds", new THREE.BufferAttribute(field.seeds, 4));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(field.sizes, 1));
    geometry.setAttribute("aBrightness", new THREE.BufferAttribute(field.brightness, 1));
    geometry.setAttribute("aStart", new THREE.BufferAttribute(field.starts, 1));
    geometry.setAttribute("aScatterDir", new THREE.BufferAttribute(field.scatterDirs, 3));
    geometry.setAttribute("aReactivity", new THREE.BufferAttribute(field.reactivity, 1));
    geometry.setAttribute("aCenterWeight", new THREE.BufferAttribute(field.centerWeights, 1));
    geometry.setAttribute("aDisturbance", new THREE.BufferAttribute(this.disturbance, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...BLEND,
      uniforms: {
        uTime: { value: 0 }, uDpr: { value: Math.min(devicePixelRatio, 2) }, uPointSize: { value: settings.size }, uGlow: { value: settings.glow },
        uMorph: { value: 1 }, uDepth: { value: settings.depth }, uBreathe: { value: settings.breathe }, uWave: { value: settings.wave },
        uScatter: { value: settings.scatter }, uCurvature: { value: 0 }, uOpacity: { value: 1 },
        uDetail: { value: 0 }, uReveal: { value: null }, uPhotoSize: { value: new THREE.Vector2(4.42,4.42*field.height/field.width) },
      },
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 60;
  }

  applySettings(settings: PhotoParticleSettings) {
    this.settings = { ...settings };
    const uniforms = this.material.uniforms;
    uniforms.uDepth.value = settings.depth; uniforms.uPointSize.value = settings.size; uniforms.uGlow.value = settings.glow;
    uniforms.uBreathe.value = settings.breathe; uniforms.uWave.value = settings.wave; uniforms.uScatter.value = settings.scatter;
    if(uniforms.uDetail.value>.5) uniforms.uGlow.value=Math.min(settings.glow,0.3);
  }

  setMorph(value: number) { this.material.uniforms.uMorph.value = THREE.MathUtils.clamp(value, 0, 1); }
  setDetailReveal(texture: THREE.Texture) {
    this.material.uniforms.uDetail.value = 1;
    this.material.uniforms.uReveal.value = texture;
    this.material.blending = THREE.NormalBlending;
    this.material.uniforms.uGlow.value = Math.min(this.settings.glow,0.3);
  }
  setCurvature(value: number) { this.material.uniforms.uCurvature.value = THREE.MathUtils.clamp(value, 0, 1); }
  setOpacity(value: number) { this.material.uniforms.uOpacity.value = THREE.MathUtils.clamp(value, 0, 1); }
  setPixelRatio(value: number) { this.material.uniforms.uDpr.value = Math.min(value, 2); }
  setPointer(local: THREE.Vector2 | null) { this.pointerActive = !!local; if (local) this.pointer.copy(local); }

  update(dt: number, time: number) {
    this.material.uniforms.uTime.value = time;
    this.targetDisturbance.fill(0);
    if (this.pointerActive && this.material.uniforms.uMorph.value > 0.55) {
      const radius = this.settings.disturbRadius, strength = this.settings.disturbStrength;
      for (let i = 0; i < this.field.count; i++) {
        const j = i * 3, s = i * 4, dx = this.field.plane[j] - this.pointer.x, dy = this.field.plane[j + 1] - this.pointer.y, distance = Math.hypot(dx, dy);
        if (distance >= radius || this.field.reactivity[i] < 0.06) continue;
        const t = 1 - distance / radius, weight = t * t * (3 - 2 * t), react = this.field.reactivity[i];
        const gate = 0.62 + 0.38 * Math.max(0, Math.sin(time * 1.95 + this.field.seeds[s] * 9));
        const amplitude = strength * weight * react * gate;
        this.targetDisturbance[j] = dx / (distance + 1e-6) * amplitude;
        this.targetDisturbance[j + 1] = dy / (distance + 1e-6) * amplitude;
        this.targetDisturbance[j + 2] = amplitude * 0.24;
      }
    }
    const rise = 1 - Math.exp(-this.settings.disturbRise * dt), fall = 1 - Math.exp(-this.settings.disturbFall * dt);
    let changed = false;
    for (let i = 0; i < this.disturbance.length; i++) {
      const target = this.targetDisturbance[i], current = this.disturbance[i], k = Math.abs(target) > Math.abs(current) ? rise : fall;
      const next = current + (target - current) * k;
      if (Math.abs(next - current) > 1e-6) changed = true;
      this.disturbance[i] = next;
    }
    if (changed) (this.points.geometry.getAttribute("aDisturbance") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() { this.points.geometry.dispose(); this.material.dispose(); }
}
