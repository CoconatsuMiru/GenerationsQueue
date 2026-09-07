import { useState, useEffect } from 'react';
import './App.css';
import type { Player, Court } from './types';
import CourtCard from './CourtCard';

const GAME_LENGTH_MINUTES = 15; // configurable court time limit (hardcoded for now)

let nextId = 4; // simple counter for generating unique IDs (Alice/Bob/Charlie use 1-3)

function App() {
  const [players, setPlayers] = useState<Player[]>([
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
    { id: 3, name: 'Charlie' },
  ]);
  const [nameInput, setNameInput] = useState('');

  const [courts, setCourts] = useState<Court[]>([
    { id: 1, name: 'Court 1', players: [], startTime: null },
    { id: 2, name: 'Court 2', players: [], startTime: null },
  ]);

  const [, setTick] = useState(0);

  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchInput, setBatchInput] = useState('');

  // Ticks every second so court timers visually update.
  useEffect(() => {
    const intervalId = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  // Automatically fills the first open court with the next 4 waiting players,
  // any time the queue or courts change and both conditions are met.
  useEffect(() => {
    const openCourt = courts.find((court) => court.players.length === 0);
    if (!openCourt) return; // no open court right now
    if (players.length < 4) return; // not enough players waiting

    const nextFour = players.slice(0, 4);
    const remaining = players.slice(4);

    setCourts(
      courts.map((court) =>
        court.id === openCourt.id
          ? { ...court, players: nextFour, startTime: Date.now() }
          : court
      )
    );
    setPlayers(remaining);
  }, [players, courts]);

  function handleAddPlayer() {
    if (nameInput.trim() === '') return;
    const newPlayer: Player = { id: nextId, name: nameInput };
    nextId++;
    setPlayers([...players, newPlayer]);
    setNameInput('');
  }

  function handleNameInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      handleAddPlayer();
    }
  }

  function handleAddBatchPlayers() {
    const names = batchInput
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');

    if (names.length === 0) return;

    const newPlayers: Player[] = names.map((name) => {
      const player = { id: nextId, name };
      nextId++;
      return player;
    });

    setPlayers([...players, ...newPlayers]);
    setBatchInput('');
    setShowBatchModal(false);
  }

  function handleRemovePlayer(id: number) {
    setPlayers(players.filter((player) => player.id !== id));
  }

  function handleSkipPlayer(id: number) {
    const player = players.find((p) => p.id === id);
    if (!player) return;

    const withoutPlayer = players.filter((p) => p.id !== id);
    setPlayers([...withoutPlayer, player]);
  }

  function handleEndGame(courtId: number) {
    const court = courts.find((c) => c.id === courtId);
    if (!court) return;

    setPlayers([...players, ...court.players]);

    setCourts(
      courts.map((c) =>
        c.id === courtId ? { ...c, players: [], startTime: null } : c
      )
    );
  }

  const nextUp = players.slice(0, 4);
  const restOfQueue = players.slice(4);

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold text-green-600">PickleQueue</h1>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={handleNameInputKeyDown}
              placeholder="Player name"
              className="border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              onClick={handleAddPlayer}
              className="bg-green-600 hover:bg-green-700 text-white font-medium px-4 py-2 rounded-md transition-colors"
            >
              Add Player
            </button>
            <button
              onClick={() => setShowBatchModal(true)}
              className="bg-white hover:bg-gray-50 text-gray-700 font-medium px-4 py-2 rounded-md border border-gray-300 transition-colors"
            >
              Add Multiple
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Courts */}
          <div className="lg:col-span-2">
            <h2 className="text-lg font-semibold text-gray-700 mb-3">Courts</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {courts.map((court) => (
                <CourtCard
                  key={court.id}
                  court={court}
                  gameLengthMinutes={GAME_LENGTH_MINUTES}
                  onEndGame={handleEndGame}
                />
              ))}
            </div>
          </div>

          {/* Right: Queue */}
          <div className="space-y-6">
            {/* Next Up */}
            <div className="bg-green-600 text-white rounded-lg shadow p-4">
              <h2 className="text-lg font-semibold mb-3">Next Up</h2>
              {nextUp.length === 0 ? (
                <p className="text-green-100">No one waiting</p>
              ) : (
                <ul className="space-y-2">
                  {nextUp.map((player, index) => (
                    <li
                      key={player.id}
                      className="bg-green-700/50 rounded-md px-3 py-2 flex items-center gap-2"
                    >
                      <span className="text-green-200 font-semibold text-sm">
                        #{index + 1}
                      </span>
                      <span className="font-medium">{player.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Rest of Queue */}
            <div className="bg-white rounded-lg shadow p-4">
              <details>
                <summary className="text-lg font-semibold text-gray-700 cursor-pointer select-none">
                  Rest of Queue {restOfQueue.length > 0 && `(${restOfQueue.length})`}
                </summary>
                <div className="mt-3">
                  {restOfQueue.length === 0 ? (
                    <p className="text-gray-400">—</p>
                  ) : (
                    <ul className="space-y-1 max-h-64 overflow-y-auto">
                      {restOfQueue.map((player) => (
                        <li key={player.id} className="text-gray-600 px-2 py-1">
                          {player.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            </div>

            {/* Full waiting queue with actions */}
            <div className="bg-white rounded-lg shadow p-4">
              <details open>
                <summary className="text-lg font-semibold text-gray-700 cursor-pointer select-none">
                  Waiting Queue {players.length > 0 && `(${players.length})`}
                </summary>
                <div className="mt-3">
                  {players.length === 0 ? (
                    <p className="text-gray-400">No players waiting</p>
                  ) : (
                    <ul className="space-y-2 max-h-64 overflow-y-auto">
                      {players.map((player) => (
                        <li
                          key={player.id}
                          className="flex items-center justify-between bg-gray-50 rounded-md px-3 py-2"
                        >
                          <span className="text-gray-800">{player.name}</span>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSkipPlayer(player.id)}
                              className="text-xs font-medium bg-gray-200 hover:bg-gray-300 text-gray-700 px-2 py-1 rounded transition-colors"
                            >
                              Skip
                            </button>
                            <button
                              onClick={() => handleRemovePlayer(player.id)}
                              className="text-xs font-medium bg-red-100 hover:bg-red-200 text-red-700 px-2 py-1 rounded transition-colors"
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
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-semibold text-gray-800 mb-3">
              Enter Players (Separated by ,)
            </h2>
            <textarea
              value={batchInput}
              onChange={(e) => setBatchInput(e.target.value)}
              placeholder="e.g. Dave, Sarah, Carlos, Elena"
              rows={4}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowBatchModal(false);
                  setBatchInput('');
                }}
                className="px-4 py-2 rounded-md text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddBatchPlayers}
                className="bg-green-600 hover:bg-green-700 text-white font-medium px-4 py-2 rounded-md transition-colors"
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