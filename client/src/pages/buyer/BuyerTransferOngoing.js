import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, Spinner, Banner, Checkbox
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { StatusBadge, HoldBadge, AutoCommittedBadge } from '../shared/transferStatus';

// Buyer's Ongoing Transfer list — every non-committed transfer (all 7
// statuses except committed, which lives in the Recent/History views
// instead). Delete selected removes whole transfers (Loading/Pending only,
// server-enforced); Commit selected runs the Commit logic per selected
// Counted transfer. Spec doc section 3/4.
//
// 改动三 (2026-09-15): "Archived" is now a real status — a fully-counted,
// no-qty-issue transfer is auto-committed AND immediately archived, so it
// never rests at a visible "committed" state. This list defaults to hiding
// archived transfers (includeArchived=false server-side); the "Show
// archived" checkbox flips that on, and only then do auto-committed rows
// show their badge (per spec: badge only visible when this filter is on).
function BuyerTransferOngoing() {
  const navigate = useNavigate();
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [deleting, setDeleting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const fetchOngoing = useCallback(async (includeArchived) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/ongoing${includeArchived ? '?includeArchived=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfers(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOngoing(showArchived); }, [fetchOngoing, showArchived]);

  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleSelectAll = () => {
    setSelectedIds(selectedIds.length === transfers.length ? [] : transfers.map(t => t.id));
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
      await fetchOngoing(showArchived);
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
      await fetchOngoing(showArchived);
    } catch (e) {
      setError(e.message);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <Page title="Ongoing Transfer" backAction={{ onAction: () => navigate('/buyer/transfer') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <InlineStack gap="200" wrap>
              <Button
                tone="critical"
                disabled={selectedIds.length === 0}
                loading={deleting}
                onClick={handleDeleteSelected}
              >
                Delete selected ({selectedIds.length})
              </Button>
              <Button
                variant="primary"
                disabled={selectedIds.length === 0}
                loading={committing}
                onClick={handleCommitSelected}
              >
                Commit selected
              </Button>
              <Checkbox
                label="Show archived"
                checked={showArchived}
                onChange={setShowArchived}
              />
            </InlineStack>

            <Card>
              {loading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : transfers.length === 0 ? (
                <Text tone="subdued">No ongoing transfers.</Text>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={{ padding: '8px 10px', width: '32px' }}>
                          <input
                            type="checkbox"
                            checked={transfers.length > 0 && selectedIds.length === transfers.length}
                            onChange={toggleSelectAll}
                          />
                        </th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>From</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>To</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transfers.map(tr => (
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
                          <td style={{ padding: '10px' }}>{tr.from_location}</td>
                          <td style={{ padding: '10px' }}>{tr.to_location}</td>
                          <td style={{ padding: '10px' }}>
                            <InlineStack gap="150" blockAlign="center">
                              <StatusBadge status={tr.status} />
                              {tr.on_hold && <HoldBadge />}
                              {showArchived && tr.auto_committed && <AutoCommittedBadge />}
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
