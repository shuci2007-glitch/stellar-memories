import * as THREE from 'three';

const VERT=/* glsl */`varying vec2 v_uv;void main(){v_uv=position.xy*.5+.5;gl_Position=vec4(position.xy,1.,1.);}`;
const FRAG=/* glsl */`
precision highp float;
#define FBM_OCTAVES 4
uniform float u_edgeSoftness;uniform float u_grain;uniform float u_intensity;uniform vec3 u_mist;uniform vec3 u_primary;
uniform vec2 u_resolution;uniform vec3 u_secondary;uniform float u_speed;uniform vec3 u_surface;uniform float u_time;uniform float u_warp;varying vec2 v_uv;
float random(vec2 point){vec3 point3=fract(vec3(point.xyx)*.1031);point3+=dot(point3,point3.yzx+33.33);return fract((point3.x+point3.y)*point3.z);}
float noise(vec2 point){vec2 cell=floor(point),local=fract(point),curve=local*local*(3.-2.*local);float bl=random(cell),br=random(cell+vec2(1,0)),tl=random(cell+vec2(0,1)),tr=random(cell+vec2(1));return mix(mix(bl,br,curve.x),mix(tl,tr,curve.x),curve.y);}
float fbm(vec2 point){float value=0.,amplitude=.52;mat2 rotation=mat2(.8,-.6,.6,.8);for(int octave=0;octave<FBM_OCTAVES;octave++){value+=amplitude*noise(point);point=rotation*point*2.03+vec2(7.1,3.7);amplitude*=.5;}return value;}
void main(){
 vec2 uv=v_uv;float aspect=min(u_resolution.x/max(u_resolution.y,1.),3.);float motionTime=u_time*max(u_speed,0.);
 vec2 point=vec2(uv.x*(1.12+aspect*.16),uv.y*1.08);vec2 drift=vec2(motionTime*.34+sin(motionTime*.41)*.12,-motionTime*.07+cos(motionTime*.29)*.10);
 vec2 firstWarp=vec2(fbm(point*1.05+drift),fbm(point*1.05+drift+vec2(4.8,1.7)));
 float secondField=fbm(point*1.45+firstWarp*(1.25*u_warp)+vec2(1.4,6.2));
 vec2 secondWarp=vec2(secondField,noise(point*1.25+firstWarp*(1.1*u_warp)+vec2(8.3,2.1)));
 float pooledPigment=fbm(point*1.18+secondWarp*(1.7*u_warp)+drift*.35),broadWash=firstWarp.y;
 float boundary=.48+(secondWarp.x-.5)*.29+(broadWash-.5)*.17+sin(uv.x*3.2+motionTime*.72)*.035;
 float feather=u_edgeSoftness*mix(.78,1.25,broadWash),wash=smoothstep(boundary-feather,boundary+feather,uv.y);
 float granulation=noise(point*5.2+secondWarp*.85+drift*1.3),density=.98+(pooledPigment-.5)*.42+(broadWash-.5)*.28+(granulation-.5)*u_grain*1.6;
 density*=mix(.70,1.08,smoothstep(.25,.75,pooledPigment));float edgeDistance=(uv.y-boundary)/max(feather,.001),wetEdge=exp(-edgeDistance*edgeDistance*2.2)*.10;
 float opacity=clamp((wash*density+wetEdge*wash)*u_intensity,0.,1.);float lowerPigment=smoothstep(boundary-.10,boundary+.24,uv.y),upperPigment=smoothstep(.67,1.,uv.y);
 vec3 pigment=mix(u_mist,u_secondary,lowerPigment);pigment=mix(pigment,u_primary,upperPigment*.86);pigment=mix(pigment,u_secondary,clamp((secondWarp.y-.55)*.24,0.,.12));
 gl_FragColor=vec4(mix(u_surface,pigment,opacity),1.);
}`;

export class AstraWatercolorBackdrop{
 readonly mesh:THREE.Mesh;private material:THREE.ShaderMaterial;
 constructor(){this.material=new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG,depthTest:false,depthWrite:false,toneMapped:false,uniforms:{u_edgeSoftness:{value:.18},u_grain:{value:.13},u_intensity:{value:.2},u_mist:{value:new THREE.Color('#07101a')},u_primary:{value:new THREE.Color('#23435F')},u_resolution:{value:new THREE.Vector2(1,1)},u_secondary:{value:new THREE.Color('#102638')},u_speed:{value:.026},u_surface:{value:new THREE.Color('#010204')},u_time:{value:0},u_warp:{value:.92}}});const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));this.mesh=new THREE.Mesh(geometry,this.material);this.mesh.frustumCulled=false;this.mesh.renderOrder=-1000;}
 resize(w:number,h:number){(this.material.uniforms.u_resolution.value as THREE.Vector2).set(w,h);}
 update(time:number){this.material.uniforms.u_time.value=time;}
 dispose(){this.mesh.geometry.dispose();this.material.dispose();}
}
