import * as THREE from 'three';

/** Screen-space attraction layered onto the existing photo shaders, with no resampling. */
export class PhotoBlackHole {
  readonly uniforms = {
    uConsume: { value: -1 },
    uConsumeRect: { value: new THREE.Vector4(1,1,0,0) },
    uConsumeSink: { value: new THREE.Vector2(.7,-.65) },
    uConsumeAspect: { value: 1 },
  };
  private image = new THREE.WebGLRenderTarget(1,1,{depthBuffer:false});
  private bufferSize = new THREE.Vector2();
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private disk: THREE.Mesh<THREE.PlaneGeometry,THREE.ShaderMaterial>;

  constructor() {
    this.disk = new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.ShaderMaterial({
      transparent:true,depthTest:false,depthWrite:false,toneMapped:false,
      uniforms:{...this.uniforms,uViewport:{value:new THREE.Vector2(1,1)},uScene:{value:this.image.texture}},
      vertexShader:'varying vec2 vNdc;void main(){vNdc=position.xy;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader:`varying vec2 vNdc;
        uniform float uConsume;uniform vec2 uConsumeSink;uniform vec2 uViewport;uniform sampler2D uScene;
        void main(){
          float appear=smoothstep(0.,.14,uConsume)*(1.-smoothstep(.9,1.,uConsume));
          vec2 p=(vNdc-uConsumeSink)*uViewport*.5/56.;
          p/=max(.001,appear)*(1.+.045*sin(uConsume*24.));float r=length(p);
          // Sample the live photograph render through a rotating gravitational lens.
          // No bitmap capture: this is the current frame's ordinary GPU render target.
          float influence=exp(-pow((r-1.35)/1.8,2.))*appear;
          float bend=influence*(.18+.035*sin(uConsume*25.+r*3.));
          float twist=influence*.18*sin(uConsume*13.-r*2.);
          vec2 lensDelta=(vNdc-uConsumeSink)*uViewport;
          lensDelta=mat2(cos(twist),-sin(twist),sin(twist),cos(twist))*lensDelta*(1.+bend);
          vec2 sampleUv=(uConsumeSink+lensDelta/uViewport)*.5+.5;
          vec4 background=texture2D(uScene,clamp(sampleUv,vec2(.001),vec2(.999)));
          if(any(lessThan(sampleUv,vec2(0.)))||any(greaterThan(sampleUv,vec2(1.))))background=vec4(0.);

          float halo=exp(-abs(r-1.04)*6.5)*.45;
          float lens=exp(-pow((r-1.02)*26.,2.));
          float tilt=.2+.07*sin(uConsume*9.);
          vec2 tilted=mat2(cos(tilt),-sin(tilt),sin(tilt),cos(tilt))*p;
          float ellipse=length(tilted*vec2(.48,3.3));
          float bands=.72+.28*sin(ellipse*42.-uConsume*58.+atan(tilted.y,tilted.x)*6.);
          float disk=exp(-abs(ellipse-1.)*11.)*bands;
          float arcs=exp(-pow((r-1.28)*16.,2.))*.3;
          float flow=.82+.18*sin(atan(p.y,p.x)*17.-uConsume*48.+r*26.);
          vec3 gold=vec3(1.,.72,.38);
          vec3 color=gold*(halo+disk*flow*.95+arcs)+vec3(1.,.91,.73)*lens;
          float core=1.-smoothstep(.91,.99,r);
          color*=1.-core;
          float alpha=max(core,clamp(halo+disk+arcs+lens,0.,1.))*appear;
          float totalAlpha=alpha+background.a*(1.-alpha);
          if(totalAlpha<.002)discard;
          // The accumulated scene texture contains premultiplied color.
          gl_FragColor=vec4((color*alpha+background.rgb*(1.-alpha))/max(.001,totalAlpha),totalAlpha);
          #include <colorspace_fragment>
        }`,
    }));
    this.disk.frustumCulled=false;
    this.scene.add(this.disk);
  }

  install(material:THREE.ShaderMaterial, particle:boolean) {
    Object.assign(material.uniforms,this.uniforms);
    const declaration=`uniform float uConsume;uniform vec4 uConsumeRect;uniform vec2 uConsumeSink;uniform float uConsumeAspect;varying float vConsumed;
    `;
    const end=material.vertexShader.lastIndexOf('}');
    // Both the textured mesh and particles use corresponding image coordinates.
    const uv=particle?'photoUv':'uv';
    material.vertexShader=declaration+material.vertexShader.slice(0,end)+`
      vConsumed=0.;
      if(uConsume>=0.){
        vec2 imageUv=${uv};
        float delay=(1.-imageUv.x+imageUv.y)*.10;
        float pull=smoothstep(0.,1.,clamp((uConsume-delay${particle?'-aSeeds.z*.12':''})/${particle?'.64':'.76'},0.,1.));
        vConsumed=smoothstep(delay,delay+.22,uConsume);
        vec2 start=gl_Position.xy/gl_Position.w;
        start=start*uConsumeRect.xy+uConsumeRect.zw;
        vec2 delta=(start-uConsumeSink)*vec2(uConsumeAspect,1.);
        float angle=${particle?'(1.1+aSeeds.x*3.4)':'1.8'}*pull*pull;
        delta=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*delta;
        vec2 flight=delta*(1.-pull);
        ${particle?`float spread=sin(pull*3.14159265)*smoothstep(0.,.18,pull);
        float driftAngle=aSeeds.y*6.283185+pull*(2.+aSeeds.x*4.);
        flight+=vec2(cos(driftAngle),sin(driftAngle))*(.12+aSeeds.w*.34)*spread;
        flight+=normalize(vec2(-delta.y,delta.x)+vec2(.0001))*(aSeeds.x-.5)*.5*spread;`:''}
        vec2 end=uConsumeSink+flight/vec2(uConsumeAspect,1.);
        gl_Position=vec4(end,0.,1.);
        ${particle?`vAlpha=mix(vAlpha,uOpacity*texture2D(uReveal,photoUv).g,vConsumed)*(1.-smoothstep(.88,1.,pull));gl_PointSize*=mix(1.,.25,pull);`:''}
      }
    }`;
    if(!particle){
      material.fragmentShader='varying float vConsumed;\n'+material.fragmentShader;
      const end=material.fragmentShader.lastIndexOf('}');
      material.fragmentShader=material.fragmentShader.slice(0,end)+'gl_FragColor.a*=1.-vConsumed;'+material.fragmentShader.slice(end);
    }else{
      material.fragmentShader='uniform float uConsume;\n'+material.fragmentShader;
      const end=material.fragmentShader.lastIndexOf('}');
      // The normal particle pass writes display colors directly. Decode them only
      // for the linear lens buffer so starting absorption does not change exposure.
      material.fragmentShader=material.fragmentShader.slice(0,end)+`if(uConsume>=0.){
        vec3 c=gl_FragColor.rgb;
        gl_FragColor.rgb=mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(vec3(.04045),c));
      }`+material.fragmentShader.slice(end);
    }
    material.needsUpdate=true;
  }

  begin(rect:DOMRect) {
    const w=window.innerWidth,h=window.innerHeight;
    this.uniforms.uConsumeAspect.value=w/h;
    this.uniforms.uConsumeRect.value.set(rect.width/w,rect.height/h,(rect.left+rect.width/2)/w*2-1,1-(rect.top+rect.height/2)/h*2);
    this.uniforms.uConsumeSink.value.set(1-Math.min(165,w*.2)/w*2,-1+Math.min(140,h*.23)/h*2);
    this.disk.material.uniforms.uViewport.value.set(w,h);
    this.uniforms.uConsume.value=0;
  }
  async prepare(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera){
    const ratio=renderer.getPixelRatio();
    this.image.setSize(Math.round(window.innerWidth*ratio),Math.round(window.innerHeight*ratio));
    renderer.setRenderTarget(this.image);
    renderer.clear();
    try { await renderer.compileAsync(scene,camera); }
    finally { renderer.setRenderTarget(null); }
    await renderer.compileAsync(this.scene,this.camera);
  }
  render(renderer:THREE.WebGLRenderer,progress:number,scene:THREE.Scene,camera:THREE.Camera){
    this.uniforms.uConsume.value=progress;
    renderer.getDrawingBufferSize(this.bufferSize);
    if(this.image.width!==this.bufferSize.x||this.image.height!==this.bufferSize.y)this.image.setSize(this.bufferSize.x,this.bufferSize.y);
    renderer.setRenderTarget(this.image);
    renderer.render(scene,camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene,this.camera);
  }
  dispose(){this.disk.geometry.dispose();this.disk.material.dispose();this.image.dispose();}
}
