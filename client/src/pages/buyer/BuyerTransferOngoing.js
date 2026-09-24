import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, Spinner, Banner, Popover, Checkbox
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { STATUS_LABELS, StatusBadge, HoldBadge, AutoCommittedBadge } from '../shared/transferStatus';
import { fetchLocationMap } from '../shared/locationMap';

// Buyer's Ongoing Transfer list — every transfer, all statuses (this page
// used to exclude 'committed'/'archived' server-side; as of 2026-09-16 the
// server just returns everything and this page's own Status/From/To filters
// decide what's visible — see the "2026-09-16 UI 改动" note below).
// Delete selected removes whole transfers (Loading/Pending only,
// server-enforced); Commit selected runs the Commit logic per selected
// Counted transfer. Spec doc section 3/4.
//
// 改动三 (2026-09-15): "Archived" is a real status — a fully-counted,
// no-qty-issue transfer is auto-committed AND immediately archived, so it
// never rests at a visible "committed" state.
//
// 2026-09-16 UI 改动 (见 claude/TRANSFER_FEATURE_SPEC.md 第 13 节):
// - Removed the old "Show archived" checkbox (and the server-side
//   includeArchived param it drove) in favor of three proper filters below.
// - Delete Selected / Commit Selected moved to the top-right, same row as
//   the filters, right-aligned; labels are now Title Case.
// - Status/From/To filters are pure front-end — this page fetches every
//   transfer once and filters the in-memory list; nothing is sent to the
//   server for this. Status filter options are the 8 statuses a transfer
//   can currently be created/advanced into (deliberately NOT including the
//   legacy 'committed' value some pre-2026-09-15 rows may still carry — a
//   row stuck at that old status is invisible on this page now, by Hera's
//   explicit choice). From/To options come from the full Shopify location
//   list (/api/shopify/locations, same endpoint Create Transfer uses), not
//   just locations seen in the current transfer list.
const STATUS_FILTER_VALUES = [
  'loading', 'pending', 'good_to_go', 'in_transit', 'receiving', 'counted', 'not_counted', 'archived',
];
const DEFAULT_STATUS_SELECTION = STATUS_FILTER_VALUES.filter(s => s !== 'archived');

// Tags filter sentinel (2026-09-23, Hera) — its own checkbox in the Tags
// filter's list, alongside every Tag pool tag (see TAG_FILTER_ALL usage
// below). Selecting it means "don't filter by tag at all", which is also
// this filter's default and its fallback once every specific tag gets
// unchecked — a transfer with no tags at all only ever matches this state.
const TAG_FILTER_ALL = '__all__';

// Same small-pill look as BuyerTransferCreate.js's TAG_CHIP_STYLE (kept as
// its own copy here rather than a shared import, matching how this file
// already duplicates its own small style constants rather than reaching
// into sibling pages).
const TAG_PILL_STYLE = {
  display: 'inline-flex', alignItems: 'center',
  padding: '2px 8px', borderRadius: '12px',
  background: '#e4e5e7', fontSize: '12px', whiteSpace: 'nowrap',
};

function toggleInList(list, value) {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value];
}

// Shared Popover+Checkbox-list multi-select — used for all four filters.
// `selected: null` means "not yet initialized" (still waiting on data the
// options themselves depend on, e.g. locations) and is treated as "show
// everything" by the caller's filter predicate, not as "nothing selected".
// `showSelectAll` (2026-09-23, Hera — From/To only) adds two buttons above
// the checkbox list that select/deselect every option in one click.
function MultiSelectFilter({ label, options, selected, onChange, showSelectAll }) {
  const [open, setOpen] = useState(false);
  const current = selected || [];
  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      activator={
        <Button onClick={() => setOpen(v => !v)} disclosure={open ? 'up' : 'down'}>
          {label}
        </Button>
      }
    >
      <Popover.Section>
        <BlockStack gap="150">
          {showSelectAll && (
            <InlineStack gap="150">
              <Button variant="plain" onClick={() => onChange(options.map(o => o.value))}>Select all</Button>
              <Button variant="plain" onClick={() => onChange([])}>Deselect all</Button>
            </InlineStack>
          )}
          {options.map(opt => (
            <Checkbox
              key={opt.value}
              label={opt.label}
              checked={current.includes(opt.value)}
              onChange={() => onChange(toggleInList(current, opt.value))}
            />
          ))}
        </BlockStack>
      </Popover.Section>
    </Popover>
  );
}

