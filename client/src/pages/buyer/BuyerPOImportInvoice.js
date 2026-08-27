import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import Papa from 'papaparse';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField,
  Banner, Badge, Checkbox, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import InfoTooltip from '../../components/InfoTooltip';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01','HQ'
];

const ADJUSTMENT_TOOLTIP = `Enter adjustment as amount or percentage.
Amount:
 Line adjustment = Total adjustment × (Line total ÷ Order subtotal)
 New unit cost = (Line total ± Line adjustment) ÷ Qty
Percentage:
 Line adjustment = Line total × Adjustment %
 New unit cost = (Line total ± Line adjustment) ÷ Qty
Use + for surcharge, − for discount.`;

const CSV_FORMAT_TOOLTIP = `column 1, unit code (SKU or code, at least 1 required
Column 2, SKU (SKU or code, at least 1 required
column 3, name
column 4, quantity (required, or will be skipped
column 5, cost
column 6, unit discount(if applicable, can be % or amount)`;

const COMMITTING_RULE_TOOLTIP = `Committing will update cost field, new cost = (current qty × current cost + invoice qty × invoice unit cost) ÷ (current qty + invoice qty)`;

const MISSING_SKU_TOOLTIP = `Go to Supplier management to add the missing SKU mapping first, then restart this importing, or add this to Commit later, and commit it after SKU added.`;

const COLLISION_TOOLTIP = `Two or more unit codes on this invoice resolved to the same SKU. Fix the supplier's code mapping (or the CSV) and re-process before committing.`;

const MISSING_COST_TOOLTIP = `This line item has no cost — it was left blank in the CSV and there's no Supplier cost metafield value to fall back on. It can still be committed: inventory will be received as normal, but the cost (and Shopify's average cost) will not be updated for it. Fill in a cost on the CSV, or set the SKU's Supplier cost metafield in Shopify, then re-process if you want the cost to be included.`;

const EFFECTIVE_COST_TOOLTIP_USD = `effective cost = invoice cost + adjustment + unit discount + converted to CAD`;
const EFFECTIVE_COST_TOOLTIP_CAD = `effective cost = invoice cost + adjustment + unit discount`;

