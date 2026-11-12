import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Button, Spinner, Banner, Select, TextField, DataTable,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { useLocationMap } from '../shared/locationMap';
import { Switch } from '../warehouse/supplyShared';

// Employee Discount card (2026-11-12, Hera — claude/EMPLOYEE_DISCOUNT.md):
// turns the Shopify automatic "Employee Discount" on / off, its rate and
// whether it combines with other discounts. The cap above is the discount's
// cap too. Every change is sent to Shopify at once (PUT /api/employees/discount).
const STATUS_LABEL = { ACTIVE: 'Active in Shopify', EXPIRED: 'Off in Shopify', SCHEDULED: 'Scheduled in Shopify' };
function EmployeeDiscountCard({ capAmount, onError }) {
  const [d, setD] = useState(null);          // GET /api/employees/discount
  const [rateInput, setRateInput] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetch('/api/employees/discount').then(r => r.json())
      .then(x => { setD(x); setRateInput(String(x.rate ?? 18)); })
      .catch(e => onError(e.message));
  }, [onError]);
  const save = async (change) => {
    setSaving(true);
    try {
      const res = await fetch('/api/employees/discount', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
      });
      const x = await res.json();
      if (!res.ok) throw new Error(x.error || 'Failed to save');
      setD(x);
      setRateInput(String(x.rate));
      if (x.error) onError(`Saved in Hub, but Shopify said: ${x.error}`);
    } catch (e) { onError(e.message); } finally { setSaving(false); }
  };
  if (!d) return <Card><Text tone="subdued">Loading...</Text></Card>;
  const statusText = d.shopifyStatus ? (STATUS_LABEL[d.shopifyStatus] || d.shopifyStatus) : 'Not created in Shopify yet';
  const rateChanged = rateInput !== '' && Number(rateInput) !== Number(d.rate);
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <Text variant="headingMd" as="h2">Employee Discount</Text>
          <Text variant="bodySm" tone="subdued">{statusText}</Text>
        </InlineStack>
        <Text variant="bodySm" tone="subdued">
          {`${d.rate}% off everything except gift cards for active employees (customer tag “employee”), online and in POS. Only the part of a purchase under the $${capAmount} season cap is discounted. In POS, add the employee as the customer of the sale.`}
        </Text>
        <InlineStack gap="600" blockAlign="center" wrap>
          <Switch on={d.enabled} disabled={saving} label={d.enabled ? 'On' : 'Off'} onChange={(on) => save({ enabled: on })} />
          <Switch on={d.combine} disabled={saving}
            label={d.combine ? 'Combines with other discounts' : 'Doesn’t combine with other discounts'}
            onChange={(on) => save({ combine: on })} />
          <InlineStack gap="200" blockAlign="center">
            <div style={{ width: 90 }}>
              <TextField label="Rate" labelHidden value={rateInput} onChange={setRateInput} type="number" suffix="%" autoComplete="off" />
            </div>
            <Button size="slim" disabled={!rateChanged || saving} onClick={() => save({ rate: Number(rateInput) })}>Save Rate</Button>
          </InlineStack>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// Branch list: comes from the shared location map (pages/shared/locationMap.js,
// 2026-09-24). The hardcoded 19-code BRANCHES constant that used to live here
// (the Branch filter's options, in its own OTT-before-EDM order) was removed;
// the filter now uses the shared canonical order (Hera OK'd the reorder).

