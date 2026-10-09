import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider, Text } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import Home from './pages/Home';
// Every /manager route is wrapped in ManagerLocationGate (2026-09-29): it
// loads the Store location remembered for the current Shopify account once,
// before the page renders, so manager pages can read it synchronously. See
// components/ManagerLocationGate.js and accountMemory.js.
import ManagerLocationGate from './components/ManagerLocationGate';
// Route-level lazy loading (2026-10-06): every page below is downloaded only
// when the user first enters its section. The /* webpackChunkName */ comment
// groups all pages of one section into ONE file, so e.g. Store users never
// download Purchasing / Online / Operation / Warehouse pages. Home and
// ManagerLocationGate stay in the main file (loaded first, always).
// lazyWithReload = React.lazy + one automatic reload when a deploy has
// replaced the section files under an already-open tab (see lazyWithReload.js).
// PageErrorBoundary = an error in one page no longer blanks the whole Hub.
import lazyWithReload from './lazyWithReload';
import PageErrorBoundary from './components/PageErrorBoundary';
const BuyerHome = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerHome'));
const BuyerInventoryCount = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerInventoryCount'));
const BuyerSettings = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerSettings'));
const CountingTasksList = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/CountingTasksList'));
const CreatingTask = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/CreatingTask'));
const PreviewTask = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/PreviewTask'));
const TaskDetail = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/TaskDetail'));
const ZeroQtyReport = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/ZeroQtyReport'));
const BuyerStockLosses = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerStockLosses'));
const BuyerWigDemo = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerWigDemo'));
const BuyerStockLossesSettings = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerStockLossesSettings'));
const ManagerRestockPlan = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerRestockPlan'));
const ManagerRestockTasks = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerRestockTasks')); // Restock tasks layer, 2026-09-24
const BuyerLabelTemplates = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerLabelTemplates'));
// Own file: the label editor carries the large fabric drawing library (~100 KB
// compressed), so the rest of Purchasing loads without it.
const BuyerLabelEditor = lazyWithReload(() => import(/* webpackChunkName: "buyer-label-editor" */ './pages/buyer/BuyerLabelEditor'));
const ManagerHome = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerHome'));
const ManagerInventoryCount = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerInventoryCount'));
const ManagerCountingTasksList = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerCountingTasksList'));
const ManagerTaskDetail = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerTaskDetail'));
const ManagerZeroQtyReport = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerZeroQtyReport'));
const ManagerStockLosses = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerStockLosses'));
const ManagerWigDemo = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerWigDemo'));
const ManagerLabelPrintTasks = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerLabelPrintTasks'));
const ManagerLabelPrintTaskDetail = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerLabelPrintTaskDetail'));
const BuyerPriceChange = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPriceChange'));
// Price Change › Create Task / Settings (2026-10-08)
const BuyerPriceChangeCreate = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPriceChangeCreate'));
const BuyerPriceChangeSettings = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPriceChangeSettings'));
const ManagerPriceChangeDetail = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerPriceChangeDetail'));
const ManagerEmployeeCap = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerEmployeeCap'));
const ManagerPOReceiving = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerPOReceiving'));
const ManagerPOReceivingDetail = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerPOReceivingDetail'));
const CRMHome = lazyWithReload(() => import(/* webpackChunkName: "crm" */ './pages/crm/CRMHome'));
const CRMSettings = lazyWithReload(() => import(/* webpackChunkName: "crm" */ './pages/crm/CRMSettings'));
const HairdresserList = lazyWithReload(() => import(/* webpackChunkName: "crm" */ './pages/crm/HairdresserList'));
const HairdresserDetail = lazyWithReload(() => import(/* webpackChunkName: "crm" */ './pages/crm/HairdresserDetail'));
const SettleCommissions = lazyWithReload(() => import(/* webpackChunkName: "crm" */ './pages/crm/SettleCommissions'));
const EmployeeCap = lazyWithReload(() => import(/* webpackChunkName: "crm" */ './pages/crm/EmployeeCap'));
// Online — new section split out of CRM/Growth (2026-09-21, Hera): Birthday
// Reward + Influencer Management, moved here from ./pages/crm, gated by
// their own online_pin instead of crm_pin. See pages/online/OnlineHome.js.
const OnlineHome = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/OnlineHome'));
const OnlineSettings = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/OnlineSettings'));
const BirthdayReward = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/BirthdayReward'));
const BirthdayOrders = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/BirthdayOrders'));
const InfluencerList = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/InfluencerList'));
const InfluencerDetail = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/InfluencerDetail'));
// Import Products (buyer) + New products (online) — 2026-09-24, see claude/IMPORT_PRODUCTS_FEATURE_SPEC.md
const BuyerImportProducts = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerImportProducts'));
const BuyerImportProductsSettings = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerImportProductsSettings'));
const OnlineNewProducts = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/OnlineNewProducts'));
const OnlineNewProductsFinalized = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/OnlineNewProductsFinalized'));
const OnlineNewProductsSettings = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/OnlineNewProductsSettings'));
// Online › Swatch — 2026-10-01, see claude/SWATCH_FEATURE_SPEC.md
const OnlineSwatch = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/swatch/OnlineSwatch'));
// Online › Dashboard + tabs — 2026-10-01, see claude/ONLINE_DASHBOARD_SPEC.md
const OnlineDashboard = lazyWithReload(() => import(/* webpackChunkName: "online" */ './pages/online/OnlineDashboard'));
const ProductDatabaseSettings = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/ProductDatabaseSettings'));
const BuyerPOReceiving = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPOReceiving'));
const BuyerPOImportInvoice = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPOImportInvoice'));
const BuyerPOInvoiceDetail = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPOInvoiceDetail'));
const BuyerPOCommitLater = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPOCommitLater'));
const BuyerPOSuppliers = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPOSuppliers'));
const BuyerPOSupplierAdd = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPOSupplierAdd'));
const BuyerPOSupplierDetail = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPOSupplierDetail'));
const BuyerPOSettings = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerPOSettings'));
const BuyerTransfer = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerTransfer'));
const BuyerTransferHistory = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerTransferHistory'));
const BuyerTransferCreate = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerTransferCreate'));
const BuyerTransferOngoing = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerTransferOngoing'));
const BuyerTransferSettings = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerTransferSettings'));
const BuyerTransferDetail = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerTransferDetail'));
const BuyerBoxPO = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerBoxPO'));
const BuyerBoxPOCreate = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerBoxPOCreate'));
const BuyerBoxPOOngoing = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerBoxPOOngoing'));
const BuyerBoxPOPast = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerBoxPOPast'));
const BuyerBoxPODetail = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerBoxPODetail'));
const WarehouseHome = lazyWithReload(() => import(/* webpackChunkName: "warehouse" */ './pages/warehouse/WarehouseHome'));
const WarehouseTransferDetail = lazyWithReload(() => import(/* webpackChunkName: "warehouse" */ './pages/warehouse/WarehouseTransferDetail'));
const WarehouseTransferReceivingDetail = lazyWithReload(() => import(/* webpackChunkName: "warehouse" */ './pages/warehouse/WarehouseTransferReceivingDetail'));
const WarehouseTransferViewDetail = lazyWithReload(() => import(/* webpackChunkName: "warehouse" */ './pages/warehouse/WarehouseTransferViewDetail'));
const WarehouseBoxPODetail = lazyWithReload(() => import(/* webpackChunkName: "warehouse" */ './pages/warehouse/WarehouseBoxPODetail'));
const ManagerTransferHome = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerTransferHome'));
const ManagerTransferSendingDetail = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerTransferSendingDetail'));
const ManagerTransferReceivingDetail = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerTransferReceivingDetail'));
const ManagerTaskHistoryDetail = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerTaskHistoryDetail'));
const ManagerPOReceivingHistoryDetail = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerPOReceivingHistoryDetail'));
const ManagerTransferHistoryDetail = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerTransferHistoryDetail'));
const ManagerNewArrival = lazyWithReload(() => import(/* webpackChunkName: "manager" */ './pages/manager/ManagerNewArrival')); // Store → New Arrival, 2026-09-29
const BuyerNewArrivalSettings = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerNewArrivalSettings')); // its rules, 2026-09-29
// Purchasing user groups (2026-10-09, Hera): BuyerGroupGate wraps every /buyer
// route (layout route below) and asks for a group when none is on record;
// Settings → User Group edits the groups. See client/src/userGroup.js.
const BuyerGroupGate = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './components/BuyerGroupGate'));
const BuyerUserGroupSettings = lazyWithReload(() => import(/* webpackChunkName: "buyer" */ './pages/buyer/BuyerUserGroupSettings'));

