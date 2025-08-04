const WebSocket = require("ws");

const depthSocket = new WebSocket(
  "wss://fstream.binance.com/ws/solusdt@depth20@100ms"
);
const tradeSocket = new WebSocket(
  "wss://fstream.binance.com/ws/solusdt@aggTrade"
);

let currentBids = new Map();
let currentAsks = new Map();

function updateOrderBook(bids, asks) {
  currentBids.clear();
  currentAsks.clear();

  bids.forEach(([price, qty]) => {
    if (parseFloat(qty) > 0) {
      currentBids.set(price, qty);
    }
  });

  asks.forEach(([price, qty]) => {
    if (parseFloat(qty) > 0) {
      currentAsks.set(price, qty);
    }
  });
}

depthSocket.on("message", (data) => {
  const json = JSON.parse(data);
  updateOrderBook(json.b, json.a);
});

tradeSocket.on("message", (data) => {
  const trade = JSON.parse(data);
  const price = trade.p;
  const qty = trade.q;
  const isSell = trade.m;

  const side = isSell ? "SELL" : "BUY";
  const existed = isSell ? currentBids.has(price) : currentAsks.has(price);

  // Nếu giá này không còn trong depth → khả năng khớp lệnh
  if (!existed) {
    console.log(`[TRADE] ${side} ${qty} SOL @ ${price} (LIKELY MATCHED)`);
  }
});

function printBidAskBuckets(result) {
  console.clear();
  console.log("=== Bid/Ask Bucket Summary ===\n");
  const sorted = Object.keys(result).sort(
    (a, b) => parseFloat(b) - parseFloat(a)
  );

  for (const bucket of sorted) {
    const b = result[bucket].bid || {};
    const a = result[bucket].ask || {};
    const bLarge = b.large || 0,
      aLarge = a.large || 0;

    console.log(`Price ${bucket}:
  BID: ${b.totalValue?.toFixed(2) || "0"} (Real: ${bLarge.toFixed(2)})
  ASK: ${a.totalValue?.toFixed(2) || "0"} (Real: ${aLarge.toFixed(2)})
`);
  }
}
