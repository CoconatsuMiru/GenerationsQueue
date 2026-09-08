export interface Player {
  id: number;
  name: string;
  partnerId: number | null;
}

export interface Court {
  id: number;
  name: string;
  players: Player[]; // empty array = court is open/idle
  startTime: number | null; // timestamp (ms) when the current game started, or null if idle
}

// Shapes matching the actual Supabase table rows
export interface DbPlayer {
  id: number;
  name: string;
  queue_position: number;
  partner_id: number | null;
}

export interface DbCourt {
  id: number;
  name: string;
  player_ids: number[];
  start_time: string | null;
}

export interface DbSessionState {
  id: number;
  is_active: boolean;
}