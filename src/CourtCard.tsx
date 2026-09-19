import type { Court } from './types';
import { isSpeechSupported } from './speech';
import { SkillBadge } from './skillLevels';

interface CourtCardProps {
  court: Court;
  gameLengthMinutes: number;
  warmupMinutes: number;
  overtimeMinutes: number;
  timeBased: boolean;
  onEndGame: (courtId: number) => void;
  onAnnounce: (courtId: number) => void;
  onRecordWin: (courtId: number, side: 'a' | 'b') => void;
}

type Phase = 'open' | 'warmup' | 'playing' | 'overtime';

function CourtCard({
  court,
  gameLengthMinutes,
  warmupMinutes,
  overtimeMinutes,
  timeBased,
  onEndGame,
  onAnnounce,
  onRecordWin,
}: CourtCardProps) {
  const phase = getPhase(court, warmupMinutes, gameLengthMinutes, timeBased);

  const cardBg =
    phase === 'open'
      ? 'bg-white'
      : phase === 'warmup'
      ? 'bg-linear-to-br from-white to-yellow-50'
      : phase === 'overtime'
      ? 'bg-linear-to-br from-white to-orange-50'
      : 'bg-linear-to-br from-white to-green-50';

  const accentBar =
    phase === 'open'
      ? 'bg-gray-200'
      : phase === 'warmup'
      ? 'bg-yellow-400'
      : phase === 'overtime'
      ? 'bg-orange-500'
      : 'bg-green-500';

  const badgeStyle =
    phase === 'open'
      ? 'bg-gray-100 text-gray-500'
      : phase === 'warmup'
      ? 'bg-yellow-100 text-yellow-700'
      : phase === 'overtime'
      ? 'bg-orange-100 text-orange-700'
      : 'bg-green-100 text-green-700';

  const badgeLabel =
    phase === 'open' ? 'Open' : phase === 'warmup' ? 'Warmup' : phase === 'overtime' ? 'Overtime' : 'Live';

  const timeBoxStyle =
    phase === 'overtime' ? 'bg-orange-100/70' : phase === 'warmup' ? 'bg-yellow-100/70' : 'bg-green-100/70';

  const timeTextStyle =
    phase === 'overtime' ? 'text-orange-700' : phase === 'warmup' ? 'text-yellow-700' : 'text-green-700';

  // Team split convention: player_ids (and therefore court.players, once
  // loaded in the correct order) always stores Team A's 2 players first,
  // then Team B's 2 — see orderGroupIntoTeams in Dashboard.tsx.
  const teamA = court.players.slice(0, 2);
  const teamB = court.players.slice(2, 4);

  return (
    <div
      className={`relative overflow-hidden rounded-xl shadow-md hover:shadow-lg transition-shadow p-5 min-w-[200px] ${cardBg}`}
    >
      <div className={`absolute top-0 left-0 right-0 h-1.5 ${accentBar}`} />

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-bold text-gray-800 tracking-tight">{court.name}</h3>
        <span className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${badgeStyle}`}>
          {phase !== 'open' && (
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                phase === 'playing' ? 'bg-green-500 animate-pulse' : phase === 'overtime' ? 'bg-orange-500 animate-pulse' : 'bg-yellow-500'
              }`}
            />
          )}
          {badgeLabel}
        </span>
      </div>

      {phase === 'open' ? (
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
          {/* Court design: two clickable sides split by a net line.
              Tapping a side records that side's 2 players as the winners —
              credits a win each, logs the match, then clears the court. */}
          <div className="flex border border-gray-300 rounded-lg overflow-hidden mb-3">
            <button
              onClick={() => onRecordWin(court.id, 'a')}
              title="Tap if this side won"
              className="flex-1 flex flex-col divide-y divide-gray-200 hover:bg-green-50 active:bg-green-100 transition-colors"
            >
              {teamA.map((player) => (
                <div
                  key={player.id}
                  className="flex items-center gap-1.5 px-2 py-2 text-sm font-medium text-gray-700 truncate"
                >
                  <SkillBadge level={player.skillLevel} />
                  {player.name}
                </div>
              ))}
            </button>

            <div className="w-0.5 bg-gray-300" />

            <button
              onClick={() => onRecordWin(court.id, 'b')}
              title="Tap if this side won"
              className="flex-1 flex flex-col divide-y divide-gray-200 hover:bg-green-50 active:bg-green-100 transition-colors"
            >
              {teamB.map((player) => (
                <div
                  key={player.id}
                  className="flex items-center gap-1.5 px-2 py-2 text-sm font-medium text-gray-700 truncate"
                >
                  <SkillBadge level={player.skillLevel} />
                  {player.name}
                </div>
              ))}
            </button>
          </div>

          {timeBased && (
            <div className={`rounded-lg px-3 py-2 mb-3 text-center ${timeBoxStyle}`}>
              <p className={`text-sm font-semibold tabular-nums ${timeTextStyle}`}>
                {getTimeDisplay(court.startTime, gameLengthMinutes, warmupMinutes, overtimeMinutes)}
              </p>
            </div>
          )}

          {isSpeechSupported() && (
            <button
              onClick={() => onAnnounce(court.id)}
              className="w-full bg-blue-500 hover:bg-blue-600 active:scale-[0.98] text-white text-sm font-semibold py-2 rounded-lg transition-all mb-2"
            >
              🔊 Call Players
            </button>
          )}

          <button
            onClick={() => onEndGame(court.id)}
            className="w-full bg-red-500 hover:bg-red-600 active:scale-[0.98] text-white text-sm font-semibold py-2 rounded-lg transition-all"
          >
            End Game (no score)
          </button>
        </>
      )}
    </div>
  );
}

function getPhase(court: Court, warmupMinutes: number, gameLengthMinutes: number, timeBased: boolean): Phase {
  if (court.players.length === 0 || court.startTime === null) return 'open';
  if (!timeBased) return 'playing';

  const elapsedSec = Math.floor((Date.now() - court.startTime) / 1000);
  const warmupSec = warmupMinutes * 60;
  const gameEndSec = warmupSec + gameLengthMinutes * 60;

  if (elapsedSec < warmupSec) return 'warmup';
  if (elapsedSec < gameEndSec) return 'playing';
  return 'overtime';
}

function getTimeDisplay(
  startTime: number | null,
  gameLengthMinutes: number,
  warmupMinutes: number,
  overtimeMinutes: number
): string {
  if (startTime === null) return '';

  const totalElapsedSec = Math.floor((Date.now() - startTime) / 1000);
  const warmupSec = warmupMinutes * 60;
  const gameTotalSec = gameLengthMinutes * 60;
  const gameEndSec = warmupSec + gameTotalSec;
  const overtimeEndSec = gameEndSec + overtimeMinutes * 60;

  if (totalElapsedSec < warmupSec) {
    const warmupRemaining = warmupSec - totalElapsedSec;
    return `Warmup — starts in ${formatTime(warmupRemaining)}`;
  }

  if (totalElapsedSec < gameEndSec) {
    const gameElapsedSec = totalElapsedSec - warmupSec;
    const gameRemainingSec = gameTotalSec - gameElapsedSec;
    return `${formatTime(gameRemainingSec)} remaining`;
  }

  const overtimeElapsedSec = totalElapsedSec - gameEndSec;
  const overtimeRemainingSec = Math.max(overtimeEndSec - totalElapsedSec, 0);
  return `+${formatTime(overtimeElapsedSec)} overtime · clears in ${formatTime(overtimeRemainingSec)}`;
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default CourtCard;