import { useState, useEffect, useRef } from 'react';
import './App.css';
import type { Player, Court } from './types';
import { supabase } from './supabaseClient';
import CourtCard from './CourtCard';

const GAME_LENGTH_MINUTES = 15; // configurable court time limit (hardcoded for now)
const WARMUP_MINUTES = 3; // warmup period before the game timer starts

function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [nameInput, setNameInput] = useState('');

  const [courts, setCourts] = useState<Court[]>([]);

  const [, setTick] = useState(0);

  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchInput, setBatchInput] = useState('');

  const isAssigning = useRef(false);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  async function loadData() {
    const { data: dbPlayers, error: playersError } = await supabase
      .from('players')
      .select('*')
      .order('queue_position', { ascending: true });

    const { data: dbCourts, error: courtsError } = await supabase
      .from('courts')
      .select('*')
      .order('id', { ascending: true });

    if (playersError) console.error('Error loading players:', playersError);
    if (courtsError) console.error('Error loading courts:', courtsError);

    const allPlayers: Player[] = (dbPlayers ?? []).map((p) => ({
      id: p.id,
      name: p.name,
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
  }

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const openCourt = courts.find((court) => court.players.length === 0);
    if (!openCourt) return;
    if (players.length < 4) return;
    if (isAssigning.current) return;

    const nextFour = players.slice(0, 4);

    async function assignCourt() {
      isAssigning.current = true;

      const { error } = await supabase
        .from('courts')
        .update({
          player_ids: nextFour.map((p) => p.id),
          start_time: new Date().toISOString(),
        })
        .eq('id', openCourt.id);

      if (error) console.error('Error assigning court:', error);

      await loadData();
      isAssigning.current = false;
    }

    assignCourt();
  }, [players, courts]);

  async function handleAddPlayer() {
    if (nameInput.trim() === '') return;

    const { data, error } = await supabase
      .from('players')
      .insert({ name: nameInput, queue_position: Date.now() })
      .select()
      .single();

    if (error) {
      console.error('Error adding player:', error);
      return;
    }

    const newPlayer: Player = { id: data.id, name: data.name };
    setPlayers([...players, newPlayer]);
    setNameInput('');
  }

  function handleNameInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      handleAddPlayer();
    }
  }

  async function handleAddBatchPlayers() {
    const names = batchInput
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');

    if (names.length === 0) return;

    const now = Date.now();
    const rowsToInsert = names.map((name, index) => ({
      name,
      queue_position: now + index,
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
    }));

    setPlayers([...players, ...newPlayers]);
    setBatchInput('');
    setShowBatchModal(false);
  }

  async function handleRemovePlayer(id: number) {
    const { error } = await supabase.from('players').delete().eq('id', id);

    if (error) {
      console.error('Error removing player:', error);
      return;
    }

    setPlayers(players.filter((player) => player.id !== id));
  }

  async function handleSkipPlayer(id: number) {
    const newPosition = Date.now();

    const { error } = await supabase
      .from('players')
      .update({ queue_position: newPosition })
      .eq('id', id);

    if (error) {
      console.error('Error skipping player:', error);
      return;
    }

    const player = players.find((p) => p.id === id);
    if (!player) return;

    const withoutPlayer = players.filter((p) => p.id !== id);
    setPlayers([...withoutPlayer, player]);
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
    for (let i = 0; i < court.players.length; i++) {
      const player = court.players[i];
      const { error: playerError } = await supabase
        .from('players')
        .update({ queue_position: now + i })
        .eq('id', player.id);

      if (playerError) console.error('Error requeuing player:', playerError);
    }

    setPlayers([...players, ...court.players]);
    setCourts(
      courts.map((c) =>
        c.id === courtId ? { ...c, players: [], startTime: null } : c
      )
    );
  }

  async function handleResetSession() {
    const confirmed = window.confirm(
      'Reset the entire session? This will remove all players and clear all courts.'
    );
    if (!confirmed) return;

    const { error: deletePlayersError } = await supabase
      .from('players')
      .delete()
      .neq('id', 0);

    const { error: resetCourtsError } = await supabase
      .from('courts')
      .update({ player_ids: [], start_time: null })
      .neq('id', 0);

    if (deletePlayersError) console.error('Error clearing players:', deletePlayersError);
    if (resetCourtsError) console.error('Error resetting courts:', resetCourtsError);

    await loadData();
  }

  const nextUp = players.slice(0, 4);
  const restOfQueue = players.slice(4);
  const courtsInPlay = courts.filter((c) => c.players.length > 0).length;

  return (
    <div className="relative min-h-screen bg-linear-to-b from-slate-100 via-emerald-50 to-teal-100 overflow-hidden">
      {/* Decorative background layer */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-dot-grid opacity-60" />
        <div className="animate-blob absolute -top-24 -left-24 w-[28rem] h-[28rem] bg-green-400 rounded-full blur-3xl opacity-50" />
        <div className="animate-blob-delayed absolute top-1/4 -right-24 w-[28rem] h-[28rem] bg-emerald-500 rounded-full blur-3xl opacity-40" />
        <div className="animate-blob absolute -bottom-24 left-1/3 w-[28rem] h-[28rem] bg-teal-400 rounded-full blur-3xl opacity-40" />
        <div className="animate-blob-delayed absolute bottom-1/4 right-1/4 w-80 h-80 bg-lime-300 rounded-full blur-3xl opacity-30" />
      </div>

      {/* Header */}
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
                <h1 className="text-2xl font-extrabold text-white tracking-tight">PickleQueue</h1>
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
                onClick={handleResetSession}
                className="bg-white/15 hover:bg-red-500/80 text-white font-semibold text-sm px-4 py-2 rounded-lg border border-white/30 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Stat strip */}
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

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Courts */}
          <div className="lg:col-span-2">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">Courts</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {courts.map((court) => (
                <CourtCard
                  key={court.id}
                  court={court}
                  gameLengthMinutes={GAME_LENGTH_MINUTES}
                  warmupMinutes={WARMUP_MINUTES}
                  onEndGame={handleEndGame}
                />
              ))}
            </div>
          </div>

          {/* Right: Queue */}
          <div className="space-y-5">
            {/* Next Up */}
            <div className="bg-linear-to-br from-green-500 to-emerald-600 text-white rounded-xl shadow-md p-5">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5-5 5M6 7l5 5-5 5" />
                </svg>
                <h2 className="text-base font-bold">Next Up</h2>
              </div>
              {nextUp.length === 0 ? (
                <p className="text-green-100 text-sm">No one waiting</p>
              ) : (
                <ul className="space-y-2">
                  {nextUp.map((player, index) => (
                    <li
                      key={player.id}
                      className="bg-white/15 backdrop-blur rounded-lg px-3 py-2 flex items-center gap-3"
                    >
                      <span className="bg-white/25 text-white font-bold text-xs w-5 h-5 rounded-full flex items-center justify-center shrink-0">
                        {index + 1}
                      </span>
                      <span className="font-medium text-sm truncate">{player.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Rest of Queue */}
            <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-5">
              <details>
                <summary className="text-sm font-bold text-gray-700 cursor-pointer select-none flex items-center justify-between">
                  <span>Rest of Queue</span>
                  {restOfQueue.length > 0 && (
                    <span className="bg-gray-100 text-gray-500 text-xs font-bold px-2 py-0.5 rounded-full">
                      {restOfQueue.length}
                    </span>
                  )}
                </summary>
                <div className="mt-3">
                  {restOfQueue.length === 0 ? (
                    <p className="text-gray-300 text-sm">—</p>
                  ) : (
                    <ul className="space-y-1 max-h-64 overflow-y-auto">
                      {restOfQueue.map((player, i) => (
                        <li key={player.id} className="text-sm text-gray-600 px-2 py-1.5 flex items-center gap-2">
                          <span className="text-gray-300 text-xs w-4">{i + 5}</span>
                          {player.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            </div>

            {/* Full waiting queue with actions */}
            <div className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-5">
              <details open>
                <summary className="text-sm font-bold text-gray-700 cursor-pointer select-none flex items-center justify-between">
                  <span>Waiting Queue</span>
                  {players.length > 0 && (
                    <span className="bg-gray-100 text-gray-500 text-xs font-bold px-2 py-0.5 rounded-full">
                      {players.length}
                    </span>
                  )}
                </summary>
                <div className="mt-3">
                  {players.length === 0 ? (
                    <p className="text-gray-300 text-sm">No players waiting</p>
                  ) : (
                    <ul className="space-y-2 max-h-64 overflow-y-auto">
                      {players.map((player) => (
                        <li
                          key={player.id}
                          className="flex items-center justify-between bg-gray-50 hover:bg-gray-100 rounded-lg px-3 py-2 transition-colors"
                        >
                          <span className="text-gray-800 text-sm font-medium truncate">{player.name}</span>
                          <div className="flex gap-1.5 shrink-0 ml-2">
                            <button
                              onClick={() => handleSkipPlayer(player.id)}
                              className="text-xs font-semibold bg-gray-200 hover:bg-gray-300 text-gray-700 px-2.5 py-1 rounded-md transition-colors"
                            >
                              Skip
                            </button>
                            <button
                              onClick={() => handleRemovePlayer(player.id)}
                              className="text-xs font-semibold bg-red-50 hover:bg-red-100 text-red-600 px-2.5 py-1 rounded-md transition-colors"
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            </div>
          </div>
        </div>
      </div>

      {/* Batch add modal */}
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
    </div>
  );
}

export default App;