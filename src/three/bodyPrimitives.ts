import * as THREE from "three";

/**
 * 天体构建用的共享基元（点精灵贴图 / 光晕 / 行星球体）。
 *
 * 原先这几段直接写在 SpaceBody.ts 里，新增「光带结 / 同心光环 / 螺旋星盘」
 * 三种纯网格天体后也需要复用，抽到这里避免复制粘贴出两份着色器。
 */

export function dotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function glowSprite(color: string, opacity: number, scale: number): THREE.Sprite {
  const size = 256;
  // 解析 "rgba(r,g,b,a)" / "rgb(r,g,b)"（兼容空格），不再用脆弱的正则替换末位 alpha
  const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  const rgb = m ? `${m[1]},${m[2]},${m[3]}` : "255,255,255";
  const centerA = m && m[4] !== undefined ? Number(m[4]) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${rgb},${centerA})`);
  g.addColorStop(0.45, `rgba(${rgb},0.28)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sprite.scale.setScalar(scale);
  sprite.renderOrder = -8;
  return sprite;
}

const PLANET_VERT = `
varying vec3 vNormal;
varying vec3 vViewPos;
varying float vLat;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vLat = position.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const PLANET_FRAG = `
uniform vec3 uLit;
uniform vec3 uDark;
uniform vec3 uRim;
uniform float uRimStrength;
uniform float uRadius;
uniform float uBands;
varying vec3 vNormal;
varying vec3 vViewPos;
varying float vLat;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(-0.60, 0.30, 0.74));
  float lam = max(dot(n, lightDir), 0.0);
  // 纬度条带：几个不同频率的正弦叠加，像大气环流
  float lat = clamp(vLat / uRadius, -1.0, 1.0);
  float stripe = 1.0 + uBands * (0.10 * sin(lat * 26.0 + sin(lat * 5.0) * 1.6));
  vec3 col = mix(uDark, uLit, pow(lam, 0.85)) * stripe;
  float fres = pow(1.0 - max(dot(n, normalize(-vViewPos)), 0.0), 3.0);
  col += uRim * fres * uRimStrength * (0.25 + 0.75 * lam);
  gl_FragColor = vec4(col, 1.0);
}`;

export function planetMesh(
  radius: number,
  lit: THREE.Color,
  dark: THREE.Color,
  rim: THREE.Color,
  rimStrength: number,
  bands: number,
): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uLit: { value: lit },
      uDark: { value: dark },
      uRim: { value: rim },
      uRimStrength: { value: rimStrength },
      uRadius: { value: radius },
      uBands: { value: bands },
    },
    vertexShader: PLANET_VERT,
    fragmentShader: PLANET_FRAG,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 56, 36), material);
  mesh.renderOrder = -6;
  return mesh;
}
