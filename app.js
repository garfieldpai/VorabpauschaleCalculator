/**
 * Vorabpauschale Rechner — Application Logic
 *
 * State shape:
 * {
 *   taxYear: 2024,
 *   basiszins: 0.0229,
 *   funds: [
 *     {
 *       id: 'f1', name: 'HDFC Mid-Cap...', isin: 'INF179K01CR2', currency: 'INR',
 *       navStart: 192.4350, navEnd: 203.7350, distributionsPerUnit: 0,
 *       teilfreistellungApplies: false,
 *       fxRateYearEnd: 93.0634, fxRateDate: '2024-12-31', fxRateSource: 'frankfurter',
 *       tranches: [ { id: 't1', units: 4235.489, acquisitionMonth: null, label: 'Held since before 2024' }, ... ]
 *     }
 *   ]
 * }
 *
 * FX rate moved to per-fund (not global) since each fund can be denominated in a
 * different currency. Rates are auto-fetched from the Frankfurter API (free,
 * ECB-sourced, no key required: https://www.frankfurter.dev) for the requested
 * date, but the ECB does not publish on weekends/EU holidays — Frankfurter returns
 * the nearest prior business day's rate instead, and tells us which date it actually
 * used via the response's `date` field. We surface that actual date to the user
 * rather than silently substituting it, since "31 Dec" and "the rate Frankfurter
 * happened to return" are not always the same date.
 */

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1';

const TOP_CURRENCIES = [
  { code: 'INR', label: 'INR — Indian Rupee' },
  { code: 'USD', label: 'USD — US Dollar' },
  { code: 'GBP', label: 'GBP — British Pound' },
];
const OTHER_CURRENCIES = [
  { code: 'CHF', label: 'CHF — Swiss Franc' },
  { code: 'JPY', label: 'JPY — Japanese Yen' },
  { code: 'CAD', label: 'CAD — Canadian Dollar' },
  { code: 'AUD', label: 'AUD — Australian Dollar' },
  { code: 'SGD', label: 'SGD — Singapore Dollar' },
  { code: 'CNY', label: 'CNY — Chinese Yuan' },
  { code: 'HKD', label: 'HKD — Hong Kong Dollar' },
  { code: 'SEK', label: 'SEK — Swedish Krona' },
  { code: 'NOK', label: 'NOK — Norwegian Krone' },
  { code: 'OTHER', label: 'Other (enter ISO code)' },
];

let state = {
  taxYear: new Date().getFullYear() - 1,
  basiszins: BASISZINS_BY_YEAR[new Date().getFullYear() - 1] || 0.0229,
  funds: [],
  foreignIncome: {
    nreInterest:       { amount: 0, tds: 0 },  // NRE FD — untaxed in India, fully taxable in DE
    nroInterest:       { amount: 0, tds: 0 },  // NRO savings/FD — TDS creditable up to 10%
    dividends:         { amount: 0, tds: 0 },  // Indian stock/MF dividends — TDS creditable up to 10%
    stockGains:        { amount: 0, tds: 0 },  // Share/MF sale gains — §20 Abs.2
    stockLosses:       { amount: 0 },           // Share/MF sale losses — only offsettable vs gains
    otherInterest:     { amount: 0, tds: 0 },  // Other foreign interest
    otherDividends:    { amount: 0, tds: 0 },  // Other foreign dividends
  },
};

let idCounter = 1;
function nextId(prefix) { return `${prefix}${idCounter++}`; }

// ---------- Persistence (localStorage as a session safety net, not the primary store) ----------
function saveToLocalStorage() {
  try {
    localStorage.setItem('vorabpauschale_state', JSON.stringify(state));
  } catch (e) { /* storage unavailable, ignore — JSON export remains the source of truth */ }
}
function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem('vorabpauschale_state');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.funds) state = parsed;
    }
  } catch (e) { /* ignore corrupt/missing data */ }
}

// ---------- Toast ----------
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------- Tab navigation ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'summary') renderSummary();
  });
});

// ---------- Tax year dropdown ----------
function populateTaxYearDropdown() {
  const sel = document.getElementById('taxYear');
  sel.innerHTML = '';
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 1; y >= 2018; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = `${y}  (→ filed in ${y + 1} return)`;
    sel.appendChild(opt);
  }
  sel.value = state.taxYear;
}
document.getElementById('taxYear').addEventListener('change', (e) => {
  state.taxYear = parseInt(e.target.value, 10);
  const known = BASISZINS_BY_YEAR[state.taxYear];
  if (known !== undefined) {
    state.basiszins = known;
    document.getElementById('basiszins').value = (known * 100).toFixed(4);
  }
  recalcAll();
  saveToLocalStorage();
});
document.getElementById('basiszins').addEventListener('input', (e) => {
  state.basiszins = parseFloat(e.target.value) / 100 || 0;
  recalcAll();
  saveToLocalStorage();
});

// ---------- FX rate fetching (Frankfurter API — free, ECB-sourced, no key) ----------
const fxCache = {}; // key: `${currency}_${date}` -> { rate, actualDate }

