import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, TextField
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import { StatusBadge } from '../shared/boxPoStatus';

function formatDateOnly(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).slice(0, 10);
  const [y, m, d] = s.split('-');
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  if (!y || !m || !d) return '';
  return `${y}.${months[Number(m) - 1]}.${d}`;
}

// Warehouse counting page (see claude/BOX_PO_FEATURE_SPEC.md section 10).
// Box qty per row has 3 render states:
//  1. unconfirmed — stepper (default = original Box qty) + gray circular
//     button with a green checkmark glyph, click to confirm the count.
//  2. confirmed & matching — plain text + solid green circular checkmark.
//  3. confirmed & mismatched — red bold text + solid orange circular
//     checkmark.
// Submit is disabled until every row is counted_confirmed. Buyer-note and
// Warehouse-note are two fully independent fields (each capped at 1, both
// can coexist) — this page only ever touches its own (role: 'warehouse').
function WarehouseBoxPODetail() {
  const navigate = useNavigate();
  const { id } = useParams();

  const [boxPo, setBoxPo] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [draftCounts, setDraftCounts] = useState({}); // itemId -> string draft value
  const [countingId, setCountingId] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/box-po/${id}`)
      .then(r => r.json())
      .then(data => {
        setBoxPo(data.boxPo || null);
        const its = Array.isArray(data.items) ? data.items : [];
        setItems(its);
        setDraftCounts(prev => {
          const next = { ...prev };
          its.forEach(it => { if (next[it.id] === undefined) next[it.id] = String(it.box_qty); });
          return next;
        });
      })
      .catch(() => setLoadError('Failed to load this BOX PO.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const updateDraft = (itemId, value) => {
    const qty = value === '' ? '' : Math.max(0, parseInt(value, 10) || 0);
    setDraftCounts(prev => ({ ...prev, [itemId]: qty === '' ? '' : String(qty) }));
  };

  const confirmCount = async (itemId) => {
    const value = draftCounts[itemId];
    const qty = parseInt(value, 10);
    // A cleared/blank input must not silently no-op the click — otherwise
    // the row just stays uncounted with no indication why, quietly blocking
    // Submit until someone notices.
    if (!Number.isFinite(qty)) {
      setActionError('Enter a number for Box received before confirming this row.');
      return;
    }
    setCountingId(itemId);
    setActionError('');
    try {
      const res = await fetch(`/api/box-po/${id}/count`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, boxReceived: qty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to confirm count');
      load();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setCountingId(null);
    }
  };

  const openAddNote = () => { setNoteDraft(boxPo?.warehouse_note || ''); setNoteEditing(true); };
  const saveNote = async () => {
    const trimmed = noteDraft.trim();
    setNoteSaving(true);
    setActionError('');
    try {
      if (!trimmed) {
        await fetch(`/api/box-po/${id}/note`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'warehouse' }),
        });
      } else {
        await fetch(`/api/box-po/${id}/note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'warehouse', text: trimmed }),
        });
      }
      setNoteEditing(false);
      load();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setNoteSaving(false);
    }
  };
  const deleteNote = async () => {
    setActionError('');
    try {
      await fetch(`/api/box-po/${id}/note`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'warehouse' }),
      });
      load();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const allConfirmed = items.length > 0 && items.every(it => it.counted_confirmed);

  const handleSubmit = async () => {
    setSubmitting(true);
    setActionError('');
    try {
      const res = await fetch(`/api/box-po/${id}/submit`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit');
      navigate('/warehouse');
    } catch (e) {
      setActionError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Page title="BOX PO" backAction={{ onAction: () => navigate('/warehouse') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }

  if (loadError || !boxPo) {
    return (
      <Page title="BOX PO" backAction={{ onAction: () => navigate('/warehouse') }}>
        <Layout><Layout.Section><Banner tone="critical">{loadError || 'Not found.'}</Banner></Layout.Section></Layout>
      </Page>
    );
  }

  return (
    <Page
      title={boxPo.box_po_number}
      titleMetadata={<StatusBadge status={boxPo.status} />}
      backAction={{ onAction: () => navigate('/warehouse') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionError && <Banner tone="critical" onDismiss={() => setActionError('')}>{actionError}</Banner>}

            <InlineStack align="space-between" blockAlign="center" wrap>
              <InlineStack gap="400" wrap>
                <Text variant="bodySm" tone="subdued">Supplier: {boxPo.supplier_name}</Text>
                <Text variant="bodySm" tone="subdued">Total Boxes: {boxPo.total_boxes}</Text>
                {boxPo.box_date && <Text variant="bodySm" tone="subdued">Date: {formatDateOnly(boxPo.box_date)}</Text>}
              </InlineStack>
              <InlineStack gap="200">
                {!boxPo.warehouse_note && !noteEditing && (
                  <Button onClick={openAddNote}>Add note</Button>
                )}
                <Button variant="primary" disabled={!allConfirmed} loading={submitting} onClick={handleSubmit}>
                  Submit
                </Button>
              </InlineStack>
            </InlineStack>

            {boxPo.warehouse_note && !noteEditing && (
              <InlineStack gap="150" blockAlign="center">
                <Text tone="subdued" variant="bodySm">Note: {boxPo.warehouse_note}</Text>
                <span style={{ cursor: 'pointer', color: '#d72c0d' }} onClick={deleteNote}>×</span>
              </InlineStack>
            )}
            {noteEditing && (
              <InlineStack gap="150" blockAlign="center">
                <div style={{ flex: 1 }}>
                  <TextField
                    label=""
                    labelHidden
                    value={noteDraft}
                    onChange={setNoteDraft}
                    placeholder="Add a note..."
                    autoComplete="off"
                    onKeyDown={(e) => { if (e.key === 'Enter') saveNote(); }}
                  />
                </div>
                <Button onClick={saveNote} loading={noteSaving}>Save</Button>
                <Button onClick={() => setNoteEditing(false)}>Cancel</Button>
              </InlineStack>
            )}

            <Card>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                      <th style={TH_STYLE}>Destination Location</th>
                      <th style={TH_STYLE}>Box qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => {
                      const mismatched = it.counted_confirmed && Number(it.box_received) !== Number(it.box_qty);
                      return (
                        <tr key={it.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                          <td style={TD_STYLE}>{it.location}</td>
                          <td style={TD_STYLE}>
                            {it.counted_confirmed ? (
                              <InlineStack gap="150" blockAlign="center">
                                <Text
                                  as="span"
                                  variant="bodySm"
                                  fontWeight={mismatched ? 'bold' : undefined}
                                  tone={mismatched ? 'critical' : undefined}
                                >
                                  {it.box_received}
                                </Text>
                                <span style={mismatched ? CIRCLE_ORANGE_STYLE : CIRCLE_GREEN_STYLE}>✓</span>
                              </InlineStack>
                            ) : (
                              <InlineStack gap="150" blockAlign="center">
                                <input
                                  type="number"
                                  min="0"
                                  value={draftCounts[it.id] ?? ''}
                                  onChange={e => updateDraft(it.id, e.target.value)}
                                  style={{
                                    width: '72px', padding: '4px 6px', borderRadius: '6px',
                                    border: '1px solid #c9cccf', fontSize: '13px',
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={() => confirmCount(it.id)}
                                  disabled={countingId === it.id}
                                  style={CIRCLE_BUTTON_STYLE}
                                  title="Confirm count"
                                >
                                  ✓
                                </button>
                              </InlineStack>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

const TH_STYLE = { padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' };
const TD_STYLE = { padding: '10px' };

const CIRCLE_BASE_STYLE = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '18px', height: '18px', borderRadius: '50%',
  color: '#fff', fontSize: '12px', fontWeight: 700, lineHeight: 1,
};
const CIRCLE_GREEN_STYLE = { ...CIRCLE_BASE_STYLE, background: '#108043' };
const CIRCLE_ORANGE_STYLE = { ...CIRCLE_BASE_STYLE, background: '#FFA500' };

const CIRCLE_BUTTON_STYLE = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '22px', height: '22px', borderRadius: '50%',
  border: '1px solid #c9cccf', background: '#f1f2f3',
  color: '#108043', fontSize: '13px', fontWeight: 700, lineHeight: 1,
  cursor: 'pointer', padding: 0,
};

export default WarehouseBoxPODetail;
