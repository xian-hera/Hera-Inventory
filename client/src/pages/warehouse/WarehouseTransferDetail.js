import React from 'react';
import { useLocation } from 'react-router-dom';
import TransferPrepDetail from '../shared/TransferPrepDetail';

// Thin wrapper — Warehouse's Loading/Pending/Good to go/In transit detail
// page is pixel-identical to Manager-as-from-location's (confirmed by Hera),
// so both just configure the shared TransferPrepDetail component.
// Warehouse never shows the Wig Number column (confirmed via AskUserQuestion).
function WarehouseTransferDetail() {
  // Back goes to where the user came from (2026-10-21, Warehouse tabs):
  // HQ Transfers tab by default, or the Schedule tab when opened through the
  // Transfer popup's "Jump to Transfer" button.
  const location = useLocation();
  const backPath = (location.state && location.state.from) || '/warehouse/hq-transfers';
  return (
    <TransferPrepDetail
      role="warehouse"
      showWigNumber={false}
      backPath={backPath}
      dispatchLabel="Mark as In Transit"
      showTags
    />
  );
}

export default WarehouseTransferDetail;
