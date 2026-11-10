# Invoice Decision Desk

An exception-first accounts-payable workspace. It takes a vendor invoice (digital PDF, scanned PDF or a photo of a handwritten bill), checks it against purchase orders, the vendor master and invoice history, and returns a decision. For every exception it shows **what happened, why it matters, the evidence, and what the AP team should do next**, then records how a reviewer resolved it.

## Live demo

**https://invoice-decision-desk-production.up.railway.app**

The hosted version is an **open-access demo running on synthetic data** (the sample invoices, vendor master, purchase orders and ERP history in `app/src/data` and `app/public/samples` are made up). There is no sign-in, which has these consequences:

- Anyone with the link can upload an invoice, and every upload calls the AI model on the demo's API key. Heavy use can exhaust the model's quota, so extraction may be slow or temporarily unavailable ("AI service temporarily unavailable", then **Retry**).
- All visitors share one set of records. Anyone can approve, reject or correct cases, enter any reviewer name, and use **Reset demo data**, which clears every case and audit trail. What you see may have been changed by someone else.
- Please upload only synthetic or non-sensitive documents. Uploaded files and extracted data are stored on the demo server.

This is how the demo is configured (`ALLOW_OPEN_ACCESS=true`, `ENABLE_RESET=true`, with a volume at `DATA_DIR`). For anything beyond a demo, run it with `DEMO_ACCESS_KEY` set (see Deploy), which puts every route behind a server-checked key.

