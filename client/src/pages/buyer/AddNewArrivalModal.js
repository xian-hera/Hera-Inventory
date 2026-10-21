import React, { useState, useEffect } from 'react';
import { Modal, BlockStack, InlineStack, Button, Tooltip, TextField, Divider, Text } from '@shopify/polaris';

// Moved here from BuyerHome.js on 2026-10-21 (Hera): the Add New Arrival button
// now lives on the New Products (Import Products) page, top-right.
// Add New Arrival (2026-09-29, Hera): for products made by hand in Shopify.
// Enter one SKU (or barcode) → Hub adds the product to Online → New products
// (POS only = false) or Store → New Arrival (POS only = true). The modal
// stays open so several SKUs can be added in a row; results are listed.
// 2026-10-08 (Hera): an explanation line on top, the box takes a SKU or a
// Name (placeholder, no label) — Name removed again the same day, SKU only
// (Hera 2026-10-08) —, the whole product is added (see the server
// route), and the result of the last Add shows right under the box.
export default function AddNewArrivalModal({ open, onClose }) {
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
