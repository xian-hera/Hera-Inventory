import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import Papa from 'papaparse';
import {
  Page, Layout, Card, Button, ButtonGroup, BlockStack, InlineStack, Text, TextField,
  Banner, Badge, Checkbox, Spinner, Popover, ActionList, Modal
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

const CSV_FORMAT_TOOLTIP = (
  <>
    All columns must have a valid header.<br />
    Accepted headers are: <strong>Code</strong>, <strong>SKU</strong>, <strong>Name</strong>, <strong>Quantity</strong>, <strong>Cost</strong>, <strong>Unit Discount</strong>.
  </>
);

// Recognized CSV header names (case-insensitive, trimmed) → the field they
// map to. "quantity" and "qty" are both accepted for the same field; every
// other recognized header matches its field name literally.
const CSV_HEADER_ALIASES = {
  code: 'code',
  sku: 'sku',
  name: 'name',
  quantity: 'quantity',
  qty: 'quantity',
  cost: 'cost',
  'unit discount': 'unitDiscount',
};

const COMMITTING_RULE_TOOLTIP = `Committing will update cost field, new cost = (current qty × current cost + invoice qty × invoice unit cost) ÷ (current qty + invoice qty)`;

const MISSING_SKU_TOOLTIP = `Go to Supplier management to add the missing SKU mapping first, then restart this importing, or add this to Commit later, and commit it after SKU added.`;

const COLLISION_TOOLTIP = `Two or more unit codes on this invoice resolved to the same SKU. Fix the supplier's code mapping (or the CSV) and re-process before committing.`;

const MISSING_COST_TOOLTIP = `This line item has no cost — it was left blank in the CSV and there's no Supplier cost metafield value to fall back on. It can still be committed: inventory will be received as normal, but the cost (and Shopify's average cost) will not be updated for it. Fill in a cost on the CSV, or set the SKU's Supplier cost metafield in Shopify, then re-process if you want the cost to be included.`;

const EFFECTIVE_COST_TOOLTIP_USD = `effective cost = invoice cost + adjustment + unit discount + converted to CAD`;
const EFFECTIVE_COST_TOOLTIP_CAD = `effective cost = invoice cost + adjustment + unit discount`;

const STATUS_PILLS = {
  pending: { label: 'Commit later', tone: 'attention' },
  sent_to_store: { label: 'Sent to store', tone: 'info' },
  store_counted: { label: 'Store counted', tone: 'success' },
  committed: { label: 'committed', tone: 'success' },
};

// Accepts "2026-09-01" (native date input) as-is; also tolerates a bare
// "MMDD" fallback (e.g. "0901") typed into the same field on a browser that
// doesn't render a real calendar for type="date" — interpreted as the
// current year.
function normalizeDateInput(val) {
  if (!val) return '';
  const v = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{4}$/.test(v)) {
    const year = new Date().getFullYear();
    const mm = v.slice(0, 2);
    const dd = v.slice(2, 4);
    return `${year}-${mm}-${dd}`;
  }
  return v;
}

