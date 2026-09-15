import React from 'react';
import TransferReceivingDetail from '../shared/TransferReceivingDetail';

// Thin wrapper — see shared/TransferReceivingDetail.js. 2026-09-15: this file
// used to hold the full implementation directly; it moved to the shared
// component so Warehouse's new "Receiving to HQ" flow (see
// WarehouseTransferReceivingDetail.js) could reuse it (spec doc 改动二).
function ManagerTransferReceivingDetail() {
  return <TransferReceivingDetail role="manager" backPath="/manager/transfer" />;
}

export default ManagerTransferReceivingDetail;
