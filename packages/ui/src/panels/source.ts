import type { ProjectManifest, ProjectSource } from '@agenthub/shared';
import { sendJson } from '../api.js';
import { toast } from '../toast.js';

/**
 * The repository line under an imported project's intent: what was cloned, and the way to the
 * pull request the owner merges. It lives in its own module so the project page adds it in one
 * line — the header there is already long, and this is the whole of what an import shows.
 */

/** `owner/repo @ branch` — the repository and the branch a pull request would target. */
export function sourceLabel(source: ProjectSource): string {
  return `${source.owner}/${source.repo} @ ${source.branch}`;
}

export function sourceHref(source: ProjectSource): string {
  return `https://github.com/${source.owner}/${source.repo}/tree/${source.branch}`;
}

function link(href: string, text: string, className: string): HTMLAnchorElement {
  const node = document.createElement('a');
  node.className = className;
  node.href = href;
  node.target = '_blank';
  node.rel = 'noreferrer noopener';
  node.textContent = text;
  return node;
}

/**
 * Null for a project that was not imported. Otherwise the repository line, plus — once a verified
 * milestone has actually pushed `agenthub/<slug>` — the way to its pull request: the open one if
 * there is one, else the button that opens it.
 */
export function projectSourceRow(manifest: ProjectManifest): HTMLElement | null {
  const source = manifest.source;
  if (!source) return null;
  const row = document.createElement('p');
  row.className = 'detail__source';
  row.append(link(sourceHref(source), sourceLabel(source), 'detail__source-link'));
  if (!source.pushedAt) return row;

  if (source.prUrl) {
    row.append(link(source.prUrl, 'Pull request', 'detail__source-link'));
    return row;
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn';
  open.textContent = 'Open pull request';
  open.addEventListener('click', () => {
    open.disabled = true;
    // Idempotent on the hub's side: pressing it again after a later milestone finds the same one.
    void sendJson<{ url: string }>(`/api/projects/${manifest.slug}/pr`)
      .then((result) => {
        if (!result?.url) throw new Error('the hub returned no pull request');
        open.replaceWith(link(result.url, 'Pull request', 'detail__source-link'));
        toast('Pull request opened.');
      })
      .catch((error: unknown) => {
        open.disabled = false;
        toast(`Could not open the pull request: ${String(error)}`, 'error');
      });
  });
  row.append(open);
  return row;
}
