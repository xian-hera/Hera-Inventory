// Employee Discount (2026-11-12, Hera — claude/EMPLOYEE_DISCOUNT.md).
//
// Who: a logged-in / attached customer with the "employee" tag (Hub adds it
// to active staff from Connecteam and removes it when they are archived).
// What: `rate` % off everything except gift cards, as ONE order discount.
// Cap: Hub writes the customer metafield $app.employee_cap =
//   { "season": "2026-S4", "spent": 580 }  — what already counts toward the
// cap this season (price before discounts & tax, gift cards excluded).
// remaining = cap − spent (a metafield of another season = 0 spent).
//   • remaining ≥ what is in the cart → rate % off (shown as a percentage)
//   • 0 < remaining < cart           → fixed amount = remaining × rate %
//                                       (only the part under the cap)
//   • remaining ≤ 0                   → no discount
// Settings come from the discount's "function-configuration" metafield,
// written by Hub: { "rate": 18, "cap": 600 }.

const MESSAGE = 'Employee Discount';

// Season of a YYYY-MM-DD date (shop's local date): Jan–Mar = S1 … Oct–Dec = S4.
export function seasonOf(isoDate) {
  const [y, m] = String(isoDate || '').split('-').map(Number);
  if (!y || !m) return null;
  return `${y}-S${Math.ceil(m / 3)}`;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

export function cartLinesDiscountsGenerateRun(input) {
  const none = { operations: [] };
  if (!input.discount.discountClasses.includes('ORDER')) return none;

  const customer = input.cart.buyerIdentity && input.cart.buyerIdentity.customer;
  if (!customer || !customer.isEmployee) return none;

  const config = (input.discount.config && input.discount.config.jsonValue) || {};
  const rate = num(config.rate);
  const cap = num(config.cap);
  if (rate <= 0 || rate > 100 || cap <= 0) return none;

  const info = (customer.capInfo && customer.capInfo.jsonValue) || {};
  const season = seasonOf(input.shop.localTime.date);
  const spent = info.season === season ? Math.max(0, num(info.spent)) : 0;
  const remaining = cap - spent;
  if (remaining <= 0) return none;

  // Gift cards are never discounted (and never count toward the cap).
  const giftCardLineIds = [];
  let eligible = 0;
  for (const line of input.cart.lines) {
    const m = line.merchandise;
    if (m && m.__typename === 'ProductVariant' && m.product && m.product.isGiftCard) {
      giftCardLineIds.push(line.id);
    } else {
      eligible += num(line.cost.subtotalAmount.amount);
    }
  }
  if (eligible <= 0) return none;

  const value = remaining >= eligible
    ? { percentage: { value: rate } }
    : { fixedAmount: { amount: round2(remaining * rate / 100) } };
  if (value.fixedAmount && value.fixedAmount.amount <= 0) return none;

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: MESSAGE,
              targets: [{ orderSubtotal: { excludedCartLineIds: giftCardLineIds } }],
              value,
            },
          ],
          selectionStrategy: 'FIRST',
        },
      },
    ],
  };
}
