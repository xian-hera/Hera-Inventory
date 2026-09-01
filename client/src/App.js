import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import Home from './pages/Home';
import BuyerHome from './pages/buyer/BuyerHome';
import BuyerInventoryCount from './pages/buyer/BuyerInventoryCount';
import BuyerSettings from './pages/buyer/BuyerSettings';
import CountingTasksList from './pages/buyer/CountingTasksList';
import CreatingTask from './pages/buyer/CreatingTask';
import PreviewTask from './pages/buyer/PreviewTask';
import TaskDetail from './pages/buyer/TaskDetail';
import ZeroQtyReport from './pages/buyer/ZeroQtyReport';
import BuyerStockLosses from './pages/buyer/BuyerStockLosses';
import BuyerStockLossesSettings from './pages/buyer/BuyerStockLossesSettings';
import ManagerRestockPlan from './pages/manager/ManagerRestockPlan';
import BuyerLabelTemplates from './pages/buyer/BuyerLabelTemplates';
import BuyerLabelEditor from './pages/buyer/BuyerLabelEditor';
import ManagerHome from './pages/manager/ManagerHome';
import ManagerInventoryCount from './pages/manager/ManagerInventoryCount';
import ManagerCountingTasksList from './pages/manager/ManagerCountingTasksList';
import ManagerTaskDetail from './pages/manager/ManagerTaskDetail';
import ManagerZeroQtyReport from './pages/manager/ManagerZeroQtyReport';
import ManagerStockLosses from './pages/manager/ManagerStockLosses';
import ManagerLabelPrintTasks from './pages/manager/ManagerLabelPrintTasks';
import ManagerLabelPrintTaskDetail from './pages/manager/ManagerLabelPrintTaskDetail';
import BuyerPriceChange from './pages/buyer/BuyerPriceChange';
import BuyerPriceChangePublished from './pages/buyer/BuyerPriceChangePublished';
import ManagerPriceChangeDetail from './pages/manager/ManagerPriceChangeDetail';
import ManagerEmployeeCap from './pages/manager/ManagerEmployeeCap';
import ManagerPOReceiving from './pages/manager/ManagerPOReceiving';
import ManagerPOReceivingDetail from './pages/manager/ManagerPOReceivingDetail';
import CRMHome from './pages/crm/CRMHome';
import CRMSettings from './pages/crm/CRMSettings';
import HairdresserList from './pages/crm/HairdresserList';
import HairdresserDetail from './pages/crm/HairdresserDetail';
import SettleCommissions from './pages/crm/SettleCommissions';
import BirthdayReward from './pages/crm/BirthdayReward';
import BirthdayOrders from './pages/crm/BirthdayOrders';
import InfluencerList from './pages/crm/InfluencerList';
import InfluencerDetail from './pages/crm/InfluencerDetail';
import EmployeeCap from './pages/crm/EmployeeCap';
import ProductDatabaseSettings from './pages/buyer/ProductDatabaseSettings';
import BuyerPOReceiving from './pages/buyer/BuyerPOReceiving';
import BuyerPOReceivingHistory from './pages/buyer/BuyerPOReceivingHistory';
import BuyerPOImportInvoice from './pages/buyer/BuyerPOImportInvoice';
import BuyerPOInvoiceDetail from './pages/buyer/BuyerPOInvoiceDetail';
import BuyerPOCommitLater from './pages/buyer/BuyerPOCommitLater';
import BuyerPOSuppliers from './pages/buyer/BuyerPOSuppliers';
import BuyerPOSupplierAdd from './pages/buyer/BuyerPOSupplierAdd';
import BuyerPOSupplierDetail from './pages/buyer/BuyerPOSupplierDetail';
import BuyerPOSettings from './pages/buyer/BuyerPOSettings';

