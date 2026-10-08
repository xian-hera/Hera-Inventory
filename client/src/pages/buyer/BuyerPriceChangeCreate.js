// Purchasing › Price Change › Create Task (2026-10-08, Hera).
// Spec: claude/PRICE_CHANGE_SCHEDULE_REVERSE_SPEC.md
// Three steps, each card appears after the previous one is confirmed and
// then collapses into a one-line summary (with "Change" to go back):
//   Start (Type, Location, Task Type) → Upload CSV (SKU + Price) → Publish
//   (change date/time in Eastern time, optional reverse, note, Schedule it /
//   Publish Now).
import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Page, Card, BlockStack, InlineStack, Text, Button, Banner, Select, Tooltip,
  TextField, Checkbox, Popover, ActionList, Modal,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { useLocationMap } from '../shared/locationMap';
import { decodeCsvBuffer, cleanCell } from './importProducts/importModel';
import { TASK_TYPES, taskTypeOf, excludedText } from '../shared/priceChangeShared';

const NARROW = { maxWidth: '62.375rem', margin: '0 auto', width: '100%' };

const TASK_TYPE_TIP = (
  <div>
    {TASK_TYPES.map(t => <div key={t.value}><b>{t.label}</b>: {t.help}</div>)}
  </div>
);

function Summary({ label, children }) {
  return (
    <BlockStack gap="050">
      <Text variant="bodySm" tone="subdued">{label}</Text>
      <div style={{ fontSize: 15, fontWeight: 500 }}>{children}</div>
    </BlockStack>
  );
}

