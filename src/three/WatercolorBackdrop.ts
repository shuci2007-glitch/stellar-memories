import * as THREE from "three";

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){vUv=position.xy*.5+.5;gl_Position=vec4(position.xy,1.,1.);}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uTime;uniform float uIntensity;uniform vec2 uResolution;
varying vec2 vUv;
float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.52;mat2 r=mat2(.8,-.6,.6,.8);for(int i=0;i<4;i++){v+=a*noise(p);p=r*p*2.03+vec2(7.1,3.7);a*=.5;}return v;}
void main(){
 vec2 uv=vUv;float aspect=min(uResolution.x/max(uResolution.y,1.),3.);float t=uTime*.035;
 vec2 p=vec2(uv.x*(1.12+aspect*.16),uv.y*1.08);
 vec2 drift=vec2(t*.34+sin(t*.41)*.12,-t*.07+cos(t*.29)*.10);
 vec2 w1=vec2(fbm(p*1.05+drift),fbm(p*1.05+drift+vec2(4.8,1.7)));
 float f2=fbm(p*1.45+w1*1.18+vec2(1.4,6.2));
 vec2 w2=vec2(f2,noise(p*1.25+w1*1.05+vec2(8.3,2.1)));
 float pooled=fbm(p*1.18+w2*1.55+drift*.35);
 float boundary=.50+(w2.x-.5)*.24+(w1.y-.5)*.13+sin(uv.x*3.2+t*.72)*.025;
 float wash=smoothstep(boundary-.18,boundary+.18,uv.y);
 float wet=exp(-pow((uv.y-boundary)/.18,2.)*2.2)*.08;
 float opacity=clamp((wash*(.78+(pooled-.5)*.35)+wet*wash)*uIntensity,0.,1.);
 vec3 surface=vec3(.012,.018,.027),mist=vec3(.035,.054,.075);
 vec3 cool=vec3(.055,.075,.105),warm=vec3(.095,.075,.055);
 vec3 pigment=mix(mist,mix(cool,warm,smoothstep(.66,1.,uv.x)*.22),smoothstep(boundary-.08,boundary+.25,uv.y));
 gl_FragColor=vec4(mix(surface,pigment,opacity),1.);
}`;

export class WatercolorBackdrop {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  constructor(){
    this.material=new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG,depthTest:false,depthWrite:false,
      uniforms:{uTime:{value:0},uIntensity:{value:.48},uResolution:{value:new THREE.Vector2(1,1)}}});
    this.mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),this.material);
    this.mesh.frustumCulled=false;this.mesh.renderOrder=-1000;
  }
  resize(w:number,h:number){(this.material.uniforms.uResolution.value as THREE.Vector2).set(w,h);}
  update(time:number,intensity=1){this.material.uniforms.uTime.value=time;this.material.uniforms.uIntensity.value=.48*intensity;}
  dispose(){this.mesh.geometry.dispose();this.material.dispose();}
}