async function fetchFxRate(currency, isoDate) {
  if (currency === 'EUR') return { rate: 1, actualDate: isoDate };
  const cacheKey = `${currency}_${isoDate}`;
  if (fxCache[cacheKey]) return fxCache[cacheKey];

  const url = `${FRANKFURTER_BASE}/${isoDate}?from=${encodeURIComponent(currency)}&to=EUR`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Frankfurter API returned ${resp.status}`);
  const data = await resp.json();
  if (!data.rates || data.rates.EUR == null) throw new Error('No EUR rate in response');

  // data.rates.EUR is "1 unit of `currency` = X EUR". Our engine wants
  // "units of native currency per 1 EUR", i.e. the inverse.
  const nativePerEur = 1 / data.rates.EUR;
  const result = { rate: nativePerEur, actualDate: data.date };
  fxCache[cacheKey] = result;
  return result;
}

async function fetchAndApplyFxRate(fundId) {
  const fund = state.funds.find(f => f.id === fundId);
  if (!fund || fund.currency === 'EUR') return;
  const currency = fund.currency === 'OTHER' ? (fund.customCurrency || '').toUpperCase() : fund.currency;
  if (!currency || currency.length !== 3) {
    showToast('Enter a valid 3-letter currency code first');
    return;
  }

  const dec31 = `${state.taxYear}-12-31`;

  const statusEl = document.querySelector(`[data-fx-status="${fundId}"]`);
  if (statusEl) statusEl.textContent = 'Fetching rate…';

  try {
    const yearEnd = await fetchFxRate(currency, dec31);
    fund.fxRateYearEnd = yearEnd.rate;
    fund.fxRateDate = yearEnd.actualDate;
    fund.fxRateSource = 'frankfurter';
    renderFunds();
    saveToLocalStorage();
    const note = yearEnd.actualDate !== dec31
      ? ` (${dec31} wasn't a trading day — using ${yearEnd.actualDate}, the nearest prior business day)`
      : '';
    showToast(`Rate fetched: 1 EUR = ${yearEnd.rate.toFixed(4)} ${currency}${note}`);
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Could not fetch — enter rate manually below';
    showToast(`Couldn't reach the exchange rate service. Enter the rate manually.`);
  }
}

// ---------- Indian MF NAV fetching (mfapi.in — free, CORS-enabled, AMFI-sourced) ----------
//
// Flow:
//   1. Search for scheme code matching the fund's ISIN via the search endpoint
//      GET https://api.mfapi.in/mf/search?q={isin}
//   2. Fetch full NAV history for that scheme_code
//      GET https://api.mfapi.in/mf/{scheme_code}
//      Returns {meta, data:[{date:"31-Dec-2024", nav:"203.7350"},...], status}
//   3. Find NAVs for:
//      - "Start of year" = last published NAV on or before 31 Dec of (taxYear-1)
//        Jan 1 is never a trading day in India (public holiday), so we always
//        look for the nearest prior date to Jan 1 of the selected year.
//      - "End of year" = last published NAV on or before 31 Dec of taxYear.
//   4. Auto-fill navStart, navEnd, record actual dates used.
//
// mfapi.in NAV history is sorted newest-first. We cache per scheme_code so
// re-renders don't re-fetch.

const MFAPI_BASE = 'https://api.mfapi.in/mf';
const CAPTNEMO_BASE = 'https://mf.captnemo.in';
const navApiCache = {}; // scheme_code → { meta, navHistory: [{isoDate, nav}] }
const isinSchemeCodeCache = {}; // isin → schemeCode

async function findSchemeCodeByIsin(isin) {
  if (isinSchemeCodeCache[isin]) return isinSchemeCodeCache[isin];

  // Strategy 1 (PRIMARY): mfdata.in — CORS-enabled, accepts ISIN search directly,
  // aggregates from multiple sources including AMFI. Much more reliable than AMFI's
  // own website (which blocks browser CORS requests) or captnemo (data quality issues).
  // Endpoint: GET /api/v1/schemes/search?q={ISIN}
  // Returns: { status, data: [{ scheme_code, scheme_name, isin_growth, isin_div_reinvest, ... }] }
  try {
    const resp = await fetch(
      `https://mfdata.in/api/v1/schemes/search?q=${encodeURIComponent(isin)}`
    );
    if (resp.ok) {
      const json = await resp.json();
      if (json.status === 'success' && json.data?.length) {
        // Find the entry whose ISIN matches exactly (search may return partials)
        const match = json.data.find(s =>
          s.isin_growth?.toUpperCase() === isin.toUpperCase() ||
          s.isin_div_reinvest?.toUpperCase() === isin.toUpperCase()
        ) || json.data[0]; // fall back to first result if no exact ISIN field match
        const schemeCode = match.scheme_code;
        isinSchemeCodeCache[isin] = schemeCode;
        return schemeCode;
      }
    }
  } catch (e) { /* fall through */ }

  // Strategy 2: mfapi.in search endpoint — searches by name, but ISIN strings
  // sometimes appear in scheme names or metadata. Less reliable but worth trying.
  try {
    const resp = await fetch(`${MFAPI_BASE}/search?q=${encodeURIComponent(isin)}`);
    if (resp.ok) {
      const results = await resp.json();
      if (Array.isArray(results) && results.length > 0) {
        const schemeCode = results[0].schemeCode;
        isinSchemeCodeCache[isin] = schemeCode;
        return schemeCode;
      }
    }
  } catch (e) { /* fall through */ }

  // Strategy 3 (LAST RESORT): captnemo.in — CORS-enabled but has data quality issues
  // (has returned wrong fund data for some ISINs). Verify ISIN in response before using.
  try {
    const resp = await fetch(`${CAPTNEMO_BASE}/nav/${isin}`);
    if (resp.ok) {
      const data = await resp.json();
      // Verify the returned ISIN matches what we requested
      if (data?.ISIN && data.ISIN.trim().toUpperCase() !== isin.toUpperCase()) {
        throw new Error(
          `captnemo returned data for ${data.ISIN} instead of ${isin}. ` +
          `All sources failed — please enter NAV manually.`
        );
      }
      if (data?.historical_nav?.length) {
        const navHistory = data.historical_nav
          .map(([isoDate, nav]) => ({ isoDate, nav: parseFloat(nav) }))
          .sort((a, b) => b.isoDate.localeCompare(a.isoDate));
        navApiCache[`isin_${isin}`] = { meta: { scheme_name: data.name }, navHistory };
        isinSchemeCodeCache[isin] = `isin_${isin}`;
        return `isin_${isin}`;
      }
    }
  } catch (e) {
    console.warn('captnemo fallback failed:', e.message);
  }

  throw new Error(
    `Could not find NAV data for ISIN ${isin}. ` +
    `Verify the ISIN is correct, or enter NAV manually.`
  );
}

