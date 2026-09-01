import type { NodeInfo } from '@agenthub/shared';

const COLUMNS = ['Tier', 'Model', 'Endpoint', 'Active', 'Max'] as const;

/** Rack detail: what this node serves, and how busy each tier is right now. */
export function openNodeInfo(
  host: HTMLElement,
  node: NodeInfo,
  streams: Record<string, number>,
): () => void {
  const panel = document.createElement('div');
  panel.className = 'gb-panel gb-panel--center';

  const heading = document.createElement('h2');
  heading.textContent = node.name;
  panel.appendChild(heading);

  const facts = document.createElement('dl');
  for (const [label, value] of [
    ['Arch', node.arch],
    ['Status', node.status],
    ['Seen', `${Math.max(0, Math.round((Date.now() - node.lastHeartbeat) / 1000))}s ago`],
  ]) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    if (label === 'Status' && node.status === 'offline') detail.className = 'gb-status--offline';
    facts.append(term, detail);
  }
  panel.appendChild(facts);

  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const column of COLUMNS) {
    const cell = document.createElement('th');
    cell.textContent = column;
    head.appendChild(cell);
  }
  const body = table.createTBody();
  for (const endpoint of node.endpoints) {
    const row = body.insertRow();
    for (const [value, wrap] of [
      [endpoint.tier, false],
      [endpoint.model, false],
      [endpoint.url, true],
      [String(streams[endpoint.tier] ?? 0), false],
      [String(endpoint.maxStreams), false],
    ] as const) {
      const cell = row.insertCell();
      cell.textContent = value;
      if (wrap) cell.className = 'gb-cell--wrap';
    }
  }
  panel.appendChild(table);

  const hint = document.createElement('p');
  hint.className = 'gb-hint';
  hint.textContent = 'Esc to close';
  panel.appendChild(hint);

  host.appendChild(panel);
  return () => panel.remove();
}
