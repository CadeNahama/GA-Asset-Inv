# ServiceNow PDI — Asset Inventory Dashboard, click by click

Written for **dev377063.service-now.com**, starting from the logged-in home page.
Assumes you have never built a table, report, or dashboard in ServiceNow.

**File you need** (in the project folder):
`servicenow-import-sample.csv` — 500 rows, use this one.
(`servicenow-import-full.csv` has all 8,000 for when the dashboard is final.)

Regenerate either at any time with `node scripts/export-servicenow.js`.

---

## Mental model (read this first, it's 30 seconds)

There is no separate "create a database" step. ServiceNow **is** a database.
You will:

1. **Create a table** — the container for your device records.
2. **Import the CSV** — this creates a second, temporary *staging* table and
   copies your rows into it.
3. **Create a transform map** — the rules that copy rows from staging into
   your real table.
4. **Build reports** — saved queries/charts against your real table.
5. **Build a dashboard** — a page that displays those reports.

Everything is reached by clicking **All** in the top-left nav and typing into
the filter box that appears. If a menu label below doesn't match exactly,
search the filter box for the words in bold — ServiceNow moves things
between releases but the search always finds them.

> **Why two tables?** The staging table is wiped periodically by a built-in
> cleanup job and accumulates duplicate rows on every import. Never build
> reports on it. Your real (target) table is permanent and deduplicated.
> This split is also what lets you automate the feed later without
> rebuilding a single report.

---

## Part 1 — Create your table

### 1.1 Open the Tables list

1. Click **All** (top-left).
2. In the **Filter** box, type `Tables`.
3. Click **System Definition → Tables**.
4. Click the blue **New** button (top right).

### 1.2 Name the table

- **Label:** `GA Asset Inventory`
- **Name:** auto-fills to `u_ga_asset_inventory` — leave it.
- **Application:** `Global`
- Tick **Create module** if offered (adds it to the left nav so you can find
  the records easily later).
- Do **not** fill in "Extends table" — this is a standalone table.

Click **Submit**, then reopen the record (Tables list → search
`GA Asset Inventory`).

### 1.3 Add the columns

On the table record, find the **Columns** related list at the bottom
(in newer releases this may be a **Columns** tab, or open **Table Builder**).
Click **New** for each row below.

For each column set four things: **Column label**, **Column name**, **Type**,
and **Max length** (String only).

Set **Column label**, **Type**, and **Max length** (String only). Let the
**Column name** auto-fill — you do not need to correct it. The export script
conforms the CSV headers to whatever ServiceNow generated, rather than the
other way round.

| Column label | Type | Max length | Column name generated |
|---|---|---|---|
| Name | String | 100 | `u_name` |
| Type | String | 40 | `u_type` |
| Status | String | 40 | `u_status` |
| Application Service | String | 100 | `u_application_service` |
| Env | String | 40 | `u_env` |
| Security | String | 40 | `u_security` |
| NetColor | String | 40 | `u_netcolor` |
| dcLoc | String | 40 | `u_dcloc` |
| LoC | String | 100 | `u_loc` |
| OS | String | 100 | `u_os` |
| IPs | String | 255 | `u_ips` |
| itsGroup | String | 60 | `u_itsgroup` |
| ITS 1 | String | 100 | `u_its_1` |
| MaintVndr | String | 100 | `u_maint_vndr` |
| **MaintExp** | **Date** | — | `u_maintexp` |
| MaintSLA | String | 40 | `u_maint_sla` |
| **Verified** | **Date** | — | `u_verified` |
| **impUsers** | **Integer** | — | `u_impusers` |

> ServiceNow's camelCase handling is inconsistent — `MaintSLA` splits into
> `u_maint_sla` but `MaintExp` does not split into `u_maint_exp`. The right
> column is what it actually produced on this instance.

**Verify:** on the Table Columns list, click the ⚙ gear icon and add **Column
name** to the displayed fields. If any differ from the last column above,
edit the `SN_HEADERS` map at the top of `scripts/export-servicenow.js` to
match and re-run it — do **not** edit the ServiceNow dictionary.

ServiceNow also adds ~6 system columns automatically (Sys ID, Created,
Created by, Updated, Updated by, Updates). Leave them alone — 18 of yours
plus those makes 24 total. The Max length shown on Date/Integer rows is
ignored by the platform; no need to change it.

**The three bold rows are the important ones.** Date and Integer types are
what make "expiring in 90 days" and numeric sorting possible. If they're
Strings, those reports cannot be built.

