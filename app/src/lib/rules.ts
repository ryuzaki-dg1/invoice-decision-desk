// AP policy knobs. Every threshold the decision engine uses lives here so the
// AP lead can tune it from the UI, and the run trail can say which limit fired.

export interface Rules {
  amountTolerancePct: number; // fraction: invoice total vs remaining PO value
  priceTolerancePct: number; // fraction: unit price vs PO unit price
  quantityTolerance: number; // whole units over the PO quantity
  arithmeticToleranceAbs: number; // currency units: line sums vs printed totals
  duplicateWindowDays: number; // same vendor + same amount within N days
  autoApproveLimit: number; // anything above this total always gets a human
  reviewHandwritten: boolean; // never auto-approve handwritten invoices
}

export const DEFAULT_RULES: Rules = {
  amountTolerancePct: 0.02,
  priceTolerancePct: 0.02,
  quantityTolerance: 0,
  arithmeticToleranceAbs: 1.0,
  duplicateWindowDays: 45,
  autoApproveLimit: 25000,
  reviewHandwritten: true,
};

const STORAGE_KEY = "ap_rules_v2";

export function loadRules(): Rules {
  if (typeof window === "undefined") return DEFAULT_RULES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RULES;
    return { ...DEFAULT_RULES, ...(JSON.parse(raw) as Partial<Rules>) };
  } catch {
    return DEFAULT_RULES;
  }
}

export function saveRules(rules: Rules): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}