async function fetchNavHistory(schemeCodeOrKey) {
  if (navApiCache[schemeCodeOrKey]) return navApiCache[schemeCodeOrKey];

  // If it's a pseudo-key from captnemo (prefixed 'isin_'), should already be cached
  if (String(schemeCodeOrKey).startsWith('isin_')) {
    throw new Error('captnemo data should already be cached');
  }

  const resp = await fetch(`${MFAPI_BASE}/${schemeCodeOrKey}`);
  if (!resp.ok) throw new Error(`mfapi.in returned ${resp.status} for scheme ${schemeCodeOrKey}`);
  const data = await resp.json();
  if (data.status !== 'SUCCESS' || !data.data?.length) {
    throw new Error(`No NAV data for scheme ${schemeCodeOrKey}`);
  }

  const MONTHS = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                  Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  const navHistory = data.data.map(row => {
    const [dd, mmm, yyyy] = row.date.split('-');
    const isoDate = `${yyyy}-${MONTHS[mmm] || mmm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    return { isoDate, nav: parseFloat(row.nav) };
  }); // already newest-first from mfapi.in

  const result = { meta: data.meta, navHistory };
  navApiCache[schemeCodeOrKey] = result;
  return result;
}

function findNavOnOrBefore(history, isoDate) {
  // history is sorted newest-first — first entry where isoDate <= target
  for (const entry of history) {
    if (entry.isoDate <= isoDate) return entry;
  }
  return null;
}

async function fetchAndApplyNavs(fundId) {
  const fund = state.funds.find(f => f.id === fundId);
  if (!fund) return;
  if (!fund.isin || fund.isin.trim().length < 10) {
    showToast('Enter the fund ISIN first (e.g. INF179K01CR2)');
    return;
  }

  const statusEl = document.querySelector(`[data-nav-status="${fundId}"]`);
  const btnEl = document.querySelector(`[data-action="fetchNavs"][data-fund="${fundId}"]`);
  const setStatus = msg => { if (statusEl) statusEl.textContent = msg; };
  const setBtnText = txt => { if (btnEl) btnEl.textContent = txt; };

  setStatus('Looking up ISIN via mfdata.in…');
  setBtnText('⏳ Fetching…');

  try {
    // Step 1: ISIN → scheme code (mfdata.in primary, mfapi.in + captnemo fallbacks)
    const schemeCodeOrKey = await findSchemeCodeByIsin(fund.isin.trim());
    setStatus(`Found scheme — loading NAV history from mfapi.in…`);

    // Step 2: full NAV history (may already be cached from captnemo)
    const { meta, navHistory } = await fetchNavHistory(schemeCodeOrKey);

    // Step 3: start-of-year NAV = last trading day of (taxYear - 1)
    // Jan 1 is always a public holiday in India so we search for <= Dec 31 of prior year
    const startTarget = `${state.taxYear - 1}-12-31`;
    const endTarget   = `${state.taxYear}-12-31`;

    const startEntry = findNavOnOrBefore(navHistory, startTarget);
    const endEntry   = findNavOnOrBefore(navHistory, endTarget);

    if (!startEntry) throw new Error(
      `No NAV found on or before ${startTarget}. Did this fund exist in ${state.taxYear - 1}?`);
    if (!endEntry) throw new Error(
      `No NAV found on or before ${endTarget}. Is the ${state.taxYear} year-end data available?`);

    // Step 4: apply
    fund.navStart      = startEntry.nav;
    fund.navEnd        = endEntry.nav;
    fund.navStartDate  = startEntry.isoDate;
    fund.navEndDate    = endEntry.isoDate;
    fund.navSource     = 'amfi';
    fund.navSchemeCode = String(schemeCodeOrKey);
    fund.navSchemeName = meta?.scheme_name || '';

    renderFunds();
    saveToLocalStorage();

    const startNote = startEntry.isoDate !== startTarget
      ? ` (nearest prior trading day to 1 Jan ${state.taxYear})` : '';
    const endNote = endEntry.isoDate !== endTarget
      ? ` (nearest prior trading day to 31 Dec ${state.taxYear})` : '';

    showToast(`NAVs fetched: start ${startEntry.nav}${startNote} / end ${endEntry.nav}${endNote}`);

    // Also auto-trigger FX fetch for INR funds if not yet done
    if (!fund.fxRateYearEnd && fund.currency === 'INR') {
      fetchAndApplyFxRate(fundId);
    }

  } catch (err) {
    setStatus(`Could not fetch: ${err.message}`);
    setBtnText('⇩ Fetch NAVs');
    showToast(`NAV fetch failed: ${err.message}`);
  }
}

const addFundModal = document.getElementById('addFundModal');
document.getElementById('addFundBtn').addEventListener('click', () => {
  document.getElementById('newFundName').value = '';
  document.getElementById('newFundIsin').value = '';
  document.getElementById('newFundCurrency').value = 'INR';
  document.getElementById('newFundCustomCurrency').value = '';
  document.getElementById('customCurrencyField').style.display = 'none';
  addFundModal.classList.add('show');
  document.getElementById('newFundName').focus();
});
document.getElementById('newFundCurrency').addEventListener('change', (e) => {
  document.getElementById('customCurrencyField').style.display = e.target.value === 'OTHER' ? 'block' : 'none';
});
document.getElementById('cancelAddFundBtn').addEventListener('click', () => addFundModal.classList.remove('show'));
document.getElementById('confirmAddFundBtn').addEventListener('click', () => {
  const name = document.getElementById('newFundName').value.trim();
  if (!name) { showToast('Please enter a fund name'); return; }
  const currencySelect = document.getElementById('newFundCurrency').value;
  const fund = {
    id: nextId('f'),
    name,
    isin: document.getElementById('newFundIsin').value.trim(),
    currency: currencySelect,
    customCurrency: currencySelect === 'OTHER' ? document.getElementById('newFundCustomCurrency').value.trim().toUpperCase() : '',
    navStart: null, navEnd: null,
    navStartDate: null, navEndDate: null,
    navSource: null, navSchemeCode: null, navSchemeName: '',
    distributionsPerUnit: 0,
    teilfreistellungApplies: false,
    fxRateYearEnd: null, fxRateDate: null, fxRateSource: null,
    tranches: [{ id: nextId('t'), units: null, acquisitionMonth: null, label: 'Held since before ' + state.taxYear }],
  };
  state.funds.push(fund);
  addFundModal.classList.remove('show');
  renderFunds();
  saveToLocalStorage();
  if (currencySelect !== 'OTHER') fetchAndApplyFxRate(fund.id);
});

// ---------- Fund + tranche CRUD ----------
function addTranche(fundId) {
  const fund = state.funds.find(f => f.id === fundId);
  fund.tranches.push({ id: nextId('t'), units: null, acquisitionMonth: 1, label: '' });
  renderFunds();
  saveToLocalStorage();
}
function removeTranche(fundId, trancheId) {
  const fund = state.funds.find(f => f.id === fundId);
  fund.tranches = fund.tranches.filter(t => t.id !== trancheId);
  renderFunds();
  saveToLocalStorage();
}
function removeFund(fundId) {
  state.funds = state.funds.filter(f => f.id !== fundId);
  renderFunds();
  saveToLocalStorage();
}

// ---------- Calculation ----------
function computeFund(fund) {
  if (fund.navStart == null || fund.navEnd == null || !fund.fxRateYearEnd) return null;
  const validTranches = fund.tranches.filter(t => t.units != null && t.units > 0);
  if (validTranches.length === 0) return null;
  return calculateVorabpauschale(
    {
      navStart: fund.navStart,
      navEnd: fund.navEnd,
      distributionsPerUnit: fund.distributionsPerUnit || 0,
      basiszins: state.basiszins,
      teilfreistellungApplies: fund.teilfreistellungApplies,
      tranches: validTranches.map(t => ({ units: t.units, acquisitionMonth: t.acquisitionMonth })),
    },
    fund.fxRateYearEnd
  );
}

function recalcAll() {
  // Lightweight path: update only the COMPUTED/DERIVED numbers in the DOM
  // (VP per tranche, fund totals, months-held) without touching any <input>
  // elements. This is what runs on every keystroke, so it must never call
  // renderFunds()/innerHTML on a container that holds the field being typed
  // into — doing so recreates the input and the browser drops keyboard focus,
  // forcing the user to click back in after every character.
  state.funds.forEach(fund => {
    const result = computeFund(fund);

    const card = document.querySelector(`[data-fund-card="${fund.id}"]`);
    if (!card) return; // structural render hasn't happened yet for this fund

    const totalEl = card.querySelector('.fund-total');
    if (totalEl) totalEl.textContent = result ? `€${result.totalEUR.toFixed(2)}` : '—';

    card.classList.toggle('lost-value', !!(result && result.isCapped));
    const cappedPill = card.querySelector('[data-capped-pill]');
    if (cappedPill) cappedPill.style.display = (result && result.isCapped) ? 'inline' : 'none';

    const validTranches = fund.tranches.filter(t => t.units != null && t.units > 0);
    fund.tranches.forEach(tranche => {
      const trancheIdx = validTranches.findIndex(t => t.id === tranche.id);
      const trancheResult = (result && trancheIdx >= 0) ? result.tranches[trancheIdx] : null;
      const isOpening = tranche.acquisitionMonth == null;
      const monthsHeld = trancheResult ? trancheResult.monthsHeld : (isOpening ? 12 : (13 - (tranche.acquisitionMonth || 1)));
      const vpDisplay = trancheResult ? trancheResult.vpForTranche.toFixed(4) : '—';

      const monthsEl = card.querySelector(`[data-months-held="${tranche.id}"]`);
      if (monthsEl) monthsEl.textContent = `${monthsHeld}/12`;
      const vpEl = card.querySelector(`[data-vp-display="${tranche.id}"]`);
      if (vpEl) vpEl.textContent = vpDisplay;
    });
  });
}

// ---------- Rendering: funds (STRUCTURAL — rebuilds DOM, only call on
// add/remove fund or tranche, or other changes that alter which elements
// exist. Never call this from an input's keystroke handler.) ----------
function renderFunds() {
  const container = document.getElementById('fundsContainer');
  container.innerHTML = '';

  if (state.funds.length === 0) {
    container.innerHTML = `
      <div class="card empty-state">
        <div class="icon">&empty;</div>
        <div>No funds added yet. Click "+ Add a fund" to get started, or load a prior year's file.</div>
      </div>`;
    return;
  }

  state.funds.forEach(fund => {
    const result = computeFund(fund);
    const card = document.createElement('div');
    card.className = 'card fund-card' + (result && result.isCapped ? ' lost-value' : '');
    card.dataset.fundCard = fund.id;

    const totalDisplay = result ? `€${result.totalEUR.toFixed(2)}` : '—';
    const displayCurrency = fund.currency === 'OTHER' ? (fund.customCurrency || '???') : fund.currency;

    const fxStatusText = fund.fxRateYearEnd
      ? `1 EUR = ${fund.fxRateYearEnd.toFixed(4)} ${displayCurrency}${fund.fxRateSource === 'frankfurter' ? ` · rate dated ${fund.fxRateDate}${fund.fxRateDate !== `${state.taxYear}-12-31` ? ' (nearest trading day to 31 Dec)' : ''}` : ' · entered manually'}`
      : 'No rate yet';

    card.innerHTML = `
      <div class="fund-header">
        <h3>${escapeHtml(fund.name)} ${fund.isin ? `<span class="pill">${escapeHtml(fund.isin)}</span>` : ''}</h3>
        <div class="fund-total">${totalDisplay}</div>
      </div>
      <div class="fund-meta">${displayCurrency} <span data-capped-pill style="display:${result && result.isCapped ? 'inline' : 'none'};">&middot; <span class="pill warn">capped at Mehrbetrag</span></span></div>

      <div class="grid cols-2" style="margin-bottom:14px; align-items:end;">
        <div class="field">
          <label>Exchange rate, 31 Dec ${state.taxYear} (auto-fetched, ECB via Frankfurter)</label>
          <div style="font-family:'IBM Plex Mono',monospace; font-size:13px; padding:9px 10px; border:1px solid var(--line); border-radius:4px; background:var(--paper);" data-fx-status="${fund.id}">${fxStatusText}</div>
        </div>
        <div class="btn-row">
          <button class="btn small" data-action="fetchFx" data-fund="${fund.id}">${fund.fxRateYearEnd ? '↻ Re-fetch FX' : '⇩ Fetch FX rate'}</button>
          <details style="font-size:12px;">
            <summary style="cursor:pointer; padding:5px 8px; display:inline;">Enter manually</summary>
            <div class="content" style="padding:8px 0 0;">
              <input type="number" step="0.0001" placeholder="e.g. 93.0634" value="${fund.fxRateSource === 'manual' ? fund.fxRateYearEnd : ''}" data-fund="${fund.id}" data-field="fxRateManual" style="width:160px; display:inline-block;">
            </div>
          </details>
        </div>
      </div>

      ${fund.currency === 'INR' ? `
      <div class="grid cols-2" style="margin-bottom:14px; align-items:end; background:var(--mono-soft); border-radius:var(--radius); padding:12px 14px;">
        <div class="field">
          <label style="color:var(--mono);">Auto-fetch NAVs from AMFI via mfdata.in + mfapi.in (Indian MFs only)</label>
          <div style="font-family:'IBM Plex Mono',monospace; font-size:12.5px; padding:8px 10px; border:1px solid #b8d4c4; border-radius:4px; background:#fff;" data-nav-status="${fund.id}">
            ${fund.navSource === 'mfapi'
              ? `${fund.navSchemeName || 'Scheme ' + fund.navSchemeCode} · start: ${fund.navStart} (${fund.navStartDate}) · end: ${fund.navEnd} (${fund.navEndDate})`
              : fund.isin ? 'Click "Fetch NAVs" to auto-populate from AMFI data' : 'Enter ISIN above to enable auto-fetch'}
          </div>
        </div>
        <div class="btn-row">
          <button class="btn small" data-action="fetchNavs" data-fund="${fund.id}" ${!fund.isin ? 'disabled' : ''}>
            ${fund.navSource === 'mfapi' ? '↻ Re-fetch NAVs' : '⇩ Fetch NAVs'}
          </button>
          <span style="font-size:11.5px; color:var(--mono); font-family:monospace;">Free · AMFI-sourced · no key</span>
        </div>
      </div>` : ''}

      <div class="grid cols-3" style="margin-bottom:14px;">
        <div class="field">
          <label>NAV start of ${state.taxYear} — ${state.taxYear - 1} year-end (${displayCurrency})</label>
          <input type="number" step="0.0001" value="${fund.navStart ?? ''}" data-fund="${fund.id}" data-field="navStart">
          ${fund.navStartDate ? `<div class="helptext">Actual date: ${fund.navStartDate}${fund.navStartDate !== `${state.taxYear-1}-12-31` ? ' ← nearest prior trading day' : ''}</div>` : ''}
        </div>
        <div class="field">
          <label>NAV end of ${state.taxYear} — Dec 31 (${displayCurrency})</label>
          <input type="number" step="0.0001" value="${fund.navEnd ?? ''}" data-fund="${fund.id}" data-field="navEnd">
          ${fund.navEndDate ? `<div class="helptext">Actual date: ${fund.navEndDate}${fund.navEndDate !== `${state.taxYear}-12-31` ? ' ← nearest prior trading day' : ''}</div>` : ''}
        </div>
        <div class="field">
          <label>Distributions/unit (${displayCurrency})</label>
          <input type="number" step="0.0001" value="${fund.distributionsPerUnit ?? 0}" data-fund="${fund.id}" data-field="distributionsPerUnit">
        </div>
      </div>
      <div class="grid cols-2" style="margin-bottom:14px;">
        <div class="field">
          <label>Teilfreistellung 30%?</label>
          <select data-fund="${fund.id}" data-field="teilfreistellungApplies">
            <option value="false" ${!fund.teilfreistellungApplies ? 'selected' : ''}>No (default — verify first)</option>
            <option value="true" ${fund.teilfreistellungApplies ? 'selected' : ''}>Yes</option>
          </select>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Tranche</th><th class="num">Units</th><th>Acquired in ${state.taxYear}?</th><th>Month</th>
            <th class="num">Months held</th><th class="num">VP (${fund.currency})</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${fund.tranches.map((t, idx) => renderTrancheRow(fund, t, idx, result)).join('')}
        </tbody>
      </table>
      <div class="btn-row" style="margin-top:12px;">
        <button class="btn small" data-action="addTranche" data-fund="${fund.id}">+ Add tranche</button>
        <button class="btn small danger" data-action="removeFund" data-fund="${fund.id}" style="margin-left:auto;">Remove fund</button>
      </div>
    `;
    container.appendChild(card);
  });

  attachFundEventListeners();
}

function renderTrancheRow(fund, tranche, idx, result) {
  const isOpening = tranche.acquisitionMonth == null;
  const validTranches = fund.tranches.filter(t => t.units != null && t.units > 0);
  const trancheIdx = validTranches.findIndex(t => t.id === tranche.id);
  const trancheResult = (result && trancheIdx >= 0) ? result.tranches[trancheIdx] : null;
  const vpDisplay = trancheResult ? trancheResult.vpForTranche.toFixed(4) : '—';
  const monthsHeld = trancheResult ? trancheResult.monthsHeld : (isOpening ? 12 : (13 - (tranche.acquisitionMonth || 1)));

  return `
    <tr>
      <td><input type="text" placeholder="${idx === 0 ? 'e.g. Opening balance' : 'e.g. ' + MONTH_NAMES[(tranche.acquisitionMonth||1)-1] + ' SIP'}" value="${escapeHtml(tranche.label || '')}" data-fund="${fund.id}" data-tranche="${tranche.id}" data-field="label" style="font-size:12.5px; padding:5px 7px;"></td>
      <td class="num"><input type="number" step="0.001" value="${tranche.units ?? ''}" data-fund="${fund.id}" data-tranche="${tranche.id}" data-field="units" style="text-align:right; font-size:12.5px; padding:5px 7px;"></td>
      <td>
        <select data-fund="${fund.id}" data-tranche="${tranche.id}" data-field="acquiredThisYear" style="font-size:12.5px; padding:5px 7px;">
          <option value="no" ${isOpening ? 'selected' : ''}>No — held before</option>
          <option value="yes" ${!isOpening ? 'selected' : ''}>Yes</option>
        </select>
      </td>
      <td>
        ${isOpening ? '&mdash;' : `<select data-fund="${fund.id}" data-tranche="${tranche.id}" data-field="acquisitionMonth" style="font-size:12.5px; padding:5px 7px;">
          ${MONTH_NAMES.map((m, i) => `<option value="${i+1}" ${tranche.acquisitionMonth === i+1 ? 'selected' : ''}>${m}</option>`).join('')}
        </select>`}
      </td>
      <td class="num mono" data-months-held="${tranche.id}">${monthsHeld}/12</td>
      <td class="num mono vp" data-vp-display="${tranche.id}">${vpDisplay}</td>
      <td><button class="btn small danger" data-action="removeTranche" data-fund="${fund.id}" data-tranche="${tranche.id}">&times;</button></td>
    </tr>
  `;
}

function attachFundEventListeners() {
  document.querySelectorAll('[data-action="addTranche"]').forEach(btn =>
    btn.addEventListener('click', () => addTranche(btn.dataset.fund)));
  document.querySelectorAll('[data-action="removeTranche"]').forEach(btn =>
    btn.addEventListener('click', () => removeTranche(btn.dataset.fund, btn.dataset.tranche)));
  document.querySelectorAll('[data-action="removeFund"]').forEach(btn =>
    btn.addEventListener('click', () => removeFund(btn.dataset.fund)));
  document.querySelectorAll('[data-action="fetchFx"]').forEach(btn =>
    btn.addEventListener('click', () => fetchAndApplyFxRate(btn.dataset.fund)));
  document.querySelectorAll('[data-action="fetchNavs"]').forEach(btn =>
    btn.addEventListener('click', () => fetchAndApplyNavs(btn.dataset.fund)));

  document.querySelectorAll('[data-field="fxRateManual"]').forEach(input => {
    input.addEventListener('input', () => {
      const fund = state.funds.find(f => f.id === input.dataset.fund);
      const val = parseFloat(input.value);
      if (val && val > 0) {
        fund.fxRateYearEnd = val;
        fund.fxRateSource = 'manual';
        fund.fxRateDate = null;
        recalcAll();
        saveToLocalStorage();
      }
    });
  });

  document.querySelectorAll('input[data-fund][data-field]:not([data-tranche]):not([data-field="fxRateManual"]), select[data-fund][data-field]:not([data-tranche])').forEach(input => {
    input.addEventListener('input', () => {
      const fund = state.funds.find(f => f.id === input.dataset.fund);
      const field = input.dataset.field;
      if (field === 'teilfreistellungApplies') {
        fund[field] = input.value === 'true';
      } else {
        fund[field] = input.value === '' ? null : parseFloat(input.value);
      }
      recalcAll();
      saveToLocalStorage();
    });
  });

  document.querySelectorAll('[data-fund][data-tranche][data-field]').forEach(input => {
    input.addEventListener('input', () => {
      const fund = state.funds.find(f => f.id === input.dataset.fund);
      const tranche = fund.tranches.find(t => t.id === input.dataset.tranche);
      const field = input.dataset.field;
      if (field === 'units') {
        tranche.units = input.value === '' ? null : parseFloat(input.value);
      } else if (field === 'label') {
        tranche.label = input.value;
      } else if (field === 'acquisitionMonth') {
        tranche.acquisitionMonth = parseInt(input.value, 10);
      } else if (field === 'acquiredThisYear') {
        tranche.acquisitionMonth = input.value === 'yes' ? 1 : null;
        renderFunds(); // re-render to show/hide month dropdown
        return;
      }
      recalcAll();
      saveToLocalStorage();
    });
  });
}

// ---------- Sparerpauschbetrag settings ----------
const SPARER_LIMITS = { single: 1000, joint: 2000 };

function getSparerRemaining() {
  const filingType = document.getElementById('filingType')?.value || 'single';
  const limit = SPARER_LIMITS[filingType];
  const alreadyUsed = parseFloat(document.getElementById('sparerAlreadyUsed')?.value) || 0;
  return Math.max(0, limit - alreadyUsed);
}

function updateSparerRemainingDisplay() {
  const remaining = getSparerRemaining();
  const el = document.getElementById('sparerRemaining');
  if (el) el.textContent = `€${remaining.toFixed(2)}`;
}

// Wire up live updates when filing type or already-used changes
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('filingType')?.addEventListener('change', () => {
    updateSparerRemainingDisplay();
    renderSummary();
  });
  document.getElementById('sparerAlreadyUsed')?.addEventListener('input', () => {
    updateSparerRemainingDisplay();
    renderSummary();
  });
  // Foreign income fields — all use data-fi-category and data-fi-field attributes
  document.querySelectorAll('[data-fi-category][data-fi-field]').forEach(input => {
    input.addEventListener('input', () => {
      const cat = input.dataset.fiCategory;
      const field = input.dataset.fiField;
      if (!state.foreignIncome[cat]) return;
      state.foreignIncome[cat][field] = parseFloat(input.value) || 0;
      renderSummary();
      saveToLocalStorage();
    });
  });
});

// ---------- Foreign income totals ----------
function getForeignIncomeTotals() {
  const fi = state.foreignIncome;

  // Net stock result: gains minus losses, floored at 0 for Sparer purposes
  // (losses can only offset gains from the same §20 Abs.2 category, not interest/dividends)
  const stockNet = Math.max(0, (fi.stockGains.amount || 0) - (fi.stockLosses.amount || 0));

  // Total foreign Kapitalerträge that count against Sparerpauschbetrag
  const totalForeignIncome =
    (fi.nreInterest.amount || 0) +
    (fi.nroInterest.amount || 0) +
    (fi.dividends.amount || 0) +
    stockNet +
    (fi.otherInterest.amount || 0) +
    (fi.otherDividends.amount || 0);

  // Total creditable foreign tax (TDS), capped per DBA at 10% of the gross amount per category
  // NRE has no TDS so no credit. Stock gains TDS treatment is more complex; we note this.
  const totalCreditable =
    Math.min(fi.nroInterest.tds || 0,    (fi.nroInterest.amount || 0)    * 0.10) +
    Math.min(fi.dividends.tds || 0,      (fi.dividends.amount || 0)      * 0.10) +
    Math.min(fi.stockGains.tds || 0,     (fi.stockGains.amount || 0)     * 0.10) +
    Math.min(fi.otherInterest.tds || 0,  (fi.otherInterest.amount || 0)  * 0.10) +
    Math.min(fi.otherDividends.tds || 0, (fi.otherDividends.amount || 0) * 0.10);

  return { totalForeignIncome, stockNet, totalCreditable };
}

// ---------- Summary view ----------
function renderSummary() {
  const tbody = document.querySelector('#summaryTable tbody');
  if (tbody) tbody.innerHTML = '';

  let grandTotalEUR = 0;
  let grandTotalTaxable = 0;
  let grandTeilfreistellungReduction = 0;

  state.funds.forEach(fund => {
    const result = computeFund(fund);
    if (!result) return;

    const teilfreiReduction = result.totalEUR - result.taxableEUR;
    grandTotalEUR += result.totalEUR;
    grandTotalTaxable += result.taxableEUR;
    grandTeilfreistellungReduction += teilfreiReduction;

    if (tbody) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(fund.name)}</td>
        <td class="num mono">${result.totalNativeCurrency.toFixed(2)} ${fund.currency === 'OTHER' ? (fund.customCurrency || '?') : fund.currency}</td>
        <td class="num mono">€${result.totalEUR.toFixed(2)}</td>
        <td class="num mono">${result.teilfreistellungApplies ? `−€${teilfreiReduction.toFixed(2)} (30%)` : '—'}</td>
        <td class="num mono">€${result.taxableEUR.toFixed(2)}</td>
      `;
      tbody.appendChild(tr);
    }
  });

  // Add other foreign income to the total taxable pool
  const { totalForeignIncome, stockNet, totalCreditable } = getForeignIncomeTotals();
  const totalAllTaxable = grandTotalTaxable + totalForeignIncome;

  // Sparerpauschbetrag: offset across ALL capital income, Vorabpauschale first then others
  const sparerRemaining = getSparerRemaining();
  const sparerOffset = Math.min(sparerRemaining, totalAllTaxable);
  const taxableExcess = Math.max(0, totalAllTaxable - sparerRemaining);
  const kest = taxableExcess * 0.25;
  const soli = kest * 0.055;
  const totalTaxBeforeCredit = kest + soli;
  const totalTax = Math.max(0, totalTaxBeforeCredit - totalCreditable);

  // Update summary bar
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('grandTotalEUR', `€${grandTotalEUR.toFixed(2)}`);
  set('grandTotalTaxable', `€${totalAllTaxable.toFixed(2)}`);
  set('taxableExcess', `€${taxableExcess.toFixed(2)}`);
  set('estimatedTax', `€${totalTax.toFixed(2)}`);
  updateSparerRemainingDisplay();

  // Update step-by-step table
  set('calc-gross', `€${grandTotalEUR.toFixed(2)}`);
  set('calc-teilfrei', `−€${grandTeilfreistellungReduction.toFixed(2)}`);
  set('calc-taxable-vp', `€${grandTotalTaxable.toFixed(2)}`);
  set('calc-foreign-income', `€${totalForeignIncome.toFixed(2)}`);
  set('calc-total-all', `€${totalAllTaxable.toFixed(2)}`);
  set('calc-sparer', `−€${sparerOffset.toFixed(2)}`);
  set('calc-excess', `€${taxableExcess.toFixed(2)}`);
  set('calc-kest', `€${kest.toFixed(2)}`);
  set('calc-soli', `€${soli.toFixed(2)}`);
  set('calc-creditable', `−€${totalCreditable.toFixed(2)}`);
  set('calc-total-tax', `€${totalTax.toFixed(2)}`);

  // Colour the excess row
  const excessRow = document.querySelector('#taxCalcTable tr[data-row="excess"]');
  if (excessRow) excessRow.style.color = taxableExcess > 0 ? 'var(--danger)' : 'var(--mono)';
}

