(() => {
  // Share picker geometry and label presentation between GitHub's shadow roots and My tasks.
  const styles = `
    .gtt-label-picker { position:fixed; inset:auto; margin:0; width:min(282px,calc(100vw - 24px)); max-width:none; max-height:calc(100vh - 24px); overflow:auto; padding:12px; border:1px solid var(--borderColor-default,var(--line,#d0d7de)); border-radius:8px; background:var(--bgColor-default,var(--paper,#fff)); color:var(--fgColor-default,var(--ink,#1f2328)); box-shadow:0 8px 24px #0002; font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .gtt-label-picker .picker-title { margin:0 0 2px; font-size:13px; font-weight:600; }
    .gtt-label-picker .picker-hint { margin:0 0 8px; color:var(--fgColor-muted,var(--muted,#59636e)); font-size:11px; }
    .gtt-label-picker .picker-choices { margin:0; max-height:240px; overflow:auto; }
    .gtt-label-picker .picker-choices label { display:flex; align-items:center; gap:6px; padding:3px 0; border-radius:4px; cursor:pointer; }
    .gtt-label-picker .picker-choices label:hover { background:var(--bgColor-muted,var(--wash,#f6f8fa)); }
    .gtt-label-picker .picker-choices input { flex:none; width:13px; height:13px; margin:0; accent-color:#0969da; }
    .gtt-label-picker .picker-label { display:inline-flex; align-items:center; min-width:0; max-width:100%; padding:0 7px; border:1px solid #0002; border-radius:12px; font-size:11px; font-weight:500; line-height:16px; overflow-wrap:anywhere; }
    .gtt-label-picker .picker-create-toggle { display:block; width:100%; margin-top:10px; padding:7px 9px; border:1px dashed var(--borderColor-default,var(--line,#d0d7de)); border-radius:5px; background:var(--bgColor-muted,var(--wash,#f6f8fa)); color:var(--fgColor-accent,var(--blue,#0969da)); font-size:12px; text-align:left; }
    .gtt-label-picker .picker-create-fields { margin-top:10px; padding-top:10px; border-top:1px solid var(--borderColor-muted,var(--line,#d8dee4)); font-size:12px; }
    .gtt-label-picker .picker-create-fields input[type=text] { flex:1; min-width:0; height:32px; padding:5px 8px; font:inherit; background:var(--bgColor-default,var(--paper,#fff)); color:inherit; border:1px solid var(--borderColor-default,var(--line,#d0d7de)); border-radius:5px; }
    .gtt-label-picker .picker-create-fields input[type=color] { flex:none; width:34px; height:32px; padding:3px; }
    .gtt-label-picker .picker-footer { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-top:10px; padding-top:10px; border-top:1px solid var(--borderColor-muted,var(--line,#d8dee4)); }
    .gtt-label-picker .picker-footer button { min-height:26px; padding:3px 8px; font-size:12px; }
    .gtt-label-picker .picker-manage { margin-right:auto; color:var(--fgColor-accent,var(--blue,#0969da)); font-size:11px; text-decoration:none; }
    .gtt-label-picker .picker-manage:hover { text-decoration:underline; }
    .gtt-plus-icon { display:block; width:12px; height:12px; flex:none; pointer-events:none; }
  `;
  function plusIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('gtt-plus-icon');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', 'M8 3v10M3 8h10'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('fill', 'none');
    svg.append(path);
    return svg;
  }
  function colorize(node, label) {
    const rgb = label.color.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255);
    const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    const ink = luminance > 0.179 ? '#000' : '#fff';
    node.style.setProperty('--label-color', label.color); node.style.setProperty('--label-ink', ink);
    node.style.backgroundColor = label.color; node.style.color = ink;
  }
  function place(panel, anchor) {
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - rect.width - 12))}px`;
    const below = anchor.bottom + 6;
    const top = below + rect.height <= innerHeight - 12 ? below : anchor.top - rect.height - 6;
    panel.style.top = `${Math.max(12, Math.min(top, innerHeight - rect.height - 12))}px`;
  }
  globalThis.GitHubTaskTrackerLabelPicker = { styles, plusIcon, colorize, place };
})();
