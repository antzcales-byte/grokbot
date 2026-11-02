/* Paper dashboard. Account numbers come from data/snapshot.json.
   Candles are fetched in the browser from the public Coinbase API. */
(function () {
  const STALE_MS = 10 * 60 * 1000;
  const REFRESH_MS = 60 * 1000;
  const PRODUCTS = [
    { product: "BTC-USD", symbol: "BTC" },
    { product: "ETH-USD", symbol: "ETH" },
    { product: "SOL-USD", symbol: "SOL" },
  ];
  const TIMEFRAMES = {
    "1H": { granularity: 3600, aggregate: null, snapshot: "1H" },
    "4H": { granularity: 3600, aggregate: 14400, snapshot: "4H" },
    "1D": { granularity: 86400, aggregate: null, snapshot: "1D" },
  };
  const POS = ["#3dd68c", "#8ef0b8", "#1f8a5b", "#b6f2d0"];
  const NEG = ["#ff5d73", "#ff9aab", "#d63a52", "#ffc2cb"];

  const state = {
    snapshot: null,
    error: null,
    tf: "1H",
    lastClose: {},
    candleSource: {},
    nextRefresh: Date.now() + REFRESH_MS,
  };
  const charts = {};
  let refreshing = false;
  let candleToken = 0;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function parseTime(value) {
    if (value == null || value === "") return NaN;
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    let text = String(value).trim();
    if (!text) return NaN;
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
      if (text.includes(" ") && !text.includes("T")) text = text.replace(" ", "T");
      return Date.parse(text);
    }
    text = text.replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T00:00:00";
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) text += ":00";
    return Date.parse(text + "Z");
  }

  function fmtTs(value) {
    const ms = typeof value === "number" && value > 1e12 ? value : parseTime(value);
    if (!Number.isFinite(ms)) return value ? String(value) : "—";
    return new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
  }

  function ageLabel(ms) {
    const seconds = Math.max(0, (Date.now() - ms) / 1000);
    if (seconds < 45) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
    return Math.floor(seconds / 86400) + "d ago";
  }

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  function money(value, signed) {
    const n = num(value);
    if (!Number.isFinite(n)) return "—";
    const body = Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (!signed) return (n < 0 ? "-" : "") + "$" + body;
    if (n > 0) return "+$" + body;
    if (n < 0) return "-$" + body;
    return "$" + body;
  }

  function priceFmt(value) {
    const n = num(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function pctFmt(value, digits) {
    const n = num(value);
    if (!Number.isFinite(n)) return "—";
    const places = digits == null ? 2 : digits;
    const body = Math.abs(n).toFixed(places) + "%";
    if (n > 0) return "+" + body;
    if (n < 0) return "-" + body;
    return body.replace("+", "");
  }

  function trimNum(value, digits) {
    const n = num(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", { maximumFractionDigits: digits });
  }

  function compactUsd(value) {
    const n = num(value);
    if (!Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1e12) return sign + "$" + (abs / 1e12).toFixed(2) + "T";
    if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
    return money(n, false);
  }

  function snapshotMillis(data) {
    if (!data) return NaN;
    const generated = parseTime(data.generated);
    if (Number.isFinite(generated)) return generated;
    const heartbeat = parseTime(data.status && data.status.heartbeat);
    if (Number.isFinite(heartbeat)) return heartbeat;
    const series = data.equity_series || [];
    if (series.length) return parseTime(series[series.length - 1][0]);
    return NaN;
  }

  function isStale(data) {
    const ms = snapshotMillis(data);
    return !Number.isFinite(ms) || Date.now() - ms > STALE_MS;
  }

  function instrumentEntries(data) {
    return Object.entries((data && data.instruments) || {});
  }

  function productName(symbol, data) {
    const inst = ((data && data.instruments) || {})[symbol];
    if (inst && inst.name) return inst.name;
    const text = String(symbol || "");
    if (text.endsWith("USD") && text.indexOf("-") === -1) return text.slice(0, -3) + "-USD";
    return text || "—";
  }

  function sideLabel(side) {
    const n = Number(side);
    if (n > 0) return "LONG";
    if (n < 0) return "SHORT";
    return "—";
  }

  function isClosed(trade) {
    return !!(trade && trade.exit_time != null && String(trade.exit_time).trim() !== "");
  }

  function allTrades(data) {
    const trades = data && Array.isArray(data.trades) ? data.trades.slice() : [];
    const seen = new Set(trades.map(function (trade) {
      return trade && trade.id != null ? "id:" + trade.id : "";
    }));
    instrumentEntries(data).forEach(function (entry) {
      ((entry[1] && entry[1].open) || []).forEach(function (trade) {
        if (!trade) return;
        const key = trade.id != null ? "id:" + trade.id : "row:" + trade.symbol + "|" + trade.entry_time + "|" + trade.entry;
        if (seen.has(key)) return;
        seen.add(key);
        trades.push(trade);
      });
    });
    return trades;
  }

  function validBar(bar) {
    if (!bar || !Number.isFinite(bar.time)) return false;
    const prices = [bar.open, bar.high, bar.low, bar.close].map(Number);
    if (!prices.every(Number.isFinite)) return false;
    const high = prices[1];
    const low = prices[2];
    return high >= low && high >= prices[0] && high >= prices[3] && low <= prices[0] && low <= prices[3];
  }

  function uniqBars(bars) {
    const byTime = new Map();
    (bars || []).forEach(function (bar) {
      if (!validBar(bar)) return;
      byTime.set(bar.time, bar);
    });
    return Array.from(byTime.keys()).sort(function (a, b) { return a - b; }).map(function (time) {
      return byTime.get(time);
    });
  }

  function aggregate(bars, seconds) {
    const buckets = new Map();
    uniqBars(bars).forEach(function (bar) {
      const key = Math.floor(bar.time / seconds) * seconds;
      const current = buckets.get(key);
      if (!current) {
        buckets.set(key, { time: key, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      } else {
        current.high = Math.max(current.high, bar.high);
        current.low = Math.min(current.low, bar.low);
        current.close = bar.close;
      }
    });
    return Array.from(buckets.values()).sort(function (a, b) { return a.time - b.time; });
  }

  function fromCoinbase(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(function (row) {
      return { time: Number(row[0]), open: Number(row[3]), high: Number(row[2]), low: Number(row[1]), close: Number(row[4]) };
    }).filter(function (bar) {
      return [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite);
    });
  }

  function fromSnapshot(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(function (row) {
      return { time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) };
    }).filter(function (bar) {
      return [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite);
    });
  }

  function renderFreshness() {
    const badge = document.getElementById("freshness");
    const text = badge.querySelector(".badge-text");
    const generated = document.getElementById("generated");
    const eta = document.getElementById("refresh-eta");
    const seconds = Math.max(0, Math.round((state.nextRefresh - Date.now()) / 1000));
    eta.textContent = "Auto-refresh in " + seconds + "s";
    if (!state.snapshot) {
      badge.className = "badge stale";
      text.textContent = "STALE";
      generated.textContent = state.error ? "Snapshot unavailable" : "Loading snapshot…";
      return;
    }
    const ms = snapshotMillis(state.snapshot);
    const stale = isStale(state.snapshot);
    badge.className = stale ? "badge stale" : "badge live";
    text.textContent = stale ? "STALE" : "LIVE";
    generated.textContent = (Number.isFinite(ms)
      ? "Snapshot " + fmtTs(ms) + " · " + ageLabel(ms)
      : "Snapshot time unknown") + (state.error ? " · refresh failed" : "");
  }

  function goalModel(data) {
    const equity = num(data.equity);
    const start = num(data.start);
    const explicit = data.goal != null && data.goal !== "" && Number.isFinite(num(data.goal));
    if (explicit) {
      const goal = num(data.goal);
      const span = goal - start;
      let raw = 0;
      if (!Number.isFinite(span) || span === 0) raw = equity >= goal ? 100 : 0;
      else raw = ((equity - start) / span) * 100;
      return {
        title: "Equity target " + money(goal, false),
        width: Math.max(0, Math.min(100, raw)),
        detail: trimNum(raw, 1) + "% of the way from " + money(start, false) + " to " + money(goal, false),
        tone: equity < start ? "bad" : raw >= 100 ? "good" : "flat",
      };
    }
    const ratio = Number.isFinite(equity) && Number.isFinite(start) && start !== 0 ? (equity / start) * 100 : 0;
    let detail = "No profit target in this snapshot. Bar is equity relative to starting capital.";
    if (Number.isFinite(equity) && Number.isFinite(start)) {
      if (equity > start) detail = "Above start by " + money(equity - start, true) + ". No separate profit target in this snapshot.";
      else if (equity < start) detail = "Below start by " + money(start - equity, false) + ". No separate profit target in this snapshot.";
      else detail = "Starting capital intact. No profit target in this snapshot.";
    }
    return {
      title: "Preserve start " + (Number.isFinite(start) ? money(start, false) : "—"),
      width: Math.max(0, Math.min(100, ratio)),
      detail: detail,
      tone: !Number.isFinite(equity) || !Number.isFinite(start) ? "flat" : equity > start ? "good" : equity < start ? "bad" : "flat",
    };
  }

  function renderEquity() {
    const data = state.snapshot;
    const equity = num(data.equity);
    const start = num(data.start);
    const peak = num(data.peak);
    const profit = Number.isFinite(equity) && Number.isFinite(start) ? equity - start : NaN;
    const ret = Number.isFinite(profit) && start ? (profit / start) * 100 : NaN;
    const tone = profit > 0 ? "up" : profit < 0 ? "down" : "flat";
    const goal = goalModel(data);
    const status = data.status || {};
    const host = document.getElementById("equity-card");
    host.innerHTML =
      '<div class="equity-grid">' +
        '<div><p class="label">Equity</p><p class="big">' + esc(money(equity, false)) + '</p>' +
          '<p class="muted">Start ' + esc(money(start, false)) + ' · Peak ' + esc(money(peak, false)) + '</p></div>' +
        '<div><p class="label">Profit</p><p class="big profit ' + tone + '">' + esc(money(profit, true)) + '</p>' +
          '<p class="muted">' + esc(Number.isFinite(ret) ? pctFmt(ret, 2) : "—") + ' vs start</p></div>' +
        '<div><p class="label">Goal progress</p><p class="goal-caption">' + esc(goal.title) + '</p>' +
          '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + esc(String(Math.round(goal.width))) + '" aria-label="Goal progress">' +
            '<div class="bar-fill ' + goal.tone + '" style="width:' + goal.width.toFixed(2) + '%"></div></div>' +
          '<p class="muted">' + esc(goal.detail) + '</p></div>' +
      '</div>' +
      '<p class="status-line">' + statusLine(status) + '</p>';
  }

  function statusBit(on) {
    return '<span class="' + (on ? "on" : "") + '">' + (on ? "ON" : "off") + "</span>";
  }

  function statusLine(status) {
    const heartbeatMs = parseTime(status.heartbeat);
    const heartbeat = status.heartbeat && Number.isFinite(heartbeatMs)
      ? fmtTs(heartbeatMs) + " (" + ageLabel(heartbeatMs) + ")"
      : "—";
    const scan = status.last_scan ? fmtTs(status.last_scan) : "—";
    const cycles = status.cycles_ok == null ? "—" : String(status.cycles_ok);
    return "Heartbeat " + esc(heartbeat) + " · Last scan " + esc(scan) + " · Cycles " + esc(cycles) +
      " · DD pause (15%) " + statusBit(!!status.killed) +
      " · Day halt " + statusBit(!!status.halt_day) +
      " · Week halt " + statusBit(!!status.halt_week);
  }

  function renderRisk() {
    const data = state.snapshot;
    const risk = data.risk || {};
    const status = data.status || {};
    const sm = data.strategy_mode || {};
    const rules = sm.rules || {};
    const fees = sm.fees || {};
    const rows = [
      { label: "Total open risk", value: sm.open_risk_pct, limit: rules.open_risk_cap_pct || 8, halt: false },
      { label: "Daily loss", value: risk.daily_loss_pct, limit: rules.daily_limit_pct || 2, halt: !!status.halt_day },
      { label: "Weekly loss", value: risk.weekly_loss_pct, limit: rules.weekly_limit_pct || 5, halt: !!status.halt_week },
      { label: "Drawdown (pause at)", value: risk.drawdown_pct, limit: rules.dd_pause_pct || 15, halt: !!status.killed },
    ];
    const html = rows.map(function (row) {
      const value = num(row.value);
      const shown = Number.isFinite(value) ? value : 0;
      const cap = num(row.limit);
      const ratio = cap > 0 ? shown / cap : 0;
      const width = Math.max(0, Math.min(100, ratio * 100));
      const tone = row.halt || ratio >= 1 ? "high" : ratio >= 0.6 ? "mid" : "low";
      return '<div><div class="risk-label"><span>' + esc(row.label) + '</span><span>' + esc(trimNum(shown, 3) + "% / " + trimNum(cap, 3) + "%") + "</span></div>" +
        '<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="' + esc(String(cap)) + '" aria-valuenow="' + esc(String(shown)) + '" aria-label="' + esc(row.label) + '">' +
          '<div class="meter-fill ' + tone + '" style="width:' + width.toFixed(2) + '%"></div></div></div>';
    }).join("");
    const hbMs = parseTime(status.heartbeat_file || status.heartbeat);
    const hbAge = Number.isFinite(hbMs) ? (Date.now() - hbMs) / 1000 : null;
    const hbTone = hbAge == null ? "high" : hbAge > 300 ? "high" : hbAge > 120 ? "mid" : "low";
    const nb = data.next_4h_bar_utc ? new Date(data.next_4h_bar_utc).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET" : "—";
    const nt = data.no_trade || {};
    const why = Object.keys(nt).map(function (k) {
      const r = nt[k] || {};
      return '<li><b>' + esc(k) + '</b> <span class="kind">' + esc(r.gate || "—") + '</span> ' + esc(r.detail || "") +
        (r.ts ? '<div class="muted small">' + esc(fmtTs(r.ts)) + "</div>" : "") + "</li>";
    }).join("");
    document.getElementById("risk-panel").innerHTML =
      '<h2>Risk — Strategy mode</h2>' +
      '<div class="chips">' +
        '<span class="chip">Heartbeat <b class="tone-' + hbTone + '">' + (hbAge == null ? "—" : esc(ageLabel(hbMs))) + "</b></span>" +
        '<span class="chip">Next 4H bar <b>' + esc(nb) + "</b></span>" +
        '<span class="chip">Risk/trade <b>' + esc(String(rules.risk_per_trade_pct || 1)) + "% sized from stop</b></span>" +
        '<span class="chip">Per-coin cap <b>' + esc(String(rules.per_coin_cap_pct || 25)) + "%</b></span>" +
        '<span class="chip">No trade-count cap · stops only tighten</span>' +
      "</div>" +
      '<div class="risk-grid">' + html + "</div>" +
      '<p class="muted small">Cost filter: Coinbase tier <b>' + esc(String(fees.tier || "—").replace(" (fallback)", "")) + "</b> — taker " + esc(String(fees.taker_pct)) + "% / maker " + esc(String(fees.maker_pct)) +
        "% · round trip ≈ " + esc(String(fees.round_trip_pct)) + "% · costs must be &lt; ⅓R → min stop distance <b>" + esc(String(fees.min_stop_pct)) + "%</b></p>" +
      '<h2 class="section-gap">Why no trade</h2>' + (why ? '<ul class="feed">' + why + "</ul>" : '<p class="empty">No reason recorded.</p>');
  }

  function cell(v, d) { return v == null || v === "" ? "—" : esc(typeof v === "number" ? trimNum(v, d == null ? 2 : d) : v); }

  function renderBook() {
    const data = state.snapshot;
    const rows = (data.strategies || []).map(function (s) {
      const st = String(s.status || "");
      const tone = /^on/.test(st) ? "low" : /exper/.test(st) ? "mid" : "";
      return "<tr><td><b>" + esc(s.id) + "</b><div class=\"muted small\">" + esc(s.name) + "</div></td><td><span class=\"pill tone-" + tone + "\">" + esc(st) + "</span></td><td>" +
        cell(s.trades, 0) + "</td><td>" + cell(s.win_rate, 1) + "</td><td>" + cell(s.expectancy_R, 3) + "</td><td>" + cell(s.profit_factor) + "</td></tr>";
    }).join("");
    const bt = (data.backtest || []).map(function (b) {
      const neg = String(b.exp_R).trim().charAt(0) === "-";
      return "<tr><td>" + esc(b.name) + "</td><td>" + esc(b.trades) + "</td><td>" + esc(b.win) + '</td><td class="' + (neg ? "neg" : "pos") + '">' + esc(b.exp_R) + "</td><td>" + esc(b.pf) + "</td><td>" + esc(b.dd) + "</td></tr>";
    }).join("");
    const ev = (data.trade_events || []).slice().reverse().map(function (e) {
      const t = e.is_test ? ' <span class="pill tone-mid">TEST</span>' : "";
      const px = e.event === "exit" ? "exit " + priceFmt(e.exit) + " · " + money(e.pnl_usd, true) + (e.r_result != null ? " (" + trimNum(e.r_result, 2) + "R)" : "") : "@ " + priceFmt(e.price) + " stop " + priceFmt(e.stop);
      return '<li><span class="kind">' + esc(String(e.event || "").toUpperCase()) + "</span> " + esc(e.symbol || "") + " " + esc(e.strategy || e.setup || "") + t + " — " + esc(px) +
        '<div class="muted small">' + esc(fmtTs(e.ts)) + (e.is_test ? " · excluded from stats" : "") + "</div></li>";
    }).join("");
    let host = document.getElementById("book-panel");
    if (!host) { host = document.createElement("section"); host.className = "panel"; host.id = "book-panel"; const r = document.getElementById("risk-panel"); r.parentNode.insertBefore(host, r.nextSibling); }
    host.innerHTML = "<h2>Strategy book (paper, tests excluded)</h2>" +
      '<div class="tscroll"><table class="tbl"><thead><tr><th>Strategy</th><th>Status</th><th>Trades</th><th>Win %</th><th>Exp R</th><th>PF</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<h2 class="section-gap">Walk-forward backtest (OOS 2021–2026, fees in)</h2>' +
      '<div class="tscroll"><table class="tbl"><thead><tr><th>Test</th><th>Trades</th><th>Win %</th><th>Exp R</th><th>PF</th><th>Max DD</th></tr></thead><tbody>' + (bt || '<tr><td colspan="6">No backtest.</td></tr>') + "</tbody></table></div>" +
      '<p class="muted small">Fewer than 30 trades = not proven. S1 4H fails; S1/S2 stay off pending review.</p>' +
      '<h2 class="section-gap">Trade events</h2>' + (ev ? '<ul class="feed">' + ev + "</ul>" : '<p class="empty">No entries or exits yet.</p>');
  }

  function renderStrategy() {
    const data = state.snapshot;
    const closed = allTrades(data).filter(isClosed);
    const totals = new Map();
    closed.forEach(function (trade) {
      const name = String(trade.setup || "unknown");
      totals.set(name, (totals.get(name) || 0) + (num(trade.pnl) || 0));
    });
    const book = instrumentEntries(data).map(function (entry) {
      const inst = entry[1] || {};
      const name = inst.name || entry[0];
      const tag = inst.tag ? ' <span class="tag">' + esc(/experimental/i.test(inst.tag) ? "EXPERIMENTAL" : inst.tag) + "</span>" : "";
      return esc(name) + tag + " " + esc(money(inst.pnl || 0, true));
    }).join(" · ");
    let body;
    if (!closed.length) {
      body = '<p class="empty">No closed trades. Strategy profit will stack here after the paper book closes a trade.</p>';
    } else if (Array.from(totals.values()).every(function (value) { return value === 0; })) {
      body = '<p class="empty">Closed trades net to $0.00. Nothing to stack.</p>' + legend(Array.from(totals.keys()).map(function (name) {
        return { name: name, pnl: 0, color: "#8491a0" };
      }));
    } else {
      const items = Array.from(totals.entries()).map(function (entry) {
        return { name: entry[0], pnl: entry[1] };
      }).sort(function (a, b) { return Math.abs(b.pnl) - Math.abs(a.pnl); });
      let pos = 0;
      let neg = 0;
      items.forEach(function (item) {
        item.color = item.pnl < 0 ? NEG[neg++ % NEG.length] : POS[pos++ % POS.length];
      });
      const absSum = items.reduce(function (sum, item) { return sum + Math.abs(item.pnl); }, 0);
      const segs = items.map(function (item) {
        const width = absSum ? (Math.abs(item.pnl) / absSum) * 100 : 0;
        return '<div class="seg" style="width:' + width.toFixed(3) + "%;background:" + item.color + '" title="' + esc(item.name + " " + money(item.pnl, true)) + '"></div>';
      }).join("");
      body = '<div class="stack" aria-hidden="true">' + segs + "</div>" + legend(items);
    }
    document.getElementById("strategy-panel").innerHTML =
      "<h2>Profit by strategy</h2>" +
      (book ? '<p class="book-line">' + book + "</p>" : "") +
      body;
  }

  function legend(items) {
    return '<ul class="legend">' + items.map(function (item) {
      const cls = item.pnl > 0 ? "up" : item.pnl < 0 ? "down" : "";
      return '<li><span class="swatch" style="background:' + item.color + '"></span><span class="' + cls + '">' +
        esc(item.name) + " " + esc(money(item.pnl, true)) + "</span></li>";
    }).join("") + "</ul>";
  }

  function tradeCard(trade, data, open) {
    const pnl = num(trade.pnl);
    const cls = open ? "open" : pnl > 0 ? "win" : pnl < 0 ? "loss" : "flat";
    const name = productName(trade.symbol, data);
    const r = num(trade.r_multiple);
    const rText = Number.isFinite(r) ? r.toFixed(2) + "R" : "";
    const meta = [trade.setup, trade.regime, trade.session].filter(Boolean).join(" · ");
    const prices = open
      ? "Entry " + priceFmt(trade.entry) + (trade.stop != null ? " · stop " + priceFmt(trade.stop) : "") + (trade.tp != null ? " · target " + priceFmt(trade.tp) : "")
      : "Entry " + priceFmt(trade.entry) + " → exit " + priceFmt(trade.exit);
    const when = open
      ? fmtTs(trade.entry_time)
      : fmtTs(trade.entry_time) + " → " + fmtTs(trade.exit_time);
    return '<article class="trade ' + cls + '">' +
      '<div class="trade-top"><div><strong>' + esc(name) + '</strong> <span class="side">' + esc(sideLabel(trade.side)) + "</span>" +
        (open ? ' <span class="tag open-tag">OPEN</span>' : "") +
        (meta ? '<div class="muted small">' + esc(meta) + "</div>" : "") +
      "</div><div class=\"pnl\">" + (open ? (trade.pnl == null || trade.pnl === "" ? "—" : esc(money(trade.pnl, true))) : esc(money(pnl, true))) +
        (rText ? '<div class="muted small">' + esc(rText) + "</div>" : "") + "</div></div>" +
      '<p class="small">' + esc(prices) + "</p>" +
      '<p class="muted small">' + esc(when) + (trade.exit_reason ? " · " + esc(trade.exit_reason) : "") + "</p>" +
    "</article>";
  }

  function renderTrades() {
    const data = state.snapshot;
    const trades = allTrades(data);
    const open = trades.filter(function (trade) { return !isClosed(trade); });
    const closed = trades.filter(isClosed).slice().sort(function (a, b) {
      return parseTime(b.exit_time) - parseTime(a.exit_time);
    });
    const openHtml = open.length
      ? '<div class="trade-grid">' + open.map(function (trade) { return tradeCard(trade, data, true); }).join("") + "</div>"
      : '<p class="empty">No open trades.</p>';
    const closedHtml = closed.length
      ? '<div class="trade-grid">' + closed.map(function (trade) { return tradeCard(trade, data, false); }).join("") + "</div>"
      : '<p class="empty">No closed trades.</p>';
    document.getElementById("trades-panel").innerHTML =
      "<h2>Open trades · " + open.length + "</h2>" + openHtml +
      '<h2 class="section-gap">Closed trades · ' + closed.length + "</h2>" + closedHtml;
  }

  function mentionsBlock(text) {
    const stripped = String(text || "").replace(/veto-only/ig, "");
    return /\b(veto|blocked)\b/i.test(stripped);
  }

  function vetoItems(data) {
    const items = [];
    (data.events || []).forEach(function (event) {
      const kind = String(event.kind || "").toUpperCase();
      const msg = String(event.msg || "");
      if (kind === "VETO" || kind === "SKIP" || kind === "BLOCKED" || mentionsBlock(kind) || mentionsBlock(msg)) {
        items.push({ ts: event.ts, kind: kind || "VETO", msg: msg });
      }
    });
    (data.messages || []).forEach(function (line) {
      if (mentionsBlock(line)) items.push({ ts: "", kind: "LOG", msg: String(line) });
    });
    return items.sort(function (a, b) { return parseTime(b.ts) - parseTime(a.ts); });
  }

  function renderFeed(items, emptyText) {
    if (!items.length) return '<p class="empty">' + esc(emptyText) + "</p>";
    return '<ul class="feed">' + items.map(function (item) {
      const kind = String(item.kind || "event");
      const kindClass = /veto|skip/i.test(kind) ? " kind veto" : " kind";
      const when = item.ts ? '<div class="muted small">' + esc(fmtTs(item.ts)) + "</div>" : "";
      return "<li><span class=\"" + kindClass.trim() + "\">" + esc(kind) + "</span> " + esc(item.msg || "") + when + "</li>";
    }).join("") + "</ul>";
  }

  function renderVeto() {
    const items = vetoItems(state.snapshot);
    document.getElementById("veto-panel").innerHTML =
      "<h2>Blocked trades and vetoes</h2>" +
      renderFeed(items, "No blocked trades or vetoes.");
  }

  function renderEvents() {
    const data = state.snapshot;
    const events = (data.events || []).slice().sort(function (a, b) {
      return parseTime(b.ts) - parseTime(a.ts);
    });
    const messages = (data.messages || []).slice().reverse();
    document.getElementById("events-panel").innerHTML =
      "<h2>Events</h2>" +
      renderFeed(events.map(function (event) {
        return { ts: event.ts, kind: event.kind || "event", msg: event.msg || "" };
      }), "No events.") +
      '<h2 class="section-gap">Messages</h2>' +
      (messages.length
        ? '<ul class="feed">' + messages.map(function (line) {
            return "<li>" + esc(line) + "</li>";
          }).join("") + "</ul>"
        : '<p class="empty">No messages.</p>');
  }

  function shortTag(tag) {
    const text = String(tag || "");
    if (/experimental/i.test(text)) return "EXPERIMENTAL";
    return text;
  }

  function renderUniverse() {
    const data = state.snapshot;
    const parts = instrumentEntries(data).map(function (entry) {
      const inst = entry[1] || {};
      const name = inst.name || entry[0];
      if (inst.tag) return name + " " + shortTag(inst.tag);
      if (String(name).indexOf("ETH") === 0) return name + " EXPERIMENTAL";
      return name;
    });
    if (!parts.length) parts.push("BTC-USD", "ETH-USD EXPERIMENTAL");
    const tradedSol = instrumentEntries(data).some(function (entry) {
      return String((entry[1] && entry[1].name) || entry[0]).indexOf("SOL") === 0;
    });
    if (!tradedSol) parts.push("SOL-USD watch only");
    document.getElementById("universe").textContent = parts.join(" · ");
  }

  function renderMarketLine() {
    const market = (state.snapshot && state.snapshot.market) || {};
    const global = market.global_ || {};
    const bits = [];
    if (global.btc_dom != null) bits.push("BTC dominance " + trimNum(global.btc_dom, 2) + "%");
    if (global.mcap != null) bits.push("market cap " + compactUsd(global.mcap));
    if (global.mcap_chg24 != null) bits.push("mcap 24h " + pctFmt(global.mcap_chg24, 2));
    document.getElementById("market-line").textContent = bits.length ? "Snapshot market · " + bits.join(" · ") : "";
  }

  function quoteHtml(product) {
    const market = (state.snapshot.market && state.snapshot.market.crypto) || {};
    const symbol = product.split("-")[0];
    const quote = market[symbol] || {};
    const change = num(quote.chg24);
    const cls = change > 0 ? "up" : change < 0 ? "down" : "";
    const spread = state.snapshot.market && state.snapshot.market.spreads && state.snapshot.market.spreads[product];
    const spreadText = spread && spread.pct != null ? "Spread " + Number(spread.pct).toFixed(4) + "%" : "";
    const last = state.lastClose[product];
    const lastText = Number.isFinite(last) ? "Last candle " + priceFmt(last) : "";
    return '<div class="quote"><p class="quote-px">' + esc(quote.price == null ? "—" : priceFmt(quote.price)) + "</p>" +
      '<p class="' + cls + '">' + esc(quote.chg24 == null ? "no 24h change" : pctFmt(quote.chg24, 2) + " 24h") + "</p>" +
      (spreadText ? '<p class="muted small">' + esc(spreadText) + "</p>" : "") +
      (lastText ? '<p class="muted small">' + esc(lastText) + "</p>" : "") +
      "</div>";
  }

  function badgeFor(product) {
    if (product === "SOL-USD") return '<span class="tag watch">WATCH ONLY</span>';
    if (product === "ETH-USD") {
      const inst = instrumentEntries(state.snapshot).filter(function (entry) {
        return (entry[1] && entry[1].name) === "ETH-USD" || entry[0] === "ETHUSD";
      })[0];
      const full = inst && inst[1] && inst[1].tag ? String(inst[1].tag) : "EXPERIMENTAL";
      return '<span class="tag" title="' + esc(full) + '">EXPERIMENTAL</span>';
    }
    return "";
  }

  function renderChartHeads() {
    PRODUCTS.forEach(function (item) {
      const inst = instrumentEntries(state.snapshot).filter(function (entry) {
        return (entry[1] && entry[1].name) === item.product;
      })[0];
      const tagLine = inst && inst[1] && inst[1].tag && item.product === "ETH-USD"
        ? '<p class="muted small">' + esc(inst[1].tag) + "</p>"
        : item.product === "SOL-USD" ? '<p class="muted small">Not in the paper book</p>' : "";
      document.getElementById("head-" + item.product).innerHTML =
        "<div><h2>" + esc(item.product) + " " + badgeFor(item.product) + "</h2>" + tagLine +
          '<p class="muted small">Snapshot quote</p></div>' + quoteHtml(item.product);
    });
  }

  function renderAll() {
    renderFreshness();
    if (!state.snapshot) {
      const message = state.error ? "Could not read data/snapshot.json (" + esc(state.error) + ")." : "Loading paper snapshot…";
      ["equity-card", "risk-panel", "strategy-panel", "trades-panel", "veto-panel", "events-panel"].forEach(function (id, index) {
        if (index === 0) document.getElementById(id).innerHTML = '<p class="empty">' + message + "</p>";
        else document.getElementById(id).innerHTML = "";
      });
      return;
    }
    renderUniverse();
    renderEquity();
    renderRisk();
    renderBook();
    renderStrategy();
    renderTrades();
    renderChartHeads();
    renderMarketLine();
    renderVeto();
    renderEvents();
    renderEquityCurve();
  }

  function ensureChart(id, kind) {
    if (typeof LightweightCharts === "undefined") return null;
    if (charts[id]) return charts[id];
    const el = document.getElementById(id);
    const chart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "#0e131a" },
        textColor: "#8491a0",
        fontFamily: "IBM Plex Mono, ui-monospace, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(34, 48, 65, 0.85)" },
        horzLines: { color: "rgba(34, 48, 65, 0.85)" },
      },
      rightPriceScale: { borderColor: "#223041" },
      timeScale: { borderColor: "#223041", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });
    const series = kind === "candle"
      ? chart.addCandlestickSeries({
          upColor: "#3dd68c",
          downColor: "#ff5d73",
          borderVisible: false,
          wickUpColor: "#3dd68c",
          wickDownColor: "#ff5d73",
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        })
      : chart.addAreaSeries({
          lineColor: "#79d4ff",
          topColor: "rgba(121, 212, 255, 0.28)",
          bottomColor: "rgba(121, 212, 255, 0.02)",
          lineWidth: 2,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        });
    charts[id] = { chart: chart, series: series };
    return charts[id];
  }

  function renderEquityCurve() {
    const note = document.getElementById("equity-note");
    const empty = document.getElementById("equity-empty");
    const host = document.getElementById("equity-chart");
    const rows = (state.snapshot && state.snapshot.equity_series) || [];
    const points = uniqBars(rows.map(function (row) {
      const ms = parseTime(row[0]);
      return { time: Math.floor(ms / 1000), value: num(row[1]) };
    }).filter(function (point) {
      return Number.isFinite(point.time) && Number.isFinite(point.value);
    }).map(function (point) {
      return { time: point.time, open: point.value, high: point.value, low: point.value, close: point.value, value: point.value };
    })).map(function (bar) {
      return { time: bar.time, value: bar.close };
    });
    if (!points.length) {
      host.classList.add("hidden");
      empty.classList.remove("hidden");
      note.textContent = "";
      return;
    }
    host.classList.remove("hidden");
    empty.classList.add("hidden");
    const first = points[0].value;
    const flat = points.every(function (point) { return point.value === first; });
    note.textContent = (flat ? "Flat at " + money(first, false) + " · " : "") + points.length + " points";
    const view = ensureChart("equity-chart", "area");
    if (!view) {
      note.textContent = "Chart library failed to load.";
      return;
    }
    view.series.setData(points);
    view.chart.timeScale().fitContent();
  }

  async function loadProduct(item, tf, token) {
    const spec = TIMEFRAMES[tf];
    const foot = document.getElementById("foot-" + item.product);
    let bars = [];
    let source = "Coinbase " + tf;
    try {
      const response = await fetch(
        "https://api.exchange.coinbase.com/products/" + item.product + "/candles?granularity=" + spec.granularity,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      bars = fromCoinbase(payload);
      if (spec.aggregate) bars = aggregate(bars, spec.aggregate);
      if (!bars.length) throw new Error("empty candle response");
    } catch (error) {
      const snap = state.snapshot && state.snapshot.market && state.snapshot.market.candles && state.snapshot.market.candles[item.product];
      bars = fromSnapshot(snap && snap[spec.snapshot]);
      source = "snapshot candles (" + (error.message || "Coinbase failed") + ")";
    }
    if (token !== candleToken) return;
    bars = uniqBars(bars);
    state.candleSource[item.product] = source;
    state.lastClose[item.product] = bars.length ? bars[bars.length - 1].close : NaN;
    const inst = instrumentEntries(state.snapshot || {}).filter(function (entry) {
      return (entry[1] && entry[1].name) === item.product;
    })[0];
    const lastBar = inst && inst[1] && inst[1].last_bar ? " · snapshot last bar " + fmtTs(inst[1].last_bar) : "";
    foot.textContent = source + lastBar;
    const view = ensureChart("chart-" + item.product, "candle");
    if (!view) {
      foot.textContent = "Chart library failed to load.";
      return;
    }
    view.series.setData(bars);
    view.chart.timeScale().fitContent();
    if (state.snapshot) renderChartHeads();
  }

  async function loadCandles() {
    const token = ++candleToken;
    const tf = state.tf;
    await Promise.all(PRODUCTS.map(function (item) { return loadProduct(item, tf, token); }));
  }

  async function loadSnapshot() {
    try {
      const response = await fetch("data/snapshot.json?t=" + Date.now(), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      if (!data || typeof data !== "object" || !("equity" in data)) throw new Error("snapshot has no equity");
      state.snapshot = data;
      state.error = null;
    } catch (error) {
      state.error = error.message || "snapshot failed";
      if (!state.snapshot) state.snapshot = null;
    }
    renderAll();
  }

  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
      await loadSnapshot();
      await loadCandles();
      state.nextRefresh = Date.now() + REFRESH_MS;
      renderFreshness();
    } finally {
      refreshing = false;
    }
  }

  document.querySelectorAll(".tfs button").forEach(function (button) {
    button.addEventListener("click", function () {
      state.tf = button.getAttribute("data-tf");
      document.querySelectorAll(".tfs button").forEach(function (other) {
        other.classList.toggle("active", other === button);
      });
      loadCandles();
    });
  });

  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
  setInterval(renderFreshness, 1000);
})();
