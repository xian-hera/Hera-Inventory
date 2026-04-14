import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, BlockStack, Text, Button, Banner, Spinner, TextField
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

// ─── Built-in reasons (always present, cannot be deleted) ────────────────────
const BUILT_IN_REASONS = [
  { key: 'damaged_delivery',  label: 'Damaged during delivery',        sub: 'during delivery' },
  { key: 'damaged_employee',  label: 'Damaged by employee / customer', sub: 'by employee / customer' },
  { key: 'expired',           label: 'Expired',  sub: null },
  { key: 'stolen',            label: 'Stolen',   sub: null },
  { key: 'tester',            label: 'Tester',   sub: null },
];
const OTHER_REASON = { key: 'other', label: 'Other', sub: null };

// ─── Built-in types (always present, cannot be deleted) ──────────────────────
const BUILT_IN_TYPES = [
  { value: 'ALL',                label: 'All types',           metafield: null },
  { value: 'Hair & Skin Care',   label: 'Hair & Skin Care',    metafield: null },
  { value: 'Hair',               label: 'Hair',                metafield: null },
  { value: 'Wig',                label: 'Wig',                 metafield: null },
  { value: 'Braid',              label: 'Braid',               metafield: null },
  { value: 'Makeup',             label: 'Makeup',              metafield: null },
  { value: 'Tools & Accessories',label: 'Tools & Accessories', metafield: null },
  { value: 'Jewelry',            label: 'Jewelry',             metafield: null },
];

// ─── Instruction modal ───────────────────────────────────────────────────────
function InstructionModal({ cell, typeLabel, reasonLabel, isHairSkinCare, onSave, onClose }) {
  const [text, setText] = useState(cell.instruction_text || '');
  const [localText, setLocalText] = useState(cell.local_supplier_instruction_text || '');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'white', borderRadius: '12px', padding: '24px', width: '480px', maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
        <Text variant="headingMd" as="h2">Instruction — {typeLabel} × {reasonLabel}</Text>
        <div style={{ marginTop: '16px' }}>
          <TextField label="Instruction text" value={text} onChange={setText} multiline={4} autoComplete="off" placeholder="Enter instruction shown to manager after submit" />
        </div>
        {isHairSkinCare && (
          <div style={{ marginTop: '16px' }}>
            <Text variant="bodySm" tone="subdued">If local supplier brand</Text>
            <div style={{ marginTop: '6px' }}>
              <TextField label="Local supplier instruction" labelHidden value={localText} onChange={setLocalText} multiline={4} autoComplete="off" placeholder="Enter instruction shown when vendor is a local supplier brand" />
            </div>
          </div>
        )}
        <div style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave(text, localText)}>Save</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Add type modal ──────────────────────────────────────────────────────────
