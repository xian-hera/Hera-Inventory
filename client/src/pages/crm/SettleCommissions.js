import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Button, TextField,
  Text, Spinner, Banner, Modal, DataTable, Divider,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function SettleCommissions() {
  const navigate = useNavigate();

  // Commission rate
  const [rate, setRate]               = useState(null);   // saved rate (number or null)
  const [rateInput, setRateInput]     = useState('');     // text field value
  const [editingRate, setEditingRate] = useState(false);  // showing edit field
  const [savingRate, setSavingRate]   = useState(false);
  const [rateError, setRateError]     = useState('');
  const [rateLoading, setRateLoading] = useState(true);

  // Summary stats (hairdressers with ≥1 customer)
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [activeHairdressers, setActiveHairdressers] = useState(0);
  const [totalBoundCustomers, setTotalBoundCustomers] = useState(0);

  // Calculate
  const [dateFrom, setDateFrom]         = useState('');
  const [calculating, setCalculating]   = useState(false);
  const [calcError, setCalcError]       = useState('');
  const [calcResults, setCalcResults]   = useState(null); // array | null

  // Pay
  const [paying, setPaying]             = useState(false);
  const [payError, setPayError]         = useState('');
  const [payResult, setPayResult]       = useState(null); // { hairdresser_count, total_revenue, total_paid }
  const [showPayModal, setShowPayModal] = useState(false);

  // History
  const [history, setHistory]               = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  // History export — items for a specific payout
  const [exportingId, setExportingId] = useState(null);

  // ── Load commission rate ──────────────────────────────────────────────────
  const fetchRate = useCallback(async () => {
    setRateLoading(true);
    try {
      const res = await fetch('/api/hairdressers/commission/settings');
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data.rate != null) {
        setRate(parseFloat(data.rate));
        setRateInput(String(parseFloat(data.rate)));
      } else {
        setRate(null);
        setEditingRate(true); // no rate set yet — open edit field immediately
      }
    } catch (e) {
      setRate(null);
      setEditingRate(true);
    } finally {
      setRateLoading(false);
    }
  }, []);

  // ── Load summary stats ────────────────────────────────────────────────────
  const fetchSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await fetch('/api/hairdressers');
      if (!res.ok) throw new Error();
      const data = await res.json();
      const active = data.filter(h => (h.bound_customers ?? 0) >= 1);
      setActiveHairdressers(active.length);
      setTotalBoundCustomers(active.reduce((sum, h) => sum + (h.bound_customers ?? 0), 0));
    } catch (e) {
      // non-blocking
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRate();
    fetchSummary();
  }, [fetchRate, fetchSummary]);

  // ── Save commission rate ──────────────────────────────────────────────────
  const handleSaveRate = async () => {
    const parsed = parseFloat(rateInput);
    if (isNaN(parsed) || parsed < 0 || parsed > 100) {
      setRateError('Please enter a valid percentage between 0 and 100.');
      return;
    }
    setSavingRate(true);
    setRateError('');
    try {
      const res = await fetch('/api/hairdressers/commission/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate: parsed }),
      });
      if (!res.ok) throw new Error('Failed to save rate');
      const data = await res.json();
      setRate(parseFloat(data.rate));
      setRateInput(String(parseFloat(data.rate)));
      setEditingRate(false);
    } catch (e) {
      setRateError(e.message);
    } finally {
      setSavingRate(false);
    }
  };

  // ── Calculate ─────────────────────────────────────────────────────────────
  const handleCalculate = async () => {
    if (!dateFrom) { setCalcError('Please select a start date.'); return; }
    setCalculating(true);
    setCalcError('');
    setCalcResults(null);
    setPayError('');
    setPayResult(null);
    try {
      const res = await fetch('/api/hairdressers/commission/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date_from: dateFrom }),
      });
      if (!res.ok) throw new Error('Calculation failed');
      const data = await res.json();
      setCalcResults(data);
    } catch (e) {
      setCalcError(e.message);
    } finally {
      setCalculating(false);
    }
  };

  // ── Pay commissions ───────────────────────────────────────────────────────
  const handlePay = async () => {
    if (!calcResults || calcResults.length === 0) return;
    setPaying(true);
    setPayError('');
    try {
      const res = await fetch('/api/hairdressers/commission/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date_from: dateFrom, results: calcResults }),
      });
      if (!res.ok) throw new Error('Payment failed');
      const data = await res.json();
      setPayResult(data);
      setShowPayModal(true);
      // Reset calc results after paying so Pay Commission button greys out again
      setCalcResults(null);
      setDateFrom('');
    } catch (e) {
      setPayError(e.message);
    } finally {
      setPaying(false);
    }
  };

  // ── Load history ──────────────────────────────────────────────────────────
  const handleOpenHistory = async () => {
    setHistoryLoading(true);
    setShowHistoryModal(true);
    try {
      const res = await fetch('/api/hairdressers/commission/history');
      if (!res.ok) throw new Error();
      setHistory(await res.json());
    } catch (e) {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  // ── Export CSV for a payout ───────────────────────────────────────────────
  const handleExport = async (payout) => {
    setExportingId(payout.id);
    try {
      const res = await fetch(`/api/hairdressers/commission/history/${payout.id}/items`);
      if (!res.ok) throw new Error();
      const items = await res.json();

      const headers = ['Name', 'Email', 'From', 'To', 'Revenue', 'Commission'];
      const rows = items.map(item => [
        item.hairdresser_name,
        item.hairdresser_email || '',
        formatDateSimple(payout.date_from),
        formatDateSimple(payout.date_to),
        Number(item.revenue).toFixed(2),
        Number(item.commission).toFixed(2),
      ]);

      const csvContent = [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `commission-${formatDateSimple(payout.paid_at)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      // non-blocking
    } finally {
      setExportingId(null);
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const formatDateSimple = (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  };

  const formatCurrency = (val) => {
    if (val == null) return '—';
    return `$${Number(val).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  // Pay Commission is only enabled when all results are calculated (array with ≥1 entry)
  const canPay = Array.isArray(calcResults) && calcResults.length > 0 && rate != null;

  return (
    <Page
      title="Settle Commissions"
      backAction={{ onAction: () => navigate('/crm/hairdressers') }}
    >
      <Layout>

        {/* ── Card 1: Summary + Commission Rate ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="start">

                {/* Left: summary stats */}
                <BlockStack gap="200">
                  <Text variant="headingSm" as="h2">Overview</Text>
                  {summaryLoading ? (
                    <Spinner size="small" />
                  ) : (
                    <BlockStack gap="100">
                      <Text variant="bodyMd">
                        <Text as="span" fontWeight="semibold">{activeHairdressers}</Text>
                        {' '}hairdresser{activeHairdressers !== 1 ? 's' : ''} with at least 1 bound customer
                      </Text>
                      <Text variant="bodyMd">
                        <Text as="span" fontWeight="semibold">{totalBoundCustomers}</Text>
                        {' '}total bound customer{totalBoundCustomers !== 1 ? 's' : ''}
                      </Text>
                    </BlockStack>
                  )}
                </BlockStack>

                {/* Right: commission rate */}
                <BlockStack gap="200" align="end">
                  <Text variant="headingSm" as="h2">Commission Rate</Text>
                  {rateLoading ? (
                    <Spinner size="small" />
                  ) : editingRate ? (
                    <BlockStack gap="200">
                      {rateError && (
                        <Banner tone="critical" onDismiss={() => setRateError('')}>
                          {rateError}
                        </Banner>
                      )}
                      <InlineStack gap="200" blockAlign="center">
                        <div style={{ width: '120px' }}>
                          <TextField
                            label=""
                            labelHidden
                            type="number"
                            value={rateInput}
                            onChange={(val) => { setRateInput(val); setRateError(''); }}
                            suffix="%"
                            min="0"
                            max="100"
                            autoComplete="off"
                          />
                        </div>
                        <Button
                          onClick={handleSaveRate}
                          loading={savingRate}
                          disabled={!rateInput.trim()}
                        >
                          Save
                        </Button>
                        {rate != null && (
                          <Button
                            onClick={() => { setEditingRate(false); setRateInput(String(rate)); setRateError(''); }}
                          >
                            Cancel
                          </Button>
                        )}
                      </InlineStack>
                    </BlockStack>
                  ) : (
                    <InlineStack gap="300" blockAlign="center">
                      <Text variant="headingMd">Current Commission Rate: {rate}%</Text>
                      <Button size="slim" onClick={() => setEditingRate(true)}>Edit</Button>
                    </InlineStack>
                  )}
                </BlockStack>

              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Card 2: Date selection ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingSm" as="h2">Calculation Period</Text>
              <InlineStack gap="300" blockAlign="end">
                <div style={{ flex: 1, maxWidth: '240px' }}>
                  <TextField
                    label="Start date"
                    type="date"
                    value={dateFrom}
                    onChange={(val) => { setDateFrom(val); setCalcError(''); }}
                    autoComplete="off"
                  />
                </div>
                <Button
                  onClick={handleCalculate}
                  loading={calculating}
                  disabled={!dateFrom || rate == null}
                >
                  Calculate
                </Button>
              </InlineStack>
              {rate == null && !rateLoading && (
                <Text tone="subdued" variant="bodySm">
                  Please set a commission rate before calculating.
                </Text>
              )}
              {calcError && (
                <Banner tone="critical" onDismiss={() => setCalcError('')}>
                  {calcError}
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Card 3: Results list ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingSm" as="h2">Hairdressers</Text>
                <InlineStack gap="200">
                  <Button
                    tone="success"
                    disabled={!canPay}
                    loading={paying}
                    onClick={handlePay}
                  >
                    Pay Commission
                  </Button>
                  <Button onClick={handleOpenHistory}>
                    History
                  </Button>
                </InlineStack>
              </InlineStack>

              {payError && (
                <Banner tone="critical" onDismiss={() => setPayError('')}>
                  {payError}
                </Banner>
              )}

              {summaryLoading ? (
                <InlineStack align="center"><Spinner size="small" /></InlineStack>
              ) : activeHairdressers === 0 ? (
                <Text tone="subdued" variant="bodySm">
                  No hairdressers with bound customers yet.
                </Text>
              ) : !Array.isArray(calcResults) ? (
                <Text tone="subdued" variant="bodySm">
                  Select a start date and click Calculate to see revenue figures.
                </Text>
              ) : calcResults.length === 0 ? (
                <Text tone="subdued" variant="bodySm">
                  No hairdressers with active bound customers found.
                </Text>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text', 'numeric', 'numeric']}
                  headings={['Name', 'Email', 'Phone', 'Customers', 'Revenue']}
                  rows={calcResults.map((r) => [
                    <Text fontWeight="semibold">{r.name}</Text>,
                    <Text tone="subdued">{r.email || '—'}</Text>,
                    <Text tone="subdued">{r.phone || '—'}</Text>,
                    <Text>{r.customer_count ?? 0}</Text>,
                    <Text>{formatCurrency(r.revenue)}</Text>,
                  ])}
                />
              )}

              {Array.isArray(calcResults) && calcResults.length > 0 && (
                <>
                  <Divider />
                  <InlineStack align="end" gap="400">
                    <Text tone="subdued" variant="bodySm">
                      Period: {formatDateSimple(dateFrom)} → today
                    </Text>
                    <Text variant="bodyMd">
                      Total Revenue:{' '}
                      <Text as="span" fontWeight="semibold">
                        {formatCurrency(calcResults.reduce((s, r) => s + (r.revenue || 0), 0))}
                      </Text>
                    </Text>
                    {rate != null && (
                      <Text variant="bodyMd">
                        Est. Commission ({rate}%):{' '}
                        <Text as="span" fontWeight="semibold">
                          {formatCurrency(
                            calcResults.reduce((s, r) => s + (r.revenue || 0), 0) * (rate / 100)
                          )}
                        </Text>
                      </Text>
                    )}
                  </InlineStack>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>

      {/* ── Pay confirmation / result modal ── */}
      <Modal
        open={showPayModal}
        onClose={() => setShowPayModal(false)}
        title="Commission Paid"
        primaryAction={{ content: 'Done', onAction: () => setShowPayModal(false) }}
      >
        <Modal.Section>
          {payResult && (
            <BlockStack gap="300">
              <Banner tone="success">
                Store credit issued successfully.
              </Banner>
              <Text>
                Issued store credit to{' '}
                <Text as="span" fontWeight="semibold">{payResult.hairdresser_count}</Text>
                {' '}hairdresser{payResult.hairdresser_count !== 1 ? 's' : ''}.
              </Text>
              <Text>
                Total revenue covered:{' '}
                <Text as="span" fontWeight="semibold">{formatCurrency(payResult.total_revenue)}</Text>
              </Text>
              <Text>
                Total store credit issued:{' '}
                <Text as="span" fontWeight="semibold">{formatCurrency(payResult.total_paid)}</Text>
              </Text>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>

      {/* ── History modal ── */}
      <Modal
        open={showHistoryModal}
        onClose={() => setShowHistoryModal(false)}
        title="Commission Payment History"
        primaryAction={{ content: 'Close', onAction: () => setShowHistoryModal(false) }}
        large
      >
        <Modal.Section>
          {historyLoading ? (
            <InlineStack align="center"><Spinner size="small" /></InlineStack>
          ) : history.length === 0 ? (
            <Text tone="subdued" variant="bodySm">No commission payments recorded yet.</Text>
          ) : (
            <DataTable
              columnContentTypes={['text', 'numeric', 'numeric', 'numeric', 'text']}
              headings={['Date', 'Hairdressers', 'Total Revenue', 'Paid', 'Export']}
              rows={history.map((p) => [
                <Text>{formatDateSimple(p.paid_at)}</Text>,
                <Text>{p.hairdresser_count}</Text>,
                <Text>{formatCurrency(p.total_revenue)}</Text>,
                <Text>{formatCurrency(p.total_paid)}</Text>,
                <Button
                  size="slim"
                  loading={exportingId === p.id}
                  onClick={() => handleExport(p)}
                >
                  Export
                </Button>,
              ])}
            />
          )}
        </Modal.Section>
      </Modal>

    </Page>
  );
}

export default SettleCommissions;