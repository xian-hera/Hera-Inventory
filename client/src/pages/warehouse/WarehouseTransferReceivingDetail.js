import React from 'react';
import TransferReceivingDetail from '../shared/TransferReceivingDetail';

// Warehouse's "Receiving to HQ" detail page (改动二第1/2点, 2026-09-15) —
// same In transit ("Delivered" button) + Receiving (counting) structure as
// Manager's own Receiving side, including the Wig Number column. The one
// difference: role="warehouse" turns on the "Submit Without Counting" button
// in shared/TransferReceivingDetail.js whenever at least one line item is
// still uncounted — Manager's Receiving page keeps the original all-or-
// nothing Submit gate.
function WarehouseTransferReceivingDetail() {
  return <TransferReceivingDetail role="warehouse" backPath="/warehouse" />;
}

export default WarehouseTransferReceivingDetail;
