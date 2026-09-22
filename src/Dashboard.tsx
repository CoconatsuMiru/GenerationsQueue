import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import './App.css';
import type { Player, Court, SkillLevel } from './types';
import { SkillBadge, SKILL_LEVELS } from './skillLevels';
import { supabase } from './supabaseClient';
import CourtCard from './CourtCard';
import { speak, isSpeechSupported, primeSpeechOnFirstInteraction, stopSpeaking } from './speech';
import type { Session } from '@supabase/supabase-js';

const GAME_LENGTH_MINUTES = 15;
const WARMUP_MINUTES = 3;
const OVERTIME_MINUTES = 2;
const MAX_QUEUE_STACKS = 10;
const ANNOUNCE_PAUSE_MS = 1500;
const FIRST_CALL_REPEAT_PAUSE_MS = 400;


interface DashboardProps {
  session: Session;
}

function buildUnits(players: Player[]): Player[][] {
  const consumed = new Set<number>();
  const units: Player[][] = [];

  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (consumed.has(player.id)) continue;

    if (player.partnerId !== null) {
      const partnerIndex = players.findIndex((p) => p.id === player.partnerId);
      const partner = partnerIndex !== -1 ? players[partnerIndex] : undefined;

      if (partner && !consumed.has(partner.id)) {
        if (partnerIndex > i) {
          continue;
        }

        units.push([player, partner]);
        consumed.add(player.id);
        consumed.add(partner.id);
        continue;
      }
    }

    units.push([player]);
    consumed.add(player.id);
  }

  return units;
}

function selectNextGroup(
  units: Player[][],
  size: number
): { group: Player[]; remainingUnits: Player[][] } {
  const group: Player[] = [];
  const remaining = [...units];
  let i = 0;

  while (group.length < size && i < remaining.length) {
    const unit = remaining[i];
    if (unit.length <= size - group.length) {
      group.push(...unit);
      remaining.splice(i, 1);
    } else {
      i++;
    }
  }

  return { group, remainingUnits: remaining };
}

function buildQueueGroups(units: Player[][], size: number, maxGroups: number): Player[][] {
  const groups: Player[][] = [];
  let remainingUnits = units;

  while (remainingUnits.length > 0 && groups.length < maxGroups) {
    const { group, remainingUnits: rest } = selectNextGroup(remainingUnits, size);
    if (group.length === 0) break;
    groups.push(group);
    remainingUnits = rest;
  }

  return groups;
}

// Splits a chosen group of 4 into Team A (left side) and Team B (right
// side), always keeping a paired duo together on the same side. Works by
// re-running buildUnits on just these 4 players — since partners are
// always assigned as a unit in the first place, this reliably recovers
// which 2 are a pair. Returns the group reordered as
// [teamA0, teamA1, teamB0, teamB1]; CourtCard slices this array in half
// to render each side.
function orderGroupIntoTeams(group: Player[]): Player[] {
  const units = buildUnits(group);
  const teamA: Player[] = [];
  const teamB: Player[] = [];

  for (const unit of units) {
    if (unit.length <= 2 - teamA.length) {
      teamA.push(...unit);
    } else {
      teamB.push(...unit);
    }
  }

  return [...teamA, ...teamB];
}

function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

let lastQueuePosition = 0;

function nextQueuePosition(): number {
  const now = Date.now();
  lastQueuePosition = now > lastQueuePosition ? now : lastQueuePosition + 1;
  return lastQueuePosition;
}

// A queue position that sorts ahead of every normal position (those are
// Date.now() timestamps). Used to put a player who was swapped OFF a court
// at the front of the line — they didn't get to play, so they're next.
function frontQueuePosition(): number {
  return Date.now() - 1e13;
}

function pairKey(idA: number, idB: number): string {
  return idA < idB ? `${idA}-${idB}` : `${idB}-${idA}`;
}

// Ranking order for the Leaderboard: players who have played come first,
// sorted by win percentage, then total wins, then name. Players with a
// 0-0 record sit at the bottom.
function compareByRecord(a: Player, b: Player): number {
  const totalA = a.wins + a.losses;
  const totalB = b.wins + b.losses;

  if ((totalA === 0) !== (totalB === 0)) return totalA === 0 ? 1 : -1;

  const pctA = totalA > 0 ? a.wins / totalA : 0;
  const pctB = totalB > 0 ? b.wins / totalB : 0;

  if (pctB !== pctA) return pctB - pctA;
  if (b.wins !== a.wins) return b.wins - a.wins;
  return a.name.localeCompare(b.name);
}

function unitGamesPlayed(unit: Player[]): number {
  return Math.max(...unit.map((p) => p.gamesPlayed));
}

const SKILL_LEVEL_ORDER: Record<SkillLevel, number> = {
  beginner: 0,
  intermediate: 1,
  advanced: 2,
};

// Tournament-style pair classification: a pair is always treated as
// whichever member has the HIGHER skill level — e.g. a Beginner paired
// with an Advanced player queues and matches as an Advanced pair, not a
// Beginner one. Mirrors how real doubles tournaments classify a team by
// its stronger player, and applies everywhere a pair's "level" matters:
// fairness tiering, group formation when a court opens up, and the court
// editor's replacement-eligibility list.
function higherSkillLevel(a: SkillLevel, b: SkillLevel): SkillLevel {
  return SKILL_LEVEL_ORDER[a] >= SKILL_LEVEL_ORDER[b] ? a : b;
}

// A unit's effective skill level for matching purposes: a solo player's
// own level, or — for a pair — the higher of the two partners' levels.
function unitSkillLevel(unit: Player[]): SkillLevel {
  if (unit.length === 1) return unit[0].skillLevel;
  return higherSkillLevel(unit[0].skillLevel, unit[1].skillLevel);
}

function selectFairnessTier(pool: Player[][]): Player[][] {
  const sorted = [...pool].sort((a, b) => unitGamesPlayed(a) - unitGamesPlayed(b));
  const tier: Player[][] = [];
  let total = 0;
  let currentValue: number | null = null;

  for (const unit of sorted) {
    const value = unitGamesPlayed(unit);
    if (currentValue === null) currentValue = value;

    if (value !== currentValue && total >= 4) break;

    tier.push(unit);
    total += unit.length;
    currentValue = value;
  }

  return tier;
}

// Beginners and Advanced can't be grouped together; Intermediate is
// compatible with everyone, including same-level. This is only checked
// when filling a group — the anchor player (see below) is always kept
// regardless of what it's compatible with.
function skillCompatible(a: SkillLevel, b: SkillLevel): boolean {
  if (a === 'intermediate' || b === 'intermediate') return true;
  return a === b;
}

function unitCompatibleWithGroup(unit: Player[], group: Player[]): boolean {
  return unit.every((u) => group.every((g) => skillCompatible(u.skillLevel, g.skillLevel)));
}

// Court editor rule: who may be brought in to replace someone on a court.
// The candidate must (1) still be waiting, (2) not be half of a waiting
// pair — pairs always move together, so a pair member can't be pulled in
// alone (unpair them in Manage Queue first), and (3) be skill-compatible
// with the three players who STAY on the court (Beginner and Advanced
// never mix; Intermediate fits anyone).
function isEligibleReplacement(candidate: Player, courtmates: Player[], waiting: Player[]): boolean {
  if (!waiting.some((p) => p.id === candidate.id)) return false;

  if (candidate.partnerId !== null && waiting.some((p) => p.id === candidate.partnerId)) return false;

  return unitCompatibleWithGroup([candidate], courtmates);
}

// Builds one candidate group that ALWAYS includes `anchor` — the
// highest-priority (fewest games played) unit in the tier — then fills
// the remaining slots from `otherUnits`, starting at `startOffset` for
// diversity across candidates. When allowIncompatible is false, a unit is
// only added if every one of its players is skill-compatible with
// everyone already in the group; this is what enforces
// Beginner-can't-mix-with-Advanced. Returns null if 4 players couldn't be
// assembled under the current constraints.
function buildGroupWithAnchor(
  anchor: Player[],
  otherUnits: Player[][],
  startOffset: number,
  allowIncompatible: boolean
): Player[] | null {
  const group: Player[] = [...anchor];
  const rotated = [...otherUnits.slice(startOffset), ...otherUnits.slice(0, startOffset)];

  for (const unit of rotated) {
    if (group.length >= 4) break;
    if (unit.length > 4 - group.length) continue;
    if (!allowIncompatible && !unitCompatibleWithGroup(unit, group)) continue;
    group.push(...unit);
  }

  return group.length === 4 ? group : null;
}

