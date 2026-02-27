import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Select, Text, DataTable, Checkbox, Badge, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

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

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchSelected, setSearchSelected] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);

  // CSV
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

  // Close search dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Search filter
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    const q = searchQuery.toLowerCase();
    const results = products.filter(p =>
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.barcode && p.barcode.toLowerCase().includes(q))
    );
    setSearchResults(results);
    setSearchOpen(results.length > 0);
  }, [searchQuery, products]);

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
      setSearchQuery('');
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

  const handleAddSearchSelected = () => {
    const toAdd = searchResults
      .filter(p => searchSelected.includes(p.barcode))
      .map(p => p.barcode);
    setTaskItems(prev => [...new Set([...prev, ...toAdd])]);
    setSearchSelected([]);
    setSearchQuery('');
    setSearchOpen(false);
  };

  const toggleSelectProduct = (barcode) => {
    setSelectedProductBarcodes(prev =>
      prev.includes(barcode) ? prev.filter(x => x !== barcode) : [...prev, barcode]
    );
  };

  const toggleSelectAll = () => {
    if (selectedProductBarcodes.length === products.length) {
      setSelectedProductBarcodes([]);
    } else {
      setSelectedProductBarcodes(products.map(p => p.barcode));
    }
  };

  const toggleSearchSelect = (barcode) => {
    setSearchSelected(prev =>
      prev.includes(barcode) ? prev.filter(x => x !== barcode) : [...prev, barcode]
    );
  };

  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const lines = evt.target.result.split('\n').filter(l => l.trim());
      const barcodes = [];
      for (const line of lines) {
        const cols = line.split(',');
        if (cols.length >= 2) {
          const barcode = cols[1].trim().replace(/"/g, '');
          if (barcode && barcode.toLowerCase() !== 'barcode') barcodes.push(barcode);
        }
      }
      setTaskItems(prev => [...new Set([...prev, ...barcodes])]);
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

  const rows = products.map(p => [
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
                    {/* CSV Upload */}
                    <input
                      type="file"
                      accept=".csv"
                      ref={csvInputRef}
                      style={{ display: 'none' }}
                      onChange={handleCSVUpload}
                    />
                    <Button onClick={() => csvInputRef.current.click()}>
                      Upload CSV
                    </Button>
                    {taskItems.length > 0 && (
                      <Text variant="bodySm" tone="subdued">{taskItems.length} items added</Text>
                    )}
                  </InlineStack>
                  <Button onClick={handleShowResult} loading={loadingProducts}>
                    Show result
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Search box */}
            {products.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingSm">Search products</Text>
                  <div ref={searchRef} style={{ position: 'relative' }}>
                    <input
                      type="text"
                      placeholder="Search by name or SKU..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      style={{
                        width: '100%', padding: '8px 12px',
                        border: '1px solid #c9cccf', borderRadius: '8px',
                        fontSize: '14px', boxSizing: 'border-box',
                      }}
                    />
                    {searchOpen && searchResults.length > 0 && (
                      <div style={{
                        position: 'absolute', top: '100%', left: 0, right: 0,
                        background: 'white', border: '1px solid #c9cccf',
                        borderRadius: '8px', zIndex: 100,
                        maxHeight: '240px', overflowY: 'auto',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                        marginTop: '4px',
                      }}>
                        {searchResults.map(p => (
                          <div
                            key={p.barcode}
                            style={{
                              padding: '8px 12px', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', gap: '8px',
                              background: searchSelected.includes(p.barcode) ? '#f1f8f5' : 'white',
                              borderBottom: '1px solid #f1f3f5',
                            }}
                            onClick={() => toggleSearchSelect(p.barcode)}
                          >
                            <input
                              type="checkbox"
                              checked={searchSelected.includes(p.barcode)}
                              onChange={() => {}}
                              style={{ cursor: 'pointer' }}
                            />
                            <div>
                              <div style={{ fontSize: '14px', fontWeight: '500' }}>{p.name}</div>
                              <div style={{ fontSize: '12px', color: '#6d7175' }}>{p.barcode}</div>
                            </div>
                            {taskItems.includes(p.barcode) && (
                              <span style={{ marginLeft: 'auto', color: 'green', fontSize: '12px' }}>✓ Added</span>
                            )}
                          </div>
                        ))}
                        {searchSelected.length > 0 && (
                          <div style={{ padding: '8px 12px', borderTop: '1px solid #f1f3f5' }}>
                            <Button size="slim" onClick={handleAddSearchSelected}>
                              Add {searchSelected.length} selected
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </BlockStack>
              </Card>
            )}

            {/* Product list */}
            {products.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="end" gap="200">
                    <Button disabled={selectedProductBarcodes.length === 0} onClick={handleAddSelected}>
                      Add selected
                    </Button>
                    <Button onClick={handleAddAll}>Add all</Button>
                  </InlineStack>
                  <DataTable
                    columnContentTypes={['text','text','text','text']}
                    headings={[
                      <Checkbox
                        checked={selectedProductBarcodes.length === products.length && products.length > 0}
                        indeterminate={selectedProductBarcodes.length > 0 && selectedProductBarcodes.length < products.length}
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