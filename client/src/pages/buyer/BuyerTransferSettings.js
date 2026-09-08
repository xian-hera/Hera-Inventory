import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

// Transfer Settings — the only setting is the Tag pool: candidate tags shown
// on Create Transfer. Not case-sensitive for uniqueness, max 20 characters,
// and deleting a tag here never touches already-published transfers (spec
// doc section 3).
function BuyerTransferSettings() {
  const navigate = useNavigate();
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newTag, setNewTag] = useState('');
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const fetchTags = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/tags');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTags(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTags(); }, [fetchTags]);

  const handleAdd = async () => {
    const trimmed = newTag.trim();
    if (!trimmed) return;
    setAdding(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTags(prev => [...prev, data].sort((a, b) => a.tag.localeCompare(b.tag)));
      setNewTag('');
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (tag) => {
    setDeletingId(tag.id);
    setError('');
    try {
      const res = await fetch(`/api/transfers/tags/${tag.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTags(prev => prev.filter(t => t.id !== tag.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Page title="Transfer Settings" backAction={{ onAction: () => navigate('/buyer/transfer') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm">Tag pool</Text>
                <Text tone="subdued" variant="bodySm">
                  Candidate tags shown when creating a transfer. Not case-sensitive, up to 20 characters. Removing a tag here does not affect transfers already created with it.
                </Text>

                <InlineStack gap="200">
                  <div style={{ flex: 1, maxWidth: '260px' }}>
                    <TextField
                      label="" labelHidden
                      placeholder="New tag"
                      value={newTag}
                      onChange={setNewTag}
                      maxLength={20}
                      autoComplete="off"
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
                    />
                  </div>
                  <Button onClick={handleAdd} loading={adding}>Add</Button>
                </InlineStack>

                {loading ? (
                  <InlineStack align="center"><Spinner size="small" /></InlineStack>
                ) : tags.length === 0 ? (
                  <Text tone="subdued">No tags yet.</Text>
                ) : (
                  <InlineStack gap="150" wrap>
                    {tags.map(tag => (
                      <span
                        key={tag.id}
                        style={{
                          display: 'inline-flex', alignItems: 'center',
                          padding: '4px 10px', borderRadius: '14px',
                          background: '#f1f2f3', fontSize: '13px',
                        }}
                      >
                        {tag.tag}
                        <span
                          onClick={() => (deletingId === tag.id ? null : handleDelete(tag))}
                          style={{ cursor: 'pointer', marginLeft: '8px', color: '#d72c0d', opacity: deletingId === tag.id ? 0.5 : 1 }}
                        >
                          ×
                        </span>
                      </span>
                    ))}
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerTransferSettings;
