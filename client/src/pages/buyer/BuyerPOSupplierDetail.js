import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Select,
  Banner, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import InfoTooltip from '../../components/InfoTooltip';

function formatCost(v) {
  return v === null || v === undefined ? '/' : `$${Number(v).toFixed(2)}`;
}

function BuyerPOSupplierDetail() {
  const navigate = useNavigate();
  const { supplierId } = useParams();

  const [supplier, setSupplier] = useState(null);
  const [skus, setSkus] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const [typeOptions, setTypeOptions] = useState([]);
  const [editingField, setEditingField] = useState(null); // 'name' | 'currency' | 'fxRate' | 'types'
  const [nameInput, setNameInput] = useState('');
  const [currencyInput, setCurrencyInput] = useState('CAD');
  const [fxRateInput, setFxRateInput] = useState('');
  const [typesInput, setTypesInput] = useState([]);

  const [updateStatus, setUpdateStatus] = useState(null);
  const pollTimer = useRef(null);

  const fetchDetail = useCallback(async (q) => {
    setLoading(true);
    try {
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      const res = await fetch(`/api/po-suppliers/${supplierId}${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSupplier(data.supplier);
      setSkus(data.skus);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => { fetchDetail(''); }, [fetchDetail]);

  useEffect(() => {
    fetch('/api/shopify/product-types')
      .then(r => r.json())
      .then(data => setTypeOptions(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const fetchUpdateStatus = useCallback(async () => {
    const res = await fetch(`/api/po-suppliers/${supplierId}/update-sku/status`);
    const data = await res.json();
    setUpdateStatus(data);
    return data.isRunning;
  }, [supplierId]);

  useEffect(() => {
    fetchUpdateStatus().then(isRunning => {
      if (isRunning) startPolling();
    });
    return () => { if (pollTimer.current) clearInterval(pollTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPolling = () => {
    if (pollTimer.current) return;
    pollTimer.current = setInterval(async () => {
      const isRunning = await fetchUpdateStatus();
      if (!isRunning) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
        fetchDetail(search);
      }
    }, 3000);
  };

  const handleUpdateSku = async () => {
    setError('');
    try {
      const res = await fetch(`/api/po-suppliers/${supplierId}/update-sku`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      startPolling();
      fetchUpdateStatus();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete supplier "${supplier?.name}"? This also removes its SKU mapping. This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/po-suppliers/${supplierId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Delete failed');
      }
      navigate('/buyer/po-receiving/suppliers');
    } catch (e) {
      setError(e.message);
    }
  };

  const startEdit = (field) => {
    setError('');
    setNameInput(supplier.name);
    setCurrencyInput(supplier.currency);
    setFxRateInput(supplier.fx_rate || '');
    setTypesInput(supplier.types_carrying || []);
    setEditingField(field);
  };

  const cancelEdit = () => setEditingField(null);

  const patchSupplier = async (body) => {
    const res = await fetch(`/api/po-suppliers/${supplierId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setSupplier(data);
    setEditingField(null);
  };

  const saveName = async () => {
    if (!nameInput.trim()) { setError('Name is required.'); return; }
    try { await patchSupplier({ name: nameInput }); } catch (e) { setError(e.message); }
  };
  const saveCurrency = async () => {
    if (currencyInput === 'USD' && !String(fxRateInput).trim()) { setError('FX rate is required when currency is USD.'); return; }
    try { await patchSupplier({ currency: currencyInput, fxRate: currencyInput === 'USD' ? fxRateInput : null }); } catch (e) { setError(e.message); }
  };
  const saveFxRate = async () => {
    if (!String(fxRateInput).trim()) { setError('FX rate is required.'); return; }
    try { await patchSupplier({ currency: supplier.currency, fxRate: fxRateInput }); } catch (e) { setError(e.message); }
  };
  const saveTypes = async () => {
    if (typesInput.length === 0) { setError('At least one type is required.'); return; }
    try { await patchSupplier({ typesCarrying: typesInput }); } catch (e) { setError(e.message); }
  };

  if (loading && !supplier) {
    return (
      <Page title="Supplier" backAction={{ onAction: () => navigate('/buyer/po-receiving/suppliers') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }
  if (!supplier) {
    return (
      <Page title="Supplier" backAction={{ onAction: () => navigate('/buyer/po-receiving/suppliers') }}>
        <Layout><Layout.Section>{error && <Banner tone="critical">{error}</Banner>}</Layout.Section></Layout>
      </Page>
    );
  }

  return (
    <Page
      title={supplier.name}
      backAction={{ onAction: () => navigate('/buyer/po-receiving/suppliers') }}
      secondaryActions={[
        { content: 'Delete supplier', destructive: true, onAction: handleDelete },
        { content: 'Update SKU', onAction: handleUpdateSku, loading: updateStatus?.isRunning, disabled: updateStatus?.isRunning },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {updateStatus?.isRunning && <Banner tone="info">Update SKU is running in the background — this may take a while…</Banner>}
            {updateStatus && !updateStatus.isRunning && updateStatus.finishedAt && updateStatus.error && (
              <Banner tone="critical">Update SKU failed: {updateStatus.error}</Banner>
            )}

            <Card>
              <InlineStack gap="600" wrap align="start">
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Name</Text>
                  {editingField === 'name' ? (
                    <InlineStack gap="200" blockAlign="center">
                      <div style={{ width: 180 }}>
                        <TextField label="" labelHidden value={nameInput} onChange={setNameInput} autoComplete="off" />
                      </div>
                      <Button size="slim" onClick={saveName}>Save</Button>
                      <Button size="slim" variant="plain" onClick={cancelEdit}>Cancel</Button>
                    </InlineStack>
                  ) : (
                    <InlineStack gap="200" blockAlign="center">
                      <Text fontWeight="semibold">{supplier.name}</Text>
                      <Button size="slim" variant="plain" onClick={() => startEdit('name')}>Edit</Button>
                    </InlineStack>
                  )}
                </BlockStack>

                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Currency</Text>
                  {editingField === 'currency' ? (
                    <InlineStack gap="200" blockAlign="center">
                      <div style={{ width: 110 }}>
                        <Select
                          label="" labelHidden
                          options={[{ label: 'CAD', value: 'CAD' }, { label: 'USD', value: 'USD' }]}
                          value={currencyInput}
                          onChange={setCurrencyInput}
                        />
                      </div>
                      {currencyInput === 'USD' && (
                        <div style={{ width: 100 }}>
                          <TextField label="" labelHidden type="number" value={String(fxRateInput)} onChange={setFxRateInput} autoComplete="off" />
                        </div>
                      )}
                      <Button size="slim" onClick={saveCurrency}>Save</Button>
                      <Button size="slim" variant="plain" onClick={cancelEdit}>Cancel</Button>
                    </InlineStack>
                  ) : (
                    <InlineStack gap="200" blockAlign="center">
                      <Text fontWeight="semibold">{supplier.currency}</Text>
                      <Button size="slim" variant="plain" onClick={() => startEdit('currency')}>Edit</Button>
                    </InlineStack>
                  )}
                </BlockStack>

                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">FX rate</Text>
                  {editingField === 'fxRate' ? (
                    <InlineStack gap="200" blockAlign="center">
                      <div style={{ width: 100 }}>
                        <TextField label="" labelHidden type="number" value={String(fxRateInput)} onChange={setFxRateInput} autoComplete="off" />
                      </div>
                      <Button size="slim" onClick={saveFxRate}>Save</Button>
                      <Button size="slim" variant="plain" onClick={cancelEdit}>Cancel</Button>
                    </InlineStack>
                  ) : (
                    <InlineStack gap="200" blockAlign="center">
                      <Text fontWeight="semibold">{supplier.currency === 'USD' ? supplier.fx_rate : '/'}</Text>
                      <Button size="slim" variant="plain" disabled={supplier.currency !== 'USD'} onClick={() => startEdit('fxRate')}>Edit</Button>
                    </InlineStack>
                  )}
                </BlockStack>

                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Types carrying</Text>
                  {editingField === 'types' ? (
                    <InlineStack gap="200" blockAlign="center">
                      <div style={{ minWidth: 220 }}>
                        <MultiSelectDropdown label="" options={typeOptions} selected={typesInput} onChange={setTypesInput} />
                      </div>
                      <Button size="slim" onClick={saveTypes}>Save</Button>
                      <Button size="slim" variant="plain" onClick={cancelEdit}>Cancel</Button>
                    </InlineStack>
                  ) : (
                    <InlineStack gap="200" blockAlign="center">
                      <Text fontWeight="semibold">{(supplier.types_carrying || []).join(', ')}</Text>
                      <Button size="slim" variant="plain" onClick={() => startEdit('types')}>Edit</Button>
                    </InlineStack>
                  )}
                </BlockStack>
              </InlineStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="" labelHidden
                      placeholder="Search by code, SKU, or product name"
                      value={search}
                      onChange={setSearch}
                      onKeyDown={(e) => { if (e.key === 'Enter') fetchDetail(search); }}
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => { setSearch(''); fetchDetail(''); }}
                    />
                  </div>
                  <Button onClick={() => fetchDetail(search)}>Search</Button>
                </InlineStack>
                {!loading && <Text tone="subdued" variant="bodySm">Found {skus.length} matched</Text>}
              </BlockStack>
            </Card>

            {skus.length > 0 && (
              <Card>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>code</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>SKU</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Type</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Pack size</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>
                          <InfoTooltip text="value in variant metafield custom.supplier_a/b/c_cost">
                            Supplier cost
                          </InfoTooltip>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {skus.map(s => (
                        <tr key={s.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                          <td style={{ padding: '10px' }}>{s.name || '-'}</td>
                          <td style={{ padding: '10px' }}>{s.code}</td>
                          <td style={{ padding: '10px' }}>{s.sku}</td>
                          <td style={{ padding: '10px' }}>{s.product_type || '-'}</td>
                          <td style={{ padding: '10px' }}>{s.pack_size ?? '-'}</td>
                          <td style={{ padding: '10px' }}>{formatCost(s.metafield_cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOSupplierDetail;
