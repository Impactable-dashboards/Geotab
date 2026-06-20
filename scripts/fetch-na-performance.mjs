#!/usr/bin/env node
// Rebuilds data/na-performance.json from Windsor (LinkedIn Ads, Geotab North
// America): daily/weekly/monthly time series (spend, conversions, clicks,
// impressions, CPC, CPM, CTR) + Top campaigns by spend with 30d/90d frequency
// and penetration. The page computes KPIs, deltas, alerts and color thresholds.
//
// Requires env: WINDSOR_API_KEY
// On any failure it throws and exits non-zero WITHOUT writing.

import { writeFile } from 'node:fs/promises';

const KEY = process.env.WINDSOR_API_KEY;
if (!KEY) { console.error('Missing WINDSOR_API_KEY'); process.exit(1); }

const NA = '506925310';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function windsor(fields, { datePreset, dateFrom, dateTo } = {}) {
  const p = new URLSearchParams();
  p.set('api_key', KEY);
  p.set('fields', fields.join(','));
  if (datePreset) p.set('date_preset', datePreset);
  if (dateFrom) p.set('date_from', dateFrom);
  if (dateTo) p.set('date_to', dateTo);
  p.set('filter', JSON.stringify([['account_id', 'eq', NA]]));
  const res = await fetch('https://connectors.windsor.ai/linkedin?' + p.toString());
  if (!res.ok) throw new Error(`Windsor ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const rows = j.data || j.result || [];
  if (!Array.isArray(rows)) throw new Error('Unexpected Windsor response: ' + JSON.stringify(j).slice(0, 300));
  return rows;
}

const num = (v) => (v == null || v === '' ? 0 : Number(v));
const r2 = (v) => Number(num(v).toFixed(2));
const r4 = (v) => Number(num(v).toFixed(4));
const iso = (d) => d.toISOString().slice(0, 10);

function metricRow(label, r) {
  return {
    label,
    spend: r2(r.spend), conversions: Math.round(num(r.externalwebsiteconversions)),
    clicks: Math.round(num(r.clicks)), impressions: Math.round(num(r.impressions)),
    cpc: r2(r.cpc), cpm: r2(r.cpm), ctr: r4(r.ctr),
  };
}

function stage(name) {
  const t = String(name || '').toUpperCase();
  if (/^1:1\b/.test(String(name).trim())) return 'Named';
  if (/\bTOFU?\b/.test(t)) return 'TOF';
  if (/\bMOFU?\b/.test(t)) return 'MOF';
  if (/\bBOFU?\b/.test(t)) return 'BOF';
  return 'Other';
}
// Compact a long LinkedIn campaign name to "<Audience> · <Stage> <format/size>".
function shortName(name) {
  const n = String(name).replace(/\s+/g, ' ').trim();
  return n.length > 52 ? n.slice(0, 50) + '…' : n;
}

async function main() {
  const today = new Date();
  const from = (days) => iso(new Date(today.getTime() - days * 864e5));
  const fields = ['spend', 'externalwebsiteconversions', 'clicks', 'impressions', 'cpc', 'cpm', 'ctr'];

  // Time series
  const dailyRows = await windsor(['date', ...fields], { dateFrom: from(126), dateTo: iso(today) });
  const daily = dailyRows
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => metricRow(r.date.slice(5).replace('-', '/').replace(/^0/, ''), r));

  const weekRows = await windsor(['year_week_iso', ...fields], { dateFrom: from(140), dateTo: iso(today) });
  const weekly = weekRows
    .filter((r) => r.year_week_iso)
    .sort((a, b) => { const [ya, wa] = a.year_week_iso.split('|').map(Number); const [yb, wb] = b.year_week_iso.split('|').map(Number); return ya - yb || wa - wb; })
    .map((r) => metricRow('Wk' + r.year_week_iso.split('|')[1], r));

  const monthRows = await windsor(['year_month', ...fields], { dateFrom: iso(new Date(today.getFullYear(), 0, 1)), dateTo: iso(today) });
  const monthly = monthRows
    .filter((r) => r.year_month)
    .sort((a, b) => { const [ya, ma] = a.year_month.split('|').map(Number); const [yb, mb] = b.year_month.split('|').map(Number); return ya - yb || ma - mb; })
    .map((r) => metricRow(MONTHS[Number(r.year_month.split('|')[1]) - 1] || r.year_month, r));

  // Campaigns (90d) + frequency/penetration 30d & 90d
  const camp90 = await windsor(['campaign', 'spend', 'impressions', 'clicks', 'cpc', 'cpm', 'externalwebsiteconversions'], { dateFrom: from(90), dateTo: iso(today) });
  const fp30 = await windsor(['campaign', 'average_frequency', 'audience_penetration'], { datePreset: 'last_30d' });
  const fp90 = await windsor(['campaign', 'average_frequency', 'audience_penetration'], { dateFrom: from(91), dateTo: iso(today) });
  const f30 = Object.fromEntries(fp30.map((r) => [r.campaign, r]));
  const f90 = Object.fromEntries(fp90.map((r) => [r.campaign, r]));

  const campaigns = camp90
    .filter((r) => r.campaign && num(r.spend) > 0)
    .map((r) => {
      const conv = Math.round(num(r.externalwebsiteconversions));
      return {
        name: shortName(r.campaign), stage: stage(r.campaign),
        spend: Math.round(num(r.spend)), impr: Math.round(num(r.impressions)), clicks: Math.round(num(r.clicks)),
        cpc: r2(r.cpc), cpm: r2(r.cpm), conv, costPerConv: conv > 0 ? Math.round(num(r.spend) / conv) : null,
        freq30: r2((f30[r.campaign] || {}).average_frequency), freq90: r2((f90[r.campaign] || {}).average_frequency),
        pen30: r4((f30[r.campaign] || {}).audience_penetration), pen90: r4((f90[r.campaign] || {}).audience_penetration),
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 30);

  // Stage totals across ALL campaigns (for accurate % of spend by funnel stage)
  const ST = { TOF: { spend: 0, impr: 0, clicks: 0, conv: 0 }, MOF: { spend: 0, impr: 0, clicks: 0, conv: 0 }, BOF: { spend: 0, impr: 0, clicks: 0, conv: 0 }, Other: { spend: 0, impr: 0, clicks: 0, conv: 0 } };
  for (const r of camp90) {
    const s = stage(r.campaign);
    ST[s].spend += num(r.spend); ST[s].impr += num(r.impressions); ST[s].clicks += num(r.clicks); ST[s].conv += num(r.externalwebsiteconversions);
  }
  const stageTotals = {};
  for (const k of ['TOF', 'MOF', 'BOF', 'Other']) stageTotals[k] = { spend: Math.round(ST[k].spend), impr: Math.round(ST[k].impr), clicks: Math.round(ST[k].clicks), conv: Math.round(ST[k].conv) };

  // Weekly spend by funnel stage (campaign x week, parsed to stage) — last 12 complete ISO weeks
  const cwRows = await windsor(['campaign', 'year_week_iso', 'spend'], { dateFrom: from(100), dateTo: iso(today) });
  const byWk = {};
  for (const r of cwRows) {
    const w = r.year_week_iso; if (!w) continue;
    (byWk[w] ||= { TOF: 0, MOF: 0, BOF: 0, Other: 0 })[stage(r.campaign)] += num(r.spend);
  }
  const wkKeys = Object.keys(byWk).sort((a, b) => { const [ya, wa] = a.split('|').map(Number); const [yb, wb] = b.split('|').map(Number); return ya - yb || wa - wb; });
  const stageWeekly = wkKeys.slice(0, -1).slice(-12).map((w) => ({
    wk: 'Wk' + w.split('|')[1], TOF: Math.round(byWk[w].TOF), MOF: Math.round(byWk[w].MOF), BOF: Math.round(byWk[w].BOF), Other: Math.round(byWk[w].Other),
  }));

  const out = {
    meta: {
      account: 'Geotab North America',
      generated: today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      rangeStart: daily.length ? from(126) : null,
      rangeEnd: iso(today),
    },
    series: { daily, weekly, monthly },
    stageWeekly, stageTotals,
    campaigns,
  };

  console.log(`series: daily=${daily.length} weekly=${weekly.length} monthly=${monthly.length}  campaigns=${campaigns.length}  stageWeekly=${stageWeekly.length}`);
  await writeFile(new URL('../data/na-performance.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote data/na-performance.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
