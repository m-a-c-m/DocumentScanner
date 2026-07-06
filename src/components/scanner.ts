// Pure image-processing for the document scanner: perspective unwarp (homography)
// to flatten a photographed document, edge auto-detection, and "scan" filters.
// All runs locally in the browser — nothing is uploaded.

export interface Pt { x: number; y: number; }

// Order 4 arbitrary points as top-left, top-right, bottom-right, bottom-left.
export function orderCorners(pts: Pt[]): Pt[] {
  const sum = pts.map((p) => p.x + p.y);
  const diff = pts.map((p) => p.x - p.y);
  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.max(...diff))];
  const bl = pts[diff.indexOf(Math.min(...diff))];
  return [tl, tr, br, bl];
}

// Solve the 8x8 linear system for the homography mapping dst (output rectangle)
// back to src (the 4 corners in the photo), so we can inverse-sample.
function solveHomography(dst: Pt[], src: Pt[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i];
    const { x: X, y: Y } = src[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col] || 1e-9;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / d;
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const h = new Array(9);
  for (let i = 0; i < 8; i++) h[i] = b[i] / (A[i][i] || 1e-9);
  h[8] = 1;
  return h;
}

function dist(a: Pt, b: Pt): number { return Math.hypot(a.x - b.x, a.y - b.y); }

// Warp the quad defined by `corners` in `src` into a flat rectangle. Returns a new
// canvas. Output size derives from the quad's side lengths (preserves proportions),
// capped so big phone photos stay fast.
export function warpDocument(src: HTMLCanvasElement | HTMLImageElement, cornersIn: Pt[], maxSide = 2000): HTMLCanvasElement {
  const [tl, tr, br, bl] = orderCorners(cornersIn);
  let outW = Math.round(Math.max(dist(tr, tl), dist(br, bl)));
  let outH = Math.round(Math.max(dist(bl, tl), dist(br, tr)));
  outW = Math.max(16, outW); outH = Math.max(16, outH);
  const scale = Math.min(1, maxSide / Math.max(outW, outH));
  outW = Math.round(outW * scale); outH = Math.round(outH * scale);

  const sCanvas = document.createElement("canvas");
  const sw = "naturalWidth" in src ? src.naturalWidth : src.width;
  const sh = "naturalHeight" in src ? src.naturalHeight : src.height;
  sCanvas.width = sw; sCanvas.height = sh;
  const sctx = sCanvas.getContext("2d")!;
  sctx.drawImage(src, 0, 0, sw, sh);
  const srcData = sctx.getImageData(0, 0, sw, sh).data;

  const dstCorners: Pt[] = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
  const h = solveHomography(dstCorners, [tl, tr, br, bl]);

  const out = document.createElement("canvas");
  out.width = outW; out.height = outH;
  const octx = out.getContext("2d")!;
  const outImg = octx.createImageData(outW, outH);
  const o = outImg.data;
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const w = h[6] * u + h[7] * v + h[8];
      const sx = (h[0] * u + h[1] * v + h[2]) / w;
      const sy = (h[3] * u + h[4] * v + h[5]) / w;
      const di = (v * outW + u) * 4;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) { o[di + 3] = 255; o[di] = o[di + 1] = o[di + 2] = 255; continue; }
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = srcData[i00 + c] * (1 - fx) + srcData[i10 + c] * fx;
        const bot = srcData[i01 + c] * (1 - fx) + srcData[i11 + c] * fx;
        o[di + c] = top * (1 - fy) + bot * fy;
      }
      o[di + 3] = 255;
    }
  }
  octx.putImageData(outImg, 0, 0);
  return out;
}

// Integral image for fast local means (used by adaptive threshold).
function integral(gray: Float32Array, w: number, h: number): Float64Array {
  const W = w + 1;
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      ii[(y + 1) * W + (x + 1)] = ii[y * W + (x + 1)] + row;
    }
  }
  return ii;
}

export type ScanFilter = "color" | "magic" | "gray" | "bw" | "whiteboard";

