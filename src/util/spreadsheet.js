'use strict';

const XLSX = require('xlsx');
const phone = require('./phone');

/**
 * Read a CSV / XLSX / XLS buffer into { headers, rows } where each row is a
 * plain object keyed by header text.
 */
function parseBuffer(buffer, filename = '') {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = wb.Sheets[sheetName];

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!matrix.length) return { headers: [], rows: [] };

  const headers = matrix[0].map((h, i) => {
    const t = String(h == null ? '' : h).trim();
    return t || `Column ${i + 1}`;
  });

  const rows = [];
  for (let r = 1; r < matrix.length; r++) {
    const raw = matrix[r];
    if (!raw || raw.every((c) => String(c == null ? '' : c).trim() === '')) continue;
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = raw[i] == null ? '' : String(raw[i]).trim();
    });
    rows.push(obj);
  }
  return { headers, rows, sheetName, sheetNames: wb.SheetNames };
}

const PATTERNS = {
  phone: [/^phone$/i, /phone.?(1|number|no)?$/i, /^mobile/i, /^cell/i, /^tel/i, /contact.?number/i, /^number$/i],
  firstName: [/^first.?name$/i, /^fname$/i, /^first$/i, /^given/i],
  lastName: [/^last.?name$/i, /^lname$/i, /^last$/i, /^surname$/i],
  fullName: [/^name$/i, /^full.?name$/i, /^contact.?name$/i, /^owner$/i, /^principal$/i],
  company: [/^company/i, /^business/i, /^dba$/i, /^merchant/i, /^account.?name$/i, /^organization/i],
  email: [/^e.?mail/i],
  // Merchant cash advance specifics
  monthlyRevenue: [/monthly.?(gross|rev|sales|deposit)/i, /^revenue.?(mo|month)/i, /^gross.?monthly/i, /avg.?monthly/i],
  annualRevenue: [/annual.?(rev|sales|gross)/i, /^yearly.?rev/i],
  timeInBusiness: [/time.?in.?business/i, /^tib$/i, /years?.?in.?business/i, /months?.?in.?business/i, /business.?since/i],
  requestedAmount: [/requested.?(amount|funding)/i, /amount.?(requested|needed|wanted)/i, /^funding.?amount/i, /^loan.?amount/i, /how.?much/i],
  industry: [/^industry/i, /^vertical/i, /business.?type/i, /^sic/i, /^naics/i],
  state: [/^state$/i, /^st$/i, /^province/i],
  positions: [/positions?/i, /existing.?(advance|loan|funding)/i, /current.?(advance|loan)/i, /stack/i],
  fico: [/^fico/i, /credit.?score/i],
};

/** "3 years", "18 months", "2y 6m" -> months. */
function monthsFromText(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // A bare number under 40 is almost always years on these sheets.
    return n <= 40 ? Math.round(n * 12) : Math.round(n);
  }
  let months = 0;
  let matched = false;
  const y = s.match(/(\d+(?:\.\d+)?)\s*(?:y|yr|yrs|year|years)/i);
  if (y) {
    months += Number(y[1]) * 12;
    matched = true;
  }
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:months?|mos?|m)\b/i);
  if (m) {
    months += Number(m[1]);
    matched = true;
  }
  if (matched) return Math.round(months);

  // A date like "2019" or "3/2021" means "in business since".
  const year = s.match(/(19|20)\d{2}/);
  if (year) {
    const then = new Date(`${s.includes('/') || s.includes('-') ? s : `01/01/${year[0]}`}`);
    if (!Number.isNaN(then.getTime())) {
      return Math.max(0, Math.round((Date.now() - then.getTime()) / (30.44 * 24 * 3600 * 1000)));
    }
  }
  return null;
}

