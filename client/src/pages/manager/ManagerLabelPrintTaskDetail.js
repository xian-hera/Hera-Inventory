import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, TextField, Modal, Select, Checkbox,
  DataTable, Badge,
} from '@shopify/polaris';
import { useParams, useNavigate } from 'react-router-dom';

const CUSTOM_NAME_NAMESPACE = 'custom';
const CUSTOM_NAME_KEY = 'name';

function ManagerLabelPrintTaskDetail() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const scanInputRef = useRef(null);

  const [task, setTask] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [scanValue, setScanValue] = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState('');

  const [selectedIds, setSelectedIds] = useState([]);

  const [showPrint, setShowPrint] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [printQty, setPrintQty] = useState('1');
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState('');

  const [deleteItemId, setDeleteItemId] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

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
    if (!loading) setTimeout(() => scanInputRef.current?.focus(), 100);
  }, [loading]);

  // ── Scan / add SKU ─────────────────────────────────────────────────────
  const handleScan = async () => {
    const sku = scanValue.trim();
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

      const existing = items.find(i => i.sku === variant.sku);
      if (existing) {
        await handleQtyChange(existing.id, existing.qty_to_print + 1);
        setScanValue('');
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
      setScanValue('');
    } catch (e) {
      setScanError(e.message);
    } finally {
      setScanLoading(false);
      setTimeout(() => scanInputRef.current?.focus(), 50);
    }
  };

  // ── Update qty ─────────────────────────────────────────────────────────
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

  // ── Delete item ────────────────────────────────────────────────────────
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

  // ── Selection ──────────────────────────────────────────────────────────
  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const allSelected = items.length > 0 && selectedIds.length === items.length;
  const toggleAll = () => setSelectedIds(allSelected ? [] : items.map(i => i.id));

  // ── Open print modal ───────────────────────────────────────────────────
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

  // ── Print ──────────────────────────────────────────────────────────────
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
      setTimeout(() => { win.print(); }, 500);
      setShowPrint(false);
    } catch (e) {
      setPrintError(e.message);
    } finally {
      setPrinting(false);
    }
  };

  // ── Build print HTML ───────────────────────────────────────────────────
  function buildPrintHtml(tmpl, selectedItems, qty) {
    const MM_TO_PX = 3.7795275591;
    const pw = tmpl.paper_width_mm;
    const ph = tmpl.paper_height_mm;

    const labelHtml = (item) => {
      // Full field map — all supported field_key values
      const fields = {
        'product.title':            item.product_title || '',
        'variant.title':            item.variant_title || '',
        'variant.sku':              item.sku || '',
        'variant.price':            item.price ? `$${item.price}` : '',
        'variant.compare_at_price': item.compare_at_price ? `$${item.compare_at_price}` : '',
        'variant.barcode':          item.barcode || '',
        'product.vendor':           item.vendor || '',
        'product.product_type':     item.product_type || '',
        // custom.name metafield
        'variant.metafield':        item.custom_name || '',
        'product.metafield':        '',
      };

      const elementsHtml = (tmpl.elements || []).map(el => {
        const left = el.x * MM_TO_PX;
        const top = el.y * MM_TO_PX;
        const width = el.w * MM_TO_PX;
        const height = el.h * MM_TO_PX;
        const baseStyle = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;overflow:hidden;box-sizing:border-box;`;

        if (el.type === 'text') {
          let value = '';
          if (el.field_key === 'custom') {
            value = el.custom_value || '';
          } else {
            value = fields[el.field_key] ?? '';
          }
          const displayValue = applyCase(value, el.convert_case);
          const fw = el.font_weight || '400';
          const fs = (el.font_size || 3) * MM_TO_PX;
          const align = el.align || 'left';
          const decoration = el.underline ? 'underline' : el.linethrough ? 'line-through' : 'none';
          return `<div style="${baseStyle}font-size:${fs}px;font-weight:${fw};text-align:${align};font-family:sans-serif;text-decoration:${decoration};line-height:1.2;">${displayValue}</div>`;
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

    const allLabels = selectedItems.flatMap(item =>
      Array.from({ length: item.qty_to_print * qty }, () => labelHtml(item))
    ).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Print labels</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: ${pw}mm ${ph}mm; margin: 0; }
  body { background: #fff; }
</style>
</head>
<body>${allLabels}</body>
</html>`;
  }

  function applyCase(str, mode) {
    if (!str) return '';
    if (mode === 'upper') return str.toUpperCase();
    if (mode === 'lower') return str.toLowerCase();
    if (mode === 'title') return str.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
    return str;
  }

  // ─────────────────────────────────────────────────────────────────────────
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
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

          <Card>
            <BlockStack gap="200">
              <Text variant="headingSm">Scan or enter SKU</Text>
              <InlineStack gap="200" blockAlign="center">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="" labelHidden
                    value={scanValue}
                    onChange={val => { setScanValue(val); setScanError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') handleScan(); }}
                    placeholder="Scan barcode or type SKU..."
                    autoComplete="off"
                    ref={scanInputRef}
                  />
                </div>
                <Button onClick={handleScan} loading={scanLoading} disabled={!scanValue.trim()}>
                  Add
                </Button>
              </InlineStack>
              {scanError && <Banner tone="critical" onDismiss={() => setScanError('')}>{scanError}</Banner>}
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
                  'SKU',
                  'Name',
                  'Qty to print',
                  '',
                ]}
                rows={items.map(item => [
                  <Checkbox
                    label="" labelHidden
                    checked={selectedIds.includes(item.id)}
                    onChange={() => toggleSelect(item.id)}
                  />,
                  <BlockStack gap="050">
                    <Text variant="bodyMd" fontWeight="semibold">{item.sku}</Text>
                    <Text variant="bodySm" tone="subdued">
                      {item.variant_title !== 'Default Title' ? item.variant_title : ''}
                    </Text>
                  </BlockStack>,
                  item.custom_name || item.product_title || '—',
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => handleQtyChange(item.id, item.qty_to_print - 1)}
                      disabled={item.qty_to_print <= 1}
                      style={{ width: 28, height: 28, borderRadius: 4, border: '1px solid #c9cccf', background: '#fff', cursor: item.qty_to_print <= 1 ? 'not-allowed' : 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >−</button>
                    <input
                      type="number"
                      min="1"
                      value={item.qty_to_print}
                      onChange={e => handleQtyChange(item.id, e.target.value)}
                      style={{ width: 48, textAlign: 'center', padding: '4px', border: '1px solid #c9cccf', borderRadius: 4, fontSize: 14 }}
                    />
                    <button
                      onClick={() => handleQtyChange(item.id, item.qty_to_print + 1)}
                      style={{ width: 28, height: 28, borderRadius: 4, border: '1px solid #c9cccf', background: '#fff', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >+</button>
                  </div>,
                  <Button variant="plain" tone="critical" onClick={() => setDeleteItemId(item.id)}>
                    Remove
                  </Button>,
                ])}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>

      {/* Print modal */}
      <Modal
        open={showPrint}
        onClose={() => setShowPrint(false)}
        title={`Print ${selectedIds.length} item${selectedIds.length > 1 ? 's' : ''}`}
        primaryAction={{
          content: 'Print',
          onAction: handlePrint,
          loading: printing,
          disabled: !selectedTemplate || templatesLoading,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setShowPrint(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {printError && <Banner tone="critical" onDismiss={() => setPrintError('')}>{printError}</Banner>}
            {templatesLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
            ) : templates.length === 0 ? (
              <Banner tone="warning">No templates found. Create a template in the Buyer area first.</Banner>
            ) : (
              <Select
                label="Template"
                options={templateOptions}
                value={selectedTemplate}
                onChange={setSelectedTemplate}
              />
            )}
            <TextField
              label="Copies per item"
              type="number"
              min="1"
              max="999"
              value={printQty}
              onChange={setPrintQty}
              helpText="Each item's qty × copies = total labels printed"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Delete item confirm */}
      <Modal
        open={!!deleteItemId}
        onClose={() => setDeleteItemId(null)}
        title="Remove item"
        primaryAction={{ content: 'Remove', destructive: true, onAction: handleDeleteItem, loading: deleteLoading }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setDeleteItemId(null) }]}
      >
        <Modal.Section>
          <Text>Remove this item from the print task?</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default ManagerLabelPrintTaskDetail;