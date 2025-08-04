const WebSocket = require("ws");

const SYMBOL = "solusdt";
const STREAM_URL = `wss://fstream.binance.com/ws/${SYMBOL}@depth10@100ms`;

// ----- Bucketize logic (step 0.1) -----
function bucketize(price) {
  return (Math.floor(price * 10) / 10).toFixed(1);
}

// ----- Build bucket summary -----
function pairBidAsk(bids, asks) {
  const buckets = {};

  for (const [priceStr, qtyStr] of bids) {
    const price = parseFloat(priceStr);
    const qty = parseFloat(qtyStr);
    const value = price * qty;
    const bucket = bucketize(price);

    if (!buckets[bucket]) buckets[bucket] = { bid: 0, ask: 0 };
    buckets[bucket].bid += value;
  }

  for (const [priceStr, qtyStr] of asks) {
    const price = parseFloat(priceStr);
    const qty = parseFloat(qtyStr);
    const value = price * qty;
    const bucket = bucketize(price);

    if (!buckets[bucket]) buckets[bucket] = { bid: 0, ask: 0 };
    buckets[bucket].ask += value;
  }

  return buckets;
}

// ----- In ra cặp BID/ASK từng vùng -----
function printBidAskPairs(buckets) {
  console.clear();
  console.log("=== Bid/Ask Pair Summary (SOL/USDT) ===\n");

  const sorted = Object.keys(buckets)
    .map(parseFloat)
    .sort((a, b) => b - a)
    .map((p) => p.toFixed(1));

  for (const bucket of sorted) {
    const b = buckets[bucket];
    const imbalance =
      b.bid > b.ask * 3 ? ">>>" : b.ask > b.bid * 3 ? "<<<" : "   ";
    console.log(
      `Price ${bucket} | BID: ${b.bid.toFixed(2).padStart(8)} | ASK: ${b.ask
        .toFixed(2)
        .padStart(8)} ${imbalance}`
    );
  }
}

// ----- WebSocket connection -----
function start() {
  const ws = new WebSocket(STREAM_URL);

  ws.on("open", () => {
    console.log("✅ Connected to Binance Futures WebSocket");
  });

  ws.on("message", (data) => {
    try {
      const json = JSON.parse(data);
      const bids = json.b;
      const asks = json.a;

      const buckets = pairBidAsk(bids, asks);
      printBidAskPairs(buckets);
    } catch (err) {
      console.error("Parsing error:", err);
    }
  });

  ws.on("close", () => {
    console.log("❌ Disconnected. Reconnecting...");
    setTimeout(start, 3000);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
}

start();
