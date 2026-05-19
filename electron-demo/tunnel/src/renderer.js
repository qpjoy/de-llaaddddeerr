// Demo landing page logic. Two buttons, both invoke main-process IPC.
const api = window.qpjoyDemo;

document.getElementById('btn-market').addEventListener('click', () => {
  void api.openMarket();
});

document.getElementById('btn-market-new').addEventListener('click', () => {
  void api.openMarketInNewWindow();
});
