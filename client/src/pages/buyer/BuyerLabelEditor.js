import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Spinner, Banner, Modal, TextField, Button, Text, Select, BlockStack } from '@shopify/polaris';
import { fabric } from 'fabric';
import JsBarcode from 'jsbarcode';

// ─── Font ────────────────────────────────────────────────────────────────────
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

// ─── Field options ────────────────────────────────────────────────────────────
const FIELD_OPTIONS = [
  { label: 'Custom text', value: 'custom' },
  { label: 'Product title', value: 'product.title' },
  { label: 'Variant title', value: 'variant.title' },
  { label: 'SKU', value: 'variant.sku' },
  { label: 'Price', value: 'variant.price' },
  { label: 'Compare at price', value: 'variant.compare_at_price' },
  { label: 'Barcode', value: 'variant.barcode' },
  { label: 'Vendor', value: 'product.vendor' },
  { label: 'Product type', value: 'product.product_type' },
  { label: 'Product metafield', value: 'product.metafield' },
  { label: 'Variant metafield', value: 'variant.metafield' },
];

const BARCODE_FIELD_OPTIONS = FIELD_OPTIONS.filter(f =>
  !['product.metafield', 'variant.metafield', 'custom'].includes(f.value)
);

const BARCODE_TYPES = [
  { label: 'CODE128 (most used)', value: 'CODE128' },
  { label: 'EAN13', value: 'EAN13' },
  { label: 'UPCA', value: 'UPC' },
  { label: 'UPCE', value: 'UPCE' },
  { label: 'CODE39', value: 'CODE39' },
  { label: 'ISBN', value: 'EAN13' },
  { label: 'EAN8', value: 'EAN8' },
  { label: 'GS1-128', value: 'GS1128' },
];

const LINE_THICKNESS = { thin: 1, medium: 2.5, thick: 5 };
const STROKE_LABEL = [
  { label: 'Thin', value: 'thin' },
  { label: 'Medium', value: 'medium' },
  { label: 'Thick', value: 'thick' },
];

// ─── MM ↔ PX conversion (96 dpi base, but we scale canvas to fit screen) ────
const MM_TO_PX = 3.7795275591; // 1mm = this many px at 96dpi

function mmToPx(mm) { return mm * MM_TO_PX; }
function pxToMm(px) { return px / MM_TO_PX; }

// ─── Build a placeholder barcode SVG data URL ─────────────────────────────
function makeBarcodeDataUrl(type = 'CODE128', value = '0123456789') {
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svg, value, {
      format: type,
      displayValue: false,
      margin: 2,
      width: 2,
      height: 60,
    });
    const serialized = new XMLSerializer().serializeToString(svg);
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(serialized)));
  } catch {
    return null;
  }
}

