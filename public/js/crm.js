/* Power Dialer - merchant CRM */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
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

  const money = (v) =>
    v === null || v === undefined || v === '' ? '' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(/[TZ]/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(d.getTime())) return iso;
    const diff = (Date.now() - d.getTime()) / 1000;
    if (Math.abs(diff) < 60) return 'just now';
    if (diff > 0 && diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff > 0 && diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 0 && diff > -3600) return `in ${Math.floor(-diff / 60)}m`;
    if (diff < 0 && diff > -86400) return `in ${Math.floor(-diff / 3600)}h`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const S = { meta: null, me: null, offset: 0, lastQuery: {}, searchTimer: null, openLeadId: null };

  // ------------------------------------------------------------------ tabs
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('section[data-panel]').forEach((s) => s.classList.toggle('hidden', s.dataset.panel !== b.dataset.tab));
    load(b.dataset.tab);
  });

  function load(tab) {
    const fns = { day: loadDay, merchants: () => runSearch(true), pipeline: loadPipeline, notes: loadNotes };
    (fns[tab] || loadDay)().catch((e) => toast(e.message, 'bad'));
  }

  // ------------------------------------------------------------------ my day
  async function loadDay() {
    const d = await api('/api/crm/my-day');
    $('dDials').textContent = d.today.dials;
    $('dConnects').textContent = d.today.connects;
    $('dTalk').textContent = fmtTime(d.today.talkSeconds);
    $('dCallbacks').textContent = d.tasks.counts.total;

    $('dPipeline').innerHTML = d.pipeline.length
      ? d.pipeline
          .map(
            (s) => `<div class="row" style="justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line)">
              <span class="stage-pill" data-kind="${esc(s.kind)}">${esc(s.label)}</span>
              <span><b>${s.count}</b> ${s.value ? `<span class="muted">&middot; ${money(s.value)}</span>` : ''}</span>
            </div>`
          )
          .join('')
      : '<span class="muted">Nothing open yet.</span>';

    renderTasks(d.tasks);

    $('dayNotes').innerHTML = d.recentNotes.length
      ? d.recentNotes
          .map(
            (n) => `<div class="reply-row" data-lead="${n.lead_id}">
              <div class="row" style="gap:8px">
                <span class="interest ${esc(n.interest)}">${esc(n.interest)}</span>
                <b>${esc([n.first_name, n.last_name].filter(Boolean).join(' ') || n.company || 'Merchant')}</b>
              </div>
              <div class="txt">${esc(n.summary)}</div>
            </div>`
          )
          .join('')
      : '<span class="muted">No notes yet. They appear a minute or two after a call ends.</span>';
    $('dayNotes')
      .querySelectorAll('[data-lead]')
      .forEach((r) => r.addEventListener('click', () => openLead(Number(r.dataset.lead))));
  }

  function renderTasks(t) {
    const rows = [...t.overdue.map((x) => ({ ...x, late: true })), ...t.upcoming];
    $('duePill').innerHTML = `<span class="dot"></span> ${t.counts.overdue} due now`;
    $('duePill').className = `pill ${t.counts.overdue ? 'bad' : 'ok'}`;

    $('taskList').innerHTML = rows.length
      ? rows
          .map((x) => {
            const who = [x.first_name, x.last_name].filter(Boolean).join(' ') || x.company || 'Someone';
            return `<div class="task-row ${x.late ? 'overdue' : ''}">
              <div class="who">
                <b>${esc(who)}</b>
                <span>${esc(x.company && who !== x.company ? x.company + ' · ' : '')}${esc(x.note || x.title)}</span>
              </div>
              <span class="when">${esc(when(x.due_at))}</span>
              <button class="small btn-primary" data-call="${x.lead_id || ''}">Call</button>
              <button class="small" data-open="${x.lead_id || ''}">Open</button>
              <button class="small btn-ghost" data-snooze="${x.id}">+1h</button>
              <button class="small btn-ghost" data-done="${x.id}">Done</button>
            </div>`;
          })
          .join('')
      : '<span class="muted">Nothing scheduled. Book a callback from any merchant record.</span>';

    $('taskList')
      .querySelectorAll('button[data-done]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/crm/tasks/${b.dataset.done}/complete`, { method: 'POST', body: {} });
          loadDay();
        })
      );
    $('taskList')
      .querySelectorAll('button[data-snooze]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/crm/tasks/${b.dataset.snooze}/snooze`, { method: 'POST', body: { minutes: 60 } });
          loadDay();
        })
      );
    $('taskList')
      .querySelectorAll('button[data-open]')
      .forEach((b) => b.addEventListener('click', () => b.dataset.open && openLead(Number(b.dataset.open))));
    $('taskList')
      .querySelectorAll('button[data-call]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          if (!b.dataset.call) return;
          try {
            await api(`/api/crm/lead/${b.dataset.call}/call`, { method: 'POST', body: {} });
            toast('Dialing. Switch to the dialer tab to talk.', 'ok');
          } catch (err) {
            toast(err.message, 'bad');
          }
        })
      );
  }

  // ------------------------------------------------------------------ merchants
  function currentQuery() {
    return {
      q: $('q').value.trim(),
      stage: $('fStage').value,
      owner: $('fOwner').value,
      sort: $('fSort').value,
      mine: $('fMine').checked ? '1' : '',
    };
  }

  async function runSearch(reset = false) {
    if (reset) S.offset = 0;
    const params = new URLSearchParams({ ...currentQuery(), limit: '60', offset: String(S.offset) });
    const data = await api(`/api/crm/search?${params}`);

    const html = data.leads
      .map((l) => {
        const person = [l.first_name, l.last_name].filter(Boolean).join(' ');
        return `<tr class="lead-row" data-lead="${l.id}">
        <td class="wrap"><span class="biz">${esc(l.company || person || 'Unknown')}</span>
          ${person && l.company ? `<div class="person">${esc(person)}</div>` : ''}</td>
        <td><span class="stage-pill" data-kind="${esc(l.stageInfo.kind)}">${esc(l.stageInfo.label)}</span></td>
        <td>${esc(l.phoneDisplay)}</td>
        <td>${esc(money(l.monthly_revenue))}</td>
        <td>${esc(money(l.requested_amount))}</td>
        <td>${l.open_positions === null || l.open_positions === undefined ? '' : l.open_positions}</td>
        <td class="small">${esc(l.owner_name || '')}</td>
        <td class="small muted">${esc(when(l.last_contact_at || l.updated_at))}</td>
        <td>${l.open_tasks ? `<span class="qual weak">${l.open_tasks} due</span>` : ''}
            <span class="qual ${esc(l.qualification.verdict)}">${esc(l.qualification.verdict)}</span></td>
      </tr>`;
      })
      .join('');

    const body = $('leadRows');
    if (reset) body.innerHTML = html || '<tr><td colspan="9" class="muted">Nothing matches that.</td></tr>';
    else body.insertAdjacentHTML('beforeend', html);

    $('resultCount').textContent = `${data.total} merchant${data.total === 1 ? '' : 's'}`;
    S.offset += data.leads.length;
    $('btnMore').classList.toggle('hidden', S.offset >= data.total);

    body.querySelectorAll('.lead-row').forEach((r) =>
      r.addEventListener('click', () => openLead(Number(r.dataset.lead)))
    );
  }

  // ------------------------------------------------------------------ pipeline
  async function loadPipeline() {
    const { pipeline } = await api('/api/crm/pipeline');
    const max = Math.max(1, ...pipeline.map((s) => s.count));
    $('board').innerHTML = pipeline
      .map(
        (s) => `<div class="board-col" data-kind="${esc(s.kind)}" data-stage="${esc(s.code)}">
        <h3>${esc(s.label)}</h3>
        <div class="n">${s.count}</div>
        <div class="v">${s.value ? money(s.value) : '&nbsp;'}</div>
        <div class="bar" style="width:${Math.max(6, (s.count / max) * 100)}%"></div>
      </div>`
      )
      .join('');

    $('board')
      .querySelectorAll('.board-col')
      .forEach((c) =>
        c.addEventListener('click', () => {
          $('fStage').value = c.dataset.stage;
          document.querySelector('#tabs button[data-tab="merchants"]').click();
        })
      );

    const open = await api('/api/crm/search?stage=open&sort=value&limit=40');
    $('stageLists').innerHTML = open.leads.length
      ? `<div class="table-scroll"><table><thead><tr><th>Business</th><th>Stage</th><th>Wants</th><th>Revenue</th><th>Owner</th></tr></thead><tbody>${open.leads
          .map(
            (l) => `<tr class="lead-row" data-lead="${l.id}">
            <td>${esc(l.company || [l.first_name, l.last_name].filter(Boolean).join(' '))}</td>
            <td><span class="stage-pill" data-kind="${esc(l.stageInfo.kind)}">${esc(l.stageInfo.label)}</span></td>
            <td>${esc(money(l.requested_amount))}</td>
            <td>${esc(money(l.monthly_revenue))}</td>
            <td class="small">${esc(l.owner_name || '')}</td></tr>`
          )
          .join('')}</tbody></table></div>`
      : '<span class="muted">Nothing open.</span>';
    $('stageLists')
      .querySelectorAll('.lead-row')
      .forEach((r) => r.addEventListener('click', () => openLead(Number(r.dataset.lead))));
  }

  // ------------------------------------------------------------------ AI notes feed
  async function loadNotes() {
    const ai = S.meta.ai;
    $('aiStatus').textContent = !ai.enabled
      ? 'AI notes are switched off.'
      : !ai.hasKey
      ? 'AI notes are on but no Anthropic API key is set - ask your administrator.'
      : `Writing notes with ${ai.model}. Transcription: ${ai.transcription}. Calls under ${ai.minTalkSeconds}s are skipped.`;

    const { notes } = await api('/api/crm/ai/recent?limit=30');
    $('noteFeed').innerHTML = notes.length
      ? notes.map((n) => aiCard(n, true)).join('')
      : '<p class="muted small">No notes yet. They show up a minute or two after a call ends.</p>';
    $('noteFeed')
      .querySelectorAll('[data-lead]')
      .forEach((el) => el.addEventListener('click', () => openLead(Number(el.dataset.lead))));
  }

  function aiCard(n, linkable = false) {
    const who = [n.first_name, n.last_name].filter(Boolean).join(' ') || n.company || '';
    const risks = (n.extracted && n.extracted.risk_flags) || [];
    return `<div class="ai-card" ${linkable ? `data-lead="${n.lead_id}" style="cursor:pointer"` : ''}>
      <div class="row-meta">
        <span class="interest ${esc(n.interest)}">${esc(n.interest || 'unclear')}</span>
        ${who ? `<b>${esc(who)}</b>` : ''}
        ${n.agent_name ? `<span class="muted small">${esc(n.agent_name)}</span>` : ''}
        <div class="spacer"></div>
        <span class="muted small">${esc(n.source === 'transcript' ? 'from recording' : n.source === 'typed_notes' ? 'from typed notes' : 'from call details')}</span>
        <span class="muted small">${esc(when(n.created_at))}</span>
      </div>
      <div class="summary">${esc(n.summary)}</div>
      ${n.next_step ? `<p class="small mt" style="margin-bottom:0"><b>Next:</b> ${esc(n.next_step)}</p>` : ''}
      ${
        n.objections && n.objections.length
          ? `<p class="small" style="margin:8px 0 0"><b>Objections</b></p><ul class="ai-list">${n.objections
              .map((o) => `<li>${esc(o)}</li>`)
              .join('')}</ul>`
          : ''
      }
      ${
        risks.length
          ? `<p class="small" style="margin:8px 0 0;color:#ffb4b4"><b>Watch out</b></p><ul class="ai-list">${risks
              .map((r) => `<li>${esc(r)}</li>`)
              .join('')}</ul>`
          : ''
      }
      ${n.coaching ? `<p class="small muted" style="margin:8px 0 0"><b>Coaching:</b> ${esc(n.coaching)}</p>` : ''}
    </div>`;
  }

  // ------------------------------------------------------------------ lead drawer
  async function openLead(leadId) {
    S.openLeadId = leadId;
    $('drawerHost').innerHTML = `<div class="drawer-back" id="drawerBack"><div class="drawer"><p class="muted">Loading...</p></div></div>`;
    $('drawerBack').addEventListener('mousedown', (e) => {
      if (e.target.id === 'drawerBack') closeDrawer();
    });
    document.addEventListener('keydown', escClose);

    let data;
    try {
      data = await api(`/api/crm/lead/${leadId}`);
    } catch (err) {
      $('drawerHost').innerHTML = `<div class="drawer-back" id="drawerBack"><div class="drawer"><p class="banner bad">${esc(err.message)}</p></div></div>`;
      return;
    }
    renderDrawer(data.lead);
  }

  function escClose(e) {
    if (e.key === 'Escape') closeDrawer();
  }
  function closeDrawer() {
    $('drawerHost').innerHTML = '';
    S.openLeadId = null;
    document.removeEventListener('keydown', escClose);
  }

  function renderDrawer(l) {
    const person = [l.first_name, l.last_name].filter(Boolean).join(' ');
    const stageOptions = S.meta.stages
      .map((s) => `<option value="${s.code}" ${s.code === l.stage ? 'selected' : ''}>${esc(s.label)}</option>`)
      .join('');

    $('drawerHost').innerHTML = `<div class="drawer-back" id="drawerBack"><div class="drawer">
      <div class="drawer-head">
        <div class="row">
          <div style="flex:1;min-width:0">
            <h2 class="name">${esc(l.company || person || 'Merchant')}</h2>
            <div class="sub">${esc(person)}${person && l.phoneDisplay ? ' &middot; ' : ''}${esc(l.phoneDisplay)}
              ${l.localHour !== null && l.localHour !== undefined ? ` &middot; ${l.localHour}:00 their time` : ''}</div>
          </div>
          <button class="btn-ghost" id="drawerClose">Close</button>
        </div>
        <div class="row mt">
          <select id="stageSel" style="max-width:190px">${stageOptions}</select>
          <span class="qual ${esc(l.qualification.verdict)}">${esc(l.qualification.verdict)}</span>
          <div class="spacer"></div>
          <button class="btn-primary small" id="btnCall">Call now</button>
          <button class="small" id="btnText">Text</button>
          <button class="small" id="btnCallback">Schedule callback</button>
        </div>
        ${
          l.qualification.flags.length
            ? `<div class="banner warn" style="margin:12px 0 0">${l.qualification.flags.map(esc).join(' &middot; ')}</div>`
            : ''
        }
      </div>

      <div class="card mt">
        <h2>Deal</h2>
        <div class="deal-grid" id="dealGrid"></div>
        <div class="row mt"><div class="spacer"></div><button class="btn-primary small" id="btnSaveDeal">Save deal details</button></div>
      </div>

      <div class="card mt">
        <h2>AI notes</h2>
        <div id="drawerAi"></div>
      </div>

      <div class="card mt">
        <h2>Add a note</h2>
        <textarea id="newNote" rows="2" placeholder="What happened?"></textarea>
        <div class="row mt"><div class="spacer"></div><button class="small btn-primary" id="btnAddNote">Save note</button></div>
      </div>

      <div class="card mt">
        <h2>Everything that has happened</h2>
        <div class="stats" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
          <div class="stat"><div class="n">${l.stats.dials}</div><div class="l">Dials</div></div>
          <div class="stat"><div class="n">${l.stats.connects}</div><div class="l">Connects</div></div>
          <div class="stat"><div class="n">${fmtTime(l.stats.talkSeconds)}</div><div class="l">Talk time</div></div>
          <div class="stat"><div class="n">${l.stats.texts}</div><div class="l">Texts</div></div>
        </div>
        <div class="tl" id="timeline"></div>
      </div>
    </div></div>`;

    $('drawerBack').addEventListener('mousedown', (e) => {
      if (e.target.id === 'drawerBack') closeDrawer();
    });
    $('drawerClose').onclick = closeDrawer;

    // deal fields
    const fields = S.meta.dealFields;
    $('dealGrid').innerHTML = Object.entries(fields)
      .map(([key, spec]) => {
        const v = l[key];
        return `<div class="deal-field">
          <label for="f_${key}">${esc(spec.label)}</label>
          <input id="f_${key}" data-field="${key}" value="${v === null || v === undefined ? '' : esc(v)}"
            ${spec.type === 'text' ? '' : 'inputmode="decimal"'} />
        </div>`;
      })
      .join('');

    $('btnSaveDeal').onclick = async () => {
      const payload = {};
      document.querySelectorAll('#dealGrid input[data-field]').forEach((i) => {
        payload[i.dataset.field] = i.value;
      });
      try {
        const r = await api(`/api/crm/lead/${l.id}`, { method: 'PATCH', body: { fields: payload } });
        toast(r.changed.length ? `Saved ${r.changed.length} change${r.changed.length === 1 ? '' : 's'}.` : 'Nothing changed.', 'ok');
        openLead(l.id);
      } catch (err) {
        toast(err.message, 'bad');
      }
    };

    $('stageSel').onchange = async () => {
      const code = $('stageSel').value;
      let reason = '';
      const info = S.meta.stages.find((s) => s.code === code);
      if (info && info.kind === 'lost') {
        reason = prompt(`Why is this one ${info.label.toLowerCase()}?\n\n${S.meta.lostReasons.join('\n')}`, S.meta.lostReasons[0]) || '';
      }
      try {
        await api(`/api/crm/lead/${l.id}/stage`, { method: 'POST', body: { stage: code, reason } });
        openLead(l.id);
      } catch (err) {
        toast(err.message, 'bad');
      }
    };

    $('btnCall').onclick = async () => {
      try {
        await api(`/api/crm/lead/${l.id}/call`, { method: 'POST', body: {} });
        toast('Dialing. Open the dialer tab to talk.', 'ok');
      } catch (err) {
        toast(err.message, 'bad');
      }
    };

    $('btnText').onclick = () =>
      window.Texting.open('compose', {
        lead: { id: l.id, name: l.company || person, phoneDisplay: l.phoneDisplay },
        mode: 'one',
      });

    $('btnCallback').onclick = () => scheduleCallback(l.id, l.company || person);

    $('btnAddNote').onclick = async () => {
      const body = $('newNote').value.trim();
      if (!body) return;
      try {
        await api(`/api/crm/lead/${l.id}/note`, { method: 'POST', body: { body } });
        openLead(l.id);
      } catch (err) {
        toast(err.message, 'bad');
      }
    };

    // AI notes
    const notes = l.aiNotes || [];
    $('drawerAi').innerHTML = notes.length
      ? notes
          .map((n) => {
            if (n.status === 'ready') return aiCard(n);
            if (n.status === 'failed')
              return `<div class="ai-card"><div class="small" style="color:#ffb4b4">Could not write a note: ${esc(n.error)}</div>
                <div class="row mt"><button class="small" data-redo="${n.id}">Try again</button></div></div>`;
            if (n.status === 'skipped')
              return `<div class="ai-card"><div class="ai-pending">Skipped - ${esc(n.error || 'too short to summarise')}</div></div>`;
            return `<div class="ai-card"><div class="ai-pending"><span class="spinner"></span> Writing the note (${esc(n.status)})...</div></div>`;
          })
          .join('')
      : '<p class="small muted">No AI notes on this merchant yet.</p>';

    $('drawerAi')
      .querySelectorAll('button[data-redo]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          b.disabled = true;
          b.textContent = 'Working...';
          try {
            await api(`/api/crm/ai/note/${b.dataset.redo}/regenerate`, { method: 'POST', body: {} });
            openLead(l.id);
          } catch (err) {
            toast(err.message, 'bad');
            b.disabled = false;
            b.textContent = 'Try again';
          }
        })
      );

    // timeline
    const ICON = {
      call: '☎',
      sms_out: '→',
      sms_in: '←',
      note: '✎',
      stage: '⚑',
      task: '⏰',
      ai_note: '✦',
      field: '▤',
      system: '·',
    };
    $('timeline').innerHTML = l.timeline.length
      ? l.timeline
          .map(
            (a) => `<div class="tl-item" data-kind="${esc(a.kind)}">
          <div class="tl-dot">${ICON[a.kind] || '·'}</div>
          <div>
            <div class="tl-title">${esc(a.title || a.kind)}</div>
            ${a.body ? `<div class="tl-body">${esc(a.body)}</div>` : ''}
            <div class="tl-when">${esc(a.who)} &middot; ${esc(when(a.created_at))}</div>
          </div>
        </div>`
          )
          .join('')
      : '<p class="small muted">Nothing yet.</p>';
  }

  // ------------------------------------------------------------------ callback modal
  function scheduleCallback(leadId, who) {
    const quick = [
      ['In 1 hour', 60],
      ['This afternoon', 240],
      ['Tomorrow morning', 60 * 20],
      ['In 3 days', 60 * 72],
      ['Next week', 60 * 24 * 7],
    ];
    $('modalHost').innerHTML = `<div class="modal-back" id="cbBack"><div class="modal">
      <h3>Call ${esc(who || 'them')} back</h3>
      <label>Quick pick</label>
      <div class="chips" id="cbQuick">${quick.map((q, i) => `<button class="chip" data-m="${q[1]}">${esc(q[0])}</button>`).join('')}</div>
      <label for="cbWhen">Or pick a time</label>
      <input type="datetime-local" id="cbWhen" />
      <label for="cbNote">Note</label>
      <textarea id="cbNote" rows="2" placeholder="What are you following up on?"></textarea>
      <div class="row mt"><div class="spacer"></div>
        <button id="cbCancel">Cancel</button>
        <button class="btn-primary" id="cbSave">Schedule</button></div>
    </div></div>`;

    const close = () => ($('modalHost').innerHTML = '');
    $('cbBack').addEventListener('mousedown', (e) => {
      if (e.target.id === 'cbBack') close();
    });
    $('cbCancel').onclick = close;

    let minutes = null;
    $('cbQuick').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-m]');
      if (!b) return;
      minutes = Number(b.dataset.m);
      $('cbQuick').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      $('cbWhen').value = '';
    });

    $('cbSave').onclick = async () => {
      const body = { leadId, kind: 'callback', note: $('cbNote').value };
      if ($('cbWhen').value) body.dueAt = new Date($('cbWhen').value).toISOString();
      else if (minutes) body.minutesFromNow = minutes;
      else return toast('Pick when.', 'warn');
      try {
        await api('/api/crm/tasks', { method: 'POST', body });
        close();
        toast('Callback scheduled.', 'ok');
        if (S.openLeadId) openLead(S.openLeadId);
        loadDay().catch(() => {});
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  }

  // ------------------------------------------------------------------ boot
  $('logout').addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  });

  $('btnMore').addEventListener('click', () => runSearch(false).catch((e) => toast(e.message, 'bad')));
  $('btnNewTask').addEventListener('click', () => scheduleCallback(null, ''));

  ['q'].forEach((id) =>
    $(id).addEventListener('input', () => {
      clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(() => runSearch(true).catch(() => {}), 250);
    })
  );
  ['fStage', 'fOwner', 'fSort', 'fMine'].forEach((id) =>
    $(id).addEventListener('change', () => runSearch(true).catch((e) => toast(e.message, 'bad')))
  );

  (async () => {
    const me = await api('/api/me');
    S.me = me.user;
    $('whoami').textContent = me.user.name || me.user.email;
    if (me.user.role === 'admin') $('adminLink').classList.remove('hidden');

    S.meta = await api('/api/crm/meta');
    $('fStage').innerHTML =
      '<option value="">Every stage</option><option value="open">Open deals only</option>' +
      S.meta.stages.map((s) => `<option value="${s.code}">${esc(s.label)}</option>`).join('');
    $('fOwner').innerHTML =
      '<option value="">Anyone</option>' + S.meta.agents.map((a) => `<option value="${a.id}">${esc(a.name || a.email)}</option>`).join('');

    load('day');

    const socket = io();
    socket.on('ai:note', () => {
      if (S.openLeadId) openLead(S.openLeadId);
      loadDay().catch(() => {});
    });
    socket.on('task:due', () => loadDay().catch(() => {}));
    socket.on('task:created', () => loadDay().catch(() => {}));
    socket.on('toast', (t) => toast(t.text, t.kind));

    setInterval(() => {
      if (!document.querySelector('section[data-panel="day"]').classList.contains('hidden')) {
        loadDay().catch(() => {});
      }
    }, 60000);
  })().catch((e) => toast(e.message, 'bad'));
})();
