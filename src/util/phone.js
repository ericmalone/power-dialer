'use strict';

/**
 * Phone helpers: normalisation to E.164 (North America focused, but any
 * already-E.164 international number passes through untouched) plus a
 * timezone lookup by area code so we can honour calling hours.
 */

const areacodes = require('./areacodes');

// NANP area code -> IANA timezone. Covers US + Canada + common territories.
const AREA_CODE_TZ = {
  201: 'America/New_York', 202: 'America/New_York', 203: 'America/New_York', 204: 'America/Winnipeg',
  205: 'America/Chicago', 206: 'America/Los_Angeles', 207: 'America/New_York', 208: 'America/Boise',
  209: 'America/Los_Angeles', 210: 'America/Chicago', 212: 'America/New_York', 213: 'America/Los_Angeles',
  214: 'America/Chicago', 215: 'America/New_York', 216: 'America/New_York', 217: 'America/Chicago',
  218: 'America/Chicago', 219: 'America/Chicago', 220: 'America/New_York', 223: 'America/New_York',
  224: 'America/Chicago', 225: 'America/Chicago', 226: 'America/Toronto', 228: 'America/Chicago',
  229: 'America/New_York', 231: 'America/New_York', 234: 'America/New_York', 236: 'America/Vancouver',
  239: 'America/New_York', 240: 'America/New_York', 248: 'America/New_York', 249: 'America/Toronto',
  250: 'America/Vancouver', 251: 'America/Chicago', 252: 'America/New_York', 253: 'America/Los_Angeles',
  254: 'America/Chicago', 256: 'America/Chicago', 260: 'America/New_York', 262: 'America/Chicago',
  267: 'America/New_York', 269: 'America/New_York', 270: 'America/Chicago', 272: 'America/New_York',
  276: 'America/New_York', 279: 'America/Los_Angeles', 281: 'America/Chicago',
  289: 'America/Toronto', 301: 'America/New_York', 302: 'America/New_York', 303: 'America/Denver',
  304: 'America/New_York', 305: 'America/New_York', 306: 'America/Regina', 307: 'America/Denver',
  308: 'America/Chicago', 309: 'America/Chicago', 310: 'America/Los_Angeles', 312: 'America/Chicago',
  313: 'America/New_York', 314: 'America/Chicago', 315: 'America/New_York', 316: 'America/Chicago',
  317: 'America/New_York', 318: 'America/Chicago', 319: 'America/Chicago', 320: 'America/Chicago',
  321: 'America/New_York', 323: 'America/Los_Angeles', 325: 'America/Chicago', 330: 'America/New_York',
  331: 'America/Chicago', 332: 'America/New_York', 334: 'America/Chicago', 336: 'America/New_York',
  337: 'America/Chicago', 339: 'America/New_York', 340: 'America/St_Thomas', 343: 'America/Toronto',
  346: 'America/Chicago', 347: 'America/New_York', 351: 'America/New_York', 352: 'America/New_York',
  360: 'America/Los_Angeles', 361: 'America/Chicago', 364: 'America/Chicago', 365: 'America/Toronto',
  367: 'America/Montreal', 380: 'America/New_York', 385: 'America/Denver', 386: 'America/New_York',
  401: 'America/New_York', 402: 'America/Chicago', 403: 'America/Edmonton', 404: 'America/New_York',
  405: 'America/Chicago', 406: 'America/Denver', 407: 'America/New_York', 408: 'America/Los_Angeles',
  409: 'America/Chicago', 410: 'America/New_York', 412: 'America/New_York', 413: 'America/New_York',
  414: 'America/Chicago', 415: 'America/Los_Angeles', 416: 'America/Toronto', 417: 'America/Chicago',
  418: 'America/Montreal', 419: 'America/New_York', 423: 'America/New_York', 424: 'America/Los_Angeles',
  425: 'America/Los_Angeles', 430: 'America/Chicago', 431: 'America/Winnipeg', 432: 'America/Chicago',
  434: 'America/New_York', 435: 'America/Denver', 437: 'America/Toronto', 438: 'America/Montreal',
  440: 'America/New_York', 442: 'America/Los_Angeles', 443: 'America/New_York', 445: 'America/New_York',
  447: 'America/Chicago', 450: 'America/Montreal', 458: 'America/Los_Angeles', 463: 'America/New_York',
  469: 'America/Chicago', 470: 'America/New_York', 475: 'America/New_York', 478: 'America/New_York',
  479: 'America/Chicago', 480: 'America/Phoenix', 484: 'America/New_York',
  501: 'America/Chicago', 502: 'America/New_York', 503: 'America/Los_Angeles', 504: 'America/Chicago',
  505: 'America/Denver', 506: 'America/Halifax', 507: 'America/Chicago', 508: 'America/New_York',
  509: 'America/Los_Angeles', 510: 'America/Los_Angeles', 512: 'America/Chicago', 513: 'America/New_York',
  514: 'America/Montreal', 515: 'America/Chicago', 516: 'America/New_York', 517: 'America/New_York',
  518: 'America/New_York', 519: 'America/Toronto', 520: 'America/Phoenix', 530: 'America/Los_Angeles',
  531: 'America/Chicago', 534: 'America/Chicago', 539: 'America/Chicago', 540: 'America/New_York',
  541: 'America/Los_Angeles', 548: 'America/Toronto', 551: 'America/New_York', 559: 'America/Los_Angeles',
  561: 'America/New_York', 562: 'America/Los_Angeles', 563: 'America/Chicago', 564: 'America/Los_Angeles',
  567: 'America/New_York', 570: 'America/New_York', 571: 'America/New_York', 573: 'America/Chicago',
  574: 'America/New_York', 575: 'America/Denver', 579: 'America/Montreal', 580: 'America/Chicago',
  581: 'America/Montreal', 585: 'America/New_York', 586: 'America/New_York', 587: 'America/Edmonton',
  601: 'America/Chicago', 602: 'America/Phoenix', 603: 'America/New_York', 604: 'America/Vancouver',
  605: 'America/Chicago', 606: 'America/New_York', 607: 'America/New_York', 608: 'America/Chicago',
  609: 'America/New_York', 610: 'America/New_York', 612: 'America/Chicago', 613: 'America/Toronto',
  614: 'America/New_York', 615: 'America/Chicago', 616: 'America/New_York', 617: 'America/New_York',
  618: 'America/Chicago', 619: 'America/Los_Angeles', 620: 'America/Chicago', 623: 'America/Phoenix',
  626: 'America/Los_Angeles', 628: 'America/Los_Angeles', 629: 'America/Chicago', 630: 'America/Chicago',
  631: 'America/New_York', 636: 'America/Chicago', 639: 'America/Regina', 640: 'America/New_York',
  641: 'America/Chicago', 646: 'America/New_York', 647: 'America/Toronto', 650: 'America/Los_Angeles',
  651: 'America/Chicago', 657: 'America/Los_Angeles', 660: 'America/Chicago', 661: 'America/Los_Angeles',
  662: 'America/Chicago', 667: 'America/New_York', 669: 'America/Los_Angeles', 671: 'Pacific/Guam',
  678: 'America/New_York', 680: 'America/New_York', 681: 'America/New_York', 682: 'America/Chicago',
  684: 'Pacific/Pago_Pago', 701: 'America/Chicago', 702: 'America/Los_Angeles', 703: 'America/New_York',
  704: 'America/New_York', 705: 'America/Toronto', 706: 'America/New_York', 707: 'America/Los_Angeles',
  708: 'America/Chicago', 709: 'America/St_Johns', 712: 'America/Chicago', 713: 'America/Chicago',
  714: 'America/Los_Angeles', 715: 'America/Chicago', 716: 'America/New_York', 717: 'America/New_York',
  718: 'America/New_York', 719: 'America/Denver', 720: 'America/Denver', 724: 'America/New_York',
  725: 'America/Los_Angeles', 726: 'America/Chicago', 727: 'America/New_York', 731: 'America/Chicago',
  732: 'America/New_York', 734: 'America/New_York', 737: 'America/Chicago', 740: 'America/New_York',
  743: 'America/New_York', 747: 'America/Los_Angeles', 754: 'America/New_York', 757: 'America/New_York',
  760: 'America/Los_Angeles', 762: 'America/New_York', 763: 'America/Chicago', 765: 'America/New_York',
  769: 'America/Chicago', 770: 'America/New_York', 772: 'America/New_York', 773: 'America/Chicago',
  774: 'America/New_York', 775: 'America/Los_Angeles', 778: 'America/Vancouver', 779: 'America/Chicago',
  780: 'America/Edmonton', 781: 'America/New_York', 782: 'America/Halifax', 785: 'America/Chicago',
  786: 'America/New_York', 787: 'America/Puerto_Rico',
  801: 'America/Denver', 802: 'America/New_York', 803: 'America/New_York', 804: 'America/New_York',
  805: 'America/Los_Angeles', 806: 'America/Chicago', 807: 'America/Toronto', 808: 'Pacific/Honolulu',
  810: 'America/New_York', 812: 'America/New_York', 813: 'America/New_York', 814: 'America/New_York',
  815: 'America/Chicago', 816: 'America/Chicago', 817: 'America/Chicago', 818: 'America/Los_Angeles',
  819: 'America/Montreal', 820: 'America/Los_Angeles', 825: 'America/Edmonton', 828: 'America/New_York',
  830: 'America/Chicago', 831: 'America/Los_Angeles', 832: 'America/Chicago', 838: 'America/New_York',
  843: 'America/New_York', 845: 'America/New_York', 847: 'America/Chicago', 848: 'America/New_York',
  850: 'America/Chicago', 854: 'America/New_York', 856: 'America/New_York', 857: 'America/New_York',
  858: 'America/Los_Angeles', 859: 'America/New_York', 860: 'America/New_York', 862: 'America/New_York',
  863: 'America/New_York', 864: 'America/New_York', 865: 'America/New_York', 867: 'America/Whitehorse',
  870: 'America/Chicago', 872: 'America/Chicago', 873: 'America/Montreal', 878: 'America/New_York',
  901: 'America/Chicago', 902: 'America/Halifax', 903: 'America/Chicago', 904: 'America/New_York',
  905: 'America/Toronto', 906: 'America/New_York', 907: 'America/Anchorage', 908: 'America/New_York',
  909: 'America/Los_Angeles', 910: 'America/New_York', 912: 'America/New_York', 913: 'America/Chicago',
  914: 'America/New_York', 915: 'America/Denver', 916: 'America/Los_Angeles', 917: 'America/New_York',
  918: 'America/Chicago', 919: 'America/New_York', 920: 'America/Chicago', 925: 'America/Los_Angeles',
  928: 'America/Phoenix', 929: 'America/New_York', 930: 'America/New_York', 931: 'America/Chicago',
  934: 'America/New_York', 936: 'America/Chicago', 937: 'America/New_York', 938: 'America/Chicago',
  940: 'America/Chicago', 941: 'America/New_York', 947: 'America/New_York', 949: 'America/Los_Angeles',
  951: 'America/Los_Angeles', 952: 'America/Chicago', 954: 'America/New_York', 956: 'America/Chicago',
  959: 'America/New_York', 970: 'America/Denver', 971: 'America/Los_Angeles', 972: 'America/Chicago',
  973: 'America/New_York', 975: 'America/Chicago', 978: 'America/New_York', 979: 'America/Chicago',
  980: 'America/New_York', 984: 'America/New_York', 985: 'America/Chicago', 986: 'America/Boise',
  989: 'America/New_York',
};

