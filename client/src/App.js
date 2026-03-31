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
import BuyerLabelTemplates from './pages/buyer/BuyerLabelTemplates';
import BuyerLabelEditor from './pages/buyer/BuyerLabelEditor';
import ManagerHome from './pages/manager/ManagerHome';
import ManagerCountingTasksList from './pages/manager/ManagerCountingTasksList';
import ManagerTaskDetail from './pages/manager/ManagerTaskDetail';
import ManagerZeroQtyReport from './pages/manager/ManagerZeroQtyReport';
import ManagerLabelPrintTasks from './pages/manager/ManagerLabelPrintTasks';
import ManagerLabelPrintTaskDetail from './pages/manager/ManagerLabelPrintTaskDetail';

function App() {
  return (
    <AppProvider i18n={enTranslations}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />

          {/* Buyer */}
          <Route path="/buyer" element={<BuyerHome />} />
          <Route path="/buyer/counting-tasks" element={<CountingTasksList />} />
          <Route path="/buyer/counting-tasks/new" element={<CreatingTask />} />
          <Route path="/buyer/counting-tasks/new/preview" element={<PreviewTask />} />
          <Route path="/buyer/counting-tasks/:taskId" element={<TaskDetail />} />
          <Route path="/buyer/zero-qty-report" element={<ZeroQtyReport />} />
          <Route path="/buyer/label-templates" element={<BuyerLabelTemplates />} />
          <Route path="/buyer/label-templates/:id" element={<BuyerLabelEditor />} />

          {/* Manager */}
          <Route path="/manager" element={<ManagerHome />} />
          <Route path="/manager/counting-tasks" element={<ManagerCountingTasksList />} />
          <Route path="/manager/counting-tasks/:taskId" element={<ManagerTaskDetail />} />
          <Route path="/manager/zero-qty-report" element={<ManagerZeroQtyReport />} />
          <Route path="/manager/restock-plan" element={<ManagerRestockPlan />} />
          <Route path="/manager/label-print" element={<ManagerLabelPrintTasks />} />
          <Route path="/manager/label-print/:taskId" element={<ManagerLabelPrintTaskDetail />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}

export default App;
