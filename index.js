const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const BASE_URL = "https://fapi.binance.com";
const SYMBOL = "SOLUSDT";
const LEVERAGE = 5;

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// === Хранилище состояния ===
async function loadLastSignal() {
  const { data, error } = await supabase
    .from("bot_state")
    .select("lastSignal")
    .eq("id", 1)
    .limit(1);

  if (error || !data || data.length === 0) {
    console.error("❌ Ошибка при загрузке состояния:", error || "No rows found");
    return null;
  }

  console.log("📥 Загружено состояние из Supabase:", data[0].lastSignal);
  return data[0].lastSignal;
}

async function saveLastSignal(signal) {
  const { error } = await supabase
    .from("bot_state")
    .upsert({ id: 1, lastSignal: signal });

  if (error) {
    console.error("❌ Ошибка при сохранении в Supabase:", error);
  } else {
    console.log("✅ lastSignal обновлён в Supabase:", signal);
  }
}

// === Binance методы ===
function getSignature(query) {
  return crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
}

async function signedRequest(method, path, params = {}) {
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = getSignature(query);
  const url = `${BASE_URL}${path}?${query}&signature=${signature}`;
  const headers = { "X-MBX-APIKEY": API_KEY };
  const res = await axios({ method, url, headers });
  return res.data;
}

async function getBalance() {
  const balances = await signedRequest("GET", "/fapi/v2/balance");
  const usdt = balances.find(b => b.asset === "USDT");
  return parseFloat(usdt.balance);
}

async function getPrice() {
  const res = await axios.get(`${BASE_URL}/fapi/v1/ticker/price?symbol=${SYMBOL}`);
  return parseFloat(res.data.price);
}

async function getPosition() {
  const positions = await signedRequest("GET", "/fapi/v2/positionRisk");
  const pos = positions.find(p => p.symbol === SYMBOL);
  return parseFloat(pos.positionAmt);
}

async function cancelAllOrders() {
  await signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: SYMBOL });
}

async function closePosition() {
  const posAmt = await getPosition();
  if (posAmt > 0) {
    await signedRequest("POST", "/fapi/v1/order", {
      symbol: SYMBOL,
      side: "SELL",
      type: "MARKET",
      quantity: Math.abs(posAmt),
    });
  } else if (posAmt < 0) {
    await signedRequest("POST", "/fapi/v1/order", {
      symbol: SYMBOL,
      side: "BUY",
      type: "MARKET",
      quantity: Math.abs(posAmt),
    });
  }
}

async function setLeverageAndMargin() {
  try {
    await signedRequest("POST", "/fapi/v1/leverage", {
      symbol: SYMBOL,
      leverage: LEVERAGE,
    });
    await signedRequest("POST", "/fapi/v1/marginType", {
      symbol: SYMBOL,
      marginType: "ISOLATED",
    });
  } catch (e) {}
}

async function openPosition(direction) {
  await setLeverageAndMargin();
  await cancelAllOrders();
  await closePosition();

  const balance = await getBalance();
  const price = await getPrice();

  const exchangeInfo = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
  const symbolInfo = exchangeInfo.data.symbols.find(s => s.symbol === SYMBOL);
  const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === "LOT_SIZE");
  const stepSize = parseFloat(lotSizeFilter.stepSize);
  const precision = Math.round(-Math.log10(stepSize));

  const qty = ((balance * LEVERAGE * 0.95) / price).toFixed(precision);
  const side = direction === "long" ? "BUY" : "SELL";
  const stopSide = direction === "long" ? "SELL" : "BUY";

  console.log(`[+] Открываем ${direction.toUpperCase()} на ${qty} SOL...`);
  await signedRequest("POST", "/fapi/v1/order", {
    symbol: SYMBOL,
    side,
    type: "MARKET",
    quantity: qty,
  });

  const stopPrice = direction === "long"
    ? (price * 0.80).toFixed(2)
    : (price * 1.20).toFixed(2);

  await signedRequest("POST", "/fapi/v1/order", {
    symbol: SYMBOL,
    side: stopSide,
    type: "STOP_MARKET",
    stopPrice,
    closePosition: true,
    timeInForce: "GTC",
    workingType: "MARK_PRICE",
  });

  const takeProfitPrice = direction === "long"
    ? (price * 1.005).toFixed(2)
    : (price * 0.995).toFixed(2);

  await signedRequest("POST", "/fapi/v1/order", {
    symbol: SYMBOL,
    side: stopSide,
    type: "TAKE_PROFIT_MARKET",
    stopPrice: takeProfitPrice,
    closePosition: true,
    timeInForce: "GTC",
    workingType: "MARK_PRICE",
  });
}

// === Webhook логика
let lastSignal = null;

async function startBot() {
  lastSignal = await loadLastSignal() || null;

  app.post("/webhook", async (req, res) => {
    const message = req.body.message;
    console.log(`📨 Получен сигнал: ${message}`);

    try {
      if (message === "SuperTrend Buy!" && lastSignal !== "buy") {
        await openPosition("long");
        lastSignal = "buy";
        await saveLastSignal("buy");
      } else if (message === "SuperTrend Sell!" && lastSignal !== "sell") {
        await openPosition("short");
        lastSignal = "sell";
        await saveLastSignal("sell");
      } else {
        console.log("⚠️ Повторный сигнал — пропущен.");
      }

      res.status(200).send("OK");
    } catch (err) {
      console.error("❌ Ошибка:", err.response?.data || err.message);
      res.status(500).send("Ошибка");
    }
  });

  app.get("/", (req, res) => {
    res.send("🚀 Bot is running and waiting for signals!");
  });

  app.listen(3000, () => {
    console.log("✅ Бот запущен на порту 3000 и готов к бою!");
  });
}

startBot();
