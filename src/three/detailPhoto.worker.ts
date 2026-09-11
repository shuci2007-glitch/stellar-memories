import { sampleV14Pixels, V14_MAX_WIDTH } from "./PhotoParticleField";
import type { QualityTier } from "../core/types";

self.onmessage = async (event: MessageEvent<{url:string;tier:QualityTier}>) => {
  let bitmap: ImageBitmap | undefined;
  try {
    const response = await fetch(event.data.url);
    if (!response.ok) throw new Error(`照片读取失败 (${response.status})`);
    bitmap = await createImageBitmap(await response.blob());
    const scale = Math.min(1, V14_MAX_WIDTH / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(2, Math.round(bitmap.width * scale));
    const height = Math.max(2, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", {willReadFrequently:true})!;
    context.drawImage(bitmap,0,0,width,height);
    const step = event.data.tier === "ultra" ? 1 : event.data.tier === "low" ? 4 : 2;
    const field = sampleV14Pixels(context.getImageData(0,0,width,height).data,width,height,step);
    // ImageBitmap textures ignore Texture.flipY; orient on the worker before upload.
    const textureScale=Math.min(1,4096/Math.max(bitmap.width,bitmap.height));
    const textureBitmap = await createImageBitmap(bitmap, {imageOrientation:"flipY",resizeWidth:Math.max(1,Math.round(bitmap.width*textureScale)),resizeHeight:Math.max(1,Math.round(bitmap.height*textureScale))});
    const transfer: Transferable[] = [textureBitmap];
    for (const value of Object.values(field)) if (value instanceof Float32Array) transfer.push(value.buffer);
    self.postMessage({field, bitmap:textureBitmap}, {transfer});
  } catch (error) {
    self.postMessage({error: String(error)});
  } finally { bitmap?.close(); }
};
