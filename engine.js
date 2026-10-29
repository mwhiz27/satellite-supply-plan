// Supply-plan engine. Mirrors the Excel model step for step:
//   Sats launched x BOM -> SKU demand (units, machine hours)
//   Machines x suppliers -> monthly machine hours (guaranteed / + planned)
//   Eligibility (qualified supplier, type rule, size rule)
//   Greedy allocation: machines least-flexible first, SKUs fewest-eligible-machines first
//   Gaps (hours, units, machines to add) and whole satellites buildable in priority order
(function (root) {
  const TYPES = ['Type A', 'Type B', 'Type C'];

  function typeOK(machineType, skuType) {
    return machineType === 'Type C' || machineType === skuType;
  }

  function defaultSettings(data) {
    const sku = {};
    data.skus.forEach(s => { sku[s.id] = { type: s.type, size: s.size, hpu: s.hpu }; });
    const sup = {};
    data.suppliers.forEach(s => { sup[s.name] = { days: s.days, uptime: s.uptime }; });
    return {
      includePlanned: false,
      priority: Object.keys(data.sats),
      sku,                 // per-SKU machine type / size / hours per unit
      sup,                 // per-supplier days per month / uptime hours per day
      plannedSlip: 0,      // months every planned machine turns on late
      machinesOff: [],     // machine IDs removed (e.g. a supplier outage)
      extraQual: [],       // [{sku, supplier, from: monthIndex}] new qualifications
      extraMachines: [],   // [{supplier, type, size, from: monthIndex}] added capacity
      launchScale: 1,      // multiplier on the launch plan (rounded to whole satellites)
      yieldPct: 1,         // good units per unit started; 1 = 100% (Excel assumption)
      stockpile: false     // allow building ahead with spare hours (Excel Dashboard toggle E3)
    };
  }

  function run(data, st) {
    const M = data.months.length;
    const months = data.months;
    const satTypes = Object.keys(data.sats);
    const supByName = {};
    data.suppliers.forEach(s => {
      const o = st.sup[s.name];
      supByName[s.name] = { ...s, days: o.days, uptime: o.uptime, hours: o.days * o.uptime };
    });

    // ---- Demand ----
    const sats = {};
    satTypes.forEach(t => { sats[t] = data.sats[t].map(v => Math.round(v * st.launchScale)); });
    const skus = data.skus.map(s => {
      const o = st.sku[s.id];
      const qual = s.suppliers.map(name => ({ name, from: 0 }));
      st.extraQual.filter(q => q.sku === s.id && !s.suppliers.includes(q.supplier))
        .forEach(q => qual.push({ name: q.supplier, from: q.from, added: true }));
      return { ...s, type: o.type, size: o.size, hpu: o.hpu, qual,
        primarySupplier: s.suppliers[0], primaryBuyer: s.buyers[0] };
    });
    const demandUnits = skus.map(s => months.map((_, t) =>
      satTypes.reduce((a, ty) => a + sats[ty][t] * (data.bom[s.id][ty] || 0), 0) / st.yieldPct));
    const demandHrs = skus.map((s, i) => demandUnits[i].map(u => u * s.hpu));

    // ---- Supply ----
    const machines = data.machines
      .filter(m => !st.machinesOff.includes(m.id))
      .map(m => {
        const planned = m.turnOn !== 'Yes';
        const from = planned ? months.indexOf(m.turnOn) + st.plannedSlip : 0;
        return { ...m, planned, from };
      });
    st.extraMachines.forEach((m, k) => machines.push({
      id: 'NEW' + (k + 1), supplier: m.supplier, type: m.type, size: m.size,
      turnOn: months[m.from] || 'n/a', planned: true, added: true, from: m.from }));
    machines.forEach(m => {
      const h = supByName[m.supplier].hours;
      m.hours = months.map((_, t) => (!m.planned ? h : (st.includePlanned && t >= m.from ? h : 0)));
      // Capacity view that ignores the scenario toggle (for the capacity chart)
      m.hoursIfPlanned = months.map((_, t) => (!m.planned || t >= m.from ? h : 0));
    });

    // ---- Eligibility (static counts drive ordering, like the Excel matrix) ----
    const elig = machines.map(m => skus.map(s => {
      const q = s.qual.find(x => x.name === m.supplier);
      return q && typeOK(m.type, s.type) && m.size >= s.size ? q.from : -1; // month it becomes eligible
    }));
    const machineCount = machines.map((_, j) => elig[j].filter(v => v >= 0).length);
    const skuCount = skus.map((_, i) => elig.filter(r => r[i] >= 0).length);
    const stableSort = (n, key) => [...Array(n).keys()].sort((a, b) => key(a) - key(b) || a - b);
    const machineOrder = stableSort(machines.length, j => machineCount[j]);
    const skuOrder = stableSort(skus.length, i => skuCount[i]);

    // ---- Type-by-type greedy allocation (mirrors the S1/S2 Type-by-Type Engines) ----
    // Each month, satellite types go in priority order. Probe: fill the type's full launch-plan demand
    // from the capacity still free to find n, the whole satellites it supports. Commit: reserve hours for
    // exactly n. After all types, Fill gives leftover hours to the remaining demand.
    const delivered = skus.map(() => new Array(M).fill(0));
    const used = machines.map(() => new Array(M).fill(0));
    const alloc = machines.map(() => skus.map(() => new Array(M).fill(0)));
    // One greedy pass: machines in rank order, SKUs hardest-to-make first
    const pass = (cap, demand, t) => {
      const got = skus.map(() => 0), rows = [];
      for (const j of machineOrder) {
        let rem = cap[j];
        for (const i of skuOrder) {
          const e = elig[j][i];
          if (e < 0 || t < e) continue;
          const a = Math.max(0, Math.min(rem, demand[i] - got[i]));
          if (a > 0) { got[i] += a; rem -= a; rows.push([j, i, a]); }
        }
      }
      return { got, rows };
    };
    const commitRows = (cap, rows, t) => rows.forEach(([j, i, a]) => {
      cap[j] = Math.max(0, cap[j] - a); delivered[i][t] += a; used[j][t] += a; alloc[j][i][t] += a;
    });
    const committedSats = {};
    satTypes.forEach(ty => { committedSats[ty] = new Array(M).fill(0); });
    for (let t = 0; t < M; t++) {
      const cap = machines.map(m => m.hours[t]);
      const committed = skus.map(() => 0);
      for (const ty of st.priority) {
        const plan = sats[ty][t];
        const perSat = skus.map(s => (data.bom[s.id][ty] || 0) * s.hpu / st.yieldPct);
        const probe = pass(cap, perSat.map(h => h * plan), t);
        let n = plan;
        skus.forEach((s, i) => {
          const q = data.bom[s.id][ty] || 0;
          if (q > 0) n = Math.min(n, Math.floor(Math.round(probe.got[i] * st.yieldPct / s.hpu / q * 1e6) / 1e6));
        });
        n = Math.max(0, n);
        committedSats[ty][t] = n;
        commitRows(cap, pass(cap, perSat.map(h => h * n), t).rows, t);
        perSat.forEach((h, i) => { committed[i] += h * n; });
      }
      commitRows(cap, pass(cap, skus.map((_, i) => Math.max(0, demandHrs[i][t] - committed[i])), t).rows, t);
    }

    // ---- Gaps ----
    const gapHrs = skus.map((_, i) => months.map((_, t) => demandHrs[i][t] - delivered[i][t]));
    const roundUp = x => (x > 1e-9 ? Math.ceil(x - 1e-9) : 0);
    const gapUnits = skus.map((s, i) => gapHrs[i].map(g => roundUp(g / s.hpu)));
    // Machine-equivalents of gap (unrounded, so they add up): gap hrs ÷ the lowest monthly hours among the
    // SKU's qualified suppliers. Whole machines are counted per supplier × type × size group below.
    const minHrs = skus.map(s => Math.min(...s.qual.map(q => supByName[q.name].hours)));
    const machinesToAdd = skus.map((s, i) => gapHrs[i].map(g => g / minHrs[i]));

    // ---- Satellites buildable, filled in priority order ----
    const deliveredUnits = skus.map((s, i) => delivered[i].map(h => h / s.hpu * st.yieldPct));
    const buildable = {}, short = {};
    satTypes.forEach(ty => { buildable[ty] = new Array(M).fill(0); short[ty] = new Array(M).fill(0); });
    // Builds whole satellites from avail (units by SKU) in priority order; avail is drawn down in place.
    // With `locked` (satellites per type already secured), those are reserved first and only extras are built.
    const buildSats = (avail, t, locked) => {
      if (locked) skus.forEach((s, i) => { satTypes.forEach(ty => { avail[i] -= locked[ty] * (data.bom[s.id][ty] || 0); }); });
      for (const ty of st.priority) {
        const plan = sats[ty][t], b0 = locked ? locked[ty] : 0;
        let extra = Infinity;
        skus.forEach((s, i) => {
          const q = data.bom[s.id][ty] || 0;
          if (q > 0) extra = Math.min(extra, Math.floor(Math.round(avail[i] / q * 1e6) / 1e6));
        });
        const b = b0 + Math.max(0, Math.min(plan - b0, extra === Infinity ? plan : extra));
        buildable[ty][t] = b;
        short[ty][t] = plan - b;
        skus.forEach((s, i) => { avail[i] -= (b - b0) * (data.bom[s.id][ty] || 0); });
      }
    };

    // ---- Optional stockpiling / build-ahead (mirrors 'Stockpiling Gaps' + the Build-Ahead Engines) ----
    // Current-month allocation is unchanged. Each month the base case's satellites are locked in first, then
    // stock plus leftover parts build extras, so stockpiling never builds fewer satellites than the base case.
    // Spare machine hours build SKUs toward future base-case gaps; units sit on hand until a satellite needs them.
    const round6 = x => Math.round(x * 1e6) / 1e6;
    const onHand = skus.map(() => new Array(M).fill(0));
    const drawn = skus.map(() => new Array(M).fill(0));
    const aheadHrs = skus.map(() => new Array(M).fill(0));
    const aheadUsed = machines.map(() => new Array(M).fill(0));
    if (st.stockpile) {
      const baseGap = gapHrs.map(r => r.slice());
      let open = skus.map(() => 0);
      for (let t = 0; t < M; t++) {
        const avail = skus.map((_, i) => open[i] + deliveredUnits[i][t]);
        const start = avail.slice();
        buildSats(skus.map((_, i) => deliveredUnits[i][t]), t); // base-case satellites this month
        const locked = Object.fromEntries(satTypes.map(ty => [ty, buildable[ty][t]]));
        buildSats(avail, t, locked); // avail is now the units remaining after all priorities
        skus.forEach((s, i) => { drawn[i][t] = Math.max(0, round6(start[i] - avail[i] - deliveredUnits[i][t])); });
        const target = skus.map((s, i) =>
          Math.max(0, baseGap[i].slice(t + 1).reduce((a, g) => a + g, 0) - avail[i] * s.hpu / st.yieldPct));
        for (const j of machineOrder) {
          let spare = Math.max(0, machines[j].hours[t] - used[j][t]);
          for (const i of skuOrder) {
            const e = elig[j][i];
            if (e < 0 || t < e) continue;
            const a = Math.max(0, Math.min(spare, target[i] - aheadHrs[i][t]));
            if (a > 0) { aheadHrs[i][t] += a; spare -= a; aheadUsed[j][t] += a; }
          }
        }
        skus.forEach((s, i) => { onHand[i][t] = avail[i] + aheadHrs[i][t] / s.hpu * st.yieldPct; });
        open = skus.map((_, i) => onHand[i][t]);
      }
      // Gaps and deliveries net of units drawn from stock
      skus.forEach((s, i) => months.forEach((_, t) => {
        const h = drawn[i][t] * s.hpu / st.yieldPct;
        gapHrs[i][t] = Math.max(0, round6(baseGap[i][t] - h));
        delivered[i][t] += h;
        gapUnits[i][t] = roundUp(round6(gapHrs[i][t] / s.hpu));
        machinesToAdd[i][t] = gapHrs[i][t] / minHrs[i];
      }));
    } else {
      for (let t = 0; t < M; t++) buildSats(skus.map((_, i) => deliveredUnits[i][t]), t);
    }
    const usedAll = machines.map((_, j) => used[j].map((u, t) => u + aheadUsed[j][t]));

    // ---- Roll-ups ----
    const sumCols = rows => months.map((_, t) => rows.reduce((a, r) => a + r[t], 0));
    const total = arr => arr.reduce((a, b) => a + b, 0);
    const monthly = {
      demand: sumCols(demandHrs),
      delivered: sumCols(delivered),
      gap: sumCols(gapHrs),
      gapUnits: sumCols(gapUnits),
      capacity: sumCols(machines.map(m => m.hours)),
      capacityGuaranteed: sumCols(machines.filter(m => !m.planned).map(m => m.hours)),
      used: sumCols(usedAll),
      buildAhead: sumCols(aheadHrs),
      onHand: sumCols(onHand),
      drawn: sumCols(drawn),
      reservedIdle: sumCols(machines.map((m, j) => m.hours.map((h, t) => (usedAll[j][t] > 0 ? h - usedAll[j][t] : 0)))),
      satsPlan: sumCols(satTypes.map(ty => sats[ty])),
      satsShort: sumCols(satTypes.map(ty => short[ty]))
    };
    // Gaps are owned by the SKU's supplier and buyer; multi-supplier / multi-buyer SKUs are "Shared" (as in the Excel)
    const skuTotals = skus.map((s, i) => ({
      id: s.id, type: s.type, size: s.size, hpu: s.hpu,
      supplier: s.qual.length > 1 ? 'Shared: ' + s.qual.map(q => q.name).join(' / ') : s.qual[0].name,
      supplierKey: s.qual.length > 1 ? 'Shared (multi-supplier SKUs)' : s.qual[0].name,
      buyer: s.buyers.join(', '),
      buyerKey: s.buyers.length > 1 ? 'Shared (SKUs with more than one buyer)' : s.buyers[0],
      hrsPerMachine: minHrs[i],
      suppliers: s.qual.map(q => q.name), eligibleMachines: skuCount[i],
      demand: total(demandHrs[i]), delivered: total(delivered[i]), gap: total(gapHrs[i]),
      gapUnits: total(gapUnits[i]), monthsShort: gapHrs[i].filter(g => g > 1e-4).length,
      peakAdd: Math.max(...machinesToAdd[i]),
      firstShort: gapHrs[i].findIndex(g => g > 1e-4)
    }));
    const groupBy = key => {
      const out = {};
      skuTotals.forEach(r => { out[r[key]] = (out[r[key]] || 0) + r.gap; });
      return out;
    };
    const gapByTypeSize = {};
    skuTotals.forEach(r => {
      const k = r.type + ' · ' + r.size;
      gapByTypeSize[k] = (gapByTypeSize[k] || 0) + r.gap;
    });
    const supplierUtil = data.suppliers.map(s => {
      const js = machines.map((m, j) => j).filter(j => machines[j].supplier === s.name);
      return {
        name: s.name, buyer: s.buyer, hoursPerMachine: supByName[s.name].hours,
        machines: js.length,
        capacity: total(sumCols(js.map(j => machines[j].hours))),
        used: total(sumCols(js.map(j => usedAll[j]))),
        gap: groupBy('supplierKey')[s.name] || 0
      };
    });
    // Whole machines to add: machine-equivalents summed per supplier(s) × type × size group, rounded up once
    // per month; a group's need is its peak month (a machine added for the peak covers every other month).
    const groupIdx = {};
    skuTotals.forEach((r, i) => { const k = `${r.supplier} | ${r.type} | Size ${r.size}`; (groupIdx[k] = groupIdx[k] || []).push(i); });
    const machineGroups = Object.keys(groupIdx).sort().map(k => {
      const monthly = months.map((_, t) => roundUp(round6(groupIdx[k].reduce((a, i) => a + machinesToAdd[i][t], 0))));
      return { group: k, skus: groupIdx[k].map(i => skus[i].id), monthly, peak: Math.max(...monthly), machineMonths: total(monthly) };
    });
    const machineRows = machines.map((m, j) => ({
      id: m.id, supplier: m.supplier, type: m.type, size: m.size, turnOn: m.turnOn,
      planned: m.planned, added: !!m.added, eligibleSkus: machineCount[j],
      skuList: skus.filter((_, i) => elig[j][i] >= 0).map(s => s.id),
      capacity: total(m.hours), used: total(usedAll[j]),
      monthsActive: m.hours.filter(h => h > 0).length
    }));

    const totals = {
      demand: total(monthly.demand), delivered: total(monthly.delivered), gap: total(monthly.gap),
      gapUnits: total(monthly.gapUnits), capacity: total(monthly.capacity), used: total(monthly.used),
      reservedIdle: total(monthly.reservedIdle),
      buildAhead: total(monthly.buildAhead), drawn: total(monthly.drawn),
      onHandEnd: monthly.onHand[M - 1],
      satsPlan: total(monthly.satsPlan), satsShort: total(monthly.satsShort),
      machinesToAdd: total(machineGroups.map(g => g.peak)),
      machineMonths: total(machineGroups.map(g => g.machineMonths)),
      skuMonthsShort: gapHrs.reduce((a, r) => a + r.filter(g => g > 1e-4).length, 0),
      skusShort: skuTotals.filter(r => r.gap > 1e-4).length,
      monthsWithShortSats: monthly.satsShort.filter(v => v > 0).length
    };
    totals.coverage = totals.demand ? totals.delivered / totals.demand : 1;

    return {
      months, skus, machines, sats, demandUnits, demandHrs, delivered, gapHrs, gapUnits,
      machinesToAdd, deliveredUnits, buildable, short, monthly, totals, skuTotals,
      gapBySupplier: groupBy('supplierKey'), gapByBuyer: groupBy('buyerKey'), gapByTypeSize, machineGroups,
      supplierUtil, machineRows, skuOrder: skuOrder.map(i => skus[i].id),
      machineOrder: machineOrder.map(j => machines[j].id), alloc, used,
      aheadUsed, aheadHrs, onHand, drawn
    };
  }

  const api = { run, defaultSettings, TYPES };
  root.SupplyEngine = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
