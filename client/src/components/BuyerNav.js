import React from 'react';

function BuyerNav() {
  return (
    <s-app-nav>
      <s-link href="/buyer" rel="home">Home</s-link>
      <s-link href="/buyer/counting-tasks">Weekly Inventory Count</s-link>
      <s-link href="/buyer/zero-qty-report">Zero/Low Inventory Count</s-link>
      <s-link href="/buyer/stock-losses">Stock Losses</s-link>
      <s-link href="/buyer/price-change">Price Change</s-link>
      <s-link href="/buyer/settings">Settings</s-link>
    </s-app-nav>
  );
}

export default BuyerNav;