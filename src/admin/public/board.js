// The lead board. Everything that comes from customers is shown with textContent, never as HTML.
(() => {
  const STAGES = ['initiated', 'interested', 'negotiating', 'site_visit_ready', 'closed', 'not_interested'];
  const LABELS = {
    initiated: 'Initiated', interested: 'Interested', negotiating: 'Negotiating',
    site_visit_ready: 'Ready for site visit', closed: 'Closed', not_interested: 'Not interested'
  };
  const REFRESH_MS = 5000;

  const state = { me: null, showTests: true, openId: null, openListing: null, timer: null, view: 'leads', listings: [], clockOffset: 0 };
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  async function api(path, options = {}) {
    const response = await fetch(`/admin/api${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) }
    });
    let body = null;
    try { body = await response.json(); } catch { /* no body */ }
    if (response.status === 401) { showLogin(); throw new Error('signed out'); }
    if (!response.ok) { const error = new Error(body?.message ?? body?.error ?? `Request failed (${response.status})`); error.status = response.status; error.body = body; throw error; }
    return body;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return `${Math.floor(seconds / 86400)} d ago`;
  }

  function notice(message, bad = false) {
    const box = $('notice');
    box.textContent = message;
    box.className = bad ? 'notice bad' : 'notice';
    box.hidden = !message;
    if (message) setTimeout(() => { if (box.textContent === message) box.hidden = true; }, 4000);
  }

  // ---- sign in -------------------------------------------------------------------------------

  function showLogin() {
    clearInterval(state.timer);
    closeDrawer();
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-email').focus();
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('login-error');
    error.hidden = true;
    try {
      state.me = await api('/login', {
        method: 'POST',
        body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value })
      });
      $('login-password').value = '';
      start();
    } catch (e) {
      error.textContent = e.message === 'signed out' ? 'Email or password is not right.' : e.message;
      error.hidden = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    showLogin();
  });

  $('show-tests').addEventListener('change', (event) => {
    state.showTests = event.target.checked;
    if (state.view === 'knowledge') loadKnowledge(); else if (state.view === 'requests') loadRequests(); else refresh();
  });

  // ---- board ---------------------------------------------------------------------------------

  function start() {
    $('login').hidden = true;
    $('app').hidden = false;
    $('who').textContent = `${state.me.email} (${state.me.role})`;
    $('tab-audit').hidden = state.me.role !== 'admin';
    $('tab-requests').hidden = state.me.role !== 'admin';
    const linked = /^#lead=(.+)$/.exec(location.hash);
    if (linked) openDrawer(decodeURIComponent(linked[1]));
    setView(state.view);
    refreshGapCount();
    refreshRequestCount();
    clearInterval(state.ticker);
    state.ticker = setInterval(tickWaits, 10000);
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (document.hidden) return;
      if (state.view === 'requests') loadRequests(); else refresh();
      if (state.view !== 'knowledge') refreshGapCount();
      if (state.view !== 'requests') refreshRequestCount();
    }, REFRESH_MS);
  }

  async function refresh() {
    if (state.view !== 'leads') return;
    try {
      const tests = state.showTests ? '1' : '0';
      const [board, demand] = await Promise.all([api(`/board?tests=${tests}`), api(`/demand?tests=${tests}`)]);
      renderBoard(board);
      renderDemand(demand);
      if (state.openId && !$('drawer').hidden) loadDetail(state.openId, { quiet: true });
    } catch (e) {
      if (e.message !== 'signed out') notice(`Could not refresh: ${e.message}`, true);
    }
  }

  function renderBoard(board) {
    $('totals').textContent = `${board.total} lead${board.total === 1 ? '' : 's'}`;
    const columns = board.columns.map((column) =>
      el('section', { class: 'column', style: `--stage: var(--${column.stage})`, 'aria-label': column.label },
        el('h2', {}, column.label, el('span', { class: 'count', text: String(column.count) })),
        column.leads.length
          ? el('div', { class: 'cards' }, column.leads.map(renderCard))
          : el('p', { class: 'empty', text: 'No leads' })
      )
    );
    $('board').replaceChildren(...columns);
  }

  function renderCard(lead) {
    return el('button', { class: 'card', type: 'button', onclick: () => openDrawer(lead.id) },
      el('span', { class: 'card-name' },
        lead.name,
        lead.isTest && el('span', { class: 'badge test', text: 'TEST' }),
        lead.handle && el('span', { class: 'card-handle', text: `@${lead.handle}` })),
      el('span', { class: 'card-summary', text: lead.summary }),
      el('span', { class: 'card-meta' },
        lead.shortlistCount > 0 && el('span', { text: `⭐ ${lead.shortlistCount} saved` }),
        lead.hasPhone && el('span', { text: '📞 number shared' }),
        lead.source && el('span', { text: `from ${lead.source}` }),
        el('span', { text: timeAgo(lead.lastContactedAt) })));
  }

  function renderDemand(demand) {
    const list = $('demand-list');
    if (!demand.items.length) {
      list.replaceChildren(el('li', {}, el('span', { class: 'muted', text: 'Nothing yet. Every search so far found an exact match.' })));
      return;
    }
    list.replaceChildren(...demand.items.map((item) =>
      el('li', {},
        el('span', { text: item.request }),
        el('span', { class: 'muted', text: `${item.count} search${item.count === 1 ? '' : 'es'} · ${item.customers} customer${item.customers === 1 ? '' : 's'}` }))));
  }

  // ---- one lead ------------------------------------------------------------------------------

  function openDrawer(id) {
    state.openId = id;
    history.replaceState(null, '', `#lead=${encodeURIComponent(id)}`);
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    $('drawer').replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
    loadDetail(id);
  }

  function closeDrawer() {
    state.openId = null;
    state.openListing = null;
    if (location.hash) history.replaceState(null, '', location.pathname);
    $('drawer').hidden = true;
    $('scrim').hidden = true;
  }

  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });

  async function loadDetail(id, { quiet = false } = {}) {
    // Do not redraw under someone who is typing a reason.
    if (quiet && $('drawer').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    try {
      const lead = await api(`/leads/${encodeURIComponent(id)}`);
      if (state.openId === id) renderDetail(lead);
    } catch (e) {
      if (e.message !== 'signed out') $('drawer').replaceChildren(el('p', { class: 'error', text: e.message }), el('button', { type: 'button', onclick: closeDrawer, text: 'Close' }));
    }
  }

  function renderDetail(lead) {
    const isAdmin = state.me?.role === 'admin';
    const r = lead.requirements;
    const rows = [
      ['Looking for', r.summary], ['Intent', r.intent], ['Timeline', r.urgency], ['Financing', r.financing],
      ['Must have', r.mustHaves.join(', ')], ['Will not accept', r.dealBreakers.join(', ')],
      ['Last request', r.lastQuery], ['Next step', r.nextAction], ['Phone', lead.phoneHidden ? 'Shared (visible to admins only)' : lead.phone], ['Came from', lead.source]
    ].filter(([, value]) => value);

    const stageSelect = el('select', { id: 'move-stage', 'aria-label': 'Move to stage' },
      STAGES.map((stage) => el('option', { value: stage, selected: stage === lead.stage, text: LABELS[stage] })));
    const reason = el('input', { id: 'move-reason', type: 'text', maxlength: '200', placeholder: 'Why? (optional)', 'aria-label': 'Reason' });
    const moveButton = el('button', { type: 'button', class: 'primary', text: 'Move', onclick: async () => {
      moveButton.disabled = true;
      try {
        await api(`/leads/${encodeURIComponent(lead.id)}/stage`, { method: 'POST', body: JSON.stringify({ stage: stageSelect.value, reason: reason.value }) });
        notice(`${lead.name} moved to ${LABELS[stageSelect.value]}.`);
        refresh();
      } catch (e) {
        notice(e.body?.reason ? `Not moved: ${e.body.reason}` : e.message, true);
      } finally { moveButton.disabled = false; }
    } });

    $('drawer').replaceChildren(...[
      el('div', { class: 'drawer-head' },
        el('div', {},
          el('h1', {}, lead.name, ' ', lead.isTest && el('span', { class: 'badge test', text: 'TEST' })),
          el('p', { class: 'muted', text: [lead.handle && `@${lead.handle}`, lead.id].filter(Boolean).join(' · ') }),
          el('p', {}, el('span', { class: 'badge stage', style: `--stage: var(--${lead.stage})`, text: LABELS[lead.stage] }))),
        el('button', { type: 'button', onclick: closeDrawer, 'aria-label': 'Close', text: 'Close' })),

      el('section', { class: 'box move' },
        el('h3', { text: 'Stage' }),
        isAdmin
          ? el('div', { class: 'move-row' }, stageSelect, reason, moveButton)
          : el('p', { class: 'muted', text: 'Your account can view leads but not move them.' })),

      el('section', { class: 'box' }, el('h3', { text: 'Requirements' }),
        el('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]))),

      lead.keyPoints.length > 0 && el('section', { class: 'box' }, el('h3', { text: 'Noted from the chat' }),
        el('ul', {}, lead.keyPoints.map((k) => el('li', { text: k.text })))),

      el('section', { class: 'box' }, el('h3', { text: `Shortlist (${lead.shortlist.length})` }),
        lead.shortlist.length
          ? el('ul', {}, lead.shortlist.map((p) => el('li', { text: [p.title, p.location, p.price].filter(Boolean).join(' · ') + (p.status && p.status !== 'available' ? ` (${p.status})` : '') })))
          : el('p', { class: 'muted', text: 'Nothing saved yet.' })),

      el('section', { class: 'box' }, el('h3', { text: 'History' }),
        el('ol', { class: 'timeline' }, lead.events.map(renderEvent))),

      el('section', { class: 'box' }, el('h3', { text: 'Conversation' }),
        lead.conversationVisible
          ? (lead.conversation.length
              ? el('div', { class: 'chat' }, lead.conversation.map((m) => el('div', { class: `bubble ${m.role}`, text: m.content })))
              : el('p', { class: 'muted', text: 'No messages yet.' }))
          : el('p', { class: 'muted', text: state.me?.role === 'admin' ? 'Conversations of real customers are hidden on this board.' : 'Only admins can read conversations.' }))
    ].filter(Boolean));
  }

  function renderEvent(e) {
    const who = e.by ?? (e.actor && e.actor !== 'system' ? e.actor : null);
    const property = e.property ? e.property.title : null;
    const text = {
      lead_created: 'First contact',
      stage_changed: `Moved from ${LABELS[e.fromStage] ?? e.fromStage} to ${LABELS[e.toStage] ?? e.toStage}`,
      shortlisted: `Saved ${property ?? 'a property'}`,
      unshortlisted: `Removed ${property ?? 'a property'} from the shortlist`,
      site_visit_requested: `Asked to visit ${property ?? 'a property'}${e.alerted ? ' · sales team alerted' : ' · sales team not yet alerted'}`,
      zero_result: `Searched for something we could not fully match: ${e.note ?? ''}`,
      handoff_reminder: `Reminded the team: ${e.note ?? ''}`,
      handoff_customer_notice: `Told the customer the team has not replied yet (${e.note ?? ''})`
    }[e.type] ?? e.type;
    return el('li', {},
      el('span', { text: text }),
      e.note && e.type === 'stage_changed' && el('span', { class: 'muted', text: `“${e.note}”` }),
      el('span', { class: 'when', text: `${timeAgo(e.at)}${who ? ` · ${who}` : ''}` }));
  }


  // ---- requests the bot passed to the team ----------------------------------------------------

  const REQUEST_STATUS = { open: 'Needs the team', waiting_customer: 'Waiting for the customer', resolved: 'Resolved' };
  const openThreads = new Set();

  function setRequestCount(n) {
    $('request-count').textContent = String(n);
    $('request-count').hidden = !n;
  }

  async function refreshRequestCount() {
    if (state.me?.role !== 'admin') return;
    try { setRequestCount((await api('/handoffs?status=open')).open); } catch { /* the badge is optional */ }
  }

  async function loadRequests({ force = false } = {}) {
    try {
      const tests = state.showTests ? '1' : '0';
      const filter = $('request-filter').value;
      const { requests, open, overdue, serverTime } = await api(`/handoffs?${filter === 'all' ? '' : `status=${filter}&`}tests=${tests}`);
      setRequestCount(open);
      state.clockOffset = Date.parse(serverTime) - Date.now();
      $('request-summary').textContent = open ? `${open} open${overdue ? `, ${overdue} overdue` : ''}` : '';
      // A conversation being read or written stays as it is; the list around it refreshes.
      if (!force && document.activeElement?.closest?.('#request-list')) return;
      renderRequests(requests);
    } catch (e) {
      if (e.message !== 'signed out') notice(`Could not load requests: ${e.message}`, true);
    }
  }

  // "2 hrs 21 mins". Kept the same as the server's wording.
  function formatWait(minutes) {
    const total = Math.max(0, Math.floor(minutes));
    if (total < 1) return 'less than a min';
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return [hours && `${hours} ${hours === 1 ? 'hr' : 'hrs'}`, mins && `${mins} ${mins === 1 ? 'min' : 'mins'}`].filter(Boolean).join(' ');
  }

  // Counts every visible timer up, and turns a request red once it has waited longer than it should.
  function tickWaits() {
    const now = Date.now() + state.clockOffset;
    let overdue = 0;
    for (const node of document.querySelectorAll('#request-list .wait')) {
      const minutes = (now - Date.parse(node.dataset.since)) / 60000;
      node.textContent = `Customer wait time since - ${formatWait(minutes)}`;
      const late = minutes >= Number(node.dataset.limit);
      node.closest('.gap')?.classList.toggle('overdue', late);
      if (late) overdue++;
    }
    const open = $('request-count').hidden ? 0 : Number($('request-count').textContent);
    if (open && document.querySelector('#request-list .wait')) $('request-summary').textContent = `${open} open${overdue ? `, ${overdue} overdue` : ''}`;
  }

  // Requests the team owes an answer to come first, the longest wait at the top.
  const requestOrder = (a, b) => {
    const rank = (r) => (r.status === 'open' ? 0 : r.status === 'waiting_customer' ? 1 : 2);
    return rank(a) - rank(b) || Number(b.overdue) - Number(a.overdue) || (Date.parse(a.waitingSince ?? a.createdAt) - Date.parse(b.waitingSince ?? b.createdAt));
  };

  function renderRequests(requests) {
    requests = [...requests].sort(requestOrder);
    $('request-list').replaceChildren(...(requests.length ? requests.map((r) => {
      const thread = el('div', { class: 'thread', 'aria-label': 'Conversation' });
      const reply = el('textarea', { maxlength: '1500', placeholder: 'Write a reply. The customer gets it from the bot as "Message from our team".', 'aria-label': 'Reply' });
      const detail = el('div', { hidden: !openThreads.has(r.id) });

      const showThread = async () => {
        try {
          const data = await api(`/handoffs/${r.id}`);
          thread.replaceChildren(...data.thread.map((m) =>
            el('div', { class: `bubble ${m.direction}` }, m.text,
              el('span', { class: 'by', text: `${m.direction === 'staff' ? (m.author ?? 'team') : 'customer'} · via ${m.via} · ${timeAgo(m.createdAt)}` }))));
          thread.scrollTop = thread.scrollHeight;
        } catch (e) { if (e.message !== 'signed out') notice(e.message, true); }
      };

      const send = el('button', { type: 'button', class: 'primary', text: 'Send reply', onclick: async () => {
        if (!reply.value.trim()) { notice('Write a reply first.', true); return; }
        send.disabled = true;
        try {
          const result = await api(`/handoffs/${r.id}/reply`, { method: 'POST', body: JSON.stringify({ text: reply.value }) });
          notice(result.delivered ? 'Sent to the customer.' : `Saved, but not delivered: ${result.reason}`, !result.delivered);
          reply.value = '';
          await showThread();
          loadRequests({ force: true });
        } catch (e) { notice(e.message, true); } finally { send.disabled = false; }
      } });

      const toggle = el('button', { type: 'button', text: openThreads.has(r.id) ? 'Hide conversation' : 'Open conversation', onclick: () => {
        const nowOpen = detail.hidden;
        detail.hidden = !nowOpen;
        if (nowOpen) { openThreads.add(r.id); showThread(); } else openThreads.delete(r.id);
        toggle.textContent = nowOpen ? 'Hide conversation' : 'Open conversation';
      } });
      if (openThreads.has(r.id)) showThread();

      const resolved = r.status === 'resolved';
      const finish = el('button', { type: 'button', text: resolved ? 'Reopen' : 'Mark resolved', onclick: async () => {
        try { await api(`/handoffs/${r.id}/${resolved ? 'reopen' : 'resolve'}`, { method: 'POST' }); loadRequests({ force: true }); } catch (e) { notice(e.message, true); }
      } });

      detail.append(thread, reply, el('div', { class: 'gap-actions' }, send));
      return el('article', { class: `gap${r.overdue ? ' overdue' : ''}` },
        el('div', { class: 'gap-head' },
          el('span', { class: 'gap-title' },
            el('span', { class: 'badge kind', text: r.kindLabel }),
            el('a', { href: `#lead=${encodeURIComponent(r.customerId)}`, text: r.customerName, onclick: () => { setView('leads'); setTimeout(() => openDrawer(r.customerId), 200); } }),
            r.customerHandle && el('span', { class: 'muted', text: `@${r.customerHandle}` }),
            r.isTest && el('span', { class: 'badge test', text: 'TEST' })),
          el('span', {}, el('span', { class: `req-status ${r.status}`, text: REQUEST_STATUS[r.status] ?? r.status }), el('span', { class: 'muted', text: ` · #${r.id} · ${timeAgo(r.createdAt)}` }))),
        el('p', { class: 'gap-quote', text: r.summary }),
        r.propertyTitle && el('p', { class: 'muted', text: `About: ${r.propertyTitle}` }),
        r.status === 'open' && r.waitingSince && el('p', { class: 'wait', 'data-since': r.waitingSince, 'data-limit': String(r.replyMinutes), text: `Customer wait time since - ${formatWait((Date.now() + state.clockOffset - Date.parse(r.waitingSince)) / 60000)}` }),
        el('div', { class: 'gap-actions' }, toggle, finish),
        detail);
    }) : [el('p', { class: 'muted', text: 'Nothing here. Requests appear when a customer asks to visit, asks for a call back, makes an offer, or asks something the assistant cannot answer.' })]));
  }

  // ---- listings and their photos ----------------------------------------------------------------

  function setView(view) {
    state.view = view;
    $('leads-view').hidden = view !== 'leads';
    $('listings-view').hidden = view !== 'listings';
    $('knowledge-view').hidden = view !== 'knowledge';
    $('requests-view').hidden = view !== 'requests';
    $('audit-view').hidden = view !== 'audit';
    $('tests-toggle').hidden = view === 'listings' || view === 'audit';
    for (const name of ['leads', 'listings', 'requests', 'knowledge', 'audit']) {
      $(`tab-${name}`).setAttribute('aria-current', view === name ? 'page' : 'false');
    }
    closeDrawer();
    if (view === 'leads') refresh();
    else if (view === 'listings') loadListings();
    else if (view === 'audit') loadAudit();
    else if (view === 'requests') loadRequests();
    else loadKnowledge();
  }

  $('tab-leads').addEventListener('click', () => setView('leads'));
  $('tab-listings').addEventListener('click', () => setView('listings'));
  $('tab-requests').addEventListener('click', () => setView('requests'));
  $('request-filter').addEventListener('change', loadRequests);
  $('tab-knowledge').addEventListener('click', () => setView('knowledge'));
  $('tab-audit').addEventListener('click', () => setView('audit'));
  $('listing-search').addEventListener('input', renderListings);

  async function loadListings() {
    try {
      state.listings = (await api('/properties')).properties;
      renderListings();
    } catch (e) {
      if (e.message !== 'signed out') notice(`Could not load listings: ${e.message}`, true);
    }
  }

  function renderListings() {
    const needle = $('listing-search').value.trim().toLowerCase();
    const shown = state.listings.filter((p) => !needle || [p.title, p.location, p.category].join(' ').toLowerCase().includes(needle));
    const withPhotos = state.listings.filter((p) => p.photoCount > 0).length;
    $('totals').textContent = `${state.listings.length} listings, ${withPhotos} with photos`;

    $('listing-list').replaceChildren(...(shown.length ? shown.map((p) =>
      el('button', { class: 'listing', type: 'button', onclick: () => openListing(p.id) },
        p.cover ? el('img', { class: 'thumb', src: p.cover, alt: '', loading: 'lazy' }) : el('span', { class: 'thumb', text: 'No photo' }),
        el('span', {},
          el('span', { class: 'listing-title', text: p.title }), el('br'),
          el('span', { class: 'listing-meta', text: [p.location, p.category, p.price].filter(Boolean).join(' · ') }), el('br'),
          p.photoCount > 0
            ? el('span', { class: 'badge photos', text: `${p.photoCount} photo${p.photoCount === 1 ? '' : 's'}` })
            : el('span', { class: 'badge nophoto', text: 'No photos yet' }), ' ',
          el('span', { class: 'badge off', text: VISIT_LABELS[p.visits] ?? VISIT_LABELS.unset })))
    ) : [el('p', { class: 'muted', text: 'No listings match.' })]));
  }

  function openListing(id) {
    state.openListing = id;
    state.openId = null;
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    $('drawer').replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
    loadPhotoPanel(id);
  }

  async function loadPhotoPanel(id) {
    try {
      const data = await api(`/properties/${encodeURIComponent(id)}/photos`);
      if (state.openListing === id) { renderPhotoPanel(data); loadVisitPanel(id, data.property.title); }
    } catch (e) {
      if (e.message !== 'signed out') $('drawer').replaceChildren(el('p', { class: 'error', text: e.message }), el('button', { type: 'button', onclick: closeDrawer, text: 'Close' }));
    }
  }

  // ---- site visit times for a listing -------------------------------------------------------------------
  const VISIT_LABELS = { unset: 'Visits: team arranges', closed: 'Visits: not open', open: 'Visits: set times' };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  async function loadVisitPanel(id, title) {
    try {
      const data = await api(`/properties/${encodeURIComponent(id)}/visits`);
      if (state.openListing === id) renderVisitPanel(id, title, data);
    } catch (e) {
      if (e.message !== 'signed out') $('drawer').append(el('p', { class: 'error', text: `Could not load visit times: ${e.message}` }));
    }
  }

  function renderVisitPanel(id, title, data) {
    $('visit-box')?.remove();
    const isAdmin = state.me?.role === 'admin';
    const current = data.availability;
    const mode = el('select', { 'aria-label': 'Site visits for this property', disabled: !isAdmin },
      el('option', { value: 'unset', text: 'Not set: the team arranges each visit' }),
      el('option', { value: 'closed', text: 'Not open yet: no visits for now' }),
      el('option', { value: 'open', text: 'Open on the times below' }));
    mode.value = current?.mode ?? 'unset';

    const rows = el('div', { class: 'visit-rows' });
    const note = el('input', { type: 'text', maxlength: '200', placeholder: 'Note for customers, for example: please bring photo ID', 'aria-label': 'Note shown to customers', value: current?.note ?? '', disabled: !isAdmin });
    const time = (value, label) => el('input', { type: 'time', value, required: true, 'aria-label': label, disabled: !isAdmin });
    const gone = (row) => isAdmin && el('button', { type: 'button', 'aria-label': 'Remove this window', onclick: () => row.remove(), text: '✕' });

    const addWeekly = (rule = { days: [6], from: '10:00', to: '13:00' }) => {
      const row = el('div', { class: 'visit-row', 'data-kind': 'weekly' },
        el('span', { class: 'days' }, DAYS.map((name, d) => el('label', {}, el('input', { type: 'checkbox', value: String(d), checked: rule.days.includes(d), disabled: !isAdmin }), ` ${name}`))),
        time(rule.from, 'From'), ' to ', time(rule.to, 'To'));
      const x = gone(row); if (x) row.append(x);
      rows.append(row);
    };
    const addDate = (rule = { date: '', from: '10:00', to: '13:00' }) => {
      const row = el('div', { class: 'visit-row', 'data-kind': 'date' },
        el('input', { type: 'date', value: rule.date, required: true, 'aria-label': 'Date', disabled: !isAdmin }),
        time(rule.from, 'From'), ' to ', time(rule.to, 'To'));
      const x = gone(row); if (x) row.append(x);
      rows.append(row);
    };
    for (const r of current?.rules ?? []) (r.date ? addDate(r) : addWeekly(r));

    const collect = () => [...rows.children].map((row) => {
      const [from, to] = [...row.querySelectorAll('input[type=time]')].map((i) => i.value);
      return row.dataset.kind === 'date'
        ? { date: row.querySelector('input[type=date]').value, from, to }
        : { days: [...row.querySelectorAll('input[type=checkbox]:checked')].map((i) => Number(i.value)), from, to };
    });

    const preview = el('ul', { class: 'muted' }, (data.preview ?? []).map((line) => el('li', { text: line })));
    const editor = el('div', {}, rows,
      isAdmin && el('p', {}, el('button', { type: 'button', onclick: () => addWeekly(), text: '+ Weekly window' }), ' ', el('button', { type: 'button', onclick: () => addDate(), text: '+ Specific date' })),
      note);
    const sync = () => { editor.hidden = mode.value === 'unset'; rows.hidden = mode.value !== 'open'; editor.querySelectorAll('p').forEach((p) => { p.hidden = mode.value !== 'open'; }); if (mode.value === 'open' && !rows.children.length && isAdmin) addWeekly(); };
    mode.addEventListener('change', sync);

    const save = async () => {
      try {
        const body = mode.value === 'unset' ? { mode: 'unset' } : { mode: mode.value, rules: mode.value === 'open' ? collect() : [], note: note.value };
        const saved = await api(`/properties/${encodeURIComponent(id)}/visits`, { method: 'PUT', body: JSON.stringify(body) });
        notice('Visit times saved.');
        loadListings();
        renderVisitPanel(id, title, saved);
      } catch (e) { if (e.message !== 'signed out') notice(e.message, true); }
    };

    const box = el('section', { class: 'box', id: 'visit-box' },
      el('h3', { text: 'Site visits' }),
      el('p', { class: 'muted', text: 'When a customer taps Book Site Visit, the bot asks for a date and time and only accepts one inside these windows. If nothing is set, the request goes straight to the team.' }),
      mode, editor,
      mode.value === 'open' && data.preview?.length ? el('div', {}, el('p', { class: 'muted', text: 'Customers are offered, from today:' }), preview) : null,
      isAdmin ? el('p', {}, el('button', { type: 'button', onclick: save, text: 'Save visit times' })) : el('p', { class: 'muted', text: 'Your account can view these but not change them.' }));
    $('drawer').append(box);
    sync();
  }

  // Shrink to at most 1600 px and re-encode. Keeps uploads small, and drops the location data phones put in photos.
  async function shrink(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not process this image'))), 'image/jpeg', 0.85));
  }

  function renderPhotoPanel(data) {
    const isAdmin = state.me?.role === 'admin';
    const id = data.property.id;
    const photos = data.photos;
    const status = el('span', { class: 'muted', id: 'upload-status', role: 'status' });
    const fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, 'aria-label': 'Choose photos' });

    const uploadFiles = async () => {
      const files = [...fileInput.files];
      if (!files.length) return;
      const room = data.max - photos.length;
      if (files.length > room) { status.textContent = `There is room for ${room} more photo${room === 1 ? '' : 's'}.`; return; }
      fileInput.disabled = true;
      let done = 0;
      for (const file of files) {
        status.textContent = `Uploading ${done + 1} of ${files.length}…`;
        try {
          const blob = await shrink(file);
          await api(`/properties/${encodeURIComponent(id)}/photos`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
          done += 1;
        } catch (e) {
          notice(`${file.name}: ${e.message === 'signed out' ? 'signed out' : e.message}`, true);
          break;
        }
      }
      if (done) notice(`${done} photo${done === 1 ? '' : 's'} added.`);
      loadListings();
      loadPhotoPanel(id);
    };
    fileInput.addEventListener('change', uploadFiles);

    const reorder = async (from, to) => {
      const ids = photos.map((p) => p.id);
      [ids[from], ids[to]] = [ids[to], ids[from]];
      try { await api(`/properties/${encodeURIComponent(id)}/photos/order`, { method: 'POST', body: JSON.stringify({ ids }) }); loadListings(); loadPhotoPanel(id); }
      catch (e) { notice(e.message, true); }
    };
    const remove = async (photo) => {
      if (!confirm('Delete this photo?')) return;
      try { await api(`/properties/${encodeURIComponent(id)}/photos/${photo.id}`, { method: 'DELETE' }); loadListings(); loadPhotoPanel(id); }
      catch (e) { notice(e.message, true); }
    };

    $('drawer').replaceChildren(...[
      el('div', { class: 'drawer-head' },
        el('div', {}, el('h1', { text: data.property.title }), el('p', { class: 'muted', text: [data.property.location, data.property.status].filter(Boolean).join(' · ') })),
        el('button', { type: 'button', onclick: closeDrawer, text: 'Close' })),
      el('section', { class: 'box' },
        el('h3', { text: `Photos (${photos.length} of ${data.max})` }),
        el('p', { class: 'muted', text: 'The first photo is the cover on the Telegram card. Customers flip through the rest with the arrow buttons.' }),
        isAdmin
          ? el('div', { class: 'upload-row' }, fileInput, status)
          : el('p', { class: 'muted', text: 'Your account can view photos but not change them.' }),
        photos.length
          ? el('div', { class: 'photo-grid' }, photos.map((photo, index) =>
              el('div', { class: 'photo' },
                el('img', { src: photo.url, alt: `Photo ${index + 1} of ${data.property.title}`, loading: 'lazy' }),
                index === 0 && el('span', { class: 'badge stage cover', style: '--stage: var(--site_visit_ready)', text: 'Cover' }),
                isAdmin && el('div', { class: 'photo-tools' },
                  el('button', { type: 'button', 'aria-label': 'Move earlier', disabled: index === 0, onclick: () => reorder(index, index - 1), text: '◀' }),
                  el('button', { type: 'button', 'aria-label': 'Delete photo', onclick: () => remove(photo), text: '✕' }),
                  el('button', { type: 'button', 'aria-label': 'Move later', disabled: index === photos.length - 1, onclick: () => reorder(index, index + 1), text: '▶' })))))
          : el('p', { class: 'muted', text: 'No photos yet.' }))
    ].filter(Boolean));
  }

  // ---- knowledge: what we could not answer, and the answers owners approve -----------------------------

  const KIND_LABELS = { listing_detail: 'About a property', area_info: 'About an area', policy: 'About what we can do', other: 'Other question' };

  async function loadKnowledge() {
    try {
      const tests = state.showTests ? '1' : '0';
      const [gaps, entries] = await Promise.all([api(`/knowledge/gaps?status=open&tests=${tests}`), api('/knowledge/entries')]);
      renderGaps(gaps.gaps);
      renderEntries(entries.entries);
      setGapCount(gaps.gaps.length);
    } catch (e) {
      if (e.message !== 'signed out') notice(`Could not load knowledge: ${e.message}`, true);
    }
  }

  async function refreshGapCount() {
    try { setGapCount((await api(`/knowledge/gaps?status=open&tests=${state.showTests ? '1' : '0'}`)).gaps.length); } catch { /* the badge is optional */ }
  }

  function setGapCount(n) {
    $('gap-count').textContent = String(n);
    $('gap-count').hidden = n === 0;
  }

  function scopeText(g) {
    if (g.propertyId) return `Used for this property only: ${g.propertyTitle ?? g.propertyId}`;
    if (g.area) return `Used for any question about ${g.area}`;
    return 'Used for every customer who asks this';
  }

  function renderGaps(gaps) {
    const isAdmin = state.me?.role === 'admin';
    $('gap-list').replaceChildren(...(gaps.length ? gaps.map((g) => {
      const answer = el('textarea', { maxlength: '1000', placeholder: 'Write the answer customers should get', 'aria-label': 'Answer' });
      const save = el('button', { type: 'button', class: 'primary', text: 'Save answer', onclick: async () => {
        if (!answer.value.trim()) { notice('Write an answer first.', true); return; }
        save.disabled = true;
        try {
          await api(`/knowledge/gaps/${g.id}/answer`, { method: 'POST', body: JSON.stringify({ answer: answer.value }) });
          notice('Saved. The next customer who asks gets this answer.');
          loadKnowledge();
        } catch (e) { notice(e.message, true); save.disabled = false; }
      } });
      const dismiss = el('button', { type: 'button', text: 'Dismiss', onclick: async () => {
        if (!confirm('Dismiss this question? Customers who ask it will keep getting the standard reply.')) return;
        try { await api(`/knowledge/gaps/${g.id}/dismiss`, { method: 'POST' }); loadKnowledge(); } catch (e) { notice(e.message, true); }
      } });

      return el('article', { class: 'gap' },
        el('div', { class: 'gap-head' },
          el('span', { class: 'gap-title' },
            el('span', { class: 'badge kind', text: KIND_LABELS[g.kind] ?? g.kind }),
            g.topicLabel ?? 'Other question',
            g.isTest && el('span', { class: 'badge test', text: 'TEST' })),
          el('span', { class: 'muted', text: `asked ${g.times} time${g.times === 1 ? '' : 's'} by ${g.customers} customer${g.customers === 1 ? '' : 's'} · ${timeAgo(g.lastAskedAt)}` })),
        el('p', { class: 'gap-quote', text: g.question }),
        el('p', { class: 'muted', text: scopeText(g) }),
        el('details', {},
          el('summary', { text: 'Request details (JSON)' }),
          el('pre', { text: JSON.stringify(g.requests, null, 2) })),
        isAdmin
          ? el('div', {}, answer, el('div', { class: 'gap-actions' }, save, dismiss))
          : el('p', { class: 'muted', text: 'Your account can view questions but not answer them.' }));
    }) : [el('p', { class: 'muted', text: 'Nothing waiting. Every question so far has been answered from the listings or by an approved answer.' })]));
  }

  function renderEntries(entries) {
    const isAdmin = state.me?.role === 'admin';
    $('entry-list').replaceChildren(...(entries.length ? entries.map((e) => {
      const answer = el('textarea', { maxlength: '1000', 'aria-label': 'Approved answer', disabled: !isAdmin }, e.answer);
      answer.value = e.answer;
      const where = e.propertyId ? `this property: ${e.propertyTitle ?? e.propertyId}` : e.area ? `questions about ${e.area}` : 'every customer';
      return el('article', { class: 'gap' },
        el('div', { class: 'gap-head' },
          el('span', { class: 'gap-title' },
            e.topicLabel ?? 'Free-form answer',
            !e.active && el('span', { class: 'badge off', text: 'Switched off' })),
          el('span', { class: 'muted', text: `served ${e.servedCount} time${e.servedCount === 1 ? '' : 's'}${e.lastServedAt ? ` · last ${timeAgo(e.lastServedAt)}` : ''}` })),
        e.question && el('p', { class: 'gap-quote', text: e.question }),
        el('p', { class: 'muted', text: `Used for ${where}${e.createdBy ? ` · written by ${e.createdBy}` : ''}` }),
        answer,
        isAdmin && el('div', { class: 'gap-actions' },
          el('button', { type: 'button', class: 'primary', text: 'Save changes', onclick: async () => {
            try { await api(`/knowledge/entries/${e.id}`, { method: 'PATCH', body: JSON.stringify({ answer: answer.value }) }); notice('Saved.'); loadKnowledge(); } catch (err) { notice(err.message, true); }
          } }),
          el('button', { type: 'button', text: e.active ? 'Switch off' : 'Switch on', onclick: async () => {
            try { await api(`/knowledge/entries/${e.id}`, { method: 'PATCH', body: JSON.stringify({ active: !e.active }) }); loadKnowledge(); } catch (err) { notice(err.message, true); }
          } }),
          el('button', { type: 'button', text: 'Delete', onclick: async () => {
            if (!confirm('Delete this answer? Customers will get the standard reply again, and the question will return to the list when asked.')) return;
            try { await api(`/knowledge/entries/${e.id}`, { method: 'DELETE' }); loadKnowledge(); } catch (err) { notice(err.message, true); }
          } })));
    }) : [el('p', { class: 'muted', text: 'No approved answers yet.' })]));
  }

  // ---- access log (admins) -----------------------------------------------------------------------

  async function loadAudit() {
    try {
      const { entries } = await api('/audit');
      $('audit-list').replaceChildren(...(entries.length
        ? entries.map((e) => el('article', { class: 'gap' },
            el('div', { class: 'gap-head' },
              el('span', { class: 'gap-title' }, e.staff, ' opened ', el('a', { href: `#lead=${encodeURIComponent(e.customerId)}`, text: e.customerId, onclick: () => { setView('leads'); setTimeout(() => openDrawer(e.customerId), 200); } })),
              el('span', { class: 'muted', text: timeAgo(e.at) })),
            el('p', { class: 'muted', text: [e.sawPhone && 'phone number', e.sawConversation && 'conversation'].filter(Boolean).join(' and ') + ' shown' })))
        : [el('p', { class: 'muted', text: 'Nobody has opened a private detail yet.' })]));
    } catch (e) {
      if (e.message !== 'signed out') notice(`Could not load the access log: ${e.message}`, true);
    }
  }

  // ---- first load ----------------------------------------------------------------------------

  (async () => {
    try {
      state.me = await api('/me');
      start();
    } catch {
      showLogin();
    }
  })();
})();
