/* Power Dialer - dialing and talk time reports */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  // ---------------------------------------------------------------- formatting
  const hms = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };
  const mins = (s) => Math.round((s || 0) / 60);
  const pct = (v) => `${((v || 0) * 100).toFixed(v >= 0.1 ? 0 : 1)}%`;
  const num = (v) => Number(v || 0).toLocaleString('en-US');

  const S = { meta: null, report: null, compare: null };

  function query() {
    const p = new URLSearchParams();
    p.set('preset', $('fPreset').value);
    if ($('fPreset').value === 'custom') {
      p.set('from', $('fFrom').value);
      p.set('to', $('fTo').value);
    }
    p.set('groupBy', $('fGroup').value);
    if ($('fList').value) p.set('list', $('fList').value);
    if (!$('fAgent').classList.contains('hidden') && $('fAgent').value) p.set('agents', $('fAgent').value);
    return p;
  }

  // ---------------------------------------------------------------- charts
  /** Rounded on the data end, square at the baseline. */
  function columnPath(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, h, w / 2));
    if (h <= 0) return '';
    return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
  }

  function niceTicks(max, count = 4) {
    if (max <= 0) return [0];
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const out = [];
    for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }

  function tooltip(host) {
    let el = host.querySelector('.tt');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tt';
      host.appendChild(el);
    }
    return {
      show(html, x, y) {
        el.innerHTML = html;
        el.classList.add('on');
        const w = el.offsetWidth;
        const hostW = host.clientWidth;
        el.style.left = `${Math.max(4, Math.min(hostW - w - 4, x - w / 2))}px`;
        el.style.top = `${Math.max(0, y - el.offsetHeight - 10)}px`;
      },
      hide() {
        el.classList.remove('on');
      },
    };
  }

  /**
   * Stacked columns: the connected part sits on the baseline, the rest above.
   * A 2px surface gap does the separating - no strokes.
   */
  function drawActivity(host, rows) {
    const W = 1200;
    const H = 250;
    const PAD = { t: 14, r: 8, b: 30, l: 40 };
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const max = Math.max(1, ...rows.map((r) => r.dials));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const band = innerW / Math.max(1, rows.length);
    const bw = Math.min(16, Math.max(3, band * 0.6));
    const y = (v) => PAD.t + innerH - (v / top) * innerH;

    const tip = tooltip(host);
    const everyNth = Math.ceil(rows.length / 12);

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dials and connects over time">`;
    svg += '<g class="grid">';
    for (const t of ticks) svg += `<line x1="${PAD.l}" y1="${y(t)}" x2="${W - PAD.r}" y2="${y(t)}" />`;
    svg += '</g><g class="axis">';
    for (const t of ticks) svg += `<text x="${PAD.l - 8}" y="${y(t) + 4}" text-anchor="end">${num(t)}</text>`;

    rows.forEach((r, i) => {
      const cx = PAD.l + band * i + band / 2;
      if (i % everyNth === 0 || rows.length <= 12) {
        svg += `<text x="${cx}" y="${H - 10}" text-anchor="middle">${esc(r.label)}</text>`;
      }
    });
    svg += '</g>';

    rows.forEach((r, i) => {
      const x = PAD.l + band * i + (band - bw) / 2;
      const connH = (r.connects / top) * innerH;
      const restH = ((r.dials - r.connects) / top) * innerH;
      const baseY = PAD.t + innerH;
      const GAP = 2;

      svg += `<g class="band" data-i="${i}">`;
      if (restH > 0) {
        const topY = baseY - connH - restH;
        svg += `<path class="mark" d="${columnPath(x, topY, bw, Math.max(1, restH - (connH > 0 ? GAP : 0)), 4)}" fill="var(--series-rest)"></path>`;
      }
      if (connH > 0) {
        const p = restH > 0 ? columnPath(x, baseY - connH, bw, connH, 0) : columnPath(x, baseY - connH, bw, connH, 4);
        svg += `<path class="mark" d="${p}" fill="var(--series-1)"></path>`;
      }
      svg += `<rect class="hit" x="${PAD.l + band * i}" y="${PAD.t}" width="${band}" height="${innerH}" data-i="${i}"></rect>`;
      svg += '</g>';
    });
    svg += '</svg>';
    host.innerHTML = svg;

    host.querySelectorAll('.hit').forEach((hit) => {
      hit.addEventListener('mousemove', (e) => {
        const r = rows[Number(hit.dataset.i)];
        const box = host.getBoundingClientRect();
        tip.show(
          `<b>${esc(r.label)}</b>
           <div class="r"><span>Dials</span><span>${num(r.dials)}</span></div>
           <div class="r"><span>Connects</span><span>${num(r.connects)}</span></div>
           <div class="r"><span>Contact rate</span><span>${r.dials ? pct(r.connects / r.dials) : '-'}</span></div>
           <div class="r"><span>Talk time</span><span>${hms(r.talk_seconds)}</span></div>`,
          e.clientX - box.left,
          e.clientY - box.top
        );
      });
      hit.addEventListener('mouseleave', () => tip.hide());
    });
  }

  /** Single-series columns: talk minutes. One color, value labelled on the peak only. */
  function drawTalk(host, rows) {
    const W = 1200;
    const H = 200;
    const PAD = { t: 30, r: 8, b: 30, l: 44 };
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const values = rows.map((r) => mins(r.talk_seconds));
    const max = Math.max(1, ...values);
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const band = innerW / Math.max(1, rows.length);
    const bw = Math.min(16, Math.max(3, band * 0.6));
    const y = (v) => PAD.t + innerH - (v / top) * innerH;
    const peak = values.indexOf(Math.max(...values));

    const tip = tooltip(host);
    const everyNth = Math.ceil(rows.length / 12);

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Talk time in minutes">`;
    svg += '<g class="grid">';
    for (const t of ticks) svg += `<line x1="${PAD.l}" y1="${y(t)}" x2="${W - PAD.r}" y2="${y(t)}" />`;
    svg += '</g><g class="axis">';
    for (const t of ticks) svg += `<text x="${PAD.l - 8}" y="${y(t) + 4}" text-anchor="end">${num(t)}m</text>`;
    rows.forEach((r, i) => {
      const cx = PAD.l + band * i + band / 2;
      if (i % everyNth === 0 || rows.length <= 12) {
        svg += `<text x="${cx}" y="${H - 10}" text-anchor="middle">${esc(r.label)}</text>`;
      }
    });
    svg += '</g>';

    rows.forEach((r, i) => {
      const v = values[i];
      const x = PAD.l + band * i + (band - bw) / 2;
      const h = (v / top) * innerH;
      svg += `<g class="band"><path class="mark" d="${columnPath(x, PAD.t + innerH - h, bw, h, 4)}" fill="var(--series-1)"></path>`;
      svg += `<rect class="hit" x="${PAD.l + band * i}" y="${PAD.t}" width="${band}" height="${innerH}" data-i="${i}"></rect></g>`;
    });
    if (values[peak] > 0) {
      const x = PAD.l + band * peak + band / 2;
      svg += `<text class="val" x="${x}" y="${y(values[peak]) - 7}" text-anchor="middle">${num(values[peak])}m</text>`;
    }
    svg += '</svg>';
    host.innerHTML = svg;

    host.querySelectorAll('.hit').forEach((hit) => {
      hit.addEventListener('mousemove', (e) => {
        const r = rows[Number(hit.dataset.i)];
        const box = host.getBoundingClientRect();
        tip.show(
          `<b>${esc(r.label)}</b>
           <div class="r"><span>Talk time</span><span>${hms(r.talk_seconds)}</span></div>
           <div class="r"><span>Connects</span><span>${num(r.connects)}</span></div>
           <div class="r"><span>Avg per connect</span><span>${r.connects ? hms(r.talk_seconds / r.connects) : '-'}</span></div>
           <div class="r"><span>Longest</span><span>${hms(r.longest_talk)}</span></div>`,
          e.clientX - box.left,
          e.clientY - box.top
        );
      });
      hit.addEventListener('mouseleave', () => tip.hide());
    });
  }

  /** Horizontal bars with the value at the tip - one hue, no ramp. */
  function drawBars(host, items) {
    const max = Math.max(1, ...items.map((i) => i.value));
    host.innerHTML = items.length
      ? items
          .map(
            (i) => `<div class="bar-row">
        <span>${esc(i.label)}</span>
        <span class="track"><span class="fill" style="width:${Math.max(i.value ? 2 : 0, (i.value / max) * 100)}%"></span></span>
        <span class="amt">${esc(i.display)}</span>
      </div>`
          )
          .join('')
      : '<p class="small muted">Nothing in this range.</p>';
  }

  // ---------------------------------------------------------------- deltas
  function delta(el, entry, { asPercent = false, asTime = false } = {}) {
    if (!entry || entry.before === 0) {
      el.innerHTML = '<span class="delta flat">no earlier period</span>';
      return;
    }
    const d = entry.delta;
    const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '–';
    const shown = asPercent
      ? `${(Math.abs(d) * 100).toFixed(1)} pts`
      : asTime
      ? hms(Math.abs(d))
      : num(Math.abs(d));
    const rel = entry.pct === null ? '' : ` (${d > 0 ? '+' : d < 0 ? '-' : ''}${Math.abs(entry.pct * 100).toFixed(0)}%)`;
    el.innerHTML = `<span class="delta ${dir}">${arrow} ${shown}${rel} vs previous</span>`;
  }

  // ---------------------------------------------------------------- render
  function render(data) {
    const s = data.current.summary;
    const r = data.current;
    S.report = r;

    $('rangeNote').textContent = `${r.range.from} to ${r.range.to} · ${r.range.timezone.replace('_', ' ')}`;

    $('kDials').textContent = num(s.dials);
    $('kConnects').textContent = num(s.connects);
    $('kRate').textContent = pct(s.contactRate);
    $('kMerchants').textContent = num(s.merchantsTouched);
    $('kVoicemail').textContent = num(s.voicemails);
    $('kNoAnswer').textContent = num(s.noAnswers);

    $('kTalk').textContent = hms(s.talkSeconds);
    $('kAvg').textContent = hms(s.avgTalkSeconds);
    $('kLongest').textContent = hms(s.longestTalkSeconds);
    $('kOnDialer').textContent = s.hoursOnDialer ? `${s.hoursOnDialer.toFixed(1)}h` : '-';
    $('kTalkPerHour').textContent = s.talkPerHour === null ? '-' : `${Math.round(s.talkPerHour / 60)}m`;
    $('kUtil').textContent = s.utilisation === null ? '-' : pct(s.utilisation);

    delta($('dDials'), data.change.dials);
    delta($('dConnects'), data.change.connects);
    delta($('dRate'), data.change.contactRate, { asPercent: true });
    delta($('dTalk'), data.change.talkSeconds, { asTime: true });
    delta($('dAvg'), data.change.avgTalkSeconds, { asTime: true });

    $('kTexts').textContent = num(s.textsSent);
    $('kReplies').textContent = num(s.textsReceived);
    $('kCbBooked').textContent = num(s.callbacksBooked);
    $('kCbDone').textContent = num(s.callbacksCompleted);
    $('kCbMissed').textContent = num(s.callbacksMissed);
    $('kFunded').textContent = num(s.funded);

    const gl = r.groupLabel.replace(/^By /, '');
    $('titleActivity').textContent = `Dials and connects by ${gl}`;
    $('titleTalk').textContent = `Talk time by ${gl}`;

    drawActivity($('vizActivity'), r.series);
    drawTalk($('vizTalk'), r.series);

    drawBars(
      $('spread'),
      r.talkSpread.map((b) => ({ label: b.label, value: b.n, display: `${num(b.n)} call${b.n === 1 ? '' : 's'}` }))
    );
    drawBars(
      $('dispositions'),
      r.dispositions.slice(0, 10).map((d) => ({
        label: d.label,
        value: d.n,
        display: `${num(d.n)} · ${hms(d.talkSeconds)}`,
      }))
    );

    renderTable(r);
  }

  function renderTable(r) {
    $('tableView').innerHTML = `<table>
      <thead><tr><th>${esc(r.groupLabel.replace(/^By /, ''))}</th><th>Dials</th><th>Connects</th><th>Contact rate</th><th>Talk time</th><th>Avg per connect</th><th>Longest</th></tr></thead>
      <tbody>${r.series
        .map(
          (row) => `<tr><td>${esc(row.label)}</td><td>${num(row.dials)}</td><td>${num(row.connects)}</td>
          <td>${row.dials ? pct(row.connects / row.dials) : '-'}</td>
          <td>${hms(row.talk_seconds)}</td>
          <td>${row.connects ? hms(row.talk_seconds / row.connects) : '-'}</td>
          <td>${hms(row.longest_talk)}</td></tr>`
        )
        .join('')}</tbody></table>`;
  }

  async function loadCalls() {
    const p = query();
    p.set('limit', '500');
    const { calls } = await api(`/api/reports/calls?${p}`);
    $('callsView').innerHTML = calls.length
      ? `<table><thead><tr><th>When</th><th>Agent</th><th>Business</th><th>Number</th><th>Outcome</th><th>Disposition</th><th>Talk</th></tr></thead>
        <tbody>${calls
          .map(
            (c) => `<tr><td class="small muted">${esc(c.local_time)}</td><td>${esc(c.agent || '')}</td>
            <td>${esc(c.company || [c.first_name, c.last_name].filter(Boolean).join(' '))}</td>
            <td>${esc(c.to_number)}</td><td>${esc(c.outcome)}</td><td>${esc(c.disposition)}</td>
            <td>${hms(c.talk_seconds)}</td></tr>`
          )
          .join('')}</tbody></table>
        <p class="small muted mt">Showing the most recent ${calls.length}. The Excel download has every one.</p>`
      : '<p class="small muted">No calls in this range.</p>';
  }

  async function loadBoard() {
    if (!S.meta.leaderboardVisible) return;
    const p = new URLSearchParams();
    p.set('preset', $('fPreset').value);
    if ($('fPreset').value === 'custom') {
      p.set('from', $('fFrom').value);
      p.set('to', $('fTo').value);
    }
    if ($('fList').value) p.set('list', $('fList').value);
    try {
      const { rows } = await api(`/api/reports/leaderboard?${p}`);
      const active = rows.filter((x) => x.dials > 0);
      if (!active.length) {
        $('boardCard').classList.add('hidden');
        return;
      }
      $('boardCard').classList.remove('hidden');
      $('boardRows').innerHTML = active
        .map(
          (x) => `<tr${x.id === S.meta.me.id ? ' style="background:rgba(57,135,229,.08)"' : ''}>
        <td>${esc(x.name)}${x.id === S.meta.me.id ? ' <span class="muted small">(you)</span>' : ''}</td>
        <td>${num(x.dials)}</td><td>${num(x.connects)}</td><td>${pct(x.contactRate)}</td>
        <td>${hms(x.talkSeconds)}</td><td>${hms(x.avgTalkSeconds)}</td><td>${hms(x.longestTalkSeconds)}</td></tr>`
        )
        .join('');
    } catch {
      $('boardCard').classList.add('hidden');
    }
  }

  async function refresh() {
    $('customRange').classList.toggle('hidden', $('fPreset').value !== 'custom');
    $('btnExport').href = `/api/reports/export?${query()}`;
    try {
      const data = await api(`/api/reports/compare?${query()}`);
      S.compare = data;
      render(data);
      loadBoard();
      if (!$('callsView').classList.contains('hidden')) loadCalls();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  // ---------------------------------------------------------------- boot
  $('logout').addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  });

  $('btnToggleTable').addEventListener('click', () => {
    const hidden = $('tableView').classList.toggle('hidden');
    $('btnToggleTable').textContent = hidden ? 'Show table' : 'Hide table';
  });

  $('btnToggleCalls').addEventListener('click', async () => {
    const hidden = $('callsView').classList.toggle('hidden');
    $('btnToggleCalls').textContent = hidden ? 'Show every call' : 'Hide calls';
    if (!hidden) await loadCalls().catch((e) => toast(e.message, 'bad'));
  });

  ['fPreset', 'fGroup', 'fList', 'fAgent', 'fFrom', 'fTo'].forEach((id) =>
    $(id).addEventListener('change', refresh)
  );

  window.addEventListener('resize', () => {
    if (S.report) {
      drawActivity($('vizActivity'), S.report.series);
      drawTalk($('vizTalk'), S.report.series);
    }
  });

  (async () => {
    const me = await api('/api/me');
    $('whoami').textContent = me.user.name || me.user.email;
    if (me.user.role === 'admin') $('adminLink').classList.remove('hidden');

    S.meta = await api('/api/reports/meta');

    $('fPreset').innerHTML = Object.entries(S.meta.presets)
      .map(([k, v]) => `<option value="${k}"${k === 'last_7' ? ' selected' : ''}>${esc(v)}</option>`)
      .join('');
    $('fGroup').innerHTML = Object.entries(S.meta.groupings)
      .filter(([k]) => k !== 'agent' || S.meta.isAdmin)
      .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
      .join('');
    $('fList').innerHTML =
      '<option value="">Every list</option>' +
      S.meta.lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');

    if (S.meta.isAdmin) {
      $('fAgent').classList.remove('hidden');
      $('fAgent').innerHTML =
        '<option value="all">Everyone</option>' +
        S.meta.agents.map((a) => `<option value="${a.id}">${esc(a.name || a.email)}</option>`).join('');
      $('fAgent').value = 'all';
    }

    const today = new Date().toISOString().slice(0, 10);
    $('fTo').value = today;
    $('fFrom').value = today;

    refresh();
  })().catch((e) => toast(e.message, 'bad'));
})();
