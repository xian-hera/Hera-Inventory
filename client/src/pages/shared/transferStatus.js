// Shared status-badge styling + label helper for the Transfer feature.
// Colors match the 7-status walkthrough Hera gave (see
// claude/TRANSFER_FEATURE_SPEC.md section 4): Loading yellow, Pending
// red/maroon, Good to go pink, In transit blue, Receiving cyan, Counted
// green, Committed gray. Shared because every Buyer/Warehouse/Manager list
// and detail page renders the same badge — unlike the rest of this codebase's
// convention of duplicating small page-local helpers, this one is reused
// verbatim by ~10 different pages, so a real shared module is worth it here.

// 2026-09-15 additions (spec doc section 11): 'not_counted' — Warehouse's
// "Submit Without Counting" on a Receiving to HQ transfer (改动二), shown to
// Buyer as a light-red pill so it reads as "needs your attention" without
// being as alarming as Pending's dark red. 'archived' replaces 'committed' as
// the terminal status everything actually rests at post-commit now (改动三)
// — kept the same gray since it's the direct successor to what 'committed'
// used to mean; 'committed' itself is kept in STATUS_LABELS/COLORS only so a
// pre-migration row (or a stray old reference) still renders instead of
// falling back to the raw string.
export const STATUS_LABELS = {
  loading: 'Loading',
  pending: 'Pending',
  good_to_go: 'Good to Go',
  in_transit: 'In transit',
  receiving: 'Receiving',
  counted: 'Counted',
  not_counted: 'Not counted',
  committed: 'Committed',
  archived: 'Archived',
};

const STATUS_COLORS = {
  loading:     { bg: '#FFF3B0', fg: '#5C4A00' },
  pending:     { bg: '#8E1F1F', fg: '#FFFFFF' },
  good_to_go:  { bg: '#F7C6DE', fg: '#7A1E4E' },
  in_transit:  { bg: '#B7CBEF', fg: '#1F3D7A' },
  receiving:   { bg: '#B6EEF2', fg: '#0B5C61' },
  counted:     { bg: '#B8E9C9', fg: '#1B5E2E' },
  not_counted: { bg: '#FBD7D3', fg: '#8E1F1F' },
  committed:   { bg: '#E1E3E5', fg: '#3F4448' },
  archived:    { bg: '#E1E3E5', fg: '#3F4448' },
};

// Hold pill (改动六) — a small red "Hold" badge shown next to the status pill
// wherever a transfer is on_hold (Buyer's Ongoing list, every detail page's
// title). Separate component from StatusBadge since it's an attribute
// alongside the status, not a status itself.
export function HoldBadge() {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: '999px',
      background: '#fed3d1', color: '#8e1f1f', fontSize: '12px', fontWeight: 700,
      whiteSpace: 'nowrap',
    }}>
      Hold
    </span>
  );
}

// Auto-committed pill (改动三) — shown next to the status pill only when the
// Ongoing list's Archived filter is on, per Hera's spec ("当 filter 显示
// Archived 的时候，auto-committed 这个 attribute 需要从列表上就能看到").
export function AutoCommittedBadge() {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: '999px',
      background: '#e0d1f7', color: '#4a2a7a', fontSize: '12px', fontWeight: 700,
      whiteSpace: 'nowrap',
    }}>
      Auto-committed
    </span>
  );
}

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