/** "$45,000", "45k", "45,000/mo" -> 45000 */
function moneyFromText(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  const k = s.match(/^\$?\s*(\d+(?:\.\d+)?)\s*k\b/);
  if (k) return Number(k[1]) * 1000;
  const mm = s.match(/^\$?\s*(\d+(?:\.\d+)?)\s*(?:m|mm)\b/);
  if (mm) return Number(mm[1]) * 1000000;
  const n = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function intFromText(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Best-guess mapping from spreadsheet headers to our lead fields. */
function guessMapping(headers) {
  const map = {
    phone: '', firstName: '', lastName: '', fullName: '', company: '', email: '',
    monthlyRevenue: '', annualRevenue: '', timeInBusiness: '', requestedAmount: '',
    industry: '', state: '', positions: '', fico: '',
  };
  for (const [field, pats] of Object.entries(PATTERNS)) {
    for (const h of headers) {
      if (map[field]) break;
      if (pats.some((p) => p.test(h.trim()))) map[field] = h;
    }
  }
  // Fall back: any column where most values look like phone numbers.
  if (!map.phone && headers.length) map.phone = headers.find((h) => /phone|mobile|cell|tel/i.test(h)) || '';
  return map;
}

/** Score how phone-like a column is, used when nothing matched by name. */
function detectPhoneColumn(headers, rows) {
  let best = { header: '', score: 0 };
  for (const h of headers) {
    let hits = 0;
    const sample = rows.slice(0, 50);
    for (const r of sample) {
      const n = phone.normalize(r[h]);
      if (n && phone.validate(n).ok) hits++;
    }
    const score = sample.length ? hits / sample.length : 0;
    if (score > best.score) best = { header: h, score };
  }
  return best.score >= 0.5 ? best.header : '';
}

/** Build lead records from rows + a column mapping. */
function toLeads(rows, mapping) {
  const out = [];
  rows.forEach((row, idx) => {
    const rawPhone = mapping.phone ? row[mapping.phone] : '';
    const e164 = phone.normalize(rawPhone);
    const check = phone.validate(e164);

    let first = mapping.firstName ? row[mapping.firstName] : '';
    let last = mapping.lastName ? row[mapping.lastName] : '';
    if (!first && !last && mapping.fullName && row[mapping.fullName]) {
      const parts = String(row[mapping.fullName]).trim().split(/\s+/);
      first = parts.shift() || '';
      last = parts.join(' ');
    }

    const used = new Set(
      Object.values(mapping).filter((v) => typeof v === 'string' && v)
    );
    const extra = {};
    for (const [k, v] of Object.entries(row)) {
      if (!used.has(k) && v !== '') extra[k] = v;
    }

    const pick = (key) => (mapping[key] ? row[mapping[key]] : null);
    const deal = {
      monthly_revenue: moneyFromText(pick('monthlyRevenue')),
      annual_revenue: moneyFromText(pick('annualRevenue')),
      time_in_business_months: monthsFromText(pick('timeInBusiness')),
      requested_amount: moneyFromText(pick('requestedAmount')),
      industry: pick('industry') ? String(pick('industry')).slice(0, 120) : '',
      entity_state: pick('state') ? String(pick('state')).trim().slice(0, 40) : '',
      open_positions: intFromText(pick('positions')),
      fico: intFromText(pick('fico')),
    };
    // Fill monthly from annual when only annual was given.
    if (!deal.monthly_revenue && deal.annual_revenue) deal.monthly_revenue = Math.round(deal.annual_revenue / 12);

    out.push({
      rowIndex: idx,
      firstName: first || '',
      lastName: last || '',
      company: mapping.company ? row[mapping.company] || '' : '',
      email: mapping.email ? row[mapping.email] || '' : '',
      phoneRaw: String(rawPhone == null ? '' : rawPhone),
      phone: check.ok ? e164 : null,
      invalidReason: check.ok ? null : check.reason,
      timezone: check.ok ? phone.timezoneFor(e164) : null,
      deal,
      extra,
    });
  });
  return out;
}

/** Export results back out as an .xlsx buffer. */
function buildExport(leads, callsByLead) {
  const rows = leads.map((l) => {
    let extra = {};
    try {
      extra = JSON.parse(l.extra_json || '{}');
    } catch {
      extra = {};
    }
    const calls = callsByLead.get(l.id) || [];
    const last = calls[calls.length - 1];
    return {
      'First Name': l.first_name,
      'Last Name': l.last_name,
      Company: l.company,
      Email: l.email,
      Phone: l.phone || l.phone_raw,
      Stage: l.stage || '',
      'Monthly Revenue': l.monthly_revenue ?? '',
      'Months in Business': l.time_in_business_months ?? '',
      'Amount Requested': l.requested_amount ?? '',
      'Open Positions': l.open_positions ?? '',
      FICO: l.fico ?? '',
      Industry: l.industry || '',
      State: l.entity_state || '',
      'Use of Funds': l.use_of_funds || '',
      'AI Summary': l.ai_summary || '',
      Status: l.status,
      Disposition: l.disposition,
      Attempts: l.attempts,
      'Last Attempt': l.last_attempt || '',
      'Call Outcome': last ? last.outcome : '',
      'Talk Time (s)': calls.reduce((a, c) => a + (c.talk_seconds || 0), 0),
      'Agent': l.agent_name || '',
      Notes: l.notes,
      Recording: last && last.recording_url ? last.recording_url : '',
      ...extra,
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  parseBuffer,
  guessMapping,
  detectPhoneColumn,
  toLeads,
  buildExport,
  monthsFromText,
  moneyFromText,
  intFromText,
};
