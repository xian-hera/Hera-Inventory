import React from 'react';

// Android + Shopify mobile app (2026-09-24, Hera): on phone widths a Polaris
// <Modal> opens as a sheet pinned to the bottom of the screen
// (.Polaris-Modal-Dialog__Modal { position: fixed; bottom: 0 } below 48em),
// where Shopify's own native bottom buttons cover its action buttons. Same
// idea as the .mobile-bottom-safe-area spacer in client/public/index.html:
// we can't move Shopify's bar, so the modal gets a bottom padding that lifts
// its content (incl. the footer buttons) above it. Render this once inside a
// page; the rule only exists while that page is mounted and only below the
// Polaris phone breakpoint, so desktop and other pages are unaffected.
function MobileModalSafeArea() {
  return (
    <style>{`
      @media (max-width: 47.9975em) {
        .Polaris-Modal-Dialog__Modal {
          padding-bottom: 96px;
        }
      }
    `}</style>
  );
}

export default MobileModalSafeArea;
