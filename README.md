# Document Scanner — Free Online Tool

**Document Scanner.** Scan documents with your camera, fix the perspective, apply filters and export to PDF. Multi-page and OCR. No sign-up, no ads, 100% client-side.

🌐 **Demo en vivo / Live demo:** [miguelacm.es/tools/document-scanner](https://miguelacm.es/tools/document-scanner)

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## ✨ Features

- **📷 Scan with the camera:** Auto corner detection and perspective warp for clean scans.
- **🔍 OCR included:** Tesseract.js extracts text from every page, on your device.
- **📄 Multi-page PDF:** Reorder pages and export the whole scan as a PDF or ZIP.

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
NEXT_PUBLIC_SITE_URL=https://miguelacm.es/tools/document-scanner
NEXT_PUBLIC_EMBED_URL=https://miguelacm.es/embed/document-scanner
```

---

## 📦 Embed on your website

```html
<iframe
  src="https://miguelacm.es/embed/document-scanner"
  width="100%"
  height="700"
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

> 💡 The link option generates a real backlink that benefits the project.

---

## 🛠 Tech Stack

| Technology | Version | Purpose |
|---|---|---|
| [Next.js](https://nextjs.org) | 16 | React framework |
| [TypeScript](https://www.typescriptlang.org) | 5 | Type safety |
| [Tailwind CSS](https://tailwindcss.com) | 4 | Styling |
| [react-icons](https://react-icons.github.io/react-icons/) | 5 | Icons |
| `tesseract.js` | — | Core logic |
| `pdf-lib` | — | Core logic |
| `jspdf` | — | Core logic |
| `fflate` | — | Core logic |

---

## 📄 License

MIT © [Miguel Ángel Colorado Marin (MACM)](https://miguelacm.es)

Built with ❤️ by **[MACM](https://miguelacm.es)** — Full Stack Developer & Cybersecurity Specialist from Guadalajara, Spain.

- 🌐 Portfolio: [miguelacm.es](https://miguelacm.es)
- 💼 LinkedIn: [linkedin.com/in/macm](https://www.linkedin.com/in/macm/)
- 🐙 GitHub: [github.com/m-a-c-m](https://github.com/m-a-c-m)
