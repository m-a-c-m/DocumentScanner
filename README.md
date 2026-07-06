# 📄 Document Scanner — Free Online, Scan to PDF

**Free Document Scanner.** Scan documents with your camera on any background, straighten the perspective, auto-rotate and export to a searchable-text PDF (OCR). No sign-up, no ads, 100% client-side.

🌐 **Demo en vivo / Live demo:** [miguelacm.es/tools/document-scanner](https://miguelacm.es/tools/document-scanner)

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## ✨ Features

- 📷 **Camera scanning:** Back camera on mobile, upload on desktop — one or several images at once
- 🎨 **Works on any background:** Detection analyzes the real color of each photo instead of assuming white paper, so pale documents on beige or wooden desks still get found
- 📐 **Perspective correction:** Auto-detects the 4 corners (Hough line detection + a mask ensemble fallback, no OpenCV) and unwarps them into a flat rectangle via homography
- 🔄 **Auto-rotation:** Detects text orientation (Tesseract OSD) and rotates the page the right way up automatically
- 🎛️ **Scanner filters:** Magic (auto white-balance + contrast), Gray, Black & White (adaptive threshold), Whiteboard (flattens uneven lighting on marker photos)
- 📚 **Multi-page:** Scan several pages, reorder, rotate or re-edit any of them from the gallery
- 📄 **Export to PDF or images:** Multi-page PDF (with page size presets), optional **searchable-text PDF** (OCR text embedded as an invisible layer), or a ZIP of images
- 🔤 **OCR:** Extract and copy the text of any page, in Spanish or English
- 💾 **Offline-friendly:** Scanned pages persist in IndexedDB — survive a reload or accidental close
- 🔒 **Zero server:** Everything — detection, OCR, PDF export — runs in the browser. Nothing is ever uploaded
- Open source: MIT license, use it freely

---

## 🚀 Quick start

```bash
git clone https://github.com/m-a-c-m/DocumentScanner.git
cd DocumentScanner
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables (optional)

```env
NEXT_PUBLIC_SITE_URL=https://scanner.miguelacm.es
```

---

## 📦 Embed on your website

### Iframe (plug & play)

```html
<iframe
  src="https://miguelacm.es/embed/document-scanner"
  width="100%"
  height="800"
  style="border:none;border-radius:12px;"
  title="Document Scanner — miguelacm.es"
  loading="lazy"
></iframe>
```

### Link with attribution (recommended for backlink)

```html
<a href="https://miguelacm.es/tools/document-scanner" target="_blank" rel="noopener">
  Document Scanner — free tool by MACM
</a>
```

> 💡 The link option generates a real backlink that benefits the project. Recommended if your platform supports custom HTML.

---

## 🛠 Tech Stack

| Technology | Version | Purpose |
|---|---|---|
| [Next.js](https://nextjs.org) | 16 | React framework + SSG |
| [TypeScript](https://www.typescriptlang.org) | 5 | Type safety |
| [Tailwind CSS](https://tailwindcss.com) | 4 | Styling |
| [react-icons](https://react-icons.github.io/react-icons/) | 5 | Icons |
| [jsPDF](https://github.com/parallax/jsPDF) | 4 | Multi-page PDF export |
| [pdf-lib](https://pdf-lib.js.org) | 1 | Merging searchable-text PDF pages |
| [fflate](https://github.com/101arrowz/fflate) | 0.8 | ZIP export |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | 6 | OCR + orientation detection |

---

## 🔬 How detection works

No OpenCV, no external model — a from-scratch pipeline in plain TypeScript:

1. **Gradient-directed Hough transform** finds the 4 dominant straight lines (the document's sides) directly, computed per color channel (not just grayscale luminance) so a boundary between two similarly-bright-but-differently-colored surfaces is still visible.
2. **Fallback mask ensemble** for low-contrast frames: an adaptive seed-color mask (sampled from several candidate points in the frame, not assuming white) corroborated by a gradient-based interior mask, plus a plain brightness split as a last resort.
3. Corners are refined sub-pixel via a magnitude-weighted fit to the real nearby edge pixels, and validated against real rectangle geometry (side ratios, angles) before being accepted.
4. A standard-paper-ratio bonus (Letter, A4, card...) nudges ambiguous candidates toward the far more common case, without ever rejecting an unusual shape.

---

## 📄 License

MIT © [Miguel Ángel Colorado Marin (MACM)](https://miguelacm.es)

Built with ❤️ by **[MACM](https://miguelacm.es)** — Full Stack Developer & Cybersecurity Specialist from Guadalajara, Spain.

- 🌐 Portfolio: [miguelacm.es](https://miguelacm.es)
- 💼 LinkedIn: [linkedin.com/in/macm](https://www.linkedin.com/in/macm/)
- 🐙 GitHub: [github.com/m-a-c-m](https://github.com/m-a-c-m)
