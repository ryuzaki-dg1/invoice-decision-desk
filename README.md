# Invoice Decision Desk: PDF in, reasoned AP decision out

An automated accounts-payable process. It takes a vendor invoice (digital PDF, scanned PDF or a photo of a handwritten bill), checks it against purchase orders, the vendor master and invoice history, and returns one of four decisions with the reasons:

| Decision | Meaning | Example trigger |
|---|---|---|
| **Approved** | Pay on the due date, no human needed | Clean PO match within tolerance |
| **Needs review** | A person confirms specific items | Split invoices exceed the PO, PO had to be inferred, handwritten |
| **Payment hold** | Stop; AP manager or procurement must act | Bank details changed, unknown vendor |
| **Rejected** | Do not pay | Duplicate of an invoice already paid |

Every run is visible stage by stage while it executes and is saved to a dashboard with history, status, outputs and a reviewer approve/reject step.

> Built on top of [jwaldor/ap-exception](https://github.com/jwaldor/ap-exception) (React + Node scaffold, LLM proxy pattern). The pipeline, decision engine, data model, run store, dashboard and UI were rewritten for this case study.

## Design decisions

1. **The AI reads; plain rules decide.** A vision model extracts fields from the page. Every check after that is deterministic code with a named threshold, so the same invoice always gets the same decision and every decision cites the rule that produced it. The model writes the plain-English explanation afterwards and cannot change the decision.
2. **Strictest finding wins.** Each check emits findings tagged `reject`, `escalate`, `review` or `info`. The decision is the strictest tag present. This makes the policy easy to explain and to change.
3. **Compare against what is still open on the PO, not the full PO.** This lets vendors split a PO across invoices without false alarms, and catches the second invoice that pushes the total over.
4. **Bias towards a human when unsure.** An inferred PO, a handwritten document or a low-confidence read of a money field all route to review instead of auto-approval.
5. **Never email a possible fraudster.** For payment holds the process drafts no vendor email; it tells AP to verify through the contact on file.

## Process stages

```
ingest → extract (LLM) → validate → vendor → PO match → duplicates → decide (rules) → explain (LLM)
```

| Stage | What it checks |
|---|---|
| Ingest | Renders PDF pages to images; text layer present = digital, absent = scan |
| Extract | Vision model returns vendor, invoice #, PO ref, dates, lines, tax, total, bank account, document type, low-confidence fields |
| Validate | Required fields; line qty × price; lines vs subtotal; subtotal + tax + shipping vs total; handwritten policy; read confidence |
| Vendor | Vendor master match (exact, alias or fuzzy); blocked vendors; remit-to bank account vs account on file |
| PO match | Explicit PO or inferred (vendor + open value + line descriptions); expiry; currency; cumulative value and quantity across split invoices; unit price |
| Duplicates | Normalised invoice numbers (`INV-0923` = `923`); same vendor + same amount within N days |
| Decide | Strictest finding wins; auto-approve limit |
| Explain | Summary for AP and a draft vendor email (never sent automatically) |

## Demo inputs (`app/public/samples`)

| File | Scenario | Expected |
|---|---|---|
| `01-acme-happy-path.pdf` | Matches PO-2026-0142; tax $0.85 off (inside 2%) | Approved |
| `02-sunridge-split-overbilling.pdf` | 12 of 20 drums already paid on SC-3371; this invoice bills 10 more | Needs review |
| `03-northstar-duplicate-scan.pdf` | Scanned resubmission of paid INV-7712, printed as "7712" | Rejected |
| `04-rao-handwritten-no-po.jpg` | Handwritten bill, no PO number; PO-2026-0225 inferred | Needs review |
| `05-acme-bank-change.pdf` | Perfect match but "our banking details have changed" | Payment hold |
| `06-unknown-vendor.pdf` | Vendor not in master, no PO | Payment hold |

Reference data (POs, vendor master, paid-invoice history) lives in `app/src/data/`. Regenerate the samples with `npm run make-samples` (the scanned and handwritten images come from `scripts/make-images.ps1`).

## Run locally

```bash
cd app
npm install
cp .env.example .env   # add one key: GEMINI_API_KEY (free), OPENAI_API_KEY or OPENROUTER_API_KEY
npm run dev            # http://localhost:5173
npm test               # decision-engine tests for every scenario
```

## Deploy (Docker / Railway / Render)

```bash
cd app
docker build -t invoice-desk .
docker run -p 3000:3000 -e GEMINI_API_KEY=... invoice-desk
```

On Railway or Render, point the service at the `app` folder (Dockerfile build) and set `GEMINI_API_KEY`. Run history is a JSON file in `DATA_DIR` (default `./data`); attach a volume to keep it across deploys.

## Assumptions and limits

- One company, USD, 2-way match (invoice ↔ PO). Goods receipts (3-way match) would slot into the PO stage.
- The PO table and vendor master are static files standing in for an ERP; run history is a JSON file. Production would use the ERP API and a database.
- Invoices arrive by upload; an email inbox listener would call the same pipeline.
- Up to 3 pages per invoice are sent to the model.
- Model: Gemini 3.5 Flash by default. If a model is busy or rate-limited (503/429), the server retries once and then falls back through `gemini-3.8-flash`, `gemini-flash-latest` and `gemini-3.5-flash-lite`. The decision never depends on which model answered, because the model only reads and explains.

## Testing

- `npm test` runs the decision engine on every scenario, with fields as the model would extract them, so no API calls are made.
- `node scripts/e2e.mjs` drives the real UI in Edge through all six demo invoices with the live model and checks each decision. It clears run history first.
