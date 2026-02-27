import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import Home from './pages/Home';
import BuyerHome from './pages/buyer/BuyerHome';
import CountingTasksList from './pages/buyer/CountingTasksList';
import CreatingTask from './pages/buyer/CreatingTask';
import PreviewTask from './pages/buyer/PreviewTask';
import TaskDetail from './pages/buyer/TaskDetail';
import ZeroQtyReport from './pages/buyer/ZeroQtyReport';
import ManagerHome from './pages/manager/ManagerHome';
import ManagerCountingTasksList from './pages/manager/ManagerCountingTasksList';
import ManagerTaskDetail from './pages/manager/ManagerTaskDetail';
import ManagerZeroQtyReport from './pages/manager/ManagerZeroQtyReport';

function App() {
  return (
    <AppProvider i18n={enTranslations}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/buyer" element={<BuyerHome />} />
          <Route path="/buyer/counting-tasks" element={<CountingTasksList />} />
          <Route path="/buyer/counting-tasks/new" element={<CreatingTask />} />
          <Route path="/buyer/counting-tasks/new/preview" element={<PreviewTask />} />
          <Route path="/buyer/counting-tasks/:taskId" element={<TaskDetail />} />
          <Route path="/buyer/zero-qty-report" element={<ZeroQtyReport />} />
          <Route path="/manager" element={<ManagerHome />} />
          <Route path="/manager/counting-tasks" element={<ManagerCountingTasksList />} />
          <Route path="/manager/counting-tasks/:taskId" element={<ManagerTaskDetail />} />
          <Route path="/manager/zero-qty-report" element={<ManagerZeroQtyReport />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}

export default App;