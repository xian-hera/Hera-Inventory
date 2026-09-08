import React from 'react';
import TransferPrepDetail from '../shared/TransferPrepDetail';

// Thin wrapper — Warehouse's Loading/Pending/Good to go/In transit detail
// page is pixel-identical to Manager-as-from-location's (confirmed by Hera),
// so both just configure the shared TransferPrepDetail component.
// Warehouse never shows the Wig Number column (confirmed via AskUserQuestion).
function WarehouseTransferDetail() {
  return (
    <TransferPrepDetail
      role="warehouse"
      showWigNumber={false}
      backPath="/warehouse"
      dispatchLabel="Dispatch"
    />
  );
}

export default WarehouseTransferDetail;