// ─── Main component ───────────────────────────────────────────────────────────
function BuyerLabelEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const canvasRef = useRef(null);
  const fabricRef = useRef(null);
  const paperOffsetRef = useRef({ left: 100, top: 100 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [template, setTemplate] = useState(null);
  const [selected, setSelected] = useState(null);   // currently selected fabric object
  const [, forceUpdate] = useState(0);              // trigger re-render when selection props change
  const [saveModal, setSaveModal] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [zoom, setZoom] = useState(1);
  const [previewModal, setPreviewModal] = useState(false);
  const [previewSku, setPreviewSku] = useState('');
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  // ── Load template ────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`/api/label-templates/${id}`)
      .then(r => r.json())
      .then(data => {
        setTemplate(data);
        setTemplateName(data.name);
        setLoading(false);
      })
      .catch(() => { setError('Failed to load template.'); setLoading(false); });
  }, [id]);

  // ── Init fabric canvas ────────────────────────────────────────────────────
  useEffect(() => {
    if (!template || !canvasRef.current) return;

    const paperW = mmToPx(template.paper_width_mm);
    const paperH = mmToPx(template.paper_height_mm);

    // Canvas fills the container div — get its actual size
    const container = canvasRef.current.parentElement;
    const canvasW = Math.max(container.clientWidth || 0, window.innerWidth - 220);
    const canvasH = Math.max(container.clientHeight || 0, window.innerHeight - 52);

    // Paper centered in canvas
    const paperLeft = Math.max(80, (canvasW - paperW) / 2);
    const paperTop = Math.max(80, (canvasH - paperH) / 2);
    paperOffsetRef.current = { left: paperLeft, top: paperTop };

    const canvas = new fabric.Canvas(canvasRef.current, {
      width: canvasW,
      height: canvasH,
      backgroundColor: '#e5e5e5',
      selection: true,
    });
    fabricRef.current = canvas;

    // Draw paper area (white rect, not selectable)
    const paper = new fabric.Rect({
      left: paperLeft, top: paperTop,
      width: paperW, height: paperH,
      fill: '#ffffff',
      shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.18)', blur: 12, offsetX: 0, offsetY: 2 }),
      selectable: false, evented: false, hoverCursor: 'default',
      name: '__paper__',
    });
    canvas.add(paper);
    canvas.sendToBack(paper);

    // Load existing elements
    if (template.elements && template.elements.length > 0) {
      template.elements.forEach(el => restoreElement(canvas, el, paperLeft, paperTop));
    }
    // Selection listeners
    canvas.on('selection:created', (e) => { setSelected(e.selected[0] || null); });
    canvas.on('selection:updated', (e) => { setSelected(e.selected[0] || null); });
    canvas.on('selection:cleared', () => setSelected(null));
    canvas.on('object:modified', () => forceUpdate(n => n + 1));

    return () => canvas.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  // ── Restore element from saved JSON ──────────────────────────────────────
  function restoreElement(canvas, el, paperLeft, paperTop) {
    const x = paperLeft + mmToPx(el.x);
    const y = paperTop + mmToPx(el.y);
    const w = mmToPx(el.w);
    const h = mmToPx(el.h);
    if (el.type === 'text') {
      addTextObject(canvas, x, y, w, h, el);
    } else if (el.type === 'barcode') {
      addBarcodeObject(canvas, x, y, w, h, el.field_key, el.barcode_type);
    } else if (el.type === 'line') {
      addLineObject(canvas, x, y, w, h, el.orientation, el.stroke_key);
    } else if (el.type === 'frame') {
      addFrameObject(canvas, x, y, w, h, el.stroke_key, el.border_radius);
    } else if (el.type === 'svg' && el.svg_data) {
      addSvgObject(canvas, x, y, w, h, el.svg_data);
    }
  }

  // ── Add element helpers ───────────────────────────────────────────────────
  function addTextObject(canvas, x, y, w, h, props = {}) {
    const obj = new fabric.Textbox(props.custom_value || props.field_key || 'Text', {
      left: x, top: y, width: w || 120,
      fontSize: props.font_size ? mmToPx(props.font_size) : 14,
      fontFamily: FONT_FAMILY,
      fontWeight: props.font_weight || '400',
      textAlign: props.align || 'left',
      underline: props.underline || false,
      linethrough: props.linethrough || false,
      fill: '#000000',
      lockUniScaling: false,
    });
    obj.customType = 'text';
    obj.fieldKey = props.field_key || 'custom';
    obj.customValue = props.custom_value || '';
    obj.metafieldNamespace = props.metafield_namespace || '';
    obj.metafieldKey = props.metafield_key || '';
    obj.shrink = props.shrink || false;
    obj.convertCase = props.convert_case || 'none';
    canvas.add(obj);
    canvas.setActiveObject(obj);
    canvas.renderAll();
    return obj;
  }

  function addBarcodeObject(canvas, x, y, w, h, fieldKey = 'variant.barcode', barcodeType = 'CODE128') {
    const dataUrl = makeBarcodeDataUrl(barcodeType, '0123456789');
    const addImg = (imgEl) => {
      const img = new fabric.Image(imgEl, {
        left: x, top: y,
        scaleX: (w || 160) / imgEl.naturalWidth,
        scaleY: (h || 60) / imgEl.naturalHeight,
        lockUniScaling: false,
      });
      img.customType = 'barcode';
      img.fieldKey = fieldKey;
      img.barcodeType = barcodeType;
      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.renderAll();
    };
    if (dataUrl) {
      const imgEl = new Image();
      imgEl.onload = () => addImg(imgEl);
      imgEl.src = dataUrl;
    } else {
      // Fallback placeholder rect
      const rect = new fabric.Rect({
        left: x, top: y, width: w || 160, height: h || 60,
        fill: '#f0f0f0', stroke: '#999', strokeWidth: 1,
        rx: 0, lockUniScaling: false,
      });
      rect.customType = 'barcode';
      rect.fieldKey = fieldKey;
      rect.barcodeType = barcodeType;
      canvas.add(rect);
      canvas.setActiveObject(rect);
      canvas.renderAll();
    }
  }

  function addLineObject(canvas, x, y, w, h, orientation = 'horizontal', strokeKey = 'thin') {
    const sw = LINE_THICKNESS[strokeKey] || 1;
    const isH = orientation !== 'vertical';
    const line = new fabric.Line(
      isH ? [0, 0, w || 80, 0] : [0, 0, 0, h || 80],
      { left: x, top: y, stroke: '#000', strokeWidth: sw,
        strokeUniform: true,
        lockUniScaling: false, hasBorders: true }
    );
    line.customType = 'line';
    line.orientation = orientation;
    line.strokeKey = strokeKey;
    canvas.add(line);
    canvas.setActiveObject(line);
    canvas.renderAll();
    return line;
  }

  function addFrameObject(canvas, x, y, w, h, strokeKey = 'thin', borderRadius = 0) {
    const sw = LINE_THICKNESS[strokeKey] || 1;
    const rect = new fabric.Rect({
      left: x, top: y, width: w || 80, height: h || 40,
      fill: 'transparent', stroke: '#000', strokeWidth: sw,
      strokeUniform: true,
      rx: borderRadius || 0, ry: borderRadius || 0,
      lockUniScaling: false,
    });
    rect.customType = 'frame';
    rect.strokeKey = strokeKey;
    rect.borderRadius = borderRadius || 0;
    canvas.add(rect);
    canvas.setActiveObject(rect);
    canvas.renderAll();
    return rect;
  }

  function addSvgObject(canvas, x, y, w, h, svgData) {
    fabric.loadSVGFromString(svgData, (objects, options) => {
      const group = fabric.util.groupSVGElements(objects, options);
      group.set({ left: x, top: y,
        scaleX: (w || 80) / (group.width || 80),
        scaleY: (h || 80) / (group.height || 80),
        lockUniScaling: false });
      group.customType = 'svg';
      group.svgData = svgData;
      canvas.add(group);
      canvas.setActiveObject(group);
      canvas.renderAll();
    });
  }

  // ── Toolbar: add element ──────────────────────────────────────────────────
  const addElement = (type) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    // Drop just outside the paper top-left corner
    const { left: pl, top: pt } = paperOffsetRef.current;
    const x = Math.max(10, pl - 100);
    const y = pt;
    if (type === 'text') addTextObject(canvas, x, y, 120, 0);
    else if (type === 'barcode') addBarcodeObject(canvas, x, y, 160, 60);
    else if (type === 'line') addLineObject(canvas, x, y, 80, 0);
    else if (type === 'frame') addFrameObject(canvas, x, y, 80, 40);
    else if (type === 'svg') {
      // Placeholder SVG group
      const placeholder = new fabric.Rect({
        left: x, top: y, width: 80, height: 80,
        fill: '#f5f5f5', stroke: '#aaa', strokeWidth: 1,
        lockUniScaling: false,
      });
      const label = new fabric.Text('SVG', {
        left: x + 28, top: y + 30, fontSize: 14,
        fontFamily: FONT_FAMILY, fill: '#888', selectable: false,
      });
      placeholder.customType = 'svg';
      placeholder.svgData = null;
      canvas.add(placeholder);
      canvas.add(label);
      canvas.setActiveObject(placeholder);
      canvas.renderAll();
    }
  };

  // ── Toolbar: actions on selected ──────────────────────────────────────────
  const rotateSelected = (deg) => {
    const obj = fabricRef.current?.getActiveObject();
    if (!obj) return;
    obj.rotate((obj.angle || 0) + deg);
    fabricRef.current.renderAll();
    forceUpdate(n => n + 1);
  };

  const deleteSelected = () => {
    const canvas = fabricRef.current;
    const obj = canvas?.getActiveObject();
    if (!obj) return;
    canvas.remove(obj);
    canvas.discardActiveObject();
    setSelected(null);
    canvas.renderAll();
  };

  const bringForward = () => {
    const obj = fabricRef.current?.getActiveObject();
    if (!obj) return;
    fabricRef.current.bringForward(obj);
    fabricRef.current.renderAll();
  };

  const sendBackward = () => {
    const obj = fabricRef.current?.getActiveObject();
    if (!obj) return;
    fabricRef.current.sendBackwards(obj);
    fabricRef.current.renderAll();
  };

  // ── Update selected object's property ────────────────────────────────────
  const updateSelected = (props) => {
    const obj = fabricRef.current?.getActiveObject();
    if (!obj) return;
    Object.entries(props).forEach(([k, v]) => { obj[k] = v; });
    // Handle fabric-native text props
    if (props.font_weight !== undefined) obj.set('fontWeight', props.font_weight);
    if (props.align !== undefined) obj.set('textAlign', props.align);
    if (props.underline !== undefined) obj.set('underline', props.underline);
    if (props.linethrough !== undefined) obj.set('linethrough', props.linethrough);
    if (props.font_size_px !== undefined) obj.set('fontSize', props.font_size_px);
    if (props.stroke_width !== undefined) { obj.set('strokeWidth', props.stroke_width); }
    if (props.border_radius !== undefined) { obj.set('rx', props.border_radius); obj.set('ry', props.border_radius); }
    if (props.custom_value !== undefined && obj.customType === 'text') {
      obj.set('text', props.custom_value || obj.fieldKey || 'Text');
    }
    fabricRef.current.renderAll();
    forceUpdate(n => n + 1);
  };

  // ── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const { left: pl, top: pt } = paperOffsetRef.current;
      const elements = fabricRef.current.getObjects()
        .filter(obj => obj.customType)
        .map(obj => {
          const base = {
            type: obj.customType,
            x: pxToMm(obj.left - pl),
            y: pxToMm(obj.top - pt),
            w: pxToMm(obj.getScaledWidth()),
            h: pxToMm(obj.getScaledHeight()),
            angle: obj.angle || 0,
          };
          if (obj.customType === 'text') {
            return { ...base, field_key: obj.fieldKey, custom_value: obj.customValue,
              metafield_namespace: obj.metafieldNamespace, metafield_key: obj.metafieldKey,
              font_weight: obj.fontWeight, font_size: pxToMm(obj.fontSize),
              align: obj.textAlign, underline: obj.underline, linethrough: obj.linethrough,
              shrink: obj.shrink, convert_case: obj.convertCase };
          }
          if (obj.customType === 'barcode') {
            return { ...base, field_key: obj.fieldKey, barcode_type: obj.barcodeType };
          }
          if (obj.customType === 'line') {
            return { ...base, orientation: obj.orientation, stroke_key: obj.strokeKey };
          }
          if (obj.customType === 'frame') {
            return { ...base, stroke_key: obj.strokeKey, border_radius: obj.borderRadius };
          }
          if (obj.customType === 'svg') {
            return { ...base, svg_data: obj.svgData };
          }
          return base;
        });
      const res = await fetch(`/api/label-templates/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: templateName, elements }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveModal(false);
    } catch (e) {
      setError('Failed to save: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── SVG file upload ───────────────────────────────────────────────────────
  const handleSvgUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const svgData = ev.target.result;
      const obj = fabricRef.current?.getActiveObject();
      if (obj && obj.customType === 'svg') {
        const x = obj.left; const y = obj.top;
        const w = obj.getScaledWidth(); const h = obj.getScaledHeight();
        fabricRef.current.remove(obj);
        addSvgObject(fabricRef.current, x, y, w, h, svgData);
      }
    };
    reader.readAsText(file);
  };

  // ── Zoom ─────────────────────────────────────────────────────────────────
  const handleZoom = (delta) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const newZoom = Math.min(3, Math.max(0.2, zoom + delta));
    canvas.setZoom(newZoom);
    canvas.setWidth(canvas.getWidth() * (newZoom / zoom));
    canvas.setHeight(canvas.getHeight() * (newZoom / zoom));
    setZoom(newZoom);
  };

  // ── Preview ───────────────────────────────────────────────────────────────
  const handlePreview = async () => {
    if (!previewSku.trim()) return;
    setPreviewLoading(true);
    setPreviewError('');
    setPreviewData(null);
    try {
      const res = await fetch(`/api/shopify/variant-by-sku?sku=${encodeURIComponent(previewSku.trim())}`);
      if (!res.ok) throw new Error('SKU not found');
      const data = await res.json();
      setPreviewData(data);
    } catch (e) {
      setPreviewError(e.message || 'Failed to fetch product data');
    } finally {
      setPreviewLoading(false);
    }
  };

  const getPreviewValue = (fieldKey, metaNs, metaKey) => {
    if (!previewData) return null;
    const { product, variant } = previewData;
    const map = {
      'product.title': product?.title,
      'variant.title': variant?.title,
      'variant.sku': variant?.sku,
      'variant.price': variant?.price ? `$${variant.price}` : null,
      'variant.compare_at_price': variant?.compare_at_price ? `$${variant.compare_at_price}` : null,
      'variant.barcode': variant?.barcode,
      'product.vendor': product?.vendor,
      'product.product_type': product?.product_type,
    };
    if (fieldKey === 'product.metafield' && metaNs && metaKey) {
      const mf = product?.metafields?.find(m => m.namespace === metaNs && m.key === metaKey);
      return mf?.value || `[metafield: ${metaNs}.${metaKey}]`;
    }
    if (fieldKey === 'variant.metafield' && metaNs && metaKey) {
      const mf = variant?.metafields?.find(m => m.namespace === metaNs && m.key === metaKey);
      return mf?.value || `[metafield: ${metaNs}.${metaKey}]`;
    }
    return map[fieldKey] || fieldKey;
  };

  // ─────────────────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <Spinner />
    </div>
  );
  if (error && !template) return (
    <div style={{ padding: 32 }}><Banner tone="critical">{error}</Banner></div>
  );

  const sel = selected;
  const selType = sel?.customType;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

      {/* ── Top bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 16px', borderBottom: '1px solid #e1e3e5',
        background: '#fff', minHeight: 52,
      }}>
        {/* Back + title */}
        <button onClick={() => navigate('/buyer/label-templates')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#666', marginRight: 8 }}>
          ← Templates
        </button>
        <span style={{ fontWeight: 500, fontSize: 15, marginRight: 'auto' }}>{templateName}</span>

        {/* Context toolbar — only when something is selected */}
        {sel && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>

            {/* Rotate */}
            <ToolBtn title="Rotate left 90°" onClick={() => rotateSelected(-90)}>↺</ToolBtn>
            <ToolBtn title="Rotate right 90°" onClick={() => rotateSelected(90)}>↻</ToolBtn>

            {/* Delete */}
            <ToolBtn title="Delete" onClick={deleteSelected} danger>✕</ToolBtn>

            <div style={{ width: 1, height: 24, background: '#e1e3e5', margin: '0 4px' }} />

            {/* Text formatting — text elements only */}
            {selType === 'text' && <>
              {/* Alignment */}
              {['left','center','right'].map(a => (
                <ToolBtn key={a} title={`Align ${a}`}
                  active={sel.textAlign === a}
                  onClick={() => updateSelected({ align: a })}>
                  {a === 'left' ? '⬡' : a === 'center' ? '☰' : '⬠'}
                </ToolBtn>
              ))}
              <div style={{ width: 1, height: 24, background: '#e1e3e5', margin: '0 4px' }} />
              {/* Bold */}
              <ToolBtn title="Bold" active={sel.fontWeight === '700'} onClick={() =>
                updateSelected({ font_weight: sel.fontWeight === '700' ? '400' : '700' })}>
                <b>B</b>
              </ToolBtn>
              {/* Underline */}
              <ToolBtn title="Underline" active={sel.underline} onClick={() =>
                updateSelected({ underline: !sel.underline })}>
                <u>U</u>
              </ToolBtn>
              {/* Strikethrough */}
              <ToolBtn title="Strikethrough" active={sel.linethrough} onClick={() =>
                updateSelected({ linethrough: !sel.linethrough })}>
                <s>S</s>
              </ToolBtn>
              {/* Font size */}
              <input
                type="number" min="6" max="200" step="1"
                value={Math.round(sel.fontSize) || 14}
                onChange={e => updateSelected({ font_size_px: parseInt(e.target.value) || 14 })}
                style={{ width: 52, padding: '4px 6px', border: '1px solid #c9cccf',
                  borderRadius: 6, fontSize: 13, textAlign: 'center' }}
                title="Font size (px)"
              />
            </>}

            <div style={{ width: 1, height: 24, background: '#e1e3e5', margin: '0 4px' }} />

            {/* Layer order */}
            <ToolBtn title="Bring forward" onClick={bringForward}>⬆</ToolBtn>
            <ToolBtn title="Send backward" onClick={sendBackward}>⬇</ToolBtn>
          </div>
        )}

        {/* Save button */}
        <button
          onClick={() => setPreviewModal(true)}
          style={{ marginLeft: 8, padding: '6px 14px', background: '#fff', color: '#333',
            border: '1px solid #c9cccf', borderRadius: 6, fontWeight: 500, cursor: 'pointer', fontSize: 14 }}>
          Preview
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
          <ToolBtn title="Zoom out" onClick={() => handleZoom(-0.1)}>−</ToolBtn>
          <span style={{ fontSize: 12, color: '#666', minWidth: 36, textAlign: 'center' }}>
            {Math.round(zoom * 100)}%
          </span>
          <ToolBtn title="Zoom in" onClick={() => handleZoom(0.1)}>+</ToolBtn>
        </div>
        <button
          onClick={() => setSaveModal(true)}
          style={{ marginLeft: 8, padding: '6px 18px', background: '#008060', color: '#fff',
            border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
          Save
        </button>
      </div>

      {/* ── Body: left panel + canvas ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left panel */}
        <div style={{
          width: 220, borderRight: '1px solid #e1e3e5', background: '#fafbfc',
          overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {/* No selection: show add tools */}
          {!sel && (
            <>
              <p style={{ fontSize: 12, color: '#666', marginBottom: 4, fontWeight: 500 }}>Add element</p>
              {[
                { type: 'text', label: 'Text' },
                { type: 'barcode', label: 'Barcode' },
                { type: 'line', label: 'Line' },
                { type: 'frame', label: 'Frame' },
                { type: 'svg', label: 'SVG' },
              ].map(({ type, label }) => (
                <button key={type} onClick={() => addElement(type)}
                  style={{ padding: '8px 12px', textAlign: 'left', background: '#fff',
                    border: '1px solid #c9cccf', borderRadius: 6, cursor: 'pointer',
                    fontSize: 13, fontFamily: FONT_FAMILY }}>
                  {label}
                </button>
              ))}
            </>
          )}

          {/* Selection: show properties */}
          {sel && (
            <BlockStack gap="300">
              <p style={{ fontSize: 12, color: '#666', fontWeight: 500, margin: 0 }}>
                {selType ? selType.charAt(0).toUpperCase() + selType.slice(1) : ''} properties
              </p>

              {/* ── TEXT props ── */}
              {selType === 'text' && (
                <>
                  <PanelSelect
                    label="Content"
                    value={sel.fieldKey}
                    options={FIELD_OPTIONS}
                    onChange={val => {
                      sel.fieldKey = val;
                      if (val !== 'custom') {
                        sel.set('text', val.split('.').pop().toUpperCase().replace('_', ' '));
                        sel.customValue = '';
                      }
                      fabricRef.current.renderAll();
                      forceUpdate(n => n + 1);
                    }}
                  />

                  {sel.fieldKey === 'custom' && (
                    <PanelInput
                      label="Text value"
                      value={sel.customValue || ''}
                      onChange={val => updateSelected({ custom_value: val, customValue: val })}
                    />
                  )}

                  {(sel.fieldKey === 'product.metafield' || sel.fieldKey === 'variant.metafield') && (
                    <>
                      <PanelInput label="Namespace"
                        value={sel.metafieldNamespace || ''}
                        onChange={val => { sel.metafieldNamespace = val; forceUpdate(n => n + 1); }}
                      />
                      <PanelInput label="Key"
                        value={sel.metafieldKey || ''}
                        onChange={val => { sel.metafieldKey = val; forceUpdate(n => n + 1); }}
                      />
                    </>
                  )}

                  <PanelSelect
                    label="Weight"
                    value={sel.fontWeight || '400'}
                    options={[
                      { label: 'Thin (400)', value: '400' },
                      { label: 'Regular (500)', value: '500' },
                      { label: 'Bold (700)', value: '700' },
                    ]}
                    onChange={val => updateSelected({ font_weight: val })}
                  />

                  <PanelSelect
                    label="Convert case"
                    value={sel.convertCase || 'none'}
                    options={[
                      { label: 'None', value: 'none' },
                      { label: 'UPPERCASE', value: 'upper' },
                      { label: 'lowercase', value: 'lower' },
                      { label: 'Title Case', value: 'title' },
                    ]}
                    onChange={val => { sel.convertCase = val; forceUpdate(n => n + 1); }}
                  />

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={sel.shrink || false}
                      onChange={e => { sel.shrink = e.target.checked; forceUpdate(n => n + 1); }} />
                    Shrink text automatically
                  </label>
                </>
              )}

              {/* ── BARCODE props ── */}
              {selType === 'barcode' && (
                <>
                  <PanelSelect
                    label="Content"
                    value={sel.fieldKey || 'variant.barcode'}
                    options={BARCODE_FIELD_OPTIONS}
                    onChange={val => { sel.fieldKey = val; forceUpdate(n => n + 1); }}
                  />
                  <PanelSelect
                    label="Barcode type"
                    value={sel.barcodeType || 'CODE128'}
                    options={BARCODE_TYPES}
                    onChange={val => {
                      sel.barcodeType = val;
                      forceUpdate(n => n + 1);
                    }}
                  />
                </>
              )}

              {/* ── LINE props ── */}
              {selType === 'line' && (
                <>
                  <PanelSelect
                    label="Orientation"
                    value={sel.orientation || 'horizontal'}
                    options={[
                      { label: 'Horizontal', value: 'horizontal' },
                      { label: 'Vertical', value: 'vertical' },
                    ]}
                    onChange={val => {
                      sel.orientation = val;
                      forceUpdate(n => n + 1);
                    }}
                  />
                  <PanelSelect
                    label="Thickness"
                    value={sel.strokeKey || 'thin'}
                    options={STROKE_LABEL}
                    onChange={val => {
                      sel.strokeKey = val;
                      updateSelected({ stroke_width: LINE_THICKNESS[val] });
                    }}
                  />
                </>
              )}

              {/* ── FRAME props ── */}
              {selType === 'frame' && (
                <>
                  <PanelSelect
                    label="Thickness"
                    value={sel.strokeKey || 'thin'}
                    options={STROKE_LABEL}
                    onChange={val => {
                      sel.strokeKey = val;
                      updateSelected({ stroke_width: LINE_THICKNESS[val] });
                    }}
                  />
                  <div>
                    <p style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Corner radius (px)</p>
                    <input
                      type="number" min="0" max="100" step="1"
                      value={sel.borderRadius || 0}
                      onChange={e => {
                        const v = parseInt(e.target.value) || 0;
                        sel.borderRadius = v;
                        updateSelected({ border_radius: v });
                      }}
                      style={{ width: '100%', padding: '6px 8px', border: '1px solid #c9cccf',
                        borderRadius: 6, fontSize: 13 }}
                    />
                  </div>
                </>
              )}

              {/* ── SVG props ── */}
              {selType === 'svg' && (
                <div>
                  <p style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Upload SVG file</p>
                  <input type="file" accept=".svg" onChange={handleSvgUpload}
                    style={{ fontSize: 13, width: '100%' }} />
                </div>
              )}
            </BlockStack>
          )}
        </div>

        {/* Canvas area — fills remaining space */}
        <div
          id="canvas-container"
          style={{ flex: 1, overflow: 'auto', background: '#e0e0e0', position: 'relative', minHeight: 0 }}
        >
          <canvas ref={canvasRef} />
        </div>
      </div>

      {/* Save modal — rename before saving */}
      <Modal
        open={saveModal}
        onClose={() => setSaveModal(false)}
        title="Save template"
        primaryAction={{ content: 'Save', onAction: handleSave, loading: saving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setSaveModal(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            <TextField
              label="Template name"
              value={templateName}
              onChange={setTemplateName}
              autoComplete="off"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
      {/* Preview modal */}
      <Modal
        open={previewModal}
        onClose={() => { setPreviewModal(false); setPreviewData(null); setPreviewError(''); setPreviewSku(''); }}
        title="Preview with product data"
        primaryAction={{ content: 'Look up', onAction: handlePreview, loading: previewLoading }}
        secondaryActions={[{ content: 'Close', onAction: () => { setPreviewModal(false); setPreviewData(null); setPreviewError(''); setPreviewSku(''); } }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Enter SKU"
              value={previewSku}
              onChange={setPreviewSku}
              onKeyDown={e => { if (e.key === 'Enter') handlePreview(); }}
              placeholder="e.g. WIG-LUCY-BLK-M"
              autoComplete="off"
            />
            {previewError && <Banner tone="critical">{previewError}</Banner>}
            {previewData && (
              <BlockStack gap="200">
                <Text variant="headingSm">Preview values</Text>
                {(template?.elements || [])
                  .filter(el => el.type === 'text' && el.field_key && el.field_key !== 'custom')
                  .map((el, i) => {
                    const val = getPreviewValue(el.field_key, el.metafield_namespace, el.metafield_key);
                    return (
                      <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13, padding: '4px 0',
                        borderBottom: '1px solid #f0f0f0' }}>
                        <span style={{ color: '#666', minWidth: 160 }}>{el.field_key}</span>
                        <span style={{ fontWeight: 500 }}>{val || '—'}</span>
                      </div>
                    );
                  })}
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </div>
  );
}

// ─── Small reusable panel components ─────────────────────────────────────────
function ToolBtn({ children, onClick, title, active, danger }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? '#e3f1ff' : 'transparent',
        border: active ? '1px solid #3b82f6' : '1px solid transparent',
        borderRadius: 6, cursor: 'pointer', fontSize: 15,
        color: danger ? '#d82c0d' : active ? '#1d4ed8' : '#333',
      }}
    >
      {children}
    </button>
  );
}

function PanelSelect({ label, value, options, onChange }) {
  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{label}</p>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '6px 8px', border: '1px solid #c9cccf',
          borderRadius: 6, fontSize: 13, background: '#fff', fontFamily: FONT_FAMILY }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function PanelInput({ label, value, onChange, placeholder }) {
  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{label}</p>
      <input
        type="text" value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '6px 8px', border: '1px solid #c9cccf',
          borderRadius: 6, fontSize: 13, fontFamily: FONT_FAMILY, boxSizing: 'border-box' }}
      />
    </div>
  );
}

export default BuyerLabelEditor;