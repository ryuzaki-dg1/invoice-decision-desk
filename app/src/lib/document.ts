// Turns an uploaded file into what the extraction model needs: page images
// (works for any vision model, scanned or digital) plus the PDF text layer
// when one exists. A PDF without a text layer is a scan.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { TextBox } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 3;

export interface PreparedDocument {
  fileName: string;
  fileHash: string; // SHA-256 of the uploaded bytes, to recognise re-uploads
  mimeType: string;
  pageImages: string[]; // data URLs (PNG/JPEG)
  textLayer: string;
  hasTextLayer: boolean;
  pageCount: number;
  textBoxes?: TextBox[]; // page-1 text positions (digital PDFs only)
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function prepareDocument(file: File): Promise<PreparedDocument> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const bytes = await file.arrayBuffer();
  const fileHash = await sha256(bytes);
  if (!isPdf) {
    if (!file.type.startsWith("image/")) throw new Error(`Unsupported file type "${file.type || file.name}". Upload a PDF or an image.`);
    return {
      fileName: file.name,
      fileHash,
      mimeType: file.type,
      pageImages: [await readAsDataUrl(file)],
      textLayer: "",
      hasTextLayer: false,
      pageCount: 1,
    };
  }

  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  const images: string[] = [];
  const texts: string[] = [];
  const textBoxes: TextBox[] = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    texts.push(
      content.items
        .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : ""))
        .join("")
        .trim(),
    );
    const viewport = page.getViewport({ scale: 1.6 });
    if (i === 1) {
      // Real positions of each text run on page 1, as fractions of the page,
      // so the viewer can point at the exact source of an extracted value.
      for (const it of content.items) {
        if (!("str" in it) || !it.str.trim()) continue;
        const t = pdfjs.Util.transform(viewport.transform, it.transform);
        const fontH = Math.hypot(t[2], t[3]);
        textBoxes.push({
          s: it.str,
          x: t[4] / viewport.width,
          y: (t[5] - fontH) / viewport.height,
          w: (it.width * viewport.scale) / viewport.width,
          h: (fontH * 1.15) / viewport.height,
        });
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    images.push(canvas.toDataURL("image/jpeg", 0.85));
  }
  const textLayer = texts.join("\n\n--- page break ---\n\n");
  return {
    fileName: file.name,
    fileHash,
    mimeType: "application/pdf",
    pageImages: images,
    textLayer,
    hasTextLayer: textLayer.replace(/\s/g, "").length > 40,
    pageCount: pdf.numPages,
    textBoxes,
  };
}
