(() => {
  const scope = 'github-task-tracker';
  let state;
  let timer;
  let port;
  const widgets = new Map();
  const filterView = globalThis.GitHubTaskTrackerFilter.create({ getState: () => state });
  const style = `${globalThis.GitHubTaskTrackerLabelOrder.styles}
${globalThis.GitHubTaskTrackerLabelPicker.styles}

    :host { display:inline-block; vertical-align:middle; margin:0 0 0 6px; font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--fgColor-default,#1f2328); }
    :host([data-placement=sidebar]) { display:block; margin:16px 0 0; padding:16px 0 0; border-top:1px solid var(--borderColor-muted,#d8dee4); }
    .sidebar-title { margin:0 0 6px; font-size:12px; font-weight:600; } .sidebar-hint { margin:0 0 9px; font-size:11px; }
    * { box-sizing:border-box; } details { position:relative; } summary { display:flex; flex-wrap:wrap; align-items:center; gap:4px; cursor:pointer; list-style:none; border-radius:6px; } summary::-webkit-details-marker { display:none; }
    .tag-bar { display:flex; flex-wrap:wrap; align-items:center; gap:4px; } .selected-labels { display:contents; }
    button,input { font:inherit; } button { cursor:pointer; } summary:focus-visible,button:focus-visible,input:focus-visible,a:focus-visible { outline:2px solid #0969da; outline-offset:3px; }
    .add { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; line-height:1; border:1px solid var(--borderColor-accent-emphasis,#0969da); border-radius:9px; padding:0; background:var(--bgColor-accent-muted,#ddf4ff); color:var(--fgColor-accent,#0969da); font-weight:600; } summary:hover .add { filter:brightness(.94); }
    .badge { display:inline-flex; align-items:center; gap:5px; border:1px solid #0002; border-radius:12px; padding:2px 10px; background:var(--label-color); color:var(--label-ink); font-weight:600; max-width:260px; overflow-wrap:anywhere; line-height:18px; }
    .lock { width:12px; height:12px; flex:none; }
    .tag { padding:0; gap:0; } .tag button { border:0; background:transparent; color:inherit; padding:2px 6px; border-radius:12px; font-weight:600; line-height:18px; } .tag .label-name { display:inline-flex; align-items:center; gap:5px; padding-left:9px; min-width:0; overflow-wrap:anywhere; text-align:left; } .tag .remove-label { padding:2px 8px 2px 4px; font-size:15px; flex:none; } .tag button:hover { background:#0002; } .tag button:focus-visible { outline-offset:1px; }
    .inline-error:empty { display:none; } .inline-error { margin:5px 0 0; color:var(--fgColor-danger,#cf222e); }
    h3 { font-size:13px; margin:0 0 2px; } p { color:var(--fgColor-muted,#59636e); margin:0 0 10px; }
    label { display:flex; gap:8px; align-items:center; padding:7px 4px; border-radius:4px; overflow-wrap:anywhere; cursor:pointer; } label:hover { background:var(--bgColor-muted,#f6f8fa); } input { accent-color:#0969da; flex:none; }
    .footer { display:flex; justify-content:space-between; margin-top:10px; border-top:1px solid var(--borderColor-muted,#d8dee4); padding-top:10px; }
    button { background:var(--bgColor-muted,#f6f8fa); color:inherit; border:1px solid var(--borderColor-default,#d0d7de); border-radius:5px; padding:3px 8px; } .manage { color:var(--fgColor-accent,#0969da); background:none; border:0; padding-left:0; } .error { color:var(--fgColor-danger,#cf222e); margin-top:8px; }
    [hidden] { display:none !important; } .create-toggle { display:block; width:100%; margin-top:10px; padding:7px 9px; text-align:left; color:var(--fgColor-accent,#0969da); border-style:dashed; }
    .create-form { margin-top:10px; padding-top:10px; border-top:1px solid var(--borderColor-muted,#d8dee4); } .create-form>label { display:block; padding:0; font-weight:600; cursor:default; } .create-fields { display:flex; gap:6px; margin:6px 0 8px; }
    .create-fields input[type=text] { flex:1; width:0; min-width:0; padding:5px 8px; border:1px solid var(--borderColor-default,#d0d7de); border-radius:5px; background:var(--bgColor-default,#fff); color:inherit; }
    .create-fields input[type=color] { width:34px; height:32px; padding:3px; border:1px solid var(--borderColor-default,#d0d7de); border-radius:5px; background:var(--bgColor-default,#fff); cursor:pointer; }
    .create-actions { display:flex; gap:6px; } .create-submit { background:#0969da; border-color:#0969da; color:#fff; font-weight:600; } .create-hint { font-size:11px; margin:7px 0 0; } button:disabled { opacity:.6; cursor:wait; }
  `;

  async function request(operation) {
    const response = await chrome.runtime.sendMessage({ scope, ...operation });
    if (!response?.ok) throw new Error(response?.error || 'Could not save. Reload this GitHub page and try again.');
    return response.data;
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function badge(label, privateMark = false) {
    const node = element('span', '', 'badge');
    globalThis.GitHubTaskTrackerLabelPicker.colorize(node, label);
    if (privateMark) {
      const lock = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      lock.classList.add('lock');
      lock.setAttribute('viewBox', '0 0 16 16');
      lock.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M5 7V5a3 3 0 0 1 6 0v2M4 7h8v7H4z');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linejoin', 'round');
      lock.append(path);
      node.append(lock);
      node.title = 'Private label — visible only in your browser';
    }
    node.append(document.createTextNode(label.name));
    return node;
  }

  function refresh(widget) {
    const ids = state.pullRequests[widget.key] || [];
    const selected = state.labels.filter(label => ids.includes(label.id));
    widget.tags.replaceChildren(...selected.map(label => selectedTag(widget, label)));
    const add = element('span', '', 'add');
    add.append(globalThis.GitHubTaskTrackerLabelPicker.plusIcon());
    widget.summary.replaceChildren(add);
    widget.summary.setAttribute('aria-label', `Edit private labels for ${widget.key}`);
    // Preserve focus during storage broadcasts by rebuilding only closed editors.
    if (!widget.details.open) renderChoices(widget);
  }

  function selectedTag(widget, label) {
    const tag = badge(label, true);
    tag.classList.add('tag');
    const name = element('button', '', 'label-name');
    name.type = 'button';
    name.dataset.labelId = label.id;
    name.title = `Show PRs with “${label.name}” in ${widget.key.split('#')[0]}`;
    name.setAttribute('aria-label', name.title);
    name.append(...tag.childNodes);
    const remove = element('button', '×', 'remove-label');
    remove.type = 'button';
    remove.dataset.labelId = label.id;
    remove.title = `Remove “${label.name}” from this PR`;
    remove.setAttribute('aria-label', remove.title);
    remove.disabled = widget.removing.has(label.id);
    name.addEventListener('click', () => filterView.open(widget.key, label.id));
    remove.addEventListener('click', async () => {
      if (widget.removing.has(label.id)) return;
      widget.removing.add(label.id);
      remove.disabled = true;
      widget.status.textContent = '';
      try {
        state = await request({ type: 'setLabel', key: widget.key, labelId: label.id, selected: false });
        refreshAll();
        widget.summary.focus({ preventScroll: true });
      } catch (error) { widget.status.textContent = error.message; }
      finally { widget.removing.delete(label.id); remove.disabled = false; }
    });
    tag.replaceChildren(name, remove);
    return tag;
  }

  function renderChoices(widget) {
    widget.labelSignature = JSON.stringify(state.labels);
    widget.choices.replaceChildren();
    widget.error.textContent = '';
    if (!state.labels.length) widget.choices.append(element('p', 'No labels yet. Create your first one below.'));
    for (const label of state.labels) {
      const row = element('label');
      const input = element('input');
      input.type = 'checkbox';
      input.checked = (state.pullRequests[widget.key] || []).includes(label.id);
      const colorLabel = badge(label); colorLabel.classList.add('picker-label');
      row.append(widget.reorder.handle(row, label), input, colorLabel);
      input.addEventListener('change', async () => {
        const selected = input.checked;
        input.disabled = true;
        widget.error.textContent = '';
        try {
          state = await request({ type: 'setLabel', key: widget.key, labelId: label.id, selected });
          refreshAll();
        } catch (error) {
          input.checked = !selected;
          widget.error.textContent = error.message;
        } finally { input.disabled = false; }
      });
      widget.choices.append(row);
    }
  }

  function createLabelForm(widget) {
    const toggle = element('button', '+ Create label', 'create-toggle picker-create-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const form = element('form', '', 'create-form picker-create-fields');
    form.hidden = true;
    const label = element('label', 'New label name');
    const name = element('input');
    name.id = 'new-label-name';
    name.type = 'text';
    name.required = true;
    name.maxLength = 60;
    name.placeholder = 'e.g. Pending by designer';
    label.htmlFor = name.id;
    const color = element('input');
    color.type = 'color';
    color.value = '#0969da';
    color.setAttribute('aria-label', 'New label color');
    const fields = element('div', '', 'create-fields');
    fields.append(name, color);
    const actions = element('div', '', 'create-actions');
    const submit = element('button', 'Create & apply', 'create-submit');
    submit.type = 'submit';
    const cancel = element('button', 'Cancel');
    cancel.type = 'button';
    actions.append(submit, cancel);
    form.append(label, fields, actions, element('p', 'Also available on your other PRs.', 'create-hint'));
    const close = () => {
      form.hidden = true;
      toggle.hidden = false;
      toggle.setAttribute('aria-expanded', 'false');
      widget.error.textContent = '';
      placePanel(widget);
    };
    toggle.addEventListener('click', () => {
      form.hidden = false;
      toggle.hidden = true;
      toggle.setAttribute('aria-expanded', 'true');
      placePanel(widget);
      name.focus();
    });
    cancel.addEventListener('click', () => { close(); toggle.focus(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      cancel.disabled = true;
      widget.error.textContent = '';
      try {
        state = await request({ type: 'createAndAssignLabel', key: widget.key, label: { id: crypto.randomUUID(), name: name.value, color: color.value } });
        name.value = '';
        refreshAll();
        close();
        toggle.focus();
      } catch (error) {
        widget.error.textContent = error.message;
        placePanel(widget);
      } finally {
        submit.disabled = false;
        cancel.disabled = false;
      }
    });
    return [toggle, form];
  }

  function createWidget(anchor, key, placement = 'list') {
    const host = element('span');
    host.dataset.gtt = key;
    host.dataset.placement = placement;
    const root = host.attachShadow({ mode: 'closed' });
    const css = element('style', style);
    const details = element('details');
    const summary = element('summary');
    const tags = element('span', '', 'selected-labels');
    const bar = element('span', '', 'tag-bar');
    const status = element('p', '', 'inline-error');
    status.setAttribute('role', 'alert');
    const panel = element('section', '', 'panel gtt-label-picker');
    // A top-layer popover escapes GitHub's row overflow and stacking contexts.
    panel.setAttribute('popover', 'manual');
    panel.setAttribute('aria-label', 'Private labels');
    const choices = element('div', '', 'choices picker-choices');
    const error = element('p', '', 'error');
    error.setAttribute('role', 'alert');
    const footer = element('div', '', 'footer picker-footer');
    const manage = element('button', 'Manage labels', 'manage');
    const tasks = element('button', 'My tasks', 'manage');
    const done = element('button', 'Done');
    manage.type = tasks.type = done.type = 'button';
    manage.addEventListener('click', () => request({ type: 'openSettings' }).catch(err => { error.textContent = err.message; }));
    tasks.addEventListener('click', () => request({ type: 'openTasks' }).catch(err => { error.textContent = err.message; }));
    done.addEventListener('click', () => { details.open = false; summary.focus(); });
    footer.append(manage, tasks, done);
    const widget = { host, key, placement, details, summary, tags, status, removing: new Set(), panel, choices, error };
    widget.reorder = globalThis.GitHubTaskTrackerLabelOrder.create(choices, {
      move: async operation => { state = await request(operation); refreshAll(); },
      error: message => { widget.error.textContent = message; }
    });
    panel.append(element('h3', 'My private labels', 'picker-title'), element('p', 'Drag handles to reorder. Saved in this browser.', 'picker-hint'), choices, ...createLabelForm(widget), footer, error);
    details.append(summary, panel);
    root.append(css);
    if (placement === 'sidebar') {
      root.append(element('h3', 'Private labels', 'sidebar-title'), element('p', 'Saved only in this browser.', 'sidebar-hint'));
    }
    bar.append(tags, details);
    root.append(bar, status);
    details.addEventListener('toggle', () => {
      if (!details.open) { panel.hidePopover(); return; }
      for (const other of widgets.values()) if (other !== widget) other.details.open = false;
      renderChoices(widget);
      panel.showPopover();
      placePanel(widget);
    });
    root.addEventListener('keydown', event => {
      if (details.open) {
        if (event.key === 'Escape') { details.open = false; summary.focus(); }
        // Keep editor keystrokes private, but allow page shortcuts once it is closed.
        event.stopPropagation();
      }
    });
    root.addEventListener('click', event => event.stopPropagation());
    anchor.after(host);
    widgets.set(anchor, widget);
    refresh(widget);
  }

  function isList() {
    return /^\/[^/]+\/[^/]+\/pulls\/?$/.test(location.pathname) || /^\/pulls(?:\/(?:assigned|mentioned|review-requested))?\/?$/.test(location.pathname);
  }

  function detailKey() {
    const match = location.pathname.match(/^\/([\w-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
    return match ? `${match[1]}/${match[2]}#${match[3]}`.toLowerCase() : null;
  }

  function detailLabelsSection() {
    const sidebar = document.querySelector('#partial-discussion-sidebar, .discussion-sidebar');
    if (!sidebar) return null;
    return sidebar.querySelector('[data-channel-event-name="labels_updated"]')
      || sidebar.querySelector('.js-issue-labels, #labels-select-menu')?.closest('.discussion-sidebar-item');
  }

  function placePanel(widget, target = widget.panel) {
    globalThis.GitHubTaskTrackerLabelPicker.place(target, widget.summary.getBoundingClientRect());
  }

  function scan() {
    if (!state) return;
    const list = isList();
    const rows = list ? globalThis.GitHubTaskTrackerFilter.collectRows() : [];
    filterView.sync(rows);
    const key = detailKey();
    for (const [anchor, widget] of widgets) {
      const wrongPage = widget.placement === 'sidebar' ? widget.key !== key : !list;
      if (!anchor.isConnected || !widget.host.isConnected || wrongPage) { widget.host.remove(); widgets.delete(anchor); }
    }
    if (key) {
      const section = detailLabelsSection();
      if (section && !widgets.has(section)) createWidget(section, key, 'sidebar');
      return;
    }
    if (!list) return;
    for (const { anchor, key } of rows) {
      if (widgets.has(anchor) && widgets.get(anchor).key !== key) {
        widgets.get(anchor).host.remove();
        widgets.delete(anchor);
      }
      if (!widgets.has(anchor)) createWidget(anchor, key);
    }
  }

  function refreshAll() {
    for (const widget of widgets.values()) {
      refresh(widget);
      // Refresh checkbox values without replacing focused controls.
      if (widget.details.open) {
        const inputs = widget.choices.querySelectorAll('input');
        if (widget.labelSignature !== JSON.stringify(state.labels)) renderChoices(widget);
        else inputs.forEach((input, index) => { input.checked = (state.pullRequests[widget.key] || []).includes(state.labels[index].id); });
        placePanel(widget);
      }
    }
    scan();
  }

  function scheduleScan() {
    // Batch updates without postponing recovery indefinitely during continuous rendering.
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; scan(); }, 80);
  }

  function connect() {
    if (!chrome.runtime?.id) return;
    const connection = chrome.runtime.connect({ name: scope });
    port = connection;
    let receivedUpdate = false;
    connection.onMessage.addListener(next => {
      if (port !== connection) return;
      receivedUpdate = true;
      state = next;
      refreshAll();
    });
    connection.onDisconnect.addListener(() => {
      if (port !== connection) return;
      port = undefined;
      // A worker can sleep between visits; reconnect without keeping it alive.
      void chrome.runtime.lastError;
      if (chrome.runtime?.id) setTimeout(connect, 1000);
    });
    request({ type: 'get' }).then(next => {
      // A broadcast can overtake the initial snapshot on the separate response channel.
      if (port !== connection || receivedUpdate) return;
      state = next;
      refreshAll();
    }).catch(error => console.warn('GitHub Task Tracker:', error.message));
  }

  function containsPageElement(nodes, includeWidgets = false) {
    for (const node of nodes) {
      if (node.nodeType === 1 && (includeWidgets || !node.hasAttribute('data-gtt'))) return true;
    }
    return false;
  }

  new MutationObserver(records => {
    // Ignore our own insertions, but recover when GitHub removes an injected control.
    if (records.some(record => record.type === 'attributes' || containsPageElement(record.addedNodes) || containsPageElement(record.removedNodes, true))) scheduleScan();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  document.addEventListener('turbo:load', scheduleScan);
  document.addEventListener('turbo:render', scheduleScan);
  document.addEventListener('pjax:end', scheduleScan);
  document.addEventListener('click', event => {
    for (const widget of widgets.values()) if (!event.composedPath().includes(widget.host)) { widget.details.open = false; }
  });
  window.addEventListener('pageshow', scheduleScan);
  window.addEventListener('popstate', scheduleScan);
  window.addEventListener('hashchange', scheduleScan);
  function repositionPanels() {
    for (const widget of widgets.values()) {
      if (widget.details.open) placePanel(widget);
    }
  }
  window.addEventListener('resize', repositionPanels);
  window.addEventListener('scroll', repositionPanels, { passive: true, capture: true });
  connect();
})();
