import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Select, Text, DataTable, Checkbox, Badge, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01'
];

function CreatingTask() {
  const navigate = useNavigate();

  // Filters
  const [department, setDepartment] = useState('CARE');
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [typeCondition, setTypeCondition] = useState('is');
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [allTypes, setAllTypes] = useState([]);
  const [metafieldCondition, setMetafieldCondition] = useState('value matches exactly');
  const [metafieldKey, setMetafieldKey] = useState('');
  const [metafieldValue, setMetafieldValue] = useState('');

  // Products
  const [products, setProducts] = useState([]);
  const [taskItems, setTaskItems] = useState([]); // barcodes added to task
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [error, setError] = useState('');

  // Fetch product types on mount
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
      setSelectedProductIds([]);
    } catch (e) {
      setError('Failed to fetch products');
    } finally {
      setLoadingProducts(false);
    }
  };

  const handleAddSelected = () => {
    const toAdd = products
      .filter(p => selectedProductIds.includes(p.barcode))
      .map(p => p.barcode);
    setTaskItems(prev => [...new Set([...prev, ...toAdd])]);
    setSelectedProductIds([]);
  };

  const handleAddAll = () => {
    const toAdd = products.map(p => p.barcode);
    setTaskItems(prev => [...new Set([...prev, ...toAdd])]);
  };

  const toggleSelectProduct = (barcode) => {
    setSelectedProductIds(prev =>
      prev.includes(barcode) ? prev.filter(x => x !== barcode) : [...prev, barcode]
    );
  };

  const toggleSelectAll = () => {
    if (selectedProductIds.length === products.length) {
      setSelectedProductIds([]);
    } else {
      setSelectedProductIds(products.map(p => p.barcode));
    }
  };

  const toggleLocation = (loc) => {
    setSelectedLocations(prev =>
      prev.includes(loc) ? prev.filter(l => l !== loc) : [...prev, loc]
    );
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

    // Build filter summary
    let filterSummary = '';
    if (selectedTypes.length > 0) {
      filterSummary += `type ${typeCondition} ${selectedTypes.join(', ')}`;
    }
    if (metafieldKey && metafieldValue) {
      if (filterSummary) filterSummary += ', ';
      filterSummary += `metafield ${metafieldKey} ${metafieldCondition} ${metafieldValue}`;
    }
    if (!filterSummary) filterSummary = 'All products';

    // Store task data in sessionStorage for preview page
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
      checked={selectedProductIds.includes(p.barcode)}
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
                  {/* Department */}
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">Department</Text>
                    <Select
                      label=""
                      labelHidden
                      options={[
                        { label: 'CARE', value: 'CARE' },
                        { label: 'HAIR', value: 'HAIR' },
                        { label: 'GENM', value: 'GENM' },
                      ]}
                      value={department}
                      onChange={setDepartment}
                    />
                  </BlockStack>

                  {/* Location */}
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">Location</Text>
                    <InlineStack gap="200" wrap>
                      <select
                        multiple
                        size={5}
                        style={{ minWidth: '120px', padding: '4px' }}
                        onChange={(e) => {
                          const vals = Array.from(e.target.selectedOptions).map(o => o.value);
                          setSelectedLocations(vals);
                        }}
                      >
                        {LOCATIONS.map(l => (
                          <option key={l} value={l}>{l}</option>
                        ))}
                      </select>
                      {selectedLocations.length > 0 && (
                        <Text variant="bodySm" tone="subdued">
                          {selectedLocations.join(', ')}
                        </Text>
                      )}
                    </InlineStack>
                  </BlockStack>
                </InlineStack>

                {/* Type filter */}
                <InlineStack gap="200" align="start" wrap>
                  <Text variant="bodySm" tone="subdued">Type</Text>
                  <Select
                    label=""
                    labelHidden
                    options={[
                      { label: 'is', value: 'is' },
                      { label: 'is not', value: 'is not' },
                    ]}
                    value={typeCondition}
                    onChange={setTypeCondition}
                  />
                  {loadingTypes ? <Spinner size="small" /> : (
                    <select
                      multiple
                      size={4}
                      style={{ minWidth: '180px', padding: '4px' }}
                      onChange={(e) => {
                        const vals = Array.from(e.target.selectedOptions).map(o => o.value);
                        setSelectedTypes(vals);
                      }}
                    >
                      {allTypes.map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  )}
                  {selectedTypes.length > 0 && (
                    <Text variant="bodySm" tone="subdued">
                      {selectedTypes.join(', ')}
                    </Text>
                  )}
                </InlineStack>

                {/* Metafield filter */}
                <InlineStack gap="200" align="start" wrap>
                  <Text variant="bodySm" tone="subdued">Product metafield</Text>
                  <Select
                    label=""
                    labelHidden
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

                <InlineStack align="end">
                  <Button onClick={handleShowResult} loading={loadingProducts}>
                    Show result
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Product list */}
            {products.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="end" gap="200">
                    <Button
                      disabled={selectedProductIds.length === 0}
                      onClick={handleAddSelected}
                    >
                      Add selected
                    </Button>
                    <Button onClick={handleAddAll}>Add all</Button>
                  </InlineStack>
                  <DataTable
                    columnContentTypes={['text','text','text','text']}
                    headings={[
                      <Checkbox
                        checked={selectedProductIds.length === products.length && products.length > 0}
                        indeterminate={selectedProductIds.length > 0 && selectedProductIds.length < products.length}
                        onChange={toggleSelectAll}
                      />,
                      'Name',
                      'SKU',
                      'Task',
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