#!/usr/bin/env node
// Rebuilds data/campaign-performance.json from Windsor (LinkedIn Ads), for the
// four Geotab regional accounts. Run daily by .github/workflows/refresh-campaign-data.yml.
//
// Requires env: WINDSOR_API_KEY
// Usage: node scripts/fetch-campaign-performance.mjs
//
// On any query failure it throws and exits non-zero WITHOUT writing, so the
// last good committed JSON is preserved rather than clobbered with partial data.

import { writeFile } from 'node:fs/promises';

const KEY = process.env.WINDSOR_API_KEY;
if (!KEY) { console.error('Missing WINDSOR_API_KEY'); process.exit(1); }

const ACCOUNTS = {
  na:    { id: '506925310', label: 'North America', name: 'Geotab North America' },
  emea:  { id: '516375258', label: 'EMEA',          name: 'Geotab - EMEA' },
  apac:  { id: '507238830', label: 'APAC',          name: 'Geotab - APAC' },
  latam: { id: '507235908', label: 'LATAM',         name: 'Geotab - LATAM' },
};
const ALL_IDS = Object.values(ACCOUNTS).map(a => a.id);
const NAME_TO_KEY = Object.fromEntries(Object.entries(ACCOUNTS).map(([k, a]) => [a.name, k]));

const FN_LABELS = {
  'Information Technology': 'IT',
  'Customer Success and Support': 'Customer Success',
  'Healthcare Services': 'Healthcare',
  'Program and Project Management': 'PM/Project Mgmt',
  'Media and Communication': 'Media',
};
const SENIORITY_ORDER = ['Senior', 'Manager', 'Director', 'VP', 'CXO', 'Entry', 'Owner'];

async function windsor(fields, { accounts, datePreset, dateFrom, dateTo } = {}) {
  const p = new URLSearchParams();
  p.set('api_key', KEY);
  p.set('fields', fields.join(','));
  if (datePreset) p.set('date_preset', datePreset);
  if (dateFrom) p.set('date_from', dateFrom);
  if (dateTo) p.set('date_to', dateTo);
  if (accounts) p.set('account_id', [].concat(accounts).join(','));
  const url = 'https://connectors.windsor.ai/linkedin?' + p.toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Windsor ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const rows = j.data || j.result || [];
  if (!Array.isArray(rows)) throw new Error('Unexpected Windsor response: ' + JSON.stringify(j).slice(0, 300));
  return rows;
}

const num = (v) => (v == null || v === '' ? 0 : Number(v));
const round = (v, d = 2) => Number(num(v).toFixed(d));

