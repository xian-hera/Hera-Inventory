import React, { useState, useEffect, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Select, Text, DataTable, Checkbox, Badge, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import SearchWithFilters from '../../components/SearchWithFilters';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01'
];

function CreatingTask() {
  const navigate = useNavigate();
  const [department, setDepartment] = useState('CARE');
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [typeCondition, setTypeCondition] = useState('is');
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [allTypes, setAllTypes] = useState([]);
  const [metafieldCondition, setMetafieldCondition] = useState('value matches exactly');
  const [metafieldKey, setMetafieldKey] = useState('');
  const [metafieldValue, setMetafieldValue] = useState('');
  const [products, setProducts] = useState([]);
  const [taskItems, setTaskItems] = useState([]);
  const [selectedProductBarcodes, setSelectedProductBarcodes] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [error, setError] = useState('');
  const [resultFilter, setResultFilter] = useState('');

  const csvInputRef = useRef(null);

  useEffect(() => {
    const fetchTypes = async () => {
      setLoadingTypes(true);
      try {
        const res = await fetch('/api/shopify/product-types');
        const data = await res.json();
        setAllTypes(data);
      } catch (e) {
        console.error('Failed to fetch product types');
      } finally {
        setLoadingTypes(false);
      }
    };
    fetchTypes();
  }, []);

  const handleShowResult = async () => {
    setLoadingProducts(true);
    setError('');
    try {
      const res = await fetch('/api/shopify/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department,
          types: selectedTypes,
          typeCondition,
          metafieldKey,
          metafieldCondition,
          metafieldValue,
        }),
      });
      const data = await res.json();
      setProducts(data);
      setSelectedProductBarcodes([]);
      setResultFilter('');
    } catch (e) {
      setError('Failed to fetch products');
    } finally {
      setLoadingProducts(false);
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
        const name = cols[0].trim().replace(/"/g, '');
        const barcode = cols[1].trim().replace(/"/g, '');
        if (barcode && barcode.toLowerCase() !== 'barcode' && name.toLowerCase() !== 'name') {
          newProducts.push({ name, barcode });
        }
      }
    }
    if (newProducts.length === 0) return;

    // Add to products list
    setProducts(prev => {
      const existing = prev.map(p => p.barcode);
      const toAdd = newProducts.filter(p => !existing.includes(p.barcode));
      return [...prev, ...toAdd];
    });

    // Add to taskItems
    setTaskItems(prev => [...new Set([...prev, ...newProducts.map(p => p.barcode)])]);
  };
  reader.readAsText(file);
  e.target.value = '';
};

  const handlePreview = () => {
    if (taskItems.length === 0) {
      setError('Please add at least one product to the task.');
      return;
    }
    if (selectedLocations.length === 0) {
      setError('Please select at least one location.');
      return;
    }
    let filterSummary = '';
    if (selectedTypes.length > 0) {
      filterSummary += `type ${typeCondition} ${selectedTypes.join(', ')}`;
    }
    if (metafieldKey && metafieldValue) {
      if (filterSummary) filterSummary += ', ';
      filterSummary += `metafield ${metafieldKey} ${metafieldCondition} ${metafieldValue}`;
    }
    if (!filterSummary) filterSummary = 'All products';

    const taskData = {
      department,
      locations: selectedLocations,
      filterSummary,
      items: products.filter(p => taskItems.includes(p.barcode)),
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

            {/* Global search */}
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

            {/* Filters */}
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="400" wrap align="start">
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">Department</Text>
                    <Select
                      label="" labelHidden
                      options={[
                        { label: 'CARE', value: 'CARE' },
                        { label: 'HAIR', value: 'HAIR' },
                        { label: 'GENM', value: 'GENM' },
                      ]}
                      value={department}
                      onChange={setDepartment}
                    />
                  </BlockStack>

                  <MultiSelectDropdown
                    label="Location"
                    options={LOCATIONS}
                    selected={selectedLocations}
                    onChange={setSelectedLocations}
                    placeholder="Select locations"
                  />
                </InlineStack>

                {/* Type filter */}
                <InlineStack gap="200" align="start" wrap>
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">Type condition</Text>
                    <Select
                      label="" labelHidden
                      options={[
                        { label: 'is', value: 'is' },
                        { label: 'is not', value: 'is not' },
                      ]}
                      value={typeCondition}
                      onChange={setTypeCondition}
                    />
                  </BlockStack>
                  {loadingTypes ? <Spinner size="small" /> : (
                    <MultiSelectDropdown
                      label="Product type"
                      options={allTypes}
                      selected={selectedTypes}
                      onChange={setSelectedTypes}
                      placeholder="Select types"
                    />
                  )}
                </InlineStack>

                {/* Metafield filter */}
                <InlineStack gap="200" align="start" wrap>
                  <Text variant="bodySm" tone="subdued">Product metafield</Text>
                  <Select
                    label="" labelHidden
                    options={[
                      { label: 'value matches exactly', value: 'value matches exactly' },
                      { label: "value doesn't match exactly", value: "value doesn't match exactly" },
                      { label: 'value contains', value: 'value contains' },
                      { label: "value doesn't contain", value: "value doesn't contain" },
                      { label: 'exists with', value: 'exists with' },
                      { label: "doesn't exist with", value: "doesn't exist with" },
                    ]}
                    value={metafieldCondition}
                    onChange={setMetafieldCondition}
                  />
                  <input
                    type="text"
                    placeholder="namespace.key"
                    value={metafieldKey}
                    onChange={e => setMetafieldKey(e.target.value)}
                    style={{ padding: '6px', border: '1px solid #ccc', borderRadius: '4px', width: '160px' }}
                  />
                  <input
                    type="text"
                    placeholder="value"
                    value={metafieldValue}
                    onChange={e => setMetafieldValue(e.target.value)}
                    style={{ padding: '6px', border: '1px solid #ccc', borderRadius: '4px', width: '120px' }}
                  />
                </InlineStack>

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
                      <Button disabled={selectedProductBarcodes.length === 0} onClick={handleAddSelected}>
                        Add selected
                      </Button>
                      <Button onClick={handleAddAll}>Add all</Button>
                    </InlineStack>
                  </InlineStack>

                  {/* Result filter — only show when >= 2 products */}
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