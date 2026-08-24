/* Power Dialer - admin console */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.raw ? undefined : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: opts.raw ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
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

  let users = [];
  let me = null;

  // ------------------------------------------------------------------ tabs
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('section[data-panel]').forEach((s) =>
      s.classList.toggle('hidden', s.dataset.panel !== b.dataset.tab)
    );
    load(b.dataset.tab);
  });

  // ------------------------------------------------------------------ dashboard
  async function loadDash() {
    const o = await api('/api/admin/overview');
    $('kCalls').textContent = o.today.calls;
    $('kConnects').textContent = o.today.connects;
    $('kAbandon').textContent = `${(o.today.abandonRate * 100).toFixed(1)}%`;
    $('kTalk').textContent = fmtTime(o.today.talkSeconds);
    $('kLeads').textContent = o.leadsLeft;
    $('twimlUrl').value = o.twimlUrl;
    $('smsInboundUrl').value = o.smsInboundUrl;
    $('twimlUrl2').value = o.twimlUrl;
    $('smsInboundUrl2').value = o.smsInboundUrl;

    $('setupWarnings').innerHTML = o.warnings.length
      ? `<div class="banner bad"><b>Setup incomplete:</b><br>${o.warnings.map(esc).join('<br>')}</div>`
      : '';
    if (o.today.abandonRate > 0.03 && o.today.calls > 30) {
      $('setupWarnings').innerHTML +=
        `<div class="banner warn">Abandon rate is ${(o.today.abandonRate * 100).toFixed(1)}%. Federal safe harbour is 3% - lower the lines per agent.</div>`;
    }
    loadStations();
  }

  async function loadStations() {
    const { stations } = await api('/api/admin/stations');
    $('stationRows').innerHTML = stations.length
      ? stations
          .map(
            (s) => `<tr>
        <td>${esc(s.agent.name || s.agent.email)}</td>
        <td><span class="pill ${({ connected: 'live', dialing: 'live', ready: 'ok', wrap: 'warn', paused: 'warn', offline: '' })[s.status] || ''}"><span class="dot"></span>${esc(s.status)}</span></td>
        <td>${s.lines}</td>
        <td>${s.onCall && s.onCall.lead ? esc([s.onCall.lead.firstName, s.onCall.lead.lastName].filter(Boolean).join(' ') || s.onCall.lead.company || s.onCall.lead.phoneDisplay) : '<span class="muted">-</span>'}</td>
        <td>${s.stats.placed}</td><td>${s.stats.connects}</td><td>${s.stats.abandons}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="7" class="muted">Nobody is signed in yet.</td></tr>';
  }

  // ------------------------------------------------------------------ lists
  $('listFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    $('uploadResult').innerHTML = '<div class="banner">Reading your file...</div>';
    try {
      const res = await fetch('/api/admin/lists/preview', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      renderMapping(data, file.name);
    } catch (err) {
      $('uploadResult').innerHTML = `<div class="banner bad">${esc(err.message)}</div>`;
    }
  });

  function renderMapping(d, filename) {
    const opts = (sel) =>
      `<option value="">- none -</option>` +
      d.headers.map((h) => `<option value="${esc(h)}"${h === sel ? ' selected' : ''}>${esc(h)}</option>`).join('');

    $('uploadResult').innerHTML = `
      <div class="banner ${d.validPhones ? 'ok' : 'bad'}">
        Found <b>${d.rowCount}</b> rows - <b>${d.validPhones}</b> usable phone numbers${d.invalidPhones ? `, ${d.invalidPhones} unusable` : ''}.
      </div>
      <label>List name</label>
      <input id="mName" value="${esc(filename.replace(/\.[^.]+$/, ''))}" />
      <div class="grid cols-2 mt">
        <div>
          <label>Phone column *</label><select id="mPhone">${opts(d.mapping.phone)}</select>
          <label>First name</label><select id="mFirst">${opts(d.mapping.firstName)}</select>
          <label>Last name</label><select id="mLast">${opts(d.mapping.lastName)}</select>
        </div>
        <div>
          <label>Full name (if not split)</label><select id="mFull">${opts(d.mapping.fullName)}</select>
          <label>Company</label><select id="mCompany">${opts(d.mapping.company)}</select>
          <label>Email</label><select id="mEmail">${opts(d.mapping.email)}</select>
        </div>
      </div>
      <p class="small muted mt" style="margin-bottom:0">Deal details, if your sheet has them. Anything you leave as "none" is still kept and shown on the merchant record.</p>
      <div class="grid cols-2">
        <div>
          <label>Monthly revenue</label><select id="mRev">${opts(d.mapping.monthlyRevenue)}</select>
          <label>Annual revenue</label><select id="mAnnual">${opts(d.mapping.annualRevenue)}</select>
          <label>Time in business</label><select id="mTib">${opts(d.mapping.timeInBusiness)}</select>
          <label>Amount requested</label><select id="mAsk">${opts(d.mapping.requestedAmount)}</select>
        </div>
        <div>
          <label>Industry</label><select id="mIndustry">${opts(d.mapping.industry)}</select>
          <label>State</label><select id="mState">${opts(d.mapping.state)}</select>
          <label>Open positions</label><select id="mPos">${opts(d.mapping.positions)}</select>
          <label>FICO</label><select id="mFico">${opts(d.mapping.fico)}</select>
        </div>
      </div>
      <label>Assign to</label>
      <div id="mAssign" class="row">${users
        .filter((u) => u.active)
        .map((u) => `<label style="margin:0"><input type="checkbox" value="${u.id}" style="width:auto"> ${esc(u.name || u.email)}</label>`)
        .join('')}</div>
      <div class="row mt">
        <label style="margin:0"><input type="checkbox" id="mDup" checked style="width:auto"> Skip numbers already in the system</label>
        <label style="margin:0"><input type="checkbox" id="mDnc" checked style="width:auto"> Skip numbers on the Do Not Call list</label>
        <div class="spacer"></div>
        <button class="btn-primary" id="mImport">Import list</button>
      </div>`;

    $('mImport').addEventListener('click', async () => {
      const mapping = {
        phone: $('mPhone').value,
        firstName: $('mFirst').value,
        lastName: $('mLast').value,
        fullName: $('mFull').value,
        company: $('mCompany').value,
        email: $('mEmail').value,
        monthlyRevenue: $('mRev').value,
        annualRevenue: $('mAnnual').value,
        timeInBusiness: $('mTib').value,
        requestedAmount: $('mAsk').value,
        industry: $('mIndustry').value,
        state: $('mState').value,
        positions: $('mPos').value,
        fico: $('mFico').value,
      };
      if (!mapping.phone) return toast('Pick the phone column.', 'warn');
      const assignTo = [...document.querySelectorAll('#mAssign input:checked')].map((i) => Number(i.value));
      try {
        const r = await api('/api/admin/lists/import', {
          method: 'POST',
          body: {
            token: d.token,
            name: $('mName').value,
            mapping,
            assignTo,
            skipDuplicates: $('mDup').checked,
            skipDnc: $('mDnc').checked,
          },
        });
        $('uploadResult').innerHTML = `<div class="banner ok">Imported <b>${r.imported}</b> leads.
          ${r.skippedDuplicates ? `${r.skippedDuplicates} duplicates skipped. ` : ''}
          ${r.skippedDnc ? `${r.skippedDnc} on the Do Not Call list. ` : ''}
          ${r.invalid ? `${r.invalid} had no usable number.` : ''}</div>`;
        $('listFile').value = '';
        loadLists();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
  }

  async function loadLists() {
    const { lists } = await api('/api/admin/lists');
    $('listRows').innerHTML = lists.length
      ? lists
          .map(
            (l) => `<tr>
        <td>${esc(l.name)}${l.archived ? ' <span class="muted small">(archived)</span>' : ''}</td>
        <td>${l.counts.total || 0}</td>
        <td>${l.counts.remaining || 0}</td>
        <td class="small">${l.assigned.map((a) => esc(a.name || a.email)).join(', ') || '<span class="muted">nobody</span>'}</td>
        <td class="small">
          <select data-rec="${l.id}" style="min-width:130px">
            <option value=""${l.record_calls === null ? ' selected' : ''}>Use default</option>
            <option value="1"${l.record_calls === 1 ? ' selected' : ''}>Record</option>
            <option value="0"${l.record_calls === 0 ? ' selected' : ''}>Do not record</option>
          </select>
        </td>
        <td class="row">
          <button data-assign="${l.id}" class="small">Assign</button>
          <a class="btn small" href="/api/admin/lists/${l.id}/export">Export</a>
          <button data-reset="${l.id}" class="small">Reset</button>
          <button data-del="${l.id}" class="small btn-danger">Delete</button>
        </td></tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="muted">No lists yet - upload a spreadsheet above.</td></tr>';

    $('listRows')
      .querySelectorAll('select[data-rec]')
      .forEach((s) =>
        s.addEventListener('change', async () => {
          const v = s.value === '' ? null : s.value === '1';
          await api(`/api/admin/lists/${s.dataset.rec}/recording`, { method: 'POST', body: { record: v } });
          toast('Saved.', 'ok');
        })
      );

    $('listRows')
      .querySelectorAll('button[data-assign]')
      .forEach((b) => b.addEventListener('click', () => assignModal(Number(b.dataset.assign), lists)));
    $('listRows')
      .querySelectorAll('button[data-reset]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Put every lead in this list back in the queue?')) return;
          const r = await api(`/api/admin/lists/${b.dataset.reset}/reset`, { method: 'POST', body: {} });
          toast(`${r.reset} leads re-queued.`, 'ok');
          loadLists();
        })
      );
    $('listRows')
      .querySelectorAll('button[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Delete this list and all of its leads? This cannot be undone.')) return;
          await api(`/api/admin/lists/${b.dataset.del}`, { method: 'DELETE' });
          loadLists();
        })
      );
  }

  function assignModal(listId, lists) {
    const list = lists.find((l) => l.id === listId);
    const assigned = new Set(list.assigned.map((a) => a.id));
    $('modalHost').innerHTML = `<div class="modal-back"><div class="modal">
      <h3>Who works "${esc(list.name)}"?</h3>
      <div>${users
        .filter((u) => u.active)
        .map(
          (u) =>
            `<label style="margin:6px 0"><input type="checkbox" value="${u.id}" ${assigned.has(u.id) ? 'checked' : ''} style="width:auto"> ${esc(u.name || u.email)}</label>`
        )
        .join('')}</div>
      <div class="row mt"><div class="spacer"></div>
        <button id="mCancel">Cancel</button>
        <button class="btn-primary" id="mSave">Save</button></div>
    </div></div>`;
    $('mCancel').onclick = () => ($('modalHost').innerHTML = '');
    $('mSave').onclick = async () => {
      const ids = [...$('modalHost').querySelectorAll('input:checked')].map((i) => Number(i.value));
      await api(`/api/admin/lists/${listId}/assign`, { method: 'POST', body: { userIds: ids } });
      $('modalHost').innerHTML = '';
      loadLists();
    };
  }

  // ------------------------------------------------------------------ people
  async function loadUsers() {
    const r = await api('/api/admin/users');
    users = r.users;

    const pending = users.filter((u) => u.pendingApproval);
    if ($('pendingBox')) {
      $('pendingBox').innerHTML = pending.length
        ? `<div class="banner warn"><b>${pending.length} ${pending.length === 1 ? 'person is' : 'people are'} waiting for approval:</b><br>${pending
            .map((u) => `${esc(u.name || '')} ${esc(u.email)} <button class="small" data-approve="${u.id}">Approve</button>`)
            .join('<br>')}</div>`
        : '';
      $('pendingBox')
        .querySelectorAll('button[data-approve]')
        .forEach((b) =>
          b.addEventListener('click', async () => {
            await api(`/api/admin/users/${b.dataset.approve}/approve`, { method: 'POST', body: {} });
            toast('Approved. They can sign in now.', 'ok');
            loadUsers();
          })
        );
    }

    if ($('signupNote')) {
      try {
        const p = await (await fetch('/signup-policy')).json();
        $('signupNote').textContent = p.enabled
          ? `Employees can also sign up themselves at ${location.origin}/signup${
              p.domains.length ? ` using a ${p.domains.map((d) => '@' + d).join(' or ')} address` : ''
            }.${p.emailWorks ? '' : ' Email is not configured yet, so invites and password resets will not send.'}`
          : 'Self sign-up is switched off. Add people here.';
      } catch {
        /* ignore */
      }
    }

    $('userRows').innerHTML = users
      .map((u) => {
        const status = u.pendingApproval
          ? '<span class="pill warn"><span class="dot"></span>waiting</span>'
          : u.active
          ? '<span class="pill ok"><span class="dot"></span>active</span>'
          : '<span class="pill bad"><span class="dot"></span>off</span>';
        const isMe = me && u.id === me.id;
        return `<tr>
      <td><a href="#" data-open="${u.id}">${esc(u.name || '-')}</a>${isMe ? ' <span class="muted small">(you)</span>' : ''}</td>
      <td>${esc(u.email)}</td>
      <td>
        <select data-role="${u.id}" ${isMe ? 'disabled title="You cannot change your own role"' : ''} style="min-width:120px">
          <option value="agent"${u.role === 'agent' ? ' selected' : ''}>Employee</option>
          <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Administrator</option>
        </select>
      </td>
      <td><input type="number" min="1" max="5" value="${u.maxLines}" data-lines="${u.id}" style="width:64px" /></td>
      <td>${status}</td>
      <td class="small muted">${esc(u.lastLoginAt || 'never')}</td>
      <td class="row">
        ${u.pendingApproval ? `<button data-approve2="${u.id}" class="small btn-primary">Approve</button>` : ''}
        ${isMe ? '' : `<button data-toggle="${u.id}" data-active="${u.active ? 0 : 1}" class="small">${u.active ? 'Disable' : 'Enable'}</button>`}
        <button data-reset="${u.id}" class="small">Email reset link</button>
        ${isMe ? '' : `<button data-remove="${u.id}" class="small btn-danger">Remove</button>`}
      </td></tr>`;
      })
      .join('');

    $('userRows')
      .querySelectorAll('a[data-open]')
      .forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          openUser(Number(a.dataset.open));
        })
      );
    $('userRows')
      .querySelectorAll('select[data-role]')
      .forEach((sel) =>
        sel.addEventListener('change', async () => {
          try {
            await api(`/api/admin/users/${sel.dataset.role}`, { method: 'PATCH', body: { role: sel.value } });
            toast(sel.value === 'admin' ? 'They are an administrator now.' : 'Administrator access removed.', 'ok');
            loadUsers();
          } catch (err) {
            toast(err.message, 'bad');
            loadUsers();
          }
        })
      );
    $('userRows')
      .querySelectorAll('input[data-lines]')
      .forEach((inp) =>
        inp.addEventListener('change', async () => {
          try {
            await api(`/api/admin/users/${inp.dataset.lines}`, {
              method: 'PATCH',
              body: { maxLines: Number(inp.value) },
            });
            toast('Saved.', 'ok');
          } catch (err) {
            toast(err.message, 'bad');
          }
        })
      );
    $('userRows')
      .querySelectorAll('button[data-remove]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          const u = users.find((x) => x.id === Number(b.dataset.remove));
          if (u) confirmRemove(u);
        })
      );

    $('userRows')
      .querySelectorAll('button[data-approve2]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/admin/users/${b.dataset.approve2}/approve`, { method: 'POST', body: {} });
          loadUsers();
        })
      );
    $('userRows')
      .querySelectorAll('button[data-toggle]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/admin/users/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active === '1' } });
          loadUsers();
        })
      );
    $('userRows')
      .querySelectorAll('button[data-reset]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            const r2 = await api(`/api/admin/users/${b.dataset.reset}/reset-link`, { method: 'POST', body: {} });
            if (r2.link) {
              prompt('Email is not configured, so send them this link yourself:', r2.link);
            } else {
              toast('Reset link emailed.', 'ok');
            }
          } catch (err) {
            toast(err.message, 'bad');
          }
        })
      );
  }

  $('addUser').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/users', {
        method: 'POST',
        body: {
          name: $('uName').value,
          email: $('uEmail').value,
          password: $('uPass').value,
          role: $('uAdmin').checked ? 'admin' : 'agent',
          maxLines: Number($('uLines').value) || 3,
          invite: !$('uPass').value,
        },
      });
      ['uName', 'uEmail', 'uPass'].forEach((i) => ($(i).value = ''));
      if (r.invited && r.link) {
        $('inviteResult').innerHTML = `<div class="banner warn">Email is not configured yet, so send them this link yourself:<br>
          <input readonly value="${esc(r.link)}" onclick="this.select()"></div>`;
      } else if (r.invited) {
        $('inviteResult').innerHTML = '<div class="banner ok">Invite sent. They pick their own password from the email.</div>';
      } else {
        $('inviteResult').innerHTML = '<div class="banner ok">Employee added.</div>';
      }
      loadUsers();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  // ------------------------------------------------------------------ numbers
  async function loadNumbers() {
    const { numbers } = await api('/api/admin/numbers');
    $('numberRows').innerHTML = numbers.length
      ? numbers
          .map(
            (n) => `<tr><td>${esc(n.display || n.phone)}</td>
        <td class="small">${n.area_code ? `<b>${esc(n.area_code)}</b> &middot; ${esc(n.region || 'Unknown')}` : '<span class="muted">outside the US and Canada</span>'}</td>
        <td>${esc(n.friendly_name)}</td>
        <td>${n.active ? 'yes' : 'no'}</td>
        <td>${n.sms_capable ? 'yes' : 'no'}</td>
        <td class="small muted">${n.use_count || 0}</td>
        <td class="row"><button data-toggle="${n.id}" data-a="${n.active ? 0 : 1}" class="small">${n.active ? 'Disable' : 'Enable'}</button>
        <button data-sms="${n.id}" data-s="${n.sms_capable ? 0 : 1}" class="small">${n.sms_capable ? 'No texting' : 'Allow texting'}</button>
        <button data-del="${n.id}" class="small btn-danger">Remove</button></td></tr>`
          )
          .join('')
      : '<tr><td colspan="7" class="muted">No caller IDs yet. Nothing can be dialed until you add one.</td></tr>';

    loadCoverage().catch(() => {});

    $('numberRows')
      .querySelectorAll('button[data-sms]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/admin/numbers/${b.dataset.sms}/sms`, { method: 'POST', body: { smsCapable: b.dataset.s === '1' } });
          loadNumbers();
        })
      );

    $('numberRows')
      .querySelectorAll('button[data-toggle]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/admin/numbers/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.a === '1' } });
          loadNumbers();
        })
      );
    $('numberRows')
      .querySelectorAll('button[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/admin/numbers/${b.dataset.del}`, { method: 'DELETE' });
          loadNumbers();
        })
      );
  }

  // ------------------------------------------------------------------ local presence
  let coverageLists = null;

  async function loadCoverage() {
    const listId = $('covList').value || '';
    const { coverage, strategies } = await api(`/api/admin/numbers/coverage${listId ? `?list=${listId}` : ''}`);

    if (!$('covStrategy').dataset.filled) {
      $('covStrategy').innerHTML = Object.entries(strategies)
        .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
        .join('');
      $('covStrategy').dataset.filled = '1';
    }
    $('covStrategy').value = coverage.strategy;

    if (!coverageLists) {
      const { lists } = await api('/api/admin/lists');
      coverageLists = lists;
      $('covList').innerHTML =
        '<option value="">Every list</option>' +
        lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    }

    const t = coverage.totals;
    const show = (id, n, p) => {
      $(id).textContent = t.leads ? `${Math.round(p * 100)}%` : '-';
      $(id).title = `${n.toLocaleString()} merchants`;
    };
    show('covExact', t.exact, t.exactPct);
    show('covState', t.state, t.statePct);
    show('covZone', t.timezone, t.timezonePct);
    show('covNone', t.none, t.nonePct);

    const gaps = coverage.gaps.filter((g) => g.level !== 'state' || true);
    $('covGaps').innerHTML = gaps.length
      ? gaps
          .map((g) => {
            const max = Math.max(...gaps.map((x) => x.leads), 1);
            const note =
              g.level === 'none' ? 'nothing close' : g.level === 'state' ? 'same state only' : 'same timezone only';
            return `<div class="bar-row">
              <span><b>${esc(g.areaCode)}</b> <span class="muted">${esc(g.region || 'Unknown')}</span></span>
              <span class="track"><span class="fill" style="width:${Math.max(2, (g.leads / max) * 100)}%"></span></span>
              <span class="amt">${g.leads.toLocaleString()} merchant${g.leads === 1 ? '' : 's'} &middot; ${note}</span>
            </div>`;
          })
          .join('')
      : '<p class="small muted">Every area code in your lists is covered by a number you already own.</p>';
  }

  $('covList').addEventListener('change', () => loadCoverage().catch((e) => toast(e.message, 'bad')));
  $('covStrategy').addEventListener('change', async () => {
    try {
      await api('/api/admin/settings', { method: 'POST', body: { caller_id_strategy: $('covStrategy').value } });
      toast('Saved.', 'ok');
      loadCoverage();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('addNumber').addEventListener('click', async () => {
    try {
      await api('/api/admin/numbers', { method: 'POST', body: { phone: $('numPhone').value, friendlyName: $('numLabel').value } });
      $('numPhone').value = '';
      $('numLabel').value = '';
      loadNumbers();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('syncNumbers').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/numbers/sync', { method: 'POST', body: {} });
      toast(`Found ${r.found} numbers on your Twilio account, added ${r.added}.`, 'ok');
      loadNumbers();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  // ------------------------------------------------------------------ dnc
  async function loadDnc() {
    const r = await api('/api/admin/dnc');
    $('dncCount').innerHTML = `<span class="dot"></span> ${r.total} numbers`;
    $('dncRows').innerHTML = r.dnc.length
      ? r.dnc
          .map(
            (d) => `<tr><td>${esc(d.phoneDisplay)}</td><td>${esc(d.reason)}</td><td class="small muted">${esc(d.created_at)}</td>
        <td><button data-del="${d.id}" class="small">Remove</button></td></tr>`
          )
          .join('')
      : '<tr><td colspan="4" class="muted">Nothing on the list yet.</td></tr>';
    $('dncRows')
      .querySelectorAll('button[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/admin/dnc/${b.dataset.del}`, { method: 'DELETE' });
          loadDnc();
        })
      );
  }

  $('addDnc').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/dnc', { method: 'POST', body: { numbers: $('dncInput').value } });
      $('dncInput').value = '';
      toast(`Added ${r.added} numbers.${r.invalid.length ? ` ${r.invalid.length} could not be read.` : ''}`, 'ok');
      loadDnc();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('dncFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    const res = await fetch('/api/admin/dnc/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) return toast(data.error, 'bad');
    toast(`Added ${data.added} numbers from column "${data.column}".`, 'ok');
    $('dncFile').value = '';
    loadDnc();
  });

  // ------------------------------------------------------------------ settings
  async function loadSettings() {
    const r = await api('/api/admin/settings');
    const s = r.settings;
    $('setThrottle').checked = s.auto_throttle === null ? true : s.auto_throttle === 'true';
    $('setVoicemail').checked = s.drop_voicemail === 'true';
    $('setLeaderboard').checked = s.leaderboard_visible === null ? true : s.leaderboard_visible === 'true';
    $('setVmText').value = s.voicemail_message || '';
    $('setInbound').value = s.inbound_forward_to || '';
    $('setOptOutReply').value =
      s.sms_optout_reply === null
        ? 'You have been unsubscribed and will not receive further messages.'
        : s.sms_optout_reply;

    $('envRows').innerHTML = Object.entries(r.env)
      .map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td><b>${esc(String(v))}</b></td></tr>`)
      .join('');

    const { dispositions } = await api('/api/admin/dispositions');
    $('dispRows').innerHTML = dispositions
      .map(
        (d) => `<tr><td>${esc(d.label)}</td><td class="muted">${esc(d.code)}</td><td>${esc(d.kind)}</td><td>${esc(d.hotkey)}</td>
      <td><button data-del="${d.id}" class="small">Remove</button></td></tr>`
      )
      .join('');
    $('dispRows')
      .querySelectorAll('button[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/admin/dispositions/${b.dataset.del}`, { method: 'DELETE' });
          loadSettings();
        })
      );
  }

  $('saveSettings').addEventListener('click', async () => {
    await api('/api/admin/settings', {
      method: 'POST',
      body: {
        auto_throttle: String($('setThrottle').checked),
        drop_voicemail: String($('setVoicemail').checked),
        leaderboard_visible: String($('setLeaderboard').checked),
        voicemail_message: $('setVmText').value,
        inbound_forward_to: $('setInbound').value,
        sms_optout_reply: $('setOptOutReply').value,
      },
    });
    toast('Saved.', 'ok');
  });

  $('addDisp').addEventListener('click', async () => {
    try {
      await api('/api/admin/dispositions', {
        method: 'POST',
        body: { label: $('dLabel').value, code: $('dCode').value || $('dLabel').value, kind: $('dKind').value, hotkey: $('dKey').value },
      });
      $('dLabel').value = '';
      $('dCode').value = '';
      $('dKey').value = '';
      loadSettings();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  // ------------------------------------------------------------------ person detail
  async function openUser(id) {
    $('modalHost').innerHTML = `<div class="modal-back" id="uBack"><div class="modal wide"><p class="muted">Loading...</p></div></div>`;
    $('uBack').addEventListener('mousedown', (e) => {
      if (e.target.id === 'uBack') $('modalHost').innerHTML = '';
    });

    let d;
    try {
      d = await api(`/api/admin/users/${id}/detail`);
    } catch (err) {
      $('modalHost').innerHTML = `<div class="modal-back" id="uBack"><div class="modal"><p class="banner bad">${esc(err.message)}</p></div></div>`;
      return;
    }

    const u = d.user;
    const statusPill = ({ connected: 'live', dialing: 'live', ready: 'ok', wrap: 'warn', paused: 'warn', offline: '' })[d.station.status] || '';

    $('modalHost').innerHTML = `<div class="modal-back" id="uBack"><div class="modal wide">
      <div class="row" style="margin-bottom:14px">
        <div>
          <h3 style="margin:0">${esc(u.name || u.email)}</h3>
          <span class="muted small">${esc(u.email)} · ${esc(u.role)} · ${u.maxLines} line${u.maxLines === 1 ? '' : 's'}</span>
        </div>
        <div class="spacer"></div>
        <span class="pill ${statusPill}"><span class="dot"></span>${esc(d.station.status)}</span>
        <button id="uClose" class="btn-ghost">Close</button>
      </div>

      <div class="stats" style="grid-template-columns:repeat(4,1fr)">
        <div class="stat"><div class="n">${d.today.dials}</div><div class="l">Dials today</div></div>
        <div class="stat"><div class="n">${d.today.connects}</div><div class="l">Connects today</div></div>
        <div class="stat"><div class="n">${fmtTime(d.today.talkSeconds)}</div><div class="l">Talk today</div></div>
        <div class="stat"><div class="n">${fmtTime(d.week.talkSeconds)}</div><div class="l">Talk this week</div></div>
      </div>

      <div class="grid cols-2 mt">
        <div>
          <h2>Account</h2>
          <dl class="kv">
            <dt>Status</dt><dd>${u.pendingApproval ? 'Waiting for approval' : u.active ? 'Active' : 'Switched off'}</dd>
            <dt>Last signed in</dt><dd>${esc(u.lastLoginAt || 'never')}</dd>
            <dt>Account created</dt><dd>${esc(u.createdAt)}</dd>
            <dt>Merchants owned</dt><dd>${d.ownedLeads}</dd>
            <dt>Open callbacks</dt><dd>${d.openTasks}</dd>
            <dt>Lists</dt><dd>${d.lists.map((l) => esc(l.name)).join(', ') || '<span class="muted">none</span>'}</dd>
          </dl>
        </div>
        <div>
          <h2>Recent account activity</h2>
          <div class="small">${
            d.recentActivity.length
              ? d.recentActivity
                  .slice(0, 8)
                  .map(
                    (a) => `<div style="padding:4px 0;border-bottom:1px solid var(--line)">
                      ${esc(a.actionLabel)}${a.target ? ` <span class="muted">${esc(a.target)}</span>` : ''}
                      <span class="muted"> · ${esc(a.created_at)}</span></div>`
                  )
                  .join('')
              : '<span class="muted">Nothing recorded yet.</span>'
          }</div>
        </div>
      </div>

      <h2 class="mt">Their last 15 calls</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>When</th><th>Business</th><th>Number</th><th>Outcome</th><th>Disposition</th><th>Talk</th></tr></thead>
          <tbody>${
            d.recentCalls.length
              ? d.recentCalls
                  .map(
                    (c) => `<tr><td class="small muted">${esc(c.created_at)}</td><td>${esc(c.company || '')}</td>
                      <td>${esc(c.to_number)}</td><td>${esc(c.outcome)}</td><td>${esc(c.disposition)}</td>
                      <td>${fmtTime(c.talk_seconds)}</td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="6" class="muted">No calls yet.</td></tr>'
          }</tbody>
        </table>
      </div>

      <div class="row mt">
        <a class="btn small" href="/reports?agent=${u.id}">Full report</a>
        <div class="spacer"></div>
        <button class="small" id="uReset">Email a reset link</button>
        <button class="small btn-danger" id="uRemove">Remove from the system</button>
      </div>
    </div></div>`;

    $('uBack').addEventListener('mousedown', (e) => {
      if (e.target.id === 'uBack') $('modalHost').innerHTML = '';
    });
    $('uClose').onclick = () => ($('modalHost').innerHTML = '');
    $('uReset').onclick = async () => {
      try {
        const r = await api(`/api/admin/users/${u.id}/reset-link`, { method: 'POST', body: {} });
        if (r.link) prompt('Email is not configured, so send them this link yourself:', r.link);
        else toast('Reset link emailed.', 'ok');
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
    $('uRemove').onclick = () => confirmRemove(u);
  }

  function confirmRemove(u) {
    const others = users.filter((x) => x.id !== u.id && x.active && !x.pendingApproval);
    $('modalHost').innerHTML = `<div class="modal-back" id="rBack"><div class="modal">
      <h3>Remove ${esc(u.name || u.email)}?</h3>
      <p class="small">Their account is deleted and they can no longer sign in. Their call history, texts and AI notes are kept.</p>
      <label>Who takes over their merchants and callbacks?</label>
      <select id="rTransfer">
        <option value="">Nobody - leave them unassigned</option>
        ${others.map((o) => `<option value="${o.id}">${esc(o.name || o.email)}</option>`).join('')}
      </select>
      <p class="small muted mt">If you are only pausing someone, use <b>Disable</b> instead - it keeps everything as it is and can be undone.</p>
      <div class="row mt"><div class="spacer"></div>
        <button id="rCancel">Cancel</button>
        <button class="btn-danger" id="rGo">Remove permanently</button></div>
    </div></div>`;

    $('rBack').addEventListener('mousedown', (e) => {
      if (e.target.id === 'rBack') $('modalHost').innerHTML = '';
    });
    $('rCancel').onclick = () => ($('modalHost').innerHTML = '');
    $('rGo').onclick = async () => {
      try {
        const r = await api(`/api/admin/users/${u.id}`, {
          method: 'DELETE',
          body: { transferTo: $('rTransfer').value || null },
        });
        $('modalHost').innerHTML = '';
        toast(`${r.removed} removed.`, 'ok');
        loadUsers();
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  }

  // ------------------------------------------------------------------ activity log
  async function loadAudit() {
    const params = new URLSearchParams();
    if ($('auditActor').value) params.set('actor', $('auditActor').value);
    if ($('auditAction').value) params.set('action', $('auditAction').value);
    const { entries, actions } = await api(`/api/admin/audit?${params}`);

    if (!$('auditActor').dataset.filled) {
      $('auditActor').innerHTML =
        '<option value="">Everyone</option>' +
        users.map((u) => `<option value="${u.id}">${esc(u.name || u.email)}</option>`).join('');
      const groups = [...new Set(Object.keys(actions).map((a) => a.split('.')[0]))];
      $('auditAction').innerHTML =
        '<option value="">Everything</option>' +
        groups.map((g) => `<option value="${g}">${esc(g)}</option>`).join('');
      $('auditActor').dataset.filled = '1';
    }

    $('auditRows').innerHTML = entries.length
      ? entries
          .map(
            (e) => `<tr>
        <td class="small muted">${esc(e.created_at)}</td>
        <td>${esc(e.who)}</td>
        <td>${esc(e.actionLabel)}</td>
        <td class="small">${esc(e.target)}</td>
        <td class="small muted">${esc(e.detail)}</td>
        <td class="small muted">${esc(e.ip)}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="muted">Nothing recorded yet.</td></tr>';
  }

  // ------------------------------------------------------------------ system check
  const ICON = { pass: '✓', warn: '!', fail: '✕', skip: '–' };

  async function loadHealth(run = false) {
    if (!run) {
      $('healthResults').innerHTML = '<p class="small muted">Press "Run the check" - it takes a few seconds.</p>';
      return;
    }
    $('btnHealth').disabled = true;
    $('btnHealth').textContent = 'Checking...';
    $('healthResults').innerHTML = '<p class="ai-pending"><span class="spinner"></span> Calling Twilio and the rest...</p>';
    try {
      const h = await api('/api/admin/health');
      const groups = [...new Set(h.checks.map((c) => c.group))];
      $('healthOverall').innerHTML = `<span class="pill ${h.overall === 'pass' ? 'ok' : h.overall === 'warn' ? 'warn' : 'bad'}">
        <span class="dot"></span>${h.counts.fail} failing · ${h.counts.warn} warning · ${h.counts.pass} fine</span>`;

      $('healthResults').innerHTML = groups
        .map(
          (g) => `<div class="check-group"><h3>${esc(g)}</h3>${h.checks
            .filter((c) => c.group === g)
            .map(
              (c) => `<div class="check ${esc(c.status)}">
                <span class="icon">${ICON[c.status] || '·'}</span>
                <span class="name">${esc(c.label)}</span>
                <span>${esc(c.detail)}${c.fix ? `<span class="fix">${esc(c.fix)}</span>` : ''}</span>
              </div>`
            )
            .join('')}</div>`
        )
        .join('');
    } catch (err) {
      $('healthResults').innerHTML = `<div class="banner bad">${esc(err.message)}</div>`;
    } finally {
      $('btnHealth').disabled = false;
      $('btnHealth').textContent = 'Run the check';
    }
  }

  // ------------------------------------------------------------------ twilio auto-setup
  const STEP_PILL = {
    created: 'ok',
    updated: 'ok',
    reused: 'ok',
    replacing: 'warn',
    skipped: 'warn',
    failed: 'bad',
  };

  function renderProvision(r) {
    if (!r) return;
    if (!r.ran) {
      $('provisionResults').innerHTML = `<div class="banner warn">${esc(r.reason || 'Setup did not run.')}</div>`;
      return;
    }
    const rows = (r.steps || [])
      .map(
        (s) => `<div class="check ${s.status === 'failed' ? 'fail' : s.status === 'skipped' ? 'warn' : 'pass'}">
          <span class="icon">${s.status === 'failed' ? '✕' : s.status === 'skipped' ? '–' : '✓'}</span>
          <span class="name">${esc(s.step)}</span>
          <span>${esc(s.detail)}</span>
        </div>`
      )
      .join('');
    const banner = r.ok
      ? '<div class="banner ok">Twilio is wired up. Run the connection check below to confirm.</div>'
      : '<div class="banner bad">Something did not finish. The detail below says what.</div>';
    $('provisionResults').innerHTML = banner + `<div class="check-group">${rows}</div>`;
  }

  async function loadProvisionState() {
    try {
      const s = await api('/api/admin/setup/twilio');
      if (s.last) {
        $('provisionResults').innerHTML =
          `<p class="small muted">Last run ${new Date(s.last.ranAt).toLocaleString()}.</p>` +
          `<div class="check-group">${s.last.steps
            .map(
              (x) => `<div class="check ${x.status === 'failed' ? 'fail' : x.status === 'skipped' ? 'warn' : 'pass'}">
                <span class="icon">${x.status === 'failed' ? '✕' : x.status === 'skipped' ? '–' : '✓'}</span>
                <span class="name">${esc(x.step)}</span><span>${esc(x.detail)}</span></div>`
            )
            .join('')}</div>`;
      } else {
        $('provisionResults').innerHTML =
          '<p class="small muted">Not run yet on this deployment. Press the button - it takes a few seconds.</p>';
      }
    } catch {
      /* the panel is optional; the check below is the real signal */
    }
  }

  $('btnProvision').addEventListener('click', async () => {
    const b = $('btnProvision');
    b.disabled = true;
    b.textContent = 'Setting up...';
    $('provisionResults').innerHTML = '<p class="ai-pending"><span class="spinner"></span> Talking to Twilio...</p>';
    try {
      renderProvision(await api('/api/admin/setup/twilio', { method: 'POST' }));
    } catch (err) {
      $('provisionResults').innerHTML = `<div class="banner bad">${esc(err.message)}</div>`;
    } finally {
      b.disabled = false;
      b.textContent = 'Run Twilio setup';
    }
  });

  $('btnHealth').addEventListener('click', () => loadHealth(true));
  $('auditRefresh').addEventListener('click', () => loadAudit().catch((e) => toast(e.message, 'bad')));
  $('auditActor').addEventListener('change', () => loadAudit().catch((e) => toast(e.message, 'bad')));
  $('auditAction').addEventListener('change', () => loadAudit().catch((e) => toast(e.message, 'bad')));

  // ------------------------------------------------------------------ texting
  const TRIGGER_LABEL = {
    answered: 'they answered and we spoke',
    no_answer: 'they did not answer',
    voicemail: 'we reached voicemail',
    abandoned: 'answered but nobody free',
    busy: 'line was busy',
    disposition: 'a certain disposition',
  };

  async function loadTexting() {
    const stats = await api('/api/admin/sms/stats');
    $('tSent').textContent = stats.today.sent;
    $('tRecv').textContent = stats.today.received;
    $('tQueued').textContent = stats.today.queued;
    $('tFailed').textContent = stats.today.failed;
    $('tBlocked').textContent = stats.today.blocked;
    $('tOptOuts').textContent = stats.optOuts;

    const s = await api('/api/admin/settings');
    $('smsAdvisories').innerHTML = (s.advisories || []).length
      ? `<div class="banner warn">${s.advisories.map(esc).join('<br>')}</div>`
      : '';
    $('msgServiceNote').textContent =
      s.env.messagingServiceSid && s.env.messagingServiceSid !== '(not set)'
        ? `Using Messaging Service ${s.env.messagingServiceSid}`
        : 'No Messaging Service set - sending from a bare number.';
    $('smsFrom').innerHTML =
      '<option value="">Pick automatically</option>' +
      (s.smsNumbers || [])
        .map((p) => `<option value="${esc(p)}"${s.settings.sms_from_number === p ? ' selected' : ''}>${esc(p)}</option>`)
        .join('');

    const { rules } = await api('/api/admin/sms/rules');
    $('smsRuleRows').innerHTML = rules.length
      ? rules
          .map(
            (r) => `<tr>
        <td>${esc(r.owner_name || r.owner_email || 'Everyone')}</td>
        <td>${esc(TRIGGER_LABEL[r.trigger] || r.trigger)}${r.disposition ? ` (${esc(r.disposition)})` : ''}</td>
        <td>${esc(r.template_name)}</td>
        <td>${r.delay_minutes ? `${r.delay_minutes} min` : 'right away'}</td>
        <td>${esc(r.list_name || 'any')}</td>
        <td>${r.active ? 'yes' : 'no'}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="muted">Nobody has set up an auto-text yet.</td></tr>';

    const { templates } = await api('/api/admin/sms/templates');
    $('smsTplRows').innerHTML = templates
      .map(
        (t) => `<tr><td>${esc(t.name)}</td>
        <td>${esc(t.owner_name || t.owner_email || 'Shared')}</td>
        <td class="small muted">${esc(t.body)}</td></tr>`
      )
      .join('');

    const { optOuts } = await api('/api/admin/sms/optouts');
    $('optOutRows').innerHTML = optOuts.length
      ? optOuts
          .map(
            (o) => `<tr><td>${esc(o.phoneDisplay)}</td><td>${esc(o.keyword)}</td>
        <td class="small muted">${esc(o.created_at)}</td>
        <td><button data-del="${o.id}" class="small">Remove</button></td></tr>`
          )
          .join('')
      : '<tr><td colspan="4" class="muted">Nobody has opted out.</td></tr>';
    $('optOutRows')
      .querySelectorAll('button[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Remove this opt-out? Only do this if they asked to start receiving texts again.')) return;
          await api(`/api/admin/sms/optouts/${b.dataset.del}`, { method: 'DELETE' });
          loadTexting();
        })
      );

    loadSmsLog();
  }

  async function loadSmsLog() {
    const dir = $('smsDir').value;
    const { messages } = await api(`/api/admin/sms/log?limit=200${dir ? `&direction=${dir}` : ''}`);
    $('smsLogRows').innerHTML = messages.length
      ? messages
          .map(
            (m) => `<tr>
        <td class="small muted">${esc(m.created_at)}</td>
        <td>${m.direction === 'inbound' ? '&larr;' : '&rarr;'}</td>
        <td>${esc(m.agent_name || '')}</td>
        <td>${esc([m.first_name, m.last_name].filter(Boolean).join(' ') || m.company || '')}</td>
        <td>${esc(m.direction === 'inbound' ? m.fromDisplay : m.toDisplay)}</td>
        <td class="small">${esc((m.body || m.error || '').slice(0, 90))}</td>
        <td class="small ${m.status === 'failed' || m.status === 'undelivered' ? '' : 'muted'}">${esc(m.status)}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="7" class="muted">No messages yet.</td></tr>';
  }

  $('smsLogRefresh').addEventListener('click', () => loadSmsLog().catch((e) => toast(e.message, 'bad')));
  $('smsDir').addEventListener('change', () => loadSmsLog().catch((e) => toast(e.message, 'bad')));

  $('saveSmsFrom').addEventListener('click', async () => {
    await api('/api/admin/settings', { method: 'POST', body: { sms_from_number: $('smsFrom').value } });
    toast('Saved.', 'ok');
  });

  $('stAdd').addEventListener('click', async () => {
    try {
      await api('/api/sms/templates', {
        method: 'POST',
        body: { name: $('stName').value, body: $('stBody').value, shared: true },
      });
      $('stName').value = '';
      $('stBody').value = '';
      toast('Shared template added.', 'ok');
      loadTexting();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  // ------------------------------------------------------------------ reports
  async function loadReports() {
    const { rows } = await api('/api/admin/reports/agents?days=7');
    $('agentRows').innerHTML = rows
      .map(
        (r) => `<tr><td>${esc(r.name || r.email)}</td><td>${r.calls || 0}</td><td>${r.connects || 0}</td>
      <td>${r.abandons || 0}</td><td>${fmtTime(r.talk_seconds)}</td>
      <td>${r.calls ? Math.round(((r.connects || 0) / r.calls) * 100) : 0}%</td></tr>`
      )
      .join('');

    const { calls } = await api('/api/admin/reports/calls?limit=150');
    $('callRows').innerHTML = calls
      .map(
        (c) => `<tr>
      <td class="small muted">${esc(c.created_at)}</td>
      <td>${esc(c.agent_name || '')}</td>
      <td>${esc([c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || '')}</td>
      <td>${esc(c.to_number)}</td>
      <td>${esc(c.outcome)}</td>
      <td>${esc(c.disposition)}</td>
      <td>${c.talk_seconds || 0}s</td>
      <td>${c.recording_url ? `<a href="${esc(c.recording_url)}" target="_blank" rel="noopener">Listen</a>` : ''}</td></tr>`
      )
      .join('');
  }

  // ------------------------------------------------------------------ boot
  function load(tab) {
    const fns = {
      dash: loadDash,
      lists: loadLists,
      people: loadUsers,
      numbers: loadNumbers,
      texting: loadTexting,
      activity: loadAudit,
      system: () => {
        loadProvisionState();
        return loadHealth(false);
      },
      dnc: loadDnc,
      settings: loadSettings,
      reports: loadReports,
    };
    (fns[tab] || loadDash)().catch((e) => toast(e.message, 'bad'));
  }

  $('logout').addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  });

  (async () => {
    const meResp = await api('/api/me');
    me = meResp.user;
    $('whoami').textContent = me.name || me.email;
    await loadUsers();
    load('dash');
    const socket = io();
    socket.on('station:admin', () => loadStations());
    setInterval(() => {
      if (!document.querySelector('section[data-panel="dash"]').classList.contains('hidden')) loadDash();
    }, 15000);
  })().catch((e) => toast(e.message, 'bad'));
})();
