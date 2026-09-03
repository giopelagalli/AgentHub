import type { UiState } from './store.js';

/** GB text for the connection badge; pure so it's testable without the DOM. */
export function badgeLabel(status: UiState['connection']): string {
  switch (status) {
    case 'live':
      return 'LIVE';
    case 'polling':
      return 'POLLING';
    case 'down':
      return 'OFFLINE';
  }
}