// Apply a "scan look" filter in place to a canvas.
export function applyScanFilter(canvas: HTMLCanvasElement, filter: ScanFilter): void {
  if (filter === "color") return;
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height, n = w * h;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  if (filter === "gray") {
    for (let i = 0; i < n; i++) {
      const g = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
    return;
  }

  if (filter === "magic") {
    // White-balance + contrast: stretch each channel to its 2nd–98th percentile.
    for (let c = 0; c < 3; c++) {
      const hist = new Uint32Array(256);
      for (let i = 0; i < n; i++) hist[d[i * 4 + c]]++;
      let lo = 0, hi = 255, acc = 0;
      const loCut = n * 0.02, hiCut = n * 0.98;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loCut) { lo = v; break; } }
      acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= hiCut) { hi = v; break; } }
      const range = Math.max(1, hi - lo);
      for (let i = 0; i < n; i++) {
        const val = (d[i * 4 + c] - lo) / range * 255;
        d[i * 4 + c] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
    }
    ctx.putImageData(img, 0, 0);
    return;
  }

  if (filter === "whiteboard") {
    // Divide each channel by its own heavily-blurred (large-radius local mean)
    // version of itself — the classic "flatten by dividing out the background"
    // trick. A whiteboard photo's marker strokes are a small, local deviation
    // from the board's shading, while the uneven lighting/shadow/glare IS that
    // local mean itself, so dividing them out kills the shading and leaves the
    // ink vivid, unlike a single global white-balance which can't tell "corner
    // of the board in shadow" from "board past the visible corner". The
    // integral-image trick (already used below for the bw threshold) makes an
    // arbitrarily large blur radius O(1) per pixel instead of O(r²).
    const rC = new Float32Array(n), gC = new Float32Array(n), bC = new Float32Array(n);
    for (let i = 0; i < n; i++) { rC[i] = d[i * 4]; gC[i] = d[i * 4 + 1]; bC[i] = d[i * 4 + 2]; }
    const iiR = integral(rC, w, h), iiG = integral(gC, w, h), iiB = integral(bC, w, h);
    const W = w + 1;
    const r = Math.max(20, Math.round(Math.min(w, h) / 8));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const area = (y1 - y0) * (x1 - x0);
        const i = y * w + x;
        const bgR = (iiR[y1 * W + x1] - iiR[y0 * W + x1] - iiR[y1 * W + x0] + iiR[y0 * W + x0]) / area;
        const bgG = (iiG[y1 * W + x1] - iiG[y0 * W + x1] - iiG[y1 * W + x0] + iiG[y0 * W + x0]) / area;
        const bgB = (iiB[y1 * W + x1] - iiB[y0 * W + x1] - iiB[y1 * W + x0] + iiB[y0 * W + x0]) / area;
        const norm = (v: number, bg: number) => Math.max(0, Math.min(255, (v / Math.max(bg, 1)) * 245));
        d[i * 4] = norm(rC[i], bgR);
        d[i * 4 + 1] = norm(gC[i], bgG);
        d[i * 4 + 2] = norm(bC[i], bgB);
      }
    }
    ctx.putImageData(img, 0, 0);
    return;
  }

  // bw: adaptive threshold (local mean) — clean black text on white, kills shadows.
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const ii = integral(gray, w, h);
  const W = w + 1;
  const r = Math.max(8, Math.round(Math.min(w, h) / 40));
  const C = 8;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const area = (y1 - y0) * (x1 - x0);
      const sum = ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
      const mean = sum / area;
      const i = y * w + x;
      const val = gray[i] < mean - C ? 0 : 255;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = val;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function otsuThreshold(hist: Uint32Array, n: number): number {
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let sumB = 0, wB = 0, maxVar = -1, thr = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (wB === 0) continue;
    const wF = n - wB; if (wF === 0) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thr = v; }
  }
  return thr;
}

interface DocComp {
  score: number; size: number;
  minx: number; miny: number; maxx: number; maxy: number;
  boundary: Pt[];
}

// Walk every 8-connected component of a 0/1 mask and return the top `k` by
// size × axis-aligned bbox-fill (a cheap first-pass ranking — a frame-shaped
// background has a hole in the middle and loses to a solid page even when it
// touches the image borders). Keeping more than one matters: a shadow, fold or
// glare streak across a page commonly splits it into two or three disconnected
// blobs that are still ONE physical document — the caller can then union
// nearby top candidates back into a single shape instead of only capturing
// whichever fragment happens to be biggest. Each kept component also carries
// its boundary pixels (touching an unmasked pixel or the frame edge), which
// the caller fits a true rotated rectangle to.
function topComponents(mask: Uint8Array, W: number, H: number, k: number): DocComp[] {
  const n = W * H;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const top: DocComp[] = [];

  for (let start = 0; start < n; start++) {
    if (visited[start] || !mask[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let size = 0, minx = W, miny = H, maxx = 0, maxy = 0;
    const boundary: Pt[] = [];
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % W, y = (p / W) | 0;
      size++;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      let onEdge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const np = ny * W + nx;
          if (!mask[np]) { onEdge = true; continue; }
          if (!visited[np]) { visited[np] = 1; stack[sp++] = np; }
        }
      }
      if (onEdge) boundary.push({ x, y });
    }
    if (size < 6) continue;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    const fill = size / (bw * bh);
    const comp: DocComp = { score: size * fill, size, minx, miny, maxx, maxy, boundary };
    if (top.length < k) { top.push(comp); top.sort((a, b) => b.score - a.score); }
    else if (comp.score > top[top.length - 1].score) { top[top.length - 1] = comp; top.sort((a, b) => b.score - a.score); }
  }
  return top;
}

function bboxGap(a: DocComp, b: DocComp): number {
  const dx = Math.max(0, Math.max(a.minx, b.minx) - Math.min(a.maxx, b.maxx));
  const dy = Math.max(0, Math.max(a.miny, b.miny) - Math.min(a.maxy, b.maxy));
  return Math.hypot(dx, dy);
}

