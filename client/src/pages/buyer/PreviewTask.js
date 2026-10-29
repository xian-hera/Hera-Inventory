import React, { useState, useEffect, useMemo } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Checkbox, Banner, TextField
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { DDList } from '../shared/ddPill';

// Preview Tasks (2026-10-28, Hera):
//   - one pill per location under the filter summary; the list shows what
//     will really be published to the chosen location (its own exclusions —
//     quantity filter / Exclude 0 / "Remove from {location}" — taken out);
//   - line items whose purchase order for that location was delivered (or is
//     on today's schedule) but is not committed yet are left out of that
//     location: shown on top, struck through, with the PO's DD pill
//     (POST /api/tasks/po-exclusions; the server checks again on save);
//   - "Remove Selected from ALL" (action card) removes the selected items from
//     every location; "Remove from {location}" only from the chosen one;
//     "Remove this Location" drops the location (no task is created for it).
//   - no "Save as draft" any more (2026-10-29): tasks are always published.
const pillBtn = (on) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 999, cursor: 'pointer',
  border: on ? '1px solid #303030' : '1px solid #c9cccf', background: on ? '#303030' : '#fff',
  color: on ? '#fff' : '#303030', fontSize: 13, fontWeight: 600, lineHeight: '20px',
});

// 2026-10-16 (Hera): line items are listed A → Z by Name (items without a
// name last) on Creating task, Preview task and the published task page.
const compareByName = (a, b) => {
  const an = (a && a.name) || '';
  const bn = (b && b.name) || '';
  if (!an && !bn) return 0;
  if (!an) return 1;
  if (!bn) return -1;
  return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
};

