# Vorabpauschale Rechner

A calculator for the German "Vorabpauschale" (advance lump sum) on foreign investment funds — the kind of fund where no German custodian bank automatically withholds tax for you, so you need to calculate and declare it yourself in Anlage KAP.

Built for situations like: Indian, US, or other non-EU mutual funds and ETFs, bought via SIP/Sparplan (recurring monthly purchases), where each tranche has its own purchase date and needs its own pro-rated calculation.

## Why this exists

Most online Vorabpauschale calculators assume a single lump-sum purchase. None of the ones tested (including a popular tax-software vendor's support tool) correctly handled:
- Multiple SIP tranches with different acquisition months in the same fund
- The exact rounding rule from the BMF's 21 May 2019 circular (round once, at the end, not per unit)
- Foreign currency conversion at the correct point in the calculation
- Year-over-year continuation without re-entering fund details from scratch

This tool encodes the formula directly from the statutory text of §18 InvStG and the BMF's application guidance, with the calculation logic (`engine.js`) kept deliberately separate from the UI so it can be read, checked, and tested independently — and so others can verify or challenge the logic against their own reading of the law.

**This is not tax advice.** Always verify your specific situation — especially whether a given foreign fund qualifies for Teilfreistellung — with a Steuerberater.

## How the calculation works

See the in-app **Help & Tax Law** tab for the full step-by-step explanation with worked examples and citations. Briefly:

1. **Basisertrag** = NAV at start of year × Basiszins × 70% (same NAV for every tranche, regardless of purchase date)
2. **Mehrbetrag** (cap) = (NAV at year end − NAV at year start) + distributions per unit, floored at zero
3. Basisertrag is capped at the Mehrbetrag
4. Units bought during the year get a 1/12-per-month reduction for each full month before purchase
5. Rounding to cents happens **once**, after multiplying by year-end unit count — never per-unit beforehand
6. The final native-currency total is converted to EUR once, using the 31 December exchange rate

## Exchange rates

Pick a currency from the dropdown when adding a fund — INR, USD, and GBP are pinned at the top as the most common cases, with other major currencies and a free-text ISO code option below. Once a fund's currency and the tax year are set, click **Fetch rate** to pull the 31 December rate automatically from the [Frankfurter API](https://www.frankfurter.dev) — a free, open-source, ECB-sourced exchange rate service with no API key and no usage limits.

The ECB doesn't publish rates on weekends or EU holidays, so if 31 December falls on a non-trading day, Frankfurter returns the nearest prior business day's rate instead — the tool shows you exactly which date was actually used rather than silently substituting it. There's also a manual override field next to the fetch button, for entering a rate yourself (e.g. an actual bank conversion rate) instead.

## Running locally

No build step — it's plain HTML/CSS/JS.

```bash
git clone <this-repo>
cd vorabpauschale-rechner
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploying to GitHub Pages

1. Push this repo to GitHub
2. Repo Settings → Pages → Source: deploy from branch `main`, folder `/ (root)`
3. Your calculator will be live at `https://<username>.github.io/<repo-name>/`

## Saving your data year to year

Click **Export JSON** in the Summary tab after entering a year's figures. Keep the file (in Google Drive, Dropbox, on your own computer — anywhere). Next year, click **Continue from prior year file** and select it: fund names, ISINs, and currencies carry forward automatically, last year's closing NAV becomes this year's opening NAV, and all of last year's tranches collapse into one new "opening balance" tranche so you can add the new year's SIP purchases on top.

### Google Drive sync (optional, requires one-time setup)

The "Connect Google Drive" button is a placeholder until you wire up a Google Cloud OAuth client:

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Google Drive API**
3. Create an **OAuth 2.0 Client ID** (type: Web application), with your GitHub Pages URL as an authorized origin
4. Drop the client ID into `app.js` where the Drive integration is stubbed, using the [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/overview) and [Drive API v3](https://developers.google.com/drive/api/guides/about-sdk) JS libraries to read/write the exported JSON to a file in the user's own Drive (e.g. `appDataFolder` scope, so it doesn't clutter their visible Drive).

Until that's wired up, manual export/import covers the same need — drop the exported file into your own Drive folder yourself.

## Basiszins reference table

Published annually by the BMF in the Bundessteuerblatt, derived from Bundesbank yield-curve data on the first trading day of the year. The table in `engine.js` (`BASISZINS_BY_YEAR`) covers 2018–2025; verify and extend it for later years against the official BMF announcement before relying on it.

## Known limitations / open questions

- **Teilfreistellung eligibility** for non-EU/EEA funds is left as a manual opt-in per fund, because whether a given foreign fund qualifies as an "Investmentfonds" under §1 InvStG (a prerequisite for the exemption) is fact-specific and not something this tool determines for you.
- **FX conversion timing**: this tool converts once, at the very end, using a single year-end rate — consistent with a literal reading of §18, but if your own Steuerberater's established practice differs (e.g. converting NAVs to EUR per-tranche at purchase-date rates), check that you're being consistent with your own prior filings.
- This has been checked against hand calculations and cross-verified logic, but has **not** been reviewed by a tax professional. Treat it as a calculation aid, not a substitute for proper advice — particularly given the rounding and Teilfreistellung questions above carry real monetary stakes.

## Contributing

Issues and PRs welcome — especially from anyone who can point to authoritative guidance on the open questions above, or who finds a fund structure this doesn't handle correctly (e.g. redemptions/sales during the year, funds with negative Basiszins years, swing pricing).
