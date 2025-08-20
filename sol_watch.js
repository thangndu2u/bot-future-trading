// sol_watch.js
// Node 18+; cần `npm i ws`
// Lấy depth10@100ms cho SOLUSDT Futures và log metrics mỗi 30s.

const WebSocket = require("ws");

// --------- Config ----------
const SYMBOL = "solusdt";
const STREAM_URL = `wss://fstream.binance.com/ws/${SYMBOL}@depth10@100ms`;
const TICK_MS = 100; // kỳ vọng 100ms/tick
const WINDOW_SHORT_SEC = 5; // ~5s
const WINDOW_LONG_SEC = 30; // ~60s
const CLUSTER_WIDTH_PCT = 0.003; // ±0.3%
const CLUSTER_HORIZON_SEC = 10;
const LOG_EVERY_SEC = 30;
const TOP_N = 5;

// sweep/gap/OFI thresholds (khởi điểm; chỉnh theo thực tế)
const SWEEP_PCT = 0.4; // 40% top-N biến mất trong 200ms coi như sweep
const GAP_ALERT = 0.4; // gap >40% so với mean depth coi là thiếu thanh khoản

// --------- Helpers ----------
const now = () => Date.now();
const mid = (b, a) => (b + a) / 2;
const pct = (x, base) => (base ? (x - base) / base : 0);

class Rolling {
  constructor(cap) {
    this.cap = cap;
    this.buf = [];
    this.sum = 0;
    this.sumsq = 0;
  }
  push(x) {
    this.buf.push(x);
    this.sum += x;
    this.sumsq += x * x;
    if (this.buf.length > this.cap) {
      const y = this.buf.shift();
      this.sum -= y;
      this.sumsq -= y * y;
    }
  }
  get n() {
    return this.buf.length;
  }
  mean() {
    return this.n ? this.sum / this.n : 0;
  }
  std() {
    if (this.n < 2) return 0;
    const mu = this.mean();
    const v = this.sumsq / this.n - mu * mu;
    return Math.sqrt(Math.max(v, 0));
  }
  last() {
    return this.buf[this.buf.length - 1];
  }
  z(x) {
    const s = this.std();
    return s === 0 ? 0 : (x - this.mean()) / s;
  }
}

// --------- State ----------
const shortCap = Math.ceil(WINDOW_SHORT_SEC * (1000 / TICK_MS)); // ~50
const longCap = Math.ceil(WINDOW_LONG_SEC * (1000 / TICK_MS)); // ~600
const horizonCap = Math.ceil(CLUSTER_HORIZON_SEC * (1000 / TICK_MS)); // ~100

const spreadRoll = new Rolling(longCap);
const absRetRoll = new Rolling(shortCap); // |log-return(mid)|
const obiRoll = new Rolling(shortCap); // imbalance short window
const ofiRoll = new Rolling(shortCap); // order flow imbalance short window
const depthSumRoll = new Rolling(longCap); // total depth (bid+ask) top-N

let lastMid = null;
let lastBid = null,
  lastAsk = null,
  lastBidQty = null,
  lastAskQty = null;

// cluster flips tracking
let clusterRefMid = null;
let clusterHistory = []; // {ts, id}

// sweep tracking (volume change within ~200ms)
const sweepWindowMs = 200;
let volHistory = []; // {ts, bidTopN, askTopN}

// timers
let lastLogTs = 0;

// --------- Core calc ---------

/** Compute OFI at top of book (Cont & Kukanov simplified) */
function computeOFI(bid, ask, bidQty, askQty) {
  if (lastBid == null || lastAsk == null) return 0;
  let ofi = 0;

  // Bid side contribution
  if (bid > lastBid) {
    ofi += bidQty; // price up → aggressive buy
  } else if (bid < lastBid) {
    ofi -= lastBidQty || 0; // price down on bid → sell pressure
  } else {
    ofi += bidQty - (lastBidQty || 0); // same price, qty grows/shrinks
  }

  // Ask side contribution (note the sign)
  if (ask < lastAsk) {
    ofi += lastAskQty || 0; // ask moves down → buy pressure
  } else if (ask > lastAsk) {
    ofi -= askQty; // ask moves up → sell pressure
  } else {
    ofi -= askQty - (lastAskQty || 0);
  }

  return ofi;
}

/** cluster id by ±pct width around reference */
function clusterId(price, ref, pctWidth) {
  const rel = (price - ref) / (ref || price);
  return Math.floor(rel / pctWidth);
}

/** Push cluster flips within horizon */
function updateCluster(midPrice, ts) {
  if (!clusterRefMid) clusterRefMid = midPrice;
  const id = clusterId(midPrice, clusterRefMid, CLUSTER_WIDTH_PCT);
  clusterHistory.push({ ts, id });
  while (
    clusterHistory.length &&
    clusterHistory[0].ts < ts - CLUSTER_HORIZON_SEC * 1000
  ) {
    clusterHistory.shift();
  }
  // count flips
  let flips = 0;
  for (let i = 1; i < clusterHistory.length; i++) {
    if (clusterHistory[i].id !== clusterHistory[i - 1].id) flips++;
  }
  return flips;
}

