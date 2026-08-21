# Leopard Mark Brewing — Rep Order PWA

Installable web app for sales reps to place/reorder beer orders, which writes
straight into the shared order-tracking Google Sheet.

## What's here

```
index.html                 the whole app (login, home/stats, order screen)
assets/css/app.css         navy theme, matches the Ops Hub palette
assets/js/config.js        <- set APPS_SCRIPT_URL here after deploy
assets/js/products.js      SKU catalog (edit prices/codes here)
assets/js/app.js           app logic
manifest.json, sw.js       PWA install + offline shell caching
assets/icons/              app icon, generated from the crest logo
apps-script/Code.gs        paste into the spreadsheet's Apps Script editor
```

## 1. Set up the spreadsheet

Open the order sheet: https://docs.google.com/spreadsheets/d/1AjH3tCpLYbAuSD-yZtZgmGFrejtAm_XXF0-GQXJ2cNc

1. Confirm the tab behind `gid=690017703` (the "Sales" section) has this exact header row:
   `Invoice # | Customer | License Number | PO Date | Delivery (Invoice) Date | Product Name | Packaging Format | Product Code | Lot # | Qty | Price (ea) | Line Total | Inventory Source | BOL # | Sales Rep | Payment Method | ACH Invoice REF # | Invoice Status | TLM Tap Handle | SGB Tap Handle | CNT Tap Handle | MicroStar 1/2 Empty | MicroStar 1/6 Empty | Notes`
   If the tab name isn't literally "Sales", open `apps-script/Code.gs` after pasting it in and change `SALES_SHEET_NAME`.
2. Add a new tab named **Reps** with columns: `Name | PIN | Active`. One row per rep, e.g. `Jack Begley | 4821 | TRUE`. This is what the app checks on login.

## 2. Deploy the backend

1. In the spreadsheet: **Extensions → Apps Script**.
2. Delete the placeholder `Code.gs` content and paste in `apps-script/Code.gs` from this repo.
3. **Deploy → New deployment → type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone with the link**
4. Click Deploy, authorize the permissions Google prompts for (it needs to read/write this spreadsheet), and copy the **Web app URL**.
5. Paste that URL into `assets/js/config.js` as `APPS_SCRIPT_URL`.

Redeploy (Deploy → Manage deployments → edit → new version) any time you change `Code.gs`.

## 2b. Redeploy after this update

`apps-script/Code.gs` now has an `addCustomer` action. If you already deployed an
earlier version: **Deploy → Manage deployments → edit (pencil) → Version: New
version → Deploy.** The URL stays the same; you don't need to update `config.js` again.

This update also expects a **Customer Accounts** tab (loaded from
`TLM Distribution Master File.xlsx`, 107 accounts bundled into
`assets/js/customers.js`) with header row on **row 2**:
`Business Name | Sales Person | Region | Alc. License # | Legal Name | Ordering
Contact | Phone Number | Ordering Contact Email | Delivery Address | Delivery
Instructions | Delivery Window | Date of Last Line Cleaning | Payment Method |
Billing Contact Email | Billing Instructions | Terms | Billing Address (If not the
same as shipping) | Priority | Column 1 | Imported to Ekos`. New customers reps add
in the app get appended here.

## 3. What the app writes vs. leaves blank

The order form only asks for what a rep actually knows at order time: customer,
license # (optional), the beers/format/qty, and notes. It fills these columns:
`Customer, License Number, PO Date, Product Name, Packaging Format, Product Code,
Qty, Sales Rep, Invoice Status ("Pending"), Notes`.

Everything fulfillment-side — `Invoice #, Delivery Date, Lot #, Price (ea), Line
Total, Inventory Source, BOL #, Payment Method, ACH ref, tap handles, MicroStar
empties` — is left blank for ops/accounting to fill in once the order is invoiced.
Add prices to `assets/js/products.js` if you want Price/Line Total computed
client-side instead — the hooks are already there in `Code.gs`, just extend
`handleOrder` to multiply.

## 4. SKU scheme (already wired into `products.js`)

| Product | Format | Code |
|---|---|---|
| Cantinesca | 1/2 barrel keg (15.5 gal) | `CNT1AKHB01` |
| Cantinesca | 1/6 barrel keg (5.16 gal) | `CNT1AKSB01` |
| Cantinesca | 4/6/12 case (12oz cans) | `CNT1AC1224` |
| Sunlight Groove — Bay Area | 1/2 barrel keg | `SGB1AKHB01` |
| Sunlight Groove — Bay Area | 1/6 barrel keg | `SGB1AKSB01` |
| Sunlight Groove — Bay Area | 4/6/12 case | `SGB1AC1224` |

## 5. Run it locally

```
cd ~/Downloads/TheLeopardMark-OrderApp
python3 -m http.server 8732
# open http://localhost:8732
```

Until `config.js` has a real Apps Script URL, the app runs in **demo mode**:
login accepts any name/PIN, stats stay at zero, and "Submit Order" just shows a
success toast without writing anywhere. This is intentional so you can click
through the UI before wiring the sheet.

## 6. Install on a rep's phone

Once hosted somewhere with HTTPS (GitHub Pages, Netlify, Vercel, or your own
domain — service workers require HTTPS except on localhost):
- **iPhone (Safari):** open the URL → Share → Add to Home Screen.
- **Android (Chrome):** open the URL → menu → Install app / Add to Home screen.

## Known gaps / next steps

- Account list is bundled into the app (`assets/js/customers.js`), not fetched live
  from the sheet — so it reflects the Excel file as of the last export, and reps on
  different devices won't instantly see accounts another rep just added until the
  bundle is regenerated. New customers still get written to the sheet immediately;
  it's *reading* the full 107-account list live that isn't wired up yet.
- Accounts aren't scoped per rep yet — every rep sees the full 107-account list, not
  just their own book (the sheet does have a "Sales Person" column, so this is easy
  to filter by if you want it).
- No pricing yet — `Price (ea)` / `Line Total` are left blank by design (per your
  call). Add a `Price` tab or hardcode prices in `products.js` when ready.
- Reorder currently pre-fills the customer name from the rep's most recent order
  and lets them re-pick beers/qty — it doesn't yet clone a full past order's line
  items, since the sheet has no order-group ID to reconstruct multi-item orders by.
  Adding an `Order ID` column would make that possible.
