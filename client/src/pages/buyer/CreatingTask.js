import React, { useState, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Checkbox, Badge, Banner, Spinner, Select
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import SearchWithFilters from '../../components/SearchWithFilters';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01','HQ'
];

// 改动一：9个 Type 列表
const TYPE_OPTIONS = [
  'Braid',
  'Hair',
  'Hair & Skin Care',
  'Hera Beauty',
  'Jewelry',
  'K-Beauty',
  'Makeup',
  'Tools & Accessories',
  'Wig',
];

const METAFIELD_CONDITIONS = [
  { label: 'value matches exactly',       value: 'value matches exactly' },
  { label: "value doesn't match exactly", value: "value doesn't match exactly" },
  { label: 'value contains',              value: 'value contains' },
  { label: "value doesn't contain",       value: "value doesn't contain" },
  { label: 'exists with',                 value: 'exists with' },
  { label: "doesn't exist with",          value: "doesn't exist with" },
];

// 改动二：单条 metafield 行的默认值
function newMetafieldRow() {
  return { id: Date.now() + Math.random(), level: 'product', condition: 'value matches exactly', key: '', value: '' };
}

function CreatingTask() {
  const navigate = useNavigate();

  // 改动一：selectedTypes 替代 department
  const [selectedTypes, setSelectedTypes]       = useState([]);
  const [selectedLocations, setSelectedLocations] = useState([]);

  // 改动二：metafield 列表 + 逻辑
  const [metafieldRows, setMetafieldRows]       = useState([]);
  const [metafieldLogic, setMetafieldLogic]     = useState('all'); // 'all' | 'any'

  const [products, setProducts]                 = useState([]);
  const [taskItems, setTaskItems]               = useState([]);
  const [negativeItems, setNegativeItems]       = useState({});
  const [excludedBarcodes, setExcludedBarcodes] = useState({});
  const [selectedProductBarcodes, setSelectedProductBarcodes] = useState([]);
  const [loadingProducts, setLoadingProducts]   = useState(false);
  const [loadingNegative, setLoadingNegative]   = useState(false);
  const [loadingExclude, setLoadingExclude]     = useState(false);
  const [negativeSuccess, setNegativeSuccess]   = useState(false);
  const [excludeSuccess, setExcludeSuccess]     = useState(false);
  const [csvImported, setCsvImported]           = useState(false);
  const [error, setError]                       = useState('');
  const [resultFilter, setResultFilter]         = useState('');

  const csvInputRef = useRef(null);

  const handleShowResult = async () => {
    setLoadingProducts(true);
    setError('');
    try {
      const res = await fetch('/api/shopify/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          types: selectedTypes,
          metafields: metafieldRows.map(r => ({
            level: r.level,
            condition: r.condition,
            key: r.key,
            value: r.value,
          })),
          metafieldLogic,
        }),
      });
      const data = await res.json();
      setProducts(data);
      setSelectedProductBarcodes([]);
      setResultFilter('');
      setExcludeSuccess(false);
      setExcludedBarcodes({});
    } catch (e) {
      setError('Failed to fetch products');
    } finally {
      setLoadingProducts(false);
    }
  };

  // 改动一：Add negative 需要 types 和 location 都选了
  const handleAddNegative = async () => {
    if (selectedLocations.length === 0) {
      setError('Please select at least one location first.');
      return;
    }
    if (selectedTypes.length === 0) {
      setError('Please select at least one type first.');
      return;
    }
    setLoadingNegative(true);
    setNegativeSuccess(false);
    setError('');
    try {
      const res = await fetch('/api/tasks/negative-inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: selectedLocations, types: selectedTypes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setNegativeItems(data);
      setNegativeSuccess(true);
    } catch (e) {
      setError(e.message || 'Failed to fetch negative inventory');
    } finally {
      setLoadingNegative(false);
    }
  };

  const handleExcludeZero = async () => {
    if (selectedLocations.length === 0) {
      setError('Please select at least one location first.');
      return;
    }
    if (products.length === 0) {
      setError('No products in list to check.');
      return;
    }
    setLoadingExclude(true);
    setExcludeSuccess(false);
    setError('');
    try {
      const barcodes = products.map(p => p.barcode).filter(Boolean);
      const res = await fetch('/api/shopify/soh-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcodes, locations: selectedLocations }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setExcludedBarcodes(data);
      setExcludeSuccess(true);
    } catch (e) {
      setError(e.message || 'Failed to check SOH');
    } finally {
      setLoadingExclude(false);
    }
  };

  const handleAddSelected = () => {
    const toAdd = products
      .filter(p => selectedProductBarcodes.includes(p.barcode))
      .map(p => p.barcode);
    setTaskItems(prev => [...new Set([...prev, ...toAdd])]);
    setSelectedProductBarcodes([]);
  };

  const handleAddAll = () => {
    setTaskItems(prev => [...new Set([...prev, ...products.map(p => p.barcode)])]);
  };

  const toggleSelectProduct = (barcode) => {
    setSelectedProductBarcodes(prev =>
      prev.includes(barcode) ? prev.filter(x => x !== barcode) : [...prev, barcode]
    );
  };

  const toggleSelectAll = () => {
    if (selectedProductBarcodes.length === filteredProducts.length) {
      setSelectedProductBarcodes([]);
    } else {
      setSelectedProductBarcodes(filteredProducts.map(p => p.barcode));
    }
  };

  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const lines = evt.target.result.split('\n').filter(l => l.trim());
      const newProducts = [];
      for (const line of lines) {
        const cols = line.split(',');
        if (cols.length >= 2) {
          const name = String(cols[0].trim().replace(/"/g, ''));
          const barcode = String(cols[1].trim().replace(/"/g, ''));
          if (barcode && barcode.toLowerCase() !== 'barcode' && name.toLowerCase() !== 'name') {
            newProducts.push({ name, barcode });
          }
        }
      }
      if (newProducts.length === 0) return;
      setProducts(prev => {
        const existing = prev.map(p => p.barcode);
        const toAdd = newProducts.filter(p => !existing.includes(p.barcode));
        return [...prev, ...toAdd];
      });
      setTaskItems(prev => [...new Set([...prev, ...newProducts.map(p => p.barcode)])]);
      setCsvImported(true);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // 改动二：metafield 行操作
  const addMetafieldRow = () => setMetafieldRows(prev => [...prev, newMetafieldRow()]);
  const removeMetafieldRow = (id) => setMetafieldRows(prev => prev.filter(r => r.id !== id));
  const updateMetafieldRow = (id, field, val) => {
    setMetafieldRows(prev => prev.map(r => r.id === id ? { ...r, [field]: val } : r));
  };

  const handlePreview = () => {
    if (taskItems.length === 0 && Object.keys(negativeItems).length === 0) {
      setError('Please add at least one product to the task.');
      return;
    }
    if (selectedLocations.length === 0) {
      setError('Please select at least one location.');
      return;
    }
    if (selectedTypes.length === 0) {
      setError('Please select at least one type.');
      return;
    }

    const summaryParts = [];
    if (selectedTypes.length > 0) summaryParts.push(`types: ${selectedTypes.join(', ')}`);
    if (metafieldRows.length > 0) {
      summaryParts.push(`metafield (${metafieldLogic}): ${metafieldRows.map(r => `${r.key} ${r.condition} ${r.value}`).join('; ')}`);
    }
    if (csvImported) summaryParts.push('CSV imported');
    if (Object.values(negativeItems).some(arr => arr.length > 0)) summaryParts.push('negative added');
    if (Object.values(excludedBarcodes).some(arr => arr.length > 0)) summaryParts.push('0 excluded');

    const filterSummary = summaryParts.length > 0 ? summaryParts.join(' | ') : 'All products';

    const taskData = {
      types: selectedTypes,
      locations: selectedLocations,
      filterSummary,
      items: products.filter(p => taskItems.includes(p.barcode)),
      negativeItems,
      excludedBarcodes,
    };
    sessionStorage.setItem('pendingTask', JSON.stringify(taskData));
    navigate('/buyer/counting-tasks/new/preview');
  };

  const filteredProducts = resultFilter.trim()
    ? products.filter(p =>
        (p.name && p.name.toLowerCase().includes(resultFilter.toLowerCase())) ||
        (p.barcode && p.barcode.toLowerCase().includes(resultFilter.toLowerCase()))
      )
    : products;

  const rows = filteredProducts.map(p => [
    <Checkbox
      checked={selectedProductBarcodes.includes(p.barcode)}
      onChange={() => toggleSelectProduct(p.barcode)}
    />,
    p.name || '-',
    p.barcode || '-',
    taskItems.includes(p.barcode) ? <Badge tone="success">Included</Badge> : '',
  ]);

  return (
    <Page
      title="Creating task"
      backAction={{ onAction: () => navigate('/buyer/counting-tasks') }}
      secondaryActions={[{ content: 'Preview task', onAction: handlePreview }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            {/* 改动一：Types + Location */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="400" wrap align="start">
                  <MultiSelectDropdown
                    label="Types"
                    options={TYPE_OPTIONS}
                    selected={selectedTypes}
                    onChange={setSelectedTypes}
                    placeholder="Select types"
                  />
                  <MultiSelectDropdown
                    label="Location"
                    options={LOCATIONS}
                    selected={selectedLocations}
                    onChange={setSelectedLocations}
                    placeholder="Select locations"
                    showSelectAll={true}
                  />
                </InlineStack>

                <InlineStack gap="200" align="start">
                  {/* 改动一：需要 types 和 location 都选了才能点 */}
                  <Button
                    onClick={handleAddNegative}
                    loading={loadingNegative}
                    disabled={selectedLocations.length === 0 || selectedTypes.length === 0}
                  >
                    Add negative
                  </Button>
                  {negativeSuccess && (
                    <Text variant="bodySm" tone="success">Added successfully</Text>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Search and add products */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm">Search and add products</Text>
                <SearchWithFilters
                  onAddItems={(items) => {
                    const barcodes = items.map(i => i.barcode);
                    setTaskItems(prev => [...new Set([...prev, ...barcodes])]);
                    setProducts(prev => {
                      const existing = prev.map(p => p.barcode);
                      const newItems = items.filter(i => !existing.includes(i.barcode));
                      return [...prev, ...newItems];
                    });
                  }}
                  taskItems={taskItems}
                />
              </BlockStack>
            </Card>

            {/* 改动二：Filters card — 移除 Type condition，新增 metafield 动态行 */}
            <Card>
              <BlockStack gap="400">

                {/* Metafield section */}
                <BlockStack gap="300">
                  <InlineStack gap="300" align="start">
                    <Button onClick={addMetafieldRow}>Add metafield</Button>
                    {/* Meet all / any 切换 */}
                    <InlineStack gap="200">
                      {['all', 'any'].map(opt => (
                        <button
                          key={opt}
                          onClick={() => setMetafieldLogic(opt)}
                          style={{
                            padding: '6px 14px', borderRadius: '20px',
                            border: `1px solid ${metafieldLogic === opt ? '#005bd3' : '#c9cccf'}`,
                            background: metafieldLogic === opt ? '#f0f5ff' : 'white',
                            color: metafieldLogic === opt ? '#005bd3' : '#6d7175',
                            cursor: 'pointer', fontSize: '13px', fontWeight: metafieldLogic === opt ? '600' : '400',
                          }}
                        >
                          {opt === 'all' ? 'Meet all conditions' : 'Meet any condition'}
                        </button>
                      ))}
                    </InlineStack>
                  </InlineStack>

                  {metafieldRows.map(row => (
                    <InlineStack key={row.id} gap="200" align="start" wrap>
                      {/* Product / Variant 选择 */}
                      <select
                        value={row.level}
                        onChange={e => updateMetafieldRow(row.id, 'level', e.target.value)}
                        style={{ padding: '6px 10px', border: '1px solid #c9cccf', borderRadius: '6px', fontSize: '14px' }}
                      >
                        <option value="product">Product</option>
                        <option value="variant">Variant</option>
                      </select>

                      {/* Match 条件 */}
                      <select
                        value={row.condition}
                        onChange={e => updateMetafieldRow(row.id, 'condition', e.target.value)}
                        style={{ padding: '6px 10px', border: '1px solid #c9cccf', borderRadius: '6px', fontSize: '14px' }}
                      >
                        {METAFIELD_CONDITIONS.map(c => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>

                      {/* namespace.key */}
                      <input
                        type="text"
                        placeholder="namespace.key"
                        value={row.key}
                        onChange={e => updateMetafieldRow(row.id, 'key', e.target.value)}
                        style={{ padding: '6px 10px', border: '1px solid #c9cccf', borderRadius: '6px', fontSize: '14px', width: '160px' }}
                      />

                      {/* value */}
                      <input
                        type="text"
                        placeholder="value"
                        value={row.value}
                        onChange={e => updateMetafieldRow(row.id, 'value', e.target.value)}
                        style={{ padding: '6px 10px', border: '1px solid #c9cccf', borderRadius: '6px', fontSize: '14px', width: '120px' }}
                      />

                      {/* 删除 */}
                      <button
                        onClick={() => removeMetafieldRow(row.id)}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: '#d72c0d', fontSize: '18px', lineHeight: 1, padding: '4px',
                        }}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </InlineStack>
                  ))}
                </BlockStack>

                <InlineStack align="space-between">
                  <InlineStack gap="200">
                    <input
                      type="file"
                      accept=".csv"
                      ref={csvInputRef}
                      style={{ display: 'none' }}
                      onChange={handleCSVUpload}
                    />
                    <Button onClick={() => csvInputRef.current.click()}>Upload CSV</Button>
                    {taskItems.length > 0 && (
                      <Text variant="bodySm" tone="subdued">{taskItems.length} items added</Text>
                    )}
                  </InlineStack>
                  <Button onClick={handleShowResult} loading={loadingProducts}>Show result</Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Product list */}
            {products.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">{products.length} products</Text>
                    <InlineStack gap="200">
                      {excludeSuccess && (
                        <Text variant="bodySm" tone="success">Excluded successfully</Text>
                      )}
                      <Button
                        onClick={handleExcludeZero}
                        loading={loadingExclude}
                        disabled={selectedLocations.length === 0}
                      >
                        Exclude 0
                      </Button>
                      <Button disabled={selectedProductBarcodes.length === 0} onClick={handleAddSelected}>
                        Add selected
                      </Button>
                      <Button onClick={handleAddAll}>Add all</Button>
                    </InlineStack>
                  </InlineStack>

                  {products.length >= 2 && (
                    <input
                      type="text"
                      placeholder="Filter results by name or SKU..."
                      value={resultFilter}
                      onChange={e => setResultFilter(e.target.value)}
                      style={{
                        width: '100%', padding: '8px 12px',
                        border: '1px solid #c9cccf', borderRadius: '8px',
                        fontSize: '14px', boxSizing: 'border-box',
                      }}
                    />
                  )}

                  <DataTable
                    columnContentTypes={['text','text','text','text']}
                    headings={[
                      <Checkbox
                        checked={selectedProductBarcodes.length === filteredProducts.length && filteredProducts.length > 0}
                        indeterminate={selectedProductBarcodes.length > 0 && selectedProductBarcodes.length < filteredProducts.length}
                        onChange={toggleSelectAll}
                      />,
                      'Name', 'SKU', 'Task',
                    ]}
                    rows={rows}
                  />
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default CreatingTask;