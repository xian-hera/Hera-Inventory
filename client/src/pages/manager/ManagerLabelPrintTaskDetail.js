import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, TextField, Modal, Select, Checkbox,
  DataTable,
} from '@shopify/polaris';
import { useParams, useNavigate } from 'react-router-dom';

const CUSTOM_NAME_NAMESPACE = 'custom';
const CUSTOM_NAME_KEY = 'name';

function resolveKey(e) {
  if (e.key && e.key !== 'Unidentified' && e.key.length === 1) return e.key;
  if (e.code) {
    if (e.code.startsWith('Digit')) return e.code.slice(5);
    if (e.code.startsWith('Numpad') && e.code.length === 7) return e.code.slice(6);
    if (e.code.startsWith('Key') && e.code.length === 4) {
      const ch = e.code.slice(3);
      return e.shiftKey ? ch : ch.toLowerCase();
    }
    const sym = { Minus:'-', Equal:'=', BracketLeft:'[', BracketRight:']',
      Backslash:'\\', Semicolon:';', Quote:"'", Backquote:'`',
      Comma:',', Period:'.', Slash:'/' };
    if (sym[e.code]) return sym[e.code];
  }
  return null;
}

function cleanBarcode(raw) {
  return raw.replace(/^[^0-9]+/, '');
}

