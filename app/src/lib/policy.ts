// AP policy knobs (pure, usable on the server). Every threshold the decision
// engine uses lives here so the run trail can say which limit fired.

export interface Rules {
  amountTolerancePct: number; // fraction: cumulative billing vs PO value
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