function EmployeeCap() {
  const navigate = useNavigate();

  // ── settings state ────────────────────────────────────────────────────────
  const [capAmount,    setCapAmount]    = useState(600);
  // eslint-disable-next-line no-unused-vars -- kept; no longer shown (cap = before discount & tax, 2026-11-12)
  const [capTaxMode,   setCapTaxMode]   = useState('before_tax');
  const [editingCap,   setEditingCap]   = useState(false);
  const [capInput,     setCapInput]     = useState('');
  const [savingCap,    setSavingCap]    = useState(false);

  // ── relink state ─────────────────────────────────────────────────────────
  const [empCount,     setEmpCount]     = useState(null);
  const [relinking,    setRelinking]    = useState(false);
  const [relinkMsg,    setRelinkMsg]    = useState('');

  // ── tag-check state ───────────────────────────────────────────────────────
  const [tagChecking,  setTagChecking]  = useState(false);
  const [tagResults,   setTagResults]   = useState(null); // null = not run yet

  // ── employee list state ───────────────────────────────────────────────────
  const [employees,    setEmployees]    = useState([]);
  const [totalEmp,     setTotalEmp]     = useState(0);
  const [loadingEmp,   setLoadingEmp]   = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [lastRefreshed,setLastRefreshed]= useState(null);
  const [season,       setSeason]       = useState('current');
  const [filterBranch, setFilterBranch] = useState('ALL');
  const { names: branchNames } = useLocationMap();
  const [filterStatus, setFilterStatus] = useState('all');
  const [page,         setPage]         = useState(1);
  const [totalPages,   setTotalPages]   = useState(1);
  const [seasonLabel,  setSeasonLabel]  = useState('');

  const [error,        setError]        = useState('');
  const PER_PAGE = 50;

  // ── helpers ───────────────────────────────────────────────────────────────

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

  // ── load settings ─────────────────────────────────────────────────────────

  const loadSettings = useCallback(async () => {
    try {
      const res  = await fetch('/api/employees/settings');
      const data = await res.json();
      setCapAmount(data.cap_amount?.value ?? 600);
      setCapTaxMode(data.cap_tax_mode?.value ?? 'before_tax');
      setLastRefreshed(data.last_refresh_all?.refreshed_at || null);
    } catch (e) {
      console.error('loadSettings:', e);
    }
  }, []);

  // ── load employee count ───────────────────────────────────────────────────

  const loadCount = useCallback(async () => {
    try {
      const res  = await fetch('/api/employees/count');
      const data = await res.json();
      setEmpCount(data.count);
    } catch (e) {
      console.error('loadCount:', e);
    }
  }, []);

  // ── load employee list ────────────────────────────────────────────────────

  const loadEmployees = useCallback(async (pg = 1) => {
    setLoadingEmp(true);
    setError('');
    try {
      const params = new URLSearchParams({
        season:   season,
        branches: filterBranch,
        status:   filterStatus,
        page:     pg,
        per_page: PER_PAGE,
      });
      const res  = await fetch(`/api/employees?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');

      setEmployees(data.employees || []);
      setTotalEmp(data.total || 0);
      setTotalPages(Math.max(1, Math.ceil((data.total || 0) / PER_PAGE)));
      setCapAmount(data.cap_amount || 600);
      setSeasonLabel(data.season || '');
      setPage(pg);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingEmp(false);
    }
  }, [season, filterBranch, filterStatus]);

  useEffect(() => {
    loadSettings();
    loadCount();
  }, [loadSettings, loadCount]);

  useEffect(() => {
    loadEmployees(1);
  }, [loadEmployees]);

  // ── relink ────────────────────────────────────────────────────────────────

  const handleRelink = async () => {
    setRelinking(true);
    setRelinkMsg('');
    setError('');
    try {
      const res  = await fetch('/api/employees/relink', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Re-link failed');
      setRelinkMsg(`Re-link complete — ${data.updated} updated, ${data.skipped} unchanged, ${data.failed} failed.`);
      await loadEmployees(1);
    } catch (e) {
      setError(e.message);
    } finally {
      setRelinking(false);
    }
  };

  // ── cap edit ──────────────────────────────────────────────────────────────

  const handleEditCap = () => {
    setCapInput(String(capAmount));
    setEditingCap(true);
  };

  const handleSaveCap = async () => {
    const val = parseFloat(capInput);
    if (isNaN(val) || val <= 0) return;
    setSavingCap(true);
    try {
      const res = await fetch('/api/employees/settings', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cap_amount: val }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.warning) setError(data.warning); // cap not sent to the Shopify discount (2026-11-12)
      setCapAmount(val);
      setEditingCap(false);
      await loadEmployees(1);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingCap(false);
    }
  };

  // ── tag check ─────────────────────────────────────────────────────────────

  const handleTagCheck = async () => {
    setTagChecking(true);
    setTagResults(null);
    setError('');
    try {
      const res  = await fetch('/api/employees/tag-check', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Tag check failed');
      setTagResults(data.unexpected || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setTagChecking(false);
    }
  };

  const handleExportTagCheck = () => {
    if (!tagResults || tagResults.length === 0) return;
    const header = 'Customer ID,Name,Email';
    const rows   = tagResults.map(r =>
      `${r.shopify_customer_id},"${r.name}","${r.email}"`
    );
    const csv  = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'employee_tag_check.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── refresh purchases ─────────────────────────────────────────────────────

  const handleRefresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      const res  = await fetch('/api/employees/refresh', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ scope: 'all' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refresh failed');
      if (data.warning) setError(data.warning); // spend not sent to Shopify for the discount (2026-11-12)
      await Promise.all([loadSettings(), loadEmployees(page)]);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  // ── filter changes reset page ─────────────────────────────────────────────

  const handleSeasonChange = (val) => { setSeason(val); setPage(1); };
  const handleBranchChange = (val) => { setFilterBranch(val); setPage(1); };
  const handleStatusChange = (val) => { setFilterStatus(val); setPage(1); };

  // ── render ────────────────────────────────────────────────────────────────

  const seasonOptions = [
    { label: 'Current Season', value: 'current' },
    { label: 'Last Season',    value: 'last' },
  ];

  const branchOptions = [
    { label: 'ALL', value: 'ALL' },
    ...branchNames.map(b => ({ label: b, value: b })),
  ];

  const statusOptions = [
    { label: 'All', value: 'all' },
    { label: 'Exceeded Cap', value: 'exceeded' },
  ];

  return (
    <Page
      title="Employee Cap"
      backAction={{ onAction: () => navigate('/crm') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">

            {error && (
              <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>
            )}
            {relinkMsg && (
              <Banner tone="success" onDismiss={() => setRelinkMsg('')}>{relinkMsg}</Banner>
            )}

            {/* ── Card 1: Employee count + Re-link + Cap ── */}
            <Card>
              <InlineStack align="space-between" blockAlign="start" wrap={false}>

                {/* Left: total */}
                <BlockStack gap="100">
                  <Text variant="headingMd" fontWeight="bold">
                    Employee Total {empCount !== null ? empCount : '—'}
                  </Text>
                  <Text variant="bodySm" tone="subdued">Active employees</Text>
                </BlockStack>

                {/* Middle: re-link */}
                <BlockStack gap="100" inlineAlign="center">
                  <Button
                    onClick={handleRelink}
                    loading={relinking}
                    disabled={relinking}
                  >
                    Re-link
                  </Button>
                  <Text variant="bodySm" tone="subdued">
                    Run this for new employees, or if an employee's Shopify account has changed
                  </Text>
                </BlockStack>

                {/* Right: cap */}
                <BlockStack gap="100" inlineAlign="end">
                  {editingCap ? (
                    <InlineStack gap="200" blockAlign="center">
                      <div style={{ width: '90px' }}>
                        <TextField
                          value={capInput}
                          onChange={setCapInput}
                          type="number"
                          prefix="$"
                          autoComplete="off"
                          autoFocus
                        />
                      </div>
                      <Button
                        variant="primary"
                        size="slim"
                        loading={savingCap}
                        onClick={handleSaveCap}
                      >
                        Save
                      </Button>
                      <Button size="slim" onClick={() => setEditingCap(false)}>
                        Cancel
                      </Button>
                    </InlineStack>
                  ) : (
                    <InlineStack gap="200" blockAlign="center">
                      <BlockStack gap="050">
                        <Text variant="headingMd" fontWeight="bold">
                          Cap ${capAmount}
                        </Text>
                        {/* 2026-11-12 (Hera): the cap counts the price before
                            discounts and tax, gift cards excluded — the
                            Before / After tax setting is no longer used. */}
                        <Text variant="bodySm" tone="subdued">
                          Before discount &amp; tax · gift cards excluded
                        </Text>
                      </BlockStack>
                      <Button size="slim" onClick={handleEditCap}>Edit</Button>
                    </InlineStack>
                  )}
                </BlockStack>

              </InlineStack>
            </Card>

            {/* ── Employee Discount (2026-11-12) ── */}
            <EmployeeDiscountCard capAmount={capAmount} onError={setError} />

            {/* ── Card 2: Tag Check ── */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Button
                    onClick={handleTagCheck}
                    loading={tagChecking}
                    disabled={tagChecking}
                  >
                    Tag Check
                  </Button>
                  {tagResults !== null && tagResults.length > 0 && (
                    <Button onClick={handleExportTagCheck} size="slim">Export CSV</Button>
                  )}
                </InlineStack>

                {tagChecking && (
                  <InlineStack gap="200" blockAlign="center">
                    <Spinner size="small" />
                    <Text tone="subdued">Checking Shopify customers…</Text>
                  </InlineStack>
                )}

                {!tagChecking && tagResults !== null && (
                  tagResults.length === 0 ? (
                    <Text tone="subdued">No unexpected tagged customers found.</Text>
                  ) : (
                    <BlockStack gap="200">
                      <Text variant="bodySm" tone="subdued">
                        {tagResults.length} customer{tagResults.length !== 1 ? 's' : ''} tagged "employee" but not in active employee list:
                      </Text>
                      {/* Header */}
                      <div style={{
                        display: 'grid', gridTemplateColumns: '140px 1fr 1fr',
                        gap: '8px', fontSize: '12px', fontWeight: '600',
                        color: '#6d7175', paddingBottom: '6px',
                        borderBottom: '1px solid #e1e3e5',
                      }}>
                        <span>Customer ID</span>
                        <span>Name</span>
                        <span>Email</span>
                      </div>
                      {tagResults.map(r => (
                        <div key={r.shopify_customer_id} style={{
                          display: 'grid', gridTemplateColumns: '140px 1fr 1fr',
                          gap: '8px', fontSize: '13px', padding: '6px 0',
                          borderBottom: '1px solid #f1f1f1',
                        }}>
                          <span style={{ color: '#6d7175' }}>{r.shopify_customer_id}</span>
                          <span>{r.name || '—'}</span>
                          <span style={{ color: '#6d7175', wordBreak: 'break-all' }}>{r.email || '—'}</span>
                        </div>
                      ))}
                    </BlockStack>
                  )
                )}
              </BlockStack>
            </Card>

            {/* ── Card 3: Employee List ── */}
            <Card>
              <BlockStack gap="400">

                {/* Filters + Refresh */}
                <BlockStack gap="300">
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr auto',
                    gap: '12px', alignItems: 'end',
                  }}>
                    <Select
                      label="Season"
                      options={seasonOptions}
                      value={season}
                      onChange={handleSeasonChange}
                    />
                    <Select
                      label="Branch"
                      options={branchOptions}
                      value={filterBranch}
                      onChange={handleBranchChange}
                    />
                    <Select
                      label="Cap Status"
                      options={statusOptions}
                      value={filterStatus}
                      onChange={handleStatusChange}
                    />
                    <BlockStack gap="100" inlineAlign="end">
                      <Button
                        onClick={handleRefresh}
                        loading={refreshing}
                        disabled={refreshing}
                      >
                        Refresh
                      </Button>
                      {lastRefreshed && (
                        <Text variant="bodySm" tone="subdued">
                          {formatDate(lastRefreshed)}
                        </Text>
                      )}
                    </BlockStack>
                  </div>
                </BlockStack>

                {/* List header */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 100px 1fr 110px',
                  gap: '8px', fontSize: '12px', fontWeight: '600',
                  color: '#6d7175', paddingBottom: '8px',
                  borderBottom: '1px solid #e1e3e5',
                }}>
                  <span>Name</span>
                  <span>Branch</span>
                  <span>Email</span>
                  <span style={{ textAlign: 'right' }}>Total Purchase</span>
                </div>

                {/* List rows */}
                {loadingEmp ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : employees.length === 0 ? (
                  <Text tone="subdued" alignment="center">No employees found.</Text>
                ) : (
                  <BlockStack gap="0">
                    {employees.map(emp => {
                      const exceeded = Number(emp.total_amount) > Number(capAmount);
                      const color    = exceeded ? '#d72c0d' : 'inherit';
                      return (
                        <div key={emp.id} style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 100px 1fr 110px',
                          gap: '8px', padding: '10px 0',
                          borderBottom: '1px solid #f1f1f1',
                          alignItems: 'start', color,
                        }}>
                          <div style={{ fontSize: '14px', fontWeight: '500', wordBreak: 'break-word' }}>
                            {emp.name}
                          </div>
                          <div style={{ fontSize: '13px', color: exceeded ? '#d72c0d' : '#6d7175' }}>
                            {(emp.branches || []).join(', ') || '—'}
                          </div>
                          <div style={{ fontSize: '13px', color: exceeded ? '#d72c0d' : '#6d7175', wordBreak: 'break-word' }}>
                            {emp.email || '—'}
                          </div>
                          <div style={{ fontSize: '14px', fontWeight: '600', textAlign: 'right' }}>
                            {formatCurrency(emp.total_amount)}
                          </div>
                        </div>
                      );
                    })}
                  </BlockStack>
                )}

                {/* Pagination */}
                {totalPages > 1 && (
                  <InlineStack align="center" gap="300">
                    <button
                      disabled={page <= 1}
                      onClick={() => loadEmployees(page - 1)}
                      style={{
                        padding: '6px 14px', borderRadius: '6px',
                        border: '1px solid #c9cccf', background: 'white',
                        cursor: page <= 1 ? 'not-allowed' : 'pointer',
                        color: page <= 1 ? '#c9cccf' : '#202223',
                        fontSize: '14px',
                      }}
                    >← Prev</button>
                    <Text variant="bodySm" tone="subdued">
                      Page {page} of {totalPages} · {totalEmp} total
                    </Text>
                    <button
                      disabled={page >= totalPages}
                      onClick={() => loadEmployees(page + 1)}
                      style={{
                        padding: '6px 14px', borderRadius: '6px',
                        border: '1px solid #c9cccf', background: 'white',
                        cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                        color: page >= totalPages ? '#c9cccf' : '#202223',
                        fontSize: '14px',
                      }}
                    >Next →</button>
                  </InlineStack>
                )}

                {seasonLabel && (
                  <Text variant="bodySm" tone="subdued" alignment="center">
                    Season {seasonLabel}
                  </Text>
                )}

              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default EmployeeCap;