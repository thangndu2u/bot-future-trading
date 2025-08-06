// hedge-sim-map-fixed.js
const WebSocket = require("ws");

const SYMBOL = "solusdt";
const DEPTH_WS = `wss://fstream.binance.com/ws/${SYMBOL}@depth@100ms`;
const AGGTRADE_WS = `wss://fstream.binance.com/ws/${SYMBOL}@aggTrade`;
const MARKPRICE_WS = `wss://fstream.binance.com/ws/${SYMBOL}@markPrice`;

// Tham số chiến lược
const TH = 3; // threshold imbalance
const ORDER_UNIT = 10; // USDT per entry
const CAPITAL_LIMIT = 100; // tổng USDT có thể dùng
const SPREAD = 0.001; // 0.1%

// State chung
let state = {
  longEntry: null, // { price, qty }
  shortEntry: null, // { price, qty }
  longHedges: new Map(), // Map<targetPrice, qty>
  shortHedges: new Map(), // Map<targetPrice, qty>
  longQty: 0,
  shortQty: 0,
  closedCycles: 0,
  profit: 0,
};

// Biến lưu giá cuối nhận được
let lastAggTrade = null; // sẽ lưu object { p, m, ... }
let lastMarkPrice = null; // sẽ lưu giá string

// Tính imbalance
function calcImb(depth) {
  const b0 = depth.b[0] ? +depth.b[0][1] : 0;
  const a0 = depth.a[0] ? +depth.a[0][1] : 0;
  return a0 > 0 ? b0 / a0 : 0;
}

// Kết nối markPrice để lấy giá tham chiếu
const mpSock = new WebSocket(MARKPRICE_WS);
mpSock.on("message", (msg) => {
  const data = JSON.parse(msg);
  lastMarkPrice = data.p; // trường p chứa giá mark
});

// Kết nối aggTrade để biết giá khớp gần nhất
const atSock = new WebSocket(AGGTRADE_WS);
atSock.on("message", (msg) => {
  lastAggTrade = JSON.parse(msg);
});

// Kết nối depth để ra tín hiệu entry/hedge
const dSock = new WebSocket(DEPTH_WS);
dSock.on("message", (data) => {
  const d = JSON.parse(data);
  const bestAsk = d.a[0]; // [price, vol]
  const bestBid = d.b[0];
  if (!bestAsk || !bestBid || !lastAggTrade || !lastMarkPrice) return;

  // Tính score
  const bidVol = +bestBid[1];
  const askVol = +bestAsk[1];
  const spread = +bestAsk[0] - +bestBid[0];
  const liqRatio = bidVol / askVol;
  const priceDiff = +lastAggTrade.p - +lastMarkPrice;

  let score = 0;
  if (liqRatio > 4) score++;
  if (liqRatio > 5.5) score++;
  if (liqRatio < 0.4) score--;
  if (spread < 0.002) score++;
  if (spread > 0.01) score--;
  if (priceDiff > 0) score++;
  else if (priceDiff < 0) score--;

  // Tính vốn đang dùng và slots còn trống
  const capitalInUse =
    (state.longEntry ? state.longEntry.qty * state.longEntry.price : 0) +
    (state.shortEntry ? state.shortEntry.qty * state.shortEntry.price : 0);
  const openSlots = Math.max(0, CAPITAL_LIMIT - capitalInUse);

  // Ra lệnh Long nếu thỏa
  if (score >= 2 && openSlots >= ORDER_UNIT) {
    const buyPrice = +bestBid[0] - 0.01;
    const qty = +(ORDER_UNIT / buyPrice).toFixed(2);
    const hedgeTarget1 = +(buyPrice * (1 + SPREAD)).toFixed(4);
    // Bạn có thể chỉ dùng 1 hedge hoặc tạo 2 target
    buySimulator({ buyPrice, qty, hedgeTarget: hedgeTarget1 });
  }
  // Ra lệnh Short nếu thỏa
  else if (score <= -3 && openSlots >= ORDER_UNIT) {
    const sellPrice = +bestAsk[0] + 0.01;
    const qty = +(ORDER_UNIT / sellPrice).toFixed(2);
    const hedgeTarget = +(sellPrice * (1 - SPREAD)).toFixed(4);
    sellSimulator({ sellPrice, qty, hedgeTarget });
  }

  // In summary
  const pendingEntries = (state.longEntry ? 1 : 0) + (state.shortEntry ? 1 : 0);
  const activeHedges = state.longHedges.size + state.shortHedges.size;
  console.clear();
  console.log(`Score           : ${score}`);
  console.log(`Pending entries : ${pendingEntries}`);
  console.log(`Active hedges   : ${activeHedges}`);
  console.log(`Long qty held   : ${state.longQty.toFixed(4)}`);
  console.log(`Short qty held  : ${state.shortQty.toFixed(4)}`);
  console.log(`Closed cycles   : ${state.closedCycles}`);
  console.log(`Total profit    : ${state.profit.toFixed(4)} USDT`);
});

// Xử lý fill qua aggTrade ticks
atSock.on("message", (msg) => {
  const t = JSON.parse(msg);
  const p = +t.p;

  // Long entry fill?
  if (state.longEntry && p <= state.longEntry.price) {
    console.log(`[FILL] LONG ENTRY @${p.toFixed(4)}`);
    state.longQty += state.longEntry.qty;
    state.longEntry = null;
  }

  // Long hedge fill?
  for (let [target, { qty }] of state.longHedges) {
    if (p >= target) {
      console.log(`[FILL] LONG HEDGE @${p.toFixed(4)}`);
      // 1. trừ longQty
      state.longQty = Math.max(0, state.longQty - qty);
      // 2. cộng profit cố định
      state.profit += ORDER_UNIT * SPREAD;
      // 3. xóa hedge
      state.longHedges.delete(target);
      state.closedCycles++;
    }
  }

  // Short entry fill?
  if (state.shortEntry && p >= state.shortEntry.price) {
    console.log(`[FILL] SHORT ENTRY @${p.toFixed(4)}`);
    state.shortQty += state.shortEntry.qty;
    state.shortEntry = null;
  }

  // SHORT HEDGE fill?
  for (let [target, { qty }] of state.shortHedges) {
    if (p <= target) {
      console.log(`[FILL] SHORT HEDGE @${p.toFixed(4)}`);
      state.shortQty = Math.max(0, state.shortQty - qty);
      state.profit += ORDER_UNIT * SPREAD;
      state.shortHedges.delete(target);
      state.closedCycles++;
    }
  }
});

// Remind: clean up on exit
process.on("SIGINT", () => {
  console.log("\nShutting down…");
  dSock.close();
  atSock.close();
  mpSock.close();
  process.exit();
});

function buySimulator({ buyPrice, qty, hedgeTarget }) {
  state.longQty += qty;
  state.longHedges.set(hedgeTarget, { qty });
  console.log(
    `[SIM] ENTRY LONG_FILLED @${buyPrice.toFixed(4)} qty=${qty.toFixed(4)}`
  );
  console.log(`[SIM] PLACE LONG HEDGE @${hedgeTarget.toFixed(4)}`);
}

function sellSimulator({ sellPrice, qty, hedgeTarget }) {
  state.shortQty += qty;
  state.shortHedges.set(hedgeTarget, { qty });
  console.log(
    `[SIM] ENTRY SHORT_FILLED @${sellPrice.toFixed(4)} qty=${qty.toFixed(4)}`
  );
  console.log(`[SIM] PLACE SHORT HEDGE @${hedgeTarget.toFixed(4)}`);
}
