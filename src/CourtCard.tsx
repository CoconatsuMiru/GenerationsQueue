import type { Court } from './types';

interface CourtCardProps {
  court: Court;
  gameLengthMinutes: number;
  onEndGame: (courtId: number) => void;
}

function CourtCard({ court, gameLengthMinutes, onEndGame }: CourtCardProps) {
  const isOpen = court.players.length === 0;

  return (
    <div
      className={`rounded-lg shadow p-4 min-w-[180px] border-t-4 ${
        isOpen ? 'bg-white border-gray-300' : 'bg-white border-green-500'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <strong className="text-gray-800">{court.name}</strong>
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            isOpen
              ? 'bg-gray-100 text-gray-500'
              : 'bg-green-100 text-green-700'
          }`}
        >
          {isOpen ? 'Open' : 'Playing'}
        </span>
      </div>

      {isOpen ? (
        <p className="text-gray-400 text-sm py-2">
          Waiting for next players
        </p>
      ) : (
        <>
          <ul className="text-sm text-gray-700 space-y-1 mb-3">
            {court.players.map((player) => (
              <li key={player.id}>{player.name}</li>
            ))}
          </ul>
          <p className="text-sm font-medium text-gray-600 mb-3">
            {getTimeDisplay(court.startTime, gameLengthMinutes)}
          </p>
          <button
            onClick={() => onEndGame(court.id)}
            className="w-full bg-red-500 hover:bg-red-600 text-white text-sm font-medium py-1.5 rounded-md transition-colors"
          >
            End Game
          </button>
        </>
      )}
    </div>
  );
}

function getTimeDisplay(startTime: number | null, gameLengthMinutes: number): string {
  if (startTime === null) return '';

  const elapsedMs = Date.now() - startTime;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const totalSec = gameLengthMinutes * 60;
  const remainingSec = Math.max(totalSec - elapsedSec, 0);

  return `Elapsed: ${formatTime(elapsedSec)} · Remaining: ${formatTime(remainingSec)}`;
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default CourtCard;