import { PALETTE } from './palette.js';

export interface SpriteDef {
  legend: Record<string, string>;
  rows: string[];
}

export function validateSprite(def: SpriteDef): void {
  const { legend, rows } = def;

  for (const [char, name] of Object.entries(legend)) {
    if (!(name in PALETTE)) {
      throw new Error(`sprite legend char '${char}' maps to unknown palette entry '${name}'`);
    }
  }

  const width = rows[0]?.length ?? 0;
  for (const row of rows) {
    if (row.length !== width) {
      throw new Error(`ragged sprite row: expected width ${width}, got ${row.length} ('${row}')`);
    }
    for (const char of row) {
      if (char === '.') continue;
      if (!(char in legend)) {
        throw new Error(`unknown legend char '${char}' in sprite row '${row}'`);
      }
    }
  }
}
