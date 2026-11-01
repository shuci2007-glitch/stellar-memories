/**
 * 生成 scripts/glsl-check.js:把星野/绸带着色器源码喂给裸 WebGL 编译,验证语法。
 *
 * 为什么要有这个:
 *   three.js 的渲染在本机无法截图验证(WebGL 扩展受限),但着色器编译失败
 *   会直接黑屏,所以用裸 WebGL 先编译一遍,能在交付前把语法错误挡住。
 *
 * 生成的脚本里所有非 ASCII 字符都转成 \uXXXX —— moli 的 --eval-file
 * 按 UTF-8 读文件时,裸中文可能把整个表达式解析坏掉。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const starSrc = readFileSync(resolve(root, "src/three/Starfield.ts"), "utf8");
const bodySrc = readFileSync(resolve(root, "src/three/SpaceBody.ts"), "utf8");

function grab(name, from) {
  const key = `export const ${name} =`;
  const i = from.indexOf(key);
  if (i < 0) throw new Error(`missing ${name}`);
  const a = from.indexOf("`", i);
  const b = from.indexOf("`", a + 1);
  if (a < 0 || b < 0) throw new Error(`bad literal for ${name}`);
  return from.slice(a + 1, b);
}

/** 只留 ASCII,其余转 \uXXXX —— 避免任何编码歧义 */
function asciiSafe(str) {
  let out = "";
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 128) out += ch;
    else if (c > 0xffff) {
      const v = c - 0x10000;
      out += "\\u" + (0xd800 + (v >> 10)).toString(16).padStart(4, "0");
      out += "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
    } else out += "\\u" + c.toString(16).padStart(4, "0");
  }
  return out;
}

// 星野着色器自带 precision 声明,不用再补
const starVert = asciiSafe(grab("STAR_VERT", starSrc));
const starFrag = asciiSafe(grab("STAR_FRAG", starSrc));
const ribbonVert = asciiSafe(grab("RIBBON_VERT", bodySrc));
const ribbonFrag = asciiSafe(grab("RIBBON_FRAG", bodySrc));

const body = `
(async () => {
  const PAIRS = [
    ["STAR", ${JSON.stringify(starVert)}, ${JSON.stringify(starFrag)}],
    ["RIBBON", ${JSON.stringify(ribbonVert)}, ${JSON.stringify(ribbonFrag)}],
  ];
  const canvas = document.createElement("canvas");
  canvas.width = 32; canvas.height = 32;
  const gl = canvas.getContext("webgl");
  if (!gl) return "NO_WEBGL_CONTEXT";
  const res = [];
  for (const [tag, vertSrc, fragSrc] of PAIRS) {
    const mk = (type, code) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, code);
      gl.compileShader(sh);
      const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
      return { sh, ok, log: String(gl.getShaderInfoLog(sh) || "") };
    };
    const v = mk(gl.VERTEX_SHADER, vertSrc);
    const f = mk(gl.FRAGMENT_SHADER, fragSrc);
    res.push(tag + ".VERTEX:" + (v.ok ? "OK" : "FAIL"));
    if (!v.ok) res.push(v.log);
    res.push(tag + ".FRAGMENT:" + (f.ok ? "OK" : "FAIL"));
    if (!f.ok) res.push(f.log);
    if (v.ok && f.ok) {
      const p = gl.createProgram();
      gl.attachShader(p, v.sh);
      gl.attachShader(p, f.sh);
      gl.linkProgram(p);
      const linked = gl.getProgramParameter(p, gl.LINK_STATUS);
      res.push(tag + ".LINK:" + (linked ? "OK" : "FAIL"));
      if (!linked) res.push(String(gl.getProgramInfoLog(p)));
    }
  }
  return res.join(" | ");
})()
`;

writeFileSync(resolve(root, "scripts/glsl-check.js"), body.trimStart() + "\n", "utf8");
console.log("generated scripts/glsl-check.js");
