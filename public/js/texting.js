/* Power Dialer - texting UI (shared by the agent console) */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

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

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(text, kind = '') {
    const host = $('toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    host.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  const S = {
    setup: null,
    templates: [],
    rules: [],
    lists: [],
    dispositions: [],
    tab: 'compose',
    mode: 'one',
    lead: null, // { id, name, phoneDisplay }
    recipients: [],
    selected: new Set(),
    activeTemplateId: null,
    previewTimer: null,
  };

  // -------------------------------------------------------------- data
  async function ensureSetup() {
    if (!S.setup) S.setup = await api('/api/sms/setup');
    return S.setup;
  }
  async function loadTemplates() {
    S.templates = (await api('/api/sms/templates')).templates;
  }
  async function loadRules() {
    const r = await api('/api/sms/rules');
    S.rules = r.rules;
    S.triggers = r.triggers;
  }
  async function loadLists() {
    S.lists = (await api('/api/lists')).lists;
  }
  async function loadDispositions() {
    S.dispositions = (await api('/api/dispositions')).dispositions;
  }

  // -------------------------------------------------------------- shell
  function close() {
    const host = $('modalHost');
    if (host) host.innerHTML = '';
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) {
    if (e.key === 'Escape') close();
  }

  async function open(tab = 'compose', opts = {}) {
    S.tab = tab;
    if (opts.lead) S.lead = opts.lead;
    if (opts.mode) S.mode = opts.mode;

    try {
      await ensureSetup();
      await loadTemplates();
    } catch (err) {
      toast(err.message, 'bad');
      return;
    }

    if (!S.setup.enabled) {
      toast('Texting is switched off in this install.', 'warn');
      return;
    }

    $('modalHost').innerHTML = `
      <div class="modal-back" id="smsBack">
        <div class="modal wide" role="dialog" aria-label="Text messages">
          <div class="row" style="margin-bottom:14px">
            <h3 style="margin:0">Text messages</h3>
            <div class="spacer"></div>
            <span class="small muted" id="smsQuota"></span>
            <button id="smsClose" class="btn-ghost">Close</button>
          </div>
          <div class="tabs" id="smsTabs">
            <button data-t="compose">Send</button>
            <button data-t="templates">My templates</button>
            <button data-t="rules">Auto-texts</button>
            <button data-t="replies">Replies</button>
          </div>
          <div id="smsBody"></div>
        </div>
      </div>`;

    $('smsClose').onclick = close;
    $('smsBack').addEventListener('mousedown', (e) => {
      if (e.target.id === 'smsBack') close();
    });
    document.addEventListener('keydown', onEsc);

    $('smsQuota').textContent = `${S.setup.sentToday} sent today of ${S.setup.dailyCap}`;
    $('smsTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-t]');
      if (b) show(b.dataset.t);
    });
    show(tab);
  }

  function show(tab) {
    S.tab = tab;
    document.querySelectorAll('#smsTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    if (tab === 'compose') renderCompose();
    else if (tab === 'templates') renderTemplates();
    else if (tab === 'rules') renderRules();
    else renderReplies();
  }

  // -------------------------------------------------------------- compose
  function renderCompose() {
    const lead = S.lead;
    const quiet = S.setup.quietHours;

    $('smsBody').innerHTML = `
      <div class="grid cols-2" style="gap:18px">
        <div>
          <label>Who is this going to?</label>
          <div class="chips" id="modePick">
            <button class="chip ${S.mode === 'one' ? 'on' : ''}" data-m="one">One person</button>
            <button class="chip ${S.mode === 'many' ? 'on' : ''}" data-m="many">A group</button>
          </div>

          <div id="oneBox" class="${S.mode === 'one' ? '' : 'hidden'}">
            <label>Phone number</label>
            <input id="smsTo" placeholder="(555) 123-4567"
              value="${lead ? esc(lead.phoneDisplay || '') : ''}" ${lead ? 'readonly' : ''} />
            ${lead ? `<p class="small muted" style="margin:6px 0 0">${esc(lead.name || 'This lead')} &middot; <a href="#" id="clearLead">send to someone else</a></p>` : ''}
          </div>

          <div id="manyBox" class="${S.mode === 'many' ? '' : 'hidden'}">
            <label>Call list</label>
            <select id="smsList"></select>
            <label>Which people</label>
            <select id="smsScope">
              <option value="no_answer">People who did not answer yet</option>
              <option value="spoke_to">People I have spoken to</option>
              <option value="callbacks">Scheduled callbacks</option>
              <option value="my_leads">All of my leads</option>
              <option value="everyone">Everyone on the list</option>
            </select>
            <div class="row mt" style="gap:8px">
              <button id="smsLoadRecips" class="small">Load people</button>
              <button id="smsSelAll" class="small btn-ghost">Select all</button>
              <button id="smsSelNone" class="small btn-ghost">Clear</button>
              <div class="spacer"></div>
              <span class="small muted" id="smsCount">0 selected</span>
            </div>
            <div class="recipients mt" id="smsRecips"><div class="small muted" style="padding:12px">Pick a list and press "Load people".</div></div>
            <label>Or paste numbers</label>
            <textarea id="smsNumbers" rows="2" placeholder="555-123-4567, 555-987-6543"></textarea>
          </div>
        </div>

        <div>
          <label>Start from a template</label>
          <div class="tpl-list" id="smsTplList"></div>

          <label>Message</label>
          <textarea id="smsBodyText" rows="5" placeholder="Type your message. Use the buttons below to drop in their name."></textarea>
          <div class="chips mt" id="smsMerge"></div>

          <label>What they will see</label>
          <div class="sms-preview" id="smsPreview"></div>
          <div class="sms-meta">
            <span id="smsChars">0 characters</span>
            <span id="smsSegs">1 message</span>
            ${quiet ? `<span class="muted">Quiet hours ${quiet.end}:00&ndash;${quiet.start}:00 local</span>` : ''}
          </div>

          <div class="row mt">
            <button id="smsSaveTpl" class="btn-ghost small">Save as template</button>
            <div class="spacer"></div>
            <button id="smsSend" class="btn-primary">Send</button>
          </div>
        </div>
      </div>`;

    // merge field buttons
    $('smsMerge').innerHTML = S.setup.mergeFields
      .map((f) => `<button class="chip" data-tok="${esc(f.token)}" title="${esc(f.label)}">{{${esc(f.token)}}}</button>`)
      .join('');
    $('smsMerge').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tok]');
      if (!b) return;
      insertAtCursor($('smsBodyText'), `{{${b.dataset.tok}}}`);
      schedulePreview();
    });

    renderTemplateChoices();

    $('modePick').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-m]');
      if (!b) return;
      S.mode = b.dataset.m;
      renderCompose();
      if (S.mode === 'many') hydrateLists();
    });

    if ($('clearLead')) {
      $('clearLead').onclick = (e) => {
        e.preventDefault();
        S.lead = null;
        renderCompose();
      };
    }

    $('smsBodyText').addEventListener('input', schedulePreview);
    $('smsSend').onclick = send;
    $('smsSaveTpl').onclick = saveAsTemplate;

    if (S.mode === 'many') {
      hydrateLists();
      $('smsLoadRecips').onclick = loadRecipients;
      $('smsSelAll').onclick = () => toggleAll(true);
      $('smsSelNone').onclick = () => toggleAll(false);
    }

    schedulePreview();
  }

  function renderTemplateChoices() {
    const box = $('smsTplList');
    if (!box) return;
    box.innerHTML = S.templates.length
      ? S.templates
          .map(
            (t) => `<button class="tpl-item ${S.activeTemplateId === t.id ? 'on' : ''}" data-tpl="${t.id}">
              <span class="body">
                <span class="name">${esc(t.name)}${t.shared ? ' <span class="muted small">(shared)</span>' : ''}</span>
                <span class="txt">${esc(t.body)}</span>
              </span>
            </button>`
          )
          .join('')
      : '<p class="small muted">No templates yet. Write a message and press "Save as template".</p>';

    box.querySelectorAll('button[data-tpl]').forEach((b) =>
      b.addEventListener('click', () => {
        const t = S.templates.find((x) => x.id === Number(b.dataset.tpl));
        if (!t) return;
        S.activeTemplateId = t.id;
        $('smsBodyText').value = t.body;
        renderTemplateChoices();
        schedulePreview();
      })
    );
  }

  async function hydrateLists() {
    if (!S.lists.length) {
      try {
        await loadLists();
      } catch {
        /* ignore */
      }
    }
    const sel = $('smsList');
    if (!sel) return;
    sel.innerHTML = S.lists.length
      ? S.lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')
      : '<option value="">No lists assigned to you</option>';
  }

  async function loadRecipients() {
    const listId = $('smsList').value;
    const scope = $('smsScope').value;
    $('smsRecips').innerHTML = '<div class="small muted" style="padding:12px">Loading...</div>';
    try {
      const r = await api(`/api/sms/recipients?listId=${encodeURIComponent(listId)}&scope=${encodeURIComponent(scope)}`);
      S.recipients = r.recipients;
      S.selected = new Set(S.recipients.filter((x) => !x.optedOut).map((x) => x.id));
      paintRecipients();
    } catch (err) {
      $('smsRecips').innerHTML = `<div class="small" style="padding:12px;color:var(--red)">${esc(err.message)}</div>`;
    }
  }

  function paintRecipients() {
    const box = $('smsRecips');
    if (!S.recipients.length) {
      box.innerHTML = '<div class="small muted" style="padding:12px">Nobody matches that filter.</div>';
      updateCount();
      return;
    }
    box.innerHTML = S.recipients
      .map((r) => {
        const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.company || 'Lead';
        return `<label>
          <input type="checkbox" value="${r.id}" ${S.selected.has(r.id) ? 'checked' : ''} ${r.optedOut ? 'disabled' : ''}>
          <span class="who">${esc(name)}</span>
          <span class="num">${esc(r.phoneDisplay)}</span>
          ${r.optedOut ? '<span class="out">opted out</span>' : ''}
        </label>`;
      })
      .join('');
    box.querySelectorAll('input[type=checkbox]').forEach((cb) =>
      cb.addEventListener('change', () => {
        const id = Number(cb.value);
        if (cb.checked) S.selected.add(id);
        else S.selected.delete(id);
        updateCount();
      })
    );
    updateCount();
  }

  function toggleAll(on) {
    S.selected = on ? new Set(S.recipients.filter((r) => !r.optedOut).map((r) => r.id)) : new Set();
    paintRecipients();
  }

  function updateCount() {
    const el = $('smsCount');
    if (el) el.textContent = `${S.selected.size} selected`;
  }

  function insertAtCursor(el, text) {
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.focus();
  }

  function schedulePreview() {
    clearTimeout(S.previewTimer);
    S.previewTimer = setTimeout(preview, 180);
  }

  async function preview() {
    const el = $('smsBodyText');
    if (!el) return;
    try {
      const r = await api('/api/sms/preview', {
        method: 'POST',
        body: { body: el.value, leadId: S.lead ? S.lead.id : null },
      });
      $('smsPreview').textContent = r.text || 'Nothing yet.';
      $('smsChars').textContent = `${r.characters} characters`;
      const segs = $('smsSegs');
      segs.textContent = r.segments === 1 ? '1 message' : `${r.segments} messages`;
      segs.className = r.segments > 2 ? 'over' : '';
    } catch {
      /* ignore */
    }
  }

  async function send() {
    const body = $('smsBodyText').value.trim();
    if (!body) return toast('Write a message first.', 'warn');

    const btn = $('smsSend');
    btn.disabled = true;
    try {
      if (S.mode === 'one') {
        const to = $('smsTo').value.trim();
        if (!S.lead && !to) return toast('Who is it going to?', 'warn');
        await api('/api/sms/send', {
          method: 'POST',
          body: {
            leadId: S.lead ? S.lead.id : null,
            to: S.lead ? null : to,
            body,
            templateId: S.activeTemplateId,
          },
        });
        toast('Text sent.', 'ok');
        close();
      } else {
        const numbers = $('smsNumbers').value.trim();
        const leadIds = [...S.selected];
        if (!leadIds.length && !numbers) return toast('Pick at least one person.', 'warn');
        const r = await api('/api/sms/send-batch', {
          method: 'POST',
          body: { leadIds, numbers, body, templateId: S.activeTemplateId },
        });
        const skipped = r.blocked.length ? `, ${r.blocked.length} skipped` : '';
        toast(`${r.queued} texts queued${skipped}.`, 'ok');
        if (r.blocked.length) {
          const reasons = [...new Set(r.blocked.map((b) => b.reason))].join('; ');
          toast(`Skipped because: ${reasons}`, 'warn');
        }
        close();
      }
      S.setup = null;
      window.dispatchEvent(new CustomEvent('sms:changed'));
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  async function saveAsTemplate() {
    const body = $('smsBodyText').value.trim();
    if (!body) return toast('Write the message first.', 'warn');
    const name = prompt('Name this template:', 'My follow-up');
    if (!name) return;
    try {
      await api('/api/sms/templates', { method: 'POST', body: { name, body } });
      await loadTemplates();
      renderTemplateChoices();
      toast('Template saved.', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  // -------------------------------------------------------------- templates tab
  function renderTemplates() {
    $('smsBody').innerHTML = `
      <p class="small muted">Templates you write are yours. Shared ones come from your administrator.</p>
      <div class="tpl-list" style="max-height:none" id="tplManage"></div>
      <div class="card mt" style="background:var(--panel-2)">
        <h2>New template</h2>
        <label>Name</label><input id="ntName" placeholder="Missed you - callback ask" />
        <label>Message</label><textarea id="ntBody" rows="4"></textarea>
        <div class="chips mt" id="ntMerge"></div>
        <div class="row mt"><div class="spacer"></div><button class="btn-primary" id="ntSave">Save template</button></div>
      </div>`;

    $('ntMerge').innerHTML = S.setup.mergeFields
      .map((f) => `<button class="chip" data-tok="${esc(f.token)}" title="${esc(f.label)}">{{${esc(f.token)}}}</button>`)
      .join('');
    $('ntMerge').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tok]');
      if (b) insertAtCursor($('ntBody'), `{{${b.dataset.tok}}}`);
    });

    paintTemplateManager();

    $('ntSave').onclick = async () => {
      try {
        await api('/api/sms/templates', {
          method: 'POST',
          body: { name: $('ntName').value, body: $('ntBody').value },
        });
        $('ntName').value = '';
        $('ntBody').value = '';
        await loadTemplates();
        paintTemplateManager();
        toast('Template saved.', 'ok');
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  }

  function paintTemplateManager() {
    $('tplManage').innerHTML = S.templates
      .map(
        (t) => `<div class="tpl-item" style="cursor:default">
          <span class="body">
            <span class="name">${esc(t.name)}${t.shared ? ' <span class="muted small">(shared)</span>' : ''}
              <span class="muted small"> &middot; ${t.segments} msg</span></span>
            <span class="txt" style="-webkit-line-clamp:3">${esc(t.body)}</span>
          </span>
          ${t.mine ? `<button class="small" data-edit="${t.id}">Edit</button><button class="small btn-ghost" data-del="${t.id}">Delete</button>` : ''}
        </div>`
      )
      .join('');

    $('tplManage')
      .querySelectorAll('button[data-edit]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          const t = S.templates.find((x) => x.id === Number(b.dataset.edit));
          const body = prompt('Edit the message:', t.body);
          if (body === null) return;
          try {
            await api(`/api/sms/templates/${t.id}`, { method: 'PATCH', body: { body } });
            await loadTemplates();
            paintTemplateManager();
          } catch (err) {
            toast(err.message, 'bad');
          }
        })
      );
    $('tplManage')
      .querySelectorAll('button[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Delete this template?')) return;
          await api(`/api/sms/templates/${b.dataset.del}`, { method: 'DELETE' });
          await loadTemplates();
          paintTemplateManager();
        })
      );
  }

  // -------------------------------------------------------------- rules tab
  const TRIGGER_LABEL = {
    answered: 'they answered and we spoke',
    no_answer: 'they did not answer',
    voicemail: 'we reached voicemail',
    abandoned: 'they answered but nobody was free',
    busy: 'the line was busy',
    disposition: 'I pick a certain disposition',
  };

  async function renderRules() {
    $('smsBody').innerHTML = '<p class="small muted">Loading...</p>';
    await loadRules();
    if (!S.dispositions.length) await loadDispositions();
    if (!S.lists.length) {
      try {
        await loadLists();
      } catch {
        /* ignore */
      }
    }

    $('smsBody').innerHTML = `
      <p class="small muted">A text goes out on its own when a call ends a certain way. Quiet hours and opt-outs still apply.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>When</th><th>Send</th><th>Delay</th><th>Scope</th><th>On</th><th></th></tr></thead>
          <tbody id="ruleRows"></tbody>
        </table>
      </div>
      <div class="card mt" style="background:var(--panel-2)">
        <h2>New auto-text</h2>
        <div class="grid cols-2">
          <div>
            <label>Send when...</label>
            <select id="rTrigger">${S.triggers.map((t) => `<option value="${t}">${esc(TRIGGER_LABEL[t] || t)}</option>`).join('')}</select>
            <div id="rDispBox" class="hidden">
              <label>Which disposition</label>
              <select id="rDisp">${S.dispositions.map((d) => `<option value="${esc(d.code)}">${esc(d.label)}</option>`).join('')}</select>
            </div>
            <label>Only for this list (optional)</label>
            <select id="rList"><option value="">Any list</option>${S.lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
          </div>
          <div>
            <label>Send this template</label>
            <select id="rTpl">${S.templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
            <label>Wait before sending (minutes)</label>
            <input id="rDelay" type="number" min="0" max="10080" value="0" />
            <label style="text-transform:none;letter-spacing:0;color:var(--text);font-size:13.5px">
              <input type="checkbox" id="rOnce" checked style="width:auto"> Only ever text each person once from this rule
            </label>
          </div>
        </div>
        <div class="row mt"><div class="spacer"></div><button class="btn-primary" id="rSave">Create auto-text</button></div>
      </div>`;

    $('rTrigger').addEventListener('change', () => {
      $('rDispBox').classList.toggle('hidden', $('rTrigger').value !== 'disposition');
    });

    paintRules();

    $('rSave').onclick = async () => {
      try {
        await api('/api/sms/rules', {
          method: 'POST',
          body: {
            trigger: $('rTrigger').value,
            disposition: $('rDisp') ? $('rDisp').value : '',
            templateId: Number($('rTpl').value),
            listId: $('rList').value || null,
            delayMinutes: Number($('rDelay').value) || 0,
            oncePerLead: $('rOnce').checked,
          },
        });
        await loadRules();
        paintRules();
        toast('Auto-text created.', 'ok');
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  }

  function paintRules() {
    $('ruleRows').innerHTML = S.rules.length
      ? S.rules
          .map((r) => {
            const disp = r.trigger === 'disposition' && r.disposition ? ` (${esc(r.disposition)})` : '';
            return `<tr>
          <td>${esc(TRIGGER_LABEL[r.trigger] || r.trigger)}${disp}</td>
          <td>${esc(r.template_name)}</td>
          <td>${r.delay_minutes ? `${r.delay_minutes} min` : 'right away'}</td>
          <td class="small muted">${r.global ? 'everyone' : 'me'}${r.list_id ? ' &middot; one list' : ''}</td>
          <td>${r.active ? 'yes' : 'no'}</td>
          <td class="row">
            ${r.mine || r.global ? `<button class="small" data-toggle="${r.id}" data-a="${r.active ? 0 : 1}">${r.active ? 'Turn off' : 'Turn on'}</button>` : ''}
            ${r.mine ? `<button class="small btn-ghost" data-del="${r.id}">Delete</button>` : ''}
          </td></tr>`;
          })
          .join('')
      : '<tr><td colspan="6" class="muted">No auto-texts yet.</td></tr>';

    $('ruleRows')
      .querySelectorAll('button[data-toggle]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            await api(`/api/sms/rules/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.a === '1' } });
            await loadRules();
            paintRules();
          } catch (err) {
            toast(err.message, 'bad');
          }
        })
      );
    $('ruleRows')
      .querySelectorAll('button[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Delete this auto-text?')) return;
          await api(`/api/sms/rules/${b.dataset.del}`, { method: 'DELETE' });
          await loadRules();
          paintRules();
        })
      );
  }

  // -------------------------------------------------------------- replies tab
  async function renderReplies() {
    $('smsBody').innerHTML = '<p class="small muted">Loading...</p>';
    const { inbox } = await api('/api/sms/inbox');
    window.dispatchEvent(new CustomEvent('sms:read'));

    $('smsBody').innerHTML = inbox.length
      ? `<div>${inbox
          .map(
            (m) => `<div class="reply-row ${m.unread ? 'unread' : ''}" ${m.leadId ? `data-lead="${m.leadId}"` : ''}>
          <div class="row" style="gap:8px">
            <span class="who">${esc(m.name || m.fromDisplay)}</span>
            <span class="muted small">${esc(m.fromDisplay)}</span>
            <div class="spacer"></div>
            <span class="muted small">${esc(m.at)}</span>
          </div>
          <div class="txt">${esc(m.body)}</div>
        </div>`
          )
          .join('')}</div>`
      : '<p class="small muted">No replies yet.</p>';

    $('smsBody')
      .querySelectorAll('.reply-row[data-lead]')
      .forEach((row) => row.addEventListener('click', () => openThread(Number(row.dataset.lead))));
  }

  async function openThread(leadId) {
    const { thread } = await api(`/api/sms/thread/${leadId}`);
    const lead = await api(`/api/leads/${leadId}`).catch(() => null);
    const name = lead ? [lead.lead.firstName, lead.lead.lastName].filter(Boolean).join(' ') || lead.lead.company : 'Lead';

    $('smsBody').innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <button class="small btn-ghost" id="backToReplies">&larr; Back</button>
        <b>${esc(name)}</b>
        <span class="muted small">${esc(lead ? lead.lead.phoneDisplay : '')}</span>
      </div>
      <div class="thread" id="threadBox">${thread
        .map((m) => {
          const cls = m.direction === 'inbound' ? 'in' : `out ${m.status === 'failed' || m.status === 'undelivered' ? 'failed' : m.status === 'queued' ? 'queued' : ''}`;
          const label = m.direction === 'inbound' ? m.created_at : `${m.created_at} &middot; ${esc(m.status)}`;
          return `<div class="bubble ${cls}">${esc(m.body || m.error)}<span class="when">${label}</span></div>`;
        })
        .join('')}</div>
      <label>Reply</label>
      <textarea id="threadReply" rows="3"></textarea>
      <div class="row mt"><div class="spacer"></div><button class="btn-primary" id="threadSend">Send</button></div>`;

    const box = $('threadBox');
    box.scrollTop = box.scrollHeight;

    $('backToReplies').onclick = renderReplies;
    $('threadSend').onclick = async () => {
      const body = $('threadReply').value.trim();
      if (!body) return;
      try {
        await api('/api/sms/send', { method: 'POST', body: { leadId, body } });
        toast('Sent.', 'ok');
        openThread(leadId);
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  }

  // -------------------------------------------------------------- quick chips
  /** Renders one-tap template buttons into a container, for the wrap-up card. */
  async function quickChips(container, getLead) {
    try {
      await ensureSetup();
      if (!S.templates.length) await loadTemplates();
    } catch {
      return;
    }
    if (!S.setup.enabled) {
      container.innerHTML = '<span class="small muted">texting off</span>';
      return;
    }
    container.innerHTML =
      S.templates
        .slice(0, 4)
        .map((t) => `<button class="chip" data-quick="${t.id}">${esc(t.name)}</button>`)
        .join('') + '<button class="chip" data-quick="more">More...</button>';

    container.querySelectorAll('button[data-quick]').forEach((b) =>
      b.addEventListener('click', async () => {
        const lead = getLead();
        if (b.dataset.quick === 'more') return open('compose', { lead, mode: 'one' });
        if (!lead) return toast('No lead on screen.', 'warn');
        b.disabled = true;
        try {
          await api('/api/sms/send', {
            method: 'POST',
            body: { leadId: lead.id, templateId: Number(b.dataset.quick) },
          });
          b.classList.add('on');
          b.textContent = 'Sent';
          toast('Text sent.', 'ok');
        } catch (err) {
          b.disabled = false;
          toast(err.message, 'bad');
        }
      })
    );
  }

  window.Texting = { open, close, quickChips, refreshTemplates: loadTemplates };
})();
