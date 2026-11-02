import { PhotoBlackHole } from "../three/PhotoBlackHole";
import type { SpherePhotoBridge } from "../three/SpherePhotoBridge";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  PHOTO_PARTICLE_SETTINGS_EVENT,
  type PhotoParticleSettings,
} from "../core/PhotoParticleSettings";
import { V14_PLANE_WIDTH } from "../three/PhotoParticleField";
import { takeDetailPhoto } from '../three/DetailPhotoResources';
import { DetailPhotoMorph, detailPhotoMaterial } from "../three/DetailPhotoMorph";
import { PhotoParticleV14 } from "../three/PhotoParticleV14Material";

/** Persistent V14 particle photograph used as the default detail presentation. */
export default function ParticleDetailCanvas({ photoId, active, onReady, fit100, frozen, onError, openingProgress, bridge, fitPadding = 1, deleting=false, onConsumed, hidden=false }: { deleting?:boolean;onConsumed?:()=>void;hidden?:boolean; fitPadding?: number; bridge?: SpherePhotoBridge; photoId: number; active: boolean; onReady?: () => void; fit100?: boolean; frozen?: boolean; onError?: (message:string)=>void; openingProgress?:()=>number }) {
  const deleteRef=useRef(deleting);deleteRef.current=deleting;
  const consumedRef=useRef(onConsumed);consumedRef.current=onConsumed;
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const readyRef = useRef(onReady); readyRef.current = onReady;
  const fitRef = useRef(fit100); fitRef.current = fit100;
  const frozenRef=useRef(frozen); frozenRef.current=frozen;
  const errorRef=useRef(onError); errorRef.current=onError;
  const openingRef=useRef(openingProgress); openingRef.current=openingProgress;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "particle-detail-canvas";
    host.appendChild(canvas);
    if (bridge) Object.assign(canvas.style, {position:"fixed",left:"0",top:"0",width:"100vw",height:"100vh"});

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 60);
    const root = new THREE.Group();
    scene.add(root);

    let particles: PhotoParticleV14 | null = null;
    let frame = 0;
    let disposed = false;
    let lastTime = performance.now();
    let bridgeFullscreen = !!bridge;
    let baseDistance = 7;
    let zoom = 1;
    let targetZoom = 1;
    let original: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
    let texture: THREE.Texture | null = null;
    let textureBitmap: ImageBitmap | null = null;
    const morph = new DetailPhotoMorph();
    const blackHole=new PhotoBlackHole();
    let consuming=false,consumeTime=0,consumed=false;
    let renderReady = false;
    let previousFit = fitRef.current;
    let readySent = false;
    let dragging = false;
    let pointerId = -1;
    let lastX = 0;
    let lastY = 0;
    let openingComplete=false;
    const raycaster = new THREE.Raycaster();

    const fitCamera = () => {
      if(consuming)return;
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(bridgeFullscreen ? window.innerWidth : width, bridgeFullscreen ? window.innerHeight : height, false);
      if (bridge) bridge.setRect(bridgeFullscreen ? host.getBoundingClientRect() : new DOMRect(0,0,width,height), bridgeFullscreen ? window.innerWidth : width, bridgeFullscreen ? window.innerHeight : height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (particles) {
        const planeHeight = V14_PLANE_WIDTH * particles.field.height / particles.field.width;
        const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
        const vertical = planeHeight / (2 * tan);
        const horizontal = V14_PLANE_WIDTH / (2 * tan * camera.aspect);
        baseDistance = Math.max(vertical, horizontal) * fitPadding;
      }
      camera.position.z = baseDistance * zoom;
      particles?.setPixelRatio(renderer.getPixelRatio());
    };

    const resetView = () => {
      root.rotation.set(0, 0, 0);
      zoom = targetZoom = 1;
      camera.position.x = camera.position.y = 0;
      fitCamera();
    };

    const setParticlePointer = (clientX: number, clientY: number) => {
      if (!particles || dragging) return;
      const bounds = host.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - bounds.left) / bounds.width) * 2 - 1,
        -((clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      root.updateMatrixWorld(true);
      const inverse = root.matrixWorld.clone().invert();
      const localOrigin = raycaster.ray.origin.clone().applyMatrix4(inverse);
      const localDirection = raycaster.ray.direction.clone().transformDirection(inverse);
      if (Math.abs(localDirection.z) < 1e-5) return;
      const distance = -localOrigin.z / localDirection.z;
      if (distance <= 0) { particles.setPointer(null); return; }
      const hit = localOrigin.addScaledVector(localDirection, distance);
      particles.setPointer(new THREE.Vector2(hit.x, hit.y));
    };

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      particles?.setPointer(null);
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragging && event.pointerId === pointerId) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        if(zoom<0.98){
          const units = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, host.clientHeight);
          camera.position.x -= dx * units;
          camera.position.y += dy * units;
        }else if(activeRef.current){
          root.rotation.y=THREE.MathUtils.clamp(root.rotation.y+dx*.0025,-.28,.28);
          root.rotation.x=THREE.MathUtils.clamp(root.rotation.x+dy*.0025,-.20,.20);
        }
        lastX = event.clientX;
        lastY = event.clientY;
      } else {
        setParticlePointer(event.clientX, event.clientY);
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      dragging = false;
      pointerId = -1;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      setParticlePointer(event.clientX, event.clientY);
    };
    const onPointerLeave = () => { if (!dragging) particles?.setPointer(null); };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = host.getBoundingClientRect();
      zoomAnchor.set((event.clientX-bounds.left)/bounds.width*2-1, 1-(event.clientY-bounds.top)/bounds.height*2);
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      targetZoom = THREE.MathUtils.clamp(targetZoom * Math.exp(THREE.MathUtils.clamp(delta, -160, 160) * 0.0015), 0.125, 1.5);
    };
    const zoomAnchor = new THREE.Vector2();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", resetView);
    const observer = new ResizeObserver(fitCamera);
    observer.observe(host);
    fitCamera();

    let settings: PhotoParticleSettings | null = null;
    const onSettings = (event: Event) => {
      if (!settings) return;
      const detail = (event as CustomEvent<Partial<PhotoParticleSettings> & { key?: keyof PhotoParticleSettings; value?: number }>).detail;
      settings = detail.key && Number.isFinite(detail.value)
        ? { ...settings, [detail.key]: detail.value as number }
        : { ...settings, ...detail };
      particles?.applySettings(settings);
    };
    window.addEventListener(PHOTO_PARTICLE_SETTINGS_EVENT, onSettings);

    void takeDetailPhoto(photoId).then(async resource => {
      if(disposed){resource.bitmap.close();return;}
      const {field,bitmap}=resource;
      settings=resource.settings;
      textureBitmap=bitmap;
      particles=new PhotoParticleV14(field,settings!);
      particles.setMorph(1);
      particles.setCurvature(0);
      particles.setDetailReveal(morph.texture);
      if (bridge) bridge.install(particles.points);
      root.add(particles.points);
      texture=new THREE.Texture(bitmap);texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;
      original=new THREE.Mesh(new THREE.PlaneGeometry(V14_PLANE_WIDTH,V14_PLANE_WIDTH*field.height/field.width,96,96),detailPhotoMaterial(texture,morph.texture));
      if (bridge) {
        const mat = original.material;
        mat.uniforms.uFullRect = {value:new THREE.Vector4()};
        const end = mat.vertexShader.lastIndexOf("}");
        mat.vertexShader = "uniform vec4 uFullRect;\n" + mat.vertexShader.slice(0,end) + "gl_Position.xy = gl_Position.xy * uFullRect.xy + uFullRect.zw * gl_Position.w;}";
      }
      bridge?.installPhoto(original);
      blackHole.install(particles.points.material,true);
      blackHole.install(original.material,false);
      original.position.z=-.001;
      root.add(original);
      resetView();
      try {
        await renderer.compileAsync(scene,camera);
        await blackHole.prepare(renderer,scene,camera);
        if(!disposed) { renderReady=true; if(bridge)bridge.ready=true; }
      } catch(error) {if(!disposed) errorRef.current?.(String(error));}
    }).catch(error=>{if(!disposed)errorRef.current?.(String(error));});

    const animate = (now: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      if(!renderReady){lastTime=now;return;}
      const dt = Math.min(0.033, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      if(deleteRef.current&&!consuming){
        consuming=true;particles?.setPointer(null);
        const rect=host.getBoundingClientRect();
        blackHole.begin(rect);
        // Keep the current camera and mask. Only the render surface expands to allow
        // particles to leave the photograph and enter the corner of the window.
        if(bridge){bridge.setRect(new DOMRect(0,0,rect.width,rect.height),rect.width,rect.height);original?.material.uniforms.uFullRect?.value.set(1,1,0,0);}
        document.body.appendChild(canvas);
        Object.assign(canvas.style,{position:'fixed',left:'0',top:'0',width:'100vw',height:'100vh',zIndex:'130',pointerEvents:'none'});
        renderer.setSize(window.innerWidth,window.innerHeight,false);
      }
      if(consuming){
        consumeTime+=dt;
        const progress=Math.min(1,consumeTime/2.65);
        blackHole.uniforms.uConsume.value=progress;
        particles?.update(dt,now/1000);
        blackHole.render(renderer,progress,scene,camera);
        if(progress===1&&!consumed){consumed=true;consumedRef.current?.();}
        return;
      }
      if (previousFit !== fitRef.current) { previousFit = fitRef.current; targetZoom = previousFit ? 0.5 : 1; zoomAnchor.set(0,0); }
      const nextZoom = THREE.MathUtils.lerp(zoom, targetZoom, 1-Math.exp(-dt*14));
      const halfHeight = baseDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
      camera.position.x += zoomAnchor.x * halfHeight * camera.aspect * (zoom-nextZoom);
      camera.position.y += zoomAnchor.y * halfHeight * (zoom-nextZoom);
      zoom = nextZoom; camera.position.z = baseDistance * zoom;
      if(targetZoom>=.99){
        camera.position.x=THREE.MathUtils.damp(camera.position.x,0,12,dt);
        camera.position.y=THREE.MathUtils.damp(camera.position.y,0,12,dt);
      }
      if (bridge) {
        bridge.tick(dt);
        const fullscreen = bridge.progress < 1 || bridge.closing;
        if (fullscreen !== bridgeFullscreen) {
          bridgeFullscreen = fullscreen;
          Object.assign(canvas.style, fullscreen ? {position:"fixed",left:"0",top:"0",width:"100vw",height:"100vh"} : {position:"",left:"",top:"",width:"100%",height:"100%"});
          fitCamera();
        }
        bridge.setRect(fullscreen ? host.getBoundingClientRect() : new DOMRect(0,0,host.clientWidth,host.clientHeight), fullscreen ? window.innerWidth : host.clientWidth, fullscreen ? window.innerHeight : host.clientHeight);
        if (bridge.progress < 1 || bridge.closing) morph.seekOpening(bridge.fromPlane ? bridge.progress : 1, particles!.field.width / particles!.field.height);
        // 原图模式仍用原有详情渲染，只在过渡完成后允许显示。
        if (original) {
          original.visible = bridge.fromPlane || bridge.progress >= 1;
          const rect = host.getBoundingClientRect();
          if (!fullscreen) original.material.uniforms.uFullRect.value.set(1,1,0,0);
          else original.material.uniforms.uFullRect.value.set(rect.width/window.innerWidth,rect.height/window.innerHeight,(rect.left+rect.width/2)/window.innerWidth*2-1,1-(rect.top+rect.height/2)/window.innerHeight*2);
        }
      }
      if(!frozenRef.current && !(bridge && (bridge.progress < 1 || bridge.closing))){
        const aspect=particles ? particles.field.width/particles.field.height : 1;
        if(!openingComplete && openingRef.current){
          const progress=openingRef.current();
          morph.seekOpening(progress,aspect);
          openingComplete=progress>=1;
        }else{
          morph.setTarget(activeRef.current);
          morph.update(dt,aspect);
        }
      }
      if (!activeRef.current || frozenRef.current) particles?.setPointer(null);
      particles?.update(dt, now / 1000);
      renderer.render(scene, camera);
      if (original && !readySent) { readySent = true; readyRef.current?.(); }
    };
    frame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener(PHOTO_PARTICLE_SETTINGS_EVENT, onSettings);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", resetView);
      if (particles) {
        root.remove(particles.points);
        particles.dispose();
      }
      renderer.forceContextLoss();
      renderer.dispose();
      original?.geometry.dispose(); original?.material.dispose(); texture?.dispose();
      textureBitmap?.close(); morph.dispose(); blackHole.dispose();
      canvas.remove();
    };
  }, [photoId]);

  return <div className="particle-detail-host is-active" ref={hostRef} style={{visibility:hidden&&!deleting?"hidden":"visible"}} />;
}
