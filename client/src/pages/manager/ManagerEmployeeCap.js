import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Spinner, Banner,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function ManagerEmployeeCap() {
  const navigate  = useNavigate();
  const location  = localStorage.getItem('managerLocation') || '';

  const [empCount,      setEmpCount]      = useState(null);
  const [employees,     setEmployees]      = useState([]);
  const [loading,       setLoading]        = useState(true);
  const [refreshing,    setRefreshing]     = useState(false);
  const [error,         setError]          = useState('');
  const [lastRefreshed, setLastRefreshed]  = useState(null);
  const [capAmount,     setCapAmount]      = useState(600);
  const [season,        setSeason]         = useState('');

  // ── helpers ────────────────────────────────────────────────────────────────

  function formatCurrency(val) {
    return `$${Number(val || 0).toFixed(2)}`;
  }

  function formatDate(iso) {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // ── fetch employees for this location ──────────────────────────────────────

  const fetchEmployees = useCallback(async () => {
    if (!location) return;
    setLoading(true);
    setError('');
    try {
      // Fetch all pages
      let all  = [];
      let page = 1;
      while (true) {
        const res  = await fetch(
          `/api/employees?season=current&branches=${encodeURIComponent(location)}&per_page=250&page=${page}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load employees');
        all = [...all, ...(data.employees || [])];
        setCapAmount(data.cap_amount || 600);
        setSeason(data.season || '');
        if (all.length >= data.total) break;
        page++;
      }
      setEmployees(all);
      setEmpCount(all.length);

      // Get last refresh time for this location
      const settingsRes  = await fetch('/api/employees/settings');
      const settings     = await settingsRes.json();
      const key          = `last_refresh_${location}`;
      setLastRefreshed(settings[key]?.refreshed_at || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [location]);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

  // ── refresh ────────────────────────────────────────────────────────────────

  const handleRefresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      const res  = await fetch('/api/employees/refresh', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ scope: location }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refresh failed');
      await fetchEmployees();
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  // ── render ─────────────────────────────────────────────────────────────────

  if (!location) {
    return (
      <Page title="Employee Cap" backAction={{ onAction: () => navigate('/manager') }}>
        <Banner tone="critical">No location selected. Please go back and select a location.</Banner>
      </Page>
    );
  }

  return (
    <Page
      title="Employee Cap"
      backAction={{ onAction: () => navigate('/manager') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">

            {error && (
              <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>
            )}

            {/* ── Card 1: summary + refresh ── */}
            <Card>
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingMd" fontWeight="bold">
                    {empCount !== null ? empCount : '—'}
                  </Text>
                  <Text variant="bodySm" tone="subdued">
                    Employees · {location}
                  </Text>
                </BlockStack>

                <BlockStack gap="100" inlineAlign="end">
                  <button
                    disabled={refreshing || loading}
                    onClick={handleRefresh}
                    style={{
                      padding: '8px 16px', borderRadius: '8px', border: 'none',
                      background: refreshing || loading ? '#f0f0f0' : '#005bd3',
                      color:      refreshing || loading ? '#8c9196' : 'white',
                      cursor:     refreshing || loading ? 'not-allowed' : 'pointer',
                      fontSize: '14px', fontWeight: '600',
                    }}
                  >
                    {refreshing ? 'Refreshing…' : 'Refresh'}
                  </button>
                  {lastRefreshed && (
                    <Text variant="bodySm" tone="subdued">
                      {formatDate(lastRefreshed)}
                    </Text>
                  )}
                </BlockStack>
              </InlineStack>
            </Card>

            {/* ── Employee list ── */}
            <Card>
              <BlockStack gap="300">
                {/* Header row */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 90px',
                  gap: '8px',
                  paddingBottom: '8px',
                  borderBottom: '1px solid #e1e3e5',
                  fontSize: '12px', fontWeight: '600', color: '#6d7175',
                }}>
                  <span>Name</span>
                  <span>Email</span>
                  <span style={{ textAlign: 'right' }}>Total</span>
                </div>

                {loading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : employees.length === 0 ? (
                  <Text tone="subdued" alignment="center">
                    No employees found for {location}.
                  </Text>
                ) : (
                  employees.map(emp => {
                    const exceeded = Number(emp.total_amount) >= Number(capAmount) - 50;
                    return (
                      <div key={emp.id} style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr 90px',
                        gap: '8px',
                        padding: '8px 0',
                        borderBottom: '1px solid #f1f1f1',
                        alignItems: 'start',
                        color: exceeded ? '#d72c0d' : 'inherit',
                      }}>
                        <div style={{ fontSize: '14px', fontWeight: '500', wordBreak: 'break-word' }}>
                          {emp.name}
                        </div>
                        <div style={{ fontSize: '13px', color: exceeded ? '#d72c0d' : '#6d7175', wordBreak: 'break-word' }}>
                          {emp.email || '—'}
                        </div>
                        <div style={{ fontSize: '14px', fontWeight: '600', textAlign: 'right' }}>
                          {formatCurrency(emp.total_amount)}
                        </div>
                      </div>
                    );
                  })
                )}
              </BlockStack>
            </Card>

            {season && (
              <Text variant="bodySm" tone="subdued" alignment="center">
                Season {season} · Cap ${capAmount} (before tax)
              </Text>
            )}

          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerEmployeeCap;