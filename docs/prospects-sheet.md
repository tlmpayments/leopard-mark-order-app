# The Routes tab

"Find Prospective Accounts" in the rep app (orders.tlmbg.co) is backed by a
**Routes** tab in the *TLM Distribution Master File* Google Sheet: one row per
prospective account (551 doors, from the CA ABC on-premise list).

## Who owns which column

| | Columns | Owner | What it means |
|---|---|---|---|
| **Plan** (white headers) | ID, Business Name, Owner, …, Route Priority, **Route**, **Stop**, Corridor Sweep, Second Pass Group, Latitude, Longitude | **The sheet** | Edit freely. The app reads them about once a minute. |
| **Field** (grey headers) | Visit Status, Last Visited By/At, Visit Count, Rep Notes, the survey answers, Visit Log | **The app** | Written when a rep visits a door. Typing here is overwritten by the next visit to that door. |

**Reordering a route = changing the Stop numbers.** Stops are numbered within a
Route. A red Stop cell means two doors share a stop on the same route. A blank
Route or Stop takes the door off its route (the sheet is the authority for
placement). The rep app's day-by-day schedule (James and Zack) is built from
these numbers, so reordering a route reshuffles which doors fall on which day.

Descriptive columns (name, address, tier…) fall back to the app's built-in copy
if a cell is blank. A row you add with an ID the app doesn't know, plus a
Latitude and Longitude, shows up as a new door.

The visit record itself is kept in the database (that's what makes live sync and
the visit trail work); the sheet is where the office reads it, one line per
account. The **Visit Log** cell keeps every visit, newest first.

## The survey

The questions live in one list, `SURVEY` in `lib/prospects/sheetColumns.ts`. It
drives the form in the rep app, the survey columns in the sheet, and the server's
validation. To change it: edit the list, run
`npx tsx scripts/build-prospects-seed.ts`, deploy, then run `setupProspectsTab()`
again in Apps Script (it adds any new columns and never touches existing data).

## Setup, once

1. **Database**: `npx prisma migrate deploy` (adds the survey columns; the
   migration is `20261002220000_prospect_survey`).
2. **Deploy the app** so `https://orders.tlmbg.co/rep-app/prospects-seed.json` exists.
3. **Apps Script** (Extensions -> Apps Script on the Master File). Add, do not replace:
   - Click **+** next to *Files* -> *Script*, name it `Prospects`, and paste the
     contents of `Prospects.gs` (everything in it is new code; it changes no
     existing function). Save.
   - In your existing `Code.gs`, find `function doPost(e)` and add these two
     lines next to the other `if (body.action === ...)` lines, before the final
     `return respond({ ok: false, error: 'Unknown action' });`:

         if (body.action === 'prospectsList') return respond(handleProspectsList(body));
         if (body.action === 'prospectVisit') return respond(handleProspectVisit(body));

   - Project Settings -> Script properties -> add **`PROSPECTS_SECRET`** = a long
     random string (e.g. `openssl rand -hex 24`).
   - Deploy -> Manage deployments -> pencil -> Version: **New version** -> Deploy
     (same URL; "Who has access" stays as it is).
   - In the editor choose `setupProspectsTab` and press **Run** (authorise once).
     The Routes tab fills in. It is safe to run again.
4. **Vercel** (project `leopard-mark-order-app`, Production): add
   **`PROSPECTS_SHEET_SECRET`** with the *same* value, then redeploy.

Until step 4 is done the app simply keeps using its built-in door list and the
sheet mirror skips quietly; nothing a rep records is lost either way.

`PROSPECTS_SECRET` is deliberately not `SYNC_SHARED_SECRET`: that one also
switches on the order sync, which is not live in production.

## Checking it works

- Change a Stop number in the sheet; within a minute or two the route's order
  changes in the app (open the route's overview).
- Mark a door and answer a survey question in the app; the door's row fills in
  within seconds (status, who, when, notes, answers, a Visit Log line).
- Jobs → "Write prospect visit to Sheet" in the Ops Hub shows each write, and
  retries any that failed.
