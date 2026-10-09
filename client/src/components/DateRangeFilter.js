import React, { useState } from 'react';
import { Popover, DatePicker, BlockStack, InlineStack, Text, Button, Box } from '@shopify/polaris';

// Date range filter (2026-10-09, Hera) — replaces the old ALL / Today /
// 7 days / 30 days <select> on Weekly Inventory Count, Manual Inventory
// Count and Stock Loss. Click the button → a Polaris calendar opens in
// "From" mode; the first click picks From, the calendar switches to "To"
// mode, the second click picks To and the popover closes with the range
// applied.
//
// Rules:
//   - To can't be before From: if the second click lands on an earlier day,
//     that day becomes the new From and the picker stays in "To" mode.
//   - Same day for From and To is allowed (filters that one day).
//   - Future days are disabled.
//   - Closing the popover half-way (From picked, To not yet) discards the
//     half-picked From and keeps the previous range.
//   - "Clear" goes back to ALL (no date filter).
//
// value: null (= ALL) or { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }. Both
// days are inclusive; the server compares them against the row's
// America/Toronto calendar day (dateFrom / dateTo query params).

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function toYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Same "2026.SEP.01" style as the tables' Date column.
function displayYmd(s) {
  const d = fromYmd(s);
  return `${d.getFullYear()}.${MONTHS[d.getMonth()]}.${String(d.getDate()).padStart(2, '0')}`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function DateRangeFilter({ label = 'Date', value, onChange }) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(null); // Date while in "To" mode, else null
  const initial = value ? fromYmd(value.from) : new Date();
  const [view, setView] = useState({ month: initial.getMonth(), year: initial.getFullYear() });

  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const openPicker = () => {
    const base = value ? fromYmd(value.from) : new Date();
    setView({ month: base.getMonth(), year: base.getFullYear() });
    setDraftFrom(null);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setDraftFrom(null);
  };

  // Polaris hands back a {start, end} range; work out which day was
  // actually clicked from it and run our own From → To steps.
  const handleChange = (range) => {
    if (!draftFrom) {
      setDraftFrom(range.start);
      return;
    }
    const clicked = sameDay(range.start, draftFrom) ? range.end : range.start;
    if (clicked < draftFrom && !sameDay(clicked, draftFrom)) {
      setDraftFrom(clicked); // earlier than From → becomes the new From
      return;
    }
    onChange({ from: toYmd(draftFrom), to: toYmd(clicked) });
    close();
  };

  const displayText = value
    ? (value.from === value.to ? displayYmd(value.from) : `${displayYmd(value.from)} – ${displayYmd(value.to)}`)
    : 'ALL';

  // Button looks the same as MultiSelectDropdown's so the filter row lines up.
  const activator = (
    <button
      type="button"
      onClick={open ? close : openPicker}
      style={{
        width: '100%', padding: '0 28px 0 10px',
        border: '1px solid #c9cccf', borderRadius: '8px',
        background: 'white', cursor: 'pointer', textAlign: 'left',
        fontSize: '14px', position: 'relative',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        height: '36px', lineHeight: '36px',
        boxSizing: 'border-box',
      }}
    >
      {displayText}
      <span style={{
        position: 'absolute', right: '8px', top: '50%',
        transform: 'translateY(-50%)', pointerEvents: 'none',
      }}>▾</span>
    </button>
  );

  return (
    <div style={{ position: 'relative', minWidth: '140px' }}>
      {label && (
        <div style={{ fontSize: '13px', color: '#6d7175', marginBottom: '4px', lineHeight: '1.4', fontWeight: '400' }}>{label}</div>
      )}
      <Popover active={open} activator={activator} onClose={close} preferredAlignment="left" autofocusTarget="none">
        <Box padding="400" minWidth="300px">
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="200">
              <Text variant="headingSm" as="p">
                {draftFrom ? 'Select To date' : 'Select From date'}
              </Text>
              {value && (
                <Button variant="plain" onClick={() => { onChange(null); close(); }}>Clear</Button>
              )}
            </InlineStack>
            <Text tone="subdued" variant="bodySm" as="p">
              {draftFrom
                ? `From: ${displayYmd(toYmd(draftFrom))}`
                : (value ? `Current: ${displayText}` : 'Current: ALL')}
            </Text>
            <DatePicker
              month={view.month}
              year={view.year}
              onMonthChange={(month, year) => setView({ month, year })}
              onChange={handleChange}
              selected={draftFrom ? { start: draftFrom, end: draftFrom } : undefined}
              allowRange
              disableDatesAfter={today}
            />
          </BlockStack>
        </Box>
      </Popover>
    </div>
  );
}

export default DateRangeFilter;