// Fold any of the runner-up components into the leader when it's sizable and
// sits close by — this is what reunites a page a shadow or fold split in two.
function mergeNearby(comps: DocComp[], W: number, H: number): DocComp | null {
  if (!comps.length) return null;
  let merged = comps[0];
  const diag = Math.hypot(W, H);
  for (let i = 1; i < comps.length; i++) {
    const c = comps[i];
    if (c.size < merged.size * 0.15) continue;
    if (bboxGap(merged, c) > diag * 0.05) continue;
    merged = {
      score: merged.score + c.score,
      size: merged.size + c.size,
      minx: Math.min(merged.minx, c.minx), miny: Math.min(merged.miny, c.miny),
      maxx: Math.max(merged.maxx, c.maxx), maxy: Math.max(merged.maxy, c.maxy),
      boundary: merged.boundary.concat(c.boundary),
    };
  }
  return merged;
}

// Andrew's monotone-chain convex hull, O(n log n).
function convexHull(pts: Pt[]): Pt[] {
  const points = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const n = points.length;
  if (n < 3) return points;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Minimum-area bounding rectangle of a convex polygon via rotating calipers: try
// each hull edge as a candidate rectangle side, project every hull point onto
// that edge's axis, take the resulting bbox, keep the smallest. This is what
// makes corner detection rotation-invariant — the true minimal rectangle around
// a real (possibly tilted) document is the document itself, regardless of angle.
function minAreaRect(hull: Pt[]): { corners: Pt[]; area: number } | null {
  if (hull.length < 3) return null;
  let best: { corners: Pt[]; area: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const p1 = hull[i], p2 = hull[(i + 1) % hull.length];
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const vx = -uy, vy = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = p.x * vx + p.y * vy;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const corner = (u: number, v: number): Pt => ({ x: u * ux + v * vx, y: u * uy + v * vy });
      best = { area, corners: [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)] };
    }
  }
  return best;
}

interface Refined { pts: Pt[]; confidence: number; }

// Fit the true rotated rectangle to a component's boundary and score confidence
// as blob-area / rectangle-area — close to 1 for a real (any-angle) document,
// low for noise/blobs that don't approximate a rectangle at all.
function refineComponent(c: DocComp): Refined | null {
  const hull = convexHull(c.boundary);
  const rect = minAreaRect(hull);
  if (!rect || rect.area <= 0) return null;
  return { pts: rect.corners, confidence: Math.min(1, c.size / rect.area) };
}

function dilateMask(mask: Uint8Array, W: number, H: number): Uint8Array {
  const next = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i]) { next[i] = 1; continue; }
      let found = 0;
      for (let dy = -1; dy <= 1 && !found; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= W) continue;
          if (mask[ny * W + nx]) { found = 1; break; }
        }
      }
      next[i] = found;
    }
  }
  return next;
}

function erodeMask(mask: Uint8Array, W: number, H: number): Uint8Array {
  const next = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) { next[i] = 0; continue; }
      let allSet = 1;
      for (let dy = -1; dy <= 1 && allSet; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= W) continue;
          if (!mask[ny * W + nx]) { allSet = 0; break; }
        }
      }
      next[i] = allSet;
    }
  }
  return next;
}

// Morphological closing (dilate then erode by the same amount): bridges small
// gaps in a mask — like a shadow or fold line cutting across an otherwise solid
// page — without meaningfully growing its outer shape.
function closeMask(mask: Uint8Array, W: number, H: number, iters: number): Uint8Array {
  let m = mask;
  for (let i = 0; i < iters; i++) m = dilateMask(m, W, H);
  for (let i = 0; i < iters; i++) m = erodeMask(m, W, H);
  return m;
}

// 3x3 box blur — knocks down the sensor/compression noise in live video frames
// before we take gradients of them, so Sobel doesn't chase speckle.
function boxBlur3(gray: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= W) continue;
          sum += gray[ny * W + nx]; count++;
        }
      }
      out[y * W + x] = (sum / count) | 0;
    }
  }
  return out;
}

interface Sobel { gx: Float32Array; gy: Float32Array; mag: Float32Array; }

// Per-channel Sobel (R, G and B each get their own gradient), keeping
// whichever channel responds strongest at each pixel. A boundary between two
// surfaces of similar BRIGHTNESS but different HUE — the exact "white
// document on a beige desk" case — can be almost invisible to a single
// grayscale-luminance gradient (beige and white can average out to nearly
// the same luminance) while still showing up clearly in one of the raw color
// channels (beige carries noticeably more red/less blue than white). Running
// Sobel on grayscale alone was throwing that signal away before detection
// ever got a chance to use it.
function sobelGradientsColor(rgba: Uint8ClampedArray, W: number, H: number): Sobel {
  const n = W * H;
  const rC = new Uint8Array(n), gC = new Uint8Array(n), bC = new Uint8Array(n);
  for (let i = 0; i < n; i++) { rC[i] = rgba[i * 4]; gC[i] = rgba[i * 4 + 1]; bC[i] = rgba[i * 4 + 2]; }
  const rB = boxBlur3(rC, W, H), gB = boxBlur3(gC, W, H), bB = boxBlur3(bC, W, H);
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  const channels = [rB, gB, bB];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      let bestMag = -1, bestGx = 0, bestGy = 0;
      for (const ch of channels) {
        const vx = -ch[i - W - 1] + ch[i - W + 1] - 2 * ch[i - 1] + 2 * ch[i + 1] - ch[i + W - 1] + ch[i + W + 1];
        const vy = -ch[i - W - 1] - 2 * ch[i - W] - ch[i - W + 1] + ch[i + W - 1] + 2 * ch[i + W] + ch[i + W + 1];
        const m = Math.sqrt(vx * vx + vy * vy);
        if (m > bestMag) { bestMag = m; bestGx = vx; bestGy = vy; }
      }
      gx[i] = bestGx; gy[i] = bestGy; mag[i] = bestMag;
    }
  }
  return { gx, gy, mag };
}