function App() {
  return (
    <AppProvider i18n={enTranslations}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />

          {/* Buyer */}
          <Route path="/buyer" element={<BuyerHome />} />
          <Route path="/buyer/inventory-count" element={<BuyerInventoryCount />} />
          <Route path="/buyer/settings" element={<BuyerSettings />} />
          <Route path="/buyer/counting-tasks" element={<CountingTasksList />} />
          <Route path="/buyer/counting-tasks/new" element={<CreatingTask />} />
          <Route path="/buyer/counting-tasks/new/preview" element={<PreviewTask />} />
          <Route path="/buyer/counting-tasks/:taskId" element={<TaskDetail />} />
          <Route path="/buyer/zero-qty-report" element={<ZeroQtyReport />} />
          <Route path="/buyer/stock-losses" element={<BuyerStockLosses />} />
          <Route path="/buyer/stock-losses-settings" element={<BuyerStockLossesSettings />} />
          <Route path="/buyer/label-templates" element={<BuyerLabelTemplates />} />
          <Route path="/buyer/label-templates/:id" element={<BuyerLabelEditor />} />
          <Route path="/buyer/price-change" element={<BuyerPriceChange />} />
          <Route path="/buyer/price-change/published" element={<BuyerPriceChangePublished />} />
          <Route path="/buyer/product-database" element={<ProductDatabaseSettings />} />
          <Route path="/buyer/po-receiving" element={<BuyerPOReceiving />} />
          <Route path="/buyer/po-receiving/history" element={<BuyerPOReceivingHistory />} />
          <Route path="/buyer/po-receiving/import" element={<BuyerPOImportInvoice />} />
          <Route path="/buyer/po-receiving/pending/:invoiceId" element={<BuyerPOImportInvoice />} />
          <Route path="/buyer/po-receiving/committed/:invoiceId" element={<BuyerPOInvoiceDetail />} />
          <Route path="/buyer/po-receiving/commit-later" element={<BuyerPOCommitLater />} />
          <Route path="/buyer/po-receiving/suppliers" element={<BuyerPOSuppliers />} />
          <Route path="/buyer/po-receiving/suppliers/new" element={<BuyerPOSupplierAdd />} />
          <Route path="/buyer/po-receiving/suppliers/:supplierId" element={<BuyerPOSupplierDetail />} />
          <Route path="/buyer/po-receiving/settings" element={<BuyerPOSettings />} />

          {/* Manager */}
          <Route path="/manager" element={<ManagerHome />} />
          <Route path="/manager/inventory-count" element={<ManagerInventoryCount />} />
          <Route path="/manager/counting-tasks" element={<ManagerCountingTasksList />} />
          <Route path="/manager/counting-tasks/:taskId" element={<ManagerTaskDetail />} />
          <Route path="/manager/zero-qty-report" element={<ManagerZeroQtyReport />} />
          <Route path="/manager/stock-losses" element={<ManagerStockLosses />} />
          <Route path="/manager/restock-plan" element={<ManagerRestockPlan />} />
          <Route path="/manager/label-print" element={<ManagerLabelPrintTasks />} />
          <Route path="/manager/label-print/:taskId" element={<ManagerLabelPrintTaskDetail />} />
          <Route path="/manager/price-change/:taskId" element={<ManagerPriceChangeDetail />} />
          <Route path="/manager/employee-cap" element={<ManagerEmployeeCap />} />
          <Route path="/manager/po-receiving" element={<ManagerPOReceiving />} />
          <Route path="/manager/po-receiving/:invoiceId" element={<ManagerPOReceivingDetail />} />

          {/* CRM */}
          <Route path="/crm" element={<CRMHome />} />
          <Route path="/crm/settings" element={<CRMSettings />} />
          <Route path="/crm/hairdressers" element={<HairdresserList />} />
          <Route path="/crm/hairdressers/settle-commissions" element={<SettleCommissions />} />
          <Route path="/crm/hairdressers/:id" element={<HairdresserDetail />} />
          <Route path="/crm/birthday-reward" element={<BirthdayReward />} />
          <Route path="/crm/birthday-reward/orders" element={<BirthdayOrders />} />
          <Route path="/crm/influencers" element={<InfluencerList />} />
          <Route path="/crm/influencers/:id" element={<InfluencerDetail />} />
          <Route path="/crm/employee-cap" element={<EmployeeCap />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}

export default App;