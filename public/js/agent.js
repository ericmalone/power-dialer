/* Power Dialer - agent console */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  const state = {
    me: null,
    maxLines: 3,
    lines: 2,
    lists: [],
    dispositions: [],
    station: null,
    device: null,
    call: null,
    phoneReady: false,
    timerHandle: null,
    callStartedAt: null,
    pendingCallId: null,
    lastLead: null,
    unread: 0,
  };

  // ---------------------------------------------------------------- toasts
  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  function alertBanner(text, kind = 'warn') {
    const el = $('alert');
    if (!text) {
      el.classList.add('hidden');
      return;
    }
    el.className = `banner ${kind}`;
    el.textContent = text;
    el.classList.remove('hidden');
  }

  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  // ---------------------------------------------------------------- softphone
  async function fetchToken() {
    const { token } = await api('/api/token');
    return token;
  }

  async function connectPhone() {
    if (state.phoneReady) return true;
    setPhonePill('warn', 'Phone: connecting...');

    let token;
    try {
      token = await fetchToken();
    } catch (err) {
      setPhonePill('bad', 'Phone: not configured');
      alertBanner(err.message, 'bad');
      return false;
    }

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhonePill('bad', 'Phone: microphone blocked');
      alertBanner(
        'Your browser blocked the microphone. Click the padlock in the address bar and allow the microphone, then try again.',
        'bad'
      );
      return false;
    }

    const device = new Twilio.Device(token, {
      codecPreferences: ['opus', 'pcmu'],
      logLevel: 'error',
    });
    state.device = device;

    device.on('tokenWillExpire', async () => {
      try {
        device.updateToken(await fetchToken());
      } catch (e) {
        toast('Could not refresh phone token.', 'bad');
      }
    });
    device.on('error', (e) => {
      toast(`Phone error: ${e.message || e.code}`, 'bad');
    });

    try {
      await device.register();
    } catch (e) {
      /* registration is only needed for inbound; keep going */
    }

    // Place the persistent leg that parks us in our own conference room.
    const call = await device.connect({ params: {} });
    state.call = call;

    call.on('disconnect', () => {
      state.phoneReady = false;
      state.call = null;
      setPhonePill('', 'Phone: not connected');
      api('/api/dialer/offline', { method: 'POST' }).catch(() => {});
      render();
    });
    call.on('error', (e) => toast(`Call error: ${e.message || e.code}`, 'bad'));

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      call.on('accept', finish);
      setTimeout(finish, 4000);
    });

    state.phoneReady = true;
    setPhonePill('ok', 'Phone: connected');
    return true;
  }

  function setPhonePill(kind, text) {
    const p = $('phonePill');
    p.className = `pill ${kind}`;
    p.innerHTML = `<span class="dot"></span> ${text}`;
  }

  // ---------------------------------------------------------------- rendering
  const STATUS_LABEL = {
    offline: ['', 'Offline'],
    paused: ['warn', 'Paused'],
    ready: ['ok', 'Ready'],
    dialing: ['live', 'Dialing...'],
    connected: ['live', 'On a call'],
    wrap: ['warn', 'Wrap-up'],
  };

  function render() {
    const st = state.station;
    const status = st ? st.status : 'offline';
    const [kind, label] = STATUS_LABEL[status] || ['', status];
    const sp = $('statusPill');
    sp.className = `pill ${kind}`;
    sp.innerHTML = `<span class="dot"></span> ${label}`;

    const dialing = ['ready', 'dialing', 'connected', 'wrap'].includes(status);
    $('btnStart').classList.toggle('hidden', dialing);
    $('btnPause').classList.toggle('hidden', !dialing);
    $('btnResume').classList.toggle('hidden', status !== 'paused' || !st || !st.listId);
    $('btnStop').classList.toggle('hidden', !dialing && status !== 'paused');
    $('listSel').disabled = dialing;

    if (st && st.lastError) alertBanner(st.lastError, 'warn');
    else if (st && st.throttleNote) alertBanner(st.throttleNote, 'warn');
    else alertBanner('');

    renderLines();
    renderStage();
  }

  function renderLines() {
    const box = $('lines');
    const st = state.station;
    const active = st ? st.activeLines : [];
    const total = Math.max(state.lines, active.length, 1);
    let html = '';
    for (let i = 0; i < total; i++) {
      const a = active[i];
      if (!a) {
        html += `<div class="line-row idle"><span class="dot"></span><span class="who">Line ${i + 1} - idle</span></div>`;
      } else {
        const cls = a.state === 'connected' ? 'connected' : '';
        const stateLabel =
          a.state === 'connected' ? 'CONNECTED' : a.state === 'ringing' ? 'ringing' : a.state === 'voicemail' ? 'voicemail' : 'dialing';
        html += `<div class="line-row ${cls}">
            <span class="who">${escapeHtml(a.name)}</span>
            <span class="num">${escapeHtml(a.phone)}</span>
            <span class="small muted">${stateLabel}</span>
          </div>`;
      }
    }
    box.innerHTML = html;
  }

  function renderStage() {
    const stage = $('stage');
    const st = state.station;
    const onCall = st && st.onCall;

    if (onCall) {
      stage.classList.add('live');
      const l = onCall.lead || {};
      const name = [l.firstName, l.lastName].filter(Boolean).join(' ') || l.company || 'Lead';
      stage.innerHTML = `
        <div class="pill live"><span class="dot"></span> Live</div>
        <div class="who">${escapeHtml(name)}</div>
        ${l.company ? `<div class="sub">${escapeHtml(l.company)}</div>` : ''}
        <div class="phone">${escapeHtml(l.phoneDisplay || '')}</div>
        <div class="timer" id="liveTimer">0:00</div>`;
      $('callActions').style.display = 'flex';
      startTimer(onCall.startedAt);
      renderLeadDetails(l);
      state.lastLead = { id: l.id, name, phoneDisplay: l.phoneDisplay };
    } else {
      stage.classList.remove('live');
      stopTimer();
      $('callActions').style.display = 'none';
      const status = st ? st.status : 'offline';
      if (status === 'dialing') {
        stage.innerHTML = `<div class="pill live"><span class="dot"></span> Dialing</div>
          <div class="who">Reaching out...</div>
          <div class="sub">${(st.activeLines || []).length} line(s) ringing. First person to answer comes straight to you.</div>`;
      } else if (status === 'wrap') {
        stage.innerHTML = `<div class="who">Call ended</div>
          <div class="sub">Pick a disposition below and the next call starts automatically.</div>`;
      } else if (status === 'ready') {
        stage.innerHTML = `<div class="who">Queuing next batch</div><div class="sub">Hang tight.</div>`;
      } else if (status === 'paused') {
        stage.innerHTML = `<div class="who">Paused</div><div class="sub">Take your time. Hit RESUME when you are ready.</div>`;
      } else {
        stage.innerHTML = `<div class="who">Ready when you are</div>
          <div class="sub">Pick a list, choose your lines, then hit START DIALING.</div>`;
      }
    }
  }

  function renderLeadDetails(l) {
    if (!l || !l.id) {
      $('leadDetails').innerHTML = '<span class="muted">No lead on screen yet.</span>';
      return;
    }
    const extra = l.extra || {};
    const d = l.deal || {};
    const money = (v) => (v === null || v === undefined || v === '' ? '' : `$${Number(v).toLocaleString('en-US')}`);
    const rows = [
      ['Phone', l.phoneDisplay],
      ['Company', l.company],
      ['Monthly revenue', money(d.monthlyRevenue)],
      ['Time in business', d.timeInBusinessMonths ? `${d.timeInBusinessMonths} months` : ''],
      ['Wants', money(d.requestedAmount)],
      ['Open positions', d.openPositions === null || d.openPositions === undefined ? '' : String(d.openPositions)],
      ['Industry', d.industry],
      ['Email', l.email],
      ['Their local time', l.localHour === null || l.localHour === undefined ? '' : `${l.localHour}:00 (${l.timezone || ''})`],
      ['Previous attempts', String(l.attempts ?? '')],
      ...Object.entries(extra).slice(0, 12),
    ].filter(([, v]) => v !== '' && v !== null && v !== undefined);

    $('leadDetails').innerHTML =
      `<dl class="kv">` +
      rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('') +
      `</dl>` +
      (l.notes ? `<p class="small mt"><b>Notes:</b> ${escapeHtml(l.notes)}</p>` : '');
  }

  function startTimer(startedAt) {
    stopTimer();
    state.callStartedAt = startedAt || Date.now();
    const paint = () => {
      const el = $('liveTimer');
      if (el) el.textContent = fmtTime((Date.now() - state.callStartedAt) / 1000);
    };
    paint();
    state.timerHandle = setInterval(paint, 500);
  }
  function stopTimer() {
    if (state.timerHandle) clearInterval(state.timerHandle);
    state.timerHandle = null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------------------------------------------------------------- dispositions
  function renderDispositions() {
    $('dispGrid').innerHTML = state.dispositions
      .map(
        (d) => `<button data-code="${escapeHtml(d.code)}" class="${escapeHtml(d.kind)}">
          <span class="key">${escapeHtml(d.hotkey || '')}</span>
          <span>${escapeHtml(d.label)}</span>
        </button>`
      )
      .join('');
    $('dispGrid')
      .querySelectorAll('button')
      .forEach((b) => b.addEventListener('click', () => submitDisposition(b.dataset.code)));
  }

  async function submitDisposition(code) {
    const notes = $('dispNotes').value;
    let callbackMinutes = 0;
    const disp = state.dispositions.find((d) => d.code === code);
    if (disp && disp.kind === 'callback') {
      const answer = prompt('Call back in how many minutes? (e.g. 60, or 1440 for tomorrow)', '120');
      if (answer === null) return;
      callbackMinutes = Math.max(1, parseInt(answer, 10) || 120);
    }
    try {
      const st = await api('/api/disposition', {
        method: 'POST',
        body: { callId: state.pendingCallId, code, notes, callbackMinutes },
      });
      state.station = st;
      state.pendingCallId = null;
      $('dispNotes').value = '';
      $('dispCard').style.display = 'none';
      $('aiCard').style.display = 'none';
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  // ---------------------------------------------------------------- controls
  async function startDialing() {
    const listId = Number($('listSel').value);
    if (!listId) return toast('Pick a call list first.', 'warn');

    $('btnStart').disabled = true;
    try {
      const ok = await connectPhone();
      if (!ok) return;
      state.station = await api('/api/dialer/start', { method: 'POST', body: { listId, lines: state.lines } });
      render();
      toast('Dialing started. Good luck out there.', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
      alertBanner(err.message, 'bad');
    } finally {
      $('btnStart').disabled = false;
    }
  }

  async function pauseDialing() {
    try {
      state.station = await api('/api/dialer/pause', { method: 'POST', body: {} });
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function resumeDialing() {
    try {
      state.station = await api('/api/dialer/resume', { method: 'POST', body: {} });
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function stopDialing() {
    try {
      state.station = await api('/api/dialer/stop', { method: 'POST', body: {} });
      render();
      toast('Session ended.', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  function setLines(n) {
    state.lines = n;
    document.querySelectorAll('#linePicker button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.n) === n);
    });
    api('/api/dialer/lines', { method: 'POST', body: { lines: n } }).catch(() => {});
    renderLines();
  }

  function buildLinePicker() {
    $('linePicker').innerHTML = Array.from({ length: state.maxLines }, (_, i) => i + 1)
      .map((n) => `<button data-n="${n}">${n}</button>`)
      .join('');
    $('linePicker')
      .querySelectorAll('button')
      .forEach((b) => b.addEventListener('click', () => setLines(Number(b.dataset.n))));
    setLines(Math.min(2, state.maxLines));
  }

  // ---------------------------------------------------------------- data
  async function loadLists() {
    const { lists } = await api('/api/lists');
    state.lists = lists;
    $('listSel').innerHTML = lists.length
      ? lists
          .map((l) => `<option value="${l.id}">${escapeHtml(l.name)} - ${l.remaining} left of ${l.total}</option>`)
          .join('')
      : '<option value="">No lists assigned to you yet</option>';
  }

  async function loadStats() {
    try {
      const { today } = await api('/api/my-stats');
      $('sCalls').textContent = today.calls;
      $('sConnects').textContent = today.connects;
      $('sTalk').textContent = fmtTime(today.talkSeconds);
      $('sRate').textContent = today.calls ? `${Math.round((today.connects / today.calls) * 100)}%` : '0%';
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- texting
  function currentLeadForText() {
    const st = state.station;
    if (st && st.onCall && st.onCall.lead) {
      const l = st.onCall.lead;
      return { id: l.id, name: [l.firstName, l.lastName].filter(Boolean).join(' ') || l.company, phoneDisplay: l.phoneDisplay };
    }
    if (state.lastLead) return state.lastLead;
    return null;
  }

  function setUnread(n) {
    state.unread = n;
    const b = $('unreadBadge');
    b.textContent = n;
    b.classList.toggle('hidden', !n);
  }

  async function loadReplies() {
    try {
      const res = await fetch('/api/sms/inbox?peek=1', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const { inbox } = await res.json();
      const unread = inbox.filter((m) => m.unread).length;
      setUnread(unread);
      $('replies').innerHTML = inbox.length
        ? inbox
            .slice(0, 6)
            .map(
              (m) => `<div class="reply-row ${m.unread ? 'unread' : ''}" ${m.leadId ? `data-lead="${m.leadId}"` : ''}>
                <div class="who">${escapeHtml(m.name || m.fromDisplay)}</div>
                <div class="txt">${escapeHtml(m.body)}</div>
              </div>`
            )
            .join('')
        : '<span class="muted">No replies yet.</span>';
      $('replies')
        .querySelectorAll('.reply-row')
        .forEach((r) => r.addEventListener('click', () => window.Texting.open('replies')));
    } catch {
      /* ignore */
    }
  }

  async function loadCallbacks() {
    try {
      const t = await api('/api/crm/tasks?hours=48');
      const rows = [...t.overdue.map((x) => ({ ...x, late: true })), ...t.upcoming].slice(0, 8);
      $('callbacks').innerHTML = rows.length
        ? rows
            .map((c) => {
              const who = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || 'Lead';
              return `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  ${c.late ? '<b style="color:var(--red)">due</b> ' : ''}${escapeHtml(who)}
                </span>
                <button data-lead="${c.lead_id || ''}" class="small">Call</button>
              </div>`;
            })
            .join('') + '<p class="small mt" style="margin-bottom:0"><a href="/crm">See all in Merchants</a></p>'
        : '<span class="muted">Nothing due. <a href="/crm">Open Merchants</a></span>';
      $('callbacks')
        .querySelectorAll('button[data-lead]')
        .forEach((b) =>
          b.addEventListener('click', async () => {
            if (!b.dataset.lead) return;
            try {
              await connectPhone();
              state.station = await api('/api/dialer/dial-one', {
                method: 'POST',
                body: { leadId: Number(b.dataset.lead) },
              });
              render();
            } catch (err) {
              toast(err.message, 'bad');
            }
          })
        );
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- AI note
  function showAiNote(note) {
    const box = $('aiNoteBox');
    $('aiCard').style.display = 'block';
    if (!note) {
      box.innerHTML = '<div class="ai-pending"><span class="spinner"></span> Writing up that call...</div>';
      return;
    }
    if (note.status && note.status !== 'ready') {
      box.innerHTML =
        note.status === 'failed'
          ? `<div class="small" style="color:#ffb4b4">Could not write a note: ${escapeHtml(note.error || '')}</div>`
          : note.status === 'skipped'
          ? `<div class="ai-pending">Skipped - ${escapeHtml(note.error || 'too short')}</div>`
          : '<div class="ai-pending"><span class="spinner"></span> Writing up that call...</div>';
      return;
    }
    const risks = (note.extracted && note.extracted.risk_flags) || [];
    box.innerHTML = `
      <div class="row-meta" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <span class="interest ${escapeHtml(note.interest || 'unclear')}">${escapeHtml(note.interest || 'unclear')}</span>
        <div class="spacer"></div>
        <span class="muted small">${escapeHtml(note.source === 'transcript' ? 'from the recording' : 'from your notes')}</span>
      </div>
      <div style="font-size:14px;line-height:1.55">${escapeHtml(note.summary || '')}</div>
      ${note.next_step ? `<p class="small mt" style="margin-bottom:0"><b>Next:</b> ${escapeHtml(note.next_step)}</p>` : ''}
      ${
        note.objections && note.objections.length
          ? `<ul class="ai-list">${note.objections.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>`
          : ''
      }
      ${risks.length ? `<p class="small" style="color:#ffb4b4;margin:6px 0 0">${risks.map(escapeHtml).join(' · ')}</p>` : ''}
      ${note.coaching ? `<p class="small muted" style="margin:8px 0 0"><b>Coaching:</b> ${escapeHtml(note.coaching)}</p>` : ''}`;
  }

  // ---------------------------------------------------------------- sockets
  function wireSockets() {
    const socket = io();
    socket.on('station', (snap) => {
      state.station = snap;
      render();
    });
    socket.on('connected', () => {
      loadStats();
    });
    socket.on('call:ended', (payload) => {
      state.pendingCallId = payload.callId;
      $('dispCard').style.display = 'block';
      $('dispHint').textContent = `Talk time ${fmtTime(payload.talkSeconds)}`;
      $('dispNotes').focus();
      if (window.Texting) window.Texting.quickChips($('quickTexts'), currentLeadForText);
      showAiNote(null);
      loadStats();
      loadCallbacks();
    });
    socket.on('ai:note', (n) => {
      showAiNote({
        status: 'ready',
        summary: n.summary,
        interest: n.interest,
        next_step: n.nextStep,
        source: 'transcript',
      });
    });
    socket.on('toast', (t) => toast(t.text, t.kind));
    socket.on('sms:received', (m) => {
      setUnread(state.unread + 1);
      loadReplies();
    });
    socket.on('sms:sent', () => loadReplies());
    socket.on('unauthorized', () => (location.href = '/login'));
  }

  // ---------------------------------------------------------------- keyboard
  function wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

      if (e.code === 'Space' && !typing) {
        e.preventDefault();
        const status = state.station ? state.station.status : 'offline';
        if (status === 'paused') resumeDialing();
        else if (status !== 'offline') pauseDialing();
        return;
      }
      if (!typing && /^[0-9]$/.test(e.key) && $('dispCard').style.display !== 'none') {
        const d = state.dispositions.find((x) => x.hotkey === e.key);
        if (d) {
          e.preventDefault();
          submitDisposition(d.code);
        }
      }
      if (e.key === 'Escape' && state.station && state.station.onCall) {
        api('/api/dialer/hangup', { method: 'POST', body: {} }).catch(() => {});
      }
    });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    const me = await api('/api/me');
    state.me = me.user;
    state.maxLines = me.maxLines;
    $('whoami').textContent = me.user.name || me.user.email;
    if (me.user.role === 'admin') {
      const a = document.createElement('a');
      a.href = '/admin';
      a.textContent = 'Admin';
      a.className = 'small';
      a.style.marginRight = '8px';
      $('logout').before(a);
    }
    if (!me.twilioConfigured) {
      alertBanner('Twilio is not fully configured yet - the phone will not connect. Ask your administrator.', 'bad');
    }

    buildLinePicker();
    const { dispositions } = await api('/api/dispositions');
    state.dispositions = dispositions;
    renderDispositions();

    await loadLists();
    state.station = await api('/api/station');
    render();
    loadStats();
    loadCallbacks();
    loadReplies();
    if (window.Texting) window.Texting.quickChips($('quickTexts'), currentLeadForText);
    wireSockets();
    wireKeyboard();

    window.addEventListener('sms:read', () => setUnread(0));
    window.addEventListener('sms:changed', () => {
      loadReplies();
      if (window.Texting) window.Texting.quickChips($('quickTexts'), currentLeadForText);
    });

    setInterval(loadStats, 30000);
    setInterval(loadLists, 60000);
    setInterval(loadReplies, 45000);
  }

  // ---------------------------------------------------------------- wiring
  $('btnStart').addEventListener('click', startDialing);
  $('btnPause').addEventListener('click', pauseDialing);
  $('btnResume').addEventListener('click', resumeDialing);
  $('btnStop').addEventListener('click', stopDialing);
  $('btnSkipDisp').addEventListener('click', () => submitDisposition(''));

  $('btnTexts').addEventListener('click', () => window.Texting.open('compose', { lead: currentLeadForText() }));
  $('btnTextLead').addEventListener('click', () =>
    window.Texting.open('compose', { lead: currentLeadForText(), mode: 'one' })
  );

  $('btnHangup').addEventListener('click', async () => {
    try {
      await api('/api/dialer/hangup', { method: 'POST', body: {} });
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('btnMute').addEventListener('click', () => {
    if (!state.call) return;
    const muted = !state.call.isMuted();
    state.call.mute(muted);
    $('btnMute').textContent = muted ? 'Unmute' : 'Mute';
    $('btnMute').classList.toggle('btn-danger', muted);
  });

  $('btnDnc').addEventListener('click', async () => {
    const st = state.station;
    if (!st || !st.onCall) return;
    if (!confirm('Add this number to the Do Not Call list? They will never be dialed again.')) return;
    try {
      await api(`/api/leads/${st.onCall.leadId}/dnc`, { method: 'POST', body: { reason: 'Requested on call' } });
      toast('Added to Do Not Call.', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('logout').addEventListener('click', async () => {
    try {
      if (state.call) state.call.disconnect();
      if (state.device) state.device.destroy();
    } catch {
      /* ignore */
    }
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  });

  window.addEventListener('beforeunload', () => {
    try {
      if (state.call) state.call.disconnect();
    } catch {
      /* ignore */
    }
  });

  boot().catch((err) => {
    alertBanner(err.message, 'bad');
  });
})();