function BuyerPOImportInvoice() {
  const navigate = useNavigate();
  const { invoiceId: invoiceIdParam } = useParams();

  const [invoiceId, setInvoiceId] = useState(invoiceIdParam ? Number(invoiceIdParam) : null);
  const [loading, setLoading] = useState(!!invoiceIdParam);
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);

  // Card 1 — invoiceNumber is now a free-text, optional reference only; the
  // canonical identifier is the auto-assigned poNumber (see below).
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [numberSaved, setNumberSaved] = useState(false);
  const [poNumber, setPoNumber] = useState(null);

  // Card 2
  const [supplierQuery, setSupplierQuery] = useState('');
  const [supplierId, setSupplierId] = useState(null);
  const [allSuppliers, setAllSuppliers] = useState([]);
  const [supplierDropdownOpen, setSupplierDropdownOpen] = useState(false);
  const [supplierDropStyle, setSupplierDropStyle] = useState({});
  const supplierFieldRef = useRef(null);
  const [supplier, setSupplier] = useState(null); // { id, name, currency, fx_rate }
  const [location, setLocation] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const [editingFxRate, setEditingFxRate] = useState(false);
  const [fxRateInput, setFxRateInput] = useState('');

  // Card 3
  const [csvRows, setCsvRows] = useState([]);
  const [csvFileName, setCsvFileName] = useState('');
  const [adjustmentDraft, setAdjustmentDraft] = useState('');
  const [adjustmentSaved, setAdjustmentSaved] = useState(null);

  // Card 4 / result
  const [items, setItems] = useState([]);
  const [hasMissing, setHasMissing] = useState(false);
  const [hasCollision, setHasCollision] = useState(false);
  const [hasMissingCost, setHasMissingCost] = useState(false);
  const [isPromotional, setIsPromotional] = useState(false);

  const csvInputRef = useRef(null);

  // Which stored cost field ('invoice_cost' | 'effective_cost') to compare
  // against Supplier cost for the highlight treatment — configured in
  // Settings, separately per supplier currency.
  const [costComparison, setCostComparison] = useState({ cad: 'invoice_cost', usd: 'invoice_cost' });

  useEffect(() => {
    fetch('/api/po-suppliers')
      .then(r => r.json())
      .then(data => setAllSuppliers(Array.isArray(data) ? data : []))
      .catch(() => {});
    fetch('/api/po-settings/cost-comparison')
      .then(r => r.json())
      .then(data => setCostComparison({ cad: data.cad || 'invoice_cost', usd: data.usd || 'invoice_cost' }))
      .catch(() => {});
  }, []);

  // ── Load an existing pending invoice ────────────────────────────────────
  useEffect(() => {
    if (!invoiceIdParam) return;
    (async () => {
      try {
        const res = await fetch(`/api/po-invoices/pending/${invoiceIdParam}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const inv = data.invoice;
        setInvoiceId(inv.id);
        setInvoiceNumber(inv.invoice_number || '');
        setPoNumber(inv.po_number || null);
        setNumberSaved(true);
        setSupplierId(inv.supplier_id);
        setSupplierQuery(inv.supplier_name);
        setSupplier({ id: inv.supplier_id, name: inv.supplier_name, currency: inv.supplier_currency, fx_rate: inv.fx_rate });
        setLocation(inv.location);
        setConfirmed(true);
        setAdjustmentSaved(
          inv.adjustment_type
            ? (inv.adjustment_type === 'percentage' ? `${inv.adjustment_value}%` : `${inv.adjustment_value}`)
            : null
        );
        setIsPromotional(inv.is_promotional);
        setItems(data.items);
        setHasMissing(inv.has_missing_sku);
        setHasCollision(inv.has_sku_collision);
        setHasMissingCost(inv.has_missing_cost);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [invoiceIdParam]);

  // ── Card 1: reference invoice number (optional) ─────────────────────────
  const handleSaveNumber = () => setNumberSaved(true);
  const handleSkipNumber = () => { setInvoiceNumber(''); setNumberSaved(true); };

  // ── Discard-and-reprocess guard ─────────────────────────────────────────
  const guardEdit = useCallback((applyChange) => {
    if (items.length > 0) {
      if (!window.confirm('Editing this will discard the processed result. You will need to click "Start to process" again. Continue?')) {
        return;
      }
      setItems([]);
      setHasMissing(false);
      setHasCollision(false);
      setHasMissingCost(false);
    }
    applyChange();
  }, [items]);

  // ── Card 2: supplier dropdown ────────────────────────────────────────────
  // Shows the full supplier list on open; typing filters that list locally
  // (case-sensitive, matching the field's own placeholder). The dropdown is
  // rendered via a portal into document.body (positioned with
  // getBoundingClientRect, same pattern as MultiSelectDropdown) so it floats
  // above the Card instead of being clipped by it.
  const openSupplierDropdown = () => {
    if (supplierFieldRef.current) {
      const rect = supplierFieldRef.current.getBoundingClientRect();
      setSupplierDropStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        minWidth: rect.width,
        zIndex: 99999,
        background: 'white',
        border: '1px solid #e1e3e5',
        borderRadius: '8px',
        maxHeight: '260px',
        overflowY: 'auto',
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      });
    }
    setSupplierDropdownOpen(true);
  };

  useEffect(() => {
    if (!supplierDropdownOpen) return;
    const handleClick = (e) => {
      const field = supplierFieldRef.current;
      const drop = document.querySelector('[data-supplier-drop="true"]');
      if (field && !field.contains(e.target) && drop && !drop.contains(e.target)) {
        setSupplierDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [supplierDropdownOpen]);

  const filteredSuppliers = supplierQuery
    ? allSuppliers.filter(s => s.name.includes(supplierQuery))
    : allSuppliers;

  const handleSupplierQueryChange = (val) => {
    guardEdit(() => {
      setSupplierQuery(val);
      setSupplierId(null);
      setSupplier(null);
      openSupplierDropdown();
    });
  };

  const selectSupplier = (s) => {
    setSupplierId(s.id);
    setSupplierQuery(s.name);
    setSupplier(s);
    setSupplierDropdownOpen(false);
    setFxRateInput(s.fx_rate || '');
  };

  const handleConfirm = () => {
    if (!supplierId || !location) return;
    setConfirmed(true);
  };

  const saveSupplierFxRate = async () => {
    guardEdit(async () => {
      try {
        const res = await fetch(`/api/po-suppliers/${supplierId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currency: supplier.currency, fxRate: fxRateInput }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setSupplier(data);
        setEditingFxRate(false);
      } catch (e) {
        setError(e.message);
      }
    });
  };

  // ── Card 3: CSV upload / adjustment ─────────────────────────────────────
  const handleCsvUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    guardEdit(() => {
      Papa.parse(file, {
        skipEmptyLines: true,
        complete: (result) => {
          let rows = result.data;
          if (rows.length === 0) return;
          // Header detection: quantity is column 4 (index 3), cost column 5
          // (index 4) — if either doesn't parse as a number on the first
          // row, treat that row as a header and skip it.
          const first = rows[0];
          if (isNaN(parseFloat(first[3])) || isNaN(parseFloat(first[4]))) {
            rows = rows.slice(1);
          }
          const parsed = rows
            .filter(cols => (cols[0] || '').trim() || (cols[1] || '').trim())
            .map(cols => ({
              code: (cols[0] || '').trim(),
              sku: (cols[1] || '').trim(),
              name: (cols[2] || '').trim(),
              quantity: (cols[3] || '').trim(),
              cost: (cols[4] || '').trim(),
              unitDiscount: (cols[5] || '').trim(),
            }));
          setCsvRows(parsed);
          setCsvFileName(file.name);
        },
        error: () => setError('Failed to parse CSV'),
      });
    });
    e.target.value = '';
  };

  const handleSaveAdjustment = () => {
    if (!adjustmentDraft.trim()) return;
    guardEdit(() => {
      setAdjustmentSaved(adjustmentDraft.trim());
      setAdjustmentDraft('');
    });
  };

  const handleRemoveAdjustment = () => {
    guardEdit(() => setAdjustmentSaved(null));
  };

  const handleStartToProcess = async () => {
    if (csvRows.length === 0) { setError('Please upload a CSV first.'); return; }
    setProcessing(true);
    setError('');
    try {
      const res = await fetch('/api/po-invoices/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId,
          invoiceNumber,
          supplierId,
          location,
          adjustment: adjustmentSaved,
          rows: csvRows,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(data.items);
      setHasMissing(data.hasMissing);
      setHasCollision(data.hasCollision);
      setHasMissingCost(data.hasMissingCost);
      setPoNumber(data.invoice.po_number);
      if (!invoiceId) {
        setInvoiceId(data.invoice.id);
        navigate(`/buyer/po-receiving/pending/${data.invoice.id}`, { replace: true });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setProcessing(false);
    }
  };

  // ── Commit ───────────────────────────────────────────────────────────────
  const persistPromotionalFlag = async (val) => {
    if (!invoiceId) return;
    await fetch(`/api/po-invoices/pending/${invoiceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPromotional: val }),
    });
  };

  const handleTogglePromotional = async (val) => {
    setIsPromotional(val);
    await persistPromotionalFlag(val);
  };

  const handleCommitLater = async () => {
    await persistPromotionalFlag(isPromotional);
    navigate('/buyer/po-receiving/commit-later');
  };

  const handleExportCsv = async () => {
    if (!invoiceId) return;
    setExportingCsv(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/${invoiceId}/export-csv`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${poNumber || invoiceNumber || 'invoice'}-export.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setExportingCsv(false);
    }
  };

  // ── Top-right page action: Discard ──────────────────────────────────────
  // Stays red "Discard" the whole way from Card 1 being locked through to a
  // successful commit — it never turns into "Commit later". The only ways
  // to end up in Commit Later are the explicit "Commit later" button (in the
  // Card 4 action row) or simply leaving the page (without hitting Discard)
  // after Start to process has succeeded. So Discard must actively delete
  // the invoice row if one has already been persisted (i.e. once Start to
  // process has created it) — otherwise it's just a plain navigate-away.
  const handleDiscard = async () => {
    if (!window.confirm('Discard this invoice? This cannot be undone, and it will not be saved to Commit Later.')) return;
    try {
      if (invoiceId) {
        const res = await fetch('/api/po-invoices/pending', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [invoiceId] }),
        });
        if (!res.ok) throw new Error('Failed to discard this invoice. Please try again.');
      }
      navigate('/buyer/po-receiving');
    } catch (e) {
      setError(e.message);
    }
  };

  const handleCommitNow = async () => {
    if (hasMissing) { window.alert('There are line item(s) missing SKU. Please resolve them before committing.'); return; }
    if (hasCollision) { window.alert('There are line item(s) with a SKU collision. Please resolve them before committing.'); return; }
    setCommitting(true);
    setError('');
    try {
      await persistPromotionalFlag(isPromotional);
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/commit`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate(`/buyer/po-receiving/committed/${invoiceId}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setCommitting(false);
    }
  };

  if (loading) {
    return (
      <Page title="Import an invoice" backAction={{ onAction: () => navigate('/buyer/po-receiving') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }

  const disabled = processing || committing;

  const isUsdSupplier = supplier?.currency === 'USD';

  // Comparison only ever happens when BOTH Invoice cost and Supplier cost are
  // real values — a row with no CSV cost (fallback-derived, raw_cost null)
  // is never compared/highlighted, regardless of which field the Settings
  // page has configured for this currency to compare against.
  const isHighlighted = (it) => {
    if (it.raw_cost === null || it.raw_cost === undefined) return false;
    if (it.supplier_cost_raw === null || it.supplier_cost_raw === undefined) return false;
    const mode = isUsdSupplier ? costComparison.usd : costComparison.cad;
    const compareField = mode === 'effective_cost' ? it.effective_cost : it.raw_cost;
    if (compareField === null || compareField === undefined) return false;
    return Number(compareField).toFixed(2) !== Number(it.supplier_cost_raw).toFixed(2);
  };

  // Priority: missing SKU first, then a cost mismatch highlighted row, then
  // everything else — same relative order the rest of the list keeps.
  const sortedItems = [...items].sort((a, b) => {
    const missingDiff = (b.is_missing ? 1 : 0) - (a.is_missing ? 1 : 0);
    if (missingDiff !== 0) return missingDiff;
    return (isHighlighted(b) ? 1 : 0) - (isHighlighted(a) ? 1 : 0);
  });
  const subtotalCad = items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.effective_cost) || 0), 0);
  const subtotalUsd = isUsdSupplier
    ? items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.raw_cost) || 0), 0)
    : null;

  // Top-right header action: red "Discard", shown continuously from Card 1
  // being locked (invoice number saved) all the way through to a successful
  // commit — it does not switch to "Commit later" once processed. Getting
  // to Commit Later happens only via the explicit button in the Card 4
  // action row, or by leaving the page without discarding.
  const headerActions = numberSaved
    ? [{ content: 'Discard', destructive: true, onAction: handleDiscard, disabled }]
    : undefined;

  return (
    <Page
      title={invoiceId ? (poNumber || invoiceNumber || 'Invoice') : 'Import an invoice'}
      subtitle={invoiceId && poNumber && invoiceNumber ? `Ref: ${invoiceNumber}` : undefined}
      titleMetadata={invoiceIdParam ? <Badge tone="attention">Commit later</Badge> : undefined}
      backAction={{ onAction: () => navigate('/buyer/po-receiving') }}
      secondaryActions={headerActions}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            {/* Card 1 */}
            {!numberSaved ? (
              <Card>
                <InlineStack gap="300" blockAlign="end">
                  <div style={{ width: 420 }}>
                    <TextField
                      label="Invoice number (reference only, optional)"
                      placeholder="for your own reference — can repeat, can be left blank"
                      value={invoiceNumber}
                      onChange={(val) => { setInvoiceNumber(val); setNumberSaved(false); }}
                      autoComplete="off"
                      disabled={disabled}
                    />
                  </div>
                  <Button variant="primary" onClick={handleSaveNumber} disabled={disabled}>Save to continue</Button>
                  <Button onClick={handleSkipNumber} disabled={disabled}>Skip</Button>
                </InlineStack>
              </Card>
            ) : (
              <Card>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">{poNumber ? 'PO number' : 'Reference invoice number'}</Text>
                  <Text fontWeight="semibold">{poNumber || invoiceNumber || '—'}</Text>
                  {poNumber && invoiceNumber && (
                    <Text tone="subdued" variant="bodySm">Ref: {invoiceNumber}</Text>
                  )}
                  <Text tone="subdued" variant="bodySm">
                    {items.length > 0
                      ? 'if you leave this page, this invoice will be saved to Commit Later'
                      : 'if you leave this page, all input info will be discarded.'}
                  </Text>
                </BlockStack>
              </Card>
            )}

            {numberSaved && !confirmed && (
              <Card>
                <BlockStack gap="200">
                  <InlineStack gap="400" wrap align="start" blockAlign="start">
                    <div ref={supplierFieldRef} style={{ minWidth: 220, position: 'relative' }}>
                      <TextField
                        label="Supplier"
                        placeholder="case sensitive"
                        value={supplierQuery}
                        onChange={handleSupplierQueryChange}
                        onFocus={openSupplierDropdown}
                        autoComplete="off"
                        disabled={disabled}
                      />
                      {supplierDropdownOpen && filteredSuppliers.length > 0 && ReactDOM.createPortal(
                        <div data-supplier-drop="true" style={supplierDropStyle}>
                          {filteredSuppliers.map(s => (
                            <div
                              key={s.id}
                              style={{ padding: '8px 12px', cursor: 'pointer' }}
                              onClick={() => selectSupplier(s)}
                            >
                              {s.name}
                            </div>
                          ))}
                        </div>,
                        document.body
                      )}
                    </div>

                    <div style={{ minWidth: 160 }}>
                      <div style={{ fontSize: '13px', color: '#6d7175', marginBottom: '4px', lineHeight: '1.4', fontWeight: '400' }}>Receiving to</div>
                      <select
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        disabled={disabled}
                        style={{
                          width: '100%', height: '36px', padding: '0 10px',
                          border: '1px solid #c9cccf', borderRadius: '8px', fontSize: '14px',
                          boxSizing: 'border-box', background: 'white',
                        }}
                      >
                        <option value="">location</option>
                        {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>

                    <div style={{ paddingTop: '22px' }}>
                      <Button variant="primary" onClick={handleConfirm} disabled={disabled || !supplierId || !location}>
                        Confirm to continue
                      </Button>
                    </div>
                  </InlineStack>

                  {supplierQuery && filteredSuppliers.length === 0 && !supplierId && (
                    <Text tone="critical" variant="bodySm">
                      Supplier may not be added yet, add it and mapping its code with SKU first.
                    </Text>
                  )}
                </BlockStack>
              </Card>
            )}

            {confirmed && supplier && (
              <InlineStack gap="600" blockAlign="center">
                <Text fontWeight="semibold">{supplier.name}</Text>
                <Text tone="subdued">{supplier.currency}</Text>
                {editingFxRate ? (
                  <InlineStack gap="150" blockAlign="center">
                    <div style={{ width: 100 }}>
                      <TextField label="" labelHidden type="number" value={String(fxRateInput)} onChange={setFxRateInput} autoComplete="off" />
                    </div>
                    <Button size="slim" onClick={saveSupplierFxRate}>Save</Button>
                  </InlineStack>
                ) : (
                  <Text tone="subdued">{supplier.currency === 'USD' ? supplier.fx_rate : '/'}</Text>
                )}
                <Button size="slim" onClick={() => setEditingFxRate(v => !v)} disabled={supplier.currency !== 'USD'}>
                  {editingFxRate ? 'Cancel' : 'Edit'}
                </Button>
                <Text tone="subdued">Receiving to: {location}</Text>
              </InlineStack>
            )}

            {confirmed && (
              <Card>
                {/* A 4-column grid (Upload CSV | filler | Add adjustment | Start to
                    process), 2 rows (labels, controls). Grid auto-sizes each row to
                    its tallest cell, so the label row and the control row line up
                    across all three columns even though "Start to process" has no
                    label of its own above it. */}
                <div style={{ display: 'grid', gridTemplateColumns: '20% 1fr 20% 20%', columnGap: '16px', rowGap: '8px' }}>
                  <div style={{ gridColumn: '1', gridRow: '1' }}>
                    <InfoTooltip text={CSV_FORMAT_TOOLTIP}>
                      <Text variant="bodySm">CSV construction requirement</Text>
                    </InfoTooltip>
                  </div>
                  <div style={{ gridColumn: '3', gridRow: '1' }}>
                    <InfoTooltip text={ADJUSTMENT_TOOLTIP}>
                      <Text variant="bodySm">Add adjustment</Text>
                    </InfoTooltip>
                  </div>

                  <div style={{ gridColumn: '1', gridRow: '2' }}>
                    <input
                      type="file"
                      accept=".csv"
                      ref={csvInputRef}
                      style={{ display: 'none' }}
                      onChange={handleCsvUpload}
                    />
                    <Button fullWidth onClick={() => csvInputRef.current.click()} disabled={disabled}>Upload CSV</Button>
                  </div>
                  <div style={{ gridColumn: '3', gridRow: '2' }}>
                    {adjustmentSaved ? (
                      <InlineStack gap="150" blockAlign="center">
                        <Text>{adjustmentSaved.endsWith('%') ? `${adjustmentSaved} added` : `$${adjustmentSaved} added`}</Text>
                        <span style={{ cursor: 'pointer', color: '#d72c0d' }} onClick={handleRemoveAdjustment}>×</span>
                      </InlineStack>
                    ) : (
                      <InlineStack gap="150" blockAlign="center">
                        <div style={{ flex: 1 }}>
                          <TextField label="" labelHidden placeholder={isUsdSupplier ? 'amount in USD' : 'amount'} value={adjustmentDraft} onChange={setAdjustmentDraft} autoComplete="off" disabled={disabled} />
                        </div>
                        {adjustmentDraft && <Button size="slim" onClick={handleSaveAdjustment}>Save</Button>}
                      </InlineStack>
                    )}
                  </div>
                  <div style={{ gridColumn: '4', gridRow: '2' }}>
                    <Button variant="primary" fullWidth onClick={handleStartToProcess} loading={processing} disabled={disabled}>
                      Start to process
                    </Button>
                  </div>
                </div>
              </Card>
            )}

            {(csvFileName || processing) && (
              <BlockStack gap="100">
                {csvFileName && <Text tone="subdued" variant="bodySm">{csvFileName} — {csvRows.length} row(s)</Text>}
                {processing && <Text tone="subdued" variant="bodySm">Processing…</Text>}
              </BlockStack>
            )}

            {items.length > 0 && (
              <InlineStack align="space-between" blockAlign="center" wrap>
                <InlineStack gap="400" blockAlign="center">
                  <InfoTooltip text={COMMITTING_RULE_TOOLTIP}>
                    <Text variant="bodySm" tone="subdued">Committing rule</Text>
                  </InfoTooltip>
                  {hasMissing && (
                    <InfoTooltip text={MISSING_SKU_TOOLTIP}>
                      <Text tone="critical" variant="bodySm">There is(are) lineitem(s) missing SKU</Text>
                    </InfoTooltip>
                  )}
                  {hasCollision && (
                    <InfoTooltip text={COLLISION_TOOLTIP}>
                      <Text tone="critical" variant="bodySm">There is(are) lineitem(s) with a SKU collision</Text>
                    </InfoTooltip>
                  )}
                  {hasMissingCost && (
                    <InfoTooltip text={MISSING_COST_TOOLTIP}>
                      <Text tone="critical" variant="bodySm">There is(are) lineitem(s) missing cost</Text>
                    </InfoTooltip>
                  )}
                </InlineStack>
                <InlineStack gap="300" blockAlign="center">
                  <InfoTooltip text="When checked, only inventory will be committed, cost field will not be updated, and also this cost will be excluded from the supplier's average cost calculation.">
                    <Checkbox label="Promotional PO" checked={isPromotional} onChange={handleTogglePromotional} />
                  </InfoTooltip>
                  <Button onClick={handleExportCsv} loading={exportingCsv} disabled={exportingCsv}>Export CSV</Button>
                  <Button onClick={handleCommitLater} disabled={committing}>Commit later</Button>
                  <Button variant="primary" onClick={handleCommitNow} loading={committing}>Commit now</Button>
                </InlineStack>
              </InlineStack>
            )}

            {items.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <InlineStack align="end" gap="400">
                    {isUsdSupplier && (
                      <Text tone="subdued" variant="bodySm">USD subtotal: {subtotalUsd.toFixed(2)}</Text>
                    )}
                    <Text variant="bodyMd" fontWeight="bold">CAD subtotal: {subtotalCad.toFixed(2)}</Text>
                  </InlineStack>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          {['SKU', 'code', 'name', 'quantity'].map(h => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{h}</th>
                          ))}
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Invoice cost</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>
                            <InfoTooltip text={isUsdSupplier ? EFFECTIVE_COST_TOOLTIP_USD : EFFECTIVE_COST_TOOLTIP_CAD}>
                              effective cost
                            </InfoTooltip>
                          </th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Supplier cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedItems.map((it, i) => {
                          const highlighted = isHighlighted(it);
                          const compareMode = isUsdSupplier ? costComparison.usd : costComparison.cad;
                          const hasRawCost = it.raw_cost !== null && it.raw_cost !== undefined;
                          const hasEffectiveCost = it.effective_cost !== null && it.effective_cost !== undefined;
                          // USD supplier only: strike through, next to effective cost, what
                          // the invoice cost would be with no discount/adjustment applied —
                          // just converted straight to CAD — whenever discount/adjustment
                          // actually changed the number. Not shown for CAD suppliers, since
                          // Invoice cost is already displayed right next to it in that case.
                          const rawCostCad = isUsdSupplier && hasRawCost ? Number(it.raw_cost) * Number(supplier?.fx_rate || 1) : null;
                          const showStrike = isUsdSupplier && rawCostCad !== null && hasEffectiveCost
                            && rawCostCad.toFixed(2) !== Number(it.effective_cost).toFixed(2);
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid #f1f1f1', background: highlighted ? '#fff8e1' : undefined }}>
                              <td style={{ padding: '10px' }}>
                                {it.is_missing ? (
                                  <InlineStack gap="100" blockAlign="center">
                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#d72c0d', display: 'inline-block' }} />
                                    <Text tone="critical">missing</Text>
                                  </InlineStack>
                                ) : it.sku}
                              </td>
                              <td style={{ padding: '10px' }}>{it.code}</td>
                              <td style={{ padding: '10px' }}>{it.name}</td>
                              <td style={{ padding: '10px' }}>{it.quantity}</td>
                              <td style={{ padding: '10px', fontWeight: highlighted && compareMode === 'invoice_cost' ? 'bold' : undefined }}>
                                {hasRawCost ? Number(it.raw_cost).toFixed(2) : '—'}
                              </td>
                              <td style={{ padding: '10px', fontWeight: highlighted && compareMode === 'effective_cost' ? 'bold' : undefined }}>
                                {!hasEffectiveCost ? (
                                  <Text tone="critical">missing</Text>
                                ) : (
                                  <>
                                    {showStrike && (
                                      <span style={{ textDecoration: 'line-through', color: '#8c9196', fontSize: '11px', marginRight: '6px' }}>
                                        {rawCostCad.toFixed(2)}
                                      </span>
                                    )}
                                    {Number(it.effective_cost).toFixed(2)}
                                  </>
                                )}
                              </td>
                              <td style={{ padding: '10px', fontWeight: highlighted ? 'bold' : undefined }}>
                                {it.supplier_cost_raw !== null && it.supplier_cost_raw !== undefined ? Number(it.supplier_cost_raw).toFixed(2) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOImportInvoice;
