import type { SkillLevel } from './types';
import { createElement } from 'react';

export const SKILL_LEVELS: SkillLevel[] = ['beginner', 'intermediate', 'advanced'];

export const SKILL_BADGE: Record<SkillLevel, { label: string; classes: string }> = {
  beginner: { label: 'B', classes: 'bg-gray-200 text-gray-600' },
  intermediate: { label: 'I', classes: 'bg-blue-100 text-blue-600' },
  advanced: { label: 'A', classes: 'bg-purple-100 text-purple-600' },
};

export function SkillBadge({ level }: { level: SkillLevel }) {
  const badge = SKILL_BADGE[level];
  return createElement(
    'span',
    {
      className: `shrink-0 text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center ${badge.classes}`,
      title: level,
    },
    badge.label,
  );
}