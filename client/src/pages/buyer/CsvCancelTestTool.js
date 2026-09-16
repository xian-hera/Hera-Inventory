import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, Banner, TextField
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

// ═══════════════════════════════════════════════════════════════════════
// TEMP TOOL — Wig Cancel Test (two-step bulk InventoryTransfer cancel by
// tag). 见 claude/TRANSFER_FEATURE_SPEC.md 第 14 节 for the research and the
// empirical finding that reshaped this into a two-step tool.
//
// This whole feature is intentionally self-contained and disposable. To
// remove it later, delete:
//   1. This file (client/src/pages/buyer/CsvCancelTestTool.js)
//   2. The "TEMP TOOL" button block in client/src/pages/buyer/BuyerTransfer.js
//   3. The "/buyer/transfer/csv-cancel-test" route in client/src/App.js
//   4. The "TEMP TOOL" block in server/routes/transfers.js (do NOT delete
//      the inventoryShipmentUpdateItemQuantities argument-shape fixes next
//      to it — those are unrelated production bug fixes, see spec doc)
//
// What it does, given a Shopify tag (e.g. "wig"):
//   Step 1 ("Cancel Progress"): finds every IN_PROGRESS transfer carrying
//     that tag and removes every pending line item from each of its
//     shipments — this is what flips a transfer back to Ready to ship.
//   Step 2 ("Cancel Transfer"): finds every READY_TO_SHIP transfer
//     carrying that tag and cancels it, restoring inventory to origin.
// Both steps run as background jobs on the server (could be hundreds of
// transfers, each needing several sequential Shopify calls) — this page
// polls a status endpoint every 2s rather than holding one long request
// open.
// ═══════════════════════════════════════════════════════════════════════

const POLL_MS = 2000;

function StepStatusText({ ok, label }) {
  if (ok === true) return <Text tone="success" as="span">{label || 'OK'}</Text>;
  if (ok === false) return <Text tone="critical" as="span">{label || 'Failed'}</Text>;
  return <Text tone="subdued" as="span">{label || '—'}</Text>;
}

function isStepOk(stepText) {
  if (typeof stepText !== 'string') return null;
  if (stepText === 'ok') return true;
  if (stepText.startsWith('failed')) return false;
  return null; // skipped / no-op / informational — not a pass/fail
}

function StepJobCard({ title, description, tag, onRun, job, running, resultsColumns }) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingSm" as="h2">{title}</Text>
        <Text tone="subdued" as="p">{description}</Text>
        <InlineStack>
          <Button variant="primary" tone="critical" disabled={!tag || running} loading={running} onClick={onRun}>
            {title}
          </Button>
        </InlineStack>
        {job && (
          <BlockStack gap="200">
            {job.running && (
              <Text as="p">
                Running for tag "{job.tag}"
                {job.total != null ? ` — ${job.processed} / ${job.total} processed` : ' — finding matching transfers...'}
              </Text>
            )}
            {!job.running && job.finishedAt && (
              <Text as="p" tone="subdued">
                Finished for tag "{job.tag}" — {job.processed}{job.total != null ? ` / ${job.total}` : ''} processed
              </Text>
            )}
            {job.error && <Banner tone="critical">{job.error}</Banner>}
            {job.results && job.results.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                      <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Original Status</th>
                      {resultsColumns.map(col => (
                        <th key={col.key} style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{col.label}</th>
                      ))}
                      <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.results.map((r, idx) => (
                      <tr key={(r.id || r.name) + idx} style={{ borderBottom: '1px solid #f1f1f1' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 600 }}>{r.name}</td>
                        <td style={{ padding: '8px 10px' }}>{r.originalStatus || '—'}</td>
                        {resultsColumns.map(col => (
                          <td key={col.key} style={{ padding: '8px 10px' }}>
                            {col.key === 'removeStep' || col.key === 'cancelStep' ? (
                              <StepStatusText ok={isStepOk(r[col.key])} label={r[col.key] || '—'} />
                            ) : (
                              r[col.key] != null ? String(r[col.key]) : '—'
                            )}
                          </td>
                        ))}
                        <td style={{ padding: '8px 10px', color: '#8c1a1a' }}>{r.error || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

function CsvCancelTestTool() {
  const navigate = useNavigate();
  const [tag, setTag] = useState('');
  const [step1Job, setStep1Job] = useState(null);
  const [step2Job, setStep2Job] = useState(null);
  const [startError, setStartError] = useState('');
  const pollRef = useRef(null);

  const pollBoth = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/transfers/wig-cancel/step1/status').then(r => r.json()).catch(() => null),
        fetch('/api/transfers/wig-cancel/step2/status').then(r => r.json()).catch(() => null),
      ]);
      if (r1) setStep1Job(r1);
      if (r2) setStep2Job(r2);
    } catch (e) {
      // ignore transient poll errors — next tick will retry
    }
  }, []);

  useEffect(() => {
    pollBoth();
    pollRef.current = setInterval(pollBoth, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [pollBoth]);

  const runStep = async (step) => {
    if (!tag.trim()) return;
    const label = step === 1 ? 'Step 1 (Cancel Progress)' : 'Step 2 (Cancel Transfer)';
    const warning = step === 1
      ? `This will REALLY remove shipment items from every IN_PROGRESS transfer tagged "${tag.trim()}" on Shopify — not a dry run. Continue?`
      : `This will REALLY cancel every READY_TO_SHIP transfer tagged "${tag.trim()}" on Shopify — not a dry run. Continue?`;
    if (!window.confirm(warning)) return;
    setStartError('');
    try {
      const res = await fetch(`/api/transfers/wig-cancel/step${step}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tag.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${label} failed to start`);
      pollBoth();
    } catch (e) {
      setStartError(e.message);
    }
  };

  return (
    <Page
      title="Wig Cancel Test (Temp Tool)"
      backAction={{ onAction: () => navigate('/buyer/transfer') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="warning">
              This is a temporary, experimental tool. Both steps below perform REAL, irreversible
              actions against Shopify (not a dry run) — only run them against a tag you intend to
              fully cancel.
            </Banner>

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h2">Tag</Text>
                <Text tone="subdued" as="p">
                  The Shopify tag both steps below search for (case-insensitive), e.g. "wig".
                </Text>
                <TextField
                  label="Tag"
                  labelHidden
                  value={tag}
                  onChange={setTag}
                  autoComplete="off"
                  placeholder="wig"
                />
                {startError && <Banner tone="critical">{startError}</Banner>}
              </BlockStack>
            </Card>

            <StepJobCard
              title="Cancel Progress"
              description={'Step 1 — finds every IN_PROGRESS transfer with this tag and removes every pending line item from its shipment(s), which flips it back to Ready to ship.'}
              tag={tag.trim()}
              onRun={() => runStep(1)}
              job={step1Job}
              running={!!(step1Job && step1Job.running)}
              resultsColumns={[
                { key: 'removeStep', label: 'Remove Step' },
                { key: 'statusAfter', label: 'Status After' },
              ]}
            />

            <StepJobCard
              title="Cancel Transfer"
              description={'Step 2 — finds every READY_TO_SHIP transfer with this tag and cancels it, restoring inventory to the origin location. Run this after Step 1 has finished and you have confirmed the transfers are Ready to ship.'}
              tag={tag.trim()}
              onRun={() => runStep(2)}
              job={step2Job}
              running={!!(step2Job && step2Job.running)}
              resultsColumns={[
                { key: 'cancelStep', label: 'Cancel Step' },
                { key: 'finalStatus', label: 'Final Status' },
              ]}
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default CsvCancelTestTool;
