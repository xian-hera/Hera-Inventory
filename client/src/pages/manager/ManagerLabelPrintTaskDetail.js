import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, TextField, Modal, Select, Checkbox,
  DataTable,
} from '@shopify/polaris';
import { useParams, useNavigate } from 'react-router-dom';
import CameraScanner from '../../components/CameraScanner';

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

  // 手动输入 SKU 弹窗
  const [showTypeIn, setShowTypeIn] = useState(false);
  const [typeInValue, setTypeInValue] = useState('');
  const [typeInError, setTypeInError] = useState('');

  // 摄像头
  const [showCamera, setShowCamera] = useState(false);

  const [showPrint, setShowPrint]           = useState(false);
  const [templates, setTemplates]           = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [printQty, setPrintQty]             = useState('1');
  const [printing, setPrinting]             = useState(false);
  const [printError, setPrintError]         = useState('');
  const [deleteItemId, setDeleteItemId]     = useState(null);
  const [deleteLoading, setDeleteLoading]   = useState(false);

  const barcodeBuffer = useRef('');
  const barcodeTimer  = useRef(null);
  const itemsRef      = useRef(items);
  const showTypeInRef = useRef(false);
  const showCameraRef = useRef(false);

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { showTypeInRef.current = showTypeIn; }, [showTypeIn]);
  useEffect(() => { showCameraRef.current = showCamera; }, [showCamera]);

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

  // 全局扫码枪监听 — 与其他 manager 页面逻辑一致
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (showTypeInRef.current) return; // 手动输入弹窗打开时不响应
      if (showCameraRef.current) return; // 摄像头打开时不响应
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

  // 核心：通过 SKU/barcode 添加条目
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

  // 手动输入 SKU 提交
  const handleTypeInSubmit = async () => {
    const sku = typeInValue.trim();
    if (!sku) return;
    setTypeInError('');
    try {
      await addBySku(sku);
      setTypeInValue('');
      setShowTypeIn(false);
    } catch (e) {
      setTypeInError(e.message);
    }
  };

  // 摄像头扫描回调 — 直接添加，窗口保持开启
  const handleCameraScan = (barcode) => {
    addBySku(barcode);
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

  const openPrintModal = async () => {
    if (selectedIds.length === 0) return;
    setShowPrint(true);
    setPrintError('');
    setPrintQty('1');
    setSelectedTemplate('');
    setTemplatesLoading(true);
    try {
      const res = await fetch('/api/label-templates');
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
      const printContent = buildPrintHtml(tmpl, selectedItems, qty);
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

  function buildPrintHtml(tmpl, selectedItems, qty) {
    const MM_TO_PX = 3.7795275591;
    const pw = tmpl.paper_width_mm;
    const ph = tmpl.paper_height_mm;
    const barcodeInits = [];

    const labelHtml = (item, labelIndex) => {
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
        const left = el.x * MM_TO_PX, top = el.y * MM_TO_PX;
        const width = el.w * MM_TO_PX, height = el.h * MM_TO_PX;
        const baseStyle = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;overflow:hidden;box-sizing:border-box;`;

        if (el.type === 'text') {
          const value = el.field_key === 'custom' ? (el.custom_value || '') : (fields[el.field_key] ?? '');
          const displayValue = applyCase(value, el.convert_case);
          const fw = el.font_weight || '400';
          const fs = (el.font_size || 3) * MM_TO_PX;
          const align = el.align || 'left';
          const decoration = el.underline ? 'underline' : el.linethrough ? 'line-through' : 'none';
          return `<div style="${baseStyle}font-size:${fs}px;font-weight:${fw};text-align:${align};font-family:sans-serif;text-decoration:${decoration};line-height:1.2;">${displayValue}</div>`;
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
          return `<div style="${baseStyle}"><div style="position:absolute;${isH ? `top:50%;left:0;width:100%;border-top:${sw}mm solid #000;` : `left:50%;top:0;height:100%;border-left:${sw}mm solid #000;`}"></div></div>`;
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

      return `<div style="position:relative;width:${pw}mm;height:${ph}mm;overflow:hidden;page-break-after:always;box-sizing:border-box;">${elementsHtml}</div>`;
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
      primaryAction={selectedIds.length > 0 ? {
        content: `Print selected (${selectedIds.length})`,
        onAction: openPrintModal,
      } : null}
    >
      <Layout>
        <Layout.Section>
          {scanError && <Banner tone="critical" onDismiss={() => setScanError('')}>{scanError}</Banner>}

          <Card>
            <BlockStack gap="200">
              <Text variant="headingSm">Scan or enter SKU</Text>
              <InlineStack gap="200" blockAlign="center">
                {/* 手动输入按钮 */}
                <Button onClick={() => { setTypeInValue(''); setTypeInError(''); setShowTypeIn(true); }}>
                  Type in SKU
                </Button>
                {/* 摄像头按钮 */}
                <button
                  onClick={() => setShowCamera(v => !v)}
                  style={{
                    padding: '8px 12px', borderRadius: '8px',
                    border: `1px solid ${showCamera ? '#008060' : '#c9cccf'}`,
                    background: showCamera ? '#f1f8f5' : 'white',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <img src="/camera.svg" alt="camera" style={{ width: '20px', height: '20px' }} />
                </button>
                {scanLoading && <Spinner size="small" />}
              </InlineStack>

            </BlockStack>
          </Card>
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

      {/* 摄像头扫描窗口 */}
      {showCamera && (
        <CameraScanner
          onScan={handleCameraScan}
          onClose={() => setShowCamera(false)}
        />
      )}

      {/* 手动输入 SKU 弹窗 */}
      {showTypeIn && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 3000 }}>
          <div style={{ position: 'fixed', top: '50%', left: '16px', right: '16px',
            transform: 'translateY(-50%)', background: 'white', borderRadius: '12px',
            padding: '24px', maxWidth: '400px', margin: '0 auto', zIndex: 3001 }}>
            <button onClick={() => setShowTypeIn(false)} style={{ position: 'absolute',
              top: '12px', right: '12px', background: 'none', border: 'none',
              fontSize: '20px', cursor: 'pointer' }}>✕</button>
            <BlockStack gap="300">
              <Text variant="headingMd" fontWeight="bold">Type in SKU</Text>
              {typeInError && (
                <div style={{ background: '#fff4f4', borderRadius: '8px', padding: '10px 14px',
                  fontSize: '14px', color: '#d72c0d' }}>{typeInError}</div>
              )}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '14px', color: '#202223', fontWeight: '500', marginBottom: '4px' }}>SKU</div>
                  <input
                    type="text"
                    value={typeInValue}
                    onChange={e => { setTypeInValue(e.target.value); setTypeInError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') handleTypeInSubmit(); }}
                    autoComplete="off" autoFocus
                    placeholder="Enter exact SKU"
                    style={{ width: '100%', padding: '10px 12px', fontSize: '16px',
                      border: '1px solid #c9cccf', borderRadius: '8px',
                      outline: 'none', boxSizing: 'border-box', display: 'block' }}
                    onFocus={e => { e.target.style.borderColor = '#005bd3'; }}
                    onBlur={e => { e.target.style.borderColor = '#c9cccf'; }}
                  />
                </div>
                <button
                  onClick={handleTypeInSubmit}
                  disabled={!typeInValue.trim()}
                  style={{ padding: '10px 18px', borderRadius: '8px', border: 'none',
                    background: typeInValue.trim() ? '#008060' : '#f6f6f7',
                    color: typeInValue.trim() ? 'white' : '#8c9196',
                    cursor: typeInValue.trim() ? 'pointer' : 'not-allowed',
                    fontSize: '14px', fontWeight: '600', whiteSpace: 'nowrap' }}>
                  Search
                </button>
              </div>
            </BlockStack>
          </div>
        </div>
      )}

      {/* Print modal */}
      <Modal open={showPrint} onClose={() => setShowPrint(false)}
        title={`Print ${selectedIds.length} item${selectedIds.length > 1 ? 's' : ''}`}
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