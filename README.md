# GST Return Desk — GSTR-1 preparation & upload

Next.js 16 (App Router) + TypeScript + MongoDB. You import the GSTR-1 offline-tool Excel, the app validates every record, you fix errors in the browser, and it generates schema-checked upload JSON. Then either:

- **File from inside the app** (`GST_INTEGRATION=sandbox`): log in with the OTP GSTN sends you, save the JSON to GSTN, track processing, compare GSTN's summary with your totals, and file with EVC. This goes through the [Sandbox.co.in](https://developer.sandbox.co.in) GST Compliance API, an authorised GSP route. See [Filing from inside the app](#filing-from-inside-the-app-sandbox-gst-api).
- **Upload on the GST portal yourself** (`GST_INTEGRATION=manual`, the default): the app hands you the file and records each step you take there and what the portal returned.

Either way the app keeps a tamper-evident audit trail.

The **Validators** page (`/tools`) also checks a GSTR-1 JSON from any source, GSTINs and HSN/SAC codes. See [Validators](#validators).

## Quick start

```bash
cp .env.example .env.local      # fill AUTH_SECRET and DATA_ENCRYPTION_KEYS (see comments)
npm install
npm run dev                     # http://localhost:3000 → /register creates the first workspace
npm test                        # engine tests (no DB needed)
npx tsx scripts/sample-workbook.ts sample.xlsx          # sample with deliberate errors
npx tsx scripts/sample-workbook.ts clean.xlsx --clean   # sample that validates clean
```

The sample's supplier GSTIN is printed when the file is written. Add a company with that GSTIN, then open **June 2025**.

## Architecture

```
src/
  engine/            ← framework-free GSTR-1 engine (no Next, no Mongo, no portal) – fully unit-tested
    config/versions.ts   format profiles by period: JSON version, HSN split, B2CL threshold, rates, HSN digits
    excel/               template map (sheet/column aliases) → parser (header detection, rate-row grouping, tax compute)
    validation/          field + section + cross-record rules (duplicates, HSN reconciliation)
    json/                generator (records → GSTR-1 JSON) + JSON Schema (ajv) gate
    json/check.ts        GSTR-1 JSON validator: reads any upload JSON back into records → schema + all rules
    hsn.ts               HSN chapter / SAC heading master and HSN/SAC checks
    portal/errorReport   parser for the portal's error-report JSON
  server/
    models.ts            Organization, User, Company, GstReturn (+ statusHistory, portal refs), Gstr1Record,
                         Gstr1Error, GeneratedJson, UploadJob, PortalEvidence, AuditLog (append-only)
    auth.ts / http.ts    JWT cookie session, RBAC permissions, route wrapper, rate limiting
    crypto.ts            hashing, redaction, AES-256-GCM helpers (for a future integration's secrets)
    gst/
      gstr1/             application processing: import → validate → edit → generate JSON
      gst-error/         portal error report import + invoice mapping
      gst-upload/        portal step: approve → upload attempt → uploaded → processed/error → filed
      gst-status/        lifecycle rules; the only writer of GstReturn.status (evidence-enforced)
      gst-audit/         hash-chained audit trail; every return entry carries GSTIN + period
      gst-client/        GstClient interface; `manual` and `sandbox` (Sandbox.co.in GST API) clients
        sandbox.ts         HTTP calls, platform token, encrypted per-company taxpayer session + refresh
        sandbox-protocol.ts pure response/request helpers (unit-tested)
      gst-login/         how the taxpayer signs in: on the portal (manual) or OTP inside the app (sandbox)
      gst-session/       GSTN session state (none in manual mode; per-company taxpayer session in sandbox mode)
      gstin-lookup/      GSTIN validation: offline, Sandbox Search GSTIN, or portal Search Taxpayer (user types the CAPTCHA)
  app/api/...          route handlers
  app/(desk)/...       UI: returns, companies, team, return workspace
```

Pipeline: `readWorkbook → parseGstr1Tables → validateReturn → generateGstr1Json → validateGstr1Json`.
Each step is a pure function, so you can reuse the engine from a CLI, a worker, or your billing product directly.

### Supported sections

B2B/SEZ/Deemed exports (4A/4B/6B/6C), B2CL (5), B2CS (7), exports (6A), CDNR/CDNUR (9B), advances received/adjusted (11A/11B), nil/exempt/non-GST (8), HSN summary B2B/B2C (12) and documents issued (13).

**Not yet supported:** amendment sheets (b2ba, b2cla, b2csa, cdnra, cdnura, expa, ata, atadja) and ECO tables 14/15. The importer reports these sheets as skipped; it never drops them silently.

### Changing the GST format

Add a profile to `src/engine/config/versions.ts` with its effective period. If GSTN renames a column, add an alias in `excel/template.ts`. JSON field changes go in `json/generate.ts` and `json/schema.ts`. Each of these is covered by tests.

## Status lifecycle

| In this app | On the GST portal (user does it there, records it here) |
|---|---|
| Draft → Imported → Validated / Validation error → JSON generated → Ready for upload (reviewer approves) | Uploading → Uploaded → Processing → Processed / Portal error → Filed |

Rules, enforced in `gst-status` (unit-tested):

- Every change goes through one transition table and is appended to `statusHistory` and to the audit log.
- **Processed** requires a *processing result*: the status/reference the portal showed, or its screenshot/PDF.
- **Filed** requires the 15-character **ARN** from the portal acknowledgement and the filing date (attachment recommended).
- **Portal error** requires the error report JSON downloaded from the portal. A report with zero errors does not mark the return processed.
- Data is locked while the file is with the portal (Uploading → Filed) and unlocks after a portal error, so the user can fix, regenerate, re-approve and upload again.
- Evidence files (PDF/PNG/JPG/JSON, max 5 MB) are stored with a SHA-256 hash and are downloadable from the GST portal tab.

The app never generates a reference, ARN or result. In manual mode it never contacts the portal. In sandbox mode it calls only the documented Sandbox API, and every portal-side transition is backed by GSTN's stored response.

## Security model

- **Tenancy.** Every query filters by `orgId` taken from the server session, never from the request. Users can also be restricted to specific companies (`companyIds`).
- **RBAC roles:**
  - owner and admin: everything
  - preparer: import, edit, generate JSON
  - reviewer: approve for upload, record portal steps, GST login and status checks, audit
  - viewer: read only
  - Filing with EVC (`return:file`) is owner/admin only.
- **No portal passwords.** The app never asks for GST portal passwords, never reads or automates OTPs, and never reads or solves a CAPTCHA. The one CAPTCHA it shows is the public *Search Taxpayer* one in the GSTIN validator: the image is passed to the user as it is, and what they type goes back to the portal. In sandbox mode the user types the GST username and the OTPs GSTN sends them. The taxpayer access token and username are AES-256-GCM encrypted per company (`DATA_ENCRYPTION_KEYS`, bound to org/company/GSTIN). They are never sent to the browser or logged. OTPs and the signatory PAN are passed straight to GSTN and never stored. The audit log records only a masked PAN (`ABK****33B`).
- **Audit.** Append-only (Mongoose hooks block updates/deletes), each entry hashes the previous one; **Verify integrity** recomputes the chain. Also deny `update`/`delete` on `auditlogs` at the MongoDB role level.
- **Start fresh (owner only).** **Settings → Danger zone** deletes all of the organisation's data: companies, returns, records, errors, generated JSON, upload jobs, portal evidence, GST API sessions and the audit log. The organisation and the owner's login are kept, and removing the other team members is optional. It needs the typed phrase `DELETE ALL DATA` and the owner's password, and it is rate-limited. This is the only code that deletes audit entries (through the driver, bypassing the append-only hook). A new chain then starts with an `org.reset` entry, so **Verify integrity** still passes.
- **Abuse limits.** Login, import and portal-step routes are rate-limited (in-memory per instance; use Redis behind a load balancer). CSV export guards against formula injection.

## Filing from inside the app (Sandbox GST API)

### Setup

1. **Create Sandbox API keys** at [console.sandbox.co.in](https://console.sandbox.co.in). Start with **test** keys (`key_test_…`, `secret_test_…`).
2. **Configure `.env.local`:**

   ```bash
   GST_INTEGRATION=sandbox
   SANDBOX_API_KEY=key_test_xxxxxxxx
   SANDBOX_API_SECRET=secret_test_xxxxxxxx
   SANDBOX_API_BASE=https://test-api.sandbox.co.in   # live: https://api.sandbox.co.in with key_live_… keys
   DATA_ENCRYPTION_KEYS=k1:<base64 32 bytes>          # node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"
   ```

   The app refuses to start a call if the key type and base URL don't match (a live key on the test URL, or the reverse). **Live keys file real returns with GSTN.**
3. **Enable API access once per GSTIN (live only).** On the GST portal, open **View Profile → Manage API Access** and set **Enable API Request** to **Yes** for a duration. This is the only time anyone needs to open the portal.
4. **Restart `npm run dev`.** The **GST portal** tab now shows the in-app flow, with a **GST login** panel.

Set `GST_INTEGRATION=manual` to go back to the manual portal workflow at any time. The manual actions stay available on the server.

### Flow

| Step | In the app | Sandbox API | Status / evidence |
|---|---|---|---|
| 1. GST login | Enter GST username → type the OTP GSTN sends | Authenticate, Generate OTP, Verify OTP (refreshed automatically before it expires) | Session ≈6 h, encrypted per company |
| 2. Send | **Send to GSTN** (after approval) | Save GSTR-1 | → Uploaded; GSTN `reference_id` as *upload reference* |
| 3. Status | Polls every 15 s, or **Check status now** | GST Return Status | `P` → Processed (*processing result*). `PE`/`ER` → Portal error: GSTN's error report is imported and each error is linked to its invoice by `gst-error` |
| 4. Summary | **Proceed to file**, then **Fetch GSTN summary** | New Proceed to File, Return Status, GSTR-1 Summary | GSTN summary stored as *summary* evidence and shown section by section next to the app's totals (`GeneratedJson.log`). Differences are highlighted |
| 5. File | Tick **I have verified the summary**, enter signatory PAN → **Send EVC OTP** → type OTP → **File GSTR-1** (owner/admin) | Generate EVC OTP, File GSTR-1 (sends back the exact summary + checksum reviewed) | GSTN response as *acknowledgement* |
| 6. ARN | Automatic after filing; **Fetch ARN** if GSTN hasn't listed it yet | Track Returns | → Filed with GSTN's ARN and filing date |

GSTN's error codes and messages are shown as-is, for example `GSTN RET191114: Date is Invalid…` or `GSTN OTP0010: User does not have authorized signatory…`. A failed save moves the return back to *Ready for upload* with GSTN's reason in the status history.

### GSTR-3B flow

GSTR-3B has its own page (**GSTR-3B** in the sidebar). Pick the company and period. The GST login is the same per-company session used by GSTR-1, and you can log in from either page.

| Step | In the app | Sandbox API | Status / evidence |
|---|---|---|---|
| 1. Get | **Fetch from GST portal** | Get GSTR-3B Details, Liability Auto Calc, Cash ITC Balance, Track Returns | Values GSTN auto-calculated (from GSTR-1/IFF and GSTR-2B) and values saved on the portal are shown side by side, and either can be used. Untouched tables start from the saved values, or else from the auto-calculation. A return already set off or filed on the portal is picked up here |
| 2. Prepare | Edit tables 3.1, 3.1.1, 3.2, 4, 5 and 5.1 → **Save draft**, or **Import from Excel** | none | 4(C) is always worked out from 4(A) − 4(B). **Download Excel template** gives the template, filled with the prepared tables when there are any: a *3.1 to 5.1* sheet with rows by code (3.1(a) … 5.1 Late fee), a *3.2 Inter-state* sheet (type, place of supply, taxable value, IGST) and a *5 Exempt inward* sheet. Importing replaces the prepared tables. Cells that can't be read are listed, not guessed |
| 3. Save | **Save to GSTN**, then the status is checked every 10 s | Save GSTR-3B, GST Return Status | *Saving* → *Saved*. GSTN errors put the return back to *Draft* with GSTN's messages |
| 4. Offset | Review the tax payable, the cash and credit ledgers, and the suggested ITC set-off (sections 49/49A, rule 88A; editable) → confirm → **Offset liability** (owner/admin) | Get GSTR-3B Details, Cash ITC Balance, Offset Liability | Re-checked against GSTN's live figures before sending. If cash is short, the app says how much to deposit by PMT-06 challan. Request and response are kept as *offset* evidence. The return is now locked |
| 5. File | **Fetch GSTN details again** → tick reviewed → PAN → **Send EVC OTP** → OTP → **File GSTR-3B** (owner/admin) | Generate EVC OTP (`gstr-3b`), File GSTR-3B (sends back the exact details reviewed), Track Returns | Acknowledgement, then *Filed* with GSTN's ARN |

When every table is zero here and on the portal, step 3 becomes **File Nil GSTR-3B**: an EVC OTP, then filing with `isNil: "Y"`, with no save or set-off.

The set-off adds this return's 4(C) ITC to the credit ledger balance by default, as the portal's *Payment of tax* screen does. If GSTN says the credit isn't enough because the ledger already includes it, untick that option.

### Test environment

The Sandbox documentation uses these sample values, which are the ones to use against `https://test-api.sandbox.co.in`:

| Field | Value |
|---|---|
| GSTIN (add a company with this GSTIN) | `33ABKCS2033B1ZW` |
| GST username | `TN_NT2.2477` |
| Login OTP | `575757` |
| Signatory PAN | `ABKCS2033B` (or `ABCCQ3123E` from the EVC OTP example) |
| EVC OTP | `575757` |

The docs also use the sample GSTIN `29AAACQ3770E000`, but its check digit is invalid, so this app won't accept it as a company GSTIN. If the test environment rejects a value, check the current test data in the Sandbox console or the [API reference](https://developer.sandbox.co.in/api-reference/gst/compliance/guides/taxpayer/gstr-1/overview).

End-to-end test run: add the company → create the return for the period → import → generate JSON → approve → **GST login** (username + OTP) → **Send to GSTN** → status *Processed* → **Proceed to file** → **Fetch GSTN summary** → tick verified → PAN → **Send EVC OTP** → OTP → **File GSTR-1** → ARN shown, status **Filed**.

### Adding another integration

Implement a `GstClient` in `src/server/gst/gst-client` using only an officially supported interface, set its capability flags, register it in `CLIENTS`, and select it with `GST_INTEGRATION`. `gst-upload` calls the client's methods when its capabilities allow, and routes every result through `changeStatus()` and PortalEvidence. Import, validation, JSON generation, error mapping and audit don't change.

## Client documents (upload → understand → check → reconcile)

**Client documents** in the sidebar. Each client's documents are organised by financial year and month.

1. **Upload** any number of files: PDF (text or scanned), JPG/PNG, Excel, CSV, JSON or Word. Pick the client, or let the app detect it from the GSTINs in each document.
2. **Understand and extract.**
   - Structured files are recognised by rules, at no cost: GSTR-1/2A/2B/3B (GSTN JSON and portal Excel), sales and purchase registers (Tally, Busy, Zoho or your own columns) and bank statements.
   - PDFs, scans, photos and Word files are read by Claude (`claude-opus-5-5`; needs `ANTHROPIC_API_KEY`). Claude identifies the type and period and extracts every invoice (with items) or bank transaction. Values it cannot read are left blank and marked for review, never guessed.
   - Files run in the background, 3 at a time (`DOC_AI_CONCURRENCY`). Re-uploading the same file is detected and it is not read again.
3. **Check.** Every record is checked for:
   - invalid GSTINs (check digit) and missing invoice number, date or GSTIN;
   - tax against rate, CGST = SGST, IGST vs CGST/SGST against the place of supply, and items, total and invoice value;
   - future dates and large cash deposits;
   - duplicates against everything already uploaded for the client (same party, type and number, or same party, date and amount), with the reason;
   - bank balances that don't follow from the previous line.
4. **Review.** Records with problems, or with values the AI was unsure of, wait in **Review**. Each one opens next to the original document at the right page, where you can correct it, approve it or reject it. The first reading is kept.
5. **Reconcile and summarise.**
   - **Purchase vs GSTR-2B:** matched, mismatched (by field), probable matches, missing in 2B, and missing in the books, with the ITC difference and the invoices behind it. It uses the purchase register, or the purchase invoices when there is no register.
   - **Overview:** sales and purchases as per the books and as per GSTN, then only the exceptions (✓ matched / ⚠ problems) and automatic findings: ITC difference, month-on-month change, supplier concentration, cash deposits, and books vs GSTR-1.
6. **Search and export.**
   - Search invoices and transactions by number, GSTIN, party, HSN or narration. Filter by side, source, issue type, review state and amount; bank transactions also by mode (UPI, NEFT, cash…).
   - Export the filtered list, or the full Excel report: summary, exceptions, sales, purchases, GSTR-2B, reconciliation, supplier- and customer-wise totals, bank, duplicates and errors.

**Bank ↔ books.** Each receipt is matched to a sales invoice and each payment to a purchase invoice:
- **Rules:** same amount (±₹1), dated 30 days before to 180 days after the invoice, preferring the party named in the narration. Several invoices of one party paid together are matched as a group.
- **Bank tab:** shows which invoice each line pays, or that none matches; it can filter to "No matching invoice".
- **Flagged:** unusual amounts (over 10× the usual, or big round figures) and cash deposits of ₹2 lakh or more.

**Reports tab.** Each report shows on screen (rows open their record) and downloads as Excel:
- **GST:** sales, purchases, GST (output tax vs ITC by head), ITC (books vs GSTR-2B), Purchase vs GSTR-2B, HSN-wise sales.
- **Parties:** invoices, suppliers, customers.
- **Bank:** summary by month and mode, transactions without invoices, unusual transactions.
- **Checks:** exceptions, duplicates, errors, missing documents (month grid), missing sales invoice numbers (gaps in a series).

**Search** (sidebar) works across every client. Queries can be in English, Hindi or Hinglish, for example `INV-1023`, a GSTIN, `₹50,000 से ज्यादा के invoices`, `September 2026 की purchases`, `Rao Industries की सारी invoices`, `cash deposits above 2 lakh`, `UPI receipts`.
- The query is read by rules, not AI. The page shows how it was understood, for example *Purchases · September 2026 · ₹50,000 or more*.
- Results link straight to the record next to its document.

**Ask the documents** (sidebar) is a chat about one client, in Hindi, Hinglish or English, for example:
- “September 2026 ki total sales kitni hai?”
- “GSTR-2B aur purchase register mein mismatch batao”
- “₹50,000 se zyada ke purchase invoices dikhao”
- “Is month ke unusual transactions batao”

How it works:
- Claude (`claude-opus-5-5`, `ASSISTANT_EFFORT` default medium) answers only through read-only tools over the client's stored records: period summary, reports, record search, Purchase vs GSTR-2B, documents.
- It is told never to state a figure that no tool returned, and to say what to upload when data is missing. Each answer lists what it looked at.
- It cannot change, approve or file anything.
- Conversations are kept per user and client, with the exact model history (thinking and tool blocks replayed unchanged on the next question). Token usage is recorded per conversation and in the audit log.

**Firm dashboard** (sidebar) shows every client × month of a financial year:
- **Colours:** green = fine, amber = records to review, ITC difference or GSTR-2B missing, red = errors, grey = nothing uploaded.
- **Columns:** per-client totals of records to review, errors, ITC difference and failed or unchecked files.
- Clients that need attention come first, and a click opens that month.

**Recent uploads** under the uploader show how far each batch has got, e.g. “125 files – 121 processed · 3 needs review · 1 duplicate”, with a link to the files.

**Document AI licensing and cost control:**
- Reading PDFs, scans, photos and Word files, and the assistant, need the **Document AI** feature in the package (super admin → Packages). Each package has an optional **AI allowance per month (₹)**.
- Every Claude API call is priced from its tokens at list prices (`USD_INR`, default 85) and recorded (`aiusages`).
- When the month's allowance is used up, further AI calls are refused until the 1st. Documents that need AI wait as “failed” and can be read again later.
- License → **Document AI usage** shows the month's spend against the allowance and the last months by documents and assistant.
- The check runs before each document and each question, so one long answer can go slightly over the allowance.

Files are stored in MongoDB GridFS (bucket `clientfiles`). "Start fresh" in Settings deletes them with the rest of the organisation's data.

## GSTR-9 and GSTR-9C (annual returns)

**GSTR-9** and **GSTR-9C** in the sidebar, per company and financial year. Both are prepared offline: the app checks the return, and you upload and file it on the GST portal.

1. **Fill**: one of these.
   - **Fill from GSTR-1 & GSTR-3B** (GSTR-9): tables 4, 5 and 17 come from the year's GSTR-1 records; 4G and tables 6, 7 and 9 come from the GSTR-3B returns in the app. For filed 3Bs, the paid columns of table 9 come from GSTN's payment table.
   - **Fill from GSTR-9** (GSTR-9C): fills 5Q, 7B – 7F, 9Q, 12E, 14S and the rate-wise rows of table 9.
   - **Import Excel or JSON**: the app's Excel template (download it from the page) or GSTN's GSTR-9 JSON (the upload/save shape, Get Details, or the system-computed JSON).
   - Type the figures in by hand.

   Whatever the data can't split is listed as notes: capital goods vs. input services, rule-wise reversals, amendments.
2. **Check**: sub-totals and differences (4N, 5N, 6J, 7J, 8D, 8K; 9C 5P/5R, 7G, 9R, 12F, 14T) recalculate as you type. Errors and warnings are listed and marked on their rows, for example:
   - negative amounts;
   - CGST ≠ SGST;
   - tax that doesn't match the taxable value or rate;
   - 6B – 6H vs. 6A;
   - reversals above ITC;
   - table 9 paid vs. payable, and credit used across the wrong heads;
   - HSN digits, rate, UQC and duplicate rows;
   - 9C figures that differ from GSTR-9;
   - un-reconciled differences without reasons.
3. **Download**:
   - GSTR-9 JSON is GSTN's format (Save GSTR-9 / offline upload). It leaves out sub-totals and the columns the portal fills (6A, 8A, table 9 paid), and it is refused while the return has errors.
   - GSTN accepts GSTR-9C only as JSON made by its offline tool. The app gives an Excel laid out like the form, for keying into the tool, plus a JSON backup that this app can import again.
4. **Record the filing**: the ARN and date (owner/admin). This locks the return; **Reopen** unlocks it, with a reason.

## Download center

**Downloads** in the sidebar.

- **Filters**: return types (GSTR-1, GSTR-3B, GSTR-9, GSTR-9C), companies, a financial year or a custom month range, and status (all / filed / not filed).
- **Formats**:
  - GSTR-1: the generated JSON, or an Excel of the records.
  - GSTR-3B: GSTN's JSON, or the Excel tables.
  - GSTR-9 / GSTR-9C: as above.
- **Each return** downloads on its own, or **Download all as ZIP** puts everything in `GSTIN/return/` folders. The ZIP has a README listing anything not included and why (e.g. JSON not generated, validation errors). Every download is audited.

## Validators

Open **Validators** in the sidebar (any role can use it).

### GSTR-1 JSON

Upload or paste an upload JSON produced by this app, the GST offline tool, Tally or any ERP. It is checked in four stages:

| Stage | What is checked |
|---|---|
| 1. Valid JSON | Syntax, with line and column of the first error |
| 2. GSTIN, period, version | Supplier GSTIN checksum and state; `fp` is MMYYYY, not in the future, not before July 2017, and a quarter-end month for QRMP; `version` matches the format profile for that period |
| 3. Structure | The GSTR-1 schema: required fields, types, enums, date and GSTIN patterns. Unknown fields are warnings |
| 4. GST rules | The JSON is read back into records and **every workbook rule** runs: recipient GSTINs, document numbers, dates within the period, POS, rates, IGST vs CGST/SGST and tax maths, invoice values, B2CL threshold, SEZ/export rules, HSN/SAC and UQC, duplicate documents, Table 12 reconciliation. JSON-only checks on top: one group per GSTIN/POS, one item per rate in a document, `sply_ty` vs POS, duplicate B2CS/advance lines, `net_issue = totnum − cancel`, the HSN layout for the period, amounts with more than 2 decimals, missing Table 13 |

Each finding shows its JSON path (for example `b2b[0].inv[2].itms[0].itm_det.rt`), document number and a suggestion, and can be downloaded as CSV.

**Fix and download.** *Fix automatically* applies only deterministic repairs, lists every change (path, before → after) and checks the file again:

- formats: case, dates to dd-mm-yyyy, 2-digit POS, numbers stored as text; amounts rounded to 2 decimals
- the format version for the period, and a missing `hash`
- `sply_ty` from POS, and IGST vs CGST/SGST heads and amounts (only where off by more than ₹1; can be switched off)
- items with the same rate, repeated GSTIN/POS groups, and duplicate B2CS/advance lines are merged
- item `num` (rate × 100 + 1), HSN and document row numbers; SAC rows get UQC `NA` and quantity 0
- `doc_num` from `doc_typ`, `net_issue = totnum − cancel`, and unknown fields are removed

Anything that needs judgement (a wrong GSTIN, invoice number, date, rate, or a B2CL↔B2CS move) gets a **Fix** button on the finding: type the new value (or remove the field) and the file is checked again. **Download fixed JSON** saves the working copy as `<name>-fixed.json`, and **Undo all changes** goes back to the original. Nothing is stored on the server. Turnover band and filing frequency come from the company with the file's GSTIN, or you can set them manually. Amendment and ECO sections are reported as *not checked*.

### GSTIN

Paste up to 100 GSTINs and pick a mode:

- **Offline check:** checksum, state, embedded PAN and holder type, entity number and registration type. Free, no network.
- **Sandbox API:** offline check plus GSTN's live record (legal and trade name, status, registration and cancellation date, taxpayer type, constitution, address, jurisdiction) through Sandbox.co.in [Search GSTIN](https://developer.sandbox.co.in/api-reference/gst/compliance/endpoints/public/search_gstin). Up to 50 per run, 3 lookups in parallel. Needs `SANDBOX_API_KEY` and `SANDBOX_API_SECRET` (any `GST_INTEGRATION` mode). Each lookup is a billable API call.
- **GST portal (CAPTCHA):** free. The app opens the portal's public *Search Taxpayer* and shows its CAPTCHA. You type it, and the app moves to the next GSTIN with a fresh CAPTCHA (**Skip** / **Stop** / **New image**). Portal cookies stay on the server for 5 minutes, and each CAPTCHA is used once. If the portal changes or is down, use the Sandbox mode.

### HSN / SAC

Checks are offline. A code must be 4, 6 or 8 digits. Goods codes need a real chapter (01–97; 77 is reserved, 98 is flagged). Services codes need a real SAC heading (9954, 9961–9999). The minimum digits follow turnover: 6 for B2B above ₹5 crore, otherwise 4. Each code shows its chapter or heading description, and there is a chapter and heading finder. The portal's HSN master still confirms on upload that a full 6- or 8-digit code exists. The same HSN rules now also run on imported workbooks.

## Production checklist

- Use a MongoDB replica set and run with `NODE_ENV=production` behind HTTPS (the session cookie is `secure` in production).
- For very large files (more than 50k rows), move `importExcel` to a background worker such as BullMQ. The engine is already framework-free.
- Verify `FORMAT_PROFILES` (JSON `version`, thresholds, rates) against the current GST offline-tool release notes.
- The portal CAPTCHA sessions and rate limits are in memory per instance. Behind a load balancer, use sticky sessions or move them to Redis.
