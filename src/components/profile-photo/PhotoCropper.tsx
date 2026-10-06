// Circle-crop + confirm step for the blocking profile-photo gate (owner spec
// 2026-10-06 §3). Pure canvas — no cropper dependency. The player drags to pan
// and uses the zoom slider; a circular mask previews exactly how the face will
// sit in the avatar. "Looks good" exports a square JPEG compressed to under
// ~300 KB (the source the Gemini fighter is drawn from); "Retake" bounces back
// to the picker. Pointer events cover touch (iPhone Safari / Android Chrome)
// and mouse alike.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { NeonButton } from "@/components/arcade";
import { RotateCcw, ZoomIn } from "lucide-react";

const EXPORT_SIZE = 512; // px square — plenty for a face reference, tiny on disk
const MAX_BYTES = 300 * 1024;

/** Approx decoded byte size of a base64 data URL. */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** Step JPEG quality down until the encoded image fits under maxBytes. */
function canvasToJpegUnder(canvas: HTMLCanvasElement, maxBytes: number): string {
  const qualities = [0.92, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
  let last = canvas.toDataURL("image/jpeg", qualities[0]);
  for (const q of qualities) {
    const url = canvas.toDataURL("image/jpeg", q);
    last = url;
    if (dataUrlBytes(url) <= maxBytes) return url;
  }
  return last; // smallest we could manage
}

export function PhotoCropper({
  imageSrc,
  onConfirm,
  onRetake,
  busy = false,
}: {
  imageSrc: string;
  onConfirm: (dataUrl: string) => void;
  onRetake: () => void;
  busy?: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [stageSize, setStageSize] = useState(288);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Measure the stage so the crop math is in real pixels (responsive / phone).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageSize(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load the picked image.
  useEffect(() => {
    setLoadError(false);
    const image = new Image();
    image.onload = () => {
      imgRef.current = image;
      setImg(image);
    };
    image.onerror = () => setLoadError(true);
    image.src = imageSrc;
  }, [imageSrc]);

  const baseScale = img ? stageSize / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const displayScale = baseScale * zoom;
  const drawW = img ? img.naturalWidth * displayScale : 0;
  const drawH = img ? img.naturalHeight * displayScale : 0;

  // Keep the image covering the stage — no empty gaps inside the circle.
  const clamp = (o: { x: number; y: number }) => ({
    x: Math.min(0, Math.max(stageSize - drawW, o.x)),
    y: Math.min(0, Math.max(stageSize - drawH, o.y)),
  });

  // Re-center / re-clamp whenever the image or zoom changes.
  useEffect(() => {
    if (!img) return;
    setOffset(clamp({ x: (stageSize - drawW) / 2, y: (stageSize - drawH) / 2 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, zoom, stageSize]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!img) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    setOffset(clamp({ x: drag.current.ox + dx, y: drag.current.oy + dy }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const handleConfirm = () => {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = EXPORT_SIZE;
    canvas.height = EXPORT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Map the square stage back to a source region on the natural image.
    const srcX = -offset.x / displayScale;
    const srcY = -offset.y / displayScale;
    const srcSize = stageSize / displayScale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, EXPORT_SIZE, EXPORT_SIZE);
    onConfirm(canvasToJpegUnder(canvas, MAX_BYTES));
  };

  if (loadError) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-destructive">That image wouldn&apos;t load. Try another.</p>
        <NeonButton tone="kombat-gold" onClick={onRetake}>
          <RotateCcw className="h-4 w-4" /> Pick another
        </NeonButton>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Square crop stage with a circular mask overlay */}
      <div
        ref={stageRef}
        className="relative mx-auto aspect-square w-full max-w-[300px] touch-none overflow-hidden rounded-xl border border-kombat-gold/40 bg-black select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ cursor: img ? "grab" : "default" }}
      >
        {img && (
          <img
            src={imageSrc}
            alt="Crop preview"
            draggable={false}
            className="pointer-events-none absolute left-0 top-0 max-w-none"
            style={{
              width: drawW,
              height: drawH,
              transform: `translate(${offset.x}px, ${offset.y}px)`,
            }}
          />
        )}
        {/* Circular guide: a dimming ring outside the inscribed circle. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl"
          style={{
            boxShadow: "inset 0 0 0 9999px rgba(0,0,0,0.55)",
            // Punch a circular hole in the dim overlay.
            WebkitMaskImage:
              "radial-gradient(circle at center, transparent 0, transparent calc(50% - 2px), #000 calc(50% - 1px))",
            maskImage:
              "radial-gradient(circle at center, transparent 0, transparent calc(50% - 2px), #000 calc(50% - 1px))",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full border-2 border-kombat-gold/70"
        />
      </div>

      {/* Zoom */}
      <label className="flex items-center gap-3 px-1">
        <ZoomIn className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label="Zoom"
          className="h-2 w-full cursor-pointer accent-kombat-gold"
        />
      </label>
      <p className="text-center text-[11px] text-muted-foreground">
        Drag to position · pinch or slide to zoom
      </p>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onRetake}
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-4 font-display text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="h-4 w-4" /> Retake
        </button>
        <NeonButton tone="kombat-red" disabled={busy || !img} onClick={handleConfirm}>
          {busy ? "Saving…" : "Looks good"}
        </NeonButton>
      </div>
    </div>
  );
}