// ---------- JSON export / import ----------
document.getElementById('exportJsonBtn').addEventListener('click', () => {
  const dataStr = JSON.stringify(state, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vorabpauschale_${state.taxYear}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported. Keep this file safe for next year.');
});

document.getElementById('importJsonBtn').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('loadPriorYearBtn').addEventListener('click', () => document.getElementById('fileInput').click());

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (!imported.funds) throw new Error('Not a valid Vorabpauschale file');

      // Roll forward: advance the year, carry over fund identities, but reset
      // each fund's tranches to a single "opening balance" using the closing
      // unit count implied by the prior year's tranches, and clear NAVs/distributions
      // so the user enters this year's fresh values rather than silently reusing old NAVs.
      const priorTotalUnitsByFund = {};
      imported.funds.forEach(f => {
        priorTotalUnitsByFund[f.id] = f.tranches.reduce((sum, t) => sum + (t.units || 0), 0);
      });

      const newYear = (imported.taxYear || new Date().getFullYear() - 1) + 1;

      state = {
        taxYear: newYear,
        basiszins: BASISZINS_BY_YEAR[newYear] !== undefined ? BASISZINS_BY_YEAR[newYear] : imported.basiszins,
        funds: imported.funds.map(f => ({
          id: f.id, name: f.name, isin: f.isin,
          currency: f.currency, customCurrency: f.customCurrency || '',
          navStart: f.navEnd ?? null,   // prior year-end → this year's start
          navEnd: null,
          navStartDate: f.navEndDate ?? null,
          navEndDate: null,
          navSource: f.navEnd ? 'rolled-forward' : null,
          navSchemeCode: f.navSchemeCode ?? null,  // carry forward for re-fetch
          navSchemeName: f.navSchemeName ?? '',
          distributionsPerUnit: 0,
          teilfreistellungApplies: f.teilfreistellungApplies || false,
          fxRateYearEnd: null, fxRateDate: null, fxRateSource: null,
          tranches: [{
            id: nextId('t'),
            units: priorTotalUnitsByFund[f.id] || null,
            acquisitionMonth: null,
            label: `Held since before ${newYear} (rolled forward)`,
          }],
        })),
      };
      populateTaxYearDropdown();
      document.getElementById('basiszins').value = (state.basiszins * 100).toFixed(4);
      renderFunds();
      saveToLocalStorage();
      showToast(`Loaded ${imported.funds.length} fund(s), rolled forward to ${state.taxYear}. Fetch this year's FX rate, add SIP tranches, and enter year-end NAVs.`);
    } catch (err) {
      showToast('Could not read that file — is it a Vorabpauschale export?');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ---------- Google Drive (stub — wires up once a Google Cloud OAuth client ID is configured) ----------
document.getElementById('driveConnectBtn').addEventListener('click', () => {
  const status = document.getElementById('driveStatus');
  status.innerHTML = `Google Drive sync needs a one-time setup: a Google Cloud project with the
    Drive API enabled and an OAuth client ID. See the README for setup steps. Until then, use
    JSON export/import above — it works fully offline and is portable to Drive, Dropbox, or
    anywhere else you like (e.g. just drop the exported file into a Drive folder yourself).`;
});

// ---------- Utility ----------
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Disclaimer banner ----------
(function initDisclaimer() {
  const banner = document.getElementById('disclaimerBanner');
  const dismissBtn = document.getElementById('dismissDisclaimer');
  if (localStorage.getItem('vorabpauschale_disclaimer_dismissed') === 'true') {
    banner.classList.add('hidden');
  }
  dismissBtn.addEventListener('click', () => {
    banner.classList.add('hidden');
    try { localStorage.setItem('vorabpauschale_disclaimer_dismissed', 'true'); } catch (e) {}
  });
})();

// ---------- Init ----------
loadFromLocalStorage();
populateTaxYearDropdown();
document.getElementById('basiszins').value = (state.basiszins * 100).toFixed(4);
renderFunds();
