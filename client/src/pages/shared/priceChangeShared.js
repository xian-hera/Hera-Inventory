// Price Change — shared bits for buyer and store pages (2026-10-08, Hera).
// Spec: claude/PRICE_CHANGE_SCHEDULE_REVERSE_SPEC.md
import React from 'react';

export const TIMEZONE = 'America/Toronto';

// Task types: value stored in the DB → label + dot colour.
export const TASK_TYPES = [
  { value: 'regular', label: 'Regular', color: '#4fb3ea', help: 'Update Price ONLY' },
  { value: 'promotion', label: 'Promotion', color: '#f2c94c', help: 'Update Price and Compare-at Price ONLY' },
  { value: 'discontinued', label: 'Discontinued', color: '#e5483a', help: 'Update Price and Compare-at Price, Discontinued metafield, and adding @ to custom.name, or replace #' },
];
export const taskTypeOf = (v) => TASK_TYPES.find(t => t.value === v) || null;

export function TaskTypeDot({ type, size = 10 }) {
  const t = taskTypeOf(type);
  if (!t) return null;
  return <span aria-hidden="true" style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: t.color, flex: '0 0 auto' }} />;
}

export function TaskTypeLabel({ type, fallback = '' }) {
  const t = taskTypeOf(type);
  if (!t) return <span>{fallback}</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <TaskTypeDot type={type} />{t.label}
    </span>
  );
}

// "Ex. HQ, MTL01" — the locations NOT selected (Hera 2026-10-08).
export function excludedText(selected, all) {
  const sel = new Set(selected || []);
  const excluded = (all || []).filter(n => !sel.has(n));
  if (!(selected || []).length) return 'None';
  return excluded.length ? `Ex. ${excluded.join(', ')}` : 'All locations';
}

// Date in Toronto: { date: 'YYYY-MM-DD', time: 'HH:MM' }.
export function torontoParts(value) {
  if (!value) return { date: '', time: '' };
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(value)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// "2026.OCT.09 14:30" in Toronto time (same style as the existing lists).
export function formatToronto(value) {
  if (!value) return '';
  const { date, time } = torontoParts(value);
  const [y, m, d] = date.split('-');
  return `${y}.${MONTHS[Number(m) - 1]}.${d} ${time}`;
}

export const money = (v) => (v === null || v === undefined || v === '' ? '—' : `$${Number(v).toFixed(2)}`);

export const isWigType = (t) => String(t || '').trim().toLowerCase() === 'wig';