// Generates a handful of valid 4-player groupings for pairing-diversity
// scoring, with tierUnits[0] (the top fairness priority) mandatory in
// every single one — it can never be excluded just because a different
// combination happens to score better on repeat-pairing history. Tries
// skill-compatible fills first across a few starting offsets; only if
// NONE of those produce a full group of 4 does it retry allowing
// incompatible pairings (e.g. Beginner + Advanced), so nobody is left
// waiting indefinitely purely because their skill level is scarce.
function generateCandidateGroups(tierUnits: Player[][]): Player[][] {
  if (tierUnits.length === 0) return [];

  const anchor = tierUnits[0];
  const otherUnits = tierUnits.slice(1);
  const maxStarts = Math.max(Math.min(otherUnits.length, 5), 1);

  function collect(allowIncompatible: boolean): Player[][] {
    const candidates: Player[][] = [];
    const seen = new Set<string>();

    for (let start = 0; start < maxStarts; start++) {
      const group = buildGroupWithAnchor(anchor, otherUnits, start, allowIncompatible);
      if (!group) continue;

      const key = group.map((p) => p.id).sort((a, b) => a - b).join(',');
      if (seen.has(key)) continue;

      seen.add(key);
      candidates.push(group);
    }

    return candidates;
  }

  const compatible = collect(false);
  if (compatible.length > 0) return compatible;

  return collect(true);
}

function scoreGroup(group: Player[], groupHistory: Map<string, number>): number {
  let score = 0;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      score += groupHistory.get(pairKey(group[i].id, group[j].id)) ?? 0;
    }
  }
  return score;
}

function pickLowestScored(
  candidates: Player[][],
  groupHistory: Map<string, number>
): Player[] {
  const scored = candidates.map((group) => ({ group, score: scoreGroup(group, groupHistory) }));
  const lowestScore = Math.min(...scored.map((s) => s.score));
  const best = scored.filter((s) => s.score === lowestScore);
  return shuffleArray(best)[0].group;
}

// Chooses which 4 players get the next open court, guaranteeing a real
// fairness ordering across the ENTIRE waiting list (not just players near
// the front of the queue): selectFairnessTier sorts every waiting unit by
// games played and returns the lowest tier, expanding to include the next
// tier up only if the lowest one doesn't have 4 players yet. A player who
// has played fewer games than everyone else is therefore never skipped in
// favor of someone who's played more, no matter where they sit in the
// queue — that's what "fair" actually means in this mode.
//
// Within that fairness tier, we still try to fill the court from a single
// skill level first (checked against whichever level appears earliest in
// the tier), falling back to a mixed-level group only if the tier doesn't
// have 4 players of one level. A pair's "level" here is always its
// higher-rated partner (see unitSkillLevel).
function chooseFairGroup(players: Player[], groupHistory: Map<string, number>): Player[] | null {
  const units = buildUnits(players);

  const totalWaiting = units.reduce((sum, unit) => sum + unit.length, 0);
  if (totalWaiting < 4) return null;

  const tier = selectFairnessTier(units);

  const frontLevel = unitSkillLevel(tier[0]);

  if (frontLevel) {
    const sameLevelUnits = tier.filter((u) => unitSkillLevel(u) === frontLevel);
    const sameLevelTotal = sameLevelUnits.reduce((sum, u) => sum + u.length, 0);

    if (sameLevelTotal >= 4) {
      const candidates = generateCandidateGroups(sameLevelUnits);
      if (candidates.length > 0) {
        return pickLowestScored(candidates, groupHistory);
      }
    }
  }

  // Fallback: mix levels within the same fairness tier.
  const candidates = generateCandidateGroups(tier);
  if (candidates.length === 0) return null;

  return pickLowestScored(candidates, groupHistory);
}

