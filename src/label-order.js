(() => {
  const styles = `
    .label-order-handle { display:inline-flex; align-items:center; justify-content:center; flex:none; width:18px; height:22px; min-height:0; padding:0; border:0; border-radius:3px; background:transparent; color:var(--fgColor-muted,var(--muted,#59636e)); cursor:grab; }
    .label-order-handle:hover { background:var(--bgColor-muted,var(--wash,#f6f8fa)); }
    .label-order-handle:active { cursor:grabbing; }
    .label-order-handle svg { width:10px; height:14px; pointer-events:none; }
    [data-order-id][data-drop=before] { box-shadow:inset 0 2px var(--fgColor-accent,var(--blue,#0969da)); }
    [data-order-id][data-drop=after] { box-shadow:inset 0 -2px var(--fgColor-accent,var(--blue,#0969da)); }
  `;

  function create(list, { move, error, disabled = () => false }) {
    let dragged;
    let busy = false;
    const rows = () => [...list.children].filter(row => row.dataset.orderId);
    const clear = () => rows().forEach(row => delete row.dataset.drop);
    const handles = () => list.querySelectorAll('.label-order-handle');
    async function commit(id, targetId, after) {
      if (busy || disabled() || id === targetId) return;
      busy = true;
      handles().forEach(handle => { handle.disabled = true; });
      const scroll = list.scrollTop;
      try { await move({ type: 'moveLabel', labelId: id, targetId, after }); }
      catch (reason) { error(reason.message); }
      finally {
        busy = false;
        handles().forEach(handle => { handle.disabled = disabled(); });
        const handle = [...handles()].find(item => item.closest('[data-order-id]').dataset.orderId === id);
        handle?.focus({ preventScroll: true });
        list.scrollTop = scroll;
      }
    }
    list.addEventListener('dragstart', event => {
      const handle = event.target.closest('.label-order-handle');
      if (!handle || busy || disabled()) { event.preventDefault(); return; }
      dragged = handle.closest('[data-order-id]').dataset.orderId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragged);
      event.stopPropagation();
    });
    list.addEventListener('dragover', event => {
      if (!dragged || busy || disabled()) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      clear();
      const row = event.target.closest('[data-order-id]');
      if (row && row.dataset.orderId !== dragged) row.dataset.drop = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 ? 'after' : 'before';
      const rect = list.getBoundingClientRect();
      if (event.clientY < rect.top + 20) list.scrollTop -= 12;
      else if (event.clientY > rect.bottom - 20) list.scrollTop += 12;
    });
    list.addEventListener('drop', event => {
      if (!dragged) return;
      event.preventDefault(); event.stopPropagation();
      const row = event.target.closest('[data-order-id]');
      const id = dragged;
      dragged = undefined;
      const after = row?.dataset.drop === 'after';
      clear();
      if (row) void commit(id, row.dataset.orderId, after);
    });
    list.addEventListener('dragend', () => { dragged = undefined; clear(); });
    return {
      handle(row, label) {
        row.dataset.orderId = label.id;
        const handle = document.createElement('button');
        handle.type = 'button'; handle.className = 'label-order-handle'; handle.draggable = true;
        handle.disabled = busy || disabled();
        handle.title = `Drag to reorder ${label.name}. Keyboard: Alt + ↑ / ↓.`;
        handle.setAttribute('aria-label', `Reorder ${label.name}`);
        handle.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 10 14'); svg.setAttribute('aria-hidden', 'true');
        for (const x of [2, 8]) for (const y of [2, 7, 12]) {
          const dot = document.createElementNS(svg.namespaceURI, 'circle');
          dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', '1'); dot.setAttribute('fill', 'currentColor'); svg.append(dot);
        }
        handle.append(svg);
        // The handle lives inside a checkbox label; moving it must never toggle selection.
        handle.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
        handle.addEventListener('keydown', event => {
          if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const items = rows(); const index = items.indexOf(row);
          const target = items[index + (event.key === 'ArrowUp' ? -1 : 1)];
          if (target) void commit(label.id, target.dataset.orderId, event.key === 'ArrowDown');
        });
        return handle;
      }
    };
  }
  globalThis.GitHubTaskTrackerLabelOrder = { create, styles };
})();
