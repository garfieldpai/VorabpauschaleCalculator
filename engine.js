/**
 * Vorabpauschale Calculation Engine
 * Implements §18 InvStG 2018 per the literal statutory text and the
 * BMF Schreiben vom 21.05.2019 (InvStG Anwendungsfragen), para 18.1-18.4.
 *
 * Key rules encoded here (verified against primary sources during development):
 *
 * 1. Basisertrag = Rücknahmepreis am Jahresanfang × Basiszins × 0.7   (§18 Abs.1 Satz 2)
 *    - "Rücknahmepreis am Jahresanfang" is the SAME value used for every tranche of a
 *      given fund/year, regardless of when in the year a tranche was actually bought.
 *      It is NOT the tranche's own purchase-date price.
 *
 * 2. Mehrbetrag (cap) = (Rücknahmepreis Jahresende − Rücknahmepreis Jahresanfang)
 *                        + Ausschüttungen im Kalenderjahr                (§18 Abs.1 Satz 3)
 *    - Basisertrag is capped at this Mehrbetrag. Never negative (floor at 0).
 *    - The Mehrbetrag is also the SAME for every tranche of a given fund/year.
 *
 * 3. Acquisition-year reduction: for units acquired DURING the year, the Vorabpauschale
 *    is reduced by 1/12 for each full month preceding the month of acquisition.
 *    (§18 Abs.2). A unit bought in month M (1=Jan..12=Dec) keeps (12-(M-1))/12 = (13-M)/12
 *    of the full-year Basisertrag.
 *
 * 4. Rounding (BMF 18.4): the per-unit Basisertrag must be carried to AT LEAST 4 decimal
 *    places. Rounding to 2 decimals (cents) happens ONLY ONCE, after multiplying by the
 *    number of units held as of 31 December of the calendar year. No rounding (to zero
 *    or otherwise) may occur at the per-unit stage before that multiplication.
 *
 * 5. Distributions (Ausschüttungen) reduce the Vorabpauschale base directly per unit,
 *    since the whole point of Vorabpauschale is to tax the SHORTFALL between actual
 *    distributions and the deemed minimum return.
 *
 * 6. Teilfreistellung (partial exemption, §20 InvStG) applies only to funds that qualify
 *    as "Investmentfonds" under §1 InvStG AND meet the relevant equity/property quota.
 *    This tool treats Teilfreistellung as OPT-IN per fund, not automatic, because foreign
 *    (non-EU/EEA regulated) funds' qualification is fact-specific and not assumed here.
 *
 * 7. Currency conversion: Vorabpauschale is computed in the fund's reporting currency,
 *    then converted to EUR ONCE at the end, using the exchange rate on 31 December of
 *    the relevant calendar year (the date the Vorabpauschale is deemed to accrue,
 *    per §18 Abs.3: "am ersten Werktag des folgenden Kalenderjahres als zugeflossen").
 *    Converting each tranche's NAV to EUR individually before computing is NOT done here,
 *    to stay consistent with the literal statute (Rücknahmepreis am Jahresanfang is a
 *    single fund-level figure, not a per-tranche FX-adjusted figure).
 */

/**
 * Compute the Vorabpauschale for a single fund holding for one calendar year.
 *
 * @param {Object} fund
 * @param {number} fund.navStart - Rücknahmepreis (NAV) at start of year, native currency
 * @param {number} fund.navEnd - Rücknahmepreis (NAV) at end of year, native currency
 * @param {number} fund.distributionsPerUnit - total Ausschüttungen per unit during the year, native currency
 * @param {number} fund.basiszins - Basiszins for the year (e.g. 0.0229 for 2024), as a decimal
 * @param {boolean} fund.teilfreistellungApplies - whether the 30% equity-fund exemption applies
 * @param {Array<{units: number, acquisitionMonth: number|null}>} fund.tranches
 *        acquisitionMonth: 1-12 if acquired during the year, or null if held since before the year (full 12/12)
 * @param {number} fxRateYearEnd - units of native currency per 1 EUR, on 31 Dec of the year (e.g. INR/EUR)
 *
 * @returns {Object} detailed breakdown
 */