function Dashboard({ session }: DashboardProps) {
  const navigate = useNavigate();

  const [players, setPlayers] = useState<Player[]>([]);
  const [allPlayers, setAllPlayers] = useState<Player[]>([]); // full roster (waiting + playing), for the leaderboards
  const [nameInput, setNameInput] = useState('');
  const [nameLevel, setNameLevel] = useState<SkillLevel>('beginner');

  const [courts, setCourts] = useState<Court[]>([]);

  const [tick, setTick] = useState(0);

  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchInput, setBatchInput] = useState('');
  const [batchLevel, setBatchLevel] = useState<SkillLevel>('beginner');

  const [showQueueSidebar, setShowQueueSidebar] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [pairingSourceId, setPairingSourceId] = useState<number | null>(null);

  // Games Played dropdown
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboardSearch, setLeaderboardSearch] = useState('');

  // Leaderboard (win-loss ranking) dropdown
  const [showWinLeaderboard, setShowWinLeaderboard] = useState(false);
  const [winLeaderboardSearch, setWinLeaderboardSearch] = useState('');

  // Court editor modal
  const [editingCourtId, setEditingCourtId] = useState<number | null>(null);
  const [editAction, setEditAction] = useState<{ type: 'replace' | 'swap'; slot: number } | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const [isSessionActive, setIsSessionActive] = useState(false);

  const [timeBased, setTimeBased] = useState(true);
  const [warmupMinutes, setWarmupMinutes] = useState(WARMUP_MINUTES);
  const [gameMinutes, setGameMinutes] = useState(GAME_LENGTH_MINUTES);
  const [overtimeMinutes, setOvertimeMinutes] = useState(OVERTIME_MINUTES);
  const [queueMode, setQueueMode] = useState<'fifo' | 'fair'>('fair');

  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const announcedAssignments = useRef<Set<string>>(new Set());
  const announcedOvertime = useRef<Set<string>>(new Set());
  const announcementCancelled = useRef(false);

  const isAssigning = useRef(false);
  const autoEndingCourts = useRef<Set<number>>(new Set());

  const playersRef = useRef<Player[]>(players);
  const courtsRef = useRef<Court[]>(courts);
  const pendingRerun = useRef(false);

  const groupHistoryRef = useRef<Map<string, number>>(new Map());

  const mutationLock = useRef<Promise<void>>(Promise.resolve());

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = mutationLock.current.then(fn, fn);
    mutationLock.current = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  useEffect(() => {
    const intervalId = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    primeSpeechOnFirstInteraction();
  }, []);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  useEffect(() => {
    courtsRef.current = courts;
  }, [courts]);

  // If the court being edited ends its game (or is removed) while the
  // editor is open, close the editor instead of leaving it stranded.
  useEffect(() => {
    if (editingCourtId === null) return;
    const court = courts.find((c) => c.id === editingCourtId);
    if (!court || court.players.length < 4) {
      setEditingCourtId(null);
      setEditAction(null);
    }
  }, [courts, editingCourtId]);

  async function loadData() {
    const userId = session.user.id;

    const { data: existingSession, error: sessionReadError } = await supabase
      .from('session_state')
      .select('*')
      .eq('owner_id', userId)
      .maybeSingle();

    if (sessionReadError) {
      console.error('SESSION READ ERROR:', sessionReadError);
    }

    // eslint-disable-next-line no-useless-assignment
    let sessionActive = false;
    let isNewAccount = false;

    if (existingSession) {
      sessionActive = existingSession.is_active;
    } else {
      const { data: created, error: createError } = await supabase
        .from('session_state')
        .insert({ owner_id: userId, is_active: false })
        .select()
        .single();

      if (createError) {
        console.error('SESSION CREATE ERROR:', createError);
      }

      sessionActive = created?.is_active ?? false;
      isNewAccount = true;
    }

    const { data: venueSettings, error: venueSettingsError } = await supabase
      .from('venue_settings')
      .select('time_based, warmup_minutes, game_minutes, overtime_minutes, queue_mode')
      .eq('owner_id', userId)
      .maybeSingle();

    if (venueSettingsError) console.error('Error loading venue settings:', venueSettingsError);

    setTimeBased(venueSettings?.time_based ?? true);
    setWarmupMinutes(venueSettings?.warmup_minutes ?? WARMUP_MINUTES);
    setGameMinutes(venueSettings?.game_minutes ?? GAME_LENGTH_MINUTES);
    setOvertimeMinutes(venueSettings?.overtime_minutes ?? OVERTIME_MINUTES);
    setQueueMode((venueSettings?.queue_mode as 'fifo' | 'fair') ?? 'fair');

    if (isNewAccount) {
      const { data: existingCourts } = await supabase
        .from('courts')
        .select('id')
        .eq('owner_id', userId);

      if (!existingCourts || existingCourts.length === 0) {
        const { error: createCourtsError } = await supabase.from('courts').insert([
          { owner_id: userId, name: 'Court 1', player_ids: [], start_time: null },
          { owner_id: userId, name: 'Court 2', player_ids: [], start_time: null },
        ]);
        if (createCourtsError) console.error('Error creating starter courts:', createCourtsError);
      }
    }

    const { data: dbPlayers, error: playersError } = await supabase
      .from('players')
      .select('*')
      .eq('owner_id', userId)
      .order('queue_position', { ascending: true })
      .order('id', { ascending: true });

    const { data: dbCourts, error: courtsError } = await supabase
      .from('courts')
      .select('*')
      .eq('owner_id', userId)
      .order('id', { ascending: true });

    const { data: dbGroupHistory, error: groupHistoryError } = await supabase
      .from('group_history')
      .select('*')
      .eq('owner_id', userId);

    if (playersError) console.error('Error loading players:', playersError);
    if (courtsError) console.error('Error loading courts:', courtsError);
    if (groupHistoryError) console.error('Error loading group history:', groupHistoryError);

    const allPlayersList: Player[] = (dbPlayers ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      partnerId: p.partner_id,
      gamesPlayed: p.games_played ?? 0,
      skillLevel: (p.skill_level as SkillLevel) ?? 'beginner',
      wins: p.wins ?? 0,
      losses: p.losses ?? 0,
    }));

    const playingIds = new Set(
      (dbCourts ?? []).flatMap((c) => c.player_ids ?? [])
    );
    const waitingPlayers = allPlayersList.filter((p) => !playingIds.has(p.id));

    const mappedCourts: Court[] = (dbCourts ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      players: (c.player_ids ?? [])
        .map((id: number) => allPlayersList.find((p) => p.id === id))
        .filter((p: Player | undefined): p is Player => p !== undefined),
      startTime: c.start_time ? new Date(c.start_time).getTime() : null,
    }));

    const historyMap = new Map<string, number>();
    (dbGroupHistory ?? []).forEach((row) => {
      historyMap.set(pairKey(row.player_a_id, row.player_b_id), row.count);
    });
    groupHistoryRef.current = historyMap;

    setPlayers(waitingPlayers);
    setAllPlayers(allPlayersList);
    setCourts(mappedCourts);
    setIsSessionActive(sessionActive);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const userId = session.user.id;

    let debounceTimer: ReturnType<typeof setTimeout>;

    function scheduleReload() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        runExclusive(loadData);
      }, 250);
    }

    const channel = supabase
      .channel('dashboard-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'courts', filter: `owner_id=eq.${userId}` },
        scheduleReload
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'players', filter: `owner_id=eq.${userId}` },
        scheduleReload
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'session_state', filter: `owner_id=eq.${userId}` },
        scheduleReload
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'venue_settings', filter: `owner_id=eq.${userId}` },
        scheduleReload
      )
      .subscribe();

    return () => {
      clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isSessionActive) return;
    triggerAssignOpenCourts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, courts, isSessionActive]);

  function triggerAssignOpenCourts() {
    if (isAssigning.current) {
      pendingRerun.current = true;
      return;
    }
    isAssigning.current = true;
    processNextAssignment();
  }

  async function processNextAssignment() {
    const assignment = await runExclusive(async () => {
      const openCourt = courtsRef.current.find((c) => c.players.length === 0);
      if (!openCourt) return null;

      const group =
        queueMode === 'fifo'
          ? (() => {
              const { group: fifoGroup } = selectNextGroup(buildUnits(playersRef.current), 4);
              return fifoGroup.length === 4 ? fifoGroup : null;
            })()
          : chooseFairGroup(playersRef.current, groupHistoryRef.current);
      if (!group) return null;

      // Reorder into [teamA0, teamA1, teamB0, teamB1] so partners always
      // share a side. This order is what gets stored in player_ids.
      const orderedGroup = orderGroupIntoTeams(group);

      const startTimeIso = new Date().toISOString();

      const { error } = await supabase
        .from('courts')
        .update({
          player_ids: orderedGroup.map((p) => p.id),
          start_time: startTimeIso,
        })
        .eq('id', openCourt.id);

      if (error) {
        console.error('Error assigning court:', error);
        return null;
      }

      const startTimeMs = new Date(startTimeIso).getTime();
      announcedAssignments.current.add(`${openCourt.id}-${startTimeMs}`);

      for (const player of orderedGroup) {
        const newGamesPlayed = player.gamesPlayed + 1;
        const { error: gamesPlayedError } = await supabase
          .from('players')
          .update({ games_played: newGamesPlayed })
          .eq('id', player.id);
        if (gamesPlayedError) console.error('Error updating games_played:', gamesPlayedError);
      }

      for (let i = 0; i < orderedGroup.length; i++) {
        for (let j = i + 1; j < orderedGroup.length; j++) {
          const idA = orderedGroup[i].id;
          const idB = orderedGroup[j].id;
          const key = pairKey(idA, idB);
          const newCount = (groupHistoryRef.current.get(key) ?? 0) + 1;
          const [playerAId, playerBId] = idA < idB ? [idA, idB] : [idB, idA];

          const { error: historyError } = await supabase.from('group_history').upsert(
            {
              owner_id: session.user.id,
              player_a_id: playerAId,
              player_b_id: playerBId,
              count: newCount,
            },
            { onConflict: 'owner_id,player_a_id,player_b_id' }
          );

          if (historyError) console.error('Error updating group_history:', historyError);

          groupHistoryRef.current.set(key, newCount);
        }
      }

      // From here on, use players with their INCREMENTED games_played. The
      // `group` array up to this point still holds the pre-game counts — if
      // those stale objects were stored on the court, then later returned to
      // the queue when the game ends, the count would silently reset to
      // "before this game" every time, which is exactly why games_played
      // appeared to stop counting after the first game.
      const incrementedGroup = orderedGroup.map((p) => ({ ...p, gamesPlayed: p.gamesPlayed + 1 }));

      const assignedIds = new Set(incrementedGroup.map((p) => p.id));
      const updatedPlayers = playersRef.current.filter((p) => !assignedIds.has(p.id));
      const updatedCourts = courtsRef.current.map((c) =>
        c.id === openCourt.id ? { ...c, players: incrementedGroup, startTime: startTimeMs } : c
      );

      const bumped = new Map(incrementedGroup.map((p) => [p.id, p.gamesPlayed]));

      playersRef.current = updatedPlayers;
      courtsRef.current = updatedCourts;
      setPlayers(updatedPlayers);
      setCourts(updatedCourts);
      setAllPlayers((prev) => prev.map((p) => (bumped.has(p.id) ? { ...p, gamesPlayed: bumped.get(p.id)! } : p)));

      return { court: openCourt, group: incrementedGroup };
    });

    if (assignment && voiceEnabled && isSpeechSupported()) {
      announcementCancelled.current = false;
      const names = assignment.group.map((p) => p.name).join(', ');
      const announcement = `${assignment.court.name}. ${names}.`;

      await speak(announcement);
      if (!announcementCancelled.current) {
        await new Promise((resolve) => setTimeout(resolve, FIRST_CALL_REPEAT_PAUSE_MS));
      }
      if (!announcementCancelled.current) {
        await speak(announcement);
      }
      if (!announcementCancelled.current) {
        await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_PAUSE_MS));
      }
    }

    if (assignment) {
      processNextAssignment();
      return;
    }

    isAssigning.current = false;

    if (pendingRerun.current) {
      pendingRerun.current = false;
      triggerAssignOpenCourts();
    }
  }

  useEffect(() => {
    if (!timeBased) return;

    const gameEndMs = (warmupMinutes + gameMinutes) * 60 * 1000;
    const totalMs = gameEndMs + overtimeMinutes * 60 * 1000;

    courts.forEach((court) => {
      if (court.startTime === null) return;
      const elapsedMs = Date.now() - court.startTime;
      const key = `${court.id}-${court.startTime}`;

      if (voiceEnabled && elapsedMs >= gameEndMs && elapsedMs < totalMs) {
        if (!announcedOvertime.current.has(key)) {
          announcedOvertime.current.add(key);
          speak(`${court.name}, overtime.`);
        }
      }

      if (elapsedMs < totalMs) return;
      if (autoEndingCourts.current.has(court.id)) return;

      autoEndingCourts.current.add(court.id);
      handleEndGame(court.id).finally(() => {
        autoEndingCourts.current.delete(court.id);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, courts, voiceEnabled, timeBased, warmupMinutes, gameMinutes, overtimeMinutes]);

  function handleAnnounceCourt(courtId: number) {
    const court = courts.find((c) => c.id === courtId);
    if (!court || court.players.length === 0) return;
    const names = court.players.map((p) => p.name).join(', ');
    speak(`${court.name}. ${names}.`);
  }

  async function handleAddPlayer() {
    if (nameInput.trim() === '') return;
    const userId = session.user.id;
    const name = nameInput;
    const level = nameLevel;
    setNameInput('');

    await runExclusive(async () => {
      const { data, error } = await supabase
        .from('players')
        .insert({
          name,
          queue_position: nextQueuePosition(),
          owner_id: userId,
          skill_level: level,
        })
        .select()
        .single();

      if (error) {
        console.error('Error adding player:', error);
        return;
      }

      const newPlayer: Player = {
        id: data.id,
        name: data.name,
        partnerId: data.partner_id,
        gamesPlayed: data.games_played ?? 0,
        skillLevel: (data.skill_level as SkillLevel) ?? 'beginner',
        wins: data.wins ?? 0,
        losses: data.losses ?? 0,
      };
      const updated = [...playersRef.current, newPlayer];
      playersRef.current = updated;
      setPlayers(updated);
      setAllPlayers((prev) => [...prev, newPlayer]);
    });
  }

  function handleNameInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      handleAddPlayer();
    }
  }

  async function handleAddBatchPlayers() {
    const userId = session.user.id;

    const names = batchInput
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');

    if (names.length === 0) return;

    const level = batchLevel;
    setBatchInput('');
    setShowBatchModal(false);

    await runExclusive(async () => {
      const rowsToInsert = names.map((name) => ({
        name,
        queue_position: nextQueuePosition(),
        owner_id: userId,
        skill_level: level,
      }));

      const { data, error } = await supabase
        .from('players')
        .insert(rowsToInsert)
        .select();

      if (error) {
        console.error('Error adding batch players:', error);
        return;
      }

      const newPlayers: Player[] = (data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        partnerId: p.partner_id,
        gamesPlayed: p.games_played ?? 0,
        skillLevel: (p.skill_level as SkillLevel) ?? 'beginner',
        wins: p.wins ?? 0,
        losses: p.losses ?? 0,
      }));

      const updated = [...playersRef.current, ...newPlayers];
      playersRef.current = updated;
      setPlayers(updated);
      setAllPlayers((prev) => [...prev, ...newPlayers]);
    });
  }

  async function handleRemovePlayer(id: number) {
    await runExclusive(async () => {
      const player = playersRef.current.find((p) => p.id === id);

      if (player?.partnerId !== null && player?.partnerId !== undefined) {
        const { error: unpairError } = await supabase
          .from('players')
          .update({ partner_id: null })
          .eq('id', player.partnerId);
        if (unpairError) console.error('Error clearing partner link:', unpairError);
      }

      const { error } = await supabase.from('players').delete().eq('id', id);

      if (error) {
        console.error('Error removing player:', error);
        return;
      }

      const updated = playersRef.current
        .filter((p) => p.id !== id)
        .map((p) => (p.id === player?.partnerId ? { ...p, partnerId: null } : p));

      playersRef.current = updated;
      setPlayers(updated);
      setAllPlayers((prev) => prev.filter((p) => p.id !== id));
    });
  }

  async function handleSkipPlayer(id: number) {
    await runExclusive(async () => {
      const player = playersRef.current.find((p) => p.id === id);
      if (!player) return;

      const idsToSkip = player.partnerId !== null ? [id, player.partnerId] : [id];

      for (const skipId of idsToSkip) {
        const { error } = await supabase
          .from('players')
          .update({ queue_position: nextQueuePosition() })
          .eq('id', skipId);
        if (error) console.error('Error skipping player:', error);
      }

      const skipped = playersRef.current.filter((p) => idsToSkip.includes(p.id));
      const remaining = playersRef.current.filter((p) => !idsToSkip.includes(p.id));
      const updated = [...remaining, ...skipped];

      playersRef.current = updated;
      setPlayers(updated);
    });
  }

  async function handleShuffleQueue() {
    await runExclusive(async () => {
      if (playersRef.current.length === 0) return;

      const units = buildUnits(playersRef.current);
      const shuffledUnits = shuffleArray(units);

      const newOrder: Player[] = [];
      const updates: { id: number; queue_position: number }[] = [];

      shuffledUnits.forEach((unit) => {
        unit.forEach((player) => {
          newOrder.push(player);
          updates.push({ id: player.id, queue_position: nextQueuePosition() });
        });
      });

      for (const update of updates) {
        const { error } = await supabase
          .from('players')
          .update({ queue_position: update.queue_position })
          .eq('id', update.id);

        if (error) {
          console.error('Error shuffling queue:', error);
          return;
        }
      }

      playersRef.current = newOrder;
      setPlayers(newOrder);
    });
  }

  // Clears a court and returns its 4 players to the queue — backfilling
  // any short trailing stack first, same as before. Factored out as its
  // own plain async function (not wrapped in runExclusive itself) so both
  // handleEndGame and handleRecordWin can call it after doing their own
  // work, inside a single shared runExclusive call each — calling
  // runExclusive from inside another runExclusive call would deadlock,
  // since it just chains onto the same lock.
  async function performCourtClear(courtId: number) {
    const court = courtsRef.current.find((c) => c.id === courtId);
    if (!court) return;

    const { error: courtError } = await supabase
      .from('courts')
      .update({ player_ids: [], start_time: null })
      .eq('id', courtId);

    if (courtError) console.error('Error clearing court:', courtError);

    const waitingUnits = buildUnits(playersRef.current);
    const waitingStacks = buildQueueGroups(waitingUnits, 4, MAX_QUEUE_STACKS);
    const lastStack = waitingStacks[waitingStacks.length - 1];
    const vacancies = lastStack ? 4 - lastStack.length : 0;

    let backfill: Player[] = [];
    let leftover: Player[] = court.players;

    if (vacancies > 0 && court.players.length > 0) {
      const shuffled = shuffleArray(court.players);
      const count = Math.min(vacancies, shuffled.length);
      backfill = shuffled.slice(0, count);
      leftover = shuffled.slice(count);
    }

    const orderedRequeue = [...backfill, ...leftover];
    for (const player of orderedRequeue) {
      const { error: requeueError } = await supabase
        .from('players')
        .update({ queue_position: nextQueuePosition() })
        .eq('id', player.id);

      if (requeueError) console.error('Error requeuing player:', requeueError);
    }

    const updatedPlayers = [...playersRef.current, ...backfill, ...leftover];
    const updatedCourts = courtsRef.current.map((c) =>
      c.id === courtId ? { ...c, players: [], startTime: null } : c
    );

    playersRef.current = updatedPlayers;
    courtsRef.current = updatedCourts;
    setPlayers(updatedPlayers);
    setCourts(updatedCourts);
  }

  // Ends a game with no score recorded — same clearing/backfill behavior
  // as always, just no win/loss bookkeeping attached.
  async function handleEndGame(courtId: number) {
    stopSpeaking();
    announcementCancelled.current = true;
    await runExclusive(() => performCourtClear(courtId));
  }

  // Records which side won: logs the match, credits a win to both winning
  // players and a loss to both losing players, then clears/requeues the
  // court exactly like handleEndGame.
  async function handleRecordWin(courtId: number, winningSide: 'a' | 'b') {
    stopSpeaking();
    announcementCancelled.current = true;

    await runExclusive(async () => {
      const court = courtsRef.current.find((c) => c.id === courtId);
      if (!court || court.players.length < 4) return;

      const teamA = court.players.slice(0, 2);
      const teamB = court.players.slice(2, 4);
      const winners = winningSide === 'a' ? teamA : teamB;
      const losers = winningSide === 'a' ? teamB : teamA;

      const { error: matchError } = await supabase.from('matches').insert({
        owner_id: session.user.id,
        court_id: courtId,
        court_name: court.name,
        team_a_names: teamA.map((p) => p.name),
        team_b_names: teamB.map((p) => p.name),
        winner_team: winningSide,
      });
      if (matchError) console.error('Error recording match:', matchError);

      for (const player of winners) {
        const { error: winError } = await supabase
          .from('players')
          .update({ wins: player.wins + 1 })
          .eq('id', player.id);
        if (winError) console.error('Error updating wins:', winError);
      }

      for (const player of losers) {
        const { error: lossError } = await supabase
          .from('players')
          .update({ losses: player.losses + 1 })
          .eq('id', player.id);
        if (lossError) console.error('Error updating losses:', lossError);
      }

      const winnerIds = new Set(winners.map((p) => p.id));
      const loserIds = new Set(losers.map((p) => p.id));

      const applyResult = (p: Player): Player => {
        if (winnerIds.has(p.id)) return { ...p, wins: p.wins + 1 };
        if (loserIds.has(p.id)) return { ...p, losses: p.losses + 1 };
        return p;
      };

      courtsRef.current = courtsRef.current.map((c) =>
        c.id === courtId ? { ...c, players: c.players.map(applyResult) } : c
      );
      setAllPlayers((prev) => prev.map(applyResult));

      await performCourtClear(courtId);
    });
  }

  // ---------- Court editor ----------

  function openCourtEditor(courtId: number) {
    setEditingCourtId(courtId);
    setEditAction(null);
  }

  function closeCourtEditor() {
    setEditingCourtId(null);
    setEditAction(null);
  }

  // Adds `delta` to the "played together" count for one pair of players,
  // in both the DB and the local cache (never below zero). Used so pairing
  // history only reflects who actually shared a court.
  async function adjustPairCount(idA: number, idB: number, delta: number) {
    const key = pairKey(idA, idB);
    const newCount = Math.max(0, (groupHistoryRef.current.get(key) ?? 0) + delta);
    const [playerAId, playerBId] = idA < idB ? [idA, idB] : [idB, idA];

    const { error } = await supabase.from('group_history').upsert(
      {
        owner_id: session.user.id,
        player_a_id: playerAId,
        player_b_id: playerBId,
        count: newCount,
      },
      { onConflict: 'owner_id,player_a_id,player_b_id' }
    );

    if (error) console.error('Error adjusting group_history:', error);

    groupHistoryRef.current.set(key, newCount);
  }

  // Replaces one player on a live court with an eligible waiting player.
  // Games-played follows who actually played: the incoming player is
  // credited a game, and the outgoing player loses the game that was
  // counted when the court started (they go to the FRONT of the queue).
  // The game timer and start time are untouched.
  async function handleReplaceCourtPlayer(courtId: number, slotIndex: number, incomingId: number) {
    if (editBusy) return;
    setEditBusy(true);

    try {
      await runExclusive(async () => {
        const court = courtsRef.current.find((c) => c.id === courtId);
        if (!court || court.players.length < 4) return;

        const outgoing = court.players[slotIndex];
        const incoming = playersRef.current.find((p) => p.id === incomingId);
        if (!outgoing || !incoming) return;

        const courtmates = court.players.filter((_, i) => i !== slotIndex);

        // Re-check eligibility against the latest state — the queue may
        // have changed since the editor list was drawn.
        if (!isEligibleReplacement(incoming, courtmates, playersRef.current)) return;

        const newIds = court.players.map((p, i) => (i === slotIndex ? incoming.id : p.id));

        const { error: courtError } = await supabase
          .from('courts')
          .update({ player_ids: newIds })
          .eq('id', courtId);

        if (courtError) {
          console.error('Error replacing court player:', courtError);
          return;
        }

        const outgoingGames = Math.max(0, outgoing.gamesPlayed - 1);
        const incomingGames = incoming.gamesPlayed + 1;

        const { error: outError } = await supabase
          .from('players')
          .update({ games_played: outgoingGames, queue_position: frontQueuePosition() })
          .eq('id', outgoing.id);
        if (outError) console.error('Error updating replaced player:', outError);

        const { error: inError } = await supabase
          .from('players')
          .update({ games_played: incomingGames })
          .eq('id', incoming.id);
        if (inError) console.error('Error updating incoming player:', inError);

        // Pairing history: the replaced player never actually shared this
        // court with the other three, and the new player now does.
        for (const mate of courtmates) {
          await adjustPairCount(outgoing.id, mate.id, -1);
          await adjustPairCount(incoming.id, mate.id, 1);
        }

        const outgoingBack: Player = { ...outgoing, gamesPlayed: outgoingGames };
        const incomingOnCourt: Player = { ...incoming, gamesPlayed: incomingGames };

        const updatedPlayers = [outgoingBack, ...playersRef.current.filter((p) => p.id !== incoming.id)];
        const updatedCourts = courtsRef.current.map((c) =>
          c.id === courtId
            ? { ...c, players: c.players.map((p, i) => (i === slotIndex ? incomingOnCourt : p)) }
            : c
        );

        playersRef.current = updatedPlayers;
        courtsRef.current = updatedCourts;
        setPlayers(updatedPlayers);
        setCourts(updatedCourts);
        setAllPlayers((prev) =>
          prev.map((p) => {
            if (p.id === outgoing.id) return { ...p, gamesPlayed: outgoingGames };
            if (p.id === incoming.id) return { ...p, gamesPlayed: incomingGames };
            return p;
          })
        );
      });
    } finally {
      setEditBusy(false);
      setEditAction(null);
    }
  }

  // Swaps two positions on a live court. Positions 0-1 are Team A (left)
  // and 2-3 are Team B (right), so swapping across teams is how you change
  // who partners with whom. No one enters or leaves, so counts and pairing
  // history stay exactly as they are.
  async function handleSwapCourtPlayers(courtId: number, indexA: number, indexB: number) {
    if (indexA === indexB || editBusy) return;
    setEditBusy(true);

    try {
      await runExclusive(async () => {
        const court = courtsRef.current.find((c) => c.id === courtId);
        if (!court || court.players.length < 4) return;

        const reordered = [...court.players];
        [reordered[indexA], reordered[indexB]] = [reordered[indexB], reordered[indexA]];

        const { error } = await supabase
          .from('courts')
          .update({ player_ids: reordered.map((p) => p.id) })
          .eq('id', courtId);

        if (error) {
          console.error('Error swapping court players:', error);
          return;
        }

        const updatedCourts = courtsRef.current.map((c) =>
          c.id === courtId ? { ...c, players: reordered } : c
        );

        courtsRef.current = updatedCourts;
        setCourts(updatedCourts);
      });
    } finally {
      setEditBusy(false);
      setEditAction(null);
    }
  }

  async function handleResetSession() {
    const userId = session.user.id;

    const confirmed = window.confirm(
      'Reset the entire session? This will remove all players, clear all courts, and delete the match history.'
    );
    if (!confirmed) return;

    await runExclusive(async () => {
      const { error: deletePlayersError } = await supabase
        .from('players')
        .delete()
        .eq('owner_id', userId);

      const { error: resetCourtsError } = await supabase
        .from('courts')
        .update({ player_ids: [], start_time: null })
        .eq('owner_id', userId);

      const { error: resetSessionError } = await supabase
        .from('session_state')
        .update({ is_active: false })
        .eq('owner_id', userId);

      const { error: resetHistoryError } = await supabase
        .from('group_history')
        .delete()
        .eq('owner_id', userId);

      const { error: resetMatchesError } = await supabase
        .from('matches')
        .delete()
        .eq('owner_id', userId);

      if (deletePlayersError) console.error('Error clearing players:', deletePlayersError);
      if (resetCourtsError) console.error('Error resetting courts:', resetCourtsError);
      if (resetSessionError) console.error('Error resetting session state:', resetSessionError);
      if (resetHistoryError) console.error('Error clearing group history:', resetHistoryError);
      if (resetMatchesError) console.error('Error clearing matches:', resetMatchesError);

      await loadData();
    });
  }

  async function handleToggleSession() {
    const userId = session.user.id;
    const newValue = !isSessionActive;

    // Update local state immediately rather than waiting for the realtime
    // event to round-trip back — on a slower production connection that
    // round trip can lag noticeably, which is what made Start Session
    // look like it needed a manual refresh to actually take effect.
    setIsSessionActive(newValue);

    const { error } = await supabase
      .from('session_state')
      .update({ is_active: newValue })
      .eq('owner_id', userId);

    if (error) {
      console.error('Error updating session state:', error);
      setIsSessionActive(!newValue); // revert on failure
      return;
    }
  }

  async function handlePairPlayers(idA: number, idB: number) {
    if (idA === idB) return;

    await runExclusive(async () => {
      const { error: errA } = await supabase.from('players').update({ partner_id: idB }).eq('id', idA);
      const { error: errB } = await supabase.from('players').update({ partner_id: idA }).eq('id', idB);

      if (errA || errB) {
        console.error('Error pairing players:', errA || errB);
        return;
      }

      const updated = playersRef.current.map((p) => {
        if (p.id === idA) return { ...p, partnerId: idB };
        if (p.id === idB) return { ...p, partnerId: idA };
        return p;
      });

      playersRef.current = updated;
      setPlayers(updated);
      setPairingSourceId(null);
    });
  }

  async function handleUnpairPlayer(id: number) {
    await runExclusive(async () => {
      const player = playersRef.current.find((p) => p.id === id);
      if (!player || player.partnerId === null) return;

      const partnerId = player.partnerId;

      const { error: errA } = await supabase.from('players').update({ partner_id: null }).eq('id', id);
      const { error: errB } = await supabase.from('players').update({ partner_id: null }).eq('id', partnerId);

      if (errA || errB) {
        console.error('Error unpairing players:', errA || errB);
        return;
      }

      const updated = playersRef.current.map((p) =>
        p.id === id || p.id === partnerId ? { ...p, partnerId: null } : p
      );

      playersRef.current = updated;
      setPlayers(updated);
    });
  }

  async function handleChangeSkillLevel(id: number, level: SkillLevel) {
    const { error } = await supabase.from('players').update({ skill_level: level }).eq('id', id);

    if (error) {
      console.error('Error updating skill level:', error);
      return;
    }

    const applyLevel = (p: Player) => (p.id === id ? { ...p, skillLevel: level } : p);
    playersRef.current = playersRef.current.map(applyLevel);
    setPlayers((prev) => prev.map(applyLevel));
    setAllPlayers((prev) => prev.map(applyLevel));
  }

  const units = buildUnits(players);
  const queueStacks = buildQueueGroups(units, 4, MAX_QUEUE_STACKS);
  const courtsInPlay = courts.filter((c) => c.players.length > 0).length;

  const filteredUnits = units.filter((unit) =>
    unit.some((p) => p.name.toLowerCase().includes(searchTerm.trim().toLowerCase()))
  );

  const leaderboardResults = [...allPlayers]
    .filter((p) => p.name.toLowerCase().includes(leaderboardSearch.trim().toLowerCase()))
    .sort((a, b) => b.gamesPlayed - a.gamesPlayed);

  // Rank is computed against the whole roster first, so a player keeps
  // their true rank number even while the search box is filtering the list.
  const winLeaderboardResults = [...allPlayers]
    .sort(compareByRecord)
    .map((player, index) => ({ player, rank: index + 1 }))
    .filter(({ player }) =>
      player.name.toLowerCase().includes(winLeaderboardSearch.trim().toLowerCase())
    );

  // Court editor derived values. The editor only opens for a court with a
  // full group of 4 on it.
  const foundEditingCourt = editingCourtId !== null ? courts.find((c) => c.id === editingCourtId) : undefined;
  const editingCourt = foundEditingCourt && foundEditingCourt.players.length === 4 ? foundEditingCourt : null;

  const replaceSlot = editAction?.type === 'replace' ? editAction.slot : null;
  const swapSlot = editAction?.type === 'swap' ? editAction.slot : null;

  const replacedPlayer =
    editingCourt && replaceSlot !== null ? editingCourt.players[replaceSlot] : undefined;

  // Only eligible waiting players, fewest games played first so organizers
  // can see at a glance who is owed a game.
  const replaceCandidates: Player[] =
    editingCourt && replaceSlot !== null
      ? players
          .filter((p) =>
            isEligibleReplacement(
              p,
              editingCourt.players.filter((_, i) => i !== replaceSlot),
              players
            )
          )
          .sort((a, b) => a.gamesPlayed - b.gamesPlayed)
      : [];

  const minCandidateGames = replaceCandidates.length > 0 ? replaceCandidates[0].gamesPlayed : 0;
  const hiddenCandidateCount = players.length - replaceCandidates.length;

  return (
    <div className="relative min-h-screen bg-linear-to-b from-slate-100 via-emerald-50 to-teal-100 overflow-hidden">
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-dot-grid opacity-60" />
        <div className="animate-blob absolute -top-24 -left-24 w-[28rem] h-[28rem] bg-green-400 rounded-full blur-3xl opacity-50" />
        <div className="animate-blob-delayed absolute top-1/4 -right-24 w-[28rem] h-[28rem] bg-emerald-500 rounded-full blur-3xl opacity-40" />
        <div className="animate-blob absolute -bottom-24 left-1/3 w-[28rem] h-[28rem] bg-teal-400 rounded-full blur-3xl opacity-40" />
        <div className="animate-blob-delayed absolute bottom-1/4 right-1/4 w-80 h-80 bg-lime-300 rounded-full blur-3xl opacity-30" />
      </div>

      <header className="bg-linear-to-r from-green-600 to-emerald-600 shadow-lg">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 shrink-0 bg-white/20 backdrop-blur rounded-xl flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" />
                  <path strokeLinecap="round" d="M8 12h8M12 8v8" />
                </svg>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight truncate">RallyQ</h1>
                  <span
                    className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      isSessionActive ? 'bg-white/25 text-white' : 'bg-black/20 text-white/80'
                    }`}
                  >
                    {isSessionActive ? '● LIVE' : 'PAUSED'}
                  </span>
                </div>
                <p className="text-green-100 text-xs font-medium hidden sm:block">Digital paddle board & queue</p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {isSpeechSupported() && (
                <button
                  onClick={() => setVoiceEnabled((v) => !v)}
                  title={voiceEnabled ? 'Mute announcements' : 'Unmute announcements'}
                  className="w-11 h-11 flex items-center justify-center text-lg bg-white/15 hover:bg-white/25 text-white rounded-lg border border-white/30 transition-colors"
                >
                  {voiceEnabled ? '🔊' : '🔇'}
                </button>
              )}
              <button
                onClick={() => navigate('/admin')}
                title="Settings"
                className="w-11 h-11 flex items-center justify-center text-lg bg-white/15 hover:bg-white/25 text-white rounded-lg border border-white/30 transition-colors"
              >
                ⚙
              </button>
              <button
                onClick={() => supabase.auth.signOut()}
                title="Log Out"
                className="w-11 h-11 flex items-center justify-center text-lg bg-white/15 hover:bg-white/25 text-white rounded-lg border border-white/30 transition-colors"
              >
                🚪
              </button>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={handleNameInputKeyDown}
                placeholder="Player name"
                className="bg-white/95 border-0 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-white w-full sm:w-36"
              />
              <select
                value={nameLevel}
                onChange={(e) => setNameLevel(e.target.value as SkillLevel)}
                className="bg-white/95 border-0 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-white"
              >
                {SKILL_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level.charAt(0).toUpperCase() + level.slice(1)}
                  </option>
                ))}
              </select>
              <button
                onClick={handleAddPlayer}
                className="whitespace-nowrap bg-white text-green-700 hover:bg-green-50 font-semibold text-sm px-4 py-2 rounded-lg transition-colors shadow-sm"
              >
                Add Player
              </button>
              <button
                onClick={() => setShowBatchModal(true)}
                className="whitespace-nowrap bg-white/15 hover:bg-white/25 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                + Multiple
              </button>
              <button
                onClick={handleShuffleQueue}
                disabled={players.length === 0}
                className="whitespace-nowrap bg-white/15 hover:bg-white/25 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                🔀 Shuffle
              </button>
              <button
                onClick={() => setShowQueueSidebar(true)}
                className="relative whitespace-nowrap bg-white/15 hover:bg-white/25 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                Manage Queue
                {players.length > 0 && (
                  <span className="absolute -top-2 -right-2 bg-white text-green-700 text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                    {players.length}
                  </span>
                )}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleToggleSession}
                className={`whitespace-nowrap font-semibold text-sm px-4 py-2 rounded-lg border transition-colors ${
                  isSessionActive
                    ? 'bg-white/15 hover:bg-yellow-500/80 text-white border-white/30'
                    : 'bg-white text-green-700 hover:bg-green-50 border-white'
                }`}
              >
                {isSessionActive ? 'Pause Session' : 'Start Session'}
              </button>
              <button
                onClick={handleResetSession}
                className="whitespace-nowrap bg-white/15 hover:bg-red-500/80 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {!isSessionActive && (
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm font-medium rounded-lg px-4 py-3 mb-6 flex items-center gap-2">
            <span>⏸</span>
            <span>
              Session is paused — players can be added and managed, but courts won't auto-fill until you click "Start Session."
            </span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-6">
          <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-3 sm:p-4 text-center">
            <p className="text-2xl sm:text-3xl font-extrabold text-gray-800">{courtsInPlay}/{courts.length}</p>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mt-1">Courts in Play</p>
          </div>
          <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-3 sm:p-4 text-center">
            <p className="text-2xl sm:text-3xl font-extrabold text-gray-800">{players.length}</p>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mt-1">In Queue</p>
          </div>
          <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-3 sm:p-4 text-center">
            <p className="text-2xl sm:text-3xl font-extrabold text-gray-800">
              {timeBased ? `${gameMinutes}m` : 'Manual'}
            </p>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mt-1">
              {timeBased ? 'Game Timer' : 'Game Mode'}
            </p>
          </div>
        </div>

        {/* Courts — full width, nothing beside them */}
        <div>
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">Courts</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
            {courts.map((court) => (
              <CourtCard
                key={court.id}
                court={court}
                gameLengthMinutes={gameMinutes}
                warmupMinutes={warmupMinutes}
                overtimeMinutes={overtimeMinutes}
                timeBased={timeBased}
                onEndGame={handleEndGame}
                onAnnounce={handleAnnounceCourt}
                onRecordWin={handleRecordWin}
                onEdit={openCourtEditor}
              />
            ))}
          </div>
        </div>

        {queueMode === 'fifo' && queueStacks.length > 0 && (
          <div className="mt-8">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">
              Upcoming Stacks
            </h2>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {queueStacks.map((stack, stackIndex) => (
                <div
                  key={stackIndex}
                  className={`shrink-0 w-56 rounded-xl shadow-sm p-4 ${
                    stackIndex === 0
                      ? 'bg-linear-to-br from-green-500 to-emerald-600 text-white'
                      : 'bg-white/90 backdrop-blur text-gray-800'
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span
                      className={`text-xs font-bold uppercase tracking-wide ${
                        stackIndex === 0 ? 'text-green-100' : 'text-gray-400'
                      }`}
                    >
                      Stack {stackIndex + 1}
                    </span>
                    {stackIndex === 0 && (
                      <span className="text-[10px] font-bold bg-white/25 px-2 py-0.5 rounded-full">
                        NEXT
                      </span>
                    )}
                  </div>
                  <ul className="space-y-1.5">
                    {stack.map((player, i) => (
                      <li
                        key={player.id}
                        className={`text-sm font-medium truncate rounded-md px-2 py-1 flex items-center gap-1.5 ${
                          stackIndex === 0 ? 'bg-white/15' : 'bg-gray-50'
                        }`}
                      >
                        <span>{i + 1}. {player.name}</span>
                        {player.partnerId !== null && <span className="text-xs">🔗</span>}
                        <span className="ml-auto flex items-center gap-1">
                          {stackIndex !== 0 && <SkillBadge level={player.skillLevel} />}
                        </span>
                      </li>
                    ))}
                    {Array.from({ length: 4 - stack.length }).map((_, i) => (
                      <li
                        key={`empty-${i}`}
                        className={`text-sm rounded-md px-2 py-1 ${
                          stackIndex === 0 ? 'text-green-200/60' : 'text-gray-300'
                        }`}
                      >
                        —
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Two dropdowns: Games Played + Leaderboard */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8 items-start">
          {/* Games Played */}
          <div>
            <button
              onClick={() => setShowLeaderboard((v) => !v)}
              className="w-full flex items-center justify-between text-sm font-bold text-gray-500 uppercase tracking-wide mb-3"
            >
              <span>📊 Games Played</span>
              <svg
                className={`w-4 h-4 transition-transform ${showLeaderboard ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showLeaderboard && (
              <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-4">
                <div className="relative mb-3">
                  <svg
                    className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path strokeLinecap="round" d="M21 21l-4.3-4.3" />
                  </svg>
                  <input
                    type="text"
                    value={leaderboardSearch}
                    onChange={(e) => setLeaderboardSearch(e.target.value)}
                    placeholder="Search players..."
                    className="w-full border border-gray-200 rounded-full pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>

                {leaderboardResults.length === 0 ? (
                  <p className="text-gray-300 text-sm">
                    {allPlayers.length === 0 ? 'No players yet' : 'No matches'}
                  </p>
                ) : (
                  <ul className="space-y-2 max-h-64 overflow-y-auto">
                    {leaderboardResults.map((player) => (
                      <li
                        key={player.id}
                        className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <SkillBadge level={player.skillLevel} />
                          <span className="text-sm font-medium text-gray-800 truncate">{player.name}</span>
                        </div>
                        <span className="text-sm font-bold text-green-600 shrink-0">{player.gamesPlayed}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Leaderboard — win-loss ranking */}
          <div>
            <button
              onClick={() => setShowWinLeaderboard((v) => !v)}
              className="w-full flex items-center justify-between text-sm font-bold text-gray-500 uppercase tracking-wide mb-3"
            >
              <span>🏆 Leaderboard</span>
              <svg
                className={`w-4 h-4 transition-transform ${showWinLeaderboard ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showWinLeaderboard && (
              <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-4">
                <div className="relative mb-3">
                  <svg
                    className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path strokeLinecap="round" d="M21 21l-4.3-4.3" />
                  </svg>
                  <input
                    type="text"
                    value={winLeaderboardSearch}
                    onChange={(e) => setWinLeaderboardSearch(e.target.value)}
                    placeholder="Search players..."
                    className="w-full border border-gray-200 rounded-full pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>

                {winLeaderboardResults.length === 0 ? (
                  <p className="text-gray-300 text-sm">
                    {allPlayers.length === 0 ? 'No players yet' : 'No matches'}
                  </p>
                ) : (
                  <ul className="space-y-2 max-h-64 overflow-y-auto">
                    {winLeaderboardResults.map(({ player, rank }) => {
                      const total = player.wins + player.losses;
                      const pct = total > 0 ? Math.round((player.wins / total) * 100) : null;

                      return (
                        <li
                          key={player.id}
                          className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-bold text-gray-400 w-5 shrink-0">{rank}</span>
                            <SkillBadge level={player.skillLevel} />
                            <span className="text-sm font-medium text-gray-800 truncate">{player.name}</span>
                          </div>
                          <div className="flex items-baseline gap-2 shrink-0">
                            <span className="text-sm font-bold text-green-600 tabular-nums">
                              {player.wins}-{player.losses}
                            </span>
                            <span className="text-xs text-gray-400 tabular-nums w-9 text-right">
                              {pct === null ? '—' : `${pct}%`}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Court editor modal */}
      {editingCourt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeCourtEditor} />

          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto animate-modal-in">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-gray-800 truncate">Edit {editingCourt.name}</h2>
                <p className="text-xs text-gray-400">The game timer keeps running while you make changes.</p>
              </div>
              <button
                onClick={closeCourtEditor}
                className="text-gray-400 hover:text-gray-600 w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors shrink-0"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-5 space-y-4">
              {swapSlot !== null ? (
                <p className="text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
                  Choose who to swap {editingCourt.players[swapSlot]?.name} with. Swapping across teams changes who
                  partners with whom.
                </p>
              ) : replaceSlot === null ? (
                <p className="text-xs text-gray-500">
                  <span className="font-semibold text-gray-700">Replace</span> brings in a waiting player.{' '}
                  <span className="font-semibold text-gray-700">Swap</span> changes positions — move players across
                  teams to change partnerships. Game counts are shown for each player.
                </p>
              ) : null}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { label: 'Team A · left side', slots: [0, 1] },
                  { label: 'Team B · right side', slots: [2, 3] },
                ].map((team) => (
                  <div key={team.label}>
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">{team.label}</h3>
                    <ul className="space-y-2">
                      {team.slots.map((slot) => {
                        const player = editingCourt.players[slot];
                        const isSource = replaceSlot === slot || swapSlot === slot;

                        return (
                          <li
                            key={player.id}
                            className={`rounded-lg border px-3 py-2 transition-colors ${
                              replaceSlot === slot
                                ? 'border-green-500 bg-green-50'
                                : swapSlot === slot
                                ? 'border-purple-400 bg-purple-50'
                                : 'border-gray-200 bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <SkillBadge level={player.skillLevel} />
                                <span className="text-sm font-semibold text-gray-800 truncate">{player.name}</span>
                              </div>
                              <span className="shrink-0 text-xs font-semibold text-gray-500 bg-white border border-gray-200 rounded-full px-2 py-0.5">
                                {player.gamesPlayed} {player.gamesPlayed === 1 ? 'game' : 'games'}
                              </span>
                            </div>

                            <div className="flex gap-1.5 mt-2">
                              {swapSlot !== null && swapSlot !== slot ? (
                                <button
                                  disabled={editBusy}
                                  onClick={() => handleSwapCourtPlayers(editingCourt.id, swapSlot, slot)}
                                  className="flex-1 text-xs font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-2.5 py-1.5 rounded-md transition-colors"
                                >
                                  Swap here
                                </button>
                              ) : isSource ? (
                                <button
                                  onClick={() => setEditAction(null)}
                                  className="flex-1 text-xs font-semibold bg-gray-200 hover:bg-gray-300 text-gray-700 px-2.5 py-1.5 rounded-md transition-colors"
                                >
                                  Cancel
                                </button>
                              ) : (
                                <>
                                  <button
                                    disabled={editBusy}
                                    onClick={() => setEditAction({ type: 'replace', slot })}
                                    className="flex-1 text-xs font-semibold bg-green-100 hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed text-green-700 px-2.5 py-1.5 rounded-md transition-colors"
                                  >
                                    Replace
                                  </button>
                                  <button
                                    disabled={editBusy}
                                    onClick={() => setEditAction({ type: 'swap', slot })}
                                    className="flex-1 text-xs font-semibold bg-purple-100 hover:bg-purple-200 disabled:opacity-50 disabled:cursor-not-allowed text-purple-700 px-2.5 py-1.5 rounded-md transition-colors"
                                  >
                                    Swap
                                  </button>
                                </>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>

              {replaceSlot !== null && replacedPlayer && (
                <div className="rounded-xl border border-green-200 bg-green-50/60 p-4">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-sm font-bold text-gray-800">Replace {replacedPlayer.name} with…</h3>
                    <button
                      onClick={() => setEditAction(null)}
                      className="text-xs font-semibold text-green-700 hover:text-green-900"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    The new player is credited 1 game. {replacedPlayer.name} loses the game counted for this court and
                    goes to the front of the queue.
                  </p>

                  {replaceCandidates.length === 0 ? (
                    <p className="text-sm text-gray-500 bg-white rounded-lg px-3 py-3 border border-gray-100">
                      No eligible players right now. Only unpaired waiting players who are skill-compatible with the
                      other three on this court can be brought in.
                    </p>
                  ) : (
                    <ul className="space-y-2 max-h-60 overflow-y-auto">
                      {replaceCandidates.map((candidate) => (
                        <li
                          key={candidate.id}
                          className="flex items-center justify-between gap-2 bg-white rounded-lg px-3 py-2 border border-gray-100"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="text-xs font-bold text-gray-400 w-7 shrink-0"
                              title="Position in the waiting queue"
                            >
                              #{players.findIndex((p) => p.id === candidate.id) + 1}
                            </span>
                            <SkillBadge level={candidate.skillLevel} />
                            <span className="text-sm font-medium text-gray-800 truncate">{candidate.name}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`text-xs font-bold tabular-nums ${
                                candidate.gamesPlayed === minCandidateGames ? 'text-green-600' : 'text-gray-500'
                              }`}
                            >
                              {candidate.gamesPlayed} {candidate.gamesPlayed === 1 ? 'game' : 'games'}
                            </span>
                            <button
                              disabled={editBusy}
                              onClick={() => handleReplaceCourtPlayer(editingCourt.id, replaceSlot, candidate.id)}
                              className="text-xs font-semibold bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-md transition-colors"
                            >
                              Bring in
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {hiddenCandidateCount > 0 && (
                    <p className="text-[11px] text-gray-400 mt-3">
                      {hiddenCandidateCount} other waiting player{hiddenCandidateCount === 1 ? '' : 's'} not shown —
                      skill mismatch, or part of a pair (unpair them in Manage Queue first).
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showBatchModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md animate-modal-in">
            <h2 className="text-lg font-bold text-gray-800 mb-1">Add Multiple Players</h2>
            <p className="text-sm text-gray-400 mb-4">Enter Players (Separated by ,)</p>
            <textarea
              value={batchInput}
              onChange={(e) => setBatchInput(e.target.value)}
              placeholder="e.g. Dave, Sarah, Carlos, Elena"
              rows={4}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none mb-3"
              autoFocus
            />
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                Skill level for all of these players
              </label>
              <select
                value={batchLevel}
                onChange={(e) => setBatchLevel(e.target.value as SkillLevel)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                {SKILL_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level.charAt(0).toUpperCase() + level.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowBatchModal(false);
                  setBatchInput('');
                }}
                className="px-4 py-2 rounded-lg text-gray-500 hover:bg-gray-100 font-medium text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddBatchPlayers}
                className="bg-green-600 hover:bg-green-700 text-white font-semibold text-sm px-4 py-2 rounded-lg transition-colors shadow-sm"
              >
                Add Players
              </button>
            </div>
          </div>
        </div>
      )}

      {showQueueSidebar && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => {
              setShowQueueSidebar(false);
              setPairingSourceId(null);
            }}
          />

          <div className="relative w-full max-w-sm bg-white h-full shadow-2xl overflow-y-auto animate-modal-in flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
              <h2 className="text-lg font-bold text-gray-800">Manage Queue</h2>
              <button
                onClick={() => {
                  setShowQueueSidebar(false);
                  setPairingSourceId(null);
                }}
                className="text-gray-400 hover:text-gray-600 w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-5 pt-4">
              <div className="relative">
                <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="7" />
                  <path strokeLinecap="round" d="M21 21l-4.3-4.3" />
                </svg>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search players..."
                  className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
            </div>

            {pairingSourceId !== null && (
              <div className="mx-5 mt-3 bg-green-50 border border-green-200 rounded-lg px-3 py-2 flex items-center justify-between">
                <p className="text-xs font-medium text-green-700">
                  Tap another player to pair with{' '}
                  {players.find((p) => p.id === pairingSourceId)?.name}
                </p>
                <button
                  onClick={() => setPairingSourceId(null)}
                  className="text-xs font-semibold text-green-700 hover:text-green-900 ml-2 shrink-0"
                >
                  Cancel
                </button>
              </div>
            )}

            <div className="p-5">
              <h3 className="text-sm font-bold text-gray-700 mb-3 flex items-center justify-between">
                <span>Waiting Queue</span>
                {players.length > 0 && (
                  <span className="bg-gray-100 text-gray-500 text-xs font-bold px-2 py-0.5 rounded-full">
                    {players.length}
                  </span>
                )}
              </h3>

              {filteredUnits.length === 0 ? (
                <p className="text-gray-300 text-sm">
                  {players.length === 0 ? 'No players waiting' : 'No matches'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {filteredUnits.map((unit) =>
                    unit.length === 2 ? (
                      <li
                        key={`pair-${unit[0].id}-${unit[1].id}`}
                        className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2"
                      >
                        <div className="flex items-center gap-1 text-xs font-semibold text-purple-600 mb-1.5">
                          <span>🔗</span>
                          <span>Paired</span>
                        </div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="flex items-center gap-1.5 text-sm font-medium text-gray-800 truncate">
                            <select
                              value={unit[0].skillLevel}
                              onChange={(e) => handleChangeSkillLevel(unit[0].id, e.target.value as SkillLevel)}
                              onClick={(e) => e.stopPropagation()}
                              className="text-[10px] font-bold border-0 bg-transparent px-0 py-0 focus:outline-none focus:ring-0 cursor-pointer"
                            >
                              {SKILL_LEVELS.map((lvl) => (
                                <option key={lvl} value={lvl}>
                                  {lvl.charAt(0).toUpperCase()}
                                </option>
                              ))}
                            </select>
                            {unit[0].name}
                          </span>
                          <span className="flex items-center gap-1.5 text-sm font-medium text-gray-800 truncate">
                            <select
                              value={unit[1].skillLevel}
                              onChange={(e) => handleChangeSkillLevel(unit[1].id, e.target.value as SkillLevel)}
                              onClick={(e) => e.stopPropagation()}
                              className="text-[10px] font-bold border-0 bg-transparent px-0 py-0 focus:outline-none focus:ring-0 cursor-pointer"
                            >
                              {SKILL_LEVELS.map((lvl) => (
                                <option key={lvl} value={lvl}>
                                  {lvl.charAt(0).toUpperCase()}
                                </option>
                              ))}
                            </select>
                            {unit[1].name}
                          </span>
                        </div>
                        <div className="flex gap-1.5 mt-2">
                          <button
                            onClick={() => handleSkipPlayer(unit[0].id)}
                            className="flex-1 text-xs font-semibold bg-gray-200 hover:bg-gray-300 text-gray-700 px-2.5 py-1 rounded-md transition-colors"
                          >
                            Skip Pair
                          </button>
                          <button
                            onClick={() => handleUnpairPlayer(unit[0].id)}
                            className="flex-1 text-xs font-semibold bg-purple-100 hover:bg-purple-200 text-purple-700 px-2.5 py-1 rounded-md transition-colors"
                          >
                            Unpair
                          </button>
                          <button
                            onClick={() => handleRemovePlayer(unit[0].id)}
                            className="text-xs font-semibold bg-red-50 hover:bg-red-100 text-red-600 px-2.5 py-1 rounded-md transition-colors"
                          >
                            ✕
                          </button>
                          <button
                            onClick={() => handleRemovePlayer(unit[1].id)}
                            className="text-xs font-semibold bg-red-50 hover:bg-red-100 text-red-600 px-2.5 py-1 rounded-md transition-colors"
                          >
                            ✕
                          </button>
                        </div>
                      </li>
                    ) : (
                      <li
                        key={unit[0].id}
                        className="flex items-center justify-between bg-gray-50 hover:bg-gray-100 rounded-lg px-3 py-2 transition-colors"
                      >
                        <span className="flex items-center gap-1.5 text-gray-800 text-sm font-medium truncate">
                          <select
                            value={unit[0].skillLevel}
                            onChange={(e) => handleChangeSkillLevel(unit[0].id, e.target.value as SkillLevel)}
                            onClick={(e) => e.stopPropagation()}
                            className="text-[10px] font-bold border-0 bg-transparent px-0 py-0 focus:outline-none focus:ring-0 cursor-pointer"
                          >
                            {SKILL_LEVELS.map((lvl) => (
                              <option key={lvl} value={lvl}>
                                {lvl.charAt(0).toUpperCase()}
                              </option>
                            ))}
                          </select>
                          {unit[0].name}
                        </span>
                        <div className="flex gap-1.5 shrink-0 ml-2">
                          {pairingSourceId === unit[0].id ? (
                            <button
                              onClick={() => setPairingSourceId(null)}
                              className="text-xs font-semibold bg-gray-200 hover:bg-gray-300 text-gray-700 px-2.5 py-1 rounded-md transition-colors"
                            >
                              Cancel
                            </button>
                          ) : pairingSourceId !== null ? (
                            <button
                              onClick={() => handlePairPlayers(pairingSourceId, unit[0].id)}
                              className="text-xs font-semibold bg-green-100 hover:bg-green-200 text-green-700 px-2.5 py-1 rounded-md transition-colors"
                            >
                              Pair Here
                            </button>
                          ) : (
                            <button
                              onClick={() => setPairingSourceId(unit[0].id)}
                              className="text-xs font-semibold bg-purple-50 hover:bg-purple-100 text-purple-600 px-2.5 py-1 rounded-md transition-colors"
                            >
                              🔗 Pair
                            </button>
                          )}
                          <button
                            onClick={() => handleSkipPlayer(unit[0].id)}
                            className="text-xs font-semibold bg-gray-200 hover:bg-gray-300 text-gray-700 px-2.5 py-1 rounded-md transition-colors"
                          >
                            Skip
                          </button>
                          <button
                            onClick={() => handleRemovePlayer(unit[0].id)}
                            className="text-xs font-semibold bg-red-50 hover:bg-red-100 text-red-600 px-2.5 py-1 rounded-md transition-colors"
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    )
                  )}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Dashboard;