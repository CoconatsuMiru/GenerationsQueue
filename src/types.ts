export interface Player {
  id: number;
  name: string;
}

export interface Court {
  id: number;
  name: string;
  players: Player[]; // empty array = court is open/idle
  startTime: number | null; // timestamp (ms) when the current game started, or null if idle
}