> **Why only 18 of 39 columns?** You only need the fields the dashboard
> actually reports on. Adding the other 21 is the same process any time you
> want them — nothing breaks by leaving them out now.

---

## Part 2 — Import the CSV

### 2.1 Load the file

1. Click **All** → filter for `Load Data`.
2. Click **System Import Sets → Load Data**.
3. On the form:
   - **Import set table:** select **Create table**
   - **Label:** `GA Asset Import` (name auto-fills `u_ga_asset_import`)
     — *write this name down, the automation step later needs it*
   - **Source of the data:** select **File**
   - Click **Choose file** and pick `servicenow-import-sample.csv`
   - **Sheet number:** `1` · **Header row:** `1`
4. Click **Submit**.

A progress screen appears. Wait for **Succeeded**. You now have 500 rows
sitting in the staging table.

### 2.2 Sanity check

Click the **Import set** link on the progress screen. You should see 500 rows
with columns like `u_type`, `u_status`, `u_name`. These names come from the
CSV headers, which are the web app's stable API keys — they won't drift if
someone renames a column label in the app.

---

## Part 3 — Create the transform map

This connects staging → your real table.

1. Click **All** → filter for `Transform Map`.
2. Click **System Import Sets → Administration → Transform Maps**.
3. Click **New**.
4. Fill in:
   - **Name:** `GA Asset Inventory Transform`
   - **Source table:** `GA Asset Import` (`u_ga_asset_import`)
   - **Target table:** `GA Asset Inventory` (`u_ga_asset_inventory`)
   - Leave **Active** ticked, **Run business rules** ticked.
5. Click **Submit**, then reopen the record.

### 3.1 Auto-map the fields

On the transform map record, look for the related links under the form:
click **Auto map matching fields**.

Because the CSV headers and your column names line up, this maps all 18
automatically. Check the **Field Maps** related list — you should see 18
entries like `u_name → u_name`.

Any CSV column you didn't create in Part 1 is simply ignored. That's fine.

### 3.2 Set the coalesce field — do not skip this

1. In the **Field Maps** related list, click the row for **`u_name`**.
2. Tick the **Coalesce** checkbox.
3. Click **Update**.

Coalesce makes hostname the match key: re-importing the same file **updates**
existing records instead of creating duplicates. Without it, every import
doubles your table. This mirrors the dedup logic already in the web app,
which matches on the same column.

> **"Coalesce field not indexed" popup — click OK.** ServiceNow is offering
> to index `u_name`. Take it. Coalescing runs a lookup per incoming row, and
> without an index that's a full table scan each time — fine on 500 rows,
> painful on 8,000. Same reason the web app indexes its DNS column.

### 3.3 Common snag: "Unable to format 2026-10-08 using format string
### yyyy-MM-dd HH:mm:ss"

ServiceNow parses imported dates with the system **date-time** format string,
even for fields typed as Date. A bare `2026-10-08` therefore fails.

`scripts/export-servicenow.js` handles this: headers listed in `DATE_FIELDS`
are written as `2026-10-08 00:00:00`. A Date field discards the time, a
Date/Time field keeps it — either parses cleanly. If you add more date
columns to the ServiceNow table later, add their headers to `DATE_FIELDS`.

Symptom to recognise: rows import with State *Inserted* and a populated
Target record, but the date columns come out blank and the Import Log has
two error entries per row (one per date field).

### 3.4 Common snag: the first CSV column fails to auto-map

If exactly one field is missing after auto-map and it's the *first* column,
check the source-field dropdown for an entry like `ï»¿name`. That's a UTF-8
byte-order mark; ServiceNow does not strip it and folds it into the column
name. `scripts/export-servicenow.js` writes without a BOM to avoid this
(`csv.serialize(..., { bom: false })`), while the app's own Export button
keeps the BOM so Excel opens files correctly.

---

## Part 4 — Run the transform

1. Click **All** → filter `Import Sets` → **System Import Sets → Run Transform**.
2. **Import set:** pick your most recent one (highest `ISET…` number).
3. **Map:** `GA Asset Inventory Transform`.
4. Click **Transform**.

> Some releases have no "All Import Sets" module. To browse them anyway, type
> `sys_import_set.list` in the filter box — **any** table opens with
> `<table_name>.list`, which routes around missing menu modules entirely.
> If you re-imported after a failed attempt, transform the **newest** import
> set; transforming an older one is harmless (rows with a blank coalesce
> field are skipped) but populates nothing.

### 4.1 Verify

In the filter box, type `u_ga_asset_inventory.list` and press Enter.

