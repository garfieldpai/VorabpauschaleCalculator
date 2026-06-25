/**
 * Vorabpauschale Rechner — Application Logic
 *
 * State shape:
 * {
 *   taxYear: 2024,
 *   basiszins: 0.0229,
 *   fxRateYearEnd: 93.0634,
 *   funds: [
 *     {
 *       id: 'f1', name: 'HDFC Mid-Cap...', isin: 'INF179K01CR2', currency: 'INR',
 *       navStart: 192.4350, navEnd: 203.7350, distributionsPerUnit: 0,
 *       teilfreistellungApplies: false,
 *       tranches: [ { id: 't1', units: 4235.489, acquisitionMonth: null, label: 'Held since before 2024' }, ... ]
 *     }
 *   ]
 * }
 */

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let state = {
  taxYear: new Date().getFullYear() - 1,
  basiszins: BASISZINS_BY_YEAR[new Date().getFullYear() - 1] || 0.0229,
  fxRateYearEnd: null,
  funds: [],
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
document.getElementById('fxRate').addEventListener('input', (e) => {
  state.fxRateYearEnd = parseFloat(e.target.value) || null;
  recalcAll();
  saveToLocalStorage();
});

// ---------- Add fund modal ----------
const addFundModal = document.getElementById('addFundModal');
document.getElementById('addFundBtn').addEventListener('click', () => {
  document.getElementById('newFundName').value = '';
  document.getElementById('newFundIsin').value = '';
  addFundModal.classList.add('show');
  document.getElementById('newFundName').focus();
});
document.getElementById('cancelAddFundBtn').addEventListener('click', () => addFundModal.classList.remove('show'));
document.getElementById('confirmAddFundBtn').addEventListener('click', () => {
  const name = document.getElementById('newFundName').value.trim();
  if (!name) { showToast('Please enter a fund name'); return; }
  const fund = {
    id: nextId('f'),
    name,
    isin: document.getElementById('newFundIsin').value.trim(),
    currency: document.getElementById('newFundCurrency').value,
    navStart: null,
    navEnd: null,
    distributionsPerUnit: 0,
    teilfreistellungApplies: false,
    tranches: [{ id: nextId('t'), units: null, acquisitionMonth: null, label: 'Held since before ' + state.taxYear }],
  };
  state.funds.push(fund);
  addFundModal.classList.remove('show');
  renderFunds();
  saveToLocalStorage();
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
  if (fund.navStart == null || fund.navEnd == null || !state.fxRateYearEnd) return null;
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
    state.fxRateYearEnd
  );
}

function recalcAll() {
  renderFunds();
}

// ---------- Rendering: funds ----------
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

    const totalDisplay = result ? `€${result.totalEUR.toFixed(2)}` : '—';

    card.innerHTML = `
      <div class="fund-header">
        <h3>${escapeHtml(fund.name)} ${fund.isin ? `<span class="pill">${escapeHtml(fund.isin)}</span>` : ''}</h3>
        <div class="fund-total">${totalDisplay}</div>
      </div>
      <div class="fund-meta">${fund.currency}${result && result.isCapped ? ' &middot; <span class="pill warn">capped at Mehrbetrag</span>' : ''}</div>

      <div class="grid cols-4" style="margin-bottom:14px;">
        <div class="field">
          <label>NAV start of ${state.taxYear} (${fund.currency})</label>
          <input type="number" step="0.0001" value="${fund.navStart ?? ''}" data-fund="${fund.id}" data-field="navStart">
        </div>
        <div class="field">
          <label>NAV end of ${state.taxYear} (${fund.currency})</label>
          <input type="number" step="0.0001" value="${fund.navEnd ?? ''}" data-fund="${fund.id}" data-field="navEnd">
        </div>
        <div class="field">
          <label>Distributions/unit (${fund.currency})</label>
          <input type="number" step="0.0001" value="${fund.distributionsPerUnit ?? 0}" data-fund="${fund.id}" data-field="distributionsPerUnit">
        </div>
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
      <td class="num mono">${monthsHeld}/12</td>
      <td class="num mono vp">${vpDisplay}</td>
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

  document.querySelectorAll('input[data-fund][data-field]:not([data-tranche]), select[data-fund][data-field]:not([data-tranche])').forEach(input => {
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

// ---------- Summary view ----------
function renderSummary() {
  const tbody = document.querySelector('#summaryTable tbody');
  tbody.innerHTML = '';
  let grandTotalEUR = 0;
  let grandTotalTaxable = 0;

  state.funds.forEach(fund => {
    const result = computeFund(fund);
    if (!result) return;
    grandTotalEUR += result.totalEUR;
    grandTotalTaxable += result.taxableEUR;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(fund.name)}</td>
      <td class="num mono">${result.totalNativeCurrency.toFixed(2)} ${fund.currency}</td>
      <td class="num mono">€${result.totalEUR.toFixed(2)}</td>
      <td class="num mono">€${result.taxableEUR.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('grandTotalEUR').textContent = `€${grandTotalEUR.toFixed(2)}`;
  document.getElementById('grandTotalTaxable').textContent = `€${grandTotalTaxable.toFixed(2)}`;
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
        fxRateYearEnd: null,
        funds: imported.funds.map(f => ({
          id: f.id,
          name: f.name,
          isin: f.isin,
          currency: f.currency,
          navStart: f.navEnd ?? null, // last year's year-end NAV becomes this year's start NAV
          navEnd: null,
          distributionsPerUnit: 0,
          teilfreistellungApplies: f.teilfreistellungApplies || false,
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
      document.getElementById('fxRate').value = '';
      renderFunds();
      saveToLocalStorage();
      showToast(`Loaded ${imported.funds.length} fund(s), rolled forward to ${state.taxYear}. Add this year's SIP tranches and enter year-end NAVs.`);
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
if (state.fxRateYearEnd) document.getElementById('fxRate').value = state.fxRateYearEnd;
renderFunds();
