import React from 'react';

// "When it got its current status" (2026-11-09, Hera): one format across the
// Store History cards and Purchasing's lists — "HH:MM, Oct. 12" (24-hour
// time, month abbreviation with a period, day without a leading zero; May has
// no period since it is not abbreviated). Values come from
// status_changed_at / label_at (server/database/statusTimes.js).
const MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

export function statusTimeText(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Same text; on a narrow column it may wrap after the comma (time / date),
// never inside either part.
export function StatusTime({ value, style }) {
  const text = statusTimeText(value);
  if (!text) return null;
  const [time, date] = text.split(', ');
  return (
    <span style={{ color: '#6d7175', fontSize: 13, ...style }}>
      <span style={{ whiteSpace: 'nowrap' }}>{time},</span>{' '}
      <span style={{ whiteSpace: 'nowrap' }}>{date}</span>
    </span>
  );
}
