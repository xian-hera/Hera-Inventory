import React from 'react';
import ReactDOM from 'react-dom/client';
import '@shopify/polaris/build/esm/styles.css';
import App from './App';

// Global fetch interceptor for session reauth
const originalFetch = window.fetch;
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (response.status === 401) {
    const data = await response.clone().json().catch(() => ({}));
    if (data.reauth && data.authUrl) {
      window.top.location.href = data.authUrl;
      return response;
    }
  }
  return response;
};

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('App crashed:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', textAlign: 'center' }}>
          <h2>Something went wrong</h2>
          <p style={{ color: '#d72c0d', marginBottom: '16px' }}>
            {this.state.error?.message}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 20px', background: '#008060', color: 'white',
              border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px',
            }}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);