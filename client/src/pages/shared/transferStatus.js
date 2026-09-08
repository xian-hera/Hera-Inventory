// Shared status-badge styling + label helper for the Transfer feature.
// Colors match the 7-status walkthrough Hera gave (see
// claude/TRANSFER_FEATURE_SPEC.md section 4): Loading yellow, Pending
// red/maroon, Good to go pink, In transit blue, Receiving cyan, Counted
// green, Committed gray. Shared because every Buyer/Warehouse/Manager list
// and detail page renders the same badge — unlike the rest of this codebase's
// convention of duplicating small page-local helpers, this one is reused
// verbatim by ~10 different pages, so a real shared module is worth it here.

export const STATUS_LABELS = {
  loading: 'Loading',
  pending: 'Pending',
  good_to_go: 'Good to Go',
  in_transit: 'In transit',
  receiving: 'Receiving',
  counted: 'Counted',
  committed: 'Committed',
};

const STATUS_COLORS = {
  loading:     { bg: '#FFF3B0', fg: '#5C4A00' },
  pending:     { bg: '#8E1F1F', fg: '#FFFFFF' },
  good_to_go:  { bg: '#F7C6DE', fg: '#7A1E4E' },
  in_transit:  { bg: '#B7CBEF', fg: '#1F3D7A' },
  receiving:   { bg: '#B6EEF2', fg: '#0B5C61' },
  counted:     { bg: '#B8E9C9', fg: '#1B5E2E' },
  committed:   { bg: '#E1E3E5', fg: '#3F4448' },
};

// Warehouse-only display override (spec doc section 5, confirmed): a
// "Pick up from store" task shown as Good to go reads as "Ready for Pick up"
// to Warehouse. The underlying status value never changes — this is purely
// a label swap for rendering.
export function warehouseStatusLabel(status, isPickupFromStore) {
  if (status === 'good_to_go' && isPickupFromStore) return 'Ready for Pick up';
  return STATUS_LABELS[status] || status;
}

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