You should see 500 device records. Check that:
- **MaintExp** and **Verified** render as **dates**, not plain text.
- **impUsers** right-aligns like a number.

If those are showing as text, the column type is wrong — fix it in Part 1.3
and re-run the transform.

### 4.2 Prove coalesce works

Re-run Part 2 with the **same file**, then transform again. The record count
should stay **500**, not go to 1,000. If it doubled, coalesce isn't set.

---

## Part 5 — Build the reports

Reports are saved queries. Build them one at a time, save each one.

1. Click **All** → filter `Reports` → **Reports → Create New**.
2. For each report below:
   - **Name:** as listed
   - **Source type:** `Table`
   - **Table:** `GA Asset Inventory`
   - **Type:** as listed (choose from the visualization picker)
   - Configure **Group by** / **Filter** as listed
   - Click **Save**

| Report name | Type | Configuration |
|---|---|---|
| Devices by Type | Donut | Group by: **Type** |
| Devices by Status | Bar | Group by: **Status** |
| Devices by Environment | Pie | Group by: **Env** |
| Devices by Datacenter | Bar | Group by: **dcLoc** |
| Security Classification | Bar | Group by: **Security** |
| Support Load by Group | Bar | Group by: **itsGroup** |
| Total Devices | Single Score | No filter |
| Maintenance Expiring (90 days) | List | Filter: **MaintExp** · *on or before* · **Today + 90 days**. Sort ascending. Show columns: Name, Type, MaintVndr, MaintExp, MaintSLA |
| Stale Verification | Single Score | Filter: **Verified** · *before* · **Today - 365 days** |
| Unowned Devices | Single Score | Filter: **ITS 1** · *is empty* |

The last three are data-quality tiles — they make neglect visible, which is
the thing that actually changes behaviour once real data is in here.

---

## Part 6 — Build the dashboard

1. Click **All** → filter `Dashboards`.
2. Click **Self-Service → Dashboards** (may appear under **Platform
   Analytics** in newer releases — either reaches the same place).
3. Click **Create a dashboard** / **New**.
   - **Name:** `GA Asset Inventory`
   - Leave sharing default (just you, on a PDI).
4. On the empty dashboard, click **Add widgets** (or the **+** icon).
5. Search each report by name and drag it on. Suggested layout:
   - **Top row:** Total Devices · Unowned Devices · Stale Verification
   - **Middle:** Devices by Type · Devices by Status · Devices by Environment
   - **Lower:** Devices by Datacenter · Security Classification
   - **Full width bottom:** Maintenance Expiring (90 days)
6. Drag edges to resize. Click **Done / Save**.

### 6.1 Add interactive filters — this is the payoff

On the dashboard, click **Add widgets → Interactive Filter**. Add three,
each pointing at table `GA Asset Inventory`:

- Filter on **Type**
- Filter on **Env**
- Filter on **dcLoc**

Now every chart on the dashboard re-slices when you pick a value. This is how
you answer "just the servers in SD-DC1" **without building another report** —
which was the original goal of making the data easy to query.

---

## Part 7 — Later: replace the manual CSV with an automated feed

Nothing in Parts 1, 3, 4, 5, or 6 changes. Only Part 2 is replaced.

**Option A — the web app pushes (simplest).** A script POSTs rows as JSON to:

```
POST https://dev377063.service-now.com/api/now/import/u_ga_asset_import
```

That is the Import Set API endpoint, named after the **staging table you
created in Part 2**. Rows land in staging, your transform map fires
automatically, your target table updates, and every report and the dashboard
reflect it. Outbound-only from your machine — no tunnel, no firewall change,
nothing exposed.

**Option B — ServiceNow pulls via MID Server.** A MID Server inside the
network calls the web app's REST API on a schedule and feeds the same staging
table. More infrastructure, but ServiceNow admins control the schedule — the
pattern GA's team will expect if they already run MID Servers.

Either way: **same staging table, same transform map, same dashboard.**

---

## Troubleshooting

**"Auto map matching fields" mapped nothing.** Your column names don't match
the CSV headers. Check a column's **Column name** (not label) is exactly
`u_maint_exp` etc. Fix by editing the field map rows manually.

**Dates show as text / date filters unavailable.** Column type is String.
Change it in the table's Columns list, then re-run the transform.

**Record count doubled after re-import.** Coalesce isn't set on `u_name`
(Part 3.2).

**Can't find a menu.** Click **All** and search the bold words — labels shift
between releases, search doesn't.

**Instance asleep.** PDIs hibernate after ~10 days idle. Wake it from the
developer portal; your data is still there.
