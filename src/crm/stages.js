'use strict';

/**
 * The merchant cash advance pipeline. A deal walks left to right; the three
 * closed stages at the end take it off the board.
 */

const STAGES = [
  { code: 'new', label: 'New lead', kind: 'open', order: 10, hint: 'Imported, never worked' },
  { code: 'contacted', label: 'Contacted', kind: 'open', order: 20, hint: 'Spoke to the owner' },
  { code: 'qualified', label: 'Qualified', kind: 'open', order: 30, hint: 'Revenue and time in business check out' },
  { code: 'app_out', label: 'Application out', kind: 'open', order: 40, hint: 'One-page app sent' },
  { code: 'docs_in', label: 'Docs received', kind: 'open', order: 50, hint: 'App back, bank statements in' },
  { code: 'underwriting', label: 'Underwriting', kind: 'open', order: 60, hint: 'Submitted to funders' },
  { code: 'offer', label: 'Offer out', kind: 'open', order: 70, hint: 'Terms presented to the merchant' },
  { code: 'funded', label: 'Funded', kind: 'won', order: 80, hint: 'Money hit their account' },
  { code: 'declined', label: 'Declined', kind: 'lost', order: 90, hint: 'Funders passed' },
  { code: 'dead', label: 'Dead', kind: 'lost', order: 100, hint: 'Not interested, unreachable, or DNC' },
];

const BY_CODE = new Map(STAGES.map((s) => [s.code, s]));

function isStage(code) {
  return BY_CODE.has(code);
}

function stage(code) {
  return BY_CODE.get(code) || STAGES[0];
}

function isClosed(code) {
  const s = BY_CODE.get(code);
  return Boolean(s && s.kind !== 'open');
}

/** Where a disposition should push the deal, when the rep has not moved it themselves. */
const DISPOSITION_TO_STAGE = {
  interested: 'contacted',
  appointment: 'qualified',
  application: 'app_out',
  callback: 'contacted',
  not_interested: 'dead',
  not_qualified: 'declined',
  wrong_number: 'dead',
  dnc: 'dead',
};

/** Standard MCA decline / dead reasons, offered as a picklist. */
const LOST_REASONS = [
  'Not interested',
  'Already funded elsewhere',
  'Too many open positions',
  'Revenue too low',
  'Under 6 months in business',
  'Restricted industry',
  'Credit too weak',
  'Excessive NSFs / negative days',
  'Would not send statements',
  'Unreachable',
  'Do not call',
];

/** Rough qualification screen used to flag a lead in the UI. */
function qualify(lead) {
  const flags = [];
  const rev = lead.monthly_revenue;
  const tib = lead.time_in_business_months;

  if (rev !== null && rev !== undefined && rev < 10000) flags.push('Monthly revenue under $10k');
  if (tib !== null && tib !== undefined && tib < 6) flags.push('Under 6 months in business');
  if (lead.open_positions !== null && lead.open_positions !== undefined && lead.open_positions >= 3) {
    flags.push(`${lead.open_positions} open positions`);
  }
  if (lead.fico !== null && lead.fico !== undefined && lead.fico < 500) flags.push('FICO under 500');
  if (lead.nsf_count !== null && lead.nsf_count !== undefined && lead.nsf_count > 5) {
    flags.push(`${lead.nsf_count} NSFs`);
  }

  const known = [rev, tib].filter((v) => v !== null && v !== undefined).length;
  let verdict = 'unknown';
  if (known >= 2) verdict = flags.length ? 'weak' : 'strong';
  else if (flags.length) verdict = 'weak';

  return { verdict, flags };
}

module.exports = { STAGES, BY_CODE, isStage, stage, isClosed, DISPOSITION_TO_STAGE, LOST_REASONS, qualify };
