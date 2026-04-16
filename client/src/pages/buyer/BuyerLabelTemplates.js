import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Button, Text,
  EmptyState, Spinner, Banner, Modal, TextField, Select,
  ActionList, Popover,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const PRESET_SIZES = [
  { label: '50 × 30 mm', width: 50, height: 30 },
  { label: '60 × 40 mm', width: 60, height: 40 },
  { label: '100 × 50 mm', width: 100, height: 50 },
  { label: '100 × 75 mm', width: 100, height: 75 },
  { label: 'Custom', width: null, height: null },
];

function TemplateCard({ template, onEdit, onDuplicate, onDelete }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const updatedDate = new Date(template.updated_at).toLocaleDateString();

  return (
    <Card padding="400">
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text variant="headingSm" fontWeight="semibold">{template.name}</Text>
            <Text variant="bodySm" tone="subdued">
              {template.paper_width_mm} × {template.paper_height_mm} mm
            </Text>
          </BlockStack>
          <Popover
            active={popoverOpen}
            activator={
              <Button
                variant="plain"
                onClick={() => setPopoverOpen(v => !v)}
                accessibilityLabel="More actions"
              >
                ···
              </Button>
            }
            onClose={() => setPopoverOpen(false)}
          >
            <ActionList
              items={[
                { content: 'Edit', onAction: () => { setPopoverOpen(false); onEdit(template); } },
                { content: 'Duplicate', onAction: () => { setPopoverOpen(false); onDuplicate(template); } },
                { content: 'Delete', destructive: true, onAction: () => { setPopoverOpen(false); onDelete(template); } },
              ]}
            />
          </Popover>
        </InlineStack>
        <Text variant="bodySm" tone="subdued">Updated {updatedDate}</Text>
        <Button onClick={() => onEdit(template)} fullWidth>Open editor</Button>
      </BlockStack>
    </Card>
  );
}

function NewTemplateModal({ open, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [sizeOption, setSizeOption] = useState('50 × 30 mm');
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const sizeSelectOptions = PRESET_SIZES.map(s => ({ label: s.label, value: s.label }));
  const preset = PRESET_SIZES.find(s => s.label === sizeOption);
  const isCustom = preset?.width === null;

  const handleCreate = async () => {
    setError('');
    const w = isCustom ? parseFloat(customW) : preset.width;
    const h = isCustom ? parseFloat(customH) : preset.height;
    if (!name.trim()) { setError('Please enter a template name.'); return; }
    if (!w || !h || w <= 0 || h <= 0) { setError('Please enter valid dimensions.'); return; }
    setLoading(true);
    try {
      await onCreate({ name: name.trim(), paper_width_mm: w, paper_height_mm: h });
      setName(''); setSizeOption('50 × 30 mm'); setCustomW(''); setCustomH('');
    } catch (e) {
      setError(e.message || 'Failed to create template.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New template"
      primaryAction={{ content: 'Create & open editor', onAction: handleCreate, loading }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
          <TextField
            label="Template name"
            value={name}
            onChange={setName}
            placeholder="e.g. Price tag 50×30"
            autoComplete="off"
          />
          <Select
            label="Paper size"
            options={sizeSelectOptions}
            value={sizeOption}
            onChange={setSizeOption}
          />
          {isCustom && (
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <TextField label="Width (mm)" type="number" value={customW} onChange={setCustomW} min="5" autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Height (mm)" type="number" value={customH} onChange={setCustomH} min="5" autoComplete="off" />
              </div>
            </InlineStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function BuyerLabelTemplates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/label-templates');
      if (!res.ok) throw new Error('Failed to load templates');
      setTemplates(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const handleCreate = async (data) => {
    const res = await fetch('/api/label-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to create template');
    const created = await res.json();
    setShowNew(false);
    navigate(`/buyer/label-templates/${created.id}`);
  };

  const handleDuplicate = async (template) => {
    setDuplicating(true);
    try {
      const res = await fetch(`/api/label-templates/${template.id}/duplicate`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to duplicate template');
      fetchTemplates();
    } catch (e) {
      setError('Failed to duplicate template.');
    } finally {
      setDuplicating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await fetch(`/api/label-templates/${deleteTarget.id}`, { method: 'DELETE' });
      setDeleteTarget(null);
      fetchTemplates();
    } catch (e) {
      setError('Failed to delete template.');
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <Page
      title="Label templates"
      backAction={{ onAction: () => navigate('/buyer/settings') }}
      primaryAction={{ content: 'New template', onAction: () => setShowNew(true) }}
    >
      <Layout>
        <Layout.Section>
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
              <Spinner />
            </div>
          ) : templates.length === 0 ? (
            <EmptyState
              heading="No templates yet"
              action={{ content: 'Create your first template', onAction: () => setShowNew(true) }}
              image=""
            >
              <p>Design a label template to use when printing product labels.</p>
            </EmptyState>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: '16px',
            }}>
              {templates.map(t => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  onEdit={(tmpl) => navigate(`/buyer/label-templates/${tmpl.id}`)}
                  onDuplicate={handleDuplicate}
                  onDelete={setDeleteTarget}
                />
              ))}
            </div>
          )}
        </Layout.Section>
      </Layout>

      <NewTemplateModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreate={handleCreate}
      />

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete template"
        primaryAction={{
          content: 'Delete',
          destructive: true,
          onAction: handleDelete,
          loading: deleteLoading,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setDeleteTarget(null) }]}
      >
        <Modal.Section>
          <Text>
            Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This cannot be undone.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default BuyerLabelTemplates;