interface HLine { theta: number; r: number; votes: number; }

// Gradient-directed Hough transform: a document's sides are straight edges, so
// instead of chasing a solid-colored blob (which fails whenever the page and
// the background are close in color), this looks for the 4 dominant straight
// lines directly — the same technique real zero-dependency scanner
// implementations use. The key optimization: a line's Hesse-normal angle
// theta equals the LOCAL GRADIENT DIRECTION at any edge pixel on it (the
// gradient points across the edge, i.e. along the line's normal), so each
// edge pixel casts one vote at its own theta instead of the textbook approach
// of testing all 180 angles per pixel — this is what makes it fast enough
// for a live per-frame loop in plain JS.
function houghLines(sobel: Sobel, W: number, H: number, thr: number, maxLines: number, thetaBins = 90): HLine[] {
  const { gx, gy, mag } = sobel;
  const diag = Math.hypot(W, H);
  const rStep = 2;
  const rBins = Math.ceil((2 * diag) / rStep) + 1;
  const acc = new Float32Array(thetaBins * rBins);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mag[i] < thr) continue;
      let th = Math.atan2(gy[i], gx[i]);
      if (th < 0) th += Math.PI;
      if (th >= Math.PI) th -= Math.PI;
      const r = x * Math.cos(th) + y * Math.sin(th);
      const tIdx = Math.min(thetaBins - 1, Math.round((th / Math.PI) * thetaBins));
      const rIdx = Math.round((r + diag) / rStep);
      if (rIdx < 0 || rIdx >= rBins) continue;
      // spread the vote across neighboring theta bins too — softens quantization
      // noise from the gradient angle estimate at a single pixel.
      for (let dt = -1; dt <= 1; dt++) {
        const tb = ((tIdx + dt) % thetaBins + thetaBins) % thetaBins;
        acc[tb * rBins + rIdx] += mag[i] * (dt === 0 ? 1 : 0.4);
      }
    }
  }
  // Peaks with local non-max suppression so we don't pick several near-duplicate
  // lines for the same physical edge. The suppression window is expressed in
  // bins-per-degree so a finer thetaBins resolution (used for the one-shot
  // confirm/still-image passes) still suppresses over roughly the same ~4°
  // angular neighborhood as the coarser live-preview resolution.
  const dtWin = Math.max(2, Math.round((4 * thetaBins) / 180));
  const peaks: HLine[] = [];
  for (let t = 0; t < thetaBins; t++) {
    for (let ri = 0; ri < rBins; ri++) {
      const v = acc[t * rBins + ri];
      if (v < 40) continue;
      let isPeak = true;
      for (let dt = -dtWin; dt <= dtWin && isPeak; dt++) {
        const tb = ((t + dt) % thetaBins + thetaBins) % thetaBins;
        for (let dr = -3; dr <= 3; dr++) {
          const rb = ri + dr;
          if (rb < 0 || rb >= rBins) continue;
          if ((dt || dr) && acc[tb * rBins + rb] > v) { isPeak = false; break; }
        }
      }
      if (isPeak) peaks.push({ theta: (t / thetaBins) * Math.PI, r: ri * rStep - diag, votes: v });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  return peaks.slice(0, maxLines);
}

// Refit a line's offset (r) from the actual nearby edge pixels instead of
// trusting the Hough accumulator's quantized bin — a magnitude-weighted
// average of the true perpendicular position of every real edge pixel near
// the line pulls it to the sub-pixel-precise physical edge, which is what
// actually determines the final crop. Keeps theta fixed (refitting angle too
// needs full 2D regression) since r is what's most exposed to bin quantization.
function refineLine(sobel: Sobel, W: number, H: number, line: HLine, band = 4): HLine {
  const { mag } = sobel;
  const cos = Math.cos(line.theta), sin = Math.sin(line.theta);
  let sumW = 0, sumR = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = mag[y * W + x];
      if (m < 12) continue;
      const r = x * cos + y * sin;
      if (Math.abs(r - line.r) > band) continue;
      sumW += m; sumR += m * r;
    }
  }
  if (sumW < 1) return line;
  return { theta: line.theta, r: sumR / sumW, votes: line.votes };
}

// Treat each side of an already-found quad as an approximate line and refine
// it the same way a Hough line would be — this improves corner precision
// regardless of which method (Hough or the mask-ensemble fallback) produced
// the initial quad, since both ultimately return 4 points that trace real
// document edges the gradient data can sharpen.
function sideToLine(a: Pt, b: Pt): HLine {
  const dx = b.x - a.x, dy = b.y - a.y;
  let theta = Math.atan2(dx, -dy);
  if (theta < 0) theta += Math.PI;
  if (theta >= Math.PI) theta -= Math.PI;
  const r = a.x * Math.cos(theta) + a.y * Math.sin(theta);
  return { theta, r, votes: 0 };
}

