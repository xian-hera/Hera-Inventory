import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, Modal, Select, TextField
} from '@shopify/polaris';
import { useParams, useNavigate } from 'react-router-dom';

function ManagerPriceChangeDetail() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const location = localStorage.getItem('managerLocation') || '';

  const [task, setTask]     = useState(null);
  const [items, setItems]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');

  const [showPrint, setShowPrint]           = useState(false);
  const [templates, setTemplates]           = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [printQty, setPrintQty]             = useState('1');
  const [printing, setPrinting]             = useState(false);
  const [printError, setPrintError]         = useState('');
  const [printSuccess, setPrintSuccess]     = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [taskRes, itemsRes] = await Promise.all([
        fetch(`/api/price-change-tasks/${taskId}/items`),
        fetch(`/api/price-change-tasks/manager?location=${encodeURIComponent(location)}`),
      ]);
      const itemsData = await taskRes.json();
      const tasksData = await itemsRes.json();
      const taskData = tasksData.find(t => String(t.id) === String(taskId));
      if (!taskData) throw new Error('Task not found');
      setTask(taskData);
      setItems(itemsData);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [taskId, location]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openPrintModal = async () => {
    setShowPrint(true);
    setPrintError('');
    setPrintSuccess(false);
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

      // Always fetch live Shopify data for every item using SKU.
      // This ensures vendor, product metafields, and all fields are
      // current regardless of what was stored in the task.
      const metafieldMap = {}; // sku -> { variant: {..., metafields:[]}, product: {..., metafields:[]} }
      await Promise.all(items.map(async (item) => {
        if (!item.sku) return;
        try {
          const res = await fetch(`/api/shopify/variant-by-sku?sku=${encodeURIComponent(item.sku)}`);
          if (!res.ok) return;
          const data = await res.json();
          metafieldMap[item.sku] = data;
        } catch { /* skip, will fall back to stored values */ }
      }));

      const printContent = buildPrintHtml(tmpl, items, qty, metafieldMap);
      const win = window.open('', '_blank');
      if (!win) throw new Error('Pop-up blocked. Please allow pop-ups.');
      win.document.write(printContent);
      win.document.close();
      win.focus();
      setTimeout(async () => {
        win.print();
        // Record printed_at only — does NOT change status or remove from list
        await fetch(`/api/price-change-tasks/${taskId}/print`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location }),
        });
        // Stay on this page; just close modal and show success banner
        setShowPrint(false);
        setPrintSuccess(true);
      }, 800);
    } catch (e) {
      setPrintError(e.message);
      setPrinting(false);
    }
  };

  function buildPrintHtml(tmpl, allItems, qty, metafieldMap = {}) {
    const MM_TO_PX = 3.7795275591;
    const SEPARATOR = ' · ';
    const pw = tmpl.paper_width_mm;
    const ph = tmpl.paper_height_mm;
    const barcodeInits = [];

    const labelHtml = (item, labelIndex) => {
      // Prefer live Shopify data; fall back to whatever is stored in the task item.
      const live = metafieldMap[item.sku];
      const fields = {
        'product.title':            live?.product?.title            || item.name              || '',
        'variant.title':            live?.variant?.title            || '',
        'variant.sku':              live?.variant?.sku              || item.sku               || '',
        'variant.price':            live?.variant?.price            ? `$${live.variant.price}`            : (item.price            ? `$${item.price}`            : ''),
        'variant.compare_at_price': live?.variant?.compare_at_price ? `$${live.variant.compare_at_price}` : (item.compare_at_price ? `$${item.compare_at_price}` : ''),
        'variant.barcode':          live?.variant?.barcode          || item.barcode           || '',
        'product.vendor':           live?.product?.vendor           || '',
        'product.product_type':     live?.product?.product_type     || '',
        'variant.metafield':        item.name                       || '',
        'product.metafield':        '',
      };

      const elementsHtml = (tmpl.elements || []).map((el, elIndex) => {
        const left = el.x * MM_TO_PX, top = el.y * MM_TO_PX;
        const width = el.w * MM_TO_PX, height = el.h * MM_TO_PX;
        const angle = el.angle || 0;
        const rotateStyle = angle ? `transform:rotate(${angle}deg);transform-origin:50% 50%;` : '';
        const baseStyle = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;overflow:hidden;box-sizing:border-box;${rotateStyle}`;

        if (el.type === 'text') {
          // 支持新格式 field_entries（多字段拼接）和旧格式 field_key（向后兼容）
          const entries = el.field_entries && el.field_entries.length > 0
            ? el.field_entries
            : [{ fieldKey: el.field_key, customValue: el.custom_value || '' }];

          const value = entries.map(fe => {
            if (fe.fieldKey === 'custom') return fe.customValue || '';
            if (fe.fieldKey === 'variant.metafield') {
              const ns = fe.metafieldNamespace || fe.metafield_namespace || '';
              const key = fe.metafieldKey || fe.metafield_key || '';
              if (!ns || !key) return item.name || '';
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
          return `<div style="${baseStyle}font-size:${fs}px;font-weight:${fw};text-align:${align};font-family:sans-serif;text-decoration:${decoration};line-height:1.2;">${displayValue}</div>`;
        }

        if (el.type === 'barcode') {
          const barcodeValue = fields[el.field_key] || item.barcode || item.sku || '';
          if (!barcodeValue) return `<div style="${baseStyle}"></div>`;
          const svgId = `bc_${labelIndex}_${elIndex}`;
          barcodeInits.push({ id: svgId, value: barcodeValue, type: el.barcode_type || 'CODE128' });
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
          return `<div style="${baseStyle}border:${sw}mm solid #000;border-radius:${el.border_radius || 0}px;"></div>`;
        }

        if (el.type === 'svg' && el.svg_data) return `<div style="${baseStyle}">${el.svg_data}</div>`;
        return '';
      }).join('');

      return `<div style="position:relative;width:${pw}mm;height:${ph}mm;overflow:hidden;page-break-after:always;box-sizing:border-box;">${elementsHtml}</div>`;
    };

    let labelIndex = 0;
    const allLabels = allItems.flatMap(item =>
      Array.from({ length: qty }, () => labelHtml(item, labelIndex++))
    ).join('');

    const barcodeScript = barcodeInits.length > 0 ? `
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<script>
window.addEventListener('load', function() {
  ${JSON.stringify(barcodeInits)}.forEach(function(bc) {
    var el = document.getElementById(bc.id);
    if (!el) return;
    try {
      JsBarcode(el, bc.value, { format: bc.type, displayValue: false, margin: 2, width: 2,
        height: Math.max(20, el.parentElement.clientHeight * 0.8) });
      el.setAttribute('width','100%'); el.setAttribute('height','100%');
    } catch(e) {}
  });
});
<\/script>` : '';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Print</title>
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
    <Page title="Price Change" backAction={{ onAction: () => navigate('/manager/label-print') }}>
      <Spinner />
    </Page>
  );

  if (error || !task) return (
    <Page title="Price Change" backAction={{ onAction: () => navigate('/manager/label-print') }}>
      <Banner tone="critical">{error || 'Task not found'}</Banner>
    </Page>
  );

  const pageTitle = `Price Change ${task.task_no}${task.label_type ? ` · ${task.label_type}` : ''}`;

  const templateOptions = templates.map(t => ({
    label: `${t.name} (${t.paper_width_mm}×${t.paper_height_mm}mm)`,
    value: String(t.id),
  }));

  return (
    <Page
      title={pageTitle}
      backAction={{ onAction: () => navigate('/manager/label-print') }}
      primaryAction={{ content: 'Print', onAction: openPrintModal }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* Print success banner — stays until user navigates away */}
            {printSuccess && (
              <Banner tone="success" onDismiss={() => setPrintSuccess(false)}>
                Labels printed successfully.
              </Banner>
            )}

            {task.note && (
              <Card>
                <Text variant="bodySm" tone="subdued">{task.note}</Text>
              </Card>
            )}

            <Card>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                      <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6d7175', fontWeight: '500' }}>SKU</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6d7175', fontWeight: '500' }}>Name</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6d7175', fontWeight: '500' }}>Price</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', color: '#6d7175', fontWeight: '500' }}>Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f1f3f5' }}>
                        <td style={{ padding: '10px 12px', fontWeight: '500' }}>{item.sku}</td>
                        <td style={{ padding: '10px 12px', color: '#202223' }}>{item.name || '-'}</td>
                        <td style={{ padding: '10px 12px', color: '#008060', fontWeight: '600' }}>
                          {item.price ? `$${item.price}` : '-'}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>1</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={showPrint}
        onClose={() => { setShowPrint(false); setPrinting(false); }}
        title={`Print all ${items.length} items`}
        primaryAction={{
          content: 'Print', onAction: handlePrint, loading: printing,
          disabled: !selectedTemplate || templatesLoading,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => { setShowPrint(false); setPrinting(false); } }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {printError && <Banner tone="critical" onDismiss={() => setPrintError('')}>{printError}</Banner>}
            {templatesLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
            ) : templates.length === 0 ? (
              <Banner tone="warning">No templates found.</Banner>
            ) : (
              <Select label="Template" options={templateOptions} value={selectedTemplate} onChange={setSelectedTemplate} />
            )}
            <TextField
              label="Copies per item" type="number" min="1" max="999"
              value={printQty} onChange={setPrintQty}
              helpText="Each item will be printed this many times"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default ManagerPriceChangeDetail;