> Built on top of [jwaldor/ap-exception](https://github.com/jwaldor/ap-exception) (React + Node scaffold, LLM proxy pattern). The pipeline, decision engine, review workflow, data model, run store and UI were rewritten for this case study.

## Product principle

**AI reads and explains. Deterministic rules validate and decide. Humans resolve exceptions.**

- A vision model extracts the fields. Every check after that is plain code with a named threshold, so the same invoice always gets the same decision and each decision cites the rule codes that produced it.
- The model then writes a plain-English summary and a vendor email draft. It is told the decision and cannot change it. If the model is unavailable, a template explanation is used and the decision is unaffected.
- Reviewer actions are enforced on the server with the same rules the UI uses, so no button can bypass an open control.
- The server does not trust the browser's decision. When a new run is saved it re-runs every deterministic check (vendor, bank, PO, cumulative billing, duplicates) against the current store, discards any client-supplied status, resolutions or audit events, and writes its own. Writes are serialised, so two simultaneous uploads or a retry cannot both pass the duplicate / PO checks.
- Before an approval is attempted, the checks are re-run against the current PO position. If another invoice has since used the PO, the new finding is added to the case (the original findings, decision and audit are untouched) and approval is refused until it is resolved.

## Decision policy (strictest finding wins; all findings are kept)

| Outcome | When | Reason codes |
|---|---|---|
| **Rejected** | Confirmed duplicate, blocked vendor | `DUPLICATE_INVOICE`, `VENDOR_BLOCKED` |
| **Payment hold** | Security or vendor-identity risk | `BANK_ACCOUNT_MISMATCH`, `UNKNOWN_VENDOR`, `PO_VENDOR_MISMATCH` |
| **Needs review** | Human judgement or clarification | `ARITHMETIC_MISMATCH`, `MISSING_FIELD`, `PO_MATCH_UNCONFIRMED`, `CUMULATIVE_PO_EXCEEDED`, `PO_AMOUNT_EXCEEDED`, `QUANTITY_EXCEEDS_PO`, `PRICE_VARIANCE`, `LOW_EXTRACTION_CONFIDENCE`, `HANDWRITTEN_DOCUMENT`, `EXPIRED_PO`, `POSSIBLE_DUPLICATE`, `OVER_APPROVAL_LIMIT` |
| **Approved** | All mandatory checks pass | info-only: `WITHIN_TOLERANCE`, `PARTIAL_BILLING`, `VENDOR_NAME_VARIANT`, `SCANNED_DOCUMENT`, `REPEAT_SUBMISSION` |

Key rules:

- **Arithmetic:** expected total = subtotal + tax + freight + other charges − discount, compared within a $1 rounding tolerance. The 2% PO tolerance never excuses an invoice that doesn't add up internally.
- **PO value:** cumulative *confirmed* billing (paid in ERP or approved here) plus this invoice is compared against PO value × (1 + 2%). Split invoicing passes while the running total fits. Invoices still in review or on hold are not counted as spend; if they would push the PO over, `PENDING_PO_CONFLICT` sends this one to review.
- **One percentage format** everywhere (2 decimals): $486 / $9,570 → +5.08%. The AI explanation must quote figures from the findings, not compute its own.
- **Inferred PO:** shown as a *suggested* match (`PO_MATCH_UNCONFIRMED`) that a reviewer must confirm.
- **Duplicates:** conservative invoice-number normalisation (case, spaces, punctuation, a leading "INV"/"Invoice No" label, leading zeros), scoped to the same vendor. Identity is vendor + invoice number, not the file, so a reformatted PDF or a changed amount under the same number is still a duplicate/conflict and is rejected with a note that the amount differs, never paid as a second payable. The same number from an unrelated vendor is not a duplicate. Same amount with a different number is only a *possible* duplicate. A byte-identical re-upload is recorded as a repeat submission and never adds a payable.
- **Missing and unverifiable payment details:** matching account = Passed; account differs = payment hold; **no account printed (or too few digits to compare) = "Not provided / Not verified"**. The policy is unchanged (payment would go to the account on file, so it does not block approval), but the app never shows it as verified.
- **Invoice number: correct a misread, never supply a missing one.** If the model extracted a number but may have misread it (for example a handwritten `1O47` for `1047`), a reviewer can correct it, with a reason and a cited source (where it appears on the document), and the server re-runs the duplicate check on the corrected value. If the document has **no invoice number at all**, a reviewer cannot enter one. The server rejects the attempt, and the primary action is **Request clarification** (ask the vendor for a revised invoice). The same reason-plus-source requirement applies to every other corrected field.
- **Approved ≠ paid:** "paid" is only said when the ERP history has a payment record (seeded demo data). Invoices approved here are "approved for payment, not yet paid".

## Understand → Control → Resolve

- **Understand:** AI reads digital PDFs, scans and handwritten photos into structured fields. Uncertain values are flagged as a review signal, not a score.
- **Control:** deterministic rules check arithmetic, vendor identity, payment details, PO value/quantity/price (cumulative), duplicates and policy limits.
- **Resolve:** each invoice shows **"Before this invoice can be approved"**, a checklist derived from the findings (`src/lib/controls.ts`), not written per scenario. Each control shows Passed / Unresolved / Resolved / Not applicable with a one-line reason, a link to its evidence and the action that resolves it. The footer reads e.g. "2 unresolved controls · Payment approval locked". Resolving one control never resolves another; approval is a separate, explicit step.
- **Invoice checks vs payment readiness:** an invoice can be valid (arithmetic and PO pass) and still unsafe to pay (changed bank account). Two derived indicators show this:
  - Invoice checks: Passed / Exceptions found / Incomplete
  - Payment readiness: Ready / Awaiting verification / Awaiting approval / Blocked / Closed
  - Both, and the summary text, are derived from the **current** state (what is open and resolved now); the original rule outcome, findings and audit are kept as history.

  "Ready" means approved for the payment run, never "paid".
- **Document-to-data verification:** for digital PDFs, the app stores the real page-1 positions of every text run from the PDF text layer. Clicking an extracted value (vendor, invoice no., date, PO, account, subtotal, tax, freight, total, line amounts) highlights it on the original. Scans and photos have no text layer, so the app says so instead of drawing a guessed box.
- **PO utilisation:** a stacked bar and a figure row, all computed from the stored ledger:
  - Stacked bar: billed before (confirmed) | this invoice within the PO | over the PO, with the tolerance band shown separately.
  - Figure row: authorised value, billed before, this invoice, cumulative, remaining or over, tolerance.
  - Quantity table: ordered, billed before, this invoice, total, excess.
  - Expandable ledger: every earlier invoice on the PO, each counted once. Pending invoices are shown but not counted; rejected duplicates are excluded.
- **Duplicate semantics:** a re-upload is shown as **"Duplicate blocked"**, never as a rejected invoice. The decision screen links to the original case and its current status, which is unaffected.

## Metrics (one shared analytics layer: `src/lib/analytics.ts`)

- **Processing attempts:** every pipeline run, including repeat uploads.
- **Unique invoices:** grouped by matched vendor + normalised invoice number when both are known, otherwise by file hash; never by amount. Repeat attempts stay in the history, grouped under their invoice.
- **Straight-through processing:** unique invoices auto-approved with no human action ÷ eligible unique invoices (resubmissions of invoices already on file are excluded). The UI shows the denominator, e.g. "1 of 5 eligible invoices auto-approved".
- **Awaiting action / value requiring intervention:** unique invoices still in review, on hold or awaiting the vendor, and their total.
- **Average time:** upload → initial automated decision (excludes the explanation step and human waiting time).

## Reviewer workflow

| Open control | Required resolution |
|---|---|
| Bank account mismatch | **Verify payment details**: the reviewer attests they called the contact on file, and records a verification reference. This is a manual attestation; the app does not verify the call. Clears only the security hold. |
| PO overage / quantity / price / expiry | **Resolve PO discrepancy**: record who authorised the amendment and its reference. The PO record isn't silently changed. A corrected invoice goes through "Correct extracted fields" instead. |
| Suggested PO | **Confirm suggested PO** |
| Handwritten / uncertain read | **Confirm extracted information**. It does not approve. |
| Arithmetic / missing fields / no PO | **Correct extracted fields** with a specific reason and a cited source; the server re-runs every rule. A *misread* invoice number can be corrected; a *missing* one cannot, so request a revised invoice |
| Unknown vendor | Cannot be approved here: request onboarding (awaiting vendor), keep on hold, or reject |
| Possible duplicate / above limit | Approve with justification |

Every finding has a stable code, a severity, evidence and an open/resolved state. Resolving one finding recomputes the status from what remains. **Approve unlocks only when nothing material is open**, and approval is a separate, explicit step. Each reviewer event records the action, demo identity, time, justification, the findings it resolved, the findings still open, and any authorisation reference. Closed cases accept no further actions.

Every status change requires a reviewer name (lightweight demo identity) and a specific justification (at least 15 characters, not a stock phrase like "looks fine"), and is logged with the from/to status and timestamp. Approved and rejected cases are final.

## Handwritten / uncertain documents: correct and re-validate

1. The model extracts what it can and reports fields it is unsure of (self-reported, not a calibrated score). Missing values stay missing.
2. Handwritten invoices always go to review (configurable policy). The investigation screen shows the document beside an editable field form, marking each field as **missing**, **inconsistent**, **model unsure**, **not yet confirmed**, or **corrected**.
3. A reviewer can correct the invoice number (only if one was extracted, i.e. fixing a misread; a blank invoice number is not editable, see the invoice-number rule above), date, PO reference, quantities, unit prices, line amounts, subtotal, tax, freight, discount and total. **Vendor name and bank account are deliberately not editable.**
4. Saving sends the corrected invoice to the server, which **re-runs every deterministic check** (arithmetic, vendor, PO, cumulative billing, quantity, price, duplicates) using the server's policy thresholds. The result can go up or down; a correction that creates a duplicate is rejected.
5. The audit keeps the original extraction and records each change (field, from → to), reviewer, time and reason. Earlier PO and figure confirmations are cleared, because the data changed.
6. Approval stays locked while the invoice doesn't reconcile or is missing fields, and until the reviewer confirms the figures and any suggested PO. A clean result after a correction still needs an explicit approval.
7. With no PO printed, ranked **PO suggestions** show their reasons (same vendor, amount fit, matching lines). Weak matches (low amount fit, no matching lines, or over the open value) are collapsed under "Weak matches" with the reason they don't fit. Applying one is a recorded correction that re-runs every rule, and a PO the reviewer chose stays *unconfirmed* until the PO owner confirms it, so selecting a PO never silently clears the PO control.

Demo file `04-rao-handwritten-no-po.jpg` has a genuinely ambiguous labour amount: an 8 written over a 3. In the latest live test Gemini read it correctly as 1850 and did not flag it; the case still went to review (handwritten + suggested PO). Nothing about the model output is hardcoded.

## Screens

Each page answers one question:

- **Overview:** *What needs attention today?* A priority queue ordered by a transparent rule (severity, then amount at stake, then time waiting, with the reason shown), compact metrics, decision mix, frequent exceptions, recent activity.
- **Process Invoice:** *Can this invoice be processed safely?* Three states: intake, then live processing (document + 8-stage timeline; business-rule blocks are distinct from system errors), then the investigation workspace.
- **Review Queue:** *What should I do next?* Master-detail, grouped by the action needed (Verify bank details, Onboard vendor, Correct or confirm fields, Confirm PO, Resolve PO discrepancy…), with the selected case resolvable in place.
- **Invoice detail:** *Why was this decided?* Document on the left (zoom, open original); decision, required action, evidence comparisons, field review/correction, resolution on the right. **Summary** (default) shows the decision, a one-sentence reason, payment readiness and the next action, with the blocking evidence open and the rest collapsed; **Detailed** adds rule codes, every control description, all rule findings, supporting evidence, vendor email, processing log and audit trail. The decision is the same in both. Every section is expandable.
- **Invoice History** · **Reference Data** (tabs + search; confirmed billing (paid or approved) shown separately from pending invoices) · **Policy Rules** (grouped thresholds, fixed security controls, decision precedence, and an **impact preview** that re-runs the rules on stored invoices to show which decisions a threshold change would alter).

Metric definitions:
- **Straight-through rate:** auto-approved ÷ processed, excluding repeat submissions.
- **Awaiting review:** needs review + payment hold + awaiting vendor.
- **Value requiring intervention:** the sum of those open invoices.

## The four designed edge cases

| Case | Sample | Behaviour |
|---|---|---|
| Split billing against one PO | `02-sunridge-split-overbilling.pdf` | Cumulative billing over the PO needs review; confirmed spend is counted once |
| Scanned resubmission of a paid invoice | `03-northstar-duplicate-scan.pdf` | Matched by vendor + normalised number, rejected as "Duplicate blocked" |
| Handwritten invoice with no PO | `04-rao-handwritten-no-po.jpg` | Review: figures confirmed or corrected, PO suggested and owner-confirmed |
| Changed bank details | `05-acme-bank-change.pdf` | Payment hold until a call-back is attested; approval stays separate |

`01` (clean) and `06` (unknown vendor, payment hold) complete the demo set below.

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
npm run dev            # development: http://localhost:5173
# or production mode (what the Docker image runs):
npm run build && npm start   # http://localhost:3000 (set PORT to change)
```

Needs Node 22.6 or newer. On Windows PowerShell, if `npm` is blocked by the execution policy, use `npm.cmd` instead.

### Environment variables

Set them in `app/.env` (local only, never commit it) or in the host's environment. No secrets are stored in the repository.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | One of them | Document extraction and the AI summary. First one found wins. Without one, upload fails with a clear system error; stored cases still open. |
| `LLM_MODEL` | No | Comma-separated model list: primary, then fallbacks used on 429/503 |
| `LLM_REASONING_EFFORT` | No | Gemini reasoning effort (default `low`) |
| `DATA_DIR` | No | Where `runs.json` and page previews are stored (default `./data`). Mount a volume here in production. |
| `PORT` | No | HTTP port (default `3000`) |
| `HTTPS_PROXY` | No | Outbound proxy for model calls, if the host needs one |
| `DEMO_ACCESS_KEY` | **Yes in production, unless `ALLOW_OPEN_ACCESS=true`** | Server-enforced access key (12+ chars). Every route except a bare `/api/health` needs it; the browser shows a sign-in prompt (any username, key as password). Never placed in the frontend bundle. Without it (and without `ALLOW_OPEN_ACCESS=true`) the production server refuses to start. |
| `ENABLE_RESET` | No | Set `true` to allow "Reset demo data" in production (disabled by default there; always allowed in local dev) |
| `ALLOW_OPEN_ACCESS` | No | `true` lets production start with no access key. Used by the hosted open-access demo; not for real data. |
| `HOST` | No | Bind address. Unset = all interfaces |

## Testing

- `npm test` runs 63 tests, with no API calls: decision engine, multi-finding review rules, correction loop, analytics, control checklist, duplicate semantics (reformatted file, changed amount, unrelated vendor), cumulative-PO boundaries, PO accounting, current-state messaging, reviewer validation and state transitions, the audit trail, plus server tests (forged client records are re-decided, concurrent uploads and retries create one payable, stale PO position blocks approval).
- `node scripts/e2e.mjs` drives the real UI in Edge through all six invoices with the live model, then a repeat upload and the bank-verification review flow, and saves screenshots. It clears run history first. `--ui-only` reuses stored runs to save model quota.

## Deploy

```bash
cd app
docker build -t invoice-desk .
docker run -p 3000:3000 -e GEMINI_API_KEY=... invoice-desk
```

Runs are stored in `DATA_DIR` (default `./data`): `runs.json` plus page previews in `docs/`. Attach a volume to keep them across deploys. The container listens on `PORT` (3000) and exposes `/api/health` for health checks (`railway.toml`). `.dockerignore` keeps `.env`, `node_modules` and local data out of the image.

**Two ways to run it online:**

- **Protected (recommended for anything beyond a demo):** set `DEMO_ACCESS_KEY`. Every route except a bare `/api/health` then needs the key (browser sign-in prompt: any username, the key as password), and the server refuses to start without it.
- **Open-access demo (what the hosted demo above uses):** set `ALLOW_OPEN_ACCESS=true` and no key. Anyone with the URL can use the app, spend the model quota and change or reset the shared records (`ENABLE_RESET=true` enables the reset button in production; it is off by default there). Only do this with synthetic data.

Either way, mount a persistent volume at `DATA_DIR` (for example `DATA_DIR=/data`), set one of the model keys, and let the platform supply `PORT`. Policy thresholds are fixed on the server; the Policy page only previews the effect of changes.

## Assumptions and limits

- One company, USD, 2-way match (invoice ↔ PO). Goods receipts (3-way match) would slot into the PO stage.
- The PO table, vendor master and ERP payment history are static demo files standing in for an ERP. Run history is a JSON file. Production would use the ERP API and a database.
- Policy thresholds are fixed on the server (`DEFAULT_RULES`); anything a browser sends is ignored. Changing them means editing `policy.ts` and redeploying. Reviewer identity is a typed name, not authentication. The only access control is the optional shared `DEMO_ACCESS_KEY` (HTTP Basic, no rate limiting, no per-user accounts), so anyone holding the key can act as any reviewer. **The hosted demo runs with no key at all**, so there is effectively no access control or per-user separation there. Use a long random key and serve over HTTPS (the key is sent on every request); for real use put it behind SSO or a private network.
- Bank verification and PO authorisation are reviewer attestations (name, reference, justification, time). The app does not contact the vendor or the PO owner and never claims to have verified them.
- Invoices arrive by upload; an email inbox listener would call the same pipeline. Up to 3 pages per invoice are sent to the model.
- Low-confidence fields are the model's self-report, not a calibrated score. No source-position highlighting on the page image.
- Model: Gemini 3.5 Flash with automatic retry and fallback (`gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.5-flash-lite`) on 429/503. The free tier rate-limits heavily, so expect 10–60 s per invoice when it is busy.
