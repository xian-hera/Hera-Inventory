import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Select, Banner
} from '@shopify/polaris';
import { useNavigate, useLocation } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

function BuyerPOSupplierAdd() {
  const navigate = useNavigate();
  const location = useLocation();

  const [name, setName] = useState(location.state?.prefillName || '');
  const [currency, setCurrency] = useState('CAD');
  const [fxRate, setFxRate] = useState('');
  const [typesCarrying, setTypesCarrying] = useState([]);
  const [typeOptions, setTypeOptions] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/shopify/product-types')
      .then(r => r.json())
      .then(data => setTypeOptions(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const validate = () => {
    if (!name.trim()) return 'Name is required.';
    if (!currency) return 'Currency is required.';
    if (currency === 'USD' && !fxRate.trim()) return 'FX rate is required when currency is USD.';
    if (typesCarrying.length === 0) return 'At least one type is required.';
    return null;
  };

  const save = async () => {
    const validationError = validate();
    if (validationError) { setError(validationError); return null; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/po-suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, currency, fxRate: currency === 'USD' ? fxRate : null, typesCarrying }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      return data;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    const supplier = await save();
    if (supplier) navigate(`/buyer/po-receiving/suppliers/${supplier.id}`);
  };

  const handleSaveAndUpdateSku = async () => {
    const supplier = await save();
    if (!supplier) return;
    try {
      await fetch(`/api/po-suppliers/${supplier.id}/update-sku`, { method: 'POST' });
    } catch (e) {
      // ignore — detail page will show status
    }
    navigate(`/buyer/po-receiving/suppliers/${supplier.id}`);
  };

  return (
    <Page
      title="Adding supplier"
      backAction={{ onAction: () => navigate('/buyer/po-receiving/suppliers') }}
      secondaryActions={[
        { content: 'Discard', destructive: true, onAction: () => navigate('/buyer/po-receiving/suppliers') },
        { content: 'Save', onAction: handleSave, loading: saving },
        { content: 'Save and update SKU', onAction: handleSaveAndUpdateSku, loading: saving },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <InlineStack gap="400" wrap align="start">
                <div style={{ width: 220 }}>
                  <TextField label="Name" value={name} onChange={setName} autoComplete="off" />
                  <Text variant="bodySm" tone="subdued">
                    Case-sensitive — must exactly match the metafield value.
                  </Text>
                </div>
                <div style={{ width: 140 }}>
                  <Select
                    label="Currency"
                    options={[{ label: 'CAD', value: 'CAD' }, { label: 'USD', value: 'USD' }]}
                    value={currency}
                    onChange={(val) => { setCurrency(val); if (val === 'CAD') setFxRate(''); }}
                  />
                </div>
                <div style={{ width: 140 }}>
                  <TextField
                    label="FX rate"
                    value={fxRate}
                    onChange={setFxRate}
                    disabled={currency !== 'USD'}
                    autoComplete="off"
                    type="number"
                  />
                </div>
                <div style={{ minWidth: 220 }}>
                  <MultiSelectDropdown
                    label="Types carrying"
                    options={typeOptions}
                    selected={typesCarrying}
                    onChange={setTypesCarrying}
                    placeholder="Select types"
                  />
                </div>
              </InlineStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOSupplierAdd;