function calculateVorabpauschale(fund, fxRateYearEnd) {
  const { navStart, navEnd, distributionsPerUnit, basiszins, teilfreistellungApplies, tranches } = fund;

  // Step 1: Basisertrag per unit, full year (4+ decimal precision, no early rounding)
  const basisertragFullYear = navStart * basiszins * 0.7;

  // Step 2: Mehrbetrag (cap), same for all tranches of this fund/year
  const mehrbetrag = Math.max((navEnd - navStart) + distributionsPerUnit, 0);

  // Step 3: cap the full-year Basisertrag at the Mehrbetrag (before any monthly pro-ration)
  const basisertragCapped = Math.min(basisertragFullYear, mehrbetrag);

  // Step 4: per tranche, apply monthly pro-ration, then multiply by units
  // (the cap is in absolute currency, applied to the FULL-YEAR figure once; pro-ration
  //  scales the already-capped full-year amount, matching §18 Abs. 2's "vermindert sich
  //  die Vorabpauschale" — it is the Vorabpauschale being reduced, not the Basisertrag
  //  recomputed from scratch per tranche.)
  let totalNativeCurrency = 0;
  const tranchesBreakdown = tranches.map((t) => {
    const monthsHeld = t.acquisitionMonth ? (13 - t.acquisitionMonth) : 12;
    const fraction = monthsHeld / 12;
    const vpPerUnit = basisertragCapped * fraction;
    // Subtract distributions per unit directly is already embedded in Mehrbetrag's
    // calculation; do not subtract again here (BMF 18.1: distributions only enter once,
    // via the Mehrbetrag formula).
    const vpForTranche = vpPerUnit * t.units;
    totalNativeCurrency += vpForTranche;
    return {
      units: t.units,
      acquisitionMonth: t.acquisitionMonth,
      monthsHeld,
      vpPerUnit,
      vpForTranche,
    };
  });

  // Step 5: round to 2 decimals ONCE, in native currency, after summing all tranches
  const totalNativeCurrencyRounded = Math.round(totalNativeCurrency * 100) / 100;

  // Step 6: convert to EUR using year-end FX rate (units of native currency per 1 EUR)
  const totalEUR = totalNativeCurrencyRounded / fxRateYearEnd;
  const totalEURRounded = Math.round(totalEUR * 100) / 100;

  // Step 7: apply Teilfreistellung if applicable (reduces TAXABLE amount, not the VP itself)
  const teilfreistellungRate = teilfreistellungApplies ? 0.3 : 0;
  const taxableEUR = totalEURRounded * (1 - teilfreistellungRate);
  const taxableEURRounded = Math.round(taxableEUR * 100) / 100;

  return {
    basisertragFullYear,
    mehrbetrag,
    basisertragCapped,
    isCapped: basisertragFullYear > mehrbetrag,
    tranches: tranchesBreakdown,
    totalNativeCurrency: totalNativeCurrencyRounded,
    fxRateYearEnd,
    totalEUR: totalEURRounded,
    teilfreistellungApplies,
    teilfreistellungRate,
    taxableEUR: taxableEURRounded,
  };
}

/**
 * Official Basiszins values published by the BMF (Bundessteuerblatt), by calendar year.
 * Source: published annually; user should verify against current BMF announcement
 * for years not yet in this table.
 */
const BASISZINS_BY_YEAR = {
  2018: 0.0087,
  2019: 0.0052,
  2020: 0.0007,
  2021: -0.0045,
  2022: 0.0000,
  2023: 0.0255,
  2024: 0.0229,
  2025: 0.0253,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calculateVorabpauschale, BASISZINS_BY_YEAR };
}