function PreviewTask() {
  const navigate = useNavigate();
  const [taskData, setTaskData] = useState(null);
  const [selectedBarcodes, setSelectedBarcodes] = useState([]);
  const [notes, setNotes] = useState([]);
  const [noteInput, setNoteInput] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [locations, setLocations] = useState([]);        // still in the preview
  const [activeLoc, setActiveLoc] = useState('');
  const [locRemoved, setLocRemoved] = useState({});      // { location: [barcode] } — "Remove from {location}"
  const [po, setPo] = useState({ byLocation: {}, dd: {} }); // delivered-PO items per location

  useEffect(() => {
    const stored = sessionStorage.getItem('pendingTask');
    if (stored) {
      const parsed = JSON.parse(stored);
      setTaskData(parsed);
      setLocations(parsed.locations || []);
      setActiveLoc((parsed.locations || [])[0] || '');
      fetch('/api/tasks/po-exclusions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: parsed.locations || [], barcodes: (parsed.items || []).map(i => i.barcode) }),
      }).then(r => (r.ok ? r.json() : null)).then(d => { if (d) setPo({ byLocation: d.byLocation || {}, dd: d.dd || {} }); })
        .catch(() => {});
    } else {
      navigate('/buyer/counting-tasks/new');
    }
  }, [navigate]);

  // What each location's task would hold: { normal: [...], po: [...] }.
  const perLoc = useMemo(() => {
    const out = {};
    if (!taskData) return out;
    for (const loc of locations) {
      const ex = new Set([...((taskData.excludedBarcodes || {})[loc] || []), ...(locRemoved[loc] || [])]);
      const poMap = po.byLocation[loc] || {};
      const list = taskData.items.filter(i => !ex.has(i.barcode));
      out[loc] = {
        normal: list.filter(i => !poMap[i.barcode]).sort(compareByName),
        po: list.filter(i => poMap[i.barcode]).sort(compareByName),
      };
    }
    return out;
  }, [taskData, locations, locRemoved, po]);

  if (!taskData) return null;
  const current = perLoc[activeLoc] || { normal: [], po: [] };

  const handleAddNote = () => {
    if (!noteInput.trim()) return;
    setNotes(prev => [...prev, { text: noteInput.trim(), created_at: new Date().toISOString() }]);
    setNoteInput('');
    setShowNoteInput(false);
  };

  const handleDeleteNote = (index) => {
    setNotes(prev => prev.filter((_, i) => i !== index));
  };

  // "Remove Selected from ALL" — same as the old "Remove selected".
  const handleRemoveSelected = () => {
    setTaskData(prev => ({
      ...prev,
      items: prev.items.filter(p => !selectedBarcodes.includes(p.barcode)),
    }));
    setSelectedBarcodes([]);
  };
  // "Remove from {location}" — only from the chosen location.
  const handleRemoveFromLocation = () => {
    if (!activeLoc || selectedBarcodes.length === 0) return;
    setLocRemoved(prev => ({ ...prev, [activeLoc]: [...new Set([...(prev[activeLoc] || []), ...selectedBarcodes])] }));
    setSelectedBarcodes([]);
  };
  const handleRemoveLocation = () => {
    if (locations.length <= 1) return;
    const left = locations.filter(l => l !== activeLoc);
    setLocations(left);
    setActiveLoc(left[0] || '');
    setSelectedBarcodes([]);
  };
  const chooseLoc = (loc) => { setActiveLoc(loc); setSelectedBarcodes([]); };

  const toggleSelectOne = (barcode) => {
    setSelectedBarcodes(prev =>
      prev.includes(barcode) ? prev.filter(x => x !== barcode) : [...prev, barcode]
    );
  };

  const toggleSelectAll = () => {
    if (current.normal.length > 0 && selectedBarcodes.length === current.normal.length) {
      setSelectedBarcodes([]);
    } else {
      setSelectedBarcodes(current.normal.map(p => p.barcode));
    }
  };

  const handleSave = async (publish) => {
    if (taskData.items.length === 0 || locations.every(l => !(perLoc[l] && perLoc[l].normal.length))) {
      setError('No items in task.');
      return;
    }
    // Each location's own removals go to the server with its exclusions.
    const excluded = { ...(taskData.excludedBarcodes || {}) };
    for (const [loc, list] of Object.entries(locRemoved)) {
      excluded[loc] = [...new Set([...(excluded[loc] || []), ...list])];
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          types: taskData.types,           // 改动一：发送 types 数组
          locations,
          filterSummary: taskData.filterSummary,
          items: taskData.items,
          excludedBarcodes: excluded,
          notes,
          publish,
          scanCount: !!taskData.scanCount,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      sessionStorage.removeItem('pendingTask');
      navigate('/buyer/counting-tasks');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}.${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };

  // Title: just "Preview Tasks" (2026-10-28, Hera — was "Preview task —
  // {types} | {locations}"; the locations are the pills now).
  const pageTitle = 'Preview Tasks';

  // PO items first (struck through, with the PO's DD pill), then the rest.
  const strike = { textDecoration: 'line-through', color: '#8a8a8a' };
  const poRows = current.po.map(p => {
    const ids = ((po.byLocation[activeLoc] || {})[p.barcode]) || [];
    const entries = ids.flatMap(id => po.dd[id] || []);
    return [
      <span />,
      <span style={strike}>{p.name || '-'}</span>,
      <span style={strike}>{p.barcode || '-'}</span>,
      entries.length ? <DDList entries={entries} /> : <span style={{ color: '#8a8a8a' }}>PO</span>,
    ];
  });
  const rows = [...poRows, ...current.normal.map(p => [
    <Checkbox
      checked={selectedBarcodes.includes(p.barcode)}
      onChange={() => toggleSelectOne(p.barcode)}
    />,
    p.name || '-',
    p.barcode || '-',
    '',
  ])];

  return (
    <Page
      title={pageTitle}
      secondaryActions={[{
        content: 'Back to creating',
        onAction: () => navigate('/buyer/counting-tasks/new'),
      }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Text variant="bodySm" tone="subdued">{taskData.filterSummary}</Text>

            {/* Location pills — one lit at a time */}
            <InlineStack gap="200" wrap>
              {locations.map(loc => {
                const n = perLoc[loc] ? perLoc[loc].normal.length : 0;
                return (
                  <button key={loc} type="button" style={pillBtn(loc === activeLoc)} onClick={() => chooseLoc(loc)} aria-pressed={loc === activeLoc}>
                    {loc}<span style={{ fontWeight: 400, opacity: 0.8 }}>{n}</span>
                  </button>
                );
              })}
            </InlineStack>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" wrap>
                  <Button onClick={() => setShowNoteInput(true)}>Add note</Button>
                  <Button disabled={selectedBarcodes.length === 0} onClick={handleRemoveSelected}>
                    Remove Selected from ALL
                  </Button>
                  <Button variant="primary" onClick={() => handleSave(true)} loading={saving}>
                    Save and publish
                  </Button>
                </InlineStack>

                {showNoteInput && (
                  <InlineStack gap="200" align="start">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="" labelHidden
                        placeholder="Enter note..."
                        value={noteInput}
                        onChange={setNoteInput}
                        autoComplete="off"
                      />
                    </div>
                    <Button onClick={handleAddNote}>Save note</Button>
                    <Button onClick={() => { setShowNoteInput(false); setNoteInput(''); }}>Cancel</Button>
                  </InlineStack>
                )}

                {notes.length > 0 && (
                  <BlockStack gap="200">
                    {notes.map((note, i) => (
                      <InlineStack key={i} align="space-between">
                        <Text variant="bodyMd">{note.text}</Text>
                        <InlineStack gap="200">
                          <Text variant="bodySm" tone="subdued">{formatDate(note.created_at)}</Text>
                          <Button variant="plain" tone="critical" onClick={() => handleDeleteNote(i)}>✕</Button>
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <InlineStack align="end" gap="200">
              <Button disabled={selectedBarcodes.length === 0} onClick={handleRemoveFromLocation}>
                {`Remove from ${activeLoc}`}
              </Button>
              <Button tone="critical" disabled={locations.length <= 1} onClick={handleRemoveLocation}>
                Remove this Location
              </Button>
            </InlineStack>

            <Card>
              {current.normal.length === 0 && (
                <div style={{ marginBottom: 8 }}>
                  <Text tone="subdued">No items left for {activeLoc} — no task will be created for it.</Text>
                </div>
              )}
              <DataTable
                columnContentTypes={['text','text','text','text']}
                headings={[
                  <Checkbox
                    checked={selectedBarcodes.length === current.normal.length && current.normal.length > 0}
                    indeterminate={selectedBarcodes.length > 0 && selectedBarcodes.length < current.normal.length}
                    onChange={toggleSelectAll}
                  />,
                  'Name', 'SKU', '',
                ]}
                rows={rows}
              />
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default PreviewTask;