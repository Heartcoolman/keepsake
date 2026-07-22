async function drawScaled(source: Blob, maxDim: number): Promise<OffscreenCanvas> {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas;
}

/** Downscale to ≤maxDim JPEG — the working image sent to the API once and stored locally. */
export async function downscaleImage(source: Blob, maxDim = 1024, quality = 0.8): Promise<Blob> {
  const canvas = await drawScaled(source, maxDim);
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

/** Small thumb for timeline cards. */
export async function makeThumb(source: Blob, maxDim = 640): Promise<Blob> {
  const canvas = await drawScaled(source, maxDim);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
}
