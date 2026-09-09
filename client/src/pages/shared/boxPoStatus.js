// Shared status-badge styling for the BOX PO feature (see
// claude/BOX_PO_FEATURE_SPEC.md section on statuses): incoming yellow,
// Received blue, Confirmed gray — same visual family as transferStatus.js.

export const STATUS_LABELS = {
  incoming: 'incoming',
  received: 'Received',
  confirmed: 'Confirmed',
};

const STATUS_COLORS = {
  incoming:  { bg: '#FFF3B0', fg: '#5C4A00' },
  received:  { bg: '#4DB8E8', fg: '#FFFFFF' },
  confirmed: { bg: '#E1E3E5', fg: '#3F4448' },
};

export function StatusBadge({ status, label }) {
  const colors = STATUS_COLORS[status] || { bg: '#E1E3E5', fg: '#3F4448' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '4px 12px',
        borderRadius: '999px',
        background: colors.bg,
        color: colors.fg,
        fontSize: '13px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label || STATUS_LABELS[status] || status}
    </span>
  );
}

// The orange dot warning shown next to a Received row's status badge when at
// least one line item's Box received doesn't match its BOX qty (spec:
// Ongoing BOX PO list + Warehouse detail page).
export function MismatchDot() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: '#FFA500',
        marginRight: '6px',
      }}
    />
  );
}
