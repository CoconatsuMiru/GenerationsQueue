import type { Court, Player } from './types';
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
  onEdit: (courtId: number) => void;
}

type Phase = 'open' | 'warmup' | 'playing' | 'overtime';

// Court palette — deep teal surround, green service boxes, blue kitchen.
const APRON = 'bg-[#2f6b5f]';
const SERVICE = 'bg-[#4aa37a]';
const KITCHEN = 'bg-[#3b82c4]';
const LINE = 'border-white/90';

const NAME_STYLE =
  'min-w-0 truncate text-xs sm:text-sm font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.4)]';

// One service box. Left-side players hug the left baseline (badge, then
// name); right-side players hug the right baseline (name, then badge).
function PlayerCell({ player, side }: { player?: Player; side: 'left' | 'right' }) {
  const isLeft = side === 'left';

  return (
    <div
      className={`flex-1 min-h-0 min-w-0 flex items-center gap-1.5 px-2 sm:px-3 ${
        isLeft ? 'justify-start' : 'justify-end'
      }`}
    >
      {player &&
        (isLeft ? (
          <>
            <span className="shrink-0 flex">
              <SkillBadge level={player.skillLevel} />
            </span>
            <span className={NAME_STYLE}>{player.name}</span>
          </>
        ) : (
          <>
            <span className={NAME_STYLE}>{player.name}</span>
            <span className="shrink-0 flex">
              <SkillBadge level={player.skillLevel} />
            </span>
          </>
        ))}
    </div>
  );
}

// One half of the court (service boxes + its half of the kitchen). The
// whole half is a single tappable button that records that side as the
// winner.
function CourtHalf({
  players,
  side,
  disabled,
  onPick,
}: {
  players: Player[];
  side: 'left' | 'right';
  disabled: boolean;
  onPick: () => void;
}) {
  const isLeft = side === 'left';

  const service = (
    <div className={`flex flex-col h-full ${SERVICE} ${isLeft ? 'border-r-2' : 'border-l-2'} ${LINE}`}>
      <div className={`flex-1 min-h-0 flex border-b-2 ${LINE}`}>
        <PlayerCell player={players[0]} side={side} />
      </div>
      <div className="flex-1 min-h-0 flex">
        <PlayerCell player={players[1]} side={side} />
      </div>
    </div>
  );

  const kitchen = <div className={`h-full ${KITCHEN}`} />;

  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      title={disabled ? undefined : 'Tap if this side won'}
      className="relative block w-1/2 h-full transition enabled:hover:brightness-110 enabled:active:brightness-125 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-white"
    >
      <div
        className={`absolute inset-0 grid grid-rows-1 ${
          isLeft ? 'grid-cols-[15fr_7fr]' : 'grid-cols-[7fr_15fr]'
        }`}
      >
        {isLeft ? (
          <>
            {service}
            {kitchen}
          </>
        ) : (
          <>
            {kitchen}
            {service}
          </>
        )}
      </div>
    </button>
  );
}

function CourtCard({
  court,
  gameLengthMinutes,
  warmupMinutes,
  overtimeMinutes,
  timeBased,
  onEndGame,
  onAnnounce,
  onRecordWin,
  onEdit,
}: CourtCardProps) {
  const phase = getPhase(court, warmupMinutes, gameLengthMinutes, timeBased);
  const isOpen = phase === 'open';

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
  // Team A plays the left half of the court, Team B the right half.
  const teamA = court.players.slice(0, 2);
  const teamB = court.players.slice(2, 4);

  return (
    <div
      className={`relative overflow-hidden rounded-xl shadow-md hover:shadow-lg transition-shadow p-4 sm:p-5 ${cardBg}`}
    >
      <div className={`absolute top-0 left-0 right-0 h-1.5 ${accentBar}`} />

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-bold text-gray-800 tracking-tight">{court.name}</h3>
        <div className="flex items-center gap-2">
          {!isOpen && (
            <button
              onClick={() => onEdit(court.id)}
              title="Edit this court's players"
              className="flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 px-2.5 py-1 rounded-full transition-colors"
            >
              ✎ Edit
            </button>
          )}
          <span className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${badgeStyle}`}>
            {!isOpen && (
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  phase === 'playing' ? 'bg-green-500 animate-pulse' : phase === 'overtime' ? 'bg-orange-500 animate-pulse' : 'bg-yellow-500'
                }`}
              />
            )}
            {badgeLabel}
          </span>
        </div>
      </div>

      {/* Pickleball court, top-down: baseline | service boxes | kitchen | net | kitchen | service boxes | baseline */}
      <div className={`rounded-xl p-2.5 sm:p-3 shadow-inner ${APRON}`}>
        <div className="relative">
          <div className={`flex aspect-[44/20] overflow-hidden rounded-[3px] border-2 ${LINE}`}>
            <CourtHalf players={teamA} side="left" disabled={isOpen} onPick={() => onRecordWin(court.id, 'a')} />
            <CourtHalf players={teamB} side="right" disabled={isOpen} onPick={() => onRecordWin(court.id, 'b')} />
          </div>

          {/* Net */}
          <div className="pointer-events-none absolute left-1/2 -top-1.5 -bottom-1.5 w-1 -translate-x-1/2 rounded-full bg-white/95 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]" />

          {isOpen && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rounded-full bg-black/35 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-sm">
                Waiting for next players
              </span>
            </div>
          )}
        </div>
      </div>

      {!isOpen && (
        <>
          <p className="mt-2 mb-3 text-center text-[11px] text-gray-400">Tap the winning side to record the result</p>

          {timeBased && (
            <div className={`rounded-lg px-3 py-2 mb-3 text-center ${timeBoxStyle}`}>
              <p className={`text-sm font-semibold tabular-nums ${timeTextStyle}`}>
                {getTimeDisplay(court.startTime, gameLengthMinutes, warmupMinutes, overtimeMinutes)}
              </p>
            </div>
          )}

          <div className="flex gap-2">
            {isSpeechSupported() && (
              <button
                onClick={() => onAnnounce(court.id)}
                className="flex-1 bg-blue-500 hover:bg-blue-600 active:scale-[0.98] text-white text-sm font-semibold py-2 rounded-lg transition-all"
              >
                🔊 Call Players
              </button>
            )}
            <button
              onClick={() => onEndGame(court.id)}
              className="flex-1 bg-red-500 hover:bg-red-600 active:scale-[0.98] text-white text-sm font-semibold py-2 rounded-lg transition-all"
            >
              End Game (no score)
            </button>
          </div>
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