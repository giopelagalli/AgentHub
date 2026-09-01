export type FloorId = 'b1' | 'f1' | 'f2' | 'f3' | 'f4' | 'ph';

export interface FloorDef {
  id: FloorId;
  label: string;
}

export const FLOORS: FloorDef[] = [
  { id: 'b1', label: 'B1 SERVER ROOM' },
  { id: 'f1', label: '1F LOBBY' },
  { id: 'f2', label: '2F GENERAL STAFF' },
  { id: 'f3', label: '3F SAMPLE PROJECT' },
  { id: 'f4', label: '4F VACANT' },
  { id: 'ph', label: 'PH PENTHOUSE' },
];
