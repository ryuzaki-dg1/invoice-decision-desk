// Finds where an extracted value appears on the page, using the PDF text
// layer's real positions. Never guesses: if the text layer doesn't contain
// the value (scans, photos, or a value the model reformatted), it returns no
// boxes and the UI says so.

import type { TextBox } from "../types.ts";
import { digitsOnly, normalizeName } from "./engine.ts";

export type LocateKind = "money" | "text" | "date" | "digits" | "vendor";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const flat = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function dateVariants(iso: string): string[] {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [iso];
  const [, y, mo, d] = m;
  const mi = Number(mo) - 1;
  const dn = String(Number(d));
  const full = MONTHS[mi];
  const short = full.slice(0, 3);
  return [iso, `${full} ${dn}, ${y}`, `${short} ${dn}, ${y}`, `${dn} ${full} ${y}`, `${dn} ${short} ${y}`, `${mo}/${d}/${y}`, `${d}/${mo}/${y}`];
}

export function locate(boxes: TextBox[] | undefined, kind: LocateKind, value: string | number | null | undefined): TextBox[] {
  if (!boxes?.length || value === null || value === undefined || value === "") return [];
  const v = String(value);
  switch (kind) {
    case "money": {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      const variants = [n.toFixed(2), n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })];
      return boxes.filter((b) => variants.some((x) => new RegExp(`(^|[^0-9.,])${x.replace(/[.,]/g, "\\$&")}($|[^0-9])`).test(b.s)));
    }
    case "date": {
      const vs = dateVariants(v).map(flat);
      return boxes.filter((b) => vs.some((x) => flat(b.s).includes(x)));
    }
    case "digits": {
      const d = digitsOnly(v);
      if (d.length < 6) return [];
      return boxes.filter((b) => digitsOnly(b.s).includes(d));
    }
    case "vendor": {
      const n = normalizeName(v);
      if (n.length < 3) return [];
      return boxes.filter((b) => normalizeName(b.s).includes(n)).slice(0, 2);
    }
    default: {
      const f = flat(v);
      if (f.length < 3) return [];
      return boxes.filter((b) => flat(b.s).includes(f));
    }
  }
}