/** track sweep by checking top-N sum change over ~200ms */
function detectSweep(bidTopN, askTopN, ts) {
  volHistory.push({ ts, bidTopN, askTopN });
  while (volHistory.length && volHistory[0].ts < ts - sweepWindowMs) {
    volHistory.shift();
  }
  if (volHistory.length < 2)
    return { askSweep: false, bidSweep: false, askDrop: 0, bidDrop: 0 };

  const first = volHistory[0];
  const askDrop =
    first.askTopN > 0 ? (first.askTopN - askTopN) / first.askTopN : 0;
  const bidDrop =
    first.bidTopN > 0 ? (first.bidTopN - bidTopN) / first.bidTopN : 0;

  return {
    askSweep: askDrop >= SWEEP_PCT,
    bidSweep: bidDrop >= SWEEP_PCT,
    askDrop,
    bidDrop,
  };
}

/** summarize and log every 30s */
function maybeLog(ts) {
  if (!lastLogTs) lastLogTs = ts;
  if (ts - lastLogTs < LOG_EVERY_SEC * 1000) return;

  lastLogTs = ts;

  const summary = {
    t: new Date(ts).toISOString(),
    spread_cur: spreadRoll.last(),
    spread_mean: spreadRoll.mean().toFixed(6),
    spread_std: spreadRoll.std().toFixed(6),
    spread_z: spreadRoll.z(spreadRoll.last()).toFixed(2),

    absret_mean: absRetRoll.mean().toExponential(3),
    absret_std: absRetRoll.std().toExponential(3),
    absret_last: absRetRoll.last()?.toExponential(3) ?? null,
    vol_z: absRetRoll.z(absRetRoll.last() ?? 0).toFixed(2),

    obi_mean: obiRoll.mean().toFixed(4),
    obi_std: obiRoll.std().toFixed(4),
    obi_last: obiRoll.last()?.toFixed(4) ?? null,
    obi_z: obiRoll.z(obiRoll.last() ?? 0).toFixed(2),

    ofi_mean: ofiRoll.mean().toFixed(4),
    ofi_std: ofiRoll.std().toFixed(4),
    ofi_last: ofiRoll.last()?.toFixed(4) ?? null,
    ofi_z: ofiRoll.z(ofiRoll.last() ?? 0).toFixed(2),

    depth_mean: depthSumRoll.mean().toFixed(2),
    depth_cur: depthSumRoll.last()?.toFixed(2) ?? null,
    depth_gap: (() => {
      const m = depthSumRoll.mean();
      const cur = depthSumRoll.last() || 0;
      return m > 0 ? (1 - cur / m).toFixed(2) : "0.00";
    })(),

    cluster_flips_10s: (() => {
      let flips = 0;
      for (let i = 1; i < clusterHistory.length; i++) {
        if (clusterHistory[i].id !== clusterHistory[i - 1].id) flips++;
      }
      return flips;
    })(),
  };

  const gap = Number(summary.depth_gap);
  const regimeBad =
    Number(summary.spread_z) >= 3.0 ||
    Number(summary.vol_z) >= 3.0 ||
    summary.cluster_flips_10s >= 4 ||
    gap >= GAP_ALERT;

  summary.regime = regimeBad ? "Bad" : "Good";

  console.log("--- 30s METRICS (SOLUSDT Futures) ---");
  console.table(summary);
}

// --------- WS consume ----------
function start() {
  const ws = new WebSocket(STREAM_URL);

  ws.on("open", () => {
    console.log("[WS] Connected:", STREAM_URL);
  });

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);

      // data: { e,u,E, T?,bids:[[p,q]...], asks:[[p,q]...] } inside combined stream wrapper
      const bids = data.b;
      const asks = data.a;
      if (!bids?.length || !asks?.length) {
        console.log("erro");
        return;
      }

      const ts = now();
      const bid0 = parseFloat(bids[0][0]);
      const ask0 = parseFloat(asks[0][0]);
      const bid0Qty = parseFloat(bids[0][1]);
      const ask0Qty = parseFloat(asks[0][1]);

      const m = mid(bid0, ask0);
      const spread = ask0 - bid0;

      // top-N volume sums
      let bidTopN = 0,
        askTopN = 0;
      for (let i = 0; i < Math.min(TOP_N, bids.length); i++)
        bidTopN += parseFloat(bids[i][1]);
      for (let i = 0; i < Math.min(TOP_N, asks.length); i++)
        askTopN += parseFloat(asks[i][1]);

      // updates
      spreadRoll.push(spread);
      depthSumRoll.push(bidTopN + askTopN);

      if (lastMid != null) {
        const r = Math.abs(Math.log(m / lastMid));
        absRetRoll.push(r);
      }
      lastMid = m;

      // imbalance (OBI) using top-N
      const obi =
        bidTopN + askTopN > 0 ? (bidTopN - askTopN) / (bidTopN + askTopN) : 0;
      obiRoll.push(obi);

      // OFI
      const ofi = computeOFI(bid0, ask0, bid0Qty, ask0Qty);
      ofiRoll.push(ofi);

      // cluster flips & sweep detect
      updateCluster(m, ts);
      const { askSweep, bidSweep } = detectSweep(bidTopN, askTopN, ts);

      // keep last top-levels for OFI next step
      lastBid = bid0;
      lastAsk = ask0;
      lastBidQty = bid0Qty;
      lastAskQty = ask0Qty;

      // quick inline alerts (optional – comment out nếu không cần spam)
      if (askSweep) {
        console.log(`[ALERT] Ask sweep detected, ${askSweep}`);
      }
      if (bidSweep) {
        console.log(`[ALERT] Bid sweep detected, ${bidSweep}`);
      }

      // periodic log
      maybeLog(ts);
    } catch (err) {
      // combined stream có thể trả heartbeat; ignore parse errors nhẹ
      console.error("parse error", err);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Closed. Reconnecting in 1s…");
    setTimeout(start, 1000);
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
    try {
      ws.close();
    } catch {}
  });
}

start();
