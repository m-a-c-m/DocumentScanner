"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FiCamera, FiUpload, FiRotateCw, FiTrash2, FiDownload, FiFileText,
  FiCheck, FiX, FiChevronUp, FiChevronDown, FiZap, FiCopy, FiLoader, FiEdit2, FiSun, FiImage, FiArrowLeft,
} from "react-icons/fi";
import { autoDetectCorners, warpDocument, applyScanFilter, orderCorners, type Pt, type ScanFilter, type FrameDetection } from "./scanner";
import { idbAllPages, idbPutPage, idbDeletePage, idbSetOrder, idbClear } from "./scannerStore";

interface Props { locale?: string; }

interface Page {
  id: string;
  srcUrl: string;
  corners: Pt[];
  filter: ScanFilter;
  out: HTMLCanvasElement;
  thumb: string;
}

interface Editing { srcUrl: string; corners: Pt[] | null; filter: ScanFilter; editId?: string; }

const FILTERS: ScanFilter[] = ["magic", "color", "gray", "bw", "whiteboard"];

function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.95): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

// A plain <a download> pointed at a data: URL is unreliable on iOS Safari — it
// just shows the top loading bar and does nothing, since Safari tries to
// "navigate" to it instead of saving it. Web Share (with files) is what
// actually works there, opening the native Save Image / Save to Files sheet;
// everywhere else falls back to the normal blob-URL anchor download.
async function downloadOrShareBlob(blob: Blob, filename: string) {
  const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
  if (nav.share && nav.canShare) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (nav.canShare({ files: [file] })) { await nav.share({ files: [file] }); return; }
    } catch {
      return; // user cancelled or share failed — don't also force a download on top of it
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Green while just detected, warming to amber as the hold-steady countdown
// nears auto-capture — a visible cue that says "stay still, almost there".
function holdColor(t: number): string {
  const g = [34, 197, 94], y = [250, 204, 21];
  const c = g.map((v, i) => Math.round(v + (y[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Corner-based perspective correction has no idea which side of the flattened
// rectangle is "up" — it only knows the geometry. A document lying rotated on
// the table relative to how the phone is held comes out perfectly flat but
// sideways or upside down. Tesseract's OSD (orientation & script detection) is
// a cheap, separate pass from full OCR — a few hundred ms once its (small,
// legacy-engine) data is cached — that reads which way the text actually runs
// and returns how many degrees to rotate clockwise to fix it.
async function detectOrientationDegrees(canvas: HTMLCanvasElement): Promise<number> {
  try {
    const maxDim = 700;
    const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(canvas.width * scale));
    small.height = Math.max(1, Math.round(canvas.height * scale));
    small.getContext("2d")!.drawImage(canvas, 0, 0, small.width, small.height);
    const url = small.toDataURL("image/jpeg", 0.85);

    const Tesseract = (await import("tesseract.js")).default;
    // Never let a slow/unreachable CDN fetch of the OSD model hold up saving a
    // page — worst case we just skip auto-rotation, same as if this feature
    // didn't run at all. The manual "Girar" button is always there regardless.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000));
    const result = await Promise.race([Tesseract.detect(url).catch(() => null), timeout]);
    if (!result) return 0;
    const { orientation_degrees, orientation_confidence } = result.data;
    if (orientation_degrees == null || orientation_confidence == null) return 0;
    // Conservative bar — a wrong auto-rotate (flipping an already-correct scan)
    // is a worse experience than occasionally missing a real one.
    if (orientation_confidence < 1.5) return 0;
    return orientation_degrees;
  } catch {
    return 0;
  }
}

function rotateCanvasDegrees(canvas: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  if (!degrees) return canvas;
  const swap = degrees === 90 || degrees === 270;
  const out = document.createElement("canvas");
  out.width = swap ? canvas.height : canvas.width;
  out.height = swap ? canvas.width : canvas.height;
  const ctx = out.getContext("2d")!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

export default function DocumentScanner({ locale = "es" }: Props) {
  const isEs = locale === "es";

  const [pages, setPages] = useState<Page[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraErr, setCameraErr] = useState("");
  const [busy, setBusy] = useState("");
  const [ocr, setOcr] = useState<{ text: string; prog: number; busy: boolean } | null>(null);
  const [dragCorner, setDragCorner] = useState<number | null>(null);
  const [autoShot, setAutoShot] = useState(true);
  const [docDetected, setDocDetected] = useState(false);
  const [pageSize, setPageSize] = useState<"auto" | "a4" | "letter">("auto");
  const [searchablePdf, setSearchablePdf] = useState(false);
  const [pdfErr, setPdfErr] = useState("");
  const [scanName, setScanName] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [captureHold, setCaptureHold] = useState(0);
  const [flash, setFlash] = useState(false);
  const [restoredCount, setRestoredCount] = useState(0);
  const [portalMobile, setPortalMobile] = useState(false);
  const [mobileTab, setMobileTab] = useState<"camera" | "edit" | "gallery">("camera");

  const baseName = scanName.trim().replace(/[^a-zA-Z0-9-_ ]/g, "").trim().replace(/\s+/g, "-") || "scan";

  // The tool page wraps this component in a `.glass` card (backdrop-filter),
  // and any ancestor with a transform/backdrop-filter creates a new
  // containing block for `position: fixed` descendants — so the full-screen
  // mobile camera view was pinning itself to that card, not the real screen,
  // which is why it rendered as if still inside the page instead of over it.
  // Portalling it straight to <body> when active on mobile sidesteps that
  // entirely. Desktop never portals — it stays the normal inline card.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setPortalMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Remember auto-capture, page size and the last filter picked across
  // visits — a returning user shouldn't have to redo the same setup every
  // single time. Read once on mount; anything unset or corrupt just falls
  // back to the existing defaults.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("docScannerPrefs");
      if (!raw) return;
      const p = JSON.parse(raw) as { autoShot?: boolean; pageSize?: "auto" | "a4" | "letter"; filter?: ScanFilter };
      if (typeof p.autoShot === "boolean") setAutoShot(p.autoShot);
      if (p.pageSize === "auto" || p.pageSize === "a4" || p.pageSize === "letter") setPageSize(p.pageSize);
      if (p.filter && FILTERS.includes(p.filter)) lastFilterRef.current = p.filter;
    } catch { /* ignore corrupt/missing prefs */ }
  }, []);

  const persistPrefs = useCallback((overrides: Partial<{ autoShot: boolean; pageSize: "auto" | "a4" | "letter"; filter: ScanFilter }> = {}) => {
    try {
      localStorage.setItem("docScannerPrefs", JSON.stringify({
        autoShot, pageSize, filter: lastFilterRef.current, ...overrides,
      }));
    } catch { /* private browsing / storage disabled — preferences just won't persist */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoShot, pageSize]);

  useEffect(() => { persistPrefs(); }, [autoShot, pageSize, persistPrefs]);

  // Switching tabs reuses the same scrollable container for whichever
  // section is active — without this, a tab you switch to inherits whatever
  // scroll offset was left over from the PREVIOUS tab, so it can open already
  // scrolled halfway down instead of at the top.
  useEffect(() => {
    if (mobileScrollRef.current) mobileScrollRef.current.scrollTop = 0;
  }, [mobileTab]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mobileScrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editImgRef = useRef<HTMLImageElement>(null);
  const editBoxRef = useRef<HTMLDivElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const loupeBoxRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<string[]>([]);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const detectWorkerRef = useRef<Worker | null>(null);
  const detectReqIdRef = useRef(0);
  const detectPendingRef = useRef<Map<number, (r: FrameDetection | null) => void>>(new Map());
  const liveRef = useRef<number | null>(null);
  const stableRef = useRef(0);
  const lastQuadRef = useRef<Pt[] | null>(null);
  const lastGoodQuadRef = useRef<Pt[] | null>(null);
  const missStreakRef = useRef(0);
  const sharpAvgRef = useRef(0);
  const capturedRef = useRef(false);
  const touchedRef = useRef(false);
  const lastFilterRef = useRef<ScanFilter>("magic");

  // The pure-JS detector runs in a worker so it never blocks the main thread —
  // during heavy camera movement every frame differs, so there's no idle frame
  // to skip, and doing that work inline was what made the UI stutter and the
  // live overlay go erratic the longer you kept moving the camera around.
  useEffect(() => {
    const w = new Worker(new URL("./scanDetect.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ id: number; result: FrameDetection | null }>) => {
      const resolve = detectPendingRef.current.get(e.data.id);
      if (resolve) { detectPendingRef.current.delete(e.data.id); resolve(e.data.result); }
    };
    detectWorkerRef.current = w;
    return () => { w.terminate(); detectWorkerRef.current = null; detectPendingRef.current.clear(); };
  }, []);

  const detectInWorker = useCallback((mode: "live" | "confirm", bitmap: ImageBitmap, sw: number, sh: number): Promise<FrameDetection | null> => {
    return new Promise((resolve) => {
      const w = detectWorkerRef.current;
      if (!w) { bitmap.close(); resolve(null); return; }
      const id = ++detectReqIdRef.current;
      detectPendingRef.current.set(id, resolve);
      w.postMessage({ id, mode, bitmap, sw, sh }, [bitmap]);
    });
  }, []);

  // Keep a live ref of pages so handlers can read the current list without stale closures.
  const pagesRef = useRef<Page[]>([]);
  useEffect(() => { pagesRef.current = pages; }, [pages]);

  // Restore scanned pages saved in IndexedDB so you don't lose them on reload/close.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await idbAllPages();
      if (cancelled || !stored.length) return;
      const rebuilt = await Promise.all(stored.map((s) => new Promise<Page | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext("2d")?.drawImage(img, 0, 0);
          resolve({ id: s.id, srcUrl: s.srcUrl, corners: s.corners, filter: s.filter, out: c, thumb: s.thumb });
        };
        img.onerror = () => resolve(null);
        img.src = s.out;
      })));
      const valid = rebuilt.filter((p): p is Page => !!p);
      if (!cancelled) { setPages(valid); if (valid.length) setRestoredCount(valid.length); }
    })();
    return () => { cancelled = true; };
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
    setTorchOn(false);
    setTorchSupported(false);
    setCaptureHold(0);
    setFlash(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // The mobile 3-tab shell (Camera/Edit/Gallery) is a fixed full-screen
  // takeover for the whole scanning session, not just the live video — lock
  // the page behind it so it can't scroll underneath and jump position once
  // the shell closes. `overflow: hidden` alone does NOT reliably stop
  // touch/rubber-band scrolling on iOS Safari (a known long-standing quirk) —
  // the fix is to also pin the body itself with `position: fixed` at its
  // current scroll offset, then restore that exact scroll position on close.
  // Gated on `cameraOn` alone (matches showMobileShell) — Edit and Gallery are
  // tabs INSIDE the same fixed shell now, not separate inline views, so the
  // lock has to span the whole session, only releasing once the shell itself
  // closes (camera stopped). Desktop never portals, so this only ever fires
  // below the sm breakpoint.
  useEffect(() => {
    if (!cameraOn || typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 639px)").matches) return;
    const scrollY = window.scrollY;
    const body = document.body.style;
    const prev = { position: body.position, top: body.top, left: body.left, right: body.right, width: body.width, overflow: body.overflow };
    body.position = "fixed";
    body.top = `-${scrollY}px`;
    body.left = "0";
    body.right = "0";
    body.width = "100%";
    body.overflow = "hidden";
    return () => {
      body.position = prev.position;
      body.top = prev.top;
      body.left = prev.left;
      body.right = prev.right;
      body.width = prev.width;
      body.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [cameraOn]);

  // Re-attach the live stream whenever the <video> is (re)mounted — e.g. after
  // returning from the edit view on desktop, or switching back to the Camera
  // tab on mobile (the <video> element unmounts entirely when another tab is
  // active) — so the preview never goes black.
  useEffect(() => {
    if (cameraOn && !editing && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [cameraOn, editing, mobileTab]);

  const openCamera = async () => {
    setCameraErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
      setMobileTab("camera");
      const track = stream.getVideoTracks()[0];
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const caps = track.getCapabilities?.() as any;
        setTorchSupported(!!caps?.torch);
      } catch { setTorchSupported(false); }
    } catch {
      setCameraErr(isEs ? "No se pudo abrir la cámara. Sube una imagen en su lugar." : "Couldn't open the camera. Upload an image instead.");
    }
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as any] });
      setTorchOn((t) => !t);
    } catch { /* unsupported on this device */ }
  };

  const startEdit = (srcUrl: string, corners: Pt[] | null = null, filter: ScanFilter = lastFilterRef.current, editId?: string) => {
    setOcr(null);
    touchedRef.current = false;
    setEditing({ srcUrl, corners, filter, editId });
    setMobileTab("edit");
  };

  const captureFrame = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    navigator.vibrate?.(30);
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    startEdit(c.toDataURL("image/jpeg", 0.95));
  };

  // Live document detection on the camera feed: draws the detected quad and, with
  // auto-shot on, captures automatically once the document holds steady. Runs
  // fully local, no download — a Hough line-detection pass (finds the 4 sides
  // directly) with a mask-based ensemble as fallback, all in a worker so it
  // can never block the UI regardless of how much work a frame needs (busyRef
  // drops a tick instead of queueing it if the previous one is still out).
  useEffect(() => {
    // Also pause while a different mobile tab is active — the <video> isn't
    // even mounted there, and without this an auto-capture could fire while
    // you're not looking at the camera at all (e.g. browsing the Gallery tab).
    if (!cameraOn || editing || (portalMobile && mobileTab !== "camera")) {
      if (liveRef.current) { clearInterval(liveRef.current); liveRef.current = null; }
      setCaptureHold(0);
      return;
    }
    capturedRef.current = false;
    stableRef.current = 0;
    lastQuadRef.current = null;
    lastGoodQuadRef.current = null;
    missStreakRef.current = 0;
    sharpAvgRef.current = 0;
    setCaptureHold(0);
    let cancelled = false;
    const busyRef = { current: false };
    const id = window.setInterval(async () => {
      if (busyRef.current || cancelled) return;
      const v = videoRef.current, ov = overlayRef.current;
      if (!v || !v.videoWidth || !ov) return;

      let quad: Pt[] | null = null;
      let confidence = 0;
      busyRef.current = true;
      try {
        const bitmap = await createImageBitmap(v);
        const r = await detectInWorker("live", bitmap, v.videoWidth, v.videoHeight);
        if (r) {
          quad = r.pts; confidence = r.confidence;
          // Rolling baseline of how sharp frames normally look for this device/
          // lighting — lets the confirm step recognize "this one instant is
          // unusually blurry" (a hand-jitter right as auto-capture fires)
          // without needing a hardcoded sharpness number that would be wrong
          // across different phones and lighting.
          sharpAvgRef.current = sharpAvgRef.current ? sharpAvgRef.current * 0.85 + r.sharpness * 0.15 : r.sharpness;
        }
      } catch { quad = null; } finally { busyRef.current = false; }
      if (cancelled) return;

      // Mobile fills the whole viewport with object-cover (crops rather than
      // letterboxes, so any screen aspect ratio is used fully) — the canvas
      // then has to match that displayed CSS box, not the video's native
      // resolution, and every point drawn on it needs to go through the same
      // scale+offset the browser applies internally to crop the video.
      // Desktop is untouched: natural sizing, canvas == native video pixels,
      // no transform needed.
      const coverMode = portalMobile;
      if (coverMode) {
        const rect = v.getBoundingClientRect();
        const cw = Math.max(1, Math.round(rect.width)), ch = Math.max(1, Math.round(rect.height));
        if (ov.width !== cw || ov.height !== ch) { ov.width = cw; ov.height = ch; }
      } else if (ov.width !== v.videoWidth) { ov.width = v.videoWidth; ov.height = v.videoHeight; }
      const octx = ov.getContext("2d");
      if (!octx) return;
      octx.clearRect(0, 0, ov.width, ov.height);

      const scale = coverMode ? Math.max(ov.width / v.videoWidth, ov.height / v.videoHeight) : 1;
      const offX = coverMode ? (ov.width - v.videoWidth * scale) / 2 : 0;
      const offY = coverMode ? (ov.height - v.videoHeight * scale) / 2 : 0;
      const mapPt = (p: Pt): Pt => (coverMode ? { x: p.x * scale + offX, y: p.y * scale + offY } : p);

      const good = !!quad && confidence >= 0.58;

      if (!good) {
        // A single missed frame is almost always camera shake, not "the
        // document is gone" — decay the countdown gently and keep drawing the
        // last good outline for a couple of frames instead of instantly
        // flipping back to the guide box, which is what actually read as
        // "broken/flickering" even though detection itself was fine.
        missStreakRef.current++;
        stableRef.current = Math.max(0, stableRef.current - 1);
        if (missStreakRef.current <= 2 && lastGoodQuadRef.current) {
          const o = orderCorners(lastGoodQuadRef.current).map(mapPt);
          const holdT = autoShot ? Math.min(1, stableRef.current / 4) : 0;
          setCaptureHold(holdT);
          octx.beginPath();
          octx.moveTo(o[0].x, o[0].y);
          for (let i = 1; i < 4; i++) octx.lineTo(o[i].x, o[i].y);
          octx.closePath();
          const color = holdColor(holdT);
          octx.fillStyle = color.replace("rgb", "rgba").replace(")", ", 0.08)");
          octx.fill();
          octx.lineWidth = Math.max(2, ov.width * 0.005);
          octx.strokeStyle = color.replace("rgb", "rgba").replace(")", ", 0.55)");
          octx.stroke();
          return;
        }
        setDocDetected(false); stableRef.current = 0; lastQuadRef.current = null; lastGoodQuadRef.current = null; setCaptureHold(0);
        const gw = ov.width * 0.08, gh = ov.height * 0.08;
        octx.setLineDash([12, 8]);
        octx.lineWidth = Math.max(2, ov.width * 0.004);
        octx.strokeStyle = "rgba(255,255,255,0.55)";
        octx.strokeRect(gw, gh, ov.width - gw * 2, ov.height - gh * 2);
        octx.setLineDash([]);
        return;
      }

      if (!quad) return;
      missStreakRef.current = 0;
      setDocDetected(true);
      lastGoodQuadRef.current = quad;
      const prev = lastQuadRef.current;
      if (prev) {
        const move = quad.reduce((s, p, i) => s + Math.hypot(p.x - prev[i].x, p.y - prev[i].y), 0) / 4;
        // Only a high-confidence AND stationary read counts toward auto-capture —
        // a shaky or merely-plausible read decays the countdown by one step
        // instead of wiping it, so transient noise doesn't cost the whole streak.
        // Compared in native video pixels regardless of display mode — the
        // quad itself always comes back in that space from the worker, so
        // this must never be measured against the (possibly differently
        // scaled) display canvas size.
        if (move < v.videoWidth * 0.02 && confidence >= 0.72) stableRef.current = Math.min(4, stableRef.current + 1);
        else stableRef.current = Math.max(0, stableRef.current - 1);
      }
      lastQuadRef.current = quad;
      const holdT = autoShot ? Math.min(1, stableRef.current / 4) : 0;
      setCaptureHold(holdT);
      const o = orderCorners(quad).map(mapPt);
      octx.beginPath();
      octx.moveTo(o[0].x, o[0].y);
      for (let i = 1; i < 4; i++) octx.lineTo(o[i].x, o[i].y);
      octx.closePath();
      const color = holdColor(holdT);
      octx.fillStyle = color.replace("rgb", "rgba").replace(")", `, ${0.12 + 0.22 * holdT})`);
      octx.fill();
      octx.lineWidth = Math.max(3, ov.width * 0.006) * (1 + holdT * 0.7);
      octx.strokeStyle = color;
      octx.stroke();
      if (autoShot && stableRef.current >= 4 && !capturedRef.current) {
        // Second, slower opinion before we actually fire: re-sample the same
        // frame at a much higher resolution and demand a stricter bar. This is
        // what stops a fast-loop false positive (which is cheap and coarse by
        // design, for the live overlay) from actually taking a bad photo.
        let confirmed = false;
        try {
          const bitmap = await createImageBitmap(v);
          const c = await detectInWorker("confirm", bitmap, v.videoWidth, v.videoHeight);
          // Reject a confirm read that's suddenly much blurrier than this
          // session's normal — usually a hand-jitter at the exact instant
          // auto-capture tried to fire — even if the geometry still scored
          // well enough on its own. Only kicks in once we have an actual
          // baseline (0 means the live loop hasn't reported one yet).
          const sharpOk = !sharpAvgRef.current || !c || c.sharpness >= sharpAvgRef.current * 0.45;
          confirmed = !!c && c.confidence >= 0.78 && sharpOk;
        } catch { confirmed = false; }
        if (cancelled) return;
        if (confirmed) {
          capturedRef.current = true;
          setFlash(true);
          window.setTimeout(() => setFlash(false), 180);
          captureFrame();
        } else {
          // Not it — don't spin retrying every 450ms, but don't fully throw away
          // the streak either, so a real document keeps earning it back fast.
          stableRef.current = 2;
        }
      }
    }, 450);
    liveRef.current = id;
    return () => {
      cancelled = true;
      if (liveRef.current) { clearInterval(liveRef.current); liveRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn, editing, autoShot, portalMobile, mobileTab]);

  const onFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    const urls: string[] = [];
    let pending = files.length;
    Array.from(files).forEach((f) => {
      if (!f.type.startsWith("image/")) { pending--; return; }
      const reader = new FileReader();
      reader.onload = () => {
        urls.push(reader.result as string);
        if (--pending === 0) {
          queueRef.current = urls.slice(1);
          if (urls[0]) startEdit(urls[0]);
        }
      };
      reader.readAsDataURL(f);
    });
  };

  const onEditImgLoad = () => {
    const img = editImgRef.current;
    if (!img || !editing || editing.corners) return;
    setEditing((e) => e ? { ...e, corners: autoDetectCorners(img) } : e);
  };

  const runAutoDetect = () => {
    const img = editImgRef.current;
    if (!img) return;
    touchedRef.current = false;
    setEditing((e) => e ? { ...e, corners: autoDetectCorners(img) } : e);
  };

  const cornerToPct = (p: Pt): { left: string; top: string } => {
    const img = editImgRef.current;
    const w = img?.naturalWidth || 1, h = img?.naturalHeight || 1;
    return { left: `${(p.x / w) * 100}%`, top: `${(p.y / h) * 100}%` };
  };

  const updateLoupe = (corner: Pt) => {
    const img = editImgRef.current, lc = loupeRef.current, box = loupeBoxRef.current;
    if (!img || !lc || !box) return;
    const ctx = lc.getContext("2d")!;
    const L = lc.width, factor = 3;
    const srcW = L / factor, srcH = L / factor;
    ctx.fillStyle = "#1a1a22"; ctx.fillRect(0, 0, L, L);
    ctx.drawImage(img, corner.x - srcW / 2, corner.y - srcH / 2, srcW, srcH, 0, 0, L, L);
    ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(L / 2 - 10, L / 2); ctx.lineTo(L / 2 + 10, L / 2);
    ctx.moveTo(L / 2, L / 2 - 10); ctx.lineTo(L / 2, L / 2 + 10); ctx.stroke();
    // Keep the loupe out of the way of the finger: place it in the corner
    // opposite to the one being dragged.
    const onLeft = corner.x < img.naturalWidth * 0.45;
    const onTop = corner.y < img.naturalHeight * 0.45;
    box.style.left = onLeft ? "auto" : "8px";
    box.style.right = onLeft ? "8px" : "auto";
    box.style.top = onTop ? "auto" : "8px";
    box.style.bottom = onTop ? "8px" : "auto";
    box.style.display = "block";
  };

  const onCornerDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    touchedRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragCorner(i);
    if (editing?.corners) updateLoupe(editing.corners[i]);
  };

  const onCornerMove = (e: React.PointerEvent) => {
    if (dragCorner === null || !editing?.corners) return;
    const box = editBoxRef.current, img = editImgRef.current;
    if (!box || !img) return;
    const r = box.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * img.naturalWidth;
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * img.naturalHeight;
    const corners = editing.corners.slice();
    corners[dragCorner] = { x, y };
    setEditing({ ...editing, corners });
    updateLoupe({ x, y });
  };

  const onCornerUp = () => {
    setDragCorner(null);
    if (loupeBoxRef.current) loupeBoxRef.current.style.display = "none";
  };

  const savePage = (goTo: "camera" | "gallery" = "gallery") => {
    const img = editImgRef.current;
    if (!img || !editing?.corners) return;
    setBusy(isEs ? "Procesando…" : "Processing…");
    setTimeout(async () => {
      try {
        let out = warpDocument(img, editing.corners!);
        setBusy(isEs ? "Comprobando orientación…" : "Checking orientation…");
        const degrees = await detectOrientationDegrees(out);
        if (degrees) out = rotateCanvasDegrees(out, degrees);
        applyScanFilter(out, editing.filter);
        const thumb = out.toDataURL("image/jpeg", 0.7);
        const outUrl = out.toDataURL("image/jpeg", 0.92);
        const id = editing.editId ?? `${Date.now()}-${Math.random()}`;
        const page: Page = { id, srcUrl: editing.srcUrl, corners: editing.corners!, filter: editing.filter, out, thumb };
        const prev = pagesRef.current;
        const next = editing.editId ? prev.map((p) => p.id === id ? page : p) : [...prev, page];
        setPages(next);
        idbPutPage({ id, order: next.findIndex((p) => p.id === id), srcUrl: editing.srcUrl, corners: editing.corners!, filter: editing.filter, thumb, out: outUrl });
      } finally {
        setBusy("");
        const nxt = queueRef.current.shift();
        if (nxt) startEdit(nxt); else { setEditing(null); setMobileTab(goTo); }
      }
    }, 30);
  };

  const deletePage = (id: string) => {
    setPages((prev) => prev.filter((p) => p.id !== id));
    idbDeletePage(id);
  };

  const clearAll = () => {
    if (pagesRef.current.length && typeof window !== "undefined" &&
      !window.confirm(isEs ? "¿Borrar todas las páginas escaneadas? No se puede deshacer." : "Delete all scanned pages? This can't be undone.")) return;
    setPages([]);
    setOcr(null);
    idbClear();
  };

  const downloadPage = async (pg: Page, i: number) => {
    const blob = await canvasToBlob(pg.out, 0.95);
    if (blob) await downloadOrShareBlob(blob, `${baseName}-${String(i + 1).padStart(2, "0")}.jpg`);
  };

  const discardEdit = () => {
    if (touchedRef.current && typeof window !== "undefined" &&
      !window.confirm(isEs ? "Has movido las esquinas — ¿descartar de todas formas?" : "You've adjusted the corners — discard anyway?")) return;
    const next = queueRef.current.shift();
    if (next) startEdit(next); else { setEditing(null); setMobileTab("camera"); }
  };

  const rotateEdit = () => {
    const img = editImgRef.current;
    if (!img) return;
    const c = document.createElement("canvas");
    c.width = img.naturalHeight; c.height = img.naturalWidth;
    const ctx = c.getContext("2d")!;
    ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, 0, 0);
    startEdit(c.toDataURL("image/jpeg", 0.95), null, editing?.filter ?? "magic", editing?.editId);
  };

  const movePage = (i: number, dir: -1 | 1) => {
    const prev = pagesRef.current;
    const j = i + dir;
    if (j < 0 || j >= prev.length) return;
    const next = prev.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setPages(next);
    idbSetOrder(next.map((p) => p.id));
  };

  // Quick manual rotate straight on the already-scanned page, for when
  // auto-orientation guessed wrong (or you just prefer it the other way) —
  // no need to reopen the corner editor for something this simple. Rotates
  // the final rendered canvas directly rather than re-deriving from the
  // original photo, so it stacks with whatever auto-rotation already ran.
  // Note: re-opening this page in "Editar" re-warps fresh from the original
  // capture and corners, which does NOT carry this manual rotation forward —
  // it's a quick fix on the current result, not a persistent transform.
  const rotateGalleryPage = (pg: Page) => {
    const out = rotateCanvasDegrees(pg.out, 90);
    const thumb = out.toDataURL("image/jpeg", 0.7);
    const outUrl = out.toDataURL("image/jpeg", 0.92);
    const next = pagesRef.current.map((p) => (p.id === pg.id ? { ...p, out, thumb } : p));
    setPages(next);
    idbPutPage({ id: pg.id, order: next.findIndex((p) => p.id === pg.id), srcUrl: pg.srcUrl, corners: pg.corners, filter: pg.filter, thumb, out: outUrl });
  };

  // Tesseract's own PDF renderer (Tesseract's native, well-tested C++
  // TessPDFRenderer, not something hand-rolled here) produces a single-page
  // PDF per image with the recognized words placed as an invisible text
  // layer already positioned correctly — far more reliable than manually
  // computing word bounding boxes into jsPDF coordinates ourselves. Each
  // page's mini-PDF is then just spliced into one combined document with
  // pdf-lib (already a dependency, used elsewhere in this project), which is
  // pure page-copying, no image processing of its own. Kept as a completely
  // separate path from the normal export so the default (non-searchable)
  // flow above is never at risk of regressing.
  const exportSearchablePdf = async () => {
    setPdfErr("");
    setBusy(isEs ? "Preparando OCR…" : "Preparing OCR…");
    let worker: Tesseract.Worker | null = null;
    try {
      const Tesseract = (await import("tesseract.js")).default;
      worker = await Tesseract.createWorker("eng+spa");
      const pagePdfs: Uint8Array[] = [];
      for (let i = 0; i < pages.length; i++) {
        setBusy(isEs ? `OCR página ${i + 1}/${pages.length}…` : `OCR page ${i + 1}/${pages.length}…`);
        const url = pages[i].out.toDataURL("image/jpeg", 0.92);
        const { data } = await worker.recognize(url, {}, { text: false, pdf: true });
        if (data.pdf) pagePdfs.push(new Uint8Array(data.pdf));
      }
      if (!pagePdfs.length) throw new Error("no pdf pages produced");
      setBusy(isEs ? "Combinando PDF…" : "Combining PDF…");
      const { PDFDocument } = await import("pdf-lib");
      const merged = await PDFDocument.create();
      for (const bytes of pagePdfs) {
        const src = await PDFDocument.load(bytes);
        const copied = await merged.copyPages(src, src.getPageIndices());
        copied.forEach((p) => merged.addPage(p));
      }
      const finalBytes = await merged.save();
      const blob = new Blob([finalBytes.buffer as ArrayBuffer], { type: "application/pdf" });
      await downloadOrShareBlob(blob, `${baseName}.pdf`);
    } catch {
      setPdfErr(isEs
        ? "No se pudo generar el PDF con texto buscable. Prueba a desmarcar esa opción."
        : "Couldn't build the searchable PDF. Try unchecking that option.");
    } finally {
      if (worker) await worker.terminate();
      setBusy("");
    }
  };

  const exportPdf = async () => {
    if (!pages.length) return;
    if (searchablePdf) { await exportSearchablePdf(); return; }
    setBusy(isEs ? "Creando PDF…" : "Building PDF…");
    try {
      const { jsPDF } = await import("jspdf");
      const preset = pageSize !== "auto";
      let pdf: import("jspdf").jsPDF | null = null;
      for (let i = 0; i < pages.length; i++) {
        const cv = pages[i].out;
        const w = cv.width, h = cv.height;
        const orient = w > h ? "l" : "p";
        const url = cv.toDataURL("image/jpeg", 0.92);
        if (preset) {
          if (!pdf) pdf = new jsPDF({ orientation: orient, unit: "pt", format: pageSize });
          else pdf.addPage(pageSize, orient);
          const pw = pdf.internal.pageSize.getWidth();
          const ph = pdf.internal.pageSize.getHeight();
          const m = 18;
          const scale = Math.min((pw - m * 2) / w, (ph - m * 2) / h);
          const dw = w * scale, dh = h * scale;
          pdf.addImage(url, "JPEG", (pw - dw) / 2, (ph - dh) / 2, dw, dh);
        } else {
          if (!pdf) pdf = new jsPDF({ orientation: orient, unit: "px", format: [w, h] });
          else pdf.addPage([w, h], orient);
          pdf.addImage(url, "JPEG", 0, 0, w, h);
        }
      }
      const blob: Blob = pdf!.output("blob");
      await downloadOrShareBlob(blob, `${baseName}.pdf`);
    } finally { setBusy(""); }
  };

  const exportImages = async () => {
    if (!pages.length) return;
    if (pages.length === 1) {
      const blob = await canvasToBlob(pages[0].out, 0.95);
      if (blob) await downloadOrShareBlob(blob, `${baseName}.jpg`);
      return;
    }
    setBusy(isEs ? "Comprimiendo…" : "Zipping…");
    try {
      const { zipSync } = await import("fflate");
      const files: Record<string, Uint8Array> = {};
      pages.forEach((pg, i) => {
        const b64 = pg.out.toDataURL("image/jpeg", 0.92).split(",")[1];
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
        files[`${baseName}-${String(i + 1).padStart(2, "0")}.jpg`] = arr;
      });
      const zipped = zipSync(files);
      const blob = new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" });
      await downloadOrShareBlob(blob, `${baseName}.zip`);
    } finally { setBusy(""); }
  };

  const runOcr = async (pg: Page) => {
    setOcr({ text: "", prog: 0, busy: true });
    try {
      const Tesseract = (await import("tesseract.js")).default;
      const { data } = await Tesseract.recognize(pg.out.toDataURL("image/jpeg", 0.95), "eng+spa", {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === "recognizing text") setOcr((o) => o ? { ...o, prog: Math.round(m.progress * 100) } : o);
        },
      });
      setOcr({ text: data.text.trim() || (isEs ? "(No se detectó texto)" : "(No text detected)"), prog: 100, busy: false });
    } catch {
      setOcr({ text: isEs ? "No se pudo extraer el texto." : "Couldn't extract text.", prog: 0, busy: false });
    }
  };

  const filterLabel = (f: ScanFilter) =>
    f === "magic" ? (isEs ? "Mágico" : "Magic")
      : f === "color" ? (isEs ? "Color" : "Color")
        : f === "gray" ? (isEs ? "Gris" : "Gray")
          : f === "whiteboard" ? (isEs ? "Pizarra" : "Whiteboard")
            : (isEs ? "B/N" : "B&W");

  const topBanners = (
    <>
      <div className="flex items-start gap-2 rounded-xl border border-green-500/20 bg-green-500/5 px-4 py-2.5 text-xs text-green-400/90">
        <FiFileText className="mt-0.5 shrink-0" />
        <span>
          {isEs
            ? "100% en tu navegador. Tus documentos nunca se suben a ningún servidor — el escaneo, los filtros y el OCR se procesan en tu dispositivo."
            : "100% in your browser. Your documents are never uploaded — scanning, filters and OCR all run on your device."}
        </span>
      </div>

      {restoredCount > 0 && (
        <div className="flex items-start justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 text-xs text-primary/90">
          <span>
            {isEs
              ? `Se ${restoredCount === 1 ? "ha" : "han"} recuperado ${restoredCount} ${restoredCount === 1 ? "página guardada" : "páginas guardadas"} de tu última sesión. Solo se guardan en este navegador, en ningún otro sitio.`
              : `Restored ${restoredCount} ${restoredCount === 1 ? "page" : "pages"} from your last session. They're only saved in this browser, nowhere else.`}
          </span>
          <button onClick={() => setRestoredCount(0)} className="shrink-0 text-primary/60 transition-colors hover:text-primary">
            <FiX size={14} />
          </button>
        </div>
      )}
    </>
  );

  const chooserBlock = (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <button onClick={openCamera} className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/40 bg-surface/30 px-6 py-10 text-center transition-colors hover:border-primary/40">
          <FiCamera className="text-3xl text-primary/70" />
          <span className="text-sm font-medium text-text">{isEs ? "Abrir cámara" : "Open camera"}</span>
          <span className="text-xs text-text-muted/60">{isEs ? "Escanea con la cámara trasera" : "Scan with the back camera"}</span>
        </button>
        <button onClick={() => fileRef.current?.click()} className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/40 bg-surface/30 px-6 py-10 text-center transition-colors hover:border-primary/40">
          <FiUpload className="text-3xl text-primary/70" />
          <span className="text-sm font-medium text-text">{isEs ? "Subir imágenes" : "Upload images"}</span>
          <span className="text-xs text-text-muted/60">{isEs ? "Una o varias a la vez" : "One or several at once"}</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
      </div>
      {cameraErr && <p className="text-center text-xs text-red-400">{cameraErr}</p>}
    </div>
  );

  const cameraControlsRow = (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <button onClick={captureFrame} className="flex items-center gap-2 rounded-xl border border-primary/40 bg-primary/15 px-6 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/25">
        <FiCamera /> {isEs ? "Capturar" : "Capture"}
      </button>
      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-muted">
        <input type="checkbox" checked={autoShot} onChange={(e) => setAutoShot(e.target.checked)} className="accent-primary" />
        {isEs ? "Captura automática" : "Auto-capture"}
      </label>
      {torchSupported && (
        <button onClick={toggleTorch} className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${torchOn ? "border-yellow-400/60 bg-yellow-400/15 text-yellow-300" : "border-border/30 bg-surface/40 text-text-muted hover:text-text"}`}>
          <FiSun /> {isEs ? "Flash" : "Flash"}
        </button>
      )}
      <button onClick={stopCamera} className="flex items-center gap-2 rounded-xl border border-border/30 bg-surface/40 px-4 py-3 text-sm font-medium text-text-muted transition-colors hover:text-text">
        <FiX /> {isEs ? "Cerrar" : "Close"}
      </button>
    </div>
  );

  const cameraHint = (
    <p className="text-center text-[11px] text-text-muted/50">
      {isEs ? "Enfoca el documento; cuando se resalte en verde se captura solo (o pulsa Capturar)." : "Point at the document; when it's highlighted green it captures itself (or tap Capture)."}
    </p>
  );

  const detectionOverlayExtras = (
    <>
      {flash && <div className="pointer-events-none absolute inset-0 bg-white/80" />}
      {docDetected && (
        <span
          className="absolute left-2 top-2 rounded-md px-2 py-1 text-[11px] font-medium text-white transition-colors"
          style={{ backgroundColor: autoShot && captureHold > 0 ? holdColor(captureHold) : "rgba(34,197,94,0.85)" }}
        >
          {autoShot && captureHold > 0
            ? (isEs ? "Quieto… capturando" : "Hold still… capturing")
            : (isEs ? "Documento detectado" : "Document detected")}
        </span>
      )}
      {docDetected && autoShot && captureHold > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/30">
          <div className="h-full transition-[width]" style={{ width: `${captureHold * 100}%`, backgroundColor: holdColor(captureHold) }} />
        </div>
      )}
    </>
  );

  // Desktop: video sizes itself naturally (block, full width) and the parent
  // grows to match — canvas overlay stretches to that same box 1:1, keeping
  // detected-quad coordinates aligned with what's actually visible.
  const cameraViewport = (
    <>
      <video ref={videoRef} playsInline muted className="block w-full" />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      {detectionOverlayExtras}
    </>
  );

  // Mobile: fills the entire available flex-1 area with object-cover, so the
  // camera view actually uses whatever screen aspect ratio the device has
  // instead of leaving black bars (or over-cropping) whenever the video's
  // native aspect doesn't match the screen's. The overlay canvas is sized to
  // match this displayed CSS box (not the video's native resolution) and the
  // detection-drawing tick above transforms every point through the same
  // scale+offset the browser applies internally to crop the video — see
  // `coverMode`/`mapPt` there. Desktop stays on natural sizing, untouched.
  const cameraViewportMobile = (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      {detectionOverlayExtras}
    </div>
  );

  const editBlockContent = !editing ? null : (
        <div className="space-y-3 rounded-2xl border border-border/30 bg-surface/30 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted/60">
            {isEs ? "Ajusta las esquinas del documento" : "Adjust the document corners"}
          </p>
          <div
            ref={editBoxRef}
            className="relative mx-auto max-w-sm select-none sm:max-w-md"
            style={{ touchAction: dragCorner !== null ? "none" : "pan-y", WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
            onPointerMove={onCornerMove}
            onPointerUp={onCornerUp}
            onPointerLeave={onCornerUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={editImgRef}
              src={editing.srcUrl}
              alt="capture"
              onLoad={onEditImgLoad}
              className="block w-full rounded-lg"
              draggable={false}
              style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none", WebkitUserDrag: "none", pointerEvents: "none" } as React.CSSProperties}
            />
            {editing.corners && (
              <>
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                  <polygon
                    points={orderCorners(editing.corners).map((p) => {
                      const img = editImgRef.current;
                      const w = img?.naturalWidth || 1, h = img?.naturalHeight || 1;
                      return `${(p.x / w) * 100},${(p.y / h) * 100}`;
                    }).join(" ")}
                    fill="rgba(34,197,94,0.12)" stroke="#22c55e" strokeWidth="0.5" vectorEffect="non-scaling-stroke"
                  />
                </svg>
                {editing.corners.map((p, i) => (
                  <div
                    key={i}
                    onPointerDown={onCornerDown(i)}
                    className="absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
                    style={cornerToPct(p)}
                  >
                    <span className={`rounded-full border-2 border-white bg-green-500/80 shadow-md transition-all ${dragCorner === i ? "h-7 w-7" : "h-5 w-5"}`} />
                  </div>
                ))}
              </>
            )}
            <div ref={loupeBoxRef} className="pointer-events-none absolute z-10 h-[120px] w-[120px] overflow-hidden rounded-full border-2 border-white/70 shadow-lg" style={{ display: "none", top: "8px", right: "8px" }}>
              <canvas ref={loupeRef} width={120} height={120} className="block" />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            {FILTERS.map((f) => (
              <button key={f} onClick={() => { setEditing({ ...editing, filter: f }); lastFilterRef.current = f; persistPrefs({ filter: f }); }} className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${editing.filter === f ? "border-primary/50 bg-primary/15 text-primary" : "border-border/30 bg-surface/40 text-text-muted hover:text-text"}`}>
                {filterLabel(f)}
              </button>
            ))}
            <button onClick={rotateEdit} className="flex items-center gap-1 rounded-lg border border-border/30 bg-surface/40 px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text">
              <FiRotateCw /> {isEs ? "Girar" : "Rotate"}
            </button>
            <button onClick={runAutoDetect} className="flex items-center gap-1 rounded-lg border border-border/30 bg-surface/40 px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text">
              <FiZap /> {isEs ? "Auto-detectar" : "Auto-detect"}
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={() => savePage("gallery")} disabled={!!busy} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-50">
              <FiCheck /> {busy || (isEs ? "Guardar" : "Save")}
            </button>
            <button onClick={() => savePage("camera")} disabled={!!busy} title={isEs ? "Guardar y escanear otra" : "Save and scan another"} className="flex items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50 sm:hidden">
              <FiCamera />
            </button>
            <button onClick={discardEdit} className="flex items-center gap-2 rounded-xl border border-border/30 bg-surface/40 px-4 py-2.5 text-sm font-medium text-text-muted transition-colors hover:text-text">
              <FiX /> {isEs ? "Descartar" : "Discard"}
            </button>
          </div>
          {queueRef.current.length > 0 && (
            <p className="text-center text-xs text-text-muted/50">{isEs ? `Quedan ${queueRef.current.length} imágenes en cola` : `${queueRef.current.length} more images queued`}</p>
          )}
        </div>
  );

  // Desktop-only camera card: original inline layout, unchanged.
  const cameraCardDesktop = cameraOn ? (
    <div className="space-y-3 rounded-2xl border border-border/30 bg-black/40 p-3">
      <div className="relative mx-auto w-full overflow-hidden rounded-lg">
        {cameraViewport}
      </div>
      {cameraControlsRow}
      {cameraHint}
    </div>
  ) : chooserBlock;

  const galleryBlockContent = pages.length === 0 ? null : (
        <div className="space-y-3 rounded-2xl border border-border/30 bg-surface/30 p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted/60">
              {isEs ? `Páginas (${pages.length})` : `Pages (${pages.length})`}
            </p>
            <button onClick={clearAll} className="text-xs text-text-muted/60 transition-colors hover:text-red-400">
              {isEs ? "Limpiar todo" : "Clear all"}
            </button>
          </div>
          <p className="-mt-1 text-[11px] text-text-muted/50">
            {isEs ? "Pulsa Editar para reajustar esquinas o cambiar el filtro cuando quieras. Tus páginas se guardan aunque cierres o recargues." : "Tap Edit to readjust corners or change the filter anytime. Your pages are saved even if you close or reload."}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {pages.map((pg, i) => (
              <div key={pg.id} className="relative overflow-hidden rounded-lg border border-border/20 bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pg.thumb} alt={`page ${i + 1}`} className="block aspect-[3/4] w-full object-contain" />
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 text-[10px] text-white">{i + 1}</span>
                <div className="absolute right-1 top-1 flex gap-0.5">
                  <button onClick={() => movePage(i, -1)} disabled={i === 0} title={isEs ? "Subir" : "Up"} className="rounded bg-black/55 p-1 text-white transition-colors hover:bg-black/80 disabled:opacity-30"><FiChevronUp size={13} /></button>
                  <button onClick={() => movePage(i, 1)} disabled={i === pages.length - 1} title={isEs ? "Bajar" : "Down"} className="rounded bg-black/55 p-1 text-white transition-colors hover:bg-black/80 disabled:opacity-30"><FiChevronDown size={13} /></button>
                </div>
                <div className="grid grid-cols-5 border-t border-border/10 bg-surface/95">
                  <button onClick={() => startEdit(pg.srcUrl, pg.corners, pg.filter, pg.id)} title={isEs ? "Editar (esquinas y filtro)" : "Edit (corners & filter)"} className="flex items-center justify-center py-2 text-primary transition-colors hover:bg-primary/10"><FiEdit2 size={15} /></button>
                  <button onClick={() => rotateGalleryPage(pg)} title={isEs ? "Girar 90°" : "Rotate 90°"} className="flex items-center justify-center py-2 text-text-muted transition-colors hover:bg-primary/10 hover:text-primary"><FiRotateCw size={15} /></button>
                  <button onClick={() => downloadPage(pg, i)} title={isEs ? "Descargar esta página" : "Download this page"} className="flex items-center justify-center py-2 text-text-muted transition-colors hover:bg-primary/10 hover:text-primary"><FiDownload size={15} /></button>
                  <button onClick={() => runOcr(pg)} title={isEs ? "Extraer texto (OCR)" : "Extract text (OCR)"} className="flex items-center justify-center py-2 text-text-muted transition-colors hover:bg-primary/10 hover:text-primary"><FiFileText size={15} /></button>
                  <button onClick={() => deletePage(pg.id)} title={isEs ? "Borrar" : "Delete"} className="flex items-center justify-center py-2 text-text-muted transition-colors hover:bg-red-500/15 hover:text-red-400"><FiTrash2 size={15} /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button onClick={exportPdf} disabled={!!busy} className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-50">
              <FiDownload /> {isEs ? "Descargar PDF" : "Download PDF"}
            </button>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-text-muted/60">{isEs ? "Tamaño:" : "Size:"}</span>
              {(["auto", "a4", "letter"] as const).map((s) => (
                <button key={s} disabled={searchablePdf} onClick={() => setPageSize(s)} className={`rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${pageSize === s ? "border-primary/50 bg-primary/15 text-primary" : "border-border/30 bg-surface/40 text-text-muted hover:text-text"}`}>
                  {s === "auto" ? "Auto" : s === "a4" ? "A4" : (isEs ? "Carta" : "Letter")}
                </button>
              ))}
            </div>
            <button onClick={exportImages} disabled={!!busy} className="flex items-center gap-2 rounded-xl border border-border/30 bg-surface/40 px-4 py-2.5 text-sm font-medium text-text-muted transition-colors hover:text-text disabled:opacity-50">
              <FiDownload /> {pages.length > 1 ? (isEs ? "Imágenes (ZIP)" : "Images (ZIP)") : (isEs ? "Imagen" : "Image")}
            </button>
            {busy && <span className="flex items-center gap-1.5 text-xs text-text-muted"><FiLoader className="animate-spin" /> {busy}</span>}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-muted">
            <input type="checkbox" checked={searchablePdf} onChange={(e) => setSearchablePdf(e.target.checked)} className="accent-primary" />
            {isEs ? "PDF con texto buscable (OCR, más lento, tamaño automático)" : "Searchable-text PDF (OCR, slower, automatic size)"}
          </label>
          {pdfErr && <p className="text-xs text-red-400">{pdfErr}</p>}
          <label className="flex items-center gap-2 text-xs text-text-muted">
            {isEs ? "Nombre del archivo:" : "File name:"}
            <input
              type="text"
              value={scanName}
              onChange={(e) => setScanName(e.target.value)}
              placeholder="scan"
              maxLength={60}
              className="min-w-0 flex-1 rounded-lg border border-border/30 bg-background/60 px-2 py-1.5 text-xs text-text placeholder:text-text-muted/40"
            />
          </label>
        </div>
  );

  const ocrBlockContent = !ocr ? null : (
    <div className="space-y-2 rounded-2xl border border-border/30 bg-surface/30 p-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted/60">
          <FiFileText /> {isEs ? "Texto extraído (OCR)" : "Extracted text (OCR)"}
          {ocr.busy && <span className="text-primary">{ocr.prog}%</span>}
        </p>
        {!ocr.busy && ocr.text && (
          <button onClick={() => navigator.clipboard?.writeText(ocr.text)} className="flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-primary">
            <FiCopy /> {isEs ? "Copiar" : "Copy"}
          </button>
        )}
      </div>
      {ocr.busy
        ? <p className="flex items-center gap-2 text-xs text-text-muted"><FiLoader className="animate-spin" /> {isEs ? "Reconociendo texto (la primera vez descarga el motor)…" : "Recognizing text (first run downloads the engine)…"}</p>
        : <textarea readOnly value={ocr.text} className="h-40 w-full resize-y rounded-lg border border-border/30 bg-background/60 p-3 text-xs text-text" />}
    </div>
  );

  const howItWorksBlock = (
    <div className="space-y-2 rounded-xl border border-border/20 bg-surface/20 p-4 text-xs text-text-muted/70">
      <p className="font-semibold text-text-muted">{isEs ? "Cómo funciona" : "How it works"}</p>
      <p>
        {isEs
          ? "Haz una foto del documento (o súbela), ajusta las 4 esquinas y se endereza con corrección de perspectiva para darle ese aspecto plano de escáner. Aplica un filtro (Mágico realza, B/N limpia sombras), escanea varias páginas y expórtalas a PDF o imágenes. Incluso extrae el texto con OCR. Todo en tu dispositivo, sin subir nada."
          : "Take a photo of the document (or upload it), adjust the 4 corners and it's straightened with perspective correction for that flat scanner look. Apply a filter (Magic enhances, B&W cleans shadows), scan several pages and export to PDF or images. You can even extract the text with OCR. All on your device, nothing uploaded."}
      </p>
    </div>
  );

  const emptyState = (text: string) => (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/30 px-6 py-14 text-center text-sm text-text-muted/60">
      {text}
    </div>
  );

  const tabBarButton = (tab: "camera" | "edit" | "gallery", icon: React.ReactNode, label: string, badge?: number) => (
    <button
      onClick={() => setMobileTab(tab)}
      className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors ${mobileTab === tab ? "text-primary" : "text-text-muted/60"}`}
    >
      <span className="relative">
        {icon}
        {!!badge && (
          <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-white">
            {badge}
          </span>
        )}
      </span>
      {label}
    </button>
  );

  // Mobile: three fixed, always-reachable sections (Camera / Edit / Gallery)
  // with a bottom tab bar, portaled to <body> — free navigation between them
  // instead of one linear flow that auto-jumps you around and buries whatever
  // isn't the current step (that's what made the gallery/downloads seem to
  // "disappear" — they were just stuck behind the full-screen camera).
  const mobileShell = (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background text-text">
      {/* Persistent on every tab — "Cerrar" used to live only inside the
          Camera tab's controls, so there was no way out while on Edit or
          Gallery short of tabbing back to Camera first. This is always here. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/30 bg-surface/95 px-3 pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))] backdrop-blur-md">
        <button onClick={stopCamera} aria-label={isEs ? "Salir del escáner" : "Exit scanner"} className="-ml-1 flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text">
          <FiArrowLeft size={19} />
        </button>
        <span className="text-sm font-medium text-text">{isEs ? "Escáner de documentos" : "Document scanner"}</span>
      </div>
      <div ref={mobileScrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* showMobileShell only mounts this whole shell once cameraOn is
            true, so the Camera tab can assume the video is live — no
            chooser branch needed here. */}
        {mobileTab === "camera" && (
          <div className="flex h-full flex-col">
            {/* You can free-navigate to Camera while a capture is still
                unsaved in Edit — live detection is deliberately paused then
                (so it's clear which shot is "the current one"), which without
                this note just looks like detection silently stopped working. */}
            {editing && (
              <button onClick={() => setMobileTab("edit")} className="flex shrink-0 items-center justify-between gap-2 bg-amber-500/15 px-3 py-2 text-left text-xs text-amber-300">
                <span>{isEs ? "Tienes una captura sin guardar — la detección está pausada." : "You have an unsaved capture — detection is paused."}</span>
                <span className="shrink-0 font-semibold underline">{isEs ? "Ir a Editar" : "Go to Edit"}</span>
              </button>
            )}
            <div className="min-h-0 flex-1">{cameraViewportMobile}</div>
            <div className="shrink-0 space-y-2 border-t border-border/30 bg-background/95 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur-md">
              {cameraControlsRow}
              {cameraHint}
            </div>
          </div>
        )}
        {mobileTab === "edit" && (
          <div className="space-y-5 p-4 pb-8">
            {editBlockContent ?? emptyState(isEs ? "No hay ninguna página en edición. Captura una en Cámara, o pulsa Editar en una página de la Galería." : "Nothing being edited right now. Capture one in Camera, or tap Edit on a page in Gallery.")}
          </div>
        )}
        {mobileTab === "gallery" && (
          <div className="space-y-5 p-4 pb-8">
            {galleryBlockContent ?? emptyState(isEs ? "Aún no has escaneado ninguna página." : "You haven't scanned any pages yet.")}
            {ocrBlockContent}
          </div>
        )}
      </div>
      <nav className="flex shrink-0 border-t border-border/30 bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
        {tabBarButton("camera", <FiCamera size={18} />, isEs ? "Cámara" : "Camera")}
        {tabBarButton("edit", <FiEdit2 size={18} />, isEs ? "Editar" : "Edit")}
        {tabBarButton("gallery", <FiImage size={18} />, isEs ? "Galería" : "Gallery", pages.length)}
      </nav>
    </div>
  );

  // The mobile 3-tab shell only takes over while there's an active scanning
  // session (camera open) — otherwise mobile renders the same normal, scrolling,
  // in-page layout desktop always has (chooser + gallery inline), so there's
  // always a way back to the rest of the page. Tapping "Cerrar" in the Camera
  // tab exits the whole shell, not just the video.
  const showMobileShell = portalMobile && cameraOn;

  return (
    <div className="space-y-5">
      {showMobileShell
        ? (typeof document !== "undefined" ? createPortal(mobileShell, document.body) : null)
        : (
          <>
            {topBanners}
            {editBlockContent ?? cameraCardDesktop}
            {!editing && galleryBlockContent}
            {ocrBlockContent}
            {howItWorksBlock}
          </>
        )}
    </div>
  );
}
