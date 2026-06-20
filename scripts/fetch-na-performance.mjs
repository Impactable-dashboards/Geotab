#!/usr/bin/env node
// Rebuilds data/na-performance.json from Windsor (LinkedIn Ads, Geotab North
// America): funnel mix by stage, 12-week TOF/MOF/BOF spend trend, frequency &
// reach, and named 1:1 accounts. Funnel stage is parsed from campaign names.
//
// Requires env: WINDSOR_API_KEY
// Usage: node scripts/fetch-na-performance.mjs
// On any failure it throws and exits non-zero WITHOUT writing.

import { writeFile } from 'node:fs/promises';

const KEY = process.env.WINDSOR_API_KEY;
if (!KEY) { console.error('Missing WINDSOR_API_KEY'); process.exit(1); }

const NA = { id: '506925310', name: 'Geotab North America' };

async function windsor(fields, { datePreset, dateFrom, dateTo } = {}) {
  const p = new URLSearchParams();
  p.set('api_key', KEY);
  p.set('fields', fields.join(','));
  if (datePreset) p.set('date_preset', datePreset);
  if (dateFrom) p.set('date_from', dateFrom);
  if (dateTo) p.set('date_to', dateTo);
  p.set('account_id', NA.id);
  const res = await fetch('https://connectors.windsor.ai/linkedin?' + p.toString());
  if (!res.ok) throw new Error(`Windsor ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const rows = j.data || j.result || [];
  if (!Array.isArray(rows)) throw new Error('Unexpected Windsor response: ' + JSON.stringify(j).slice(0, 300));
  return rows;
}

const num = (v) => (v == null || v === '' ? 0 : Number(v));
const r4 = (v) => Number(num(v).toFixed(4));
const fmtMoney = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtImpr = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
const fmtDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Funnel stage from the LinkedIn campaign name.
function stage(name) {
  const n = String(name || '');
  if (/^1:1\b/.test(n.trim())) return 'Named';
  const t = n.toUpperCase();
  if (/\bTOFU?\b/.test(t)) return 'TOF';
  if (/\bMOFU?\b/.test(t)) return 'MOF';
  if (/\bBOFU?\b/.test(t)) return 'BOF';
  return 'Other';
}
const cleanAccount = (name) => String(name).replace(/^1:1\s*/, '').replace(/\s*-\s*[A-Za-z]+\s*\d{4}.*$/, '').trim();
const STAGE_LABEL = { TOF: 'Top of Funnel', MOF: 'Mid Funnel', BOF: 'Bottom of Funnel', Other: 'Always-On / Persona' };

async function main() {
  // 1) Campaign-level (30d) → funnel mix + named accounts
  const camp = await windsor(['campaign', 'spend', 'impressions', 'clicks'], { datePreset: 'last_30d' });
  const mix = { TOF: { spend: 0, impr: 0, clicks: 0 }, MOF: { spend: 0, impr: 0, clicks: 0 }, BOF: { spend: 0, impr: 0, clicks: 0 }, Other: { spend: 0, impr: 0, clicks: 0 } };
  const named = [];
  for (const row of camp) {
    const s = stage(row.campaign);
    if (s === 'Named') {
      named.push({ account: cleanAccount(row.campaign), spend: Math.round(num(row.spend)), impr: Math.round(num(row.impressions)), clicks: Math.round(num(row.clicks)), ctr: num(row.impressions) ? r4(num(row.clicks) / num(row.impressions)) : 0 });
      continue;
    }
    mix[s].spend += num(row.spend); mix[s].impr += num(row.impressions); mix[s].clicks += num(row.clicks);
  }
  const funnel = ['TOF', 'MOF', 'BOF', 'Other'].map((k) => ({
    stage: k, label: STAGE_LABEL[k], spend: Math.round(mix[k].spend), impr: Math.round(mix[k].impr),
    clicks: Math.round(mix[k].clicks), ctr: mix[k].impr ? r4(mix[k].clicks / mix[k].impr) : 0,
  }));
  named.sort((a, b) => b.spend - a.spend);

  // 2) Weekly TOF/MOF/BOF spend trend (last 12 complete ISO weeks)
  const since = new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const wkRows = await windsor(['campaign', 'year_week_iso', 'spend'], { dateFrom: since, dateTo: today });
  const byWeek = {};
  for (const row of wkRows) {
    const s = stage(row.campaign); if (!['TOF', 'MOF', 'BOF'].includes(s)) continue;
    const w = row.year_week_iso; if (!w) continue;
    (byWeek[w] ||= { tof: 0, mof: 0, bof: 0 })[s.toLowerCase()] += num(row.spend);
  }
  const weeksAsc = Object.keys(byWeek).sort((a, b) => {
    const [ya, wa] = a.split('|').map(Number); const [yb, wb] = b.split('|').map(Number); return ya - yb || wa - wb;
  });
  const trend = weeksAsc.slice(0, -1).slice(-12).map((w) => ({
    wk: 'Wk' + w.split('|')[1], tof: Math.round(byWeek[w].tof), mof: Math.round(byWeek[w].mof), bof: Math.round(byWeek[w].bof),
  }));

  // 3) Frequency & reach (30d)
  const freqRows = await windsor(['account_name', 'average_frequency', 'approximate_unique_impressions', 'impressions', 'spend'], { datePreset: 'last_30d' });
  const fr = freqRows.find((x) => x.account_name === NA.name) || freqRows[0] || {};
  const totalImpr = Math.round(num(fr.impressions));
  const totalSpend = funnel.reduce((s, f) => s + f.spend, 0) + named.reduce((s, n) => s + n.spend, 0);

  const out = {
    meta: {
      generated: fmtDate(new Date()), window: 'Last 30 days',
      totalSpend: fmtMoney(totalSpend), totalImpressions: fmtImpr(totalImpr),
      reach: Math.round(num(fr.approximate_unique_impressions)), frequency: Number(num(fr.average_frequency).toFixed(1)),
    },
    funnel, trend, named,
  };

  console.log(`Funnel: ${funnel.map((f) => f.stage + '=' + f.spend).join(' ')}`);
  console.log(`Named: ${named.length}  weeks: ${trend.length}  reach: ${out.meta.reach}  freq: ${out.meta.frequency}`);

  await writeFile(new URL('../data/na-performance.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote data/na-performance.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
