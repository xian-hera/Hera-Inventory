import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, Text, Spinner, TextField, InlineStack
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '/';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')}`;
}

function BuyerPOSuppliers() {
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchSuppliers = useCallback(async (q) => {
    setLoading(true);
    try {
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      const res = await fetch(`/api/po-suppliers${params}`);
      const data = await res.json();
      setSuppliers(Array.isArray(data) ? data : []);
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSuppliers(''); }, [fetchSuppliers]);

  const handleClearSearch = () => {
    setSearch('');
    fetchSuppliers('');
  };

  return (
    <Page
      title="Supplier management"
      backAction={{ onAction: () => navigate('/buyer/po-receiving') }}
      primaryAction={{ content: 'Add Supplier', onAction: () => navigate('/buyer/po-receiving/suppliers/new') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label=""
                      labelHidden
                      placeholder="Search by supplier name, code, or SKU"
                      value={search}
                      onChange={setSearch}
                      onKeyDown={(e) => { if (e.key === 'Enter') fetchSuppliers(search); }}
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={handleClearSearch}
                    />
                  </div>
                  <Button onClick={() => fetchSuppliers(search)}>Search</Button>
                </InlineStack>
                {!loading && <Text tone="subdued" variant="bodySm">Found {suppliers.length} matched</Text>}
              </BlockStack>
            </Card>

            <Card>
              {loading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : suppliers.length === 0 ? (
                <Text tone="subdued" alignment="center">No matching supplier found.</Text>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        {['Supplier', 'Currency', 'FX rate', 'Last invoice'].map((h, i) => (
                          <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {suppliers.map(s => (
                        <tr key={s.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                          <td style={{ padding: '10px' }}>
                            <span
                              style={{ cursor: 'pointer', textDecoration: 'underline' }}
                              onClick={() => navigate(`/buyer/po-receiving/suppliers/${s.id}`)}
                            >
                              {s.name}
                            </span>
                          </td>
                          <td style={{ padding: '10px' }}>{s.currency}</td>
                          <td style={{ padding: '10px' }}>{s.currency === 'USD' ? s.fx_rate : '/'}</td>
                          <td style={{ padding: '10px' }}>{formatDate(s.last_committed_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOSuppliers;