// Shown while a section file is downloading. Plain "Loading..." text, not a
// Polaris Spinner — see claude/UI_RULES_READ_FIRST.md rule 1.
function PageLoading() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
      <Text as="p" tone="subdued">Loading...</Text>
    </div>
  );
}

function App() {
  return (
    <AppProvider i18n={enTranslations}>
      <BrowserRouter>
        <PageErrorBoundary>
          <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/" element={<Home />} />

          {/* Buyer — every route below sits inside the user-group gate (2026-10-09) */}
          <Route element={<BuyerGroupGate />}>
          <Route path="/buyer" element={<BuyerHome />} />
          <Route path="/buyer/settings/user-group" element={<BuyerUserGroupSettings />} />
          <Route path="/buyer/inventory-count" element={<BuyerInventoryCount />} />
          <Route path="/buyer/settings" element={<BuyerSettings />} />
          <Route path="/buyer/settings/new-arrival" element={<BuyerNewArrivalSettings />} />
          <Route path="/buyer/counting-tasks" element={<CountingTasksList />} />
          <Route path="/buyer/counting-tasks/new" element={<CreatingTask />} />
          <Route path="/buyer/counting-tasks/new/preview" element={<PreviewTask />} />
          <Route path="/buyer/counting-tasks/:taskId" element={<TaskDetail />} />
          <Route path="/buyer/zero-qty-report" element={<ZeroQtyReport />} />
          <Route path="/buyer/stock-losses" element={<BuyerStockLosses />} />
          <Route path="/buyer/wig-demo" element={<BuyerWigDemo />} />
          <Route path="/buyer/stock-losses-settings" element={<BuyerStockLossesSettings />} />
          <Route path="/buyer/label-templates" element={<BuyerLabelTemplates />} />
          <Route path="/buyer/label-templates/:id" element={<BuyerLabelEditor />} />
          <Route path="/buyer/price-change" element={<BuyerPriceChange />} />
          <Route path="/buyer/price-change/create" element={<BuyerPriceChangeCreate />} />
          <Route path="/buyer/price-change/settings" element={<BuyerPriceChangeSettings />} />
          <Route path="/buyer/product-database" element={<ProductDatabaseSettings />} />
          <Route path="/buyer/po-receiving" element={<BuyerPOReceiving />} />
          <Route path="/buyer/po-receiving/import" element={<BuyerPOImportInvoice />} />
          <Route path="/buyer/po-receiving/pending/:invoiceId" element={<BuyerPOImportInvoice />} />
          <Route path="/buyer/po-receiving/committed/:invoiceId" element={<BuyerPOInvoiceDetail />} />
          <Route path="/buyer/po-receiving/commit-later" element={<BuyerPOCommitLater />} />
          <Route path="/buyer/po-receiving/suppliers" element={<BuyerPOSuppliers />} />
          <Route path="/buyer/po-receiving/suppliers/new" element={<BuyerPOSupplierAdd />} />
          <Route path="/buyer/po-receiving/suppliers/:supplierId" element={<BuyerPOSupplierDetail />} />
          <Route path="/buyer/import-products" element={<BuyerImportProducts />} />
          <Route path="/buyer/import-products/settings" element={<BuyerImportProductsSettings />} />
          <Route path="/buyer/po-receiving/settings" element={<BuyerPOSettings />} />
          <Route path="/buyer/transfer" element={<BuyerTransfer />} />
          <Route path="/buyer/transfer/history" element={<BuyerTransferHistory />} />
          <Route path="/buyer/transfer/create" element={<BuyerTransferCreate />} />
          <Route path="/buyer/transfer/ongoing" element={<BuyerTransferOngoing />} />
          <Route path="/buyer/transfer/settings" element={<BuyerTransferSettings />} />
          <Route path="/buyer/transfer/:transferId" element={<BuyerTransferDetail />} />
          {/* BOX PO — fixed-path routes registered before the :id route so
              react-router's ordering can't shadow "create"/"ongoing"/"past"
              as an :id value (same lesson learned server-side in boxPo.js). */}
          <Route path="/buyer/po-receiving/box-po" element={<BuyerBoxPO />} />
          <Route path="/buyer/po-receiving/box-po/create" element={<BuyerBoxPOCreate />} />
          <Route path="/buyer/po-receiving/box-po/ongoing" element={<BuyerBoxPOOngoing />} />
          <Route path="/buyer/po-receiving/box-po/past" element={<BuyerBoxPOPast />} />
          <Route path="/buyer/po-receiving/box-po/:id" element={<BuyerBoxPODetail />} />
          </Route>

          {/* Warehouse */}
          <Route path="/warehouse" element={<WarehouseHome />} />
          {/* Receiving to HQ (改动二) — fixed "receiving" segment registered
              before the :transferId route so it can't be shadowed. */}
          <Route path="/warehouse/transfer/receiving/:transferId" element={<WarehouseTransferReceivingDetail />} />
          {/* Read-only view for "Pick up from store" transfers (2026-10-05) */}
          <Route path="/warehouse/transfer/view/:transferId" element={<WarehouseTransferViewDetail />} />
          <Route path="/warehouse/transfer/:transferId" element={<WarehouseTransferDetail />} />
          <Route path="/warehouse/box-po/:id" element={<WarehouseBoxPODetail />} />

          {/* Manager */}
          <Route path="/manager" element={<ManagerLocationGate><ManagerHome /></ManagerLocationGate>} />
          <Route path="/manager/transfer" element={<ManagerLocationGate><ManagerTransferHome /></ManagerLocationGate>} />
          <Route path="/manager/transfer/sending/:transferId" element={<ManagerLocationGate><ManagerTransferSendingDetail /></ManagerLocationGate>} />
          <Route path="/manager/transfer/receiving/:transferId" element={<ManagerLocationGate><ManagerTransferReceivingDetail /></ManagerLocationGate>} />
          {/* Transfer History detail — fixed "history" segment can't collide
              with the :transferId routes above (different segment counts). */}
          <Route path="/manager/transfer/history/:historyId" element={<ManagerLocationGate><ManagerTransferHistoryDetail /></ManagerLocationGate>} />
          <Route path="/manager/inventory-count" element={<ManagerLocationGate><ManagerInventoryCount /></ManagerLocationGate>} />
          <Route path="/manager/counting-tasks" element={<ManagerLocationGate><ManagerCountingTasksList /></ManagerLocationGate>} />
          <Route path="/manager/counting-tasks/:taskId" element={<ManagerLocationGate><ManagerTaskDetail /></ManagerLocationGate>} />
          <Route path="/manager/counting-tasks/history/:historyId" element={<ManagerLocationGate><ManagerTaskHistoryDetail /></ManagerLocationGate>} />
          <Route path="/manager/zero-qty-report" element={<ManagerLocationGate><ManagerZeroQtyReport /></ManagerLocationGate>} />
          <Route path="/manager/stock-losses" element={<ManagerLocationGate><ManagerStockLosses /></ManagerLocationGate>} />
          <Route path="/manager/wig-demo" element={<ManagerLocationGate><ManagerWigDemo /></ManagerLocationGate>} />
          <Route path="/manager/restock-plan" element={<ManagerLocationGate><ManagerRestockTasks /></ManagerLocationGate>} />
          <Route path="/manager/restock-plan/:taskId" element={<ManagerLocationGate><ManagerRestockPlan /></ManagerLocationGate>} />
          <Route path="/manager/label-print" element={<ManagerLocationGate><ManagerLabelPrintTasks /></ManagerLocationGate>} />
          <Route path="/manager/label-print/:taskId" element={<ManagerLocationGate><ManagerLabelPrintTaskDetail /></ManagerLocationGate>} />
          <Route path="/manager/price-change/:taskId" element={<ManagerLocationGate><ManagerPriceChangeDetail /></ManagerLocationGate>} />
          <Route path="/manager/employee-cap" element={<ManagerLocationGate><ManagerEmployeeCap /></ManagerLocationGate>} />
          <Route path="/manager/new-arrival" element={<ManagerLocationGate><ManagerNewArrival /></ManagerLocationGate>} />
          <Route path="/manager/po-receiving" element={<ManagerLocationGate><ManagerPOReceiving /></ManagerLocationGate>} />
          <Route path="/manager/po-receiving/history/:historyId" element={<ManagerLocationGate><ManagerPOReceivingHistoryDetail /></ManagerLocationGate>} />
          <Route path="/manager/po-receiving/:invoiceId" element={<ManagerLocationGate><ManagerPOReceivingDetail /></ManagerLocationGate>} />

          {/* CRM */}
          <Route path="/crm" element={<CRMHome />} />
          <Route path="/crm/settings" element={<CRMSettings />} />
          <Route path="/crm/hairdressers" element={<HairdresserList />} />
          <Route path="/crm/hairdressers/settle-commissions" element={<SettleCommissions />} />
          <Route path="/crm/hairdressers/:id" element={<HairdresserDetail />} />
          <Route path="/crm/employee-cap" element={<EmployeeCap />} />

          {/* Online — new section split out of CRM/Growth (2026-09-21, Hera) */}
          {/* Online tabs (2026-10-01): OnlineHome = PIN gate + header + tab bar around each tab page */}
          <Route path="/online" element={<OnlineHome tab="dashboard"><OnlineDashboard /></OnlineHome>} />
          <Route path="/online/settings" element={<OnlineSettings />} />
          <Route path="/online/birthday-reward" element={<OnlineHome tab="birthday-reward"><BirthdayReward inTabs /></OnlineHome>} />
          <Route path="/online/birthday-reward/orders" element={<BirthdayOrders />} />
          <Route path="/online/influencers" element={<OnlineHome tab="influencers"><InfluencerList inTabs /></OnlineHome>} />
          <Route path="/online/influencers/:id" element={<InfluencerDetail />} />
          <Route path="/online/new-products" element={<OnlineHome tab="new-products"><OnlineNewProducts inTabs /></OnlineHome>} />
          <Route path="/online/new-products/finalized" element={<OnlineNewProductsFinalized />} />
          <Route path="/online/new-products/settings" element={<OnlineNewProductsSettings />} />
          <Route path="/online/swatch" element={<OnlineHome tab="swatch"><OnlineSwatch inTabs /></OnlineHome>} />
        </Routes>
          </Suspense>
        </PageErrorBoundary>
      </BrowserRouter>
    </AppProvider>
  );
}

export default App;