function BuyerTransferOngoing() {
  const navigate = useNavigate();
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [deleting, setDeleting] = useState(false);
  const [committing, setCommitting] = useState(false);

  const [selectedStatuses, setSelectedStatuses] = useState(DEFAULT_STATUS_SELECTION);
  const [locationNames, setLocationNames] = useState([]);
  const [selectedFrom, setSelectedFrom] = useState(null); // null until locations load, see MultiSelectFilter
  const [selectedTo, setSelectedTo] = useState(null);

  // Tags filter (2026-09-23, Hera) — options come from the Tag pool
  // (BuyerTransferSettings.js's list, same GET /api/transfers/tags the
  // Create Transfer page uses), not from tags actually seen on current
  // transfers, same reasoning as From/To using the full location list.
  const [tagPool, setTagPool] = useState([]);
  const [selectedTags, setSelectedTags] = useState([TAG_FILTER_ALL]);

  const fetchOngoing = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/ongoing');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfers(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOngoing(); }, [fetchOngoing]);

  // Tags filter options — the Tag pool, fetched once (same endpoint Create
  // Transfer's tag picker uses). Left empty on failure — the filter then
  // just shows the "All" checkbox with nothing else to pick.
  useEffect(() => {
    fetch('/api/transfers/tags')
      .then(res => res.json())
      .then(data => setTagPool(Array.isArray(data) ? data.map(t => t.tag) : []))
      .catch(() => setTagPool([]));
  }, []);

  // From/To filter options — full Shopify location list, not just whatever
  // shows up in the current transfers. Defaults to "everything checked".
  useEffect(() => {
    fetchLocationMap() // shared location map (2026-09-24)
      .then(data => {
        const names = (Array.isArray(data) ? data : []).map(l => l.name).filter(Boolean);
        setLocationNames(names);
        setSelectedFrom(names);
        setSelectedTo(names);
      })
      .catch(() => {
        setLocationNames([]);
        setSelectedFrom([]);
        setSelectedTo([]);
      });
  }, []);

  // Tags filter's "All" checkbox behaves like a select/deselect toggle
  // rather than an ordinary list member (2026-09-23, Hera spec): checking
  // "All" clears every specific tag and shows everything again; checking
  // any specific tag drops "All"; unchecking the last remaining specific
  // tag falls back to "All" rather than leaving the filter matching
  // nothing. MultiSelectFilter still just hands back its own toggled list —
  // this wrapper reconciles that against TAG_FILTER_ALL before storing it.
  const handleTagsChange = (newList) => {
    const hadAll = selectedTags.includes(TAG_FILTER_ALL);
    const hasAllNow = newList.includes(TAG_FILTER_ALL);
    if (hasAllNow && !hadAll) {
      setSelectedTags([TAG_FILTER_ALL]);
      return;
    }
    const cleaned = newList.filter(v => v !== TAG_FILTER_ALL);
    setSelectedTags(cleaned.length > 0 ? cleaned : [TAG_FILTER_ALL]);
  };

  const visibleTransfers = transfers.filter(tr => (
    selectedStatuses.includes(tr.status)
    && (selectedTags.includes(TAG_FILTER_ALL) || selectedTags.some(t => (tr.tags || []).includes(t)))
    && (selectedFrom === null || selectedFrom.includes(tr.from_location))
    && (selectedTo === null || selectedTo.includes(tr.to_location))
  ));

  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleSelectAll = () => {
    setSelectedIds(selectedIds.length === visibleTransfers.length ? [] : visibleTransfers.map(t => t.id));
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedIds.length} transfer(s)? This cannot be undone.`)) return;
    setDeleting(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/delete-selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSelectedIds([]);
      await fetchOngoing();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  const handleCommitSelected = async () => {
    if (selectedIds.length === 0) return;
    setCommitting(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/commit-selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      const failed = (data.results || []).filter(r => !r.success);
      if (failed.length > 0) setError(`${failed.length} transfer(s) failed to commit: ${failed.map(f => f.error).join('; ')}`);
      setSelectedIds([]);
      await fetchOngoing();
    } catch (e) {
      setError(e.message);
    } finally {
      setCommitting(false);
    }
  };

  const statusOptions = STATUS_FILTER_VALUES.map(v => ({ value: v, label: STATUS_LABELS[v] || v }));
  const tagFilterOptions = [{ value: TAG_FILTER_ALL, label: 'All' }, ...tagPool.map(t => ({ value: t, label: t }))];
  const locationOptions = locationNames.map(n => ({ value: n, label: n }));

  return (
    <Page title="Ongoing Transfer" backAction={{ onAction: () => navigate('/buyer/transfer') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <InlineStack align="space-between" blockAlign="center" wrap>
              <InlineStack gap="200" wrap>
                <MultiSelectFilter
                  label="Status"
                  options={statusOptions}
                  selected={selectedStatuses}
                  onChange={setSelectedStatuses}
                />
                <MultiSelectFilter
                  label="Tags"
                  options={tagFilterOptions}
                  selected={selectedTags}
                  onChange={handleTagsChange}
                />
                <MultiSelectFilter
                  label="From"
                  options={locationOptions}
                  selected={selectedFrom}
                  onChange={setSelectedFrom}
                  showSelectAll
                />
                <MultiSelectFilter
                  label="To"
                  options={locationOptions}
                  selected={selectedTo}
                  onChange={setSelectedTo}
                  showSelectAll
                />
              </InlineStack>
              <InlineStack gap="200" wrap>
                <Button
                  tone="critical"
                  disabled={selectedIds.length === 0}
                  loading={deleting}
                  onClick={handleDeleteSelected}
                >
                  Delete Selected ({selectedIds.length})
                </Button>
                <Button
                  variant="primary"
                  disabled={selectedIds.length === 0}
                  loading={committing}
                  onClick={handleCommitSelected}
                >
                  Commit Selected
                </Button>
              </InlineStack>
            </InlineStack>

            <Card>
              {loading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : visibleTransfers.length === 0 ? (
                <Text tone="subdued">No ongoing transfers.</Text>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={{ padding: '8px 10px', width: '32px' }}>
                          <input
                            type="checkbox"
                            checked={visibleTransfers.length > 0 && selectedIds.length === visibleTransfers.length}
                            onChange={toggleSelectAll}
                          />
                        </th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Tags</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>From</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>To</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTransfers.map(tr => (
                        <tr key={tr.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                          <td style={{ padding: '8px 10px' }}>
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(tr.id)}
                              onChange={(e) => { e.stopPropagation(); toggleSelect(tr.id); }}
                            />
                          </td>
                          <td
                            style={{ padding: '10px', cursor: 'pointer', textDecoration: 'underline' }}
                            onClick={() => navigate(`/buyer/transfer/${tr.id}`)}
                          >
                            {tr.shopify_transfer_name || tr.transfer_no}
                          </td>
                          <td style={{ padding: '10px' }}>
                            {(tr.tags || []).length > 0 && (
                              <InlineStack gap="100" wrap>
                                {tr.tags.map(tag => (
                                  <span key={tag} style={TAG_PILL_STYLE}>{tag}</span>
                                ))}
                              </InlineStack>
                            )}
                          </td>
                          <td style={{ padding: '10px' }}>{tr.from_location}</td>
                          <td style={{ padding: '10px' }}>{tr.to_location}</td>
                          <td style={{ padding: '10px' }}>
                            <InlineStack gap="150" blockAlign="center">
                              <StatusBadge status={tr.status} />
                              {tr.on_hold && <HoldBadge />}
                              {tr.auto_committed && <AutoCommittedBadge />}
                            </InlineStack>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerTransferOngoing;
