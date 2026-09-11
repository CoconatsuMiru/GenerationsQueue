import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import './App.css';
import type { Player, Court } from './types';
import { supabase } from './supabaseClient';
import CourtCard from './CourtCard';
import { speak, isSpeechSupported } from './speech';
import type { Session } from '@supabase/supabase-js';

const GAME_LENGTH_MINUTES = 15;
const WARMUP_MINUTES = 3;
const OVERTIME_MINUTES = 2;
const MAX_QUEUE_STACKS = 10;
const ANNOUNCE_PAUSE_MS = 1500; // pause after each court announcement finishes, before the next one

interface DashboardProps {
  session: Session;
}

function buildUnits(players: Player[]): Player[][] {
  const consumed = new Set<number>();
  const units: Player[][] = [];

  for (const player of players) {
    if (consumed.has(player.id)) continue;

    if (player.partnerId !== null) {
      const partner = players.find((p) => p.id === player.partnerId);
      if (partner && !consumed.has(partner.id)) {
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

  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const announcedAssignments = useRef<Set<string>>(new Set());
  const announcedOvertime = useRef<Set<string>>(new Set());

  const isAssigning = useRef(false);
  const autoEndingCourts = useRef<Set<number>>(new Set());

  useEffect(() => {
    const intervalId = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

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
      .order('queue_position', { ascending: true });

    const { data: dbCourts, error: courtsError } = await supabase
      .from('courts')
      .select('*')
      .eq('owner_id', userId)
      .order('id', { ascending: true });

    if (playersError) console.error('Error loading players:', playersError);
    if (courtsError) console.error('Error loading courts:', courtsError);

    const allPlayers: Player[] = (dbPlayers ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      partnerId: p.partner_id,
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
        loadData();
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

  // Triggers the sequential court-filling routine whenever players, courts,
  // or session state change. assignOpenCourts() guards against overlapping
  // runs itself via isAssigning.current.
  useEffect(() => {
    if (!isSessionActive) return;
    assignOpenCourts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, courts, isSessionActive]);

  // Fills empty courts ONE AT A TIME instead of all at once. For each open
  // court: assigns players in the DB, updates local state immediately so
  // the loop can keep going without waiting on the realtime round trip,
  // announces the lineup by voice, and only moves to the next open court
  // after that announcement has fully finished playing (plus a short
  // pause). This is what stops multiple "Court X..." announcements from
  // overlapping or talking over each other when several courts are empty
  // at once (e.g. right when a session starts).
  async function assignOpenCourts() {
    if (isAssigning.current) return;
    isAssigning.current = true;

    try {
      let remainingPlayers = players;
      let remainingCourts = courts;

      while (true) {
        const openCourt = remainingCourts.find((c) => c.players.length === 0);
        if (!openCourt) break;

        const units = buildUnits(remainingPlayers);
        const { group } = selectNextGroup(units, 4);
        if (group.length < 4) break;

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
          break;
        }

        const startTimeMs = new Date(startTimeIso).getTime();
        announcedAssignments.current.add(`${openCourt.id}-${startTimeMs}`);

        const assignedIds = new Set(group.map((p) => p.id));
        remainingPlayers = remainingPlayers.filter((p) => !assignedIds.has(p.id));
        remainingCourts = remainingCourts.map((c) =>
          c.id === openCourt.id ? { ...c, players: group, startTime: startTimeMs } : c
        );

        setPlayers(remainingPlayers);
        setCourts(remainingCourts);

        if (voiceEnabled && isSpeechSupported()) {
          const names = group.map((p) => p.name).join(', ');
          await speak(`${openCourt.name}. ${names}.`);
          await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_PAUSE_MS));
        }
      }
    } finally {
      isAssigning.current = false;
    }
  }

  useEffect(() => {
    const gameEndMs = (WARMUP_MINUTES + GAME_LENGTH_MINUTES) * 60 * 1000;
    const totalMs = gameEndMs + OVERTIME_MINUTES * 60 * 1000;

    courts.forEach((court) => {
      if (court.startTime === null) return;
      const elapsedMs = Date.now() - court.startTime;
      const key = `${court.id}-${court.startTime}`;

      // Announce overtime once, right when the game clock crosses into it.
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
  }, [tick, courts, voiceEnabled]);

  async function handleAddPlayer() {
    if (nameInput.trim() === '') return;
    const userId = session.user.id;

    const { data, error } = await supabase
      .from('players')
      .insert({ name: nameInput, queue_position: Date.now(), owner_id: userId })
      .select()
      .single();

    if (error) {
      console.error('Error adding player:', error);
      return;
    }

    const newPlayer: Player = { id: data.id, name: data.name, partnerId: data.partner_id };
    setPlayers((prev) => [...prev, newPlayer]);
    setNameInput('');
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

    const now = Date.now();
    const rowsToInsert = names.map((name, index) => ({
      name,
      queue_position: now + index,
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
    }));

    setPlayers((prev) => [...prev, ...newPlayers]);
    setBatchInput('');
    setShowBatchModal(false);
  }

  async function handleRemovePlayer(id: number) {
    const player = players.find((p) => p.id === id);

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

    setPlayers((prev) =>
      prev
        .filter((p) => p.id !== id)
        .map((p) => (p.id === player?.partnerId ? { ...p, partnerId: null } : p))
    );
  }

  async function handleSkipPlayer(id: number) {
    const player = players.find((p) => p.id === id);
    if (!player) return;

    const idsToSkip = player.partnerId !== null ? [id, player.partnerId] : [id];
    const now = Date.now();

    for (let i = 0; i < idsToSkip.length; i++) {
      const { error } = await supabase
        .from('players')
        .update({ queue_position: now + i })
        .eq('id', idsToSkip[i]);
      if (error) console.error('Error skipping player:', error);
    }

    setPlayers((prev) => {
      const skipped = prev.filter((p) => idsToSkip.includes(p.id));
      const remaining = prev.filter((p) => !idsToSkip.includes(p.id));
      return [...remaining, ...skipped];
    });
  }

  async function handleShuffleQueue() {
    if (players.length === 0) return;

    // Shuffle at the unit level (pairs move together, singles move alone)
    // rather than shuffling individual players, so a paired duo never
    // gets split apart by the shuffle.
    const units = buildUnits(players);
    const shuffledUnits = shuffleArray(units);

    const now = Date.now();
    const newOrder: Player[] = [];
    const updates: { id: number; queue_position: number }[] = [];

    let position = 0;
    shuffledUnits.forEach((unit) => {
      unit.forEach((player) => {
        newOrder.push(player);
        updates.push({ id: player.id, queue_position: now + position });
        position++;
      });
    });

    // Sequential per-row updates instead of a single upsert — this matches
    // the pattern handleSkipPlayer already uses successfully, sidestepping
    // whatever was causing the batched upsert to silently fail.
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

    setPlayers(newOrder);
  }

  async function handleEndGame(courtId: number) {
    const court = courts.find((c) => c.id === courtId);
    if (!court) return;

    const { error: courtError } = await supabase
      .from('courts')
      .update({ player_ids: [], start_time: null })
      .eq('id', courtId);

    if (courtError) console.error('Error ending game:', courtError);

    const now = Date.now();
    const requeueRows = court.players.map((player, i) => ({
      id: player.id,
      queue_position: now + i,
    }));

    if (requeueRows.length > 0) {
      const { error: requeueError } = await supabase
        .from('players')
        .upsert(requeueRows, { onConflict: 'id' });

      if (requeueError) console.error('Error requeuing players:', requeueError);
    }

    // Functional updates here are the fix: when multiple courts end at
    // nearly the same time, each call builds on the latest state instead
    // of a stale snapshot from when it was called, so no updates get lost.
    setPlayers((prev) => [...prev, ...court.players]);
    setCourts((prev) =>
      prev.map((c) =>
        c.id === courtId ? { ...c, players: [], startTime: null } : c
      )
    );
  }

  async function handleResetSession() {
    const userId = session.user.id;

    const confirmed = window.confirm(
      'Reset the entire session? This will remove all players and clear all courts.'
    );
    if (!confirmed) return;

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

    if (deletePlayersError) console.error('Error clearing players:', deletePlayersError);
    if (resetCourtsError) console.error('Error resetting courts:', resetCourtsError);
    if (resetSessionError) console.error('Error resetting session state:', resetSessionError);
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

    const { error: errA } = await supabase.from('players').update({ partner_id: idB }).eq('id', idA);
    const { error: errB } = await supabase.from('players').update({ partner_id: idA }).eq('id', idB);

    if (errA || errB) {
      console.error('Error pairing players:', errA || errB);
      return;
    }

    setPlayers((prev) =>
      prev.map((p) => {
        if (p.id === idA) return { ...p, partnerId: idB };
        if (p.id === idB) return { ...p, partnerId: idA };
        return p;
      })
    );
    setPairingSourceId(null);
  }

  async function handleUnpairPlayer(id: number) {
    const player = players.find((p) => p.id === id);
    if (!player || player.partnerId === null) return;

    const partnerId = player.partnerId;

    const { error: errA } = await supabase.from('players').update({ partner_id: null }).eq('id', id);
    const { error: errB } = await supabase.from('players').update({ partner_id: null }).eq('id', partnerId);

    if (errA || errB) {
      console.error('Error unpairing players:', errA || errB);
      return;
    }

    setPlayers((prev) =>
      prev.map((p) => (p.id === id || p.id === partnerId ? { ...p, partnerId: null } : p))
    );
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
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 backdrop-blur rounded-xl flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" />
                  <path strokeLinecap="round" d="M8 12h8M12 8v8" />
                </svg>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-extrabold text-white tracking-tight">PickleQueue</h1>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      isSessionActive ? 'bg-white/25 text-white' : 'bg-black/20 text-white/80'
                    }`}
                  >
                    {isSessionActive ? '● LIVE' : 'PAUSED'}
                  </span>
                </div>
                <p className="text-green-100 text-xs font-medium">Digital paddle board & queue</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={handleNameInputKeyDown}
                placeholder="Player name"
                className="bg-white/95 border-0 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-white w-40"
              />
              <button
                onClick={handleAddPlayer}
                className="bg-white text-green-700 hover:bg-green-50 font-semibold text-sm px-4 py-2 rounded-lg transition-colors shadow-sm"
              >
                Add Player
              </button>
              <button
                onClick={() => setShowBatchModal(true)}
                className="bg-white/15 hover:bg-white/25 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                + Multiple
              </button>
              <button
                onClick={handleShuffleQueue}
                disabled={players.length === 0}
                className="bg-white/15 hover:bg-white/25 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                🔀 Shuffle
              </button>
              <button
                onClick={() => setShowQueueSidebar(true)}
                className="relative bg-white/15 hover:bg-white/25 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                Manage Queue
                {players.length > 0 && (
                  <span className="absolute -top-2 -right-2 bg-white text-green-700 text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                    {players.length}
                  </span>
                )}
              </button>
              <button
                onClick={handleToggleSession}
                className={`font-semibold text-sm px-4 py-2 rounded-lg border transition-colors ${
                  isSessionActive
                    ? 'bg-white/15 hover:bg-yellow-500/80 text-white border-white/30'
                    : 'bg-white text-green-700 hover:bg-green-50 border-white'
                }`}
              >
                {isSessionActive ? 'Pause Session' : 'Start Session'}
              </button>
              <button
                onClick={handleResetSession}
                className="bg-white/15 hover:bg-red-500/80 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                Reset
              </button>
              {isSpeechSupported() && (
                <button
                  onClick={() => setVoiceEnabled((v) => !v)}
                  title={voiceEnabled ? 'Mute announcements' : 'Unmute announcements'}
                  className="bg-white/15 hover:bg-white/25 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
                >
                  {voiceEnabled ? '🔊 Voice On' : '🔇 Voice Off'}
                </button>
              )}
              <button
                onClick={() => navigate('/admin')}
                className="bg-white/15 hover:bg-white/25 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                ⚙ Settings
              </button>
              <button
                onClick={() => supabase.auth.signOut()}
                className="bg-white/15 hover:bg-white/25 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                Log Out
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {!isSessionActive && (
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm font-medium rounded-lg px-4 py-3 mb-6 flex items-center gap-2">
            <span>⏸</span>
            <span>
              Session is paused — players can be added and managed, but courts won't auto-fill until you click "Start Session."
            </span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-4 text-center">
            <p className="text-3xl font-extrabold text-gray-800">{courtsInPlay}/{courts.length}</p>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mt-1">Courts in Play</p>
          </div>
          <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-4 text-center">
            <p className="text-3xl font-extrabold text-gray-800">{players.length}</p>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mt-1">In Queue</p>
          </div>
          <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-4 text-center">
            <p className="text-3xl font-extrabold text-gray-800">{GAME_LENGTH_MINUTES}m</p>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mt-1">Game Timer</p>
          </div>
        </div>

        <div>
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">Courts</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {courts.map((court) => (
              <CourtCard
                key={court.id}
                court={court}
                gameLengthMinutes={GAME_LENGTH_MINUTES}
                warmupMinutes={WARMUP_MINUTES}
                overtimeMinutes={OVERTIME_MINUTES}
                onEndGame={handleEndGame}
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