function ManagerLabelPrintTaskDetail() {
  const { taskId } = useParams();
  const navigate = useNavigate();

  const [task, setTask]         = useState(null);
  const [items, setItems]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError]     = useState('');
  const [selectedIds, setSelectedIds] = useState([]);

  const [searchQuery, setSearchQuery]     = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchChecked, setSearchChecked] = useState([]);
  const [searchDropOpen, setSearchDropOpen] = useState(false);
  const [dropdownPos, setDropdownPos]     = useState({ top: 0, left: 0, width: 0 });
  const [addingItems, setAddingItems]     = useState(false);
  const [addError, setAddError]           = useState('');

  const searchInputRef = useRef(null);
  const searchDropRef  = useRef(null);

  const [showPrint, setShowPrint]           = useState(false);
  const [templates, setTemplates]           = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [printQty, setPrintQty]             = useState('1');
  const [printing, setPrinting]             = useState(false);
  const [printError, setPrintError]         = useState('');
  const [deleteItemId, setDeleteItemId]     = useState(null);
  const [deleteLoading, setDeleteLoading]   = useState(false);

  const barcodeBuffer  = useRef('');
  const barcodeTimer   = useRef(null);
  const itemsRef       = useRef(items);
  const searchDebounce = useRef(null);

  // Update dropdown position whenever it opens or results change
  useEffect(() => {
    if (searchDropOpen && searchInputRef.current) {
      const rect = searchInputRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, [searchDropOpen, searchResults]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!searchDropOpen) return;
    const handleMouseDown = (e) => {
      if (
        searchInputRef.current && !searchInputRef.current.contains(e.target) &&
        searchDropRef.current && !searchDropRef.current.contains(e.target)
      ) {
        setSearchDropOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [searchDropOpen]);

  useEffect(() => { itemsRef.current = items; }, [items]);

  const fetchTask = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [taskRes, itemsRes] = await Promise.all([
        fetch(`/api/label-print-tasks/${taskId}`),
        fetch(`/api/label-print-tasks/${taskId}/items`),
      ]);
      if (!taskRes.ok) throw new Error('Task not found');
      const [taskData, itemsData] = await Promise.all([taskRes.json(), itemsRes.json()]);
      setTask(taskData);
      setItems(itemsData);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { fetchTask(); }, [fetchTask]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      const activeTag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA'].includes(activeTag)) return;

      if (e.key === 'Enter') {
        clearTimeout(barcodeTimer.current);
        const barcode = cleanBarcode(barcodeBuffer.current.trim());
        barcodeBuffer.current = '';
        if (barcode.length > 0) addBySku(barcode);
        return;
      }

      const ch = resolveKey(e);
      if (ch) {
        barcodeBuffer.current += ch;
        clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => { barcodeBuffer.current = ''; }, 500);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(barcodeTimer.current);
    };
  }, []);

  const addBySku = async (sku) => {
    if (!sku) return;
    setScanLoading(true);
    setScanError('');
    try {
      const res = await fetch(`/api/shopify/variant-by-sku?sku=${encodeURIComponent(sku)}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'SKU not found');
      }
      const { variant, product } = await res.json();

      const existing = itemsRef.current.find(i => i.sku === variant.sku);
      if (existing) {
        await handleQtyChange(existing.id, existing.qty_to_print + 1);
        return;
      }

      const customName = variant.metafields?.find(
        m => m.namespace === CUSTOM_NAME_NAMESPACE && m.key === CUSTOM_NAME_KEY
      )?.value || '';

      const addRes = await fetch(`/api/label-print-tasks/${taskId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant_id: variant.id,
          sku: variant.sku,
          product_title: product.title,
          variant_title: variant.title,
          custom_name: customName,
          price: variant.price || null,
          compare_at_price: variant.compare_at_price || null,
          barcode: variant.barcode || null,
          vendor: product.vendor || null,
          product_type: product.product_type || null,
          qty_to_print: 1,
        }),
      });
      if (!addRes.ok) throw new Error('Failed to add item');
      const newItem = await addRes.json();
      setItems(prev => [newItem, ...prev]);
    } catch (e) {
      setScanError(e.message);
    } finally {
      setScanLoading(false);
    }
  };

  // Search with debounce
  const handleSearchChange = (value) => {
    setSearchQuery(value);
    setAddError('');
    clearTimeout(searchDebounce.current);
    if (value.trim().length < 2) {
      setSearchResults([]);
      setSearchChecked([]);
      setSearchDropOpen(false);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const params = new URLSearchParams({ q: value.trim() });
        const res = await fetch(`/api/shopify/search?${params.toString()}`);
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        setSearchResults(data.slice(0, 30));
        setSearchDropOpen(true);
      } catch (e) {
        setSearchResults([]);
        setSearchDropOpen(false);
      } finally {
        setSearchLoading(false);
      }
    }, 400);
  };

  const toggleSearchCheck = (variantId) => {
    setSearchChecked(prev =>
      prev.includes(variantId) ? prev.filter(x => x !== variantId) : [...prev, variantId]
    );
  };

  const handleAddChecked = async () => {
    const toAdd = searchResults.filter(r => searchChecked.includes(r.variantId));
    if (toAdd.length === 0) return;
    setAddingItems(true);
    setAddError('');
    try {
      for (const item of toAdd) {
        const sku = item.barcode; // barcode === sku in this store
        // Skip if already in list
        if (itemsRef.current.find(i => i.sku === sku)) continue;
        const res = await fetch(`/api/label-print-tasks/${taskId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            variant_id: item.variantId,
            sku,
            custom_name: item.name,
            qty_to_print: 1,
          }),
        });
        if (!res.ok) throw new Error('Failed to add item');
        const newItem = await res.json();
        setItems(prev => [newItem, ...prev]);
      }
      setSearchChecked([]);
      setSearchQuery('');
      setSearchResults([]);
      setSearchDropOpen(false);
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAddingItems(false);
    }
  };

  const handleQtyChange = async (itemId, newQty) => {
    const qty = Math.max(1, parseInt(newQty) || 1);
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, qty_to_print: qty } : i));
    try {
      await fetch(`/api/label-print-tasks/${taskId}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qty_to_print: qty }),
      });
    } catch (e) {
      setScanError('Failed to update quantity.');
    }
  };

  const handleDeleteItem = async () => {
    if (!deleteItemId) return;
    setDeleteLoading(true);
    try {
      await fetch(`/api/label-print-tasks/${taskId}/items/${deleteItemId}`, { method: 'DELETE' });
      setItems(prev => prev.filter(i => i.id !== deleteItemId));
      setSelectedIds(prev => prev.filter(x => x !== deleteItemId));
      setDeleteItemId(null);
    } catch (e) {
      setScanError('Failed to delete item.');
    } finally {
      setDeleteLoading(false);
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const allSelected = items.length > 0 && selectedIds.length === items.length;
  const toggleAll = () => setSelectedIds(allSelected ? [] : items.map(i => i.id));

  const openPrintAllModal = async () => {
    setSelectedIds(items.map(i => i.id));
    setShowPrint(true);
    setPrintError('');
    setPrintQty('1');
    setSelectedTemplate('');
    setTemplatesLoading(true);
    try {
      const res = await fetch('/api/label-templates/published');
      if (!res.ok) throw new Error('Failed to load templates');
      const data = await res.json();
      setTemplates(data);
      if (data.length > 0) setSelectedTemplate(String(data[0].id));
    } catch (e) {
      setPrintError('Failed to load templates.');
    } finally {
      setTemplatesLoading(false);
    }
  };

  const openPrintModal = async () => {
    if (selectedIds.length === 0) return;
    setShowPrint(true);
    setPrintError('');
    setPrintQty('1');
    setSelectedTemplate('');
    setTemplatesLoading(true);
    try {
      const res = await fetch('/api/label-templates/published');
      if (!res.ok) throw new Error('Failed to load templates');
      const data = await res.json();
      setTemplates(data);
      if (data.length > 0) setSelectedTemplate(String(data[0].id));
    } catch (e) {
      setPrintError('Failed to load templates.');
    } finally {
      setTemplatesLoading(false);
    }
  };

  const handlePrint = async () => {
    if (!selectedTemplate) { setPrintError('Please select a template.'); return; }
    const qty = parseInt(printQty) || 1;
    setPrinting(true);
    setPrintError('');
    try {
      const tmplRes = await fetch(`/api/label-templates/${selectedTemplate}`);
      if (!tmplRes.ok) throw new Error('Failed to load template');
      const tmpl = await tmplRes.json();
      const selectedItems = items.filter(i => selectedIds.includes(i.id));

      // Fetch live variant data for all items at print time.
      // This ensures fields like price, vendor, product_title etc. are always current,
      // regardless of whether the item was added via scan or search.
      const liveDataMap = {};
      await Promise.all(selectedItems.map(async (item) => {
        try {
          const res = await fetch(`/api/shopify/variant-by-sku?sku=${encodeURIComponent(item.sku)}`);
          if (!res.ok) return;
          liveDataMap[item.sku] = await res.json();
        } catch { /* skip — item will print with whatever is stored */ }
      }));

      // Enrich each item with live Shopify data, falling back to stored values
      const enrichedItems = selectedItems.map(item => {
        const live = liveDataMap[item.sku];
        if (!live) return item;
        const { variant, product } = live;
        const customName = variant.metafields?.find(
          m => m.namespace === CUSTOM_NAME_NAMESPACE && m.key === CUSTOM_NAME_KEY
        )?.value || item.custom_name || '';
        return {
          ...item,
          product_title:    product.title               || item.product_title,
          variant_title:    variant.title               || item.variant_title,
          custom_name:      customName,
          price:            variant.price               ?? item.price,
          compare_at_price: variant.compare_at_price    ?? item.compare_at_price,
          barcode:          variant.barcode             || item.barcode,
          vendor:           product.vendor              || item.vendor,
          product_type:     product.product_type        || item.product_type,
        };
      });

      // metafieldMap reuses liveDataMap for template elements referencing arbitrary metafields
      const metafieldMap = {};
      Object.entries(liveDataMap).forEach(([sku, data]) => { metafieldMap[sku] = data; });

      const printContent = buildPrintHtml(tmpl, enrichedItems, qty, metafieldMap);
      const win = window.open('', '_blank');
      if (!win) throw new Error('Pop-up blocked. Please allow pop-ups for this site.');
      win.document.write(printContent);
      win.document.close();
      win.focus();
      setTimeout(() => { win.print(); }, 800);
      setShowPrint(false);
    } catch (e) {
      setPrintError(e.message);
    } finally {
      setPrinting(false);
    }
  };

  function buildPrintHtml(tmpl, selectedItems, qty, metafieldMap = {}) {
    const MM_TO_PX = 3.7795275591;
    const SEPARATOR = ' · ';
    const pw = tmpl.paper_width_mm;
    const ph = tmpl.paper_height_mm;
    const barcodeInits = [];

    // Calculate total label count upfront so we can skip page-break on the last label
    const totalLabels = selectedItems.reduce((sum, item) => sum + item.qty_to_print * qty, 0);

    const labelHtml = (item, labelIndex) => {
      const isLast = labelIndex === totalLabels - 1;

      const fields = {
        'product.title':            item.product_title || '',
        'variant.title':            item.variant_title || '',
        'variant.sku':              item.sku || '',
        'variant.price':            item.price ? `$${item.price}` : '',
        'variant.compare_at_price': item.compare_at_price ? `$${item.compare_at_price}` : '',
        'variant.barcode':          item.barcode || '',
        'product.vendor':           item.vendor || '',
        'product.product_type':     item.product_type || '',
        'variant.metafield':        item.custom_name || '',
        'product.metafield':        '',
      };

      const elementsHtml = (tmpl.elements || []).map((el, elIndex) => {
        const left = el.x * MM_TO_PX;
        const top  = el.y * MM_TO_PX;
        const width  = el.w * MM_TO_PX;
        const height = el.h * MM_TO_PX;
        const angle  = el.angle || 0;
        const rotateStyle = angle ? `transform:rotate(${angle}deg);transform-origin:50% 50%;` : '';
        const baseStyle = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;overflow:hidden;box-sizing:border-box;${rotateStyle}`;

        if (el.type === 'text') {
          const entries = el.field_entries && el.field_entries.length > 0
            ? el.field_entries
            : [{ fieldKey: el.field_key, customValue: el.custom_value || '' }];

          const value = entries.map(fe => {
            if (fe.fieldKey === 'custom') return fe.customValue || '';
            if (fe.fieldKey === 'variant.metafield') {
              const ns = fe.metafieldNamespace || fe.metafield_namespace || '';
              const key = fe.metafieldKey || fe.metafield_key || '';
              if (!ns || !key) return item.custom_name || '';
              const mfData = metafieldMap[item.sku];
              return mfData?.variant?.metafields?.find(m => m.namespace === ns && m.key === key)?.value || '';
            }
            if (fe.fieldKey === 'product.metafield') {
              const ns = fe.metafieldNamespace || fe.metafield_namespace || '';
              const key = fe.metafieldKey || fe.metafield_key || '';
              if (!ns || !key) return '';
              const mfData = metafieldMap[item.sku];
              return mfData?.product?.metafields?.find(m => m.namespace === ns && m.key === key)?.value || '';
            }
            return fields[fe.fieldKey] ?? '';
          }).filter(v => v !== '').join(SEPARATOR);

          const displayValue = applyCase(value, el.convert_case);
          const fw = el.font_weight || '400';
          const fs = (el.font_size || 3) * MM_TO_PX;
          const align = el.align || 'left';
          const decoration = el.underline ? 'underline' : el.linethrough ? 'line-through' : 'none';
          // Fixed box position; text wraps within width, clamped to 2 lines, rest hidden.
          const textStyle = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;box-sizing:border-box;${rotateStyle}font-size:${fs}px;font-weight:${fw};text-align:${align};font-family:sans-serif;text-decoration:${decoration};line-height:1.2;word-wrap:break-word;overflow-wrap:break-word;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;`;
          return `<div style="${textStyle}">${displayValue}</div>`;
        }

        if (el.type === 'barcode') {
          const barcodeValue = fields[el.field_key] || item.barcode || item.sku || '';
          if (!barcodeValue) return `<div style="${baseStyle}"></div>`;
          const barcodeType = el.barcode_type || 'CODE128';
          const svgId = `bc_${labelIndex}_${elIndex}`;
          barcodeInits.push({ id: svgId, value: barcodeValue, type: barcodeType });
          return `<div style="${baseStyle}display:flex;align-items:center;justify-content:center;"><svg id="${svgId}" style="width:100%;height:100%;"></svg></div>`;
        }

        if (el.type === 'line') {
          const isH = el.orientation !== 'vertical';
          const sw = { thin: 0.5, medium: 1, thick: 2 }[el.stroke_key] || 0.5;
          const lineOuter = `position:absolute;left:${left}px;top:${top}px;width:${Math.max(width, 1)}px;height:${Math.max(height, 1)}px;box-sizing:border-box;${rotateStyle}`;
          return `<div style="${lineOuter}"><div style="position:absolute;${isH ? `top:50%;left:0;width:100%;border-top:${sw}mm solid #000;` : `left:50%;top:0;height:100%;border-left:${sw}mm solid #000;`}"></div></div>`;
        }

        if (el.type === 'frame') {
          const sw = { thin: 0.5, medium: 1, thick: 2 }[el.stroke_key] || 0.5;
          const br = el.border_radius || 0;
          return `<div style="${baseStyle}border:${sw}mm solid #000;border-radius:${br}px;"></div>`;
        }

        if (el.type === 'svg' && el.svg_data) {
          return `<div style="${baseStyle}">${el.svg_data}</div>`;
        }

        return '';
      }).join('');

      // No page-break on the last label — prevents blank trailing page on some Windows printers
      const pageBreak = isLast ? '' : 'page-break-after:always;';
      return `<div style="position:relative;width:${pw}mm;height:${ph}mm;overflow:hidden;${pageBreak}box-sizing:border-box;">${elementsHtml}</div>`;
    };

    let labelIndex = 0;
    const allLabels = selectedItems.flatMap(item =>
      Array.from({ length: item.qty_to_print * qty }, () => labelHtml(item, labelIndex++))
    ).join('');

    const barcodeScript = barcodeInits.length > 0 ? `
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<script>
window.addEventListener('load', function() {
  var barcodes = ${JSON.stringify(barcodeInits)};
  barcodes.forEach(function(bc) {
    var el = document.getElementById(bc.id);
    if (!el) return;
    try {
      JsBarcode(el, bc.value, { format: bc.type, displayValue: false, margin: 2, width: 2,
        height: Math.max(20, el.parentElement.clientHeight * 0.8) });
      el.setAttribute('width', '100%');
      el.setAttribute('height', '100%');
    } catch(e) { console.warn('Barcode error for', bc.value, e); }
  });
});
<\/script>` : '';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Print labels</title>
<style>* { margin:0;padding:0;box-sizing:border-box; } @page { size:${pw}mm ${ph}mm;margin:0; } body { background:#fff; }</style>
${barcodeScript}</head><body>${allLabels}</body></html>`;
  }

  function applyCase(str, mode) {
    if (!str) return '';
    if (mode === 'upper') return str.toUpperCase();
    if (mode === 'lower') return str.toLowerCase();
    if (mode === 'title') return str.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
    return str;
  }

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
      <Spinner />
    </div>
  );

  if (error) return (
    <Page title="Error" backAction={{ onAction: () => navigate('/manager/label-print') }}>
      <Banner tone="critical">{error}</Banner>
    </Page>
  );

  const templateOptions = templates.map(t => ({
    label: `${t.name} (${t.paper_width_mm}×${t.paper_height_mm}mm)`,
    value: String(t.id),
  }));

  return (
    <Page
      title={task?.name || 'Print task'}
      backAction={{ onAction: () => navigate('/manager/label-print') }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingSm">Scan or search to add items</Text>

              {/* Search bar */}
              <div ref={searchInputRef} style={{ position: 'relative' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => handleSearchChange(e.target.value)}
                    onFocus={e => { e.target.style.borderColor = '#005bd3'; if (searchResults.length > 0) setSearchDropOpen(true); }}
                    onBlur={e => { e.target.style.borderColor = '#c9cccf'; }}
                    placeholder="Search by name or SKU..."
                    autoComplete="off"
                    style={{
                      flex: 1, padding: '8px 12px',
                      border: '1px solid #c9cccf', borderRadius: '8px',
                      fontSize: '14px', outline: 'none', boxSizing: 'border-box',
                    }}
                  />
                  {(searchLoading || scanLoading) && <Spinner size="small" />}
                  <button
                    onClick={handleAddChecked}
                    disabled={searchChecked.length === 0 || addingItems}
                    style={{
                      padding: '8px 18px', borderRadius: '8px', border: 'none',
                      background: searchChecked.length > 0 && !addingItems ? '#008060' : '#f6f6f7',
                      color: searchChecked.length > 0 && !addingItems ? 'white' : '#8c9196',
                      cursor: searchChecked.length > 0 && !addingItems ? 'pointer' : 'not-allowed',
                      fontSize: '14px', fontWeight: '600', whiteSpace: 'nowrap',
                    }}
                  >
                    {addingItems ? 'Adding…' : searchChecked.length > 0 ? `Add (${searchChecked.length})` : 'Add'}
                  </button>
                </div>

                {/* Dropdown results — rendered via portal to escape Card overflow:hidden */}
                {searchDropOpen && searchResults.length > 0 && ReactDOM.createPortal(
                  <div
                    ref={searchDropRef}
                    style={{
                      position: 'fixed',
                      top: dropdownPos.top,
                      left: dropdownPos.left,
                      width: dropdownPos.width,
                      background: 'white',
                      border: '1px solid #c9cccf', borderRadius: '8px',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
                      maxHeight: '420px', overflowY: 'auto', zIndex: 99999,
                    }}
                  >
                    {searchResults.map(r => {
                      const checked = searchChecked.includes(r.variantId);
                      const alreadyAdded = !!itemsRef.current.find(i => i.sku === r.barcode);
                      return (
                        <div
                          key={r.variantId}
                          onClick={() => toggleSearchCheck(r.variantId)}
                          style={{
                            padding: '10px 12px', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '8px',
                            background: checked ? '#f1f8f5' : 'white',
                            borderBottom: '1px solid #f1f3f5',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {}}
                            style={{ cursor: 'pointer', flexShrink: 0 }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '14px', fontWeight: '500', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {r.name}
                            </div>
                            <div style={{ fontSize: '12px', color: '#6d7175' }}>{r.barcode}</div>
                          </div>
                          {alreadyAdded && (
                            <span style={{ color: '#008060', fontSize: '12px', fontWeight: '600', flexShrink: 0 }}>✓ Added</span>
                          )}
                        </div>
                      );
                    })}
                  </div>,
                  document.body
                )}
              </div>

              {addError && (
                <div style={{ background: '#fff4f4', borderRadius: '8px', padding: '8px 12px', fontSize: '13px', color: '#d72c0d' }}>
                  {addError}
                </div>
              )}
              {scanError && <Banner tone="critical" onDismiss={() => setScanError('')}>{scanError}</Banner>}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="300" align="end">
            <Button
              disabled={selectedIds.length === 0}
              onClick={openPrintModal}
            >
              {selectedIds.length > 0 ? `Print selected (${selectedIds.length})` : 'Print selected'}
            </Button>
            <Button
              variant="primary"
              disabled={items.length === 0}
              onClick={openPrintAllModal}
            >
              Print all
            </Button>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {items.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#666' }}>
                No items yet. Scan a product to add it.
              </div>
            ) : (
              <DataTable
                columnContentTypes={['text', 'text', 'text', 'text', 'text']}
                headings={[
                  <Checkbox label="" labelHidden checked={allSelected} onChange={toggleAll} />,
                  'SKU', 'Name', 'Qty to print', '',
                ]}
                rows={items.map(item => [
                  <Checkbox label="" labelHidden checked={selectedIds.includes(item.id)} onChange={() => toggleSelect(item.id)} />,
                  <BlockStack gap="050">
                    <Text variant="bodyMd" fontWeight="semibold">{item.sku}</Text>
                    <Text variant="bodySm" tone="subdued">
                      {item.variant_title !== 'Default Title' ? item.variant_title : ''}
                    </Text>
                  </BlockStack>,
                  item.custom_name || item.product_title || '—',
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => handleQtyChange(item.id, item.qty_to_print - 1)}
                      disabled={item.qty_to_print <= 1}
                      style={{ width: 28, height: 28, borderRadius: 4, border: '1px solid #c9cccf',
                        background: '#fff', cursor: item.qty_to_print <= 1 ? 'not-allowed' : 'pointer',
                        fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                    <input type="number" min="1" value={item.qty_to_print}
                      onChange={e => handleQtyChange(item.id, e.target.value)}
                      style={{ width: 48, textAlign: 'center', padding: '4px',
                        border: '1px solid #c9cccf', borderRadius: 4, fontSize: 14 }} />
                    <button onClick={() => handleQtyChange(item.id, item.qty_to_print + 1)}
                      style={{ width: 28, height: 28, borderRadius: 4, border: '1px solid #c9cccf',
                        background: '#fff', cursor: 'pointer', fontSize: 16,
                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                  </div>,
                  <Button variant="plain" tone="critical" onClick={() => setDeleteItemId(item.id)}>Remove</Button>,
                ])}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>

      {/* Print modal */}
      <Modal open={showPrint} onClose={() => setShowPrint(false)}
        title={`Print ${selectedIds.length} item${selectedIds.length !== 1 ? 's' : ''}`}
        primaryAction={{ content: 'Print', onAction: handlePrint, loading: printing, disabled: !selectedTemplate || templatesLoading }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setShowPrint(false) }]}>
        <Modal.Section>
          <BlockStack gap="400">
            {printError && <Banner tone="critical" onDismiss={() => setPrintError('')}>{printError}</Banner>}
            {templatesLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
            ) : templates.length === 0 ? (
              <Banner tone="warning">No templates found. Create a template in the Buyer area first.</Banner>
            ) : (
              <Select label="Template" options={templateOptions} value={selectedTemplate} onChange={setSelectedTemplate} />
            )}
            <TextField label="Copies per item" type="number" min="1" max="999"
              value={printQty} onChange={setPrintQty}
              helpText="Each item's qty × copies = total labels printed" />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Delete item confirm */}
      <Modal open={!!deleteItemId} onClose={() => setDeleteItemId(null)} title="Remove item"
        primaryAction={{ content: 'Remove', destructive: true, onAction: handleDeleteItem, loading: deleteLoading }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setDeleteItemId(null) }]}>
        <Modal.Section>
          <Text>Remove this item from the print task?</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default ManagerLabelPrintTaskDetail;