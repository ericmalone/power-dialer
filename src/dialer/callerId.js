'use strict';

/**
 * Which of your numbers should this merchant see?
 *
 * People answer a number that looks like their neighbour. The order of
 * preference, best first:
 *
 *   0. The number that already called them - a repeat attempt should look
 *      like the same person calling back, not a new stranger every time.
 *   1. A number in their own area code.
 *   2. A number in their state.
 *   3. A number in their timezone - at least the call is not coming from
 *      three hours away.
 *   4. Anything active.
 *
 * Within whichever tier wins, the least recently used number goes first, so
 * one poor number does not carry the whole floor and get flagged for it.
 */

const { db, settings } = require('../db');
const phone = require('../util/phone');

const STRATEGIES = {
  local: 'Area code, then state, then timezone',
  exact: 'Only an exact area code match',
  off: 'Do not match - just rotate evenly',
};

/** Reads the current setting, honouring the old on/off checkbox. */
function strategy() {
  const explicit = settings.get('caller_id_strategy', null);
  if (explicit && STRATEGIES[explicit]) return explicit;
  return settings.getBool('match_area_code', true) ? 'local' : 'off';
}

/** Fill in area code / state / timezone for any number missing them. */
function backfillPlaces() {
  const rows = db.prepare("SELECT id, phone FROM caller_ids WHERE area_code = '' OR area_code IS NULL").all();
  if (!rows.length) return 0;
  const upd = db.prepare('UPDATE caller_ids SET area_code = ?, state = ?, timezone = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      const p = phone.place(r.phone);
      upd.run(p.areaCode || '', p.state || '', p.timezone || '', r.id);
    }
  });
  tx();
  return rows.length;
}

function pool({ smsOnly = false } = {}) {
  backfillPlaces();
  return db
    .prepare(
      `SELECT id, phone, area_code, state, timezone, last_used_at, use_count
       FROM caller_ids WHERE active = 1 ${smsOnly ? 'AND sms_capable = 1' : ''}`
    )
    .all();
}

/**
 * SQLite hands back "2026-08-22 12:50:00" while anything we write ourselves is
 * ISO. Compare on real timestamps so the two formats cannot sort against each
 * other wrongly.
 */
function usedAtMs(value) {
  if (!value) return 0; // never used - goes first
  const iso = /[T]/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Least recently used first; never-used numbers before used ones. */
function leastUsed(candidates) {
  return [...candidates].sort((a, b) => {
    const at = usedAtMs(a.last_used_at);
    const bt = usedAtMs(b.last_used_at);
    if (at !== bt) return at - bt;
    if (a.use_count !== b.use_count) return a.use_count - b.use_count;
    return a.id - b.id;
  })[0];
}

/**
 * Choose a number to call or text from.
 *
 * @param {object} opts
 * @param {string} opts.toNumber   the merchant's number, E.164
 * @param {number} [opts.leadId]   so repeat attempts stay on the same number
 * @param {boolean} [opts.smsOnly] restrict to numbers marked for texting
 * @param {boolean} [opts.record]  update usage counters (false for previews)
 * @returns {{phone: string, match: string, region: string|null}|null}
 */
function pick({ toNumber, leadId = null, smsOnly = false, record = true }) {
  const candidates = pool({ smsOnly });
  if (!candidates.length) return null;

  const target = phone.place(toNumber);
  const mode = strategy();

  // 0. Stay on the number this merchant already knows.
  if (leadId) {
    const lead = db.prepare('SELECT preferred_caller_id FROM leads WHERE id = ?').get(leadId);
    if (lead && lead.preferred_caller_id) {
      const stuck = candidates.find((c) => c.phone === lead.preferred_caller_id);
      if (stuck) return finish(stuck, 'same as last time', target, leadId, record);
    }
  }

  const tiers = [];
  if (mode !== 'off' && target.areaCode) {
    tiers.push({ match: 'area code', rows: candidates.filter((c) => c.area_code === target.areaCode) });
  }
  if (mode === 'local' && target.state) {
    tiers.push({ match: 'state', rows: candidates.filter((c) => c.state === target.state) });
  }
  if (mode === 'local' && target.timezone) {
    tiers.push({ match: 'timezone', rows: candidates.filter((c) => c.timezone === target.timezone) });
  }
  tiers.push({ match: mode === 'off' ? 'rotation' : 'no local number', rows: candidates });

  for (const tier of tiers) {
    if (tier.rows.length) return finish(leastUsed(tier.rows), tier.match, target, leadId, record);
  }
  return null;
}

function finish(row, match, target, leadId, record) {
  if (record) {
    db.prepare("UPDATE caller_ids SET last_used_at = datetime('now'), use_count = use_count + 1 WHERE id = ?").run(
      row.id
    );
    if (leadId) {
      db.prepare('UPDATE leads SET preferred_caller_id = ? WHERE id = ? AND preferred_caller_id IS NULL').run(
        row.phone,
        leadId
      );
    }
  }
  return { phone: row.phone, match, region: target.region || null };
}

/**
 * How much of your list can you actually match, and what should you buy next?
 */
function coverage({ listId = null } = {}) {
  backfillPlaces();
  const mine = pool();
  const myAreaCodes = new Set(mine.map((c) => c.area_code).filter(Boolean));
  const myStates = new Set(mine.map((c) => c.state).filter(Boolean));
  const myZones = new Set(mine.map((c) => c.timezone).filter(Boolean));

  const rows = db
    .prepare(
      `SELECT substr(phone, 3, 3) AS ac, COUNT(*) n FROM leads
       WHERE phone LIKE '+1%' AND length(phone) = 12
         AND status NOT IN ('dnc','invalid')
         ${listId ? 'AND list_id = @listId' : ''}
       GROUP BY ac ORDER BY n DESC`
    )
    .all(listId ? { listId: Number(listId) } : {});

  let exact = 0;
  let state = 0;
  let zone = 0;
  let none = 0;
  const gaps = [];

  for (const r of rows) {
    const place = phone.place(`+1${r.ac}5550100`);
    if (myAreaCodes.has(r.ac)) {
      exact += r.n;
    } else if (place.state && myStates.has(place.state)) {
      state += r.n;
      gaps.push({ areaCode: r.ac, leads: r.n, region: place.region, level: 'state' });
    } else if (place.timezone && myZones.has(place.timezone)) {
      zone += r.n;
      gaps.push({ areaCode: r.ac, leads: r.n, region: place.region, level: 'timezone' });
    } else {
      none += r.n;
      gaps.push({ areaCode: r.ac, leads: r.n, region: place.region, level: 'none' });
    }
  }

  const total = exact + state + zone + none;
  return {
    numbers: mine.map((c) => ({
      phone: c.phone,
      areaCode: c.area_code,
      state: c.state,
      region: c.state ? phone.regionName(c.state) : null,
      useCount: c.use_count,
      lastUsedAt: c.last_used_at,
    })),
    strategy: strategy(),
    totals: {
      leads: total,
      exact,
      state,
      timezone: zone,
      none,
      exactPct: total ? exact / total : 0,
      statePct: total ? state / total : 0,
      timezonePct: total ? zone / total : 0,
      nonePct: total ? none / total : 0,
    },
    // The area codes worth buying a number in, biggest first.
    gaps: gaps.sort((a, b) => b.leads - a.leads).slice(0, 15),
    areaCodesInList: rows.length,
  };
}

module.exports = { pick, coverage, strategy, STRATEGIES, backfillPlaces, leastUsed, usedAtMs };
