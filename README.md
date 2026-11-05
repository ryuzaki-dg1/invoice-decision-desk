# Invoice Decision Desk

An exception-first accounts-payable workspace. It takes a vendor invoice (digital PDF, scanned PDF or a photo of a handwritten bill), checks it against purchase orders, the vendor master and invoice history, and returns a decision. For every exception it shows **what happened, why it matters, the evidence, and what the AP team should do next**, then records how a reviewer resolved it.

> Built on top of [jwaldor/ap-exception](https://github.com/jwaldor/ap-exception) (React + Node scaffold, LLM proxy pattern). The pipeline, decision engine, review workflow, data model, run store and UI were rewritten for this case study.

## Product principle

**AI reads and explains. Deterministic rules validate and decide. Humans resolve exceptions.**

- A vision model extracts the fields. Every check after that is plain code with a named threshold, so the same invoice always gets the same decision and each decision cites the rule codes that produced it.
- The model then writes a plain-English summary and a vendor email draft. It is told the decision and cannot change it. If the model is unavailable, a template explanation is used and the decision is unaffected.
- Reviewer actions are enforced on the server with the same rules the UI uses, so no button can bypass an open control.

## Decision policy (strictest finding wins; all findings are kept)

| Outcome | When | Reason codes |
|---|---|---|
| **Rejected** | Confirmed duplicate, blocked vendor | `DUPLICATE_INVOICE`, `VENDOR_BLOCKED` |
| **Payment hold** | Security or vendor-identity risk | `BANK_ACCOUNT_MISMATCH`, `UNKNOWN_VENDOR`, `PO_VENDOR_MISMATCH` |
| **Needs review** | Human judgement or clarification | `ARITHMETIC_MISMATCH`, `MISSING_FIELD`, `PO_MATCH_UNCONFIRMED`, `CUMULATIVE_PO_EXCEEDED`, `PO_AMOUNT_EXCEEDED`, `QUANTITY_EXCEEDS_PO`, `PRICE_VARIANCE`, `LOW_EXTRACTION_CONFIDENCE`, `HANDWRITTEN_DOCUMENT`, `EXPIRED_PO`, `POSSIBLE_DUPLICATE`, `OVER_APPROVAL_LIMIT` |
| **Approved** | All mandatory checks pass | info-only: `WITHIN_TOLERANCE`, `PARTIAL_BILLING`, `VENDOR_NAME_VARIANT`, `SCANNED_DOCUMENT`, `REPEAT_SUBMISSION` |

Key rules:

- **Arithmetic:** expected total = subtotal + tax + freight + other charges − discount, compared within a $1 rounding tolerance. The 2% PO tolerance never excuses an invoice that doesn't add up internally.
- **PO value:** cumulative billing (previous invoices on the PO + this one) is compared against PO value × (1 + 2%). Split invoicing passes while the running total fits.
- **Inferred PO:** shown as a *suggested* match (`PO_MATCH_UNCONFIRMED`) that a reviewer must confirm.
- **Duplicates:** conservative invoice-number normalisation (case, spaces, punctuation, a leading "INV"/"Invoice No" label, leading zeros), scoped to the same vendor. Same amount with a different number is only a *possible* duplicate. A byte-identical re-upload is recorded as a repeat submission and never adds a payable.
- **Approved ≠ paid:** "paid" is only said when the ERP history has a payment record (seeded demo data). Invoices approved here are "approved for payment, not yet paid".

## Reviewer workflow

| Open control | Required resolution |
|---|---|
| Bank account mismatch | "Record independent bank verification", with a checkbox confirming a call-back to the contact on file. The hold then clears to Needs review; approval is a separate step. |
| Suggested PO | "Confirm suggested PO" before Approve is enabled |
| Unknown vendor | Cannot be approved here; request onboarding, keep on hold, or reject |
| Other review items | Approve with justification, request clarification, or reject |

Every status change requires a reviewer name (lightweight demo identity) and a justification, and is logged with the from/to status and timestamp. Approved and rejected cases are final.

## Screens

- **Overview:** KPIs (processed, straight-through rate, awaiting review, value requiring intervention, average time), *Needs your attention* ordered by severity then age, decision breakdown, top exception reasons, searchable activity.
- **Process Invoice:** intake, an 8-stage live timeline (business-rule blocks shown separately from system errors), then the decision workspace.
- **Review Queue:** open exceptions only; rejected invoices are closed.
- **Invoice detail:** decision header (what / why / next / who decided), control strip, original document beside the extracted fields, evidence (invoice vs PO, vendor and bank vs master, duplicate reference), resolution panel, findings, audit trail, timeline, vendor email.
- **Invoice History**, **Reference Data** (POs with billed/remaining, vendor master, ERP payment history) and **Policy Rules** (editable thresholds + precedence).

Metric definitions:
- **Straight-through rate:** auto-approved ÷ processed, excluding repeat submissions.
- **Awaiting review:** needs review + payment hold + awaiting vendor.
- **Value requiring intervention:** the sum of those open invoices.

## Demo inputs (`app/public/samples`)

| File | Scenario | Expected |
|---|---|---|
| `01-acme-happy-path.pdf` | Totals reconcile; freight makes it $0.85 (0.06%) above the PO, inside 2% | Approved |
| `02-sunridge-split-overbilling.pdf` | 12 of 20 drums already paid on SC-3371; this invoice bills 10 more (110% of PO) | Needs review |
| `03-northstar-duplicate-scan.pdf` | Scanned resubmission of paid INV-7712, printed as "7712" | Rejected |
| `04-rao-handwritten-no-po.jpg` | Handwritten, no PO number; PO-2026-0225 suggested | Needs review |
| `05-acme-bank-change.pdf` | Perfect PO match but "our banking details have changed" | Payment hold |
| `06-unknown-vendor.pdf` | Vendor not in master, no PO | Payment hold |

Reference data lives in `app/src/data/`. Regenerate the samples with `npm run make-samples` (the scanned and handwritten images come from `scripts/make-images.ps1`).

## Run locally

```bash
cd app
npm install
cp .env.example .env   # add one key: GEMINI_API_KEY (free tier works), OPENAI_API_KEY or OPENROUTER_API_KEY
npm run dev            # http://localhost:5173
```

## Testing

- `npm test` runs 17 tests on the decision engine and review rules: every scenario plus arithmetic, discounts, approved-vs-paid wording, repeat uploads, possible duplicates and reviewer controls. No API calls are made.
- `node scripts/e2e.mjs` drives the real UI in Edge through all six invoices with the live model, then a repeat upload and the bank-verification review flow, and saves screenshots. It clears run history first. `--ui-only` reuses stored runs to save model quota.

## Deploy

```bash
cd app
docker build -t invoice-desk .
docker run -p 3000:3000 -e GEMINI_API_KEY=... invoice-desk
```

Runs are stored in `DATA_DIR` (default `./data`): `runs.json` plus page previews in `docs/`. Attach a volume to keep them across deploys.

## Assumptions and limits

- One company, USD, 2-way match (invoice ↔ PO). Goods receipts (3-way match) would slot into the PO stage.
- The PO table, vendor master and ERP payment history are static demo files standing in for an ERP. Run history is a JSON file. Production would use the ERP API and a database.
- Policy thresholds are stored per browser. Reviewer identity is a typed name, not authentication.
- Invoices arrive by upload; an email inbox listener would call the same pipeline. Up to 3 pages per invoice are sent to the model.
- Low-confidence fields are the model's self-report, not a calibrated score. No source-position highlighting on the page image.
- Model: Gemini 3.5 Flash with automatic retry and fallback (`gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.5-flash-lite`) on 429/503. The free tier rate-limits heavily, so expect 10–60 s per invoice when it is busy.
