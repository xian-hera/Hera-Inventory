import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Page, Text } from '@shopify/polaris';
import OnlineTransferPrepDetail from './OnlineTransferPrepDetail';
import TransferPrepDetail from '../shared/TransferPrepDetail';

// Thin wrapper — Manager-as-from-location's Loading/Pending/Good to go
// detail page (the "Sending" side) is pixel-identical to Warehouse's
// (confirmed by Hera), except this one shows the Wig Number column and the
// Good-to-go button reads "Truck picked up" instead of "Dispatch".
// Online (Fulfiller) transfers get their own page (2026-10-23, Hera) —
// claude/FULFILLER_ONLINE_TRANSFER_SPEC.md; every other transfer: the shared
// TransferPrepDetail as before.
function ManagerTransferSendingDetail() {
  const { transferId } = useParams();
  const [source, setSource] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/transfers/${transferId}?role=manager`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setSource((d && d.transfer && d.transfer.source) || 'hub'); })
      .catch(() => { if (!cancelled) setSource('hub'); });
    return () => { cancelled = true; };
  }, [transferId]);
  if (source === null) return <Page title="Transfer"><Text tone="subdued">Loading...</Text></Page>;
  if (source === 'fulfiller') return <OnlineTransferPrepDetail />;
  return <ManagerTransferSendingDetailNormal />;
}

function ManagerTransferSendingDetailNormal() {
  return (
    <TransferPrepDetail
      role="manager"
      showWigNumber={true}
      backPath="/manager/transfer"
      // "Truck picked up" button removed 2026-10-23 (Hera): the store's job
      // ends at Ready to Ship; WH's Delivery › Picked Up makes it In Transit.
    />
  );
}

export default ManagerTransferSendingDetail;
