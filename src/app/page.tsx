import type { Metadata } from "next";
import DocumentScanner from "@/components/DocumentScanner";
import { MdDocumentScanner } from "react-icons/md";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://miguelacm.es/tools/document-scanner";
const EMBED_URL = process.env.NEXT_PUBLIC_EMBED_URL || "https://miguelacm.es/embed/document-scanner";

export const metadata: Metadata = {
  title: "Document Scanner — Free Online, Scan to PDF",
  description: "Scan documents with your phone on any background, straighten the perspective, auto-rotate and export to a searchable-text PDF (OCR). No sign-up, no ads, 100% client-side.",
  alternates: { canonical: SITE_URL },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Document Scanner",
  url: SITE_URL,
  description: "Scan documents with the camera on any background and export to a searchable-text PDF, 100% in the browser.",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  inLanguage: "en",
  offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
  author: { "@type": "Person", name: "Miguel Ángel Colorado Marin", url: "https://miguelacm.es" },
  featureList: [
    "Camera scanning on any background",
    "Perspective correction",
    "Auto-rotation by orientation",
    "Scanner filters (Magic, B&W, Whiteboard)",
    "Multi-page to PDF",
    "Searchable-text PDF (OCR)",
    "100% in browser",
  ],
};

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <main className="min-h-screen px-4 py-12">
        <div className="mx-auto max-w-4xl">
          <div className="mb-10 text-center">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-4 py-1.5 text-sm text-primary">
              <MdDocumentScanner className="text-base" />
              Free tool · Open source · 100% client-side
            </div>
            <h1 className="mb-3 text-4xl font-bold text-white md:text-5xl">Document Scanner</h1>
            <p className="mb-2 text-lg text-text-muted">
              Scan documents on any background, straighten the perspective, auto-rotate and export to a searchable-text PDF.
            </p>
            <p className="text-sm text-text-muted/60">
              By{" "}
              <a href="https://miguelacm.es" target="_blank" rel="noopener noreferrer" className="gradient-text font-medium hover:opacity-80 transition-opacity">MACM</a>
              {" "}· Your documents never leave your device
            </p>
          </div>

          <div className="glass rounded-2xl border border-border/20 p-6 md:p-8">
            <DocumentScanner locale="en" />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              { icon: "🎨", title: "Works on any background", desc: "Detection analyzes the actual color it sees in each photo instead of assuming a white page, so a pale document on a beige or wooden desk still gets found." },
              { icon: "🔄", title: "Auto-rotation", desc: "If the text comes out sideways or upside down, it's automatically rotated the right way up before saving." },
              { icon: "🔍", title: "Searchable PDF", desc: "Export a multi-page PDF with an invisible OCR text layer over each image, so the final file can be searched and its text selected." },
            ].map((item) => (
              <div key={item.icon} className="glass rounded-xl border border-border/15 p-5">
                <span className="mb-3 block text-2xl">{item.icon}</span>
                <h3 className="mb-1 font-semibold text-white">{item.title}</h3>
                <p className="text-sm text-text-muted leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 rounded-xl border border-border/20 bg-white/3 p-6">
            <h2 className="mb-4 text-lg font-semibold text-white">How to scan a document</h2>
            <ol className="space-y-3">
              {[
                { n: 1, text: "Open the camera and take a photo of the document, or upload an image. Works on mobile with the back camera, on any background." },
                { n: 2, text: "The tool auto-detects the 4 corners. Drag them if it misses; a loupe helps you fine-tune with your finger." },
                { n: 3, text: "The perspective is straightened and auto-rotated if needed. Pick a filter: Magic, Gray, Black & White or Whiteboard." },
                { n: 4, text: "Repeat to scan more pages — reorder, rotate or delete them from the gallery." },
                { n: 5, text: "Export everything as a multi-page PDF (optionally with searchable text) or as images." },
              ].map((step) => (
                <li key={step.n} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">{step.n}</span>
                  <p className="text-sm text-text-muted leading-relaxed">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>

          <div className="mt-8 space-y-4">
            <h2 className="text-lg font-semibold text-white">Frequently asked questions</h2>
            {[
              { q: "Are my documents uploaded to a server?", a: "No. All scanning, filters and OCR run 100% in your browser. Your documents are never sent to any server or stored — it's the most private way to scan confidential papers." },
              { q: "Does it detect the document on any background?", a: "Yes. Instead of assuming the document is white, it analyzes the actual color it sees in each photo and tells it apart from the background even when they're close, like a pale page on a beige or wooden desk." },
              { q: "Does the exported PDF have selectable text?", a: "You can enable the searchable-text PDF option when exporting: each page goes through OCR and the recognized text is added as an invisible layer over the image." },
              { q: "Does it work on mobile?", a: "Yes, it's built for mobile: back camera scanning, large touch-friendly controls, and a loupe to fine-tune corners with your finger. It also works on tablet and desktop." },
              { q: "Can I combine several pages into one PDF?", a: "Yes. Scan as many pages as you want, reorder them and download a single multi-page PDF, or images in a ZIP. No watermark, no limits, no sign-up." },
            ].map((item) => (
              <div key={item.q} className="rounded-xl border border-border/20 bg-white/3 p-5">
                <h3 className="mb-2 font-medium text-white">{item.q}</h3>
                <p className="text-sm text-text-muted leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 rounded-xl border border-border/20 bg-white/3 p-6">
            <h2 className="mb-2 font-semibold text-white">Embed this tool on your website</h2>
            <p className="mb-4 text-sm text-text-muted">Add the Document Scanner to any page with a simple iframe, or link to it with attribution.</p>
            <div className="mb-3 rounded-lg bg-black/40 p-3">
              <p className="mb-1 text-xs text-text-muted/60">Iframe (plug & play):</p>
              <code className="text-xs text-green-400 break-all">{`<iframe src="${EMBED_URL}" width="100%" height="800" style="border:none;border-radius:12px;" title="Document Scanner — miguelacm.es" loading="lazy"></iframe>`}</code>
            </div>
            <div className="rounded-lg bg-black/40 p-3">
              <p className="mb-1 text-xs text-text-muted/60">Link with attribution (recommended for backlink):</p>
              <code className="text-xs text-green-400 break-all">{`<a href="${SITE_URL}" target="_blank" rel="noopener">Document Scanner — free tool by MACM</a>`}</code>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
