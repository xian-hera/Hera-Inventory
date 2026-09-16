import React, { useState } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, Banner, DropZone
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';

// ═══════════════════════════════════════════════════════════════════════
// TEMP TOOL — CSV bulk-cancel-test tool for Buyer.
// 见 claude/TRANSFER_FEATURE_SPEC.md 第 14 节 for the research/rationale.
//
// This whole feature is intentionally self-contained and disposable. To
// remove it later, delete:
//   1. This file (client/src/pages/buyer/CsvCancelTestTool.js)
//   2. The "TEMP TOOL" button block in client/src/pages/buyer/BuyerTransfer.js
//   3. The "/buyer/transfer/csv-cancel-test" route in client/src/App.js
//   4. The "TEMP TOOL" block in server/routes/transfers.js (the
//      zeroShipmentLineItems/testCancelOne helpers and the
//      POST /csv-cancel-test route)
//
// What it does: reads a CSV with a single column of Shopify transfer
// names (e.g. "T4955"), and for each one, asks the backend to attempt a
// real (not dry-run) sequence against Shopify: find the transfer by exact
// name match, verify it's IN_PROGRESS, zero out its shipment line items
// (cancelling them, restoring inventory to the origin location), verify
// the transfer flipped to READY_TO_SHIP, then call inventoryTransferCancel.
// Every step's outcome is recorded and shown per-row, even on failure —
// nothing here throws away partial results.
// ═══════════════════════════════════════════════════════════════════════

function ResultBadgeText({ ok, label }) {
  if (ok === true) return <Text tone="success" as="span">{label || 'OK'}</Text>;
  if (ok === false) return <Text tone="critical" as="span">{label || 'Failed'}</Text>;
  return <Text tone="subdued" as="span">{label || '—'}</Text>;
}

function CsvCancelTestTool() {
  const navigate = useNavigate();
  const [fileName, setFileName] = useState('');
  const [transferNumbers, setTransferNumbers] = useState([]);
  const [parseError, setParseError] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [results, setResults] = useState([]);

  const handleDrop = (_dropFiles, acceptedFiles) => {
    setParseError('');
    setResults([]);
    setRunError('');
    const file = acceptedFiles && acceptedFiles[0];
    if (!file) return;
    setFileName(file.name);
    Papa.parse(file, {
      complete: (parsed) => {
        try {
          const rows = parsed.data || [];
          const names = rows
            .map(row => (Array.isArray(row) ? row[0] : row))
            .map(v => (v == null ? '' : String(v).trim()))
            .filter(v => v.length > 0)
            .filter(v => v.toLowerCase() !== 'transfer number' && v.toLowerCase() !== 'shopify transfer number');
          const deduped = Array.from(new Set(names));
          if (deduped.length === 0) {
            setParseError('No transfer numbers found in this CSV.');
            setTransferNumbers([]);
          } else {
            setTransferNumbers(deduped);
          }
        } catch (e) {
          setParseError('Could not parse this CSV: ' + e.message);
          setTransferNumbers([]);
        }
      },
      error: (err) => {
        setParseError('Could not parse this CSV: ' + err.message);
        setTransferNumbers([]);
      },
    });
  };

  const runTest = async () => {
    if (transferNumbers.length === 0) return;
    if (!window.confirm(
      `This will attempt to REALLY cancel ${transferNumbers.length} transfer(s) on Shopify ` +
      `(zero their shipments and restore inventory to origin), not a dry run. Continue?`
    )) return;
    setRunning(true);
    setRunError('');
    setResults([]);
    try {
      const res = await fetch('/api/transfers/csv-cancel-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferNumbers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setResults(Array.isArray(data.results) ? data.results : []);
    } catch (e) {
      setRunError(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Page
      title="CSV Cancel Test (Temp Tool)"
      backAction={{ onAction: () => navigate('/buyer/transfer') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="warning">
              This is a temporary, experimental tool. It performs REAL, irreversible actions
              against Shopify (not a dry run) — only run it against transfer numbers you intend
              to cancel and restore inventory for.
            </Banner>

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h2">1. Upload CSV</Text>
                <Text tone="subdued" as="p">
                  Single column, one Shopify transfer name per row (e.g. T4955). A header row is
                  fine — it will be skipped if it reads as text like "transfer number".
                </Text>
                <DropZone accept=".csv,text/csv" type="file" onDrop={handleDrop} allowMultiple={false}>
                  {fileName ? (
                    <InlineStack gap="200" blockAlign="center" padding="400">
                      <Text as="span">📄 {fileName}</Text>
                    </InlineStack>
                  ) : (
                    <DropZone.FileUpload actionTitle="Add CSV file" actionHint="or drop a .csv file here" />
                  )}
                </DropZone>
                {parseError && <Banner tone="critical">{parseError}</Banner>}
                {transferNumbers.length > 0 && !parseError && (
                  <Text as="p">
                    Parsed {transferNumbers.length} transfer number(s): {transferNumbers.join(', ')}
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h2">2. Run</Text>
                {runError && <Banner tone="critical">{runError}</Banner>}
                <InlineStack>
                  <Button
                    variant="primary"
                    tone="critical"
                    disabled={transferNumbers.length === 0}
                    loading={running}
                    onClick={runTest}
                  >
                    Run Cancel Test ({transferNumbers.length})
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {results.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h2">3. Results</Text>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Found</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Original Status</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Zero Step</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Status After Zero</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Cancel Step</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Final Status</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r, idx) => (
                          <tr key={r.name + idx} style={{ borderBottom: '1px solid #f1f1f1' }}>
                            <td style={{ padding: '8px 10px', fontWeight: 600 }}>{r.name}</td>
                            <td style={{ padding: '8px 10px' }}><ResultBadgeText ok={r.found} label={r.found ? 'Yes' : 'No'} /></td>
                            <td style={{ padding: '8px 10px' }}>{r.originalStatus || '—'}</td>
                            <td style={{ padding: '8px 10px' }}><ResultBadgeText ok={r.zeroStep && r.zeroStep.ok} label={r.zeroStep ? (r.zeroStep.ok ? 'OK' : 'Failed') : '—'} /></td>
                            <td style={{ padding: '8px 10px' }}>{r.statusAfterZero || '—'}</td>
                            <td style={{ padding: '8px 10px' }}><ResultBadgeText ok={r.cancelStep && r.cancelStep.ok} label={r.cancelStep ? (r.cancelStep.ok ? 'OK' : 'Failed') : '—'} /></td>
                            <td style={{ padding: '8px 10px' }}>{r.finalStatus || '—'}</td>
                            <td style={{ padding: '8px 10px', color: '#8c1a1a' }}>{r.error || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default CsvCancelTestTool;
