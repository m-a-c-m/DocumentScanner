import type { Metadata } from "next";
import Tool from "@/components/DocumentScanner";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://miguelacm.es/tools/document-scanner";
const EMBED_URL = process.env.NEXT_PUBLIC_EMBED_URL || "https://miguelacm.es/embed/document-scanner";

export const metadata: Metadata = {
  title: "Document Scanner — Free Online Tool",
  description: "Scan documents with your camera, fix the perspective, apply filters and export to PDF. Multi-page and OCR.",
  alternates: { canonical: SITE_URL },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Document Scanner",
  url: SITE_URL,
  description: "Scan documents with your camera, fix the perspective, apply filters and export to PDF. Multi-page and OCR.",
  applicationCategory: "UtilityApplication",
  operatingSystem: "Web",
  inLanguage: "en",
  offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
  author: { "@type": "Person", name: "Miguel Ángel Colorado Marin", url: "https://miguelacm.es" },
};

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <main className="min-h-screen px-4 py-12">
        <div className="mx-auto max-w-4xl">
          <div className="mb-10 text-center">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-4 py-1.5 text-sm text-primary">Free tool · Open source</div>
            <h1 className="mb-3 text-4xl font-bold text-white md:text-5xl">Document Scanner</h1>
            <p className="mb-2 text-lg text-text-muted">Scan documents with your camera, fix the perspective, apply filters and export to PDF. Multi-page and OCR.</p>
            <p className="text-sm text-text-muted/60">By{" "}<a href="https://miguelacm.es" target="_blank" rel="noopener noreferrer" className="gradient-text font-medium hover:opacity-80 transition-opacity">MACM</a>{" "}· No sign-up · No ads</p>
          </div>

          <div className="glass rounded-2xl border border-border/20 p-6 md:p-8"><Tool locale="en" /></div>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
            { icon: "📷", title: "Scan with the camera", desc: "Auto corner detection and perspective warp for clean scans." },
            { icon: "🔍", title: "OCR included", desc: "Tesseract.js extracts text from every page, on your device." },
            { icon: "📄", title: "Multi-page PDF", desc: "Reorder pages and export the whole scan as a PDF or ZIP." },
            ].map((item) => (
              <div key={item.icon + item.title} className="glass rounded-xl border border-border/15 p-5">
                <span className="mb-3 block text-2xl">{item.icon}</span>
                <h3 className="mb-1 font-semibold text-white">{item.title}</h3>
                <p className="text-sm text-text-muted leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 rounded-xl border border-border/20 bg-white/3 p-6">
            <h2 className="mb-2 font-semibold text-white">Embed this tool on your website</h2>
            <p className="mb-4 text-sm text-text-muted">Add Document Scanner to any page with a simple iframe, or link to it with attribution.</p>
            <div className="mb-3 rounded-lg bg-black/40 p-3">
              <p className="mb-1 text-xs text-text-muted/60">Iframe (plug & play):</p>
              <code className="text-xs text-green-400 break-all">{`<iframe src="${EMBED_URL}" width="100%" height="700" style="border:none;border-radius:12px;" title="Document Scanner — miguelacm.es" loading="lazy"></iframe>`}</code>
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
