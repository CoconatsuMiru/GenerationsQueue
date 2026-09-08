import type { Court } from './types';

interface CourtCardProps {
  court: Court;
  gameLengthMinutes: number;
  warmupMinutes: number;
  onEndGame: (courtId: number) => void;
}

function CourtCard({ court, gameLengthMinutes, warmupMinutes, onEndGame }: CourtCardProps) {
  const isOpen = court.players.length === 0;
  const isWarmingUp = !isOpen && isInWarmup(court.startTime, warmupMinutes);

  return (
    <div
      className={`relative overflow-hidden rounded-xl shadow-md hover:shadow-lg transition-shadow p-5 min-w-[200px] ${
        isOpen ? 'bg-white' : isWarmingUp ? 'bg-linear-to-br from-white to-yellow-50' : 'bg-linear-to-br from-white to-green-50'
      }`}
    >
      <div
        className={`absolute top-0 left-0 right-0 h-1.5 ${
          isOpen ? 'bg-gray-200' : isWarmingUp ? 'bg-yellow-400' : 'bg-green-500'
        }`}
      />

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-bold text-gray-800 tracking-tight">{court.name}</h3>
        <span
          className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
            isOpen
              ? 'bg-gray-100 text-gray-500'
              : isWarmingUp
              ? 'bg-yellow-100 text-yellow-700'
              : 'bg-green-100 text-green-700'
          }`}
        >
          {!isOpen && (
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isWarmingUp ? 'bg-yellow-500' : 'bg-green-500 animate-pulse'
              }`}
            />
          )}
          {isOpen ? 'Open' : isWarmingUp ? 'Warmup' : 'Live'}
        </span>
      </div>

      {isOpen ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mb-2">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <p className="text-gray-400 text-sm">Waiting for next players</p>
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-x-2 gap-y-1.5 mb-4">
            {court.players.map((player) => (
              <li
                key={player.id}
                className="text-sm font-medium text-gray-700 bg-white/70 rounded-md px-2 py-1 truncate"
              >
                {player.name}
              </li>
            ))}
          </ul>

          <div
            className={`rounded-lg px-3 py-2 mb-3 text-center ${
              isWarmingUp ? 'bg-yellow-100/70' : 'bg-green-100/70'
            }`}
          >
            <p
              className={`text-sm font-semibold tabular-nums ${
                isWarmingUp ? 'text-yellow-700' : 'text-green-700'
              }`}
            >
              {getTimeDisplay(court.startTime, gameLengthMinutes, warmupMinutes)}
            </p>
          </div>

          <button
            onClick={() => onEndGame(court.id)}
            className="w-full bg-red-500 hover:bg-red-600 active:scale-[0.98] text-white text-sm font-semibold py-2 rounded-lg transition-all"
          >
            End Game
          </button>
        </>
      )}
    </div>
  );
}

function isInWarmup(startTime: number | null, warmupMinutes: number): boolean {
  if (startTime === null) return false;
  const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
  return elapsedSec < warmupMinutes * 60;
}

function getTimeDisplay(
  startTime: number | null,
  gameLengthMinutes: number,
  warmupMinutes: number
): string {
  if (startTime === null) return '';

  const totalElapsedSec = Math.floor((Date.now() - startTime) / 1000);
  const warmupSec = warmupMinutes * 60;

  if (totalElapsedSec < warmupSec) {
    const warmupRemaining = warmupSec - totalElapsedSec;
    return `Warmup — starts in ${formatTime(warmupRemaining)}`;
  }

  const gameElapsedSec = totalElapsedSec - warmupSec;
  const gameTotalSec = gameLengthMinutes * 60;
  const gameRemainingSec = Math.max(gameTotalSec - gameElapsedSec, 0);

  return `${formatTime(gameRemainingSec)} remaining`;
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default CourtCard;