function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
function fmtImpr(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n); }
function fmtDate(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

async function main() {
  // 1) Region totals (last 30d)
  const regionRows = await windsor(
    ['account_name', 'spend', 'impressions', 'clicks', 'ctr', 'cpm', 'cpc'],
    { accounts: ALL_IDS, datePreset: 'last_30d' }
  );
  const regions = Object.entries(ACCOUNTS).map(([key, a]) => {
    const r = regionRows.find(x => x.account_name === a.name) || {};
    return {
      key, label: a.label,
      spend: Math.round(num(r.spend)), impressions: Math.round(num(r.impressions)),
      clicks: Math.round(num(r.clicks)), ctr: round(r.ctr, 4),
      cpm: round(r.cpm), cpc: round(r.cpc),
    };
  });

  // 2) Campaign-group performance per account (include account_name so we can filter client-side)
  const campFields = ['account_name', 'campaign_group_name', 'spend', 'impressions', 'clicks', 'ctr', 'cpm', 'cpc', 'total_engagements'];
  const naRaw = await windsor(campFields, { accounts: ACCOUNTS.na.id, datePreset: 'last_30d' });
  const emeaRaw = await windsor(campFields, { accounts: ACCOUNTS.emea.id, datePreset: 'last_30d' });
  const mapCamp = (rows, name, withEng) => rows
    .filter(r => !name || r.account_name === name)
    .filter(r => r.campaign_group_name && num(r.impressions) > 0)
    .map(r => {
      const o = {
        n: String(r.campaign_group_name).trim(), spend: round(r.spend), impr: Math.round(num(r.impressions)),
        clicks: Math.round(num(r.clicks)), ctr: round(r.ctr, 4), cpm: round(r.cpm), cpc: round(r.cpc),
      };
      if (withEng) o.eng = Math.round(num(r.total_engagements));
      return o;
    })
    .sort((a, b) => b.impr - a.impr);
  const naCampaigns = mapCamp(naRaw, ACCOUNTS.na.name, true);
  const emeaCampaigns = mapCamp(emeaRaw, ACCOUNTS.emea.name, false);

  // 3) NA demographics (member_* cannot be combined with other dimensions; scoped by account_id)
  const senRaw = await windsor(['member_seniority', 'impressions', 'clicks'], { accounts: ACCOUNTS.na.id, datePreset: 'last_30d' });
  const seniority = SENIORITY_ORDER
    .map(s => senRaw.find(r => r.member_seniority === s))
    .filter(Boolean)
    .map(r => ({ s: r.member_seniority, impr: Math.round(num(r.impressions)), clicks: Math.round(num(r.clicks)) }));

  const fnRaw = await windsor(['member_job_function', 'impressions', 'clicks'], { accounts: ACCOUNTS.na.id, datePreset: 'last_30d' });
  const functions = fnRaw
    .map(r => ({ f: FN_LABELS[r.member_job_function] || r.member_job_function, impr: Math.round(num(r.impressions)), clicks: Math.round(num(r.clicks)) }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10);

  // 4) 8-week spend trend by region (last 8 complete ISO weeks)
  const since = new Date(Date.now() - 70 * 864e5).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const trendRaw = await windsor(['account_name', 'year_week_iso', 'spend'], { accounts: ALL_IDS, dateFrom: since, dateTo: today });
  const byWeek = {};
  for (const r of trendRaw) {
    const yw = r.year_week_iso; const key = NAME_TO_KEY[r.account_name];
    if (!yw || !key) continue;
    (byWeek[yw] ||= { yw })[key] = (byWeek[yw][key] || 0) + num(r.spend);
  }
  const weeksAsc = Object.keys(byWeek).sort((a, b) => {
    const [ya, wa] = a.split('|').map(Number); const [yb, wb] = b.split('|').map(Number);
    return ya - yb || wa - wb;
  });
  // drop the current (partial) week, keep last 8 complete weeks
  const complete = weeksAsc.slice(0, -1).slice(-8);
  const trend = complete.map(yw => {
    const w = byWeek[yw];
    return {
      wk: 'Wk' + yw.split('|')[1],
      na: round(w.na || 0), emea: round(w.emea || 0), apac: round(w.apac || 0), latam: round(w.latam || 0),
    };
  });

  const totalSpend = regions.reduce((s, r) => s + r.spend, 0);
  const totalImpr = regions.reduce((s, r) => s + r.impressions, 0);

  const out = {
    meta: {
      generated: fmtDate(new Date()),
      window: 'Last 30 days',
      accounts: regions.length,
      totalSpend: fmtMoney(totalSpend),
      totalImpressions: fmtImpr(totalImpr),
    },
    regions, trend, naCampaigns, emeaCampaigns, seniority, functions,
  };

  // sanity: demographic impressions should be in the ballpark of NA region impressions
  const senImpr = seniority.reduce((s, x) => s + x.impr, 0);
  console.log(`Regions: ${regions.map(r => r.key + '=' + r.spend).join(' ')}`);
  console.log(`NA impr=${regions[0].impressions}  seniority impr sum=${senImpr}  NA campaigns=${naCampaigns.length}  weeks=${trend.length}`);
  if (senImpr > regions[0].impressions * 3) console.warn('WARNING: seniority impressions >> NA impressions — check account_id scoping.');

  await writeFile(new URL('../data/campaign-performance.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote data/campaign-performance.json');
}

main().catch(e => { console.error(e); process.exit(1); });
