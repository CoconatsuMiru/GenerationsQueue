import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import './App.css';
import type { Player, Court } from './types';
import { supabase } from './supabaseClient';
import CourtCard from './CourtCard';
import { speak, isSpeechSupported, primeSpeechOnFirstInteraction } from './speech';
import type { Session } from '@supabase/supabase-js';

const GAME_LENGTH_MINUTES = 15;
const WARMUP_MINUTES = 3;
const OVERTIME_MINUTES = 2;
const MAX_QUEUE_STACKS = 10;
const ANNOUNCE_PAUSE_MS = 1500;
const FIRST_CALL_REPEAT_PAUSE_MS = 400;
const FAIRNESS_POOL_TARGET_PLAYERS = 8; // how many players deep to look when picking a fair group

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

// Builds a small forward-looking pool of units (roughly the front
// FAIRNESS_POOL_TARGET_PLAYERS players' worth, not just 4) so the
// fairness scoring below has a handful of realistic groupings to choose
// from, without scanning the whole queue and drifting far from FIFO.
function buildCandidatePool(units: Player[][], targetPlayers: number): Player[][] {
  const pool: Player[][] = [];
  let total = 0;
  for (const unit of units) {
    if (total >= targetPlayers) break;
    pool.push(unit);
    total += unit.length;
  }
  return pool;
}

// A unit's "games played" for tiering is the MAX across its members
// (rather than an average) — this way a pair only counts as part of the
// lowest tier when BOTH partners are equally under-played, so a
// veteran+newcomer pair can't sneak in ahead of two equally-fresh
// newcomers.
function unitGamesPlayed(unit: Player[]): number {
  return Math.max(...unit.map((p) => p.gamesPlayed));
}

// Picks the tier of units with the fewest games played, expanding to
// include the next tier(s) up if there aren't yet 4 players' worth of
// units in the lowest tier — this is what stops a court from stalling
// just because very few "freshest" players happen to be waiting.
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

