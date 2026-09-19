export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';

export interface Player {
  id: number;
  name: string;
  partnerId: number | null;
  gamesPlayed: number;
  skillLevel: SkillLevel;
  wins: number;
  losses: number;
}

export interface Court {
  id: number;
  name: string;
  players: Player[]; // empty array = court is open/idle
  startTime: number | null; // timestamp (ms) when the current game started, or null if idle
}

export interface VenueSettings {
  warmupMinutes: number;
  gameMinutes: number;
  overtimeMinutes: number;
  timeBased: boolean;
  queueMode: 'fifo' | 'fair';
}

// Shapes matching the actual Supabase table rows
export interface DbPlayer {
  id: number;
  name: string;
  queue_position: number;
  partner_id: number | null;
  games_played: number;
  skill_level: SkillLevel;
  wins: number;
  losses: number;
}

export interface DbCourt {
  id: number;
  name: string;
  player_ids: number[];
  start_time: string | null;
}

export interface DbSessionState {
  owner_id: string;
  is_active: boolean;
}

export interface DbVenueSettings {
  owner_id: string;
  warmup_minutes: number;
  game_minutes: number;
  overtime_minutes: number;
  time_based: boolean;
  queue_mode: 'fifo' | 'fair';
}

export interface DbGroupHistory {
  owner_id: string;
  player_a_id: number;
  player_b_id: number;
  count: number;
}

export interface DbMatch {
  id: number;
  owner_id: string;
  court_id: number;
  court_name: string;
  team_a_names: string[];
  team_b_names: string[];
  winner_team: 'a' | 'b';
  created_at: string;
}