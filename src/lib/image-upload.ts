// Client-side selfie prep for the canvasser fighter pipeline. Downscales a
// picked photo to a sane max dimension and re-encodes as JPEG so the upload
// stays small (well under the 8MB server cap) and Gemini gets a clean square-ish
// face. Runs entirely in the browser — the raw file never leaves until we hand
// the compact data URL to the upload server fn.

export async function fileToResizedDataUrl(
  file: File,
  maxDim = 1024,
  quality = 0.85,
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }
  const bitmap = await loadBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process the image.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  if (!dataUrl.startsWith("data:image/")) throw new Error("Couldn't read that image.");
  return dataUrl;
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap is fastest and handles EXIF orientation on modern
  // browsers; fall back to an <img> + object URL where it isn't available.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through to the <img> path
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Couldn't load that image."));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