function refineQuadEdges(sobel: Sobel, W: number, H: number, pts: Pt[]): Pt[] {
  const [tl, tr, br, bl] = pts;
  const sides = [sideToLine(tl, tr), sideToLine(tr, br), sideToLine(br, bl), sideToLine(bl, tl)]
    .map((l) => refineLine(sobel, W, H, l));
  const refined = [
    lineIntersection(sides[3], sides[0]),
    lineIntersection(sides[0], sides[1]),
    lineIntersection(sides[1], sides[2]),
    lineIntersection(sides[2], sides[3]),
  ];
  if (refined.some((c) => !c)) return pts;
  const result = refined as Pt[];
  // Guard against a noisy side dragging the refit into a degenerate shape —
  // fall back to the pre-refinement quad rather than trust a broken result.
  const before = quadArea(pts), after = quadArea(result);
  if (after < before * 0.5 || after > before * 1.8 || !looksLikeDocument(result)) return pts;
  return result;
}

function lineIntersection(l1: HLine, l2: HLine): Pt | null {
  const a1 = Math.cos(l1.theta), b1 = Math.sin(l1.theta);
  const a2 = Math.cos(l2.theta), b2 = Math.sin(l2.theta);
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (l1.r * b2 - l2.r * b1) / det, y: (a1 * l2.r - a2 * l1.r) / det };
}

function angleDiffDeg(t1: number, t2: number): number {
  const d = (Math.abs(t1 - t2) * 180) / Math.PI;
  return Math.min(d % 180, 180 - (d % 180));
}

// Real documents cluster around a handful of standard aspect ratios (square,
// US Letter ≈1.29, A-series/√2 ≈1.41, ID/credit-card-like ≈1.59, common photo
// ratios ≈1.5/1.75) — a genuine real-world pattern, not a hard rule (a torn
// receipt or odd-shaped note is still perfectly valid). Used only as a small
// tiebreaker bonus between otherwise-competing candidates, never a
// requirement, so it nudges an ambiguous choice toward the far more common
// case without rejecting anything unusual.
const PAPER_RATIOS = [1, 1.294, 1.414, 1.5, 1.586, 1.75];

function paperRatioBonus(pts: Pt[]): number {
  const [tl, tr, br, bl] = pts;
  const w = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2;
  const h = (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2;
  if (w < 1 || h < 1) return 0;
  const ratio = Math.max(w, h) / Math.min(w, h);
  let closest = Infinity;
  for (const r of PAPER_RATIOS) closest = Math.min(closest, Math.abs(ratio - r));
  return Math.max(0, 0.12 - closest * 0.15);
}

// Search the strongest lines for 2 roughly-parallel pairs that are roughly
// perpendicular to each other — the 4 sides of a document — and keep the
// combination with the strongest combined vote (nudged by how close it looks
// to a standard paper ratio) whose corners actually pass looksLikeDocument.
// Small candidate set (maxLines from houghLines), so the nested search is
// fast despite being combinatorial.
function houghQuad(lines: HLine[], W: number, H: number): { pts: Pt[]; votes: number } | null {
  let best: { pts: Pt[]; votes: number } | null = null;
  let bestScore = -Infinity;
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (angleDiffDeg(lines[i].theta, lines[j].theta) > 12) continue;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        if (Math.abs(angleDiffDeg(lines[i].theta, lines[k].theta) - 90) > 18) continue;
        for (let l = k + 1; l < n; l++) {
          if (l === i || l === j) continue;
          if (angleDiffDeg(lines[k].theta, lines[l].theta) > 12) continue;
          const p1 = lineIntersection(lines[i], lines[k]);
          const p2 = lineIntersection(lines[i], lines[l]);
          const p3 = lineIntersection(lines[j], lines[l]);
          const p4 = lineIntersection(lines[j], lines[k]);
          if (!p1 || !p2 || !p3 || !p4) continue;
          const pts = [p1, p2, p3, p4];
          if (pts.some((p) => p.x < -W * 0.15 || p.x > W * 1.15 || p.y < -H * 0.15 || p.y > H * 1.15)) continue;
          const ordered = orderCorners(pts);
          if (quadArea(ordered) < W * H * 0.06) continue;
          if (!looksLikeDocument(ordered)) continue;
          const votes = lines[i].votes + lines[j].votes + lines[k].votes + lines[l].votes;
          const score = votes * (1 + paperRatioBonus(ordered));
          if (score > bestScore) { bestScore = score; best = { pts: ordered, votes }; }
        }
      }
    }
  }
  return best;
}

