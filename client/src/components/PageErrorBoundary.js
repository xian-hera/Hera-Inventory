// PageErrorBoundary (2026-10-06) — see App.js.
//
// Catches an error thrown while rendering ONE page, so a bug in one page
// shows an error message in place of that page instead of blanking the
// whole Hub. The outer ErrorBoundary in index.js is still there as the
// last line of defence.
//
// It resets automatically when the URL path changes, so navigating to any
// other page (or "Back to Home") clears the error.
//
// Also receives section files that failed to download and could not be
// fixed by the automatic reload in lazyWithReload.js.

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Page, Banner, BlockStack, InlineStack, Button, Text } from '@shopify/polaris';

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[PageErrorBoundary] page crashed:', error, info);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Page>
        <Banner tone="critical" title="This page ran into an error">
          <BlockStack gap="300">
            <Text as="p">
              The rest of the Hub still works. Try reloading the page; if it keeps
              happening, send this message to the Hub admin.
            </Text>
            <Text as="p" tone="subdued">{String((error && error.message) || error)}</Text>
            <InlineStack gap="200">
              <Button variant="primary" onClick={() => window.location.reload()}>
                Reload page
              </Button>
              <Button onClick={this.props.onHome}>Back to Home</Button>
            </InlineStack>
          </BlockStack>
        </Banner>
      </Page>
    );
  }
}

export default function PageErrorBoundary({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <Boundary resetKey={location.pathname} onHome={() => navigate('/')}>
      {children}
    </Boundary>
  );
}