// Area codes that are premium / toll-free and should never be auto-dialed.
const BLOCKED_AREA_CODES = new Set([
  '900', '976', '800', '833', '844', '855', '866', '877', '888',
]);

/**
 * Normalise a raw spreadsheet value into E.164.
 * Returns null when the value cannot be a dialable number.
 */
function normalize(raw, defaultCountry = '1') {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Spreadsheets love turning phone numbers into 5.5551234567e9
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);
  // ...or into 2125551234.0
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');

  const hadPlus = s.trim().startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  // Strip a leading international access prefix people paste in.
  if (!hadPlus && digits.length > 11 && digits.startsWith('011')) digits = digits.slice(3);

  if (hadPlus) {
    // Trust an explicit + prefix for international numbers.
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;

  return null;
}

/** True when the number is a well-formed North American number. */
function isNanp(e164) {
  return typeof e164 === 'string' && /^\+1\d{10}$/.test(e164);
}

function areaCode(e164) {
  return isNanp(e164) ? e164.slice(2, 5) : null;
}

/**
 * Basic sanity checks beyond formatting. Returns { ok, reason }.
 */
function validate(e164) {
  if (!e164) return { ok: false, reason: 'unparseable' };
  if (!/^\+\d{8,15}$/.test(e164)) return { ok: false, reason: 'bad_format' };

  if (isNanp(e164)) {
    const ac = e164.slice(2, 5);
    const exch = e164.slice(5, 8);
    if (BLOCKED_AREA_CODES.has(ac)) return { ok: false, reason: 'toll_free_or_premium' };
    if (ac[0] === '0' || ac[0] === '1') return { ok: false, reason: 'invalid_area_code' };
    if (exch[0] === '0' || exch[0] === '1') return { ok: false, reason: 'invalid_exchange' };
    if (ac[1] === '9' && ac[2] === '9' && ac[0] === '5') return { ok: false, reason: 'reserved' };
  }
  return { ok: true, reason: null };
}

