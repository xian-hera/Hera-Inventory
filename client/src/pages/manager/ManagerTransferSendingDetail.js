import React from 'react';
import TransferPrepDetail from '../shared/TransferPrepDetail';

// Thin wrapper — Manager-as-from-location's Loading/Pending/Good to go
// detail page (the "Sending" side) is pixel-identical to Warehouse's
// (confirmed by Hera), except this one shows the Wig Number column and the
// Good-to-go button reads "Truck picked up" instead of "Dispatch".
function ManagerTransferSendingDetail() {
  return (
    <TransferPrepDetail
      role="manager"
      showWigNumber={true}
      backPath="/manager/transfer"
      dispatchLabel="Truck picked up"
    />
  );
}

export default ManagerTransferSendingDetail;