function BuyerPriceChangeCreate() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const { names: locationNames } = useLocationMap();

  // ── Start ──
  const [allTypes, setAllTypes] = useState([]);
  const [types, setTypes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [taskType, setTaskType] = useState('');
  const [step, setStep] = useState('start'); // start → upload → publish
  const [error, setError] = useState('');

  // ── Upload ──
  const [fileName, setFileName] = useState('');
  const [csvRows, setCsvRows] = useState(null); // [{ row, sku, price }]
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null); // { items, skipped }
  const [showSkipped, setShowSkipped] = useState(false);

  // ── Publish ──
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [reverseOn, setReverseOn] = useState(false);
  const [revDate, setRevDate] = useState('');
  const [revTime, setRevTime] = useState('');
  const [revType, setRevType] = useState('');
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/shopify/product-types').then(r => r.json()).catch(() => []),
      fetch('/api/price-change-tasks/settings').then(r => r.json()).catch(() => ({})),
    ]).then(([t, s]) => {
      const hidden = new Set((Array.isArray(s.hiddenTypes) ? s.hiddenTypes : []).map(x => String(x).toLowerCase()));
      setAllTypes((Array.isArray(t) ? t : []).filter(x => !hidden.has(String(x).toLowerCase())));
    });
  }, []);

  // Default locations: every active location except HQ, once the list loads.
  const locDefaulted = useRef(false);
  useEffect(() => {
    if (locDefaulted.current || !locationNames.length) return;
    locDefaulted.current = true;
    setLocations(locationNames.filter(n => n.toUpperCase() !== 'HQ'));
  }, [locationNames]);

  const startReady = types.length > 0 && locations.length > 0 && !!taskType;

  const resetUpload = () => { setFileName(''); setCsvRows(null); setResult(null); setShowSkipped(false); };
  const resetPublish = () => {
    setDate(''); setTime(''); setReverseOn(false); setRevDate(''); setRevTime(''); setRevType(''); setNote('');
  };

  // ── CSV ──
  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setError('');
    setResult(null);
    const reader = new FileReader();
    reader.onerror = () => setError('Could not read the CSV.');
    reader.onload = () => {
      const all = Papa.parse(decodeCsvBuffer(reader.result), { skipEmptyLines: 'greedy' }).data || [];
      // Header row = first row with a "SKU" cell; only SKU and Price are read.
      const norm = (v) => cleanCell(v).trim().toLowerCase();
      const hi = all.findIndex(r => (r || []).some(c => norm(c) === 'sku'));
      if (hi === -1) { setError('The CSV needs a column with the header "SKU".'); return; }
      const head = all[hi].map(norm);
      const skuCol = head.indexOf('sku');
      let priceCol = head.indexOf('price');
      if (priceCol === -1) priceCol = head.indexOf('variant price');
      const rows = [];
      for (let i = hi + 1; i < all.length; i++) {
        const cells = all[i] || [];
        const sku = cleanCell(cells[skuCol]).trim();
        if (!sku) continue;
        rows.push({ row: i + 1, sku, price: priceCol === -1 ? '' : cleanCell(cells[priceCol]).trim() });
      }
      if (!rows.length) { setError('No SKUs found in the CSV.'); return; }
      setCsvRows(rows);
      setFileName(f.name);
    };
    reader.readAsArrayBuffer(f);
  };

  const process = async () => {
    if (!csvRows) return;
    setProcessing(true);
    setError('');
    try {
      const res = await fetch('/api/price-change-tasks/process', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productTypes: types, taskType, rows: csvRows }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Process failed');
      setResult(d);
      if (d.items.length) setStep('publish');
      else setShowSkipped(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setProcessing(false);
    }
  };

  const downloadSkipped = () => {
    const text = Papa.unparse({ fields: ['Row', 'SKU', 'Reason'], data: result.skipped.map(s => [s.row, s.sku, s.reason]) });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = `price change skipped rows.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── Publish ──
  const publishReady = date && time && (!reverseOn || (revDate && revTime && revType));
  const submit = async (now) => {
    setSaving(true);
    setError('');
    setMenuOpen(false);
    try {
      const res = await fetch('/api/price-change-tasks/scheduled', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productTypes: types, locations, taskType, note: note.trim() || null,
          items: result.items,
          when: now ? 'now' : { date, time },
          reverse: reverseOn ? { date: revDate, time: revTime, taskType: revType } : null,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not save the task');
      navigate('/buyer/price-change');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const typeOptions = [{ label: 'Choose', value: '' }, ...TASK_TYPES.map(t => ({ label: t.label, value: t.value }))];
  const skippedList = useMemo(() => (result ? result.skipped : []), [result]);

  return (
    <Page
      title="Creating Price Change Task"
      backAction={{ onAction: () => navigate('/buyer/price-change') }}
      secondaryActions={[{ content: 'Settings', onAction: () => navigate('/buyer/price-change/settings') }]}
    >
      <div style={NARROW}>
        <BlockStack gap="400">
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

          {/* ── Start ── */}
          {step === 'start' ? (
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Start</Text>
                <InlineStack gap="400" blockAlign="end" wrap>
                  <div style={{ minWidth: 220 }}>
                    <MultiSelectDropdown label="Type" options={allTypes} selected={types} onChange={setTypes} placeholder="Choose" showSelectAll />
                  </div>
                  <div style={{ minWidth: 220 }}>
                    <MultiSelectDropdown
                      label="Location" options={locationNames} selected={locations} onChange={setLocations}
                      placeholder="None" showSelectAll formatDisplay={(sel, all) => excludedText(sel, all)}
                    />
                  </div>
                  <div style={{ minWidth: 200 }}>
                    <Select
                      label={<Tooltip content={TASK_TYPE_TIP}><span style={{ borderBottom: '1px dotted #8c9196' }}>Task Type</span></Tooltip>}
                      options={typeOptions} value={taskType} onChange={setTaskType}
                    />
                  </div>
                  <div style={{ marginLeft: 'auto' }}>
                    <Button variant="primary" disabled={!startReady} onClick={() => setStep('upload')}>Confirm</Button>
                  </div>
                </InlineStack>
              </BlockStack>
            </Card>
          ) : (
            <InlineStack gap="800" blockAlign="end" wrap={false}>
              <Summary label="Type">{types.join(', ')}</Summary>
              <div style={{ minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                <Summary label="Locations">{excludedText(locations, locationNames)}</Summary>
              </div>
              <div style={{ fontSize: 15, fontWeight: 500, whiteSpace: 'nowrap' }}>{taskTypeOf(taskType) && `${taskTypeOf(taskType).label} Price Change`}</div>
              <Button variant="plain" onClick={() => { resetUpload(); resetPublish(); setStep('start'); }}>Change</Button>
            </InlineStack>
          )}

          {/* ── Upload CSV ── */}
          {step === 'upload' && (
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Upload csv</Text>
                <InlineStack gap="300" blockAlign="center">
                  <Tooltip content={<span>Only SKU and Price columns with Headers are required,<br />Other columns will be ignored.</span>}>
                    <Button onClick={() => fileRef.current && fileRef.current.click()}>Upload CSV</Button>
                  </Tooltip>
                  <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={onFile} />
                  {fileName && <Text tone="subdued">{fileName} added</Text>}
                  <div style={{ marginLeft: 'auto' }}>
                    <Button variant="primary" onClick={process} loading={processing} disabled={!csvRows}>Process</Button>
                  </div>
                </InlineStack>
                {result && !result.items.length && (
                  <Banner tone="critical">No rows can be updated — see the list below.</Banner>
                )}
              </BlockStack>
            </Card>
          )}
          {step === 'publish' && result && (
            <InlineStack gap="300" blockAlign="center">
              <Text tone="subdued">{fileName}</Text>
              <Text fontWeight="medium">Processed, {result.items.length} Rows will be updated</Text>
              {result.skipped.length > 0 && (
                <Button variant="plain" tone="critical" onClick={() => setShowSkipped(v => !v)}>
                  {result.skipped.length} skipped {showSkipped ? '▴' : '▾'}
                </Button>
              )}
              <Button variant="plain" onClick={() => { resetUpload(); resetPublish(); setStep('upload'); }}>Change</Button>
            </InlineStack>
          )}
          {result && skippedList.length > 0 && showSkipped && (
            <Banner tone="warning">
              <BlockStack gap="100">
                <Text fontWeight="medium">{skippedList.length} row(s) will not be updated:</Text>
                {skippedList.slice(0, 30).map((s, i) => <div key={i}>Row {s.row} · {s.sku} — {s.reason}</div>)}
                {skippedList.length > 30 && <div>…and {skippedList.length - 30} more.</div>}
                <InlineStack><Button onClick={downloadSkipped}>Download list</Button></InlineStack>
              </BlockStack>
            </Banner>
          )}

          {/* ── Publish ── */}
          {step === 'publish' && (
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Publish</Text>
                <InlineStack gap="600" blockAlign="start" wrap>
                  <BlockStack gap="200">
                    <Text variant="bodySm" tone="subdued">Change will apply at the time set below (Eastern time), task will be published after 10 minutes</Text>
                    <InlineStack gap="300">
                      <div style={{ width: 170 }}><TextField label="Date" labelHidden type="date" value={date} onChange={setDate} autoComplete="off" /></div>
                      <div style={{ width: 130 }}><TextField label="Time" labelHidden type="time" value={time} onChange={setTime} autoComplete="off" /></div>
                    </InlineStack>
                    {reverseOn && (
                      <BlockStack gap="200">
                        <div style={{ marginTop: 8 }}><Text variant="bodySm" tone="subdued">The price change will be reversed at the time set below.</Text></div>
                        <InlineStack gap="300" blockAlign="center">
                          <div style={{ width: 170 }}><TextField label="Reverse date" labelHidden type="date" value={revDate} onChange={setRevDate} autoComplete="off" /></div>
                          <div style={{ width: 130 }}><TextField label="Reverse time" labelHidden type="time" value={revTime} onChange={setRevTime} autoComplete="off" /></div>
                          <div style={{ width: 230 }}>
                            <Select
                              label="Stores see it as" labelInline
                              options={typeOptions} value={revType} onChange={setRevType}
                            />
                          </div>
                        </InlineStack>
                      </BlockStack>
                    )}
                  </BlockStack>
                  <div style={{ paddingTop: 24 }}>
                    <Checkbox label="Schedule a Reverse" checked={reverseOn} onChange={setReverseOn} />
                  </div>
                  <div style={{ marginLeft: 'auto', paddingTop: 20 }}>
                    <InlineStack gap="200" blockAlign="center">
                      <Button onClick={() => { setNoteDraft(note); setNoteOpen(true); }}>{note ? 'Edit note' : 'Add note'}</Button>
                      <div style={{ display: 'flex' }}>
                        <Button variant="primary" onClick={() => submit(false)} disabled={!publishReady} loading={saving}>Schedule it</Button>
                        <Popover
                          active={menuOpen}
                          onClose={() => setMenuOpen(false)}
                          preferredAlignment="right"
                          activator={<Button variant="primary" onClick={() => setMenuOpen(v => !v)} accessibilityLabel="More publish options" disabled={saving}>▾</Button>}
                        >
                          <ActionList items={[{
                            content: 'Publish Now',
                            disabled: reverseOn && !(revDate && revTime && revType),
                            onAction: () => submit(true),
                          }]} />
                        </Popover>
                      </div>
                    </InlineStack>
                  </div>
                </InlineStack>
                {note && <Text variant="bodySm" tone="subdued">Note: {note}</Text>}
              </BlockStack>
            </Card>
          )}
          <div style={{ height: 120 }} />
        </BlockStack>
      </div>

      <Modal
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title="Task note"
        primaryAction={{ content: 'Save', onAction: () => { setNote(noteDraft); setNoteOpen(false); } }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setNoteOpen(false) }]}
      >
        <Modal.Section>
          <TextField label="Note for the stores (optional)" value={noteDraft} onChange={setNoteDraft} multiline={3} autoComplete="off" />
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default BuyerPriceChangeCreate;