// Edge-based mask: a document's boundary is a gradient discontinuity regardless
// of absolute brightness, so this works even when the page and the surface
// behind it are similarly bright (the classic failure case for pure intensity
// thresholding). Blur → Sobel magnitude → Otsu → dilate to close small gaps →
// flood-fill "outside" from the image borders (blocked by edge pixels) →
// whatever's left unreached and isn't itself an edge is the document's interior.
function gradientInteriorMask(W: number, H: number, sobel: Sobel): Uint8Array {
  const n = W * H;
  const mag = sobel.mag;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, mag[i] | 0)]++;
  const thr = Math.max(20, otsuThreshold(hist, n));
  let edge: Uint8Array<ArrayBufferLike> = new Uint8Array(n);
  for (let i = 0; i < n; i++) edge[i] = mag[i] > thr ? 1 : 0;
  edge = dilateMask(edge, W, H);
  edge = dilateMask(edge, W, H);

  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seed = (i: number) => { if (!edge[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % W, y = (p / W) | 0;
    if (x > 0) seed(p - 1);
    if (x < W - 1) seed(p + 1);
    if (y > 0) seed(p - W);
    if (y < H - 1) seed(p + W);
  }
  const interior = new Uint8Array(n);
  for (let i = 0; i < n; i++) interior[i] = (!edge[i] && !outside[i]) ? 1 : 0;
  return interior;
}

function quadArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += p[i].x * p[j].y - p[j].x * p[i].y;
  }
  return Math.abs(a) / 2;
}

function angleAtDeg(a: Pt, b: Pt, c: Pt): number {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-6 || m2 < 1e-6) return 0;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return Math.acos(cos) * 180 / Math.PI;
}

// A blob can be large, solid and fill its fitted rectangle well and still not
// be a document — a round plate, a person's white shirt, an arm. This is the
// actual geometric check that was missing: real opposite sides of a rectangle
// (even skewed by phone-camera perspective) stay within about 2x of each
// other's length, and its interior angles stay roughly near 90°. A blob that
// merely LOOKS rectangle-ish in aggregate (fill ratio) but isn't one fails
// this outright, regardless of how confident the fill-based score was.
function looksLikeDocument(pts: Pt[]): boolean {
  const [tl, tr, br, bl] = pts;
  const top = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const left = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const right = Math.hypot(br.x - tr.x, br.y - tr.y);
  if (Math.min(top, bottom, left, right) < 1) return false;
  if (Math.max(top, bottom) / Math.min(top, bottom) > 1.9) return false;
  if (Math.max(left, right) / Math.min(left, right) > 1.9) return false;
  const angles = [angleAtDeg(bl, tl, tr), angleAtDeg(tl, tr, br), angleAtDeg(tr, br, bl), angleAtDeg(br, bl, tl)];
  return angles.every((a) => a >= 55 && a <= 125);
}

// Downscale `draw` to grayscale + the raw RGBA sample, reusing `scratch`
// canvas to avoid per-frame allocation in the live preview loop.
type Scratch = HTMLCanvasElement | OffscreenCanvas;

function sampleGray(draw: CanvasImageSource, sw: number, sh: number, maxDim: number, scratch?: Scratch) {
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const W = Math.max(1, Math.round(sw * scale));
  const H = Math.max(1, Math.round(sh * scale));
  const c: Scratch = scratch ?? document.createElement("canvas");
  if (c.width !== W) c.width = W;
  if (c.height !== H) c.height = H;
  const cx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cx.drawImage(draw as any, 0, 0, W, H);
  const rgba = cx.getImageData(0, 0, W, H).data;
  const n = W * H;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) | 0;
  }
  return { gray, rgba, W, H };
}

// A fixed "must be white" rule (a specific saturation/brightness cutoff) goes
// by color in exactly the naive way that breaks on a beige desk — beige is
// bright and low-saturation enough to pass the same test as the actual white
// page sitting on it, merging both into one blob with no boundary between
// them. This instead samples a small patch at a chosen point of the frame —
// most often the center, where a centered document naturally lands, but the
// caller can try a few different spots (see SEED_POINTS below) since the
// document isn't always perfectly centered — as a per-shot color reference,
// and masks every pixel close to THAT color, whatever it actually is (white,
// cream, a pastel form, anything). The distance tolerance adapts to how
// uniform the seed patch itself is: a clean blank-paper spot gives a tight
// tolerance, while a noisier one (a hand, printed text, background instead of
// the document) widens it automatically instead of using one fixed magic
// number that would be wrong depending on the scene. It self-corrects every
// tick since nothing here persists across frames — a bad seed on one frame
// just fails to find a good mask that frame, no different from any other
// miss the existing hysteresis already smooths over.
function seedColorMaskAt(rgba: Uint8ClampedArray, W: number, H: number, cxFrac: number, cyFrac: number): Uint8Array {
  const n = W * H;
  const halfW = Math.round(W * 0.08), halfH = Math.round(H * 0.08);
  const ccx = Math.round(W * cxFrac), ccy = Math.round(H * cyFrac);
  const cx0 = Math.max(0, ccx - halfW), cx1 = Math.min(W, ccx + halfW);
  const cy0 = Math.max(0, ccy - halfH), cy1 = Math.min(H, ccy + halfH);
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const i = (y * W + x) * 4;
      sr += rgba[i]; sg += rgba[i + 1]; sb += rgba[i + 2]; cnt++;
    }
  }
  const mask = new Uint8Array(n);
  if (!cnt) return mask;
  const mr = sr / cnt, mg = sg / cnt, mb = sb / cnt;
  let varSum = 0;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const i = (y * W + x) * 4;
      const dr = rgba[i] - mr, dg = rgba[i + 1] - mg, db = rgba[i + 2] - mb;
      varSum += dr * dr + dg * dg + db * db;
    }
  }
  const seedStd = Math.sqrt(varSum / cnt);
  const thresh = Math.max(26, seedStd * 3.2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, di = i * 4;
      const dr = rgba[di] - mr, dg = rgba[di + 1] - mg, db = rgba[di + 2] - mb;
      mask[i] = Math.sqrt(dr * dr + dg * dg + db * db) < thresh ? 1 : 0;
    }
  }
  return mask;
}

