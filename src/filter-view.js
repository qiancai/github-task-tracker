(() => {
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function listRepository() {
    const match = location.pathname.match(/^\/([\w-]+)\/([\w.-]+)\/pulls\/?$/);
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
  }

  function isList() {
    return Boolean(listRepository()) || /^\/pulls(?:\/(?:assigned|mentioned|review-requested))?\/?$/.test(location.pathname);
  }

  function collectRows() {
    const found = [];
    const seen = new Set();
    for (const anchor of document.querySelectorAll('a[href*="/pull/"]')) {
      const url = new URL(anchor.href, location.href);
      const match = url.origin === location.origin && url.pathname.match(/^\/([\w-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
      if (!match || !anchor.textContent.trim() || anchor.closest('.avatar') || anchor.getAttribute('aria-label')?.startsWith('comments')) continue;
      const row = anchor.closest('.js-issue-row, [id^="issue_"], [data-testid="list-row"], .Box-row, li:has([data-testid="listitem-title-link"])');
      if (!row || seen.has(row)) continue;
      seen.add(row);
      found.push({ row, anchor, key: `${match[1]}/${match[2]}#${match[3]}`.toLowerCase() });
    }
    return found;
  }

  const css = `
    :host { display:block; margin:12px 0; padding:12px 16px; color:var(--fgColor-default,#1f2328); background:var(--bgColor-accent-muted,#ddf4ff); border:1px solid var(--borderColor-accent-muted,#b6e3ff); border-radius:6px; font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    * { box-sizing:border-box; } .toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; } strong { overflow-wrap:anywhere; } button { cursor:pointer; font:inherit; color:var(--fgColor-accent,#0969da); background:var(--bgColor-default,#fff); border:1px solid var(--borderColor-default,#d1d9e0); border-radius:5px; padding:3px 9px; } .clear { font-size:16px; padding:0 6px; } .clear-all { margin-left:auto; } :focus-visible { outline:2px solid var(--fgColor-accent,#0969da); outline-offset:3px; } p { color:var(--fgColor-muted,#59636e); margin:7px 0 0; } .empty { color:var(--fgColor-default,#1f2328); } [hidden] { display:none !important; }
  `;

  function create({ getState }) {
    const hidden = new Map();
    const pagination = new Map();
    let view;

    function selection() {
      if (!isList()) return null;
      const hash = new URLSearchParams(location.hash.slice(1));
      const labelId = hash.get('private-label');
      const repository = listRepository() || hash.get('private-repo');
      if (!labelId || !repository || !/^[\w-]+\/[\w.-]+$/.test(repository)) return null;
      return { labelId, repository: repository.toLowerCase() };
    }

    function restoreRow(row, previous) {
      if (previous.value) row.style.setProperty('display', previous.value, previous.priority);
      else row.style.removeProperty('display');
    }

    function restorePagination() {
      for (const [link, previous] of pagination) {
        // Do not overwrite a newer URL supplied by GitHub while the filter was active.
        if (link.getAttribute('href') === previous.decorated) link.setAttribute('href', previous.original);
      }
      pagination.clear();
    }

    function dispose() {
      for (const [row, previous] of hidden) restoreRow(row, previous);
      hidden.clear();
      restorePagination();
      view?.host.remove();
      view = undefined;
    }

    function clear() {
      const url = new URL(location.href);
      url.hash = '';
      history.pushState({}, '', url);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }

    function open(key, labelId) {
      const repository = key.split('#')[0];
      const stay = isList() && (!listRepository() || listRepository() === repository);
      const url = stay ? new URL(location.href) : new URL(`/${repository}/pulls`, location.origin);
      const hash = new URLSearchParams({ 'private-label': labelId });
      if (!listRepository() && stay) hash.set('private-repo', repository);
      url.hash = hash.toString();
      location.assign(url.href);
    }

    function paginationURL(link, filter) {
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname || !url.searchParams.has('page')) return null;
      const hash = new URLSearchParams({ 'private-label': filter.labelId });
      if (!listRepository()) hash.set('private-repo', filter.repository);
      url.hash = hash.toString();
      return url.href;
    }

    function decoratePagination(filter) {
      for (const [link] of pagination) if (!link.isConnected) pagination.delete(link);
      for (const link of document.querySelectorAll('a[href]')) {
        const decorated = paginationURL(link, filter);
        if (!decorated) continue;
        const href = link.getAttribute('href');
        if (!pagination.has(link) || href !== pagination.get(link).decorated) {
          let original = href;
          const url = new URL(link.href, location.href);
          const hash = new URLSearchParams(url.hash.slice(1));
          if (hash.has('private-label')) { url.hash = ''; original = url.href; }
          pagination.set(link, { original, decorated });
        }
        if (href !== decorated) link.setAttribute('href', decorated);
      }
    }

    // GitHub's client router may use its original URL instead of the decorated href.
    function paginate(event) {
      const filter = selection();
      const link = event.target.closest?.('a[href]');
      if (!filter || !link || event.defaultPrevented) return;
      const url = paginationURL(link, filter);
      if (!url) return;
      link.href = url;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      location.assign(url);
    }
    document.addEventListener('click', paginate, true);
    document.addEventListener('auxclick', paginate, true);

    function sync(rows = collectRows()) {
      const filter = selection();
      const state = getState();
      if (!filter || !state) { if (view || hidden.size || pagination.size) dispose(); return false; }
      const currentRows = new Set(rows.map(item => item.row));
      for (const [row, previous] of hidden) {
        if (!currentRows.has(row)) { restoreRow(row, previous); hidden.delete(row); }
      }
      const label = state.labels.find(item => item.id === filter.labelId);
      let matches = 0;
      for (const { row, key } of rows) {
        const selected = Boolean(label && key.startsWith(`${filter.repository}#`) && state.pullRequests[key]?.includes(filter.labelId));
        if (selected) {
          matches++;
          if (hidden.has(row)) { restoreRow(row, hidden.get(row)); hidden.delete(row); }
        } else {
          if (!hidden.has(row)) hidden.set(row, { value: row.style.getPropertyValue('display'), priority: row.style.getPropertyPriority('display') });
          row.style.setProperty('display', 'none', 'important');
        }
      }
      const area = rows[0]?.row.closest('[id$="-list-view-container"], .js-issues-results, .Box')
        || rows[0]?.row.closest('ul, [role="list"]')
        || document.querySelector('[id$="-list-view-container"], .js-issues-results, #repo-content-pjax-container, .repository-content, [class*="prc-PageLayout-Content-"]');
      if (!area) { decoratePagination(filter); return true; }
      if (!view || !view.host.isConnected || view.area !== area) {
        view?.host.remove();
        const host = element('section');
        host.dataset.gttFilter = '';
        const root = host.attachShadow({ mode: 'closed' });
        const toolbar = element('div', '', 'toolbar');
        const name = element('strong');
        const close = element('button', '×', 'clear');
        close.type = 'button';
        close.setAttribute('aria-label', 'Clear private label filter');
        close.addEventListener('click', clear);
        const count = element('span', '', 'count');
        count.setAttribute('role', 'status');
        const clearAll = element('button', 'Clear filter', 'clear-all');
        clearAll.type = 'button';
        clearAll.addEventListener('click', clear);
        toolbar.append(name, close, count, clearAll);
        const empty = element('p', '', 'empty');
        empty.setAttribute('role', 'status');
        root.append(element('style', css), toolbar, empty);
        area.before(host);
        view = { host, root, area, name, count, empty };
      }
      const name = `Private label: ${label?.name || 'Unavailable label'}`;
      const count = `${matches} of ${rows.length} PRs on this page`;
      if (view.name.textContent !== name) view.name.textContent = name;
      if (view.count.textContent !== count) view.count.textContent = count;
      view.empty.hidden = matches > 0;
      view.empty.textContent = label ? 'No PRs on this page have this private label. Try another GitHub page or clear the filter.' : 'This label was deleted or is unavailable in this browser. Clear the filter to show all PRs.';
      decoratePagination(filter);
      return true;
    }

    return { sync, open };
  }

  globalThis.GitHubTaskTrackerFilter = { create, collectRows };
})();
