import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import Home from './pages/Home';

function App() {
  const shopifyConfig = {
    apiKey: process.env.REACT_APP_SHOPIFY_API_KEY,
    host: new URLSearchParams(window.location.search).get('host') || '',
    forceRedirect: true,
  };

  return (
    <AppProvider
      i18n={enTranslations}
      features={{ newDesignLanguage: true }}
    >
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}

export default App;