export interface FrameDetection { pts: Pt[]; confidence: number; sharpness: number; }

const MIN_CONFIDENCE = 0.55; // below this the fitted rectangle doesn't really match the blob

// Auto edge detection (pure JS, no OpenCV — runs everywhere, never crashes iOS,
// cheap enough to run live on every device). Ensembles candidate masks —
// several adaptive seed-color samples (see seedColorMaskAt), gradient/edge-
// based, and (last resort) plain bright-on-dark/dark-on-bright. No seed-color
// mask is trusted on its own — a same-colored background alone would trigger
// it — it only counts where corroborated by an actual detected boundary
// (a genuine edge-enclosed area), i.e. "looks like the reference color AND
// inside something we can actually see the edges of". Each mask is
// morphologically closed so a shadow/fold/glare streak splitting the page
// doesn't cost the detection, the
// top few blobs per mask are considered, and nearby ones are unioned back into
// one shape before picking a winner. Corners come from fitting a true minimum-
// area rectangle (any angle) via convex hull + rotating calipers; the result
// then has to pass looksLikeDocument — actual rectangle geometry, not just a
// good fill score — before it's accepted at all.
function detectCornersFrame(draw: CanvasImageSource, sw: number, sh: number, maxDim: number, scratch?: Scratch): FrameDetection | null {
  const { gray, rgba, W, H } = sampleGray(draw, sw, sh, maxDim, scratch);
  const n = W * H;
  const sx = sw / W, sy = sh / H;
  const sobel = sobelGradientsColor(rgba, W, H);

  const magHist = new Uint32Array(256);
  let magSum = 0;
  for (let i = 0; i < n; i++) { const m = Math.min(255, sobel.mag[i] | 0); magHist[m]++; magSum += m; }
  // Mean gradient magnitude of the whole frame doubles as a cheap sharpness
  // proxy — a genuinely out-of-focus or motion-blurred frame has much weaker
  // edges everywhere, document included, regardless of what detection method
  // finds. Exposed on the result so the caller can refuse to auto-capture a
  // blurry read even if a quad was technically found.
  const sharpness = magSum / n;
  const otsuMag = otsuThreshold(magHist, n);

  // The one-shot passes (confirm before capture, static-image auto-detect) can
  // afford a finer angular search and more candidate lines than the live
  // preview loop (which runs every ~450ms and has to stay cheap) — this is
  // what actually improves corner precision on frames that matter most.
  const thorough = maxDim >= 400;
  const thetaBins = thorough ? 180 : 90;
  const maxLines = thorough ? 30 : 24;

  // Method 1: Hough line detection — finds the 4 straight sides directly, so
  // it works even when the page and background are nearly the same color
  // (the one case the mask-based ensemble below structurally can't solve,
  // since there's no color/brightness boundary for a blob to key off at all —
  // but there's almost always still a faint edge/shadow line the gradient
  // picks up). Tried first at a stricter threshold (cleaner lines, the more
  // principled read when available), then retried once at a looser threshold
  // before giving up to the mask ensemble — a single fixed threshold missed
  // real documents in low-contrast scenes (pale page on a pale desk) where
  // weaker-but-real edges only show up once the bar is lowered.
  let hq: ReturnType<typeof houghQuad> = null;
  for (const mult of [0.6, 0.35]) {
    const edgeThr = Math.max(14, otsuMag * mult);
    const lines = houghLines(sobel, W, H, edgeThr, maxLines, thetaBins);
    if (lines.length < 4) continue;
    hq = houghQuad(lines, W, H);
    if (hq) break;
  }
  if (hq) {
    // Refinement is a handful of extra full-frame passes — cheap once at
    // confirm/still-image resolution, but real cost added on every successful
    // live-preview tick (every ~450ms) is exactly the kind of per-frame work
    // that made the overlay janky while moving the camera before detection
    // moved to a worker — so it only runs for the one-shot thorough passes.
    const refinedPts = thorough ? refineQuadEdges(sobel, W, H, hq.pts) : hq.pts;
    const pts = refinedPts.map((p) => ({
      x: Math.max(0, Math.min(sw, p.x * sx)),
      y: Math.max(0, Math.min(sh, p.y * sy)),
    }));
    return { pts, confidence: 0.85, sharpness };
  }

  // Method 2 (fallback): mask ensemble — intensity (bright/dark), gradient-
  // enclosed region, and an adaptive seed-color signal (whatever color sits
  // at a sampled point of the frame, corroborated by an actual gradient
  // boundary — a same-colored background alone shouldn't count). Each mask is
  // morphologically closed and its top few blobs unioned back together before
  // fitting a true minimum-area rectangle to the winner's boundary.
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  const thr = otsuThreshold(hist, n);
  const brightMask = new Uint8Array(n);
  const darkMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) { if (gray[i] > thr) brightMask[i] = 1; else darkMask[i] = 1; }
  const gradMask = gradientInteriorMask(W, H, sobel);

  // A document isn't always dead-centered in frame, especially while the
  // user is still framing the shot — sampling only the exact center means one
  // off-center photo silently seeds from the background instead of the page,
  // corrupting the whole mask. Trying a handful of candidate points instead
  // (competing on the exact same component-score logic already used below,
  // no new comparison machinery needed) makes the seed-color idea robust to
  // that instead of assuming perfect centering. Thorough (one-shot) passes
  // afford the full grid; the live loop keeps a cheaper subset.
  const seedPoints: Array<[number, number]> = thorough
    ? [[0.5, 0.5], [0.5, 0.32], [0.5, 0.68], [0.32, 0.5], [0.68, 0.5]]
    : [[0.5, 0.5], [0.5, 0.4]];
  const seedConfirmedMasks = seedPoints.map(([cxf, cyf]) => {
    const seedMask = seedColorMaskAt(rgba, W, H, cxf, cyf);
    const confirmed = new Uint8Array(n);
    for (let i = 0; i < n; i++) confirmed[i] = (seedMask[i] && gradMask[i]) ? 1 : 0;
    return closeMask(confirmed, W, H, 2);
  });

  // Color/boundary-aware masks go first and win on their own merit; the plain
  // brightness split (brightMask/darkMask) only gets a say if none of them
  // found anything at all. A big "everything bright" blob — beige desk fused
  // with the white page sitting on it, since beige clears the same global
  // brightness threshold — would otherwise often out-SCORE the smaller,
  // correctly-segmented seed/gradient blob simply by being bigger, which is
  // exactly the "goes by color" failure this is meant to fix.
  const smartMasks = [...seedConfirmedMasks, gradMask];
  let best: DocComp | null = null;
  for (const m of smartMasks) {
    const merged = mergeNearby(topComponents(m, W, H, 3), W, H);
    if (merged && (!best || merged.score > best.score)) best = merged;
  }
  if (!best) {
    const naiveMasks = [closeMask(brightMask, W, H, 1), closeMask(darkMask, W, H, 1)];
    for (const m of naiveMasks) {
      const merged = mergeNearby(topComponents(m, W, H, 3), W, H);
      if (merged && (!best || merged.score > best.score)) best = merged;
    }
  }
  if (!best) return null;
  const frac = best.size / n;
  if (frac < 0.06 || frac > 0.995) return null;

  const refined = refineComponent(best);
  if (!refined || refined.confidence < MIN_CONFIDENCE) return null;
  const orderedRefined = orderCorners(refined.pts);
  const refinedPts = thorough ? refineQuadEdges(sobel, W, H, orderedRefined) : orderedRefined;
  const pts = refinedPts.map((p) => ({
    x: Math.max(0, Math.min(sw, p.x * sx)),
    y: Math.max(0, Math.min(sh, p.y * sy)),
  }));
  if (quadArea(pts) < sw * sh * 0.05) return null;
  if (!looksLikeDocument(pts)) return null;
  return { pts, confidence: refined.confidence, sharpness };
}