// Generates a small handful of valid 4-player groupings by sliding the
// starting point within the fairness tier a few times (rather than
// exhaustively combining every possibility) — cheap, and stays close to
// FIFO order within the tier. Reuses selectNextGroup's unit-fitting logic
// so pairs still land in the same group of 4 together.
function generateCandidateGroups(tierUnits: Player[][]): Player[][] {
  const candidates: Player[][] = [];
  const seen = new Set<string>();
  const maxStarts = Math.min(tierUnits.length, 5);

  for (let start = 0; start < maxStarts; start++) {
    const { group } = selectNextGroup(tierUnits.slice(start), 4);
    if (group.length < 4) continue;

    const key = group.map((p) => p.id).sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;

    seen.add(key);
    candidates.push(group);
  }

  return candidates;
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

// Chooses which 4 players get the next open court: pulls a small
// forward-looking pool from the front of the queue, narrows to whichever
// units have played the fewest games so far (expanding tiers as needed so
// a court never stalls), generates a handful of valid groupings from that
// tier, and picks whichever grouping has played together least often
// before. Ties are broken randomly. Returns null if there aren't yet 4
// players available to form any group.
function chooseFairGroup(players: Player[], groupHistory: Map<string, number>): Player[] | null {
  const units = buildUnits(players);
  const pool = buildCandidatePool(units, FAIRNESS_POOL_TARGET_PLAYERS);

  const totalPoolPlayers = pool.reduce((sum, unit) => sum + unit.length, 0);
  if (totalPoolPlayers < 4) return null;

  const tier = selectFairnessTier(pool);
  const candidates = generateCandidateGroups(tier);
  if (candidates.length === 0) return null;

  const scored = candidates.map((group) => ({
    group,
    score: scoreGroup(group, groupHistory),
  }));

  const lowestScore = Math.min(...scored.map((s) => s.score));
  const bestCandidates = scored.filter((s) => s.score === lowestScore);
  const chosen = shuffleArray(bestCandidates)[0];

  return chosen.group;
}

function Dashboard({ session }: DashboardProps) {
  const navigate = useNavigate();

  const [players, setPlayers] = useState<Player[]>([]);
  const [nameInput, setNameInput] = useState('');

  const [courts, setCourts] = useState<Court[]>([]);

  const [tick, setTick] = useState(0);

  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchInput, setBatchInput] = useState('');

  const [showQueueSidebar, setShowQueueSidebar] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [pairingSourceId, setPairingSourceId] = useState<number | null>(null);

  const [isSessionActive, setIsSessionActive] = useState(false);

  const [timeBased, setTimeBased] = useState(true);

  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const announcedAssignments = useRef<Set<string>>(new Set());
  const announcedOvertime = useRef<Set<string>>(new Set());

  const isAssigning = useRef(false);
  const autoEndingCourts = useRef<Set<number>>(new Set());

  const playersRef = useRef<Player[]>(players);
  const courtsRef = useRef<Court[]>(courts);
  const pendingRerun = useRef(false);

  // In-memory cache of pairwise "played together" counts, keyed by
  // pairKey(idA, idB). Loaded fresh in loadData() and kept in sync
  // locally as new assignments happen, so scoring inside
  // processNextAssignment never needs an extra DB round trip.
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
      .select('time_based')
      .eq('owner_id', userId)
      .maybeSingle();

    if (venueSettingsError) console.error('Error loading venue settings:', venueSettingsError);

    setTimeBased(venueSettings?.time_based ?? true);

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

    const allPlayers: Player[] = (dbPlayers ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      partnerId: p.partner_id,
      gamesPlayed: p.games_played ?? 0,
    }));

    const playingIds = new Set(
      (dbCourts ?? []).flatMap((c) => c.player_ids ?? [])
    );
    const waitingPlayers = allPlayers.filter((p) => !playingIds.has(p.id));

    const mappedCourts: Court[] = (dbCourts ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      players: allPlayers.filter((p) => (c.player_ids ?? []).includes(p.id)),
      startTime: c.start_time ? new Date(c.start_time).getTime() : null,
    }));

    const historyMap = new Map<string, number>();
    (dbGroupHistory ?? []).forEach((row) => {
      historyMap.set(pairKey(row.player_a_id, row.player_b_id), row.count);
    });
    groupHistoryRef.current = historyMap;

    setPlayers(waitingPlayers);
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

  // Handles ONE court at a time. The decide-and-write step (now including
  // the fairness-based group selection, plus the games_played and
  // group_history bookkeeping) runs inside runExclusive and stays fast —
  // it reads the freshest known queue via refs, picks a group, writes to
  // Supabase, updates local state, then immediately releases the lock.
  // The voice announcement happens AFTER the lock is released, so other
  // actions (End Game, Skip, etc.) never have to wait for it.
  async function processNextAssignment() {
    const assignment = await runExclusive(async () => {
      const openCourt = courtsRef.current.find((c) => c.players.length === 0);
      if (!openCourt) return null;

      const group = chooseFairGroup(playersRef.current, groupHistoryRef.current);
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

      // Fairness bookkeeping: bump games_played for the 4 assigned
      // players, and bump the repeat-grouping count for every pairwise
      // combination among them. Sequential single-row writes — a
      // batched multi-row upsert was previously found to silently fail
      // to persist for this project.
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

      const assignedIds = new Set(group.map((p) => p.id));
      const updatedPlayers = playersRef.current.filter((p) => !assignedIds.has(p.id));
      const updatedCourts = courtsRef.current.map((c) =>
        c.id === openCourt.id ? { ...c, players: group, startTime: startTimeMs } : c
      );

      playersRef.current = updatedPlayers;
      courtsRef.current = updatedCourts;
      setPlayers(updatedPlayers);
      setCourts(updatedCourts);

      return { court: openCourt, group };
    });

    if (assignment && voiceEnabled && isSpeechSupported()) {
      const names = assignment.group.map((p) => p.name).join(', ');
      const announcement = `${assignment.court.name}. ${names}.`;
      await speak(announcement);
      await new Promise((resolve) => setTimeout(resolve, FIRST_CALL_REPEAT_PAUSE_MS));
      await speak(announcement);
      await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_PAUSE_MS));
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

    const gameEndMs = (WARMUP_MINUTES + GAME_LENGTH_MINUTES) * 60 * 1000;
    const totalMs = gameEndMs + OVERTIME_MINUTES * 60 * 1000;

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
  }, [tick, courts, voiceEnabled, timeBased]);

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
    setNameInput('');

    await runExclusive(async () => {
      const { data, error } = await supabase
        .from('players')
        .insert({ name, queue_position: nextQueuePosition(), owner_id: userId })
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
      };
      const updated = [...playersRef.current, newPlayer];
      playersRef.current = updated;
      setPlayers(updated);
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

    setBatchInput('');
    setShowBatchModal(false);

    await runExclusive(async () => {
      const rowsToInsert = names.map((name) => ({
        name,
        queue_position: nextQueuePosition(),
        owner_id: userId,
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
      }));

      const updated = [...playersRef.current, ...newPlayers];
      playersRef.current = updated;
      setPlayers(updated);
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

    const { error } = await supabase
      .from('session_state')
      .update({ is_active: newValue })
      .eq('owner_id', userId);

    if (error) {
      console.error('Error updating session state:', error);
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

  const units = buildUnits(players);
  const queueStacks = buildQueueGroups(units, 4, MAX_QUEUE_STACKS);
  const courtsInPlay = courts.filter((c) => c.players.length > 0).length;

  const filteredUnits = units.filter((unit) =>
    unit.some((p) => p.name.toLowerCase().includes(searchTerm.trim().toLowerCase()))
  );

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
              {timeBased ? `${GAME_LENGTH_MINUTES}m` : 'Manual'}
            </p>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mt-1">
              {timeBased ? 'Game Timer' : 'Game Mode'}
            </p>
          </div>
        </div>

        <div>
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">Courts</h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
            {courts.map((court) => (
              <CourtCard
                key={court.id}
                court={court}
                gameLengthMinutes={GAME_LENGTH_MINUTES}
                warmupMinutes={WARMUP_MINUTES}
                overtimeMinutes={OVERTIME_MINUTES}
                timeBased={timeBased}
                onEndGame={handleEndGame}
                onAnnounce={handleAnnounceCourt}
              />
            ))}
          </div>
        </div>

        {queueStacks.length > 0 && (
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
                        className={`text-sm font-medium truncate rounded-md px-2 py-1 flex items-center gap-1 ${
                          stackIndex === 0 ? 'bg-white/15' : 'bg-gray-50'
                        }`}
                      >
                        <span>{i + 1}. {player.name}</span>
                        {player.partnerId !== null && <span className="text-xs">🔗</span>}
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
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
              autoFocus
            />
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
                          <span className="text-sm font-medium text-gray-800 truncate">{unit[0].name}</span>
                          <span className="text-sm font-medium text-gray-800 truncate">{unit[1].name}</span>
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
                        <span className="text-gray-800 text-sm font-medium truncate">{unit[0].name}</span>
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