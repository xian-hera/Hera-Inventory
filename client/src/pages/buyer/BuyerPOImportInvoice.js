import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import Papa from 'papaparse';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField,
  Banner, Badge, Checkbox, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
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

const COMMITTING_RULE_TOOLTIP = `Committing will update cost field, new cost = (current qty × current cost + invoice qty × invoice unit cost) ÷ (current qty + invoice qty)`;

const MISSING_SKU_TOOLTIP = `Go to Supplier management to add the missing SKU mapping first, then restart this importing, or add this to Commit later, and commit it after SKU added.`;

const COLLISION_TOOLTIP = `Two or more unit codes on this invoice resolved to the same SKU. Fix the supplier's code mapping (or the CSV) and re-process before committing.`;

function BuyerPOImportInvoice() {
  const navigate = useNavigate();
  const { invoiceId: invoiceIdParam } = useParams();

  const [invoiceId, setInvoiceId] = useState(invoiceIdParam ? Number(invoiceIdParam) : null);
  const [loading, setLoading] = useState(!!invoiceIdParam);
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);
  const [committing, setCommitting] = useState(false);

  // Card 1
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [numberSaved, setNumberSaved] = useState(false);

  // Card 2
  const [supplierQuery, setSupplierQuery] = useState('');
  const [supplierId, setSupplierId] = useState(null);
  const [supplierMatches, setSupplierMatches] = useState([]);
  const [supplierDropdownOpen, setSupplierDropdownOpen] = useState(false);
  const [supplierDropStyle, setSupplierDropStyle] = useState({});
  const supplierFieldRef = useRef(null);
  const [supplier, setSupplier] = useState(null); // { id, name, currency, fx_rate }
  const [productTypes, setProductTypes] = useState([]);
  const [typeOptions, setTypeOptions] = useState([]);
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
  const [isPromotional, setIsPromotional] = useState(false);

  const csvInputRef = useRef(null);

  useEffect(() => {
    fetch('/api/shopify/product-types')
      .then(r => r.json())
      .then(data => setTypeOptions(Array.isArray(data) ? data : []))
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
        setInvoiceNumber(inv.invoice_number);
        setNumberSaved(true);
        setSupplierId(inv.supplier_id);
        setSupplierQuery(inv.supplier_name);
        setSupplier({ id: inv.supplier_id, name: inv.supplier_name, currency: inv.supplier_currency, fx_rate: inv.fx_rate });
        setProductTypes(inv.product_types || []);
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
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [invoiceIdParam]);

  // ── Card 1: invoice number ──────────────────────────────────────────────
  const handleSaveNumber = async () => {
    if (!invoiceNumber.trim()) { setError('Invoice number is required.'); return; }
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/check-number?number=${encodeURIComponent(invoiceNumber.trim())}`);
      const data = await res.json();
      if (!data.available) { setError('An invoice with this number already exists.'); return; }
      setNumberSaved(true);
    } catch (e) {
      setNumberSaved(true); // advisory check only — don't block on network failure
    }
  };

  // ── Discard-and-reprocess guard ─────────────────────────────────────────
  const guardEdit = useCallback((applyChange) => {
    if (items.length > 0) {
      if (!window.confirm('Editing this will discard the processed result. You will need to click "Start to process" again. Continue?')) {
        return;
      }
      setItems([]);
      setHasMissing(false);
      setHasCollision(false);
    }
    applyChange();
  }, [items]);

  // ── Card 2: supplier autocomplete ───────────────────────────────────────
  // The dropdown is rendered via a portal into document.body (positioned with
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
        maxHeight: '200px',
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

  const handleSupplierQueryChange = (val) => {
    guardEdit(() => {
      setSupplierQuery(val);
      setSupplierId(null);
      setSupplier(null);
      openSupplierDropdown();
      if (!val) { setSupplierMatches([]); return; }
      fetch(`/api/po-suppliers/autocomplete?q=${encodeURIComponent(val)}`)
        .then(r => r.json())
        .then(data => setSupplierMatches(Array.isArray(data) ? data : []))
        .catch(() => setSupplierMatches([]));
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
    if (!supplierId || productTypes.length === 0 || !location) return;
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
          // Header detection: if the quantity or cost column of the first row
          // doesn't parse as a number, treat that row as a header and skip it.
          const first = rows[0];
          if (isNaN(parseFloat(first[2])) || isNaN(parseFloat(first[3]))) {
            rows = rows.slice(1);
          }
          const parsed = rows
            .filter(cols => (cols[0] || '').trim())
            .map(cols => ({
              code: (cols[0] || '').trim(),
              name: (cols[1] || '').trim(),
              quantity: (cols[2] || '').trim(),
              cost: (cols[3] || '').trim(),
              unitDiscount: (cols[4] || '').trim(),
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
          productTypes,
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
  const sortedItems = [...items].sort((a, b) => (b.is_missing ? 1 : 0) - (a.is_missing ? 1 : 0));

  return (
    <Page
      title={invoiceIdParam ? invoiceNumber : 'Import an invoice'}
      titleMetadata={invoiceIdParam ? <Badge tone="attention">Commit later</Badge> : undefined}
      backAction={{ onAction: () => navigate('/buyer/po-receiving') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            {/* Card 1 */}
            <Card>
              <InlineStack gap="300" blockAlign="end">
                <div style={{ width: 220 }}>
                  <TextField
                    label="Invoice number"
                    value={invoiceNumber}
                    onChange={(val) => guardEdit(() => { setInvoiceNumber(val); setNumberSaved(false); })}
                    autoComplete="off"
                    disabled={disabled}
                  />
                </div>
                <Button onClick={handleSaveNumber} disabled={disabled || numberSaved}>Save</Button>
              </InlineStack>
            </Card>

            {(numberSaved || confirmed) && (
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
                      {supplierDropdownOpen && supplierMatches.length > 0 && ReactDOM.createPortal(
                        <div data-supplier-drop="true" style={supplierDropStyle}>
                          {supplierMatches.map(s => (
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

                    <div style={{ minWidth: 220 }}>
                      <MultiSelectDropdown
                        label="Type"
                        options={typeOptions}
                        selected={productTypes}
                        onChange={(val) => guardEdit(() => setProductTypes(val))}
                        placeholder="product type"
                      />
                    </div>

                    <div style={{ width: 160 }}>
                      <Text variant="bodySm" tone="subdued">Receiving to</Text>
                      <select
                        value={location}
                        onChange={(e) => guardEdit(() => setLocation(e.target.value))}
                        disabled={disabled}
                        style={{ padding: '6px 10px', border: '1px solid #c9cccf', borderRadius: '6px', fontSize: '14px', width: '100%' }}
                      >
                        <option value="">location</option>
                        {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>

                    <div style={{ paddingTop: '22px' }}>
                      <Button onClick={handleConfirm} disabled={disabled || !supplierId || productTypes.length === 0 || !location}>
                        Confirm
                      </Button>
                    </div>
                  </InlineStack>

                  {supplierQuery && supplierMatches.length === 0 && !supplierId && (
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
              </InlineStack>
            )}

            {confirmed && (
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
                  {/* Column 1 — Upload CSV, 20% width, left-aligned */}
                  <div style={{ width: '20%', minWidth: '180px' }}>
                    <BlockStack gap="200">
                      <input
                        type="file"
                        accept=".csv"
                        ref={csvInputRef}
                        style={{ display: 'none' }}
                        onChange={handleCsvUpload}
                      />
                      <Button fullWidth onClick={() => csvInputRef.current.click()} disabled={disabled}>Upload CSV</Button>
                      {/* Line breaks below are exact, per Hera's spec — allowed to overflow
                          this column's width rather than reflow. */}
                      <div style={{ whiteSpace: 'pre', fontSize: '13px', color: '#6d7175' }}>
{`accepted format, column 1, unit code
column 2, name
column 3, quantity
column 4, cost
column 5, unit discount(if applicable, can be % or amount) `}
                      </div>
                      {csvFileName && <Text variant="bodySm" tone="subdued">{csvFileName} — {csvRows.length} row(s)</Text>}
                    </BlockStack>
                  </div>

                  {/* Columns 2 & 3 — Add adjustment / Start to process, each 20% width, grouped to the right */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '16px', width: '40%', minWidth: '360px' }}>
                    <div style={{ width: '50%', minWidth: '180px' }}>
                      <BlockStack gap="200">
                        <InfoTooltip text={ADJUSTMENT_TOOLTIP}>
                          <Text variant="bodySm">Add adjustment</Text>
                        </InfoTooltip>
                        {adjustmentSaved ? (
                          <InlineStack gap="150" blockAlign="center">
                            <Text>{adjustmentSaved.endsWith('%') ? `${adjustmentSaved} added` : `$${adjustmentSaved} added`}</Text>
                            <span style={{ cursor: 'pointer', color: '#d72c0d' }} onClick={handleRemoveAdjustment}>×</span>
                          </InlineStack>
                        ) : (
                          <InlineStack gap="150" blockAlign="center">
                            <div style={{ width: 130 }}>
                              <TextField label="" labelHidden placeholder="amount" value={adjustmentDraft} onChange={setAdjustmentDraft} autoComplete="off" disabled={disabled} />
                            </div>
                            {adjustmentDraft && <Button size="slim" onClick={handleSaveAdjustment}>Save</Button>}
                          </InlineStack>
                        )}
                      </BlockStack>
                    </div>

                    <div style={{ width: '50%', minWidth: '180px' }}>
                      <Button variant="primary" fullWidth onClick={handleStartToProcess} loading={processing} disabled={disabled}>
                        Start to process
                      </Button>
                    </div>
                  </div>
                </div>
                {processing && <Text tone="subdued">Processing…</Text>}
              </Card>
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
                </InlineStack>
                <InlineStack gap="300" blockAlign="center">
                  <InfoTooltip text="When checked, only inventory will be committed, cost field will not be updated, and also this cost will be excluded from the supplier's average cost calculation.">
                    <Checkbox label="Promotional PO" checked={isPromotional} onChange={handleTogglePromotional} />
                  </InfoTooltip>
                  <Button onClick={handleCommitLater} disabled={committing}>Commit later</Button>
                  <Button variant="primary" onClick={handleCommitNow} loading={committing}>Commit now</Button>
                </InlineStack>
              </InlineStack>
            )}

            {items.length > 0 && (
              <Card>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        {['SKU', 'code', 'name', 'quantity', 'cost'].map(h => (
                          <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedItems.map((it, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f1f1f1' }}>
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
                          <td style={{ padding: '10px' }}>
                            {Number(it.cost_before_adjustment).toFixed(2) !== Number(it.effective_cost).toFixed(2) && (
                              <span style={{ textDecoration: 'line-through', color: '#8c9196', fontSize: '11px', marginRight: '6px' }}>
                                {Number(it.cost_before_adjustment).toFixed(2)}
                              </span>
                            )}
                            {Number(it.effective_cost).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOImportInvoice;
