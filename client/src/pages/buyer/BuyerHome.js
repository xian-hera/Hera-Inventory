import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Button, BlockStack, Banner,
  ButtonGroup, Popover, Tooltip, Modal, TextField, InlineStack, Divider, Text, Box,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const BADGE_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '20px',
  height: '20px',
  padding: '0 6px',
  borderRadius: '10px',
  background: '#E32A69',
  color: 'white',
  fontSize: '12px',
  fontWeight: '700',
  marginLeft: '8px',
  lineHeight: 1,
};

function Badge({ count }) {
  if (!count) return null;
  return <span style={BADGE_STYLE}>{count}</span>;
}

function ExclamationBadge() {
  return <span style={BADGE_STYLE}>!</span>;
}

// Add New Arrival (2026-09-29, Hera): for products made by hand in Shopify.
// Enter one SKU (or barcode) → Hub adds the product to Online → New products
// (POS only = false) or Store → New Arrival (POS only = true). The modal
// stays open so several SKUs can be added in a row; results are listed.
// 2026-10-08 (Hera): an explanation line on top, the box takes a SKU or a
// Name (placeholder, no label) — Name removed again the same day, SKU only
// (Hera 2026-10-08) —, the whole product is added (see the server
// route), and the result of the last Add shows right under the box.
function AddNewArrivalModal({ open, onClose }) {
  const [sku, setSku] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]); // [{ sku, message, error }]
  const [feedback, setFeedback] = useState(null); // { tone, text } of the last Add

  useEffect(() => { if (!open) { setSku(''); setResults([]); setFeedback(null); } }, [open]);

  const add = async () => {
    const code = sku.trim();
    if (!code || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/import-products/add-new-arrival', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, sku: code }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not add');
      setResults(r => [{ sku: code, message: d.message, title: d.title }, ...r]);
      setFeedback(d.added ? { tone: 'success', text: 'Added successfully.' }
        : d.waiting ? { tone: 'subdued', text: d.message } // product still waiting in Online (2026-10-08)
          : { tone: 'subdued', text: `Already added${d.title ? ` — ${d.title}` : ''}.` });
      setSku('');
    } catch (e) {
      setResults(r => [{ sku: code, message: e.message, error: true }, ...r]);
      setFeedback({ tone: 'critical', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add New Arrival">
      <Modal.Section>
        <BlockStack gap="400">
          <BlockStack gap="100">
            <Text as="p">Created a new product directly in Shopify instead of through Hub? Enter its SKU and click Add, so the other teams know it exists.</Text>
            <Text as="p">For a new product with several variants, one variant's SKU is enough.</Text>
            {/* Was "Added a new variant to an existing product? Nothing to do
                here." — changed 2026-10-08 (Hera): new variants are now
                handled here too, like Import. */}
            <Text as="p">Added a new variant to an existing product? Enter that variant's SKU.</Text>
          </BlockStack>
          <BlockStack gap="100">
          <InlineStack gap="300" blockAlign="end" wrap={false}>
            <div style={{ flex: 1 }} onKeyDown={(e) => { if (e.key === 'Enter') add(); }}>
              <TextField label="SKU" labelHidden placeholder="SKU" value={sku} onChange={(v) => { setSku(v); setFeedback(null); }} autoComplete="off" autoFocus />
            </div>
            <Tooltip content="For products with variants, add only 1 variant's SKU.">
              <Button variant="primary" onClick={add} loading={busy} disabled={!sku.trim()}>Add</Button>
            </Tooltip>
          </InlineStack>
          {feedback && <Text as="p" tone={feedback.tone}>{feedback.text}</Text>}
          </BlockStack>
          {results.length > 0 && (
            <>
              <Divider />
              <BlockStack gap="200">
                {results.map((r, i) => (
                  <div key={`${i}-${r.sku}`}>
                    {r.error
                      ? <Text as="span" tone="critical">{r.message}</Text>
                      : (
                        <>
                          <Text as="span" fontWeight="bold">{r.sku}</Text>{' '}
                          <Text as="span" tone="subdued">{r.message}</Text>
                          {r.title && <Text as="p" variant="bodySm" tone="subdued">{r.title}</Text>}
                        </>
                      )}
                  </div>
                ))}
              </BlockStack>
            </>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function BuyerHome() {
  const navigate = useNavigate();
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [addArrivalOpen, setAddArrivalOpen] = useState(false);

  const [badges, setBadges] = useState({
    inventoryCount: 0,
    stockLosses: 0,
    priceChangeAlert: false,
  });

  useEffect(() => {
    fetch('/api/badges/buyer')
      .then(r => r.json())
      .then(data => {
        setBadges({
          inventoryCount: (data.weeklyReviewing || 0) + (data.zeroLowReviewing || 0),
          stockLosses: data.stockLossesReviewing || 0,
          priceChangeAlert: data.priceChangeAlert || false,
        });
      })
      .catch(() => {});
  }, []);

  return (
    <Page
      title="Task"
      backAction={{ onAction: () => navigate('/') }}
      // Import Products (2026-09-24, Hera): top-right button, Desktop only.
      // Was: secondaryActions={[{ content: 'Import Products', onAction: () => navigate('/buyer/import-products') }]}
      // 2026-09-29: now a split button — Import Products + ▾ → Add New Arrival.
      primaryAction={(
        <ButtonGroup variant="segmented">
          <Button onClick={() => navigate('/buyer/import-products')}>Import Products</Button>
          <Popover
            active={importMenuOpen}
            onClose={() => setImportMenuOpen(false)}
            preferredAlignment="right"
            activator={(
              <Button disclosure={importMenuOpen ? 'up' : 'down'} onClick={() => setImportMenuOpen(o => !o)} accessibilityLabel="More import actions" />
            )}
          >
            <Box padding="100">
              <Tooltip content="If you manually added products, add them here so it could be added to New Arrival list.">
                <Button variant="tertiary" textAlign="left" fullWidth onClick={() => { setImportMenuOpen(false); setAddArrivalOpen(true); }}>
                  Add New Arrival
                </Button>
              </Tooltip>
            </Box>
          </Popover>
        </ButtonGroup>
      )}
    >
      <AddNewArrivalModal open={addArrivalOpen} onClose={() => setAddArrivalOpen(false)} />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* Inventory Count */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/inventory-count')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Inventory Count
                <Badge count={badges.inventoryCount} />
              </span>
            </Button>

            {/* Stock Losses */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/stock-losses')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Stock Loss
                <Badge count={badges.stockLosses} />
              </span>
            </Button>

            {/* PO Receiving */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving')}>
              Purchase Orders
            </Button>

            {/* Transfer */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/transfer')}>
              Transfer
            </Button>

            {/* Price Change */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/price-change')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Price Change
                {badges.priceChangeAlert && <ExclamationBadge />}
              </span>
            </Button>

            {/* Wig - Demo (2026-09-17, Hera: rename "Wig DEMO" to "Wig - Demo"
                and move it to just before Settings) */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/wig-demo')}>
              Wig - Demo
            </Button>

            {/* Settings */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/settings')}>
              Settings
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerHome;