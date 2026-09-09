import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '../shared/boxPoStatus';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')}`;
}

// Past BOX PO (see claude/BOX_PO_FEATURE_SPEC.md section 11): all confirmed
// tasks within the 90-day retention window (cleaned up lazily by the server
// on read — see cleanupExpiredConfirmed in boxPo.js). Only a Delete selected
// button here — nothing left to confirm.
function BuyerBoxPOPast() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState([]);
  const [actionError, setActionError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/box-po/past')
      .then(r => r.json())
      .then(data => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const handleDeleteSelected = async () => {
    if (!window.confirm(`Delete ${selectedIds.length} selected BOX PO task(s)? This cannot be undone.`)) return;
    setDeleting(true);
    setActionError('');
    try {
      const res = await fetch('/api/box-po/delete-selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      if (!res.ok) throw new Error('Failed to delete selected');
      setSelectedIds([]);
      load();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Page title="Past BOX PO" backAction={{ onAction: () => navigate('/buyer/po-receiving/box-po') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionError && <Banner tone="critical" onDismiss={() => setActionError('')}>{actionError}</Banner>}

            <InlineStack align="end">
              {selectedIds.length > 0 && (
                <Button tone="critical" onClick={handleDeleteSelected} loading={deleting}>
                  Delete selected ({selectedIds.length})
                </Button>
              )}
            </InlineStack>

            <Card>
              {loading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : rows.length === 0 ? (
                <Text tone="subdued">No confirmed BOX PO tasks in the last 90 days.</Text>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={TH_STYLE}>
                          <input
                            type="checkbox"
                            checked={rows.length > 0 && selectedIds.length === rows.length}
                            onChange={() => setSelectedIds(selectedIds.length === rows.length ? [] : rows.map(r => r.id))}
                          />
                        </th>
                        <th style={TH_STYLE}>BOX PO number</th>
                        <th style={TH_STYLE}>Supplier</th>
                        <th style={TH_STYLE}>Created date</th>
                        <th style={TH_STYLE}>Confirmed date</th>
                        <th style={TH_STYLE}>Total Boxes</th>
                        <th style={TH_STYLE}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                          <td style={TD_STYLE}>
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(r.id)}
                              onChange={(e) => { e.stopPropagation(); toggleSelect(r.id); }}
                            />
                          </td>
                          <td
                            style={{ ...TD_STYLE, cursor: 'pointer', textDecoration: 'underline' }}
                            onClick={() => navigate(`/buyer/po-receiving/box-po/${r.id}`)}
                          >
                            {r.box_po_number}
                          </td>
                          <td style={TD_STYLE}>{r.supplier_name}</td>
                          <td style={TD_STYLE}>{formatDate(r.created_at)}</td>
                          <td style={TD_STYLE}>{formatDate(r.confirmed_at)}</td>
                          <td style={TD_STYLE}>{r.total_boxes}</td>
                          <td style={TD_STYLE}><StatusBadge status={r.status} /></td>
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

const TH_STYLE = { padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' };
const TD_STYLE = { padding: '10px' };

export default BuyerBoxPOPast;
