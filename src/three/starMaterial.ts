import * as THREE from "three";

/**
 * 全项目共享的 Stellar Rendering Primitive。
 * 各场景可以改变颜色与强度，但星核、亚像素覆盖、衍射星芒和混合方式只有这一套。
 */
export const STELLAR_FILTER_GLSL = /* glsl */ `
float stellarCubicCoverage(float coordinate) {
  float x = abs(coordinate);
  if (x < 1.0) return (4.0 - 6.0*x*x + 3.0*x*x*x) / 6.0;
  float tail = max(2.0 - x, 0.0);
  return tail*tail*tail / 6.0;
}
float stellarFilteredCore(vec2 pixel, float area, float diameter) {
  return stellarCubicCoverage(pixel.x) * stellarCubicCoverage(pixel.y)
    * area * diameter * diameter;
}
float stellarDisc(vec2 point) {
  return pow(1.0 - smoothstep(0.08, 1.0, length(point)), 2.2);
}
float stellarRays(vec2 point, float strength) {
  float horizontal = exp(-abs(point.y) * 28.0)
    * (1.0 - smoothstep(0.18, 1.0, abs(point.x)));
  float vertical = exp(-abs(point.x) * 28.0)
    * (1.0 - smoothstep(0.18, 1.0, abs(point.y)));
  return max(horizontal, vertical) * 0.28 * strength;
}
`;

export const STELLAR_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
varying float vBrightness;
varying float vRay;
varying float vDiam;
${STELLAR_FILTER_GLSL}
void main() {
  vec2 pixel = (gl_PointCoord - vec2(0.5)) * max(vDiam, 4.0);
  vec2 point = pixel * 2.0 / max(vDiam, 0.0001);
  float core = stellarDisc(point);
  float rays = stellarRays(point, vRay);
  float resolved = smoothstep(2.0, 4.0, vDiam);
  float alpha = mix(stellarFilteredCore(pixel, 0.150904, vDiam), max(core, rays), resolved) * vAlpha;
  if (alpha <= 0.0) discard;
  float whiteCore = mix(0.59228, core, resolved)
    * smoothstep(0.9, 2.8, vBrightness) * 0.82;
  float colorEnergy = 1.0 - min(vColor.r, min(vColor.g, vColor.b));
  vec3 emission = mix(vColor, vec3(1.0), whiteCore) * vBrightness
    * (1.0 + colorEnergy * 0.42);
  gl_FragColor = vec4(emission, alpha);
}`;

export const STELLAR_BLEND: Pick<THREE.ShaderMaterialParameters,
  "blending"|"blendEquation"|"blendSrc"|"blendDst"|"blendEquationAlpha"|"blendSrcAlpha"|"blendDstAlpha"> = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneFactor,
  blendEquationAlpha: THREE.AddEquation,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

export const STAR_PROFILES = {
  galaxy: { hero: 1, warmth: 0.09, intensity: 1 },
  lock: { hero: 0.55, warmth: 0.05, intensity: 0.72 },
  particle: { hero: 0.08, warmth: 0, intensity: 1 },
  solar: { hero: 0.36, warmth: 0.04, intensity: 0.58 },
} as const;
