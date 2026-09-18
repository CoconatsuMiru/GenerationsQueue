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

function pairKey(idA: number, idB: number): string {
  return idA < idB ? `${idA}-${idB}` : `${idB}-${idA}`;
}

function unitGamesPlayed(unit: Player[]): number {
  return Math.max(...unit.map((p) => p.gamesPlayed));
}

function unitSkillLevel(unit: Player[]): SkillLevel | null {
  if (unit.length === 1) return unit[0].skillLevel;
  return unit[0].skillLevel === unit[1].skillLevel ? unit[0].skillLevel : null;
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
// have 4 players of one level.
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
  const [allPlayers, setAllPlayers] = useState<Player[]>([]); // full roster (waiting + playing), for the leaderboard
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
  
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboardSearch, setLeaderboardSearch] = useState('');

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
    }));

    const playingIds = new Set(
      (dbCourts ?? []).flatMap((c) => c.player_ids ?? [])
    );
    const waitingPlayers = allPlayersList.filter((p) => !playingIds.has(p.id));

    const mappedCourts: Court[] = (dbCourts ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      players: allPlayersList.filter((p) => (c.player_ids ?? []).includes(p.id)),
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

      const startTimeIso = new Date().toISOString();

      const { error } = await supabase
        .from('courts')
        .update({
          player_ids: group.map((p) => p.id),
          start_time: startTimeIso,
        })
        .eq('id', openCourt.id);

      if (error) {
        console.error('Error assigning court:', error);
        return null;
      }

      const startTimeMs = new Date(startTimeIso).getTime();
      announcedAssignments.current.add(`${openCourt.id}-${startTimeMs}`);

      for (const player of group) {
        const newGamesPlayed = player.gamesPlayed + 1;
        const { error: gamesPlayedError } = await supabase
          .from('players')
          .update({ games_played: newGamesPlayed })
          .eq('id', player.id);
        if (gamesPlayedError) console.error('Error updating games_played:', gamesPlayedError);
      }

      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const idA = group[i].id;
          const idB = group[j].id;
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
      const incrementedGroup = group.map((p) => ({ ...p, gamesPlayed: p.gamesPlayed + 1 }));

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

    async function handleEndGame(courtId: number) {
    stopSpeaking();
    announcementCancelled.current = true;

    await runExclusive(async () => {
      const court = courtsRef.current.find((c) => c.id === courtId);
      if (!court) return;

      const { error: courtError } = await supabase
        .from('courts')
        .update({ player_ids: [], start_time: null })
        .eq('id', courtId);

      if (courtError) console.error('Error ending game:', courtError);

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
    });
  }

  async function handleResetSession() {
    const userId = session.user.id;

    const confirmed = window.confirm(
      'Reset the entire session? This will remove all players and clear all courts.'
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

      if (deletePlayersError) console.error('Error clearing players:', deletePlayersError);
      if (resetCourtsError) console.error('Error resetting courts:', resetCourtsError);
      if (resetSessionError) console.error('Error resetting session state:', resetSessionError);
      if (resetHistoryError) console.error('Error clearing group history:', resetHistoryError);

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

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">Courts</h2>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
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
                />
              ))}
            </div>
          </div>

{/* Games Played lookup */}
          <div>
            <button
              onClick={() => setShowLeaderboard((v) => !v)}
              className="w-full flex items-center justify-between text-sm font-bold text-gray-500 uppercase tracking-wide mb-3"
            >
              <span>🏆 Games Played</span>
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
      </div>

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