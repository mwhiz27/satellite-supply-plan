/* Satellite Supply Plan: UI layer. All math lives in engine.js.
   Every view shows both scenarios: Guaranteed (G) and Guaranteed + Planned (GP). */
(function () {
  const D = window.CASE_DATA;
  const E = window.SupplyEngine;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const months = D.months;
  const satTypes = Object.keys(D.sats);
  const supplierNames = D.suppliers.map(s => s.name);
  const QUAL_LEAD = 6; // assumed qualification lead time (months) for recommended actions

  // Excel base-case results, used to show the app reconciles to the model
  const EXCEL = {
    base: { g: { gap: 46969.2, short: 1220 }, gp: { gap: 12528.5, short: 702 } },
    stock: { g: { gap: 45483.9, short: 1118 }, gp: { gap: 10651.1, short: 465 } }
  };

  const COLORS = {
    ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835',
    g: '#d95926', gp: '#3987e5', // validated dark categorical pair (orange / blue)
    gap: '#d03b3b', surface: '#0b0b0c',
    sats: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']
  };
  const satColor = Object.fromEntries(satTypes.map((t, i) => [t, COLORS.sats[i]]));

  // ---------- state ----------
  let st = E.defaultSettings(D);
  const applied = new Set();
  let heatMetric = 'gapHrs';
  let auditScn = 'gp';
  let tableTab = 'sku';
  let selected = null; // {i: sku index, t: month index}
  let jumpFrom = null;  // {sel, offset, label}: the element clicked and where it sat on screen
  let Rg, Rgp, recResults;
  const RS = () => ({ g: Rg, gp: Rgp });

  const clone = o => JSON.parse(JSON.stringify(o));
  const fmt = (n, d = 0) => (Math.abs(n) < 1e-9 ? 0 : n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = n => (n * 100).toFixed(1) + '%';
  const mLabel = m => { const [y, mo] = m.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+mo - 1] + '-' + y.slice(2); };
  const shortSup = n => n.replace(' Manufacturing', '').replace(' Industries', '').replace(' Components', '').replace(' Precision', '').replace(' Co.', '');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sw = k => `<i class="sw ${k === 'g' ? 'g' : 'p'}"></i>`;
  const sum = a => a.reduce((x, y) => x + y, 0);

  // ---------- recommendations ----------
  function addQual(s, supplier, skus, from) {
    skus.forEach(sku => {
      const base = D.skus.find(x => x.id === sku);
      if (base.suppliers.includes(supplier)) return;
      const ex = s.extraQual.find(q => q.sku === sku && q.supplier === supplier);
      if (ex) ex.from = Math.min(ex.from, from); else s.extraQual.push({ sku, supplier, from });
    });
  }
  const RECS = [
    {
      id: 'bluegate', title: 'Qualify Bluegate Works for Type B SKUs 7, 8 and 15',
      owner: 'Alex Rivera (Bluegate) with Priya Natarajan and Mei Tanaka', when: 'Start now · live Jul-73',
      what: 'Bluegate owns two Type B machines, M11 (size 300) and M12 (size 200), but none of its SKUs are Type B, so the model can never use them. SKUs 7 and 8 rely on Cobalt Ridge\'s two Type B machines, and SKU 15 on a single Silverpine machine.',
      why: 'Uses capacity we already have access to. These three SKUs are the main reason whole satellites fail, and every satellite type uses at least one of them.',
      apply: s => addQual(s, 'Bluegate Works', [7, 8, 15], QUAL_LEAD)
    },
    {
      id: 'buildahead', title: 'Allow building ahead (stockpiling)',
      owner: 'Supply planning with all buyers', when: 'Now',
      what: 'Use spare machine hours in early months to build SKUs ahead of future gaps, and hold them until a satellite needs them. This is the Excel\'s stockpiling scenario. No supplier terms change, only when we reserve hours and how much inventory we carry.',
      why: 'The biggest lever once Bluegate is qualified: its spare early-month hours build Type B parts ahead of the 1974 ramp. Costs inventory carrying and early reservations. Directional: the model\'s build-ahead mix is a simple heuristic, so the real upside is likely larger.',
      apply: s => { s.stockpile = true; }
    },
    {
      id: 'silverpine', title: 'Add a second shift at Silverpine (12 → 24 hrs/day)',
      owner: 'Mei Tanaka', when: 'Immediately',
      what: 'Silverpine runs its machines only 12 hours a day, the shortest of any supplier. It is the only source for SKU 13 and the main source for SKU 15.',
      why: 'Protects the guaranteed-only case: it closes much of what build-ahead leaves when planned machines don\'t arrive.',
      apply: s => { s.sup['Silverpine Components'].uptime = Math.max(s.sup['Silverpine Components'].uptime, 24); }
    }
  ];
  // Levers tested on top of the recommended stack that don't move satellites (shown live, not stacked)
  const ALTS = [
    { name: 'Weekend shifts at Cobalt Ridge (20 → 30 days)', owner: 'Priya Natarajan', reason: 'More Type B hours, but once Bluegate makes SKUs 7, 8 and 15 they no longer limit satellites.',
      apply: s => { s.sup['Cobalt Ridge Manufacturing'].days = Math.max(s.sup['Cobalt Ridge Manufacturing'].days, 30); } },
    { name: 'Weekend shifts at Northwind Precision (22 → 30 days)', owner: 'Alex Rivera', reason: 'Northwind\'s extra hours go to SKUs 1, 2, 3 and 18, which no longer limit satellites once the actions above land.',
      apply: s => { s.sup['Northwind Precision'].days = Math.max(s.sup['Northwind Precision'].days, 30); } },
    { name: 'Qualify Redwood Forge for SKUs 3 and 9', owner: 'Jordan Blake', reason: 'Redwood\'s Type B 300 machines are already busy with SKUs 16 and 17.',
      apply: s => addQual(s, 'Redwood Forge Co.', [3, 9], QUAL_LEAD) }
  ];

  function effectiveSettings() {
    const s = clone(st);
    RECS.forEach(r => { if (applied.has(r.id)) r.apply(s); });
    return s;
  }
  const runScn = (s, gp) => E.run(D, { ...clone(s), includePlanned: gp });

  // ---------- compute ----------
  function compute() {
    const s = effectiveSettings();
    Rg = runScn(s, false);
    Rgp = runScn(s, true);
    // Stacked recommendation impacts on the user's assumptions (not on applied recs), both scenarios
    let cur = clone(st);
    let prev = { g: runScn(cur, false).totals, gp: runScn(cur, true).totals };
    const start = prev;
    recResults = RECS.map(r => {
      const next = clone(cur); r.apply(next);
      const res = { g: runScn(next, false).totals, gp: runScn(next, true).totals };
      const out = {
        dShort: { g: res.g.satsShort - prev.g.satsShort, gp: res.gp.satsShort - prev.gp.satsShort },
        dGap: { g: res.g.gap - prev.g.gap, gp: res.gp.gap - prev.gp.gap }
      };
      cur = next; prev = res;
      return out;
    });
    recResults.start = start; recResults.end = prev;
    recResults.alts = ALTS.map(a => {
      const next = clone(cur); a.apply(next);
      const g = runScn(next, false).totals, gp = runScn(next, true).totals;
      return { dShort: { g: g.satsShort - prev.g.satsShort, gp: gp.satsShort - prev.gp.satsShort }, dGap: { g: g.gap - prev.g.gap, gp: gp.gap - prev.gp.gap } };
    });
    // Planned-capacity risk (protect action)
    const slip = E.run(D, { ...clone(s), includePlanned: true, plannedSlip: s.plannedSlip + 3 });
    let worst = null;
    D.machines.filter(m => m.turnOn !== 'Yes').forEach(m => {
      if (s.machinesOff.includes(m.id)) return;
      const r = E.run(D, { ...clone(s), includePlanned: true, machinesOff: [...s.machinesOff, m.id] });
      const d = r.totals.satsShort - Rgp.totals.satsShort;
      if (!worst || d > worst.d) worst = { m, d };
    });
    recResults.risk = { slip: slip.totals.satsShort - Rgp.totals.satsShort, slipGap: slip.totals.gap - Rgp.totals.gap, worst,
      plannedValue: Rg.totals.satsShort - Rgp.totals.satsShort };
  }

  function isBaseCase() {
    return JSON.stringify({ ...E.defaultSettings(D), stockpile: st.stockpile }) === JSON.stringify(st) && applied.size === 0;
  }
  function changeCount() {
    const d = E.defaultSettings(D); let n = 0;
    if (JSON.stringify(d.priority) !== JSON.stringify(st.priority)) n++;
    Object.keys(d.sku).forEach(k => { if (JSON.stringify(d.sku[k]) !== JSON.stringify(st.sku[k])) n++; });
    Object.keys(d.sup).forEach(k => { if (JSON.stringify(d.sup[k]) !== JSON.stringify(st.sup[k])) n++; });
    if (st.plannedSlip) n++;
    if (st.launchScale !== 1) n++;
    if (st.yieldPct !== 1) n++;
    return n + st.machinesOff.length + st.extraQual.length + st.extraMachines.length + applied.size;
  }

  // ---------- hero ----------
  function renderHero() {
    const G = Rg.totals, P = Rgp.totals;
    const firstG = Rg.monthly.gap.findIndex(g => g > 1e-4), firstP = Rgp.monthly.gap.findIndex(g => g > 1e-4);
    const byType = {};
    Rgp.skuTotals.forEach(x => { byType[x.type] = (byType[x.type] || 0) + x.gap; });
    const topType = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
    if (P.satsShort > 0) {
      $('#heroHeadline').innerHTML = `Even with planned capacity, <em>${fmt(P.satsShort)}</em> of ${fmt(P.satsPlan)} satellites can't be built`;
      $('#heroSub').innerHTML = `Guaranteed machines alone leave <strong>${fmt(G.satsShort)}</strong> short (${pct(G.satsShort / G.satsPlan)} of plan). Planned turn-ons lift demand coverage from <strong>${pct(G.coverage)}</strong> to <strong>${pct(P.coverage)}</strong>, but ${P.skusShort} of 20 SKUs still run short. ${topType[0]} machines carry ${Math.round(topType[1] / P.gap * 100)}% of the remaining gap.${st.stockpile ? ` Includes building ahead with spare hours (${fmt(P.buildAhead)} hrs with planned).` : ''}`;
    } else if (G.satsShort > 0) {
      $('#heroHeadline').innerHTML = `Every satellite can be built, but only if planned capacity arrives`;
      $('#heroSub').innerHTML = `With guaranteed machines alone, <strong>${fmt(G.satsShort)}</strong> of ${fmt(G.satsPlan)} satellites are short.`;
    } else {
      $('#heroHeadline').innerHTML = `Supply covers the full launch plan`;
      $('#heroSub').textContent = `Guaranteed machines alone meet every satellite's SKU needs under the current assumptions.`;
    }
    const pair = (g, p) => `<div class="pair"><div>${sw('g')}<span class="v">${g}</span><span class="t">guaranteed</span></div><div>${sw('gp')}<span class="v">${p}</span><span class="t">+ planned</span></div></div>`;
    const kpis = [
      ['Machine-hr demand', `<div class="v">${fmt(G.demand)}</div><div class="s">${fmt(G.satsPlan)} satellites · 24 months</div>`],
      ['Gap (machine hrs)', pair(fmt(G.gap), fmt(P.gap))],
      ['Demand covered', pair(pct(G.coverage), pct(P.coverage))],
      ['Satellites short', pair(fmt(G.satsShort), fmt(P.satsShort))],
      ['SKUs short (of 20)', pair(G.skusShort, P.skusShort)],
      ['Machines to add', pair(fmt(G.machinesToAdd), fmt(P.machinesToAdd))]
    ];
    $('#kpis').innerHTML = kpis.map(k => `<div class="kpi"><div class="l">${k[0]}</div>${k[1]}</div>`).join('');
    $('#heroMode').textContent = st.stockpile ? 'Build-ahead allowed (directional)' : 'No build-ahead (base case)';
    $$('[data-sp]').forEach(b => b.classList.toggle('on', (b.dataset.sp === 'on') === st.stockpile));

    const d = { ...E.defaultSettings(D), stockpile: st.stockpile };
    const xg = runScn(d, false).totals, xgp = runScn(d, true).totals, x = EXCEL[st.stockpile ? 'stock' : 'base'];
    const recon = Math.abs(xg.gap - x.g.gap) < 0.05 && Math.abs(xgp.gap - x.gp.gap) < 0.05 && xg.satsShort === x.g.short && xgp.satsShort === x.gp.short;
    const mode = st.stockpile ? 'stockpiling allowed, directional' : 'no stockpiling';
    const reconTxt = recon ? `<span class="ok">✓ Reconciles to the Excel model (${mode})</span>` : '<span class="mod">⚠ Base case does not match Excel</span>';
    const n = changeCount();
    $('#statusline').innerHTML = isBaseCase()
      ? `${reconTxt} &middot; Excel case shown`
      : `${reconTxt} &middot; <span class="mod">● Modified scenario: ${n} change${n === 1 ? '' : 's'} from base</span> &middot; <a href="#assumptions">review</a>`;
  }

  // ---------- charts ----------
  Chart.defaults.color = COLORS.muted;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;
  Chart.defaults.animation = false;
  const tooltipStyle = {
    backgroundColor: '#000', borderColor: 'rgba(255,255,255,0.6)', borderWidth: 1, cornerRadius: 0,
    titleColor: COLORS.ink, bodyColor: COLORS.ink2, footerColor: COLORS.muted, padding: 10, boxPadding: 4
  };
  const axis = (extra = {}) => ({
    grid: { color: COLORS.grid, drawTicks: false }, border: { color: COLORS.axis },
    ticks: { padding: 8, color: COLORS.muted }, ...extra
  });
  const xMonths = axis({ grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12, color: COLORS.muted } });
  const kTicks = { callback: v => (v >= 1000 ? fmt(v / 1000) + 'k' : fmt(v)), color: COLORS.muted };
  const charts = {};

  const legendHTML = items => items.map(([c, l, line]) => `<span><i class="${line ? 'line' : ''}" style="background:${c}"></i>${l}</span>`).join('');
  const scnLegend = legendHTML([[COLORS.g, 'Guaranteed'], [COLORS.gp, 'Guaranteed + planned']]);
  const vbar = (label, color) => ({ type: 'bar', label, data: [], backgroundColor: color, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom' });
  const hbarDs = (label, color) => ({ label, data: [], backgroundColor: color, borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'start', maxBarThickness: 12 });

  function initCharts() {
    charts.cap = new Chart($('#chartCap'), {
      type: 'line',
      data: { labels: months.map(mLabel), datasets: [
        { label: 'Demand', data: [], borderColor: COLORS.ink, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
        { label: 'Capacity: guaranteed', data: [], borderColor: COLORS.g, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, stepped: 'middle' },
        { label: 'Capacity: + planned', data: [], borderColor: COLORS.gp, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, stepped: 'middle' }
      ] },
      options: {
        maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y)} hrs` } } },
        scales: { x: xMonths, y: axis({ beginAtZero: true, ticks: kTicks }) }
      }
    });
    $('#legendCap').innerHTML = legendHTML([[COLORS.ink, 'Demand', true], [COLORS.g, 'Capacity: guaranteed', true], [COLORS.gp, 'Capacity: + planned', true]]);

    const groupedMonthly = (el, unit, footer) => new Chart($(el), {
      type: 'bar',
      data: { labels: months.map(mLabel), datasets: [vbar('Guaranteed', COLORS.g), vbar('+ Planned', COLORS.gp)] },
      options: {
        maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        datasets: { bar: { categoryPercentage: 0.78, barPercentage: 0.88 } },
        plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y)} ${unit}`, footer } } },
        scales: { x: xMonths, y: axis({ min: 0, ticks: { ...kTicks, precision: 0 } }) }
      }
    });
    charts.gap = groupedMonthly('#chartGap', 'hrs short', items => {
      const t = items[0].dataIndex;
      return `Demand ${fmt(Rg.monthly.demand[t])} hrs · covered ${pct(Rg.monthly.delivered[t] / Rg.monthly.demand[t])} / ${pct(Rgp.monthly.delivered[t] / Rgp.monthly.demand[t])}`;
    });
    charts.sats = groupedMonthly('#chartSats', 'satellites short', items => {
      const t = items[0].dataIndex;
      const types = k => satTypes.filter(ty => RS()[k].short[ty][t] > 0).map(ty => `${ty} ${RS()[k].short[ty][t]}`).join(', ') || 'none';
      return [`Planned launches: ${fmt(Rg.monthly.satsPlan[t])}`, `Guaranteed short: ${types('g')}`, `+ Planned short: ${types('gp')}`];
    });
    $('#legendGap').innerHTML = scnLegend;
    $('#legendSats').innerHTML = scnLegend;
    $$('.legend-scn').forEach(el => { el.innerHTML = scnLegend; });

    const hbar = (el, onClick) => new Chart($(el), {
      type: 'bar',
      data: { labels: [], datasets: [hbarDs('Guaranteed', COLORS.g), hbarDs('+ Planned', COLORS.gp)] },
      options: {
        indexAxis: 'y', maintainAspectRatio: false, interaction: { mode: 'index', intersect: false, axis: 'y' },
        datasets: { bar: { categoryPercentage: 0.8, barPercentage: 0.9 } },
        plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.parsed.x)} hrs short` } } },
        scales: { x: axis({ min: 0, ticks: kTicks }), y: axis({ grid: { display: false }, ticks: { color: COLORS.ink2, autoSkip: false } }) },
        onClick, onHover: (e, el) => { e.native.target.style.cursor = onClick && el.length ? 'pointer' : 'default'; }
      }
    });
    charts.sku = hbar('#chartSku', (e, els) => {
      if (!els.length) return;
      const id = charts.sku.$ids[els[0].index];
      const i = Rgp.skus.findIndex(s => s.id === id);
      openSku(i, null, 'Gap by SKU', '#skuPanel');
    });
    charts.supplier = hbar('#chartSupplier');
    charts.buyer = hbar('#chartBuyer');
  }

  function renderCharts() {
    const cap = charts.cap.data.datasets;
    cap[0].data = Rg.monthly.demand; cap[1].data = Rg.monthly.capacity; cap[2].data = Rgp.monthly.capacity;
    charts.cap.update();
    const pos = a => a.map(v => Math.max(0, v)); // float noise can leave -1e-12 gaps
    charts.gap.data.datasets[0].data = pos(Rg.monthly.gap); charts.gap.data.datasets[1].data = pos(Rgp.monthly.gap);
    charts.gap.update();
    charts.sats.data.datasets[0].data = Rg.monthly.satsShort; charts.sats.data.datasets[1].data = Rgp.monthly.satsShort;
    charts.sats.update();

    const gpById = Object.fromEntries(Rgp.skuTotals.map(r => [r.id, r]));
    const skuRows = [...Rg.skuTotals].sort((a, b) => gpById[b.id].gap - gpById[a.id].gap || b.gap - a.gap || a.id - b.id);
    charts.sku.$ids = skuRows.map(r => r.id);
    charts.sku.data.labels = skuRows.map(r => `SKU ${r.id} · ${r.type.replace('Type ', '')}${r.size}`);
    charts.sku.data.datasets[0].data = skuRows.map(r => r.gap);
    charts.sku.data.datasets[1].data = skuRows.map(r => gpById[r.id].gap);
    charts.sku.update();
    const pairChart = (chart, key) => {
      const names = Object.keys(Rg[key]).sort((a, b) => ((Rgp[key][b] || 0) - (Rgp[key][a] || 0)) || (Rg[key][b] - Rg[key][a]));
      chart.data.labels = names.map(n => (key === 'gapBySupplier' ? shortSup(n) : n));
      chart.data.datasets[0].data = names.map(n => Rg[key][n]);
      chart.data.datasets[1].data = names.map(n => Rgp[key][n] || 0);
      chart.update();
    };
    pairChart(charts.supplier, 'gapBySupplier');
    pairChart(charts.buyer, 'gapByBuyer');
  }

  // ---------- numbers tables under the charts ----------
  function numTable(rows, cols, colLabel) {
    // rows: [[label, values[], fmtFn]]; cols: header labels
    return `<table><thead><tr><th>${colLabel}</th>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(([lab, vals, f]) =>
      `<tr><td>${lab}</td>${vals.map(v => `<td>${(f || fmt)(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  function renderNumbers() {
    const mcols = [...months.map(mLabel), 'Total'];
    const withTot = (a, isPct, R) => [...a, isPct ? R.totals.coverage : sum(a)];
    $('#numCap').innerHTML = numTable([
      ['Demand hrs', withTot(Rg.monthly.demand)],
      [`${sw('g')}Capacity hrs`, withTot(Rg.monthly.capacity)],
      [`${sw('gp')}Capacity hrs`, withTot(Rgp.monthly.capacity)],
      [`${sw('g')}Delivered hrs`, withTot(Rg.monthly.delivered)],
      [`${sw('gp')}Delivered hrs`, withTot(Rgp.monthly.delivered)]], mcols, 'Month');
    const cov = R => withTot(R.monthly.delivered.map((d, t) => d / R.monthly.demand[t]), true, R);
    $('#numGap').innerHTML = numTable([
      [`${sw('g')}Gap hrs`, withTot(Rg.monthly.gap)], [`${sw('gp')}Gap hrs`, withTot(Rgp.monthly.gap)],
      [`${sw('g')}Gap units`, withTot(Rg.monthly.gapUnits)], [`${sw('gp')}Gap units`, withTot(Rgp.monthly.gapUnits)],
      [`${sw('g')}Coverage`, cov(Rg), pct], [`${sw('gp')}Coverage`, cov(Rgp), pct]], mcols, 'Month');
    const byType = R => satTypes.map(ty => [`${R === Rg ? sw('g') : sw('gp')}${ty} short`, withTot(R.short[ty])]);
    $('#numSats').innerHTML = numTable([
      ['Satellites planned', withTot(Rg.monthly.satsPlan)],
      [`${sw('g')}Short, all types`, withTot(Rg.monthly.satsShort)], ...byType(Rg),
      [`${sw('gp')}Short, all types`, withTot(Rgp.monthly.satsShort)], ...byType(Rgp)], mcols, 'Month');
    const two = (label, key) => {
      const names = Object.keys(Rg[key]).sort((a, b) => ((Rgp[key][b] || 0) - (Rgp[key][a] || 0)) || (Rg[key][b] - Rg[key][a]));
      return `<table><thead><tr><th>${label}</th><th>${sw('g')}Gap hrs</th><th>${sw('gp')}Gap hrs</th></tr></thead><tbody>${names.map(n =>
        `<tr><td>${esc(n)}</td><td>${fmt(Rg[key][n])}</td><td>${fmt(Rgp[key][n] || 0)}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td>${fmt(Rg.totals.gap)}</td><td>${fmt(Rgp.totals.gap)}</td></tr></tbody></table>`;
    };
    $('#numSupplier').innerHTML = two('Supplier', 'gapBySupplier');
    $('#numBuyer').innerHTML = two('Buyer', 'gapByBuyer');
    $('#numSku').innerHTML = `<table><thead><tr><th>SKU</th><th>Supplier(s)</th><th>Buyer</th><th>${sw('g')}Gap hrs</th><th>${sw('gp')}Gap hrs</th><th>${sw('g')}Gap units</th><th>${sw('gp')}Gap units</th></tr></thead><tbody>${Rg.skuTotals.map((g, i) => { const p = Rgp.skuTotals[i];
      return `<tr class="clickable" data-sku-row="${i}"><td>SKU ${g.id}</td><td style="text-align:left">${esc(p.suppliers.map(shortSup).join(', '))}</td><td style="text-align:left">${esc(g.buyer)}</td><td>${fmt(g.gap)}</td><td>${fmt(p.gap)}</td><td>${fmt(g.gapUnits)}</td><td>${fmt(p.gapUnits)}</td></tr>`; }).join('')}</tbody></table>`;
  }

  // ---------- ledes ----------
  function typeClose() {
    const byType = R => { const o = {}; R.skuTotals.forEach(x => { o[x.type] = (o[x.type] || 0) + x.gap; }); return o; };
    const g = byType(Rg), p = byType(Rgp);
    const parts = ['Type A', 'Type B', 'Type C'].filter(t => g[t] > 1e-4).map(t => ({ t, closed: 1 - (p[t] || 0) / g[t] }));
    if (!parts.length) return '';
    parts.sort((a, b) => a.closed - b.closed);
    const worst = parts[0], rest = parts.slice(1);
    return `Planned turn-ons close ${rest.map(x => `${Math.round(x.closed * 100)}% of the ${x.t} gap`).join(' and ')}, but only ${Math.round(worst.closed * 100)}% of the ${worst.t} gap.`;
  }
  function renderLedes() {
    const peak = R => R.monthly.gap.reduce((b, g, k, a) => (g > a[b] ? k : b), 0);
    const pG = peak(Rg), pP = peak(Rgp);
    const underP = Rgp.monthly.capacity.filter((c, t) => c < Rgp.monthly.demand[t]).length;
    $('#gapLede').innerHTML = Rg.totals.gap > 1e-4
      ? `The gap grows as Sat1.2 and Sat4 ramp up. Guaranteed-only, it peaks in <strong>${mLabel(months[pG])}</strong> at <strong>${fmt(Rg.monthly.gap[pG])} hours</strong>. With planned machines the peak is <strong>${fmt(Rgp.monthly.gap[pP])} hours</strong> in ${mLabel(months[pP])}. ${underP === 0 ? 'With planned capacity, total hours exceed demand every month, so the remaining gap is a <strong>mix problem, not a volume problem</strong>: hours sit on machines that aren\'t qualified or compatible with the SKUs that need them.' : `Even with planned capacity, total hours fall short of demand in ${underP} month${underP === 1 ? '' : 's'}, so this is a volume problem as well as a mix problem.`}`
      : 'No machine-hour gap in any month under the current assumptions.';
    const top = [...Rgp.skuTotals].sort((a, b) => b.gap - a.gap).filter(r => r.gap > 1e-4);
    const top3 = sum(top.slice(0, 3).map(r => r.gap));
    const buy = Object.entries(Rgp.gapByBuyer).sort((a, b) => b[1] - a[1])[0];
    $('#whereLede').innerHTML = top.length
      ? `With planned capacity, three SKUs, <strong>${top.slice(0, 3).map(r => r.id).join(', ')}</strong>, make up ${Math.round(top3 / Rgp.totals.gap * 100)}% of what's left. ${typeClose()} ${buy[0].startsWith('Shared') ? `SKUs shared by more than one buyer carry the largest remaining share (${Math.round(buy[1] / Rgp.totals.gap * 100)}%), so they need a single named owner.` : `<strong>${buy[0]}</strong> owns the largest remaining share (${Math.round(buy[1] / Rgp.totals.gap * 100)}%).`}`
      : (Rg.totals.gap > 1e-4 ? 'With planned capacity no SKU is short. The guaranteed-only gaps are shown for reference.' : 'No SKU is short.');
  }

  // ---------- tables ----------
  function typeSizeTable() {
    const sizes = [100, 200, 300], types = ['Type A', 'Type B', 'Type C'];
    const max = Math.max(1, ...Object.values(Rg.gapByTypeSize), ...Object.values(Rgp.gapByTypeSize));
    const one = (R, k) => {
      let h = `<div><h4>${sw(k)}${k === 'g' ? 'Guaranteed' : 'Guaranteed + planned'}</h4><div class="table-wrap"><table><thead><tr><th>Size</th>${types.map(t => `<th>${t.replace('Type ', '')}</th>`).join('')}<th>Total</th></tr></thead><tbody>`;
      sizes.forEach(sz => {
        let rowT = 0;
        h += `<tr><td>${sz}</td>` + types.map(t => {
          const v = R.gapByTypeSize[`${t} · ${sz}`] || 0; rowT += v;
          return `<td style="background:rgba(208,59,59,${(v / max * 0.85).toFixed(2)})">${v > 1e-4 ? fmt(v) : '<span style="color:var(--muted)">–</span>'}</td>`;
        }).join('') + `<td>${fmt(rowT)}</td></tr>`;
      });
      const colT = types.map(t => sum(sizes.map(sz => R.gapByTypeSize[`${t} · ${sz}`] || 0)));
      return h + `<tr class="total"><td>Total</td>${colT.map(v => `<td>${fmt(v)}</td>`).join('')}<td>${fmt(R.totals.gap)}</td></tr></tbody></table></div></div>`;
    };
    $('#typeSizeTable').innerHTML = one(Rg, 'g') + one(Rgp, 'gp');
  }
  function supplierTable() {
    const useCell = (s, k) => {
      const u = s.capacity ? s.used / s.capacity : 0;
      return `<td><div class="bar-cell">${pct(u)}<span class="b" style="width:${Math.round(u * 50)}px;background:${COLORS[k]}"></span></div></td>`;
    };
    let h = `<table><thead><tr><th>Supplier</th><th>Buyer</th><th>${sw('g')}Use</th><th>${sw('gp')}Use</th><th>${sw('g')}Gap (sole)</th><th>${sw('gp')}Gap (sole)</th></tr></thead><tbody>`;
    Rg.supplierUtil.forEach((s, k) => {
      const p = Rgp.supplierUtil[k];
      h += `<tr><td>${shortSup(s.name)}</td><td>${s.buyer}</td>${useCell(s, 'g')}${useCell(p, 'gp')}
        <td class="${s.gap > 1e-4 ? 'neg' : 'zero'}">${fmt(s.gap)}</td><td class="${p.gap > 1e-4 ? 'neg' : 'zero'}">${fmt(p.gap)}</td></tr>`;
    });
    const sh = R => R.gapBySupplier['Shared (multi-supplier SKUs)'] || 0;
    h += `<tr><td>Shared</td><td style="color:var(--muted)">multi-supplier SKUs</td><td></td><td></td><td class="${sh(Rg) > 1e-4 ? 'neg' : 'zero'}">${fmt(sh(Rg))}</td><td class="${sh(Rgp) > 1e-4 ? 'neg' : 'zero'}">${fmt(sh(Rgp))}</td></tr>`;
    $('#supplierTable').innerHTML = h + '</tbody></table>';
  }

  const METRIC = {
    gapHrs: { get: R => R.gapHrs, color: 'gap' },
    gapUnits: { get: R => R.gapUnits, color: 'gap' },
    machinesToAdd: { get: R => R.machinesToAdd, color: 'gap' },
    demandUnits: { get: R => R.demandUnits, color: 'blue' },
    demandHrs: { get: R => R.demandHrs, color: 'blue' },
    delivered: { get: R => R.delivered, color: 'blue' }
  };
  function renderHeatmap() {
    const R = RS()[auditScn];
    const data = METRIC[heatMetric].get(R);
    const max = Math.max(1e-9, ...data.flat());
    const rgb = METRIC[heatMetric].color === 'gap' ? '208,59,59' : '57,135,229';
    let h = `<table><thead><tr><th>SKU</th>${months.map(mo => `<th>${mLabel(mo)}</th>`).join('')}<th>Total</th></tr></thead><tbody>`;
    R.skus.forEach((s, i) => {
      h += `<tr><td>SKU ${s.id} <span style="color:var(--muted)">${s.type.replace('Type ', '')}${s.size}</span></td>`;
      data[i].forEach((v, t) => {
        const a = v > 1e-4 ? 0.15 + 0.85 * v / max : 0;
        const sel = selected && selected.i === i && selected.t === t ? ' sel' : '';
        h += `<td class="cell${v > 1e-4 ? '' : ' z'}${sel}" data-i="${i}" data-t="${t}" style="background:rgba(${rgb},${a.toFixed(2)})">${v > 1e-4 ? fmt(v) : '·'}</td>`;
      });
      h += `<td>${fmt(sum(data[i]))}</td></tr>`;
    });
    const colTot = months.map((_, t) => sum(data.map(r => r[t])));
    h += `<tr class="total"><td>Total</td>${colTot.map(v => `<td>${fmt(v)}</td>`).join('')}<td>${fmt(sum(colTot))}</td></tr></tbody></table>`;
    $('#heatmap').innerHTML = h;
  }

  // ---------- drill-in with return ----------
  function openSku(i, t, fromLabel, anchorSel) {
    if (t === null || t === undefined) {
      // worst month for this SKU: + planned first, guaranteed if planned has no gap
      const pick = arr => arr.reduce((b, g, k, a) => (g > a[b] ? k : b), 0);
      t = Rgp.gapHrs[i].some(g => g > 1e-4) ? pick(Rgp.gapHrs[i]) : pick(Rg.gapHrs[i]);
    }
    const anchor = anchorSel && document.querySelector(anchorSel);
    jumpFrom = { sel: anchorSel, offset: anchor ? anchor.getBoundingClientRect().top : 0, y: window.scrollY, label: fromLabel };
    selected = { i, t };
    renderHeatmap(); renderDetail(); showBack();
    $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function showBack() {
    const b = $('#backBtn');
    if (!jumpFrom) { b.hidden = true; return; }
    b.innerHTML = `↩ Back to ${esc(jumpFrom.label)}<span class="x" aria-label="Dismiss">×</span>`;
    b.hidden = false;
  }

  function renderDetail() {
    const el = $('#detail');
    if (!selected) { el.hidden = true; return; }
    const { i, t } = selected, s = Rgp.skus[i];
    el.hidden = false;
    const supH = Rgp.skuTotals[i].hrsPerMachine;
    const qualFrom = name => { const q = s.qual.find(q => q.name === name); return q && q.added ? ` (new, from ${mLabel(months[q.from])})` : ''; };
    const two = (fn, d = 1, hi) => `<div class="pair">${['g', 'gp'].map(k => `<div>${sw(k)}<span class="v"${hi && fn(RS()[k]) > 1e-4 ? ' style="color:var(--gap)"' : ''}>${fmt(fn(RS()[k]), d)}</span></div>`).join('')}</div>`;
    const rows = Rgp.machines.map((m, j) => ({ m, j }))
      .filter(x => {
        const q = s.qual.find(q => q.name === x.m.supplier);
        return q && q.from <= t && (x.m.type === 'Type C' || x.m.type === s.type) && x.m.size >= s.size;
      });
    const status = m => (!m.planned ? 'Guaranteed' : (m.from > 23 ? 'Planned after Dec-74' : `Planned ${mLabel(months[Math.max(0, m.from)])}`));
    el.innerHTML = `
      <div class="toolbar"><div>
        <h3>SKU ${s.id} &middot; ${mLabel(months[t])}</h3>
        <p class="meta">${s.type}, size ${s.size}, ${s.hpu} hrs/unit &middot; Qualified: ${s.qual.map(q => esc(q.name) + qualFrom(q.name)).join(', ')} &middot; Buyer: ${s.buyers.join(', ')}${D.assumedSkus.includes(s.id) ? ' &middot; <span class="tag">assumed specs</span>' : ''}</p>
      </div>
      <label class="field" style="margin:0">Month <select id="detailMonth">${months.map((m, k) => `<option value="${k}" ${k === t ? 'selected' : ''}>${mLabel(m)}</option>`).join('')}</select></label></div>
      <div class="detail-grid">
        <div><div class="v">${fmt(Rgp.demandUnits[i][t], 1)}</div><div class="l">Demand units</div></div>
        <div><div class="v">${fmt(Rgp.demandHrs[i][t], 1)}</div><div class="l">Demand hrs</div></div>
        <div>${two(R => R.delivered[i][t])}<div class="l">Delivered hrs</div></div>
        <div>${two(R => R.gapHrs[i][t], 1, true)}<div class="l">Gap hrs</div></div>
        <div>${two(R => R.machinesToAdd[i][t], 2)}<div class="l">Machine-equivalents of gap (${fmt(supH)} h per machine-month)</div></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Eligible machine</th><th>Supplier</th><th>Type · size</th><th>Status</th>
        <th>${sw('g')}Hrs avail.</th><th>${sw('g')}To this SKU</th><th>${sw('gp')}Hrs avail.</th><th>${sw('gp')}To this SKU</th><th>${sw('gp')}To other SKUs</th>${st.stockpile ? `<th>${sw('gp')}Build-ahead</th>` : ''}<th>${sw('gp')}Left idle</th></tr></thead><tbody>
      ${rows.length ? rows.map(({ m, j }) => {
        const cg = Rg.machines[j].hours[t], ag = Rg.alloc[j][i][t];
        const cp = m.hours[t], ap = Rgp.alloc[j][i][t], up = Rgp.used[j][t], bp = Rgp.aheadUsed[j][t];
        return `<tr><td>${m.id}</td><td>${shortSup(m.supplier)}</td><td>${m.type.replace('Type ', '')} · ${m.size}</td><td>${status(m)}</td>
          <td>${fmt(cg)}</td><td>${fmt(ag, 1)}</td><td>${fmt(cp)}</td><td>${fmt(ap, 1)}</td><td>${fmt(up - ap, 1)}</td>${st.stockpile ? `<td>${fmt(bp, 1)}</td>` : ''}<td>${fmt(cp - up - bp, 1)}</td></tr>`;
      }).join('') : '<tr><td colspan="11">No eligible machines</td></tr>'}
      </tbody></table></div>${st.stockpile ? `<p class="note">Build-ahead: ${sw('g')}${fmt(Rg.drawn[i][t], 1)} / ${sw('gp')}${fmt(Rgp.drawn[i][t], 1)} units drawn from stock this month &middot; on hand at month end ${sw('g')}${fmt(Rg.onHand[i][t], 1)} / ${sw('gp')}${fmt(Rgp.onHand[i][t], 1)} units. Build-ahead column = spare hours this machine spent building any SKU ahead.</p>` : ''}`;
  }

  function renderDetailTable() {
    let h = '';
    const neg = v => (v > 1e-4 ? 'neg' : 'zero');
    if (tableTab === 'sku') {
      h = `<table><thead><tr><th>SKU</th><th>Type</th><th>Size</th><th>Hrs/unit</th><th>Qualified suppliers</th><th>Buyer</th><th>Eligible machines</th><th>Demand hrs</th>
        <th>${sw('g')}Gap hrs</th><th>${sw('gp')}Gap hrs</th><th>${sw('g')}Gap units</th><th>${sw('gp')}Gap units</th><th>${sw('g')}Months short</th><th>${sw('gp')}Months short</th><th>${sw('gp')}First short</th></tr></thead><tbody>`;
      Rg.skuTotals.forEach((g, i) => {
        const p = Rgp.skuTotals[i];
        h += `<tr class="clickable" data-sku-row="${i}" title="Open SKU ${g.id} detail"><td>SKU ${g.id}${D.assumedSkus.includes(g.id) ? ' *' : ''}</td><td>${g.type.replace('Type ', '')}</td><td>${g.size}</td><td>${g.hpu}</td><td style="text-align:left">${p.suppliers.map(shortSup).join(', ')}</td><td style="text-align:left">${g.buyer}</td><td>${p.eligibleMachines}</td><td>${fmt(g.demand)}</td>
          <td class="${neg(g.gap)}">${fmt(g.gap, 1)}</td><td class="${neg(p.gap)}">${fmt(p.gap, 1)}</td><td>${fmt(g.gapUnits)}</td><td>${fmt(p.gapUnits)}</td><td>${g.monthsShort}</td><td>${p.monthsShort}</td><td>${p.firstShort >= 0 ? mLabel(months[p.firstShort]) : '–'}</td></tr>`;
      });
      const G = Rg.totals, P = Rgp.totals;
      h += `<tr class="total"><td>Total</td><td colspan="6"></td><td>${fmt(G.demand)}</td><td>${fmt(G.gap, 1)}</td><td>${fmt(P.gap, 1)}</td><td>${fmt(G.gapUnits)}</td><td>${fmt(P.gapUnits)}</td><td>${G.skuMonthsShort}</td><td>${P.skuMonthsShort}</td><td></td></tr></tbody></table><p class="note">Click a row to open that SKU. * Assumed specs (type, size, hours per unit). Gap units round each SKU-month up.</p>`;
    } else if (tableTab === 'sats') {
      h = `<table><thead><tr><th>Satellite</th><th>Row</th>${months.map(m => `<th>${mLabel(m)}</th>`).join('')}<th>Total</th></tr></thead><tbody>`;
      st.priority.forEach((ty, p) => {
        [['Plan', Rg.sats[ty]], [`${sw('g')}Short`, Rg.short[ty]], [`${sw('gp')}Short`, Rgp.short[ty]]].forEach(([lab, arr], k) => {
          h += `<tr${k === 2 ? ' style="border-bottom:1px solid var(--axis)"' : ''}><td>${k === 0 ? `${p + 1} · ${ty}` : ''}</td><td>${lab}</td>${arr.map(v => `<td class="${k && v > 0 ? 'neg' : (v ? '' : 'zero')}">${fmt(v)}</td>`).join('')}<td>${fmt(sum(arr))}</td></tr>`;
        });
      });
      h += `<tr class="total"><td>All</td><td>${sw('g')}Short</td>${Rg.monthly.satsShort.map(v => `<td>${fmt(v)}</td>`).join('')}<td>${fmt(Rg.totals.satsShort)}</td></tr>`;
      h += `<tr class="total"><td></td><td>${sw('gp')}Short</td>${Rgp.monthly.satsShort.map(v => `<td>${fmt(v)}</td>`).join('')}<td>${fmt(Rgp.totals.satsShort)}</td></tr></tbody></table>`;
    } else if (tableTab === 'adds') {
      h = `<table><thead><tr><th>Machine group (supplier | type | size)</th><th>SKUs</th><th>${sw('g')}Machines to add</th><th>${sw('gp')}Machines to add</th><th>${sw('g')}Machine-months short</th><th>${sw('gp')}Machine-months short</th></tr></thead><tbody>`;
      Rgp.machineGroups.forEach((p, k) => {
        const g = Rg.machineGroups[k];
        if (!g.machineMonths && !p.machineMonths) return;
        h += `<tr><td style="white-space:normal">${esc(p.group)}</td><td>${p.skus.join(', ')}</td><td class="${g.peak ? 'neg' : 'zero'}">${g.peak}</td><td class="${p.peak ? 'neg' : 'zero'}">${p.peak}</td><td>${g.machineMonths}</td><td>${p.machineMonths}</td></tr>`;
      });
      h += `<tr class="total"><td>Total</td><td></td><td>${fmt(Rg.totals.machinesToAdd)}</td><td>${fmt(Rgp.totals.machinesToAdd)}</td><td>${fmt(Rg.totals.machineMonths)}</td><td>${fmt(Rgp.totals.machineMonths)}</td></tr></tbody></table>
        <p class="note">Same method as the Excel: each SKU's gap is turned into machine-equivalents (gap hrs ÷ the lowest monthly hours of its qualified suppliers). These are summed within each supplier × type × size group and rounded up once per month. A group needs its peak month, since a machine added for the peak also covers every other month. Shared groups use the lower monthly hours, so they're conservative.</p>`;
    } else if (tableTab === 'machines') {
      h = `<table><thead><tr><th>Machine</th><th>Supplier</th><th>Type</th><th>Size</th><th>Turn on</th><th>SKUs it can make</th><th>${sw('g')}Used hrs</th><th>${sw('g')}Use</th><th>${sw('gp')}Used hrs</th><th>${sw('gp')}Use</th></tr></thead><tbody>`;
      Rgp.machineRows.forEach((m, j) => {
        const g = Rg.machineRows[j];
        const use = r => (r.capacity ? pct(r.used / r.capacity) : '–');
        h += `<tr><td>${m.id}${m.added ? ' (added)' : ''}</td><td style="text-align:left">${shortSup(m.supplier)}</td><td>${m.type.replace('Type ', '')}</td><td>${m.size}</td><td>${m.turnOn === 'Yes' ? 'Yes' : (months.includes(m.turnOn) ? mLabel(m.turnOn) : m.turnOn)}</td><td style="text-align:left" class="${m.eligibleSkus ? '' : 'neg'}">${m.skuList.length ? m.skuList.join(', ') : 'none: idle'}</td><td>${fmt(g.used)}</td><td>${use(g)}</td><td>${fmt(m.used)}</td><td>${use(m)}</td></tr>`;
      });
      h += '</tbody></table>';
    } else {
      const both = (lab, f, isPct, endBal) => [[`${sw('g')}${lab}`, f(Rg), isPct, 'g', endBal], [`${sw('gp')}${lab}`, f(Rgp), isPct, 'gp', endBal]];
      const rows = [['Demand hrs', Rg.monthly.demand],
        ...both('Capacity hrs', R => R.monthly.capacity), ...both('Delivered hrs', R => R.monthly.delivered),
        ...both('Gap hrs', R => R.monthly.gap), ...both('Coverage', R => R.monthly.delivered.map((d, t) => d / R.monthly.demand[t]), true),
        ...both('Gap units', R => R.monthly.gapUnits), ...both('Reserved but idle hrs', R => R.monthly.reservedIdle),
        ['Satellites planned', Rg.monthly.satsPlan], ...both('Satellites short', R => R.monthly.satsShort),
        ...(st.stockpile ? [...both('Build-ahead hrs', R => R.monthly.buildAhead), ...both('Units drawn from stock', R => R.monthly.drawn), ...both('Units on hand (end)', R => R.monthly.onHand, false, true)] : [])];
      h = `<table><thead><tr><th>Metric</th>${months.map(m => `<th>${mLabel(m)}</th>`).join('')}<th>Total</th></tr></thead><tbody>`;
      rows.forEach(([lab, arr, isPct, k, endBal]) => {
        const tot = isPct ? RS()[k].totals.coverage : (endBal ? arr[arr.length - 1] : sum(arr));
        const red = /Gap|short/.test(lab);
        h += `<tr><td>${lab}</td>${arr.map(v => `<td class="${red && v > 1e-4 ? 'neg' : ''}">${isPct ? pct(v) : fmt(v)}</td>`).join('')}<td>${isPct ? pct(tot) : fmt(tot)}</td></tr>`;
      });
      h += '</tbody></table><p class="note">Reserved but idle: under the whole-machine reservation rule, hours we pay for on machines we use in a month but don\'t fill.</p>';
    }
    $('#detailTable').innerHTML = h;
  }

  function csv() {
    const R = RS()[auditScn], data = METRIC[heatMetric].get(R);
    const lines = [['SKU', ...months].join(',')].concat(R.skus.map((s, i) => [s.id, ...data[i].map(v => +v.toFixed(4))].join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${heatMetric}_${auditScn === 'gp' ? 'guaranteed_plus_planned' : 'guaranteed'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- actions ----------
  function renderActions() {
    const s0 = recResults.start, s1 = recResults.end, risk = recResults.risk;
    $('#actionsLede').innerHTML = s0.gp.satsShort > 0 || s0.g.satsShort > 0
      ? `With planned capacity, actions 02–04 take satellites short from <strong>${fmt(s0.gp.satsShort)}</strong> to <strong>${fmt(s1.gp.satsShort)}</strong>. If only guaranteed machines show up, they take it from <strong>${fmt(s0.g.satsShort)}</strong> to <strong>${fmt(s1.g.satsShort)}</strong>. That difference is why action 01 comes first: protect the planned capacity the plan depends on.`
      : 'No satellites are short under the current assumptions. The actions below add margin.';
    const box = (label, f, fmtF, sub) => `<div><div class="l">${label}</div>${['g', 'gp'].map(k => `<div class="row">${sw(k)}<span class="v">${fmtF(f(s0[k]))} → ${fmtF(f(s1[k]))}</span></div>`).join('')}<div class="s">${sub}</div></div>`;
    $('#actionsSummary').innerHTML =
      box('Satellites short', x => x.satsShort, fmt, `${fmt(s0.gp.satsShort - s1.gp.satsShort)} recovered with planned · ${fmt(s0.g.satsShort - s1.g.satsShort)} guaranteed-only`) +
      box('Gap (machine hrs)', x => x.gap, fmt, `${s0.gp.gap ? Math.round((1 - s1.gp.gap / s0.gp.gap) * 100) : 0}% closed with planned · ${s0.g.gap ? Math.round((1 - s1.g.gap / s0.g.gap) * 100) : 0}% guaranteed-only`) +
      box('Demand covered', x => x.coverage, pct, `${s1.gp.skusShort} SKUs still short with planned · ${s1.g.skusShort} guaranteed-only`);

    const w = risk.worst;
    const protect = `
      <li class="action">
        <div>
          <h4>Lock in planned machine turn-on dates</h4>
          <p>Planned machines are worth <b>${fmt(risk.plannedValue)}</b> satellites: the difference between the two scenarios. Convert planned turn-ons into firm reservations. A 3-month slip across the board costs <b>${fmt(risk.slip)}</b> more satellites${w ? `, and losing <b>${w.m.id}</b> alone (${shortSup(w.m.supplier)}, ${w.m.type} ${w.m.size}, due ${mLabel(w.m.turnOn)}) costs <b>${fmt(w.d)}</b>` : ''}.</p>
          <p class="why">Cheapest action: the capacity is already planned. Track turn-on dates monthly with each buyer and escalate slips early.</p>
          <div class="meta"><span>Owner <b>All buyers${w ? `, ${D.suppliers.find(s => s.name === w.m.supplier).buyer} first (${w.m.id})` : ''}</b></span><span>Timing <b>Now</b></span></div>
        </div>
        <div class="impact"><div class="l">Satellites at stake</div><div class="v">${fmt(risk.plannedValue)}</div><div class="h">guaranteed vs. + planned &middot; a 3-mo slip costs <span style="color:var(--gap)">+${fmt(risk.slip)}</span></div></div>
      </li>`;
    const rec = v => (v <= 0 ? '+' + fmt(-v) : '−' + fmt(v));
    const fmtD = v => (v <= 0 ? '+' + fmt(-v) : '−' + fmt(v));
    const alts = `
      <li class="action alt">
        <div>
          <h4>Tested and not recommended</h4>
          <p class="why">Each lever below is applied on top of actions 02–04 above. Satellites recovered are computed live, so they update if you change assumptions. Red means the lever leaves more satellites short, a greedy-ordering effect.</p>
          <div class="table-wrap"><table><thead><tr><th>Lever</th><th>Owner</th><th>${sw('gp')}Sats recovered</th><th>${sw('g')}Sats recovered</th><th>${sw('gp')}Gap hrs</th><th style="text-align:left">Why not</th></tr></thead><tbody>
          ${ALTS.map((a, k) => { const x = recResults.alts[k]; return `<tr><td style="white-space:normal">${a.name}</td><td>${a.owner}</td><td class="${x.dShort.gp > 0 ? 'neg' : ''}">${fmtD(x.dShort.gp)}</td><td class="${x.dShort.g > 0 ? 'neg' : ''}">${fmtD(x.dShort.g)}</td><td>${x.dGap.gp <= 0 ? '−' : '+'}${fmt(Math.abs(x.dGap.gp))}</td><td style="text-align:left;white-space:normal;color:var(--muted)">${a.reason}</td></tr>`; }).join('')}
          </tbody></table></div>
        </div>
      </li>`;
    $('#actionsList').innerHTML = protect + RECS.map((r, k) => {
      const x = recResults[k];
      return `
      <li class="action${applied.has(r.id) ? ' applied' : ''}">
        <div>
          <h4>${r.title}</h4>
          <p>${r.what}</p>
          <p class="why">${r.why}</p>
          <div class="meta"><span>Owner <b>${r.owner}</b></span><span>Timing <b>${r.when}</b></span></div>
        </div>
        <div class="impact">
          <div class="l">Satellites recovered</div>
          <div class="both">${['gp', 'g'].map(sk => `<div>${sw(sk)}<span class="v${x.dShort[sk] > 0 ? ' worse' : ''}">${rec(x.dShort[sk])}</span><span class="t">${sk === 'g' ? 'guar.' : '+ plan.'}</span></div>`).join('')}</div>
          <div class="h">${x.dGap.gp <= 0 ? '−' : '+'}${fmt(Math.abs(x.dGap.gp))} / ${x.dGap.g <= 0 ? '−' : '+'}${fmt(Math.abs(x.dGap.g))} gap hrs</div>
          <label class="apply"><input type="checkbox" data-rec="${r.id}" ${applied.has(r.id) ? 'checked' : ''}> Apply to model</label>
        </div>
      </li>`;
    }).join('') + alts;
  }

  // ---------- controls ----------
  function renderControls() {
    $('#slip').value = st.plannedSlip;
    $('#slipOut').textContent = st.plannedSlip === 0 ? 'On schedule' : `${Math.abs(st.plannedSlip)} mo ${st.plannedSlip > 0 ? 'late' : 'early'}`;
    $('#launchScale').value = Math.round(st.launchScale * 100);
    $('#launchOut').textContent = `${Math.round(st.launchScale * 100)}% of plan`;
    $('#yield').value = Math.round(st.yieldPct * 100);
    $('#yieldOut').textContent = `${Math.round(st.yieldPct * 100)}%`;
    $$('#auditScn button').forEach(b => b.classList.toggle('on', b.dataset.as === auditScn));

    $('#prioList').innerHTML = st.priority.map((t, i) => {
      const pl = sum(Rg.sats[t]);
      return `<li><span class="n">${i + 1}</span><span class="name" style="border-left:4px solid ${satColor[t]};padding-left:10px">${t}</span><span class="s">short ${sw('g')}${fmt(sum(Rg.short[t]))} ${sw('gp')}${fmt(sum(Rgp.short[t]))} of ${fmt(pl)}</span>
        <button data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${t} up">↑</button><button data-down="${i}" ${i === st.priority.length - 1 ? 'disabled' : ''} aria-label="Move ${t} down">↓</button></li>`;
    }).join('');

    const def = E.defaultSettings(D);
    $('#skuAssumed').innerHTML = D.assumedSkus.map(id => {
      const v = st.sku[id], d = def.sku[id];
      const base = D.skus.find(s => s.id === id);
      return `<div class="sku-row"><div class="id">SKU ${id}<div style="font-size:11px;color:var(--muted);font-weight:400">${shortSup(base.suppliers[0])}</div></div>
        <label>Machine type<select data-sku="${id}" data-f="type" class="${v.type !== d.type ? 'changed' : ''}">${E.TYPES.map(t => `<option ${t === v.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Machine size<select data-sku="${id}" data-f="size" class="${v.size !== d.size ? 'changed' : ''}">${[100, 200, 300].map(z => `<option ${z === v.size ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
        <label>Hours / unit<input type="number" min="0.1" step="0.1" value="${v.hpu}" data-sku="${id}" data-f="hpu" class="${v.hpu !== d.hpu ? 'changed' : ''}"></label></div>`;
    }).join('') + `<p class="note" style="margin-top:12px">Excel base: SKU 7 = Type B, 200, 2.5 h (like SKU 8 at Cobalt Ridge). SKU 16 = Type B, 300, 2 h (Redwood Forge). Eligible machines today: SKU 7 → ${Rgp.skuTotals.find(r => r.id === 7).eligibleMachines}, SKU 16 → ${Rgp.skuTotals.find(r => r.id === 16).eligibleMachines}.</p>`;

    let h = '<table><thead><tr><th>Supplier</th><th>Buyer</th><th>Days / month</th><th>Uptime hrs / day</th><th>Hrs / machine-month</th><th>Machines</th></tr></thead><tbody>';
    D.suppliers.forEach(s => {
      const v = st.sup[s.name];
      h += `<tr><td>${s.name}</td><td>${s.buyer}</td>
        <td><input type="number" min="1" max="31" step="1" value="${v.days}" data-sup="${esc(s.name)}" data-f="days" class="${v.days !== s.days ? 'changed' : ''}"></td>
        <td><input type="number" min="1" max="24" step="1" value="${v.uptime}" data-sup="${esc(s.name)}" data-f="uptime" class="${v.uptime !== s.uptime ? 'changed' : ''}"></td>
        <td>${fmt(v.days * v.uptime)}</td><td>${Rgp.machines.filter(m => m.supplier === s.name).length}</td></tr>`;
    });
    $('#supplierCtl').innerHTML = h + '</tbody></table>';

    const monthOpts = sel => months.map((m, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${mLabel(m)}</option>`).join('');
    if (!$('#qualForm').dataset.init) {
      $('#qualForm').innerHTML = `
        <label>SKU<select id="qSku">${D.skus.map(s => `<option value="${s.id}">SKU ${s.id} · ${s.type.replace('Type ', '')}${s.size}</option>`).join('')}</select></label>
        <label>New supplier<select id="qSup"></select></label>
        <label>Effective<select id="qFrom">${monthOpts(QUAL_LEAD)}</select></label>
        <button class="btn small" id="qAdd">Add qualification</button>`;
      $('#addMachineForm').innerHTML = `
        <label>Supplier<select id="aSup">${supplierNames.map(n => `<option>${esc(n)}</option>`).join('')}</select></label>
        <label>Type<select id="aType">${E.TYPES.map(t => `<option>${t}</option>`).join('')}</select></label>
        <label>Size<select id="aSize"><option>100</option><option>200</option><option selected>300</option></select></label>
        <label>Turns on<select id="aFrom">${monthOpts(6)}</select></label>
        <button class="btn small" id="aAdd">Add machine</button>`;
      $('#qualForm').dataset.init = 1;
    }
    const sku = +$('#qSku').value, cur = D.skus.find(s => s.id === sku);
    const prevSup = $('#qSup').value;
    $('#qSup').innerHTML = supplierNames.filter(n => !cur.suppliers.includes(n)).map(n => `<option ${n === prevSup ? 'selected' : ''}>${esc(n)}</option>`).join('');
    $('#qualList').innerHTML = st.extraQual.map((q, k) => `<li>SKU ${q.sku} ← ${shortSup(q.supplier)} from ${mLabel(months[q.from])}<button data-rmq="${k}" aria-label="Remove">×</button></li>`).join('');
    $('#addMachineList').innerHTML = st.extraMachines.map((m, k) => `<li>NEW${k + 1}: ${shortSup(m.supplier)} ${m.type} ${m.size} from ${mLabel(months[m.from])}<button data-rmm="${k}" aria-label="Remove">×</button></li>`).join('');

    $('#machineCtl').innerHTML = D.machines.map(m => {
      const off = st.machinesOff.includes(m.id);
      const row = Rgp.machineRows.find(r => r.id === m.id);
      return `<label class="mtoggle${off ? ' off' : ''}"><input type="checkbox" data-mach="${m.id}" ${off ? '' : 'checked'}><div><b>${m.id} · ${m.type.replace('Type ', '')}${m.size}</b><span>${shortSup(m.supplier)} · ${m.turnOn === 'Yes' ? 'guaranteed' : 'planned ' + mLabel(m.turnOn)}${row ? ` · ${row.eligibleSkus} SKUs` : ''}</span></div></label>`;
    }).join('');
  }

  const ASSUMPTIONS = [
    'Being able to change assumptions live is valued over a perfect optimum: a rule-based, type-by-type greedy allocation (same logic as the Excel) instead of Solver. The allocation favours completing whole satellites in priority order over maximizing total hours delivered.',
    'SKUs 7 and 16 had no machine type, size, or hours per unit. Values follow similar SKUs at the same supplier (editable above). The real values would come from each supplier\'s specs and an estimate of average time per unit.',
    'The supplier and buyer listed first are the primary supplier and buyer. Gaps are attributed to them.',
    '100% yield (editable above).',
    'The launch plan is firm (scale editable above).',
    'No building ahead, inventory, or stockpiling in the base case. The stockpiling scenario is available with the build-ahead toggle.',
    'No lead time between production and launch (shipping, receiving, etc.).',
    'BOM quantities are exact and don\'t change.',
    'Inventory left after the launch schedule ends has no value.',
    'Capacity is the same every month: no seasonality, holidays, short months, or maintenance beyond what uptime already reflects.',
    'No changeover or setup time when a machine switches SKUs within a month.',
    'Hours per unit are the same on any eligible machine. A bigger or Type C machine isn\'t faster.',
    '"Yes" machines are available every month for the whole horizon.',
    'A planned machine is available for the whole month it turns on and turns on on schedule (timing editable above).',
    'Any machine can be reserved in any month. Suppliers\' other customers don\'t compete for the capacity.',
    'Production is continuous: fractional units are allowed within a month. Without stockpiling, units don\'t carry over between months.',
    'Suppliers have no limits beyond machine hours (materials, labor, tooling).',
    'Qualified supplier lists don\'t change during the horizon in the base case, because qualification takes several months. Recommended qualifications assume 6 months.'
  ];

  function bind() {
    document.addEventListener('click', e => {
      const b = e.target.closest('button');
      const row = e.target.closest('tr[data-sku-row]');
      if (!b && row) {
        const box = row.closest('[id]'); // anchor to this table: the same SKU row appears in more than one table
        openSku(+row.dataset.skuRow, null, 'SKU table', `#${box.id} tr[data-sku-row="${row.dataset.skuRow}"]`);
        return;
      }
      if (!b) return;
      if (b.id === 'backBtn') {
        if (e.target.classList.contains('x')) { jumpFrom = null; showBack(); return; }
        // Re-find the clicked element (layout may have shifted) and put it back where it was on screen
        const j = jumpFrom, anchor = j && j.sel && document.querySelector(j.sel);
        const y = anchor ? window.scrollY + anchor.getBoundingClientRect().top - j.offset : (j ? j.y : 0);
        jumpFrom = null; showBack();
        window.scrollTo({ top: y, behavior: 'smooth' });
      } else if (b.dataset.sp) { st.stockpile = b.dataset.sp === 'on'; update();
      } else if (b.dataset.as) { auditScn = b.dataset.as; $$('#auditScn button').forEach(x => x.classList.toggle('on', x === b)); renderHeatmap(); }
      else if (b.dataset.up !== undefined) { const i = +b.dataset.up; [st.priority[i - 1], st.priority[i]] = [st.priority[i], st.priority[i - 1]]; update(); }
      else if (b.dataset.down !== undefined) { const i = +b.dataset.down; [st.priority[i + 1], st.priority[i]] = [st.priority[i], st.priority[i + 1]]; update(); }
      else if (b.dataset.m) { heatMetric = b.dataset.m; $$('#heatMetric button').forEach(x => x.classList.toggle('on', x === b)); renderHeatmap(); }
      else if (b.dataset.t) { tableTab = b.dataset.t; $$('#tableTab button').forEach(x => x.classList.toggle('on', x === b)); renderDetailTable(); }
      else if (b.dataset.rmq !== undefined) { st.extraQual.splice(+b.dataset.rmq, 1); update(); }
      else if (b.dataset.rmm !== undefined) { st.extraMachines.splice(+b.dataset.rmm, 1); update(); }
      else if (b.id === 'qAdd') {
        const sku = +$('#qSku').value, supplier = $('#qSup').value, from = +$('#qFrom').value;
        if (supplier && !st.extraQual.some(q => q.sku === sku && q.supplier === supplier)) { st.extraQual.push({ sku, supplier, from }); update(); }
      } else if (b.id === 'aAdd') {
        st.extraMachines.push({ supplier: $('#aSup').value, type: $('#aType').value, size: +$('#aSize').value, from: +$('#aFrom').value }); update();
      } else if (b.id === 'resetBtn') { st = E.defaultSettings(D); applied.clear(); selected = null; update(); }
      else if (b.id === 'csvBtn') csv();
    });
    $('#heatmap').addEventListener('click', e => {
      const c = e.target.closest('td.cell'); if (!c) return;
      openSku(+c.dataset.i, +c.dataset.t, 'heatmap', `td.cell[data-i="${c.dataset.i}"][data-t="${c.dataset.t}"]`);
    });
    $('#heatmap').addEventListener('mousemove', e => {
      const c = e.target.closest('td.cell'), tip = $('#tooltip');
      if (!c) { tip.hidden = true; return; }
      const i = +c.dataset.i, t = +c.dataset.t;
      tip.innerHTML = `<b>SKU ${Rgp.skus[i].id} · ${mLabel(months[t])}</b><br>Demand ${fmt(Rgp.demandHrs[i][t], 1)} hrs (${fmt(Rgp.demandUnits[i][t])} units)<br>${sw('g')}Gap ${fmt(Rg.gapHrs[i][t], 1)} hrs · ${fmt(Rg.gapUnits[i][t])} units<br>${sw('gp')}Gap ${fmt(Rgp.gapHrs[i][t], 1)} hrs · ${fmt(Rgp.gapUnits[i][t])} units`;
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 290) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
    });
    $('#heatmap').addEventListener('mouseleave', () => { $('#tooltip').hidden = true; });

    document.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.stock) { st.stockpile = t.checked; update(); }
      else if (t.dataset.rec) { t.checked ? applied.add(t.dataset.rec) : applied.delete(t.dataset.rec); update(); }
      else if (t.dataset.sku) {
        const o = st.sku[t.dataset.sku];
        if (t.dataset.f === 'type') o.type = t.value;
        else if (t.dataset.f === 'size') o.size = +t.value;
        else { const v = parseFloat(t.value); if (v > 0) o.hpu = v; }
        update();
      } else if (t.dataset.sup) {
        const v = parseInt(t.value, 10), lim = t.dataset.f === 'days' ? 31 : 24;
        if (v > 0) st.sup[t.dataset.sup][t.dataset.f] = Math.min(v, lim);
        update();
      } else if (t.dataset.mach) {
        const id = t.dataset.mach;
        st.machinesOff = t.checked ? st.machinesOff.filter(x => x !== id) : [...st.machinesOff, id];
        update();
      } else if (t.id === 'qSku') renderControls();
      else if (t.id === 'detailMonth' && selected) { selected.t = +t.value; renderHeatmap(); renderDetail(); }
    });
    // Update the label while dragging; rerun the model (~30 engine runs) only on release
    const live = (id, fn) => {
      $(id).addEventListener('input', e => { fn(+e.target.value); renderControls(); });
      $(id).addEventListener('change', update);
    };
    live('#slip', v => { st.plannedSlip = v; });
    live('#launchScale', v => { st.launchScale = v / 100; });
    live('#yield', v => { st.yieldPct = v / 100; });

    const nav = $('#topnav');
    const onScroll = () => nav.classList.toggle('solid', window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  // ---------- starfield ----------
  function stars() {
    const c = $('#stars'), ctx = c.getContext('2d');
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = c.offsetWidth * dpr; c.height = c.offsetHeight * dpr;
      ctx.clearRect(0, 0, c.width, c.height);
      seed = 7;
      const n = Math.round(c.offsetWidth * c.offsetHeight / 2600);
      for (let k = 0; k < n; k++) {
        const x = rnd() * c.width, y = rnd() * c.height, r = (rnd() < 0.92 ? 0.5 : 1.1) * dpr, a = 0.25 + rnd() * 0.65;
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    };
    draw(); window.addEventListener('resize', draw);
  }

  function update() {
    compute();
    renderHero(); renderCharts(); renderNumbers(); renderLedes();
    typeSizeTable(); supplierTable();
    renderHeatmap(); renderDetail(); renderDetailTable(); renderActions(); renderControls();
  }

  $('#assumeList').innerHTML = ASSUMPTIONS.map(a => `<li>${a}</li>`).join('');
  stars(); initCharts(); bind(); update();
})();
