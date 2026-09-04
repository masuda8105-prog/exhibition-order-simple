// Remove both in-memory order data and rendered copies of customer information.
// Keep authentication, products and terminal settings available for the next order.
export function clearOrderData(state, containers) {
  state.draft = null;
  state.createdAt = null;
  for (const container of containers) container.replaceChildren();
}
