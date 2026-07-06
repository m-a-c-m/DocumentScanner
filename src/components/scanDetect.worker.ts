/// <reference lib="webworker" />
// Runs the live document-edge detection off the main thread. The pure-JS
// detector (scanner.ts) is cheap per call, but during heavy camera movement
// every frame is different, so there's no idle frame to skip — the per-tick
// cost was piling up on the main thread and making the whole page stutter.
// Moving it here means detection can never block rendering or touch input,
// no matter how much work a given frame needs.
import { detectCornersLive, detectCornersConfirm } from "./scanner";

let scratch: OffscreenCanvas | null = null;

interface Req { id: number; mode: "live" | "confirm"; bitmap: ImageBitmap; sw: number; sh: number; }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, mode, bitmap, sw, sh } = e.data;
  if (!scratch) scratch = new OffscreenCanvas(1, 1);
  let result = null;
  try {
    result = mode === "confirm"
      ? detectCornersConfirm(bitmap, sw, sh, scratch)
      : detectCornersLive(bitmap, sw, sh, scratch);
  } catch {
    result = null;
  } finally {
    bitmap.close();
  }
  (self as unknown as Worker).postMessage({ id, result });
};