function BuyerPOImportInvoice() {
  const navigate = useNavigate();
  const { invoiceId: invoiceIdParam } = useParams();

  const [invoiceId, setInvoiceId] = useState(invoiceIdParam ? Number(invoiceIdParam) : null);
  const [loading, setLoading] = useState(!!invoiceIdParam);
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [sendingToStore, setSendingToStore] = useState(false);
  const [status, setStatus] = useState('pending');

  // Reference number is now a free-text, optional field edited inline next
  // to the title — no more separate "Card 1" wizard step to save/skip it.
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [poNumber, setPoNumber] = useState(null);
  const [editingReference, setEditingReference] = useState(false);
  const [referenceDraft, setReferenceDraft] = useState('');
  const [savingReference, setSavingReference] = useState(false);

  // Invoice date — the date printed on the supplier's invoice itself, not
  // when it was entered here. Native type="date" gives a calendar picker in
  // every modern browser; normalizeDateInput() tolerates a bare MMDD typed
  // fallback for anything that renders it as a plain text field.
  const [invoiceDate, setInvoiceDateState] = useState('');
  const [savingDate, setSavingDate] = useState(false);

  // Card 2 (supplier / location)
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
  // Informational, non-blocking notices from the last CSV parse (excluded
  // columns, rows skipped for missing quantity/code-or-SKU, cost fallback) —
  // shown as small text under the filename/row-count line. A hard rejection
  // (duplicated header, no quantity column, no Code/SKU column) goes through
  // the regular `error` Banner instead, since it blocks processing outright.
  const [csvNotices, setCsvNotices] = useState([]);
  const [adjustmentDraft, setAdjustmentDraft] = useState('');
  const [adjustmentSaved, setAdjustmentSaved] = useState(null);

  // Card 4 / result
  const [items, setItems] = useState([]);
  const [hasMissing, setHasMissing] = useState(false);
  const [hasCollision, setHasCollision] = useState(false);
  const [hasMissingCost, setHasMissingCost] = useState(false);
  const [isPromotional, setIsPromotional] = useState(false);

  // Card 4 — inline editing / selection / add-item
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [editingItemId, setEditingItemId] = useState(null);
  const [editingField, setEditingField] = useState(null); // 'quantity' | 'cost'
  const [editQtyDraft, setEditQtyDraft] = useState('');
  const [editCostDraft, setEditCostDraft] = useState('');
  const [savingItemEdit, setSavingItemEdit] = useState(false);
  const [deletingItems, setDeletingItems] = useState(false);
  const [addItemModalOpen, setAddItemModalOpen] = useState(false);
  const [addItemInput, setAddItemInput] = useState('');
  const [addItemQty, setAddItemQty] = useState('1');
  const [addItemCost, setAddItemCost] = useState('');
  const [addingItem, setAddingItem] = useState(false);

  // Store count (buyer view of the manager's count, once counted) — the
  // buyer edits a correction *delta* (e.g. -1, +2); it's translated to/from
  // the absolute store_count the manager's endpoint stores.
  const [editingStoreCountId, setEditingStoreCountId] = useState(null);
  const [storeCountDraft, setStoreCountDraft] = useState('');
  const [savingStoreCount, setSavingStoreCount] = useState(false);

  // Actions menu (merged Send to store / Commit later / Commit)
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);

  // Note
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [buyerNote, setBuyerNote] = useState(null);
  const [buyerNoteAt, setBuyerNoteAt] = useState(null);
  const [managerNote, setManagerNote] = useState(null);
  const [managerNoteAt, setManagerNoteAt] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);

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

  const applyInvoicePayload = (inv, its) => {
    setInvoiceId(inv.id);
    setInvoiceNumber(inv.invoice_number || '');
    setPoNumber(inv.po_number || null);
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
    setInvoiceDateState(inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : '');
    setStatus(inv.status || 'pending');
    setBuyerNote(inv.buyer_note || null);
    setBuyerNoteAt(inv.buyer_note_at || null);
    setManagerNote(inv.manager_note || null);
    setManagerNoteAt(inv.manager_note_at || null);
    setItems(its);
    setHasMissing(inv.has_missing_sku);
    setHasCollision(inv.has_sku_collision);
    setHasMissingCost(inv.has_missing_cost);
    setSelectedIds(new Set());
  };

  // ── Load an existing pending invoice ────────────────────────────────────
  useEffect(() => {
    if (!invoiceIdParam) return;
    (async () => {
      try {
        const res = await fetch(`/api/po-invoices/pending/${invoiceIdParam}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        applyInvoicePayload(data.invoice, data.items);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceIdParam]);

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

  // ── Card: supplier dropdown ──────────────────────────────────────────────
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

  // ── Invoice date ─────────────────────────────────────────────────────────
  const handleDateChange = async (val) => {
    const normalized = normalizeDateInput(val);
    setInvoiceDateState(normalized);
    if (!invoiceId) return; // not yet persisted — will go out with Start to process
    setSavingDate(true);
    try {
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceDate: normalized || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingDate(false);
    }
  };

  // ── Reference number (inline, replaces the old Card 1 wizard step) ──────
  const openReferenceEditor = () => {
    setReferenceDraft(invoiceNumber || '');
    setEditingReference(true);
  };

  const saveReference = async () => {
    if (!invoiceId) {
      // Not yet processed — nothing persisted to a server row yet, just keep
      // it locally; it goes out as part of the Start to process request.
      setInvoiceNumber(referenceDraft.trim());
      setEditingReference(false);
      return;
    }
    setSavingReference(true);
    try {
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/reference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceNumber: referenceDraft.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setInvoiceNumber(data.invoice_number || '');
      setEditingReference(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingReference(false);
    }
  };

  // ── Card 3: CSV upload / adjustment ─────────────────────────────────────
  // The CSV must always have a header row now — no more positional/no-header
  // support. Columns are matched to fields by header text (case-insensitive,
  // trimmed); any column whose header is blank, unrecognized, or a duplicate
  // of an already-used recognized header is excluded, with a notice. See
  // CSV_HEADER_ALIASES for the recognized set.
  const handleCsvUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    guardEdit(() => {
      Papa.parse(file, {
        skipEmptyLines: true,
        complete: (result) => {
          const allRows = result.data;
          setCsvFileName(file.name);
          if (allRows.length === 0) {
            setCsvRows([]);
            setCsvNotices([]);
            setError('CSV is empty.');
            return;
          }

          const headerRow = allRows[0];
          const dataRows = allRows.slice(1);
          const normalize = (h) => (h || '').toString().trim().toLowerCase();

          // Map each recognized field to its (first) column index, tracking
          // exclusion notices for blank/unrecognized/duplicate headers as we
          // go. A duplicate of a recognized header is a hard rejection (see
          // below), not just an exclusion.
          const fieldToIndex = {};
          const columnNotices = [];
          let hasDuplicateHeader = false;

          headerRow.forEach((h, i) => {
            const colNum = i + 1;
            const norm = normalize(h);
            if (!norm) {
              const hasData = dataRows.some(row => (row[i] || '').toString().trim());
              if (hasData) columnNotices.push(`Column ${colNum} excluded: no header.`);
              return;
            }
            const field = CSV_HEADER_ALIASES[norm];
            if (!field) {
              columnNotices.push(`Column ${colNum} excluded: header not recognized.`);
              return;
            }
            if (fieldToIndex[field] !== undefined) {
              hasDuplicateHeader = true;
              return;
            }
            fieldToIndex[field] = i;
          });

          const rejectMessages = [];
          if (hasDuplicateHeader) rejectMessages.push('Processing failed: duplicated header');

          const quantityIdx = fieldToIndex.quantity;
          const anyQuantity = quantityIdx !== undefined
            && dataRows.some(row => (row[quantityIdx] || '').toString().trim());
          if (quantityIdx === undefined || !anyQuantity) {
            rejectMessages.push('processing failed: no quantity');
          }

          const codeIdx = fieldToIndex.code;
          const skuIdx = fieldToIndex.sku;
          if (codeIdx === undefined && skuIdx === undefined) {
            rejectMessages.push('processing failed: no Code or SKU column found');
          }

          if (rejectMessages.length > 0) {
            setCsvRows([]);
            setCsvNotices([]);
            setError(rejectMessages.join('\n'));
            return;
          }

          const nameIdx = fieldToIndex.name;
          const costIdx = fieldToIndex.cost;
          const discountIdx = fieldToIndex.unitDiscount;

          let someQuantityMissing = false;
          let someCodeSkuMissing = false;
          let someCostMissing = costIdx === undefined; // whole column absent → same fallback outcome as blank cells

          const parsed = [];
          for (const row of dataRows) {
            const rowHasAnyValue = row.some(c => (c || '').toString().trim());
            if (!rowHasAnyValue) continue;

            const quantity = (row[quantityIdx] || '').toString().trim();
            if (!quantity) { someQuantityMissing = true; continue; }

            const code = codeIdx !== undefined ? (row[codeIdx] || '').toString().trim() : '';
            const sku = skuIdx !== undefined ? (row[skuIdx] || '').toString().trim() : '';
            if (!code && !sku) { someCodeSkuMissing = true; continue; }

            const cost = costIdx !== undefined ? (row[costIdx] || '').toString().trim() : '';
            if (costIdx !== undefined && !cost) someCostMissing = true;

            parsed.push({
              code,
              sku,
              name: nameIdx !== undefined ? (row[nameIdx] || '').toString().trim() : '',
              quantity,
              cost,
              unitDiscount: discountIdx !== undefined ? (row[discountIdx] || '').toString().trim() : '',
            });
          }

          const notices = [...columnNotices];
          if (someCostMissing) notices.push('Missing cost will default to Supplier Cost.');
          if (someQuantityMissing) notices.push('some row(s) is skipped: no quantity');
          if (someCodeSkuMissing) notices.push('some row(s) is skipped: no Code or SKU');

          setCsvRows(parsed);
          setCsvNotices(notices);
          setError('');
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
          invoiceDate: invoiceDate || null,
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
      setStatus(data.invoice.status || 'pending');
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

  // ── Card 4: inline edit / delete / add ──────────────────────────────────
  const refreshAfterItemsChange = (data) => {
    setItems(data.items);
    setHasMissing(!!data.invoice.has_missing_sku);
    setHasCollision(!!data.invoice.has_sku_collision);
    setHasMissingCost(!!data.invoice.has_missing_cost);
  };

  // editingItemId/editingField together identify a single cell being edited
  // — clicking quantity only ever puts quantity into edit mode, clicking
  // cost only ever puts cost into edit mode, never both at once.
  const startEditQty = (item) => {
    setEditingItemId(item.id);
    setEditingField('quantity');
    setEditQtyDraft(String(item.quantity));
  };

  const startEditCost = (item) => {
    setEditingItemId(item.id);
    setEditingField('cost');
    setEditCostDraft(item.raw_cost !== null && item.raw_cost !== undefined ? String(item.raw_cost) : '');
  };

  const cancelEditItem = () => {
    setEditingItemId(null);
    setEditingField(null);
    setEditQtyDraft('');
    setEditCostDraft('');
  };

  const saveEditItem = async (itemId, field) => {
    setSavingItemEdit(true);
    setError('');
    try {
      const body = field === 'quantity'
        ? { quantity: editQtyDraft }
        : { cost: editCostDraft === '' ? null : editCostDraft };
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      refreshAfterItemsChange(data);
      cancelEditItem();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingItemEdit(false);
    }
  };

  const toggleSelectItem = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(prev => (prev.size === items.length ? new Set() : new Set(items.map(it => it.id))));
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedIds.size} selected line item(s)? This cannot be undone.`)) return;
    setDeletingItems(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/items`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: [...selectedIds] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      refreshAfterItemsChange(data);
      setSelectedIds(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingItems(false);
    }
  };

  const openAddItemModal = () => {
    setAddItemInput('');
    setAddItemQty('1');
    setAddItemCost('');
    setAddItemModalOpen(true);
  };

  const handleAddItem = async () => {
    if (!addItemInput.trim()) { setError('Enter a SKU or code'); return; }
    setAddingItem(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeOrSku: addItemInput.trim(), quantity: addItemQty, cost: addItemCost || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      refreshAfterItemsChange(data);
      setAddItemModalOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setAddingItem(false);
    }
  };

  // ── Store count (buyer-side correction-delta view/edit) ─────────────────
  // store_count is the manager's absolute counted quantity; the buyer edits
  // a signed *delta* against the original invoice quantity instead — this
  // is purely a display/edit transformation, translated back to an absolute
  // count before saving (delta = store_count - quantity).
  const storeCountDelta = (item) => (item.store_count === null || item.store_count === undefined)
    ? null
    : Number(item.store_count) - Number(item.quantity);

  const startEditStoreCount = (item) => {
    const delta = storeCountDelta(item);
    setEditingStoreCountId(item.id);
    setStoreCountDraft(delta === null ? '0' : String(delta));
  };

  const saveStoreCount = async (item) => {
    const delta = parseInt(storeCountDraft, 10);
    if (isNaN(delta)) { setError('Invalid correction value'); return; }
    const absolute = Number(item.quantity) + delta;
    if (absolute < 0) { setError('Store count cannot be negative'); return; }
    setSavingStoreCount(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/manager/receiving/${invoiceId}/items/${item.id}/count`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: absolute }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(prev => prev.map(it => (it.id === item.id ? data : it)));
      setEditingStoreCountId(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingStoreCount(false);
    }
  };

  // ── Notes ────────────────────────────────────────────────────────────────
  const openNoteModal = () => {
    setNoteDraft('');
    setNoteModalOpen(true);
  };

  const saveBuyerNote = async () => {
    if (!noteDraft.trim()) return;
    setSavingNote(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/notes/buyer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: noteDraft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBuyerNote(data.buyer_note);
      setBuyerNoteAt(data.buyer_note_at);
      setNoteDraft('');
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingNote(false);
    }
  };

  const deleteBuyerNote = async () => {
    setSavingNote(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/notes/buyer`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBuyerNote(null);
      setBuyerNoteAt(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingNote(false);
    }
  };

  // ── Commit / Commit later / Send to store ───────────────────────────────
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
    setActionsMenuOpen(false);
    await persistPromotionalFlag(isPromotional);
    navigate('/buyer/po-receiving/commit-later');
  };

  const handleSendToStore = async () => {
    setActionsMenuOpen(false);
    if (hasMissing) { window.alert('There are line item(s) missing SKU. Please resolve them before sending to store.'); return; }
    if (hasCollision) { window.alert('There are line item(s) with a SKU collision. Please resolve them before sending to store.'); return; }
    if (!window.confirm('Send this invoice to the store for counting? You will not be able to edit line items until the manager finishes counting.')) return;
    setSendingToStore(true);
    setError('');
    try {
      await persistPromotionalFlag(isPromotional);
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/send-to-store`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus(data.status);
    } catch (e) {
      setError(e.message);
    } finally {
      setSendingToStore(false);
    }
  };

  const handleExportPdf = async () => {
    if (!invoiceId) return;
    setExportingPdf(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/${invoiceId}/export-pdf`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${poNumber || invoiceNumber || 'invoice'}-export.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setExportingPdf(false);
    }
  };

  // ── Top-right page action: Discard ──────────────────────────────────────
  // Stays red "Discard" the whole way from the first field being touched
  // through to a successful commit — it never turns into "Commit later".
  // The only ways to end up in Commit Later are the explicit "Commit later"
  // action or simply leaving the page after Start to process has succeeded.
  // So Discard must actively delete the invoice row if one has already been
  // persisted (i.e. once Start to process has created it) — otherwise it's
  // just a plain navigate-away.
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
    setActionsMenuOpen(false);
    if (hasMissing) { window.alert('There are line item(s) missing SKU. Please resolve them before committing.'); return; }
    if (hasCollision) { window.alert('There are line item(s) with a SKU collision. Please resolve them before committing.'); return; }
    // The buyer can commit a 'sent_to_store' invoice at any time — it does
    // not have to wait for the manager's count. commitInvoice() on the
    // server falls back to the original invoice quantity for any line item
    // that hasn't been counted yet.
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

  const disabled = processing || committing || sendingToStore;
  // Line items can only be edited/deleted/added-to while the invoice is
  // still 'pending' (not yet sent to the store for counting).
  const itemsEditable = status === 'pending';
  const showStoreCountColumn = status === 'sent_to_store' || status === 'store_counted';

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

  const pill = STATUS_PILLS[status] || STATUS_PILLS.pending;

  const headerActions = invoiceId || items.length > 0
    ? [{ content: 'Discard', destructive: true, onAction: handleDiscard, disabled }]
    : undefined;

  return (
    <Page
      title={invoiceId ? (poNumber || invoiceNumber || 'Invoice') : 'Import an invoice'}
      titleMetadata={invoiceId ? <Badge tone={pill.tone}>{pill.label}</Badge> : undefined}
      backAction={{ onAction: () => navigate('/buyer/po-receiving') }}
      secondaryActions={headerActions}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && (
              <Banner tone="critical" onDismiss={() => setError('')}>
                <div style={{ whiteSpace: 'pre-line' }}>{error}</div>
              </Banner>
            )}

            {/* Reference number — inline, next to the title area, replacing
                the old separate wizard step. */}
            <InlineStack gap="200" blockAlign="center">
              {editingReference ? (
                <InlineStack gap="150" blockAlign="center">
                  <div style={{ width: 220 }}>
                    <TextField
                      label="" labelHidden
                      placeholder="reference number (optional)"
                      value={referenceDraft}
                      onChange={setReferenceDraft}
                      autoComplete="off"
                      disabled={savingReference}
                    />
                  </div>
                  <Button size="slim" onClick={saveReference} loading={savingReference}>Save</Button>
                  <Button size="slim" onClick={() => setEditingReference(false)} disabled={savingReference}>Cancel</Button>
                </InlineStack>
              ) : invoiceNumber ? (
                <Text tone="subdued" variant="bodySm">
                  Ref: {invoiceNumber}{' '}
                  <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={openReferenceEditor}>edit</span>
                </Text>
              ) : (
                <span style={{ cursor: 'pointer', textDecoration: 'underline', fontSize: '13px', color: '#6d7175' }} onClick={openReferenceEditor}>
                  + add reference number
                </span>
              )}
            </InlineStack>

            {!invoiceId && items.length === 0 && (
              <Text tone="subdued" variant="bodySm">if you leave this page before processing, all input info will be discarded.</Text>
            )}
            {invoiceId && (
              <Text tone="subdued" variant="bodySm">
                {items.length > 0 ? 'if you leave this page, this invoice will be saved to Commit Later' : ''}
              </Text>
            )}

            {!confirmed ? (
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

                    <div style={{ minWidth: 160 }}>
                      <TextField
                        label="Invoice date"
                        type="date"
                        value={invoiceDate}
                        onChange={handleDateChange}
                        autoComplete="off"
                        disabled={disabled}
                      />
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
            ) : (
              <InlineStack gap="600" blockAlign="center" wrap>
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
                <div style={{ width: 160 }}>
                  <TextField
                    label="Invoice date" labelHidden
                    type="date"
                    value={invoiceDate}
                    onChange={handleDateChange}
                    autoComplete="off"
                    disabled={disabled || !itemsEditable}
                  />
                </div>
                {savingDate && <Spinner size="small" />}
              </InlineStack>
            )}

            {confirmed && itemsEditable && (
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
                {csvNotices.map((n, i) => (
                  <Text key={i} tone="subdued" variant="bodySm">{n}</Text>
                ))}
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
                  {itemsEditable && (
                    <InfoTooltip text="When checked, only inventory will be committed, cost field will not be updated, and also this cost will be excluded from the supplier's average cost calculation.">
                      <Checkbox label="Promotional PO" checked={isPromotional} onChange={handleTogglePromotional} />
                    </InfoTooltip>
                  )}
                  <Button onClick={openNoteModal}>
                    Note{(buyerNote || managerNote) ? ' •' : ''}
                  </Button>
                  <Button onClick={handleExportPdf} loading={exportingPdf} disabled={exportingPdf}>Export PDF</Button>
                  {status === 'sent_to_store' && (
                    <Text tone="subdued" variant="bodySm">Waiting for the store to count this invoice.</Text>
                  )}
                  {(() => {
                    // The merged action button's default (main) action and
                    // its collapsed dropdown options both depend on the
                    // invoice's current status — per Hera's spec:
                    //   pending        → default Send to store, dropdown [Commit later, Commit]
                    //   sent_to_store  → default Commit later,  dropdown [Commit]
                    //   store_counted  → default Commit,        dropdown [Commit later]
                    const ACTIONS = {
                      send_to_store: { content: 'Send to store', onAction: handleSendToStore, loading: sendingToStore },
                      commit_later: { content: 'Commit later', onAction: handleCommitLater },
                      commit: { content: 'Commit', onAction: handleCommitNow, loading: committing },
                    };
                    const CONFIG = {
                      pending: { default: 'send_to_store', dropdown: ['commit_later', 'commit'] },
                      sent_to_store: { default: 'commit_later', dropdown: ['commit'] },
                      store_counted: { default: 'commit', dropdown: ['commit_later'] },
                    };
                    const config = CONFIG[status] || CONFIG.pending;
                    const defaultAction = ACTIONS[config.default];
                    const dropdownActions = config.dropdown.map(key => ACTIONS[key]);
                    return (
                      <Popover
                        active={actionsMenuOpen}
                        onClose={() => setActionsMenuOpen(false)}
                        activator={
                          <ButtonGroup variant="segmented">
                            <Button variant="primary" onClick={defaultAction.onAction} loading={defaultAction.loading}>
                              {defaultAction.content}
                            </Button>
                            <Button variant="primary" onClick={() => setActionsMenuOpen(v => !v)} disclosure disabled={disabled} />
                          </ButtonGroup>
                        }
                      >
                        <ActionList
                          items={dropdownActions.map(a => ({
                            content: a.content,
                            onAction: () => { setActionsMenuOpen(false); a.onAction(); },
                          }))}
                        />
                      </Popover>
                    );
                  })()}
                </InlineStack>
              </InlineStack>
            )}

            {itemsEditable && items.length > 0 && (
              <InlineStack gap="200" blockAlign="center">
                <Button onClick={openAddItemModal} disabled={disabled}>+ item</Button>
                <Button
                  tone="critical"
                  onClick={handleDeleteSelected}
                  disabled={selectedIds.size === 0 || deletingItems}
                  loading={deletingItems}
                >
                  Delete selected{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                </Button>
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
                          {itemsEditable && (
                            <th style={{ padding: '8px 6px' }}>
                              <input type="checkbox" checked={items.length > 0 && selectedIds.size === items.length} onChange={toggleSelectAll} />
                            </th>
                          )}
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
                          {showStoreCountColumn && (
                            <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Store count</th>
                          )}
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
                          const isEditingQty = editingItemId === it.id && editingField === 'quantity';
                          const isEditingCost = editingItemId === it.id && editingField === 'cost';
                          const qtyEdited = it.quantity_original !== null && it.quantity_original !== undefined
                            && Number(it.quantity_original) !== Number(it.quantity);
                          const costEdited = it.raw_cost_original !== null && it.raw_cost_original !== undefined
                            && hasRawCost && Number(it.raw_cost_original) !== Number(it.raw_cost);
                          const delta = showStoreCountColumn ? storeCountDelta(it) : null;
                          return (
                            <tr key={it.id} style={{ borderBottom: '1px solid #f1f1f1', background: highlighted ? '#fff8e1' : undefined }}>
                              {itemsEditable && (
                                <td style={{ padding: '10px 6px' }}>
                                  <input type="checkbox" checked={selectedIds.has(it.id)} onChange={() => toggleSelectItem(it.id)} />
                                </td>
                              )}
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
                              <td style={{ padding: '10px' }}>
                                {isEditingQty ? (
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                                    <input
                                      type="number"
                                      value={editQtyDraft}
                                      onChange={(e) => setEditQtyDraft(e.target.value)}
                                      autoFocus
                                      style={{
                                        width: '3.5em', padding: '4px 6px', fontSize: '13px',
                                        border: '1px solid #c9cccf', borderRadius: '6px', boxSizing: 'content-box',
                                      }}
                                    />
                                    <button
                                      onClick={() => saveEditItem(it.id, 'quantity')}
                                      disabled={savingItemEdit}
                                      title="Save"
                                      style={{
                                        width: '22px', height: '22px', padding: 0, lineHeight: 1,
                                        border: '1px solid #008060', borderRadius: '4px', background: '#e3f1df',
                                        color: '#008060', cursor: savingItemEdit ? 'default' : 'pointer', fontWeight: 700,
                                      }}
                                    >✓</button>
                                    <button
                                      onClick={cancelEditItem}
                                      disabled={savingItemEdit}
                                      title="Cancel"
                                      style={{
                                        width: '22px', height: '22px', padding: 0, lineHeight: 1,
                                        border: '1px solid #c9cccf', borderRadius: '4px', background: 'white',
                                        color: '#6d7175', cursor: savingItemEdit ? 'default' : 'pointer', fontWeight: 700,
                                      }}
                                    >✕</button>
                                  </span>
                                ) : itemsEditable ? (
                                  <span style={{ cursor: 'pointer' }} onClick={() => startEditQty(it)}>
                                    {qtyEdited && (
                                      <span style={{ textDecoration: 'line-through', color: '#8c9196', fontSize: '11px', marginRight: '6px' }}>
                                        {it.quantity_original}
                                      </span>
                                    )}
                                    {it.quantity}
                                  </span>
                                ) : (
                                  <>
                                    {qtyEdited && (
                                      <span style={{ textDecoration: 'line-through', color: '#8c9196', fontSize: '11px', marginRight: '6px' }}>
                                        {it.quantity_original}
                                      </span>
                                    )}
                                    {it.quantity}
                                  </>
                                )}
                              </td>
                              <td style={{ padding: '10px', fontWeight: highlighted && compareMode === 'invoice_cost' ? 'bold' : undefined }}>
                                {isEditingCost ? (
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                                    <input
                                      type="number"
                                      value={editCostDraft}
                                      onChange={(e) => setEditCostDraft(e.target.value)}
                                      placeholder="—"
                                      autoFocus
                                      style={{
                                        width: '4.5em', padding: '4px 6px', fontSize: '13px',
                                        border: '1px solid #c9cccf', borderRadius: '6px', boxSizing: 'content-box',
                                      }}
                                    />
                                    <button
                                      onClick={() => saveEditItem(it.id, 'cost')}
                                      disabled={savingItemEdit}
                                      title="Save"
                                      style={{
                                        width: '22px', height: '22px', padding: 0, lineHeight: 1,
                                        border: '1px solid #008060', borderRadius: '4px', background: '#e3f1df',
                                        color: '#008060', cursor: savingItemEdit ? 'default' : 'pointer', fontWeight: 700,
                                      }}
                                    >✓</button>
                                    <button
                                      onClick={cancelEditItem}
                                      disabled={savingItemEdit}
                                      title="Cancel"
                                      style={{
                                        width: '22px', height: '22px', padding: 0, lineHeight: 1,
                                        border: '1px solid #c9cccf', borderRadius: '4px', background: 'white',
                                        color: '#6d7175', cursor: savingItemEdit ? 'default' : 'pointer', fontWeight: 700,
                                      }}
                                    >✕</button>
                                  </span>
                                ) : itemsEditable ? (
                                  <span style={{ cursor: 'pointer' }} onClick={() => startEditCost(it)}>
                                    {costEdited && (
                                      <span style={{ textDecoration: 'line-through', color: '#8c9196', fontSize: '11px', marginRight: '6px' }}>
                                        {Number(it.raw_cost_original).toFixed(2)}
                                      </span>
                                    )}
                                    {hasRawCost ? Number(it.raw_cost).toFixed(2) : '—'}
                                  </span>
                                ) : (
                                  <>
                                    {costEdited && (
                                      <span style={{ textDecoration: 'line-through', color: '#8c9196', fontSize: '11px', marginRight: '6px' }}>
                                        {Number(it.raw_cost_original).toFixed(2)}
                                      </span>
                                    )}
                                    {hasRawCost ? Number(it.raw_cost).toFixed(2) : '—'}
                                  </>
                                )}
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
                              {showStoreCountColumn && (
                                <td style={{ padding: '10px' }}>
                                  {editingStoreCountId === it.id ? (
                                    <InlineStack gap="100" blockAlign="center">
                                      <div style={{ width: 60 }}>
                                        <TextField label="" labelHidden type="number" value={storeCountDraft} onChange={setStoreCountDraft} autoComplete="off" />
                                      </div>
                                      <Button size="slim" onClick={() => saveStoreCount(it)} loading={savingStoreCount}>Save</Button>
                                      <Button size="slim" onClick={() => setEditingStoreCountId(null)} disabled={savingStoreCount}>Cancel</Button>
                                    </InlineStack>
                                  ) : delta === null ? (
                                    <Text tone="subdued">not counted yet</Text>
                                  ) : (
                                    <span style={{ cursor: 'pointer' }} onClick={() => startEditStoreCount(it)}>
                                      {delta === 0 ? '0' : (delta > 0 ? `+${delta}` : String(delta))}
                                    </span>
                                  )}
                                </td>
                              )}
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

      {/* + item modal */}
      <Modal
        open={addItemModalOpen}
        onClose={() => setAddItemModalOpen(false)}
        title="Add a line item"
        primaryAction={{ content: 'Add', onAction: handleAddItem, loading: addingItem }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setAddItemModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField label="SKU or code" value={addItemInput} onChange={setAddItemInput} autoComplete="off" />
            <TextField label="Quantity" type="number" value={addItemQty} onChange={setAddItemQty} autoComplete="off" />
            <TextField label="Cost (blank = use Supplier cost)" type="number" value={addItemCost} onChange={setAddItemCost} autoComplete="off" />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Note modal — buyer note editable/deletable (one at a time), manager
          note shown read-only as a reply, per the 1-note-each rule enforced
          server-side. */}
      <Modal
        open={noteModalOpen}
        onClose={() => setNoteModalOpen(false)}
        title="Note"
        secondaryActions={[{ content: 'Close', onAction: () => setNoteModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {buyerNote ? (
              <BlockStack gap="100">
                <Text variant="bodySm" tone="subdued">Your note{buyerNoteAt ? ` — ${new Date(buyerNoteAt).toLocaleString()}` : ''}</Text>
                <Text>{buyerNote}</Text>
                <div>
                  <Button size="slim" tone="critical" onClick={deleteBuyerNote} loading={savingNote}>Delete</Button>
                </div>
              </BlockStack>
            ) : (
              <BlockStack gap="200">
                <TextField label="Add a note" value={noteDraft} onChange={setNoteDraft} multiline={3} autoComplete="off" />
                <div>
                  <Button size="slim" onClick={saveBuyerNote} loading={savingNote} disabled={!noteDraft.trim()}>Save note</Button>
                </div>
              </BlockStack>
            )}
            {managerNote && (
              <BlockStack gap="100">
                <Text variant="bodySm" tone="subdued">Manager reply{managerNoteAt ? ` — ${new Date(managerNoteAt).toLocaleString()}` : ''}</Text>
                <Text>{managerNote}</Text>
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default BuyerPOImportInvoice;