function AddTypeModal({ productTypes, onSave, onClose }) {
  const [selectedType, setSelectedType] = useState('');
  const [typeSearch, setTypeSearch] = useState('');
  const [useMetafield, setUseMetafield] = useState(false);
  const [mfLevel, setMfLevel] = useState('product');
  const [mfNamespaceKey, setMfNamespaceKey] = useState('');
  const [mfValue, setMfValue] = useState('');
  const filtered = productTypes.filter(t => t.toLowerCase().includes(typeSearch.toLowerCase()));
  const handleSave = () => {
    if (!selectedType) return;
    let metafield = null;
    if (useMetafield && mfNamespaceKey.trim()) {
      const parts = mfNamespaceKey.trim().split('.');
      metafield = { level: mfLevel, namespace: parts[0] || '', key: parts.slice(1).join('.') || '', value: mfValue.trim() };
    }
    onSave({ value: selectedType, label: selectedType, metafield });
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'white', borderRadius: '12px', padding: '24px', width: '440px', maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
        <Text variant="headingMd" as="h2">Add type</Text>
        <div style={{ marginTop: '16px' }}>
          <TextField label="Search product type" value={typeSearch} onChange={setTypeSearch} autoComplete="off" placeholder="Type to search..." />
          {typeSearch && (
            <div style={{ border: '1px solid #c9cccf', borderRadius: '6px', marginTop: '4px', maxHeight: '160px', overflowY: 'auto' }}>
              {filtered.length === 0 && <div style={{ padding: '8px 12px', color: '#6d7175', fontSize: '13px' }}>No results</div>}
              {filtered.map(t => (
                <div key={t} onClick={() => { setSelectedType(t); setTypeSearch(t); }} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '14px', background: selectedType === t ? '#f0f5ff' : 'white' }}>{t}</div>
              ))}
            </div>
          )}
          {selectedType && <div style={{ marginTop: '6px', fontSize: '13px', color: '#008060' }}>Selected: <strong>{selectedType}</strong></div>}
        </div>
        <div style={{ marginTop: '16px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '14px' }}>
            <input type="checkbox" checked={useMetafield} onChange={e => setUseMetafield(e.target.checked)} />
            Add metafield condition (optional)
          </label>
        </div>
        {useMetafield && (
          <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <select value={mfLevel} onChange={e => setMfLevel(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #c9cccf', borderRadius: '6px', fontSize: '14px' }}>
              <option value="product">Product</option>
              <option value="variant">Variant</option>
            </select>
            <TextField label="namespace.key" value={mfNamespaceKey} onChange={setMfNamespaceKey} autoComplete="off" placeholder="e.g. custom.supplier_type" />
            <TextField label="Value" value={mfValue} onChange={setMfValue} autoComplete="off" placeholder="Leave empty to match any value" />
          </div>
        )}
        <div style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!selectedType} onClick={handleSave}>Add</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Add reason modal ─────────────────────────────────────────────────────────
function AddReasonModal({ onSave, onClose }) {
  const [label, setLabel] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'white', borderRadius: '12px', padding: '24px', width: '360px', maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
        <Text variant="headingMd" as="h2">Add reason</Text>
        <div style={{ marginTop: '16px' }}>
          <TextField label="Reason label" value={label} onChange={setLabel} autoComplete="off" placeholder="e.g. Recalled by supplier" />
        </div>
        <div style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!label.trim()} onClick={() => onSave(label.trim())}>Add</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete confirm modal ─────────────────────────────────────────────────────
function DeleteConfirmModal({ message, onConfirm, onClose }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'white', borderRadius: '12px', padding: '24px', width: '360px', maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
        <Text variant="headingMd" as="h2">Confirm delete</Text>
        <div style={{ marginTop: '12px' }}><Text variant="bodyMd">{message}</Text></div>
        <div style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="critical" onClick={onConfirm}>Delete</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Reason header — two-line for "Damaged ..." columns ──────────────────────
function DamagedReasonHeader({ sub, reasonKey, hoverReason, setHoverReason }) {
  return (
    <th
      style={{ padding: '10px 12px', borderBottom: '2px solid #e1e3e5', textAlign: 'left', minWidth: '90px', maxWidth: '100px', verticalAlign: 'bottom' }}
      onMouseEnter={() => setHoverReason(reasonKey)}
      onMouseLeave={() => setHoverReason(null)}
    >
      <div style={{ fontWeight: '700', fontSize: '13px' }}>Damaged</div>
      <div style={{ fontWeight: '400', fontSize: '11px', color: '#6d7175', marginTop: '2px' }}>{sub}</div>
    </th>
  );
}

function SimpleReasonHeader({ label, reasonKey, hoverReason, setHoverReason, onDelete }) {
  return (
    <th
      style={{ padding: '10px 12px', borderBottom: '2px solid #e1e3e5', textAlign: 'left', fontWeight: '700', fontSize: '13px', minWidth: '80px', cursor: onDelete ? 'pointer' : 'default', verticalAlign: 'bottom' }}
      onMouseEnter={() => setHoverReason(reasonKey)}
      onMouseLeave={() => setHoverReason(null)}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        {label}
        {onDelete && hoverReason === reasonKey && (
          <button onClick={onDelete} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d72c0d', fontSize: '16px', lineHeight: 1, padding: 0 }}>×</button>
        )}
      </span>
    </th>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
function BuyerStockLossesSettings() {
  const navigate = useNavigate();

  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState('');
  const [saving, setSaving]                 = useState('');

  // Brands
  const [brands, setBrands]                 = useState([]);
  const [brandSearch, setBrandSearch]       = useState('');
  const [brandResults, setBrandResults]     = useState([]);
  const [selectedBrands, setSelectedBrands] = useState([]);
  const [allVendors, setAllVendors]         = useState([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);

  // Dropdown fixed positioning ref
  const brandInputRef                       = useRef(null);
  const [dropdownStyle, setDropdownStyle]   = useState({});

  // Custom reasons / types / matrix
  const [customReasons, setCustomReasons]   = useState([]);
  const [customTypes, setCustomTypes]       = useState([]);
  const [matrix, setMatrix]                 = useState({});
  const [productTypes, setProductTypes]     = useState([]);

  const [hoverReason, setHoverReason]       = useState(null);
  const [hoverType, setHoverType]           = useState(null);

  const [instructionModal, setInstructionModal] = useState(null);
  const [showAddType, setShowAddType]           = useState(false);
  const [showAddReason, setShowAddReason]       = useState(false);
  const [deleteConfirm, setDeleteConfirm]       = useState(null);

  // ── Load settings data ─────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [brandsRes, reasonsRes, matrixRes, typesRes] = await Promise.all([
        fetch('/api/stock-losses-settings/brands').then(r => r.json()),
        fetch('/api/stock-losses-settings/custom-reasons').then(r => r.json()),
        fetch('/api/stock-losses-settings/matrix').then(r => r.json()),
        fetch('/api/shopify/product-types').then(r => r.json()),
      ]);
      setBrands(brandsRes);
      setSelectedBrands(brandsRes.map(b => b.vendor));
      setCustomReasons(Array.isArray(reasonsRes) ? reasonsRes : []);
      setProductTypes(Array.isArray(typesRes) ? typesRes : []);
      const matrixMap = {};
      const customTypeMap = {};
      for (const row of (Array.isArray(matrixRes) ? matrixRes : [])) {
        if (!matrixMap[row.type_value]) matrixMap[row.type_value] = {};
        matrixMap[row.type_value][row.reason] = {
          photo_required: row.photo_required,
          instruction_text: row.instruction_text,
          local_supplier_instruction_text: row.local_supplier_instruction_text,
        };
        const isBuiltIn = BUILT_IN_TYPES.some(t => t.value === row.type_value);
        if (!isBuiltIn) {
          customTypeMap[row.type_value] = {
            value: row.type_value, label: row.type_label,
            metafield: row.metafield_key ? { level: row.metafield_level, namespace: row.metafield_namespace, key: row.metafield_key, value: row.metafield_value } : null,
          };
        }
      }
      setMatrix(matrixMap);
      setCustomTypes(Object.values(customTypeMap));
    } catch (e) {
      setError('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Load all vendors once at mount (cached for instant client-side search) ─
  useEffect(() => {
    setVendorsLoading(true);
    fetch('/api/shopify/vendors-tags')
      .then(r => r.json())
      .then(data => { setAllVendors(Array.isArray(data.vendors) ? data.vendors : []); })
      .catch(() => {})
      .finally(() => setVendorsLoading(false));
  }, []);

  // ── Client-side vendor filter (instant) ───────────────────────────────────
  useEffect(() => {
    if (!brandSearch.trim()) { setBrandResults([]); return; }
    const q = brandSearch.toLowerCase();
    const filtered = allVendors.filter(v => v.toLowerCase().includes(q) && !selectedBrands.includes(v));
    setBrandResults(filtered.slice(0, 20));
  }, [brandSearch, selectedBrands, allVendors]);

  // ── Recalculate dropdown position whenever results appear ─────────────────
  useEffect(() => {
    if (brandResults.length > 0 && brandInputRef.current) {
      const rect = brandInputRef.current.getBoundingClientRect();
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 2,
        left: rect.left,
        width: rect.width,
        background: 'white',
        border: '1px solid #c9cccf',
        borderRadius: '6px',
        zIndex: 10000,
        maxHeight: '200px',
        overflowY: 'auto',
        boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
      });
    }
  }, [brandResults]);

  const handleAddBrand = async (vendor) => {
    try {
      await fetch('/api/stock-losses-settings/brands', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor }),
      });
      setSelectedBrands(prev => [...prev, vendor]);
      setBrands(prev => [...prev, { vendor }]);
      setBrandSearch('');
      setBrandResults([]);
    } catch (e) { setError('Failed to add brand'); }
  };

  const handleRemoveBrand = async (vendor) => {
    const brand = brands.find(b => b.vendor === vendor);
    if (!brand) return;
    try {
      await fetch(`/api/stock-losses-settings/brands/${brand.id}`, { method: 'DELETE' });
      setBrands(prev => prev.filter(b => b.vendor !== vendor));
      setSelectedBrands(prev => prev.filter(v => v !== vendor));
    } catch (e) { setError('Failed to remove brand'); }
  };

  // ── Matrix helpers ─────────────────────────────────────────────────────────
  const getCellValue = (tv, rk, field) => matrix[tv]?.[rk]?.[field] || false;
  const getCellText  = (tv, rk, field) => matrix[tv]?.[rk]?.[field] || '';

  const allReasons = [
    ...BUILT_IN_REASONS,
    ...customReasons.map(r => ({ key: r.reason_key, label: r.reason_label, sub: null })),
    OTHER_REASON,
  ];
  const allTypes = [...BUILT_IN_TYPES, ...customTypes];

  const saveCell = async (typeValue, typeLabel, reasonKey, reasonLabel, updates) => {
    setSaving(`${typeValue}_${reasonKey}`);
    const current = matrix[typeValue]?.[reasonKey] || {};
    const merged  = { ...current, ...updates };
    try {
      const typeObj = allTypes.find(t => t.value === typeValue);
      await fetch('/api/stock-losses-settings/matrix', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type_value: typeValue, type_label: typeLabel,
          metafield_level: typeObj?.metafield?.level || null,
          metafield_namespace: typeObj?.metafield?.namespace || null,
          metafield_key: typeObj?.metafield?.key || null,
          metafield_value: typeObj?.metafield?.value || null,
          reason: reasonKey, reason_label: reasonLabel,
          photo_required: merged.photo_required || false,
          instruction_text: merged.instruction_text || null,
          local_supplier_instruction_text: merged.local_supplier_instruction_text || null,
        }),
      });
      setMatrix(prev => ({ ...prev, [typeValue]: { ...(prev[typeValue] || {}), [reasonKey]: merged } }));
    } catch (e) { setError('Failed to save setting'); }
    finally { setSaving(''); }
  };

  const handleTogglePhoto = (tv, tl, rk, rl) => {
    saveCell(tv, tl, rk, rl, { photo_required: !getCellValue(tv, rk, 'photo_required') });
  };

  const handleInstructionSave = async (text, localText) => {
    const { typeValue, typeLabel, reasonKey, reasonLabel } = instructionModal;
    await saveCell(typeValue, typeLabel, reasonKey, reasonLabel, {
      instruction_text: text || null, local_supplier_instruction_text: localText || null,
    });
    setInstructionModal(null);
  };

  // ── Add / delete custom reason ─────────────────────────────────────────────
  const handleAddReason = async (label) => {
    try {
      const res  = await fetch('/api/stock-losses-settings/custom-reasons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason_label: label }) });
      const data = await res.json();
      setCustomReasons(prev => [...prev, data.row]);
      setShowAddReason(false);
    } catch (e) { setError('Failed to add reason'); }
  };

  const handleDeleteReason = (reason) => {
    setDeleteConfirm({
      message: `Delete reason "${reason.label}"? All related settings will also be removed.`,
      onConfirm: async () => {
        try {
          await fetch(`/api/stock-losses-settings/custom-reasons/${reason.id}`, { method: 'DELETE' });
          setCustomReasons(prev => prev.filter(r => r.id !== reason.id));
          setMatrix(prev => {
            const next = { ...prev };
            for (const tv of Object.keys(next)) { const { [reason.key]: _, ...rest } = next[tv]; next[tv] = rest; }
            return next;
          });
        } catch (e) { setError('Failed to delete reason'); }
        setDeleteConfirm(null);
      },
    });
  };

  // ── Add / delete custom type ───────────────────────────────────────────────
  const handleAddType = (typeObj) => {
    const exists = allTypes.some(t => t.value === typeObj.value);
    if (exists) { setError('This type is already in the list.'); setShowAddType(false); return; }
    setCustomTypes(prev => [...prev, typeObj]);
    setShowAddType(false);
  };

  const handleDeleteType = (typeObj) => {
    setDeleteConfirm({
      message: `Delete type "${typeObj.label}"? All related settings will also be removed.`,
      onConfirm: async () => {
        try {
          await fetch(`/api/stock-losses-settings/type/${encodeURIComponent(typeObj.value)}`, { method: 'DELETE' });
          setCustomTypes(prev => prev.filter(t => t.value !== typeObj.value));
          setMatrix(prev => { const next = { ...prev }; delete next[typeObj.value]; return next; });
        } catch (e) { setError('Failed to delete type'); }
        setDeleteConfirm(null);
      },
    });
  };

  // ── Render matrix cell ─────────────────────────────────────────────────────
  const renderCell = (typeValue, typeLabel, reasonKey, reasonLabel) => {
    const isSaving       = saving === `${typeValue}_${reasonKey}`;
    const photo          = getCellValue(typeValue, reasonKey, 'photo_required');
    const hasInstruction = !!(getCellText(typeValue, reasonKey, 'instruction_text'));
    return (
      <td key={reasonKey} style={{ padding: '10px 12px', borderBottom: '1px solid #e1e3e5', verticalAlign: 'middle' }}>
        {isSaving ? <Spinner size="small" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px' }}>
              <input type="checkbox" checked={photo} onChange={() => handleTogglePhoto(typeValue, typeLabel, reasonKey, reasonLabel)} />
              <span style={{ fontWeight: '600' }}>Photo</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={hasInstruction}
                onChange={() => {
                  if (hasInstruction) {
                    saveCell(typeValue, typeLabel, reasonKey, reasonLabel, { instruction_text: null, local_supplier_instruction_text: null });
                  } else {
                    setInstructionModal({ typeValue, typeLabel, reasonKey, reasonLabel });
                  }
                }}
              />
              {hasInstruction ? (
                <span style={{ fontWeight: '600', textDecoration: 'underline', cursor: 'pointer' }} onClick={e => { e.preventDefault(); setInstructionModal({ typeValue, typeLabel, reasonKey, reasonLabel }); }}>
                  Instructions
                </span>
              ) : (
                <span style={{ fontWeight: '600' }}>Instructions</span>
              )}
            </label>
          </div>
        )}
      </td>
    );
  };

  if (loading) return (
    <Page title="Stock Losses Settings" backAction={{ onAction: () => navigate('/buyer/settings') }}>
      <div style={{ padding: '40px', textAlign: 'center' }}><Spinner /></div>
    </Page>
  );

  return (
    <>
      {/* Modals */}
      {instructionModal && (
        <InstructionModal
          cell={{ instruction_text: getCellText(instructionModal.typeValue, instructionModal.reasonKey, 'instruction_text'), local_supplier_instruction_text: getCellText(instructionModal.typeValue, instructionModal.reasonKey, 'local_supplier_instruction_text') }}
          typeLabel={instructionModal.typeLabel} reasonLabel={instructionModal.reasonLabel}
          isHairSkinCare={instructionModal.typeValue === 'Hair & Skin Care'}
          onSave={handleInstructionSave} onClose={() => setInstructionModal(null)}
        />
      )}
      {showAddType   && <AddTypeModal productTypes={productTypes} onSave={handleAddType} onClose={() => setShowAddType(false)} />}
      {showAddReason && <AddReasonModal onSave={handleAddReason} onClose={() => setShowAddReason(false)} />}
      {deleteConfirm && <DeleteConfirmModal message={deleteConfirm.message} onConfirm={deleteConfirm.onConfirm} onClose={() => setDeleteConfirm(null)} />}

      {/* Vendor dropdown — rendered outside card to escape overflow:hidden */}
      {brandResults.length > 0 && (
        <div style={dropdownStyle}>
          {brandResults.map(v => (
            <div
              key={v}
              onMouseDown={() => handleAddBrand(v)}
              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '14px' }}
              onMouseEnter={e => e.currentTarget.style.background = '#f6f6f7'}
              onMouseLeave={e => e.currentTarget.style.background = 'white'}
            >
              {v}
            </div>
          ))}
        </div>
      )}

      <Page title="Stock Losses Settings" backAction={{ onAction: () => navigate('/buyer/settings') }}>
        <Layout>
          <Layout.Section>
            <BlockStack gap="600">
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

              {/* ── Card 1: Local Supplier Brand List ── */}
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingSm">Local supplier brand list</Text>
                  <div ref={brandInputRef}>
                    <TextField
                      label="Search vendor" labelHidden
                      value={brandSearch} onChange={setBrandSearch}
                      onBlur={() => setTimeout(() => setBrandResults([]), 150)}
                      autoComplete="off"
                      placeholder={vendorsLoading ? 'Loading vendors...' : 'Search vendor...'}
                      disabled={vendorsLoading}
                    />
                  </div>
                  {selectedBrands.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
                      {selectedBrands.map(v => (
                        <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 10px', background: '#f0f5ff', border: '1px solid #b3c8ff', borderRadius: '20px', fontSize: '13px' }}>
                          {v}
                          <button onClick={() => handleRemoveBrand(v)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d72c0d', fontSize: '14px', lineHeight: 1, padding: '0 2px' }}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </BlockStack>
              </Card>

              {/* ── Card 2: Settings Matrix ── */}
              <Card padding="0">
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '580px' }}>
                    <thead>
                      <tr>
                        <th style={{ padding: '10px 12px', borderBottom: '2px solid #e1e3e5', textAlign: 'left', minWidth: '130px' }} />
                        {/* "Damaged during delivery" — two-line */}
                        <DamagedReasonHeader
                          sub="during delivery"
                          reasonKey="damaged_delivery"
                          hoverReason={hoverReason}
                          setHoverReason={setHoverReason}
                        />
                        {/* "Damaged by employee / customer" — two-line */}
                        <DamagedReasonHeader
                          sub="by employee / customer"
                          reasonKey="damaged_employee"
                          hoverReason={hoverReason}
                          setHoverReason={setHoverReason}
                        />
                        {/* Remaining built-in reasons */}
                        {BUILT_IN_REASONS.filter(r => !r.sub).map(r => (
                          <SimpleReasonHeader key={r.key} label={r.label} reasonKey={r.key} hoverReason={hoverReason} setHoverReason={setHoverReason} onDelete={null} />
                        ))}
                        {/* Custom reasons */}
                        {customReasons.map(r => (
                          <SimpleReasonHeader
                            key={r.reason_key} label={r.reason_label} reasonKey={r.reason_key}
                            hoverReason={hoverReason} setHoverReason={setHoverReason}
                            onDelete={() => handleDeleteReason({ id: r.id, key: r.reason_key, label: r.reason_label })}
                          />
                        ))}
                        <SimpleReasonHeader label="Other" reasonKey="other" hoverReason={hoverReason} setHoverReason={setHoverReason} onDelete={null} />
                        <th style={{ padding: '10px 12px', borderBottom: '2px solid #e1e3e5' }}>
                          <Button onClick={() => setShowAddReason(true)}>Add+</Button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {BUILT_IN_TYPES.map(type => (
                        <tr key={type.value}>
                          <td style={{ padding: '10px 12px', borderBottom: '1px solid #e1e3e5', fontWeight: '700', fontSize: '14px', whiteSpace: 'nowrap' }}>{type.label}</td>
                          {BUILT_IN_REASONS.map(r => renderCell(type.value, type.label, r.key, r.label))}
                          {customReasons.map(r => renderCell(type.value, type.label, r.reason_key, r.reason_label))}
                          {renderCell(type.value, type.label, OTHER_REASON.key, OTHER_REASON.label)}
                          <td style={{ borderBottom: '1px solid #e1e3e5' }} />
                        </tr>
                      ))}
                      {customTypes.map(type => (
                        <tr key={type.value}>
                          <td
                            style={{ padding: '10px 12px', borderBottom: '1px solid #e1e3e5', fontWeight: '700', fontSize: '14px', whiteSpace: 'nowrap', cursor: 'pointer' }}
                            onMouseEnter={() => setHoverType(type.value)} onMouseLeave={() => setHoverType(null)}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {type.label}
                              {type.metafield && <span style={{ fontSize: '11px', color: '#6d7175', fontWeight: '400' }}>({type.metafield.namespace}.{type.metafield.key})</span>}
                              {hoverType === type.value && (
                                <button onClick={() => handleDeleteType(type)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d72c0d', fontSize: '16px', lineHeight: 1, padding: 0 }}>×</button>
                              )}
                            </span>
                          </td>
                          {BUILT_IN_REASONS.map(r => renderCell(type.value, type.label, r.key, r.label))}
                          {customReasons.map(r => renderCell(type.value, type.label, r.reason_key, r.reason_label))}
                          {renderCell(type.value, type.label, OTHER_REASON.key, OTHER_REASON.label)}
                          <td style={{ borderBottom: '1px solid #e1e3e5' }} />
                        </tr>
                      ))}
                      <tr>
                        <td style={{ padding: '10px 12px' }}><Button onClick={() => setShowAddType(true)}>Add+</Button></td>
                        {allReasons.map(r => <td key={r.key} />)}
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Card>

            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}

export default BuyerStockLossesSettings;