function timezoneFor(e164) {
  const ac = areaCode(e164);
  if (!ac) return null;
  return AREA_CODE_TZ[Number(ac)] || null;
}

/** Two-letter state or province for a number, or null outside the NANP. */
function stateFor(e164) {
  return areacodes.stateForAreaCode(areaCode(e164));
}

/** "New York" rather than "NY", for anything a person reads. */
function regionFor(e164) {
  const st = stateFor(e164);
  return st ? areacodes.regionName(st) : null;
}

/** Everything we know about where a number sits, in one call. */
function place(e164) {
  const ac = areaCode(e164);
  const state = areacodes.stateForAreaCode(ac);
  return {
    areaCode: ac,
    state,
    region: state ? areacodes.regionName(state) : null,
    timezone: ac ? AREA_CODE_TZ[Number(ac)] || null : null,
  };
}

/**
 * Local hour (0-23) at the lead's location, or null if unknown.
 */
function localHour(e164, now = new Date()) {
  const tz = timezoneFor(e164);
  if (!tz) return null;
  try {
    const h = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    }).format(now);
    const n = parseInt(h, 10);
    return Number.isFinite(n) ? n % 24 : null;
  } catch {
    return null;
  }
}

/**
 * Is it legal-hours to call this number right now?
 * Unknown timezone => allowed (we don't block on missing data), caller decides.
 */
function withinCallingHours(e164, startHour, endHour, now = new Date()) {
  const h = localHour(e164, now);
  if (h === null) return { ok: true, hour: null, tz: null };
  return { ok: h >= startHour && h < endHour, hour: h, tz: timezoneFor(e164) };
}

/** Pretty display: +15551234567 -> (555) 123-4567 */
function format(e164) {
  if (!e164) return '';
  if (isNanp(e164)) {
    const d = e164.slice(2);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return e164;
}

module.exports = {
  normalize,
  validate,
  isNanp,
  areaCode,
  timezoneFor,
  stateFor,
  regionFor,
  place,
  regionName: areacodes.regionName,
  localHour,
  withinCallingHours,
  format,
  AREA_CODE_TZ,
  BLOCKED_AREA_CODES,
};
