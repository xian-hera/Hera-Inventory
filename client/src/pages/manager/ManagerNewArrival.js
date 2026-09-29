// Store → New Arrival (2026-09-29, Hera). Spec: claude/STORE_NEW_ARRIVAL_FEATURE.md
// Two tabs: products already in stock at this store ("Available in store")
// and products not stocked here yet ("Incoming"). One card per product type
// (A→Z), newest first inside a card. Tap the picture to see it large; tap
// anywhere to close.
import React, { useState, useEffect, useCallback } from 'react';
import { Page, Card, BlockStack, InlineStack, Text, Tabs, Banner, Spinner, Divider, Box } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { getManagerLocation } from '../../accountMemory';

const TABS = [
  { id: 'available', content: 'Available in store', note: 'Products below should be attached the NEW tag on their price tag.' },
  { id: 'incoming', content: 'Incoming', note: 'Products below are not stocked in your store yet.' },
];

function ProductRow({ item, onOpenImage, first }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '12px 0', borderTop: first ? 'none' : '1px solid #e1e3e5' }}>
      <button
        type="button"
        onClick={() => item.imageUrl && onOpenImage(item)}
        aria-label={item.imageUrl ? `View picture of ${item.title}` : 'No picture'}
        style={{
          width: 64, height: 64, flex: '0 0 64px', padding: 0, border: '1px solid #e1e3e5', borderRadius: 8,
          background: '#f6f6f7', overflow: 'hidden', cursor: item.imageUrl ? 'pointer' : 'default',
        }}
      >
        {item.thumbUrl
          ? <img src={item.thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <span style={{ fontSize: 11, color: '#8c9196' }}>No image</span>}
      </button>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {item.vendor && <Text variant="bodySm" tone="subdued">{item.vendor}</Text>}
        <div style={{ wordBreak: 'break-word' }}><Text variant="bodyMd" fontWeight="semibold">{item.title}</Text></div>
        <div style={{ marginTop: 'auto', paddingTop: 4, textAlign: 'right' }}>
          <Text variant="bodySm" as="span" tone="subdued">New until </Text>
          <Text variant="bodySm" as="span" fontWeight="semibold">{item.newUntil || 'TBD'}</Text>
        </div>
      </div>
    </div>
  );
}

function ManagerNewArrival() {
  const navigate = useNavigate();
  const location = getManagerLocation();
  const [tab, setTab] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [image, setImage] = useState(null); // item whose picture is open

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch(`/api/store-new-arrivals?location=${encodeURIComponent(location)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Load failed');
      setData(d);
    } catch (e) {
      setError(e.message);
    }
  }, [location]);
  useEffect(() => { load(); }, [load]);

  const current = TABS[tab];
  const cards = data ? data[current.id] || [] : [];

  return (
    <Page title="New Arrival" backAction={{ onAction: () => navigate('/manager') }}>
      <BlockStack gap="400">
        {/* Cards are edge-to-edge on phones (Polaris); the tabs and note get
            the same side padding as the page title. */}
        <Box paddingInlineStart={{ xs: '400', sm: '0' }} paddingInlineEnd={{ xs: '400', sm: '0' }}>
          <BlockStack gap="300">
            <Tabs tabs={TABS.map(t => ({ id: t.id, content: t.content }))} selected={tab} onSelect={setTab} />
            <Text tone="subdued">{current.note}</Text>
          </BlockStack>
        </Box>
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {!data && !error && <InlineStack align="center"><Spinner /></InlineStack>}
        {data && cards.length === 0 && (
          <Card><Text tone="subdued" alignment="center">No products.</Text></Card>
        )}
        {cards.map(card => (
          <Card key={card.type}>
            <BlockStack gap="300">
              <Text variant="headingSm" as="h2">{card.type}</Text>
              <Divider />
              <div>
                {card.items.map((item, i) => (
                  <ProductRow key={item.id} item={item} first={i === 0} onOpenImage={setImage} />
                ))}
              </div>
            </BlockStack>
          </Card>
        ))}
      </BlockStack>

      {/* Large picture — tap anywhere to close. Bottom padding keeps it clear
          of Shopify's native buttons on Android (same as other manager
          popups, 2026-09-24). */}
      {image && (
        <div
          onClick={() => setImage(null)}
          role="dialog"
          aria-label={image.title}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.8)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: '16px 16px 96px', boxSizing: 'border-box', cursor: 'pointer',
          }}
        >
          <img
            src={image.imageUrl}
            alt={image.title}
            style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 176px)', objectFit: 'contain', borderRadius: 8, background: '#fff' }}
          />
          <div style={{ color: '#fff', marginTop: 12, fontSize: 14, textAlign: 'center' }}>{image.title}</div>
        </div>
      )}

      {/* Generous bottom space (Hera 2026-09-29): the last card must not sit
          on the screen edge or under a bottom nav bar. 120px plus whatever
          safe-area inset Shopify reports (the plain 80px fallback alone was
          too tight, and a small reported inset made it even tighter). */}
      <div style={{ height: 'calc(120px + var(--shopify-safe-area-inset-bottom, 0px))' }} aria-hidden="true" />
    </Page>
  );
}

export default ManagerNewArrival;