// Run detection on a live video frame (or any drawable), reusing a scratch
// canvas so it's cheap enough for a ~2fps preview loop on every device. Exposes
// confidence so the caller can require a solid read before trusting it — that's
// what keeps auto-capture from firing on a shaky, low-quality "detection".
export function detectCornersLive(draw: CanvasImageSource, sw: number, sh: number, scratch: Scratch): FrameDetection | null {
  return detectCornersFrame(draw, sw, sh, 260, scratch);
}

// The second, slower opinion: once the fast live loop thinks it has found a
// steady document, this re-samples the SAME frame at a much higher resolution
// before we actually fire the shutter. It's only called once, right before
// capture — not every tick — so the extra cost (bigger sample, same pipeline)
// is negligible, but it's the gate that has to get it right: noise and coarse
// sampling both hide at 260px and can surface at 480px, catching false
// positives the fast pass missed.
export function detectCornersConfirm(draw: CanvasImageSource, sw: number, sh: number, scratch: Scratch): FrameDetection | null {
  return detectCornersFrame(draw, sw, sh, 480, scratch);
}

// Detect corners on a static captured/uploaded image. Sampled at a higher
// resolution than the live preview since this only runs once (after capture,
// or on demand) and its output directly determines the final crop — a coarser
// sample here is what causes corners to undershoot the real edges.
export function autoDetectCorners(src: HTMLImageElement | HTMLCanvasElement): Pt[] {
  const sw = "naturalWidth" in src ? src.naturalWidth : src.width;
  const sh = "naturalHeight" in src ? src.naturalHeight : src.height;
  const inset = (): Pt[] => [
    { x: sw * 0.06, y: sh * 0.06 }, { x: sw * 0.94, y: sh * 0.06 },
    { x: sw * 0.94, y: sh * 0.94 }, { x: sw * 0.06, y: sh * 0.94 },
  ];
  try {
    return detectCornersFrame(src, sw, sh, 640)?.pts ?? inset();
  } catch {
    return inset();
  }
}
