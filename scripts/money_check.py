#!/usr/bin/env python3
"""ScreenPeek money checker.

Pulls Adsterra statistics for the ScreenPeek domain into KV (money:days /
money:formats) and sends Telegram money alerts via @TrafeeUpdatebot:
  * first earning, balance milestones ($10..$10,000 ladder incl. $50/$100)
  * expected-payout notices on Adsterra's NET-15 paydays (1st-2nd / 16th-17th)
  * one daily summary at/after 09:00 Dhaka (03:00 UTC) — replaced by the two
    live widget cards (Emerald Vault + Solar Pulse) once the bot is on:
    sent once via sendWidget, then refreshed in place every run

Design notes (verified against Adsterra's Publisher API docs + live calls):
  * The API has NO balance or payments endpoint. Milestones come from the
    cumulative stats revenue (exact). Payouts are modelled on the published
    NET-15 calendar and worded as "expected", never "sent".
  * Stats days are UTC. Revenue is rounded to 3 decimals by Adsterra.
  * API rate limit is about simultaneous requests: this script is strictly
    sequential.
  * Alert state lives in KV `money:state` (the money_* keys) so runs are idempotent:
    stats upserts always happen; an alert is recorded only after its
    Telegram send succeeds (or when no bot is configured, it is recorded
    as skipped so a later bot setup does not replay history).

Required env: ADSTERRA_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
KV_NAMESPACE_ID. Optional env: MONEY_BOT_TOKEN, MONEY_BOT_CHAT_ID.
D1_DATABASE_ID is used only by the one-time bootstrap that copies the
pre-KV money memory (D1 config + adsterra_days/formats) into KV on the
first KV run; after that the database is never touched again.
Config: payout_min_usd (number, optional) — the KV mirror
`config:payout_min_usd` (written by the admin panel), falling back to the
copy in money:state, then to the $100 crypto minimum.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error
from datetime import date, timedelta

DOMAIN_ID = 6190252  # screenpeek.screenpeek.workers.dev
EPOCH = date(2026, 11, 1)  # first possible stats day (site added 2026-11-10)
MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
API = "https://api3.adsterratools.com/publisher"


def http_json(url, headers=None, data=None, method=None):
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=40) as resp:
        return json.load(resp)


def adsterra(path, params):
    qs = urllib.parse.urlencode(params, doseq=True)
    return http_json(f"{API}/{path}?{qs}", headers={"X-API-Key": os.environ["ADSTERRA_API_TOKEN"],
                                                     "Accept": "application/json"})


class D1:
    def __init__(self):
        acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
        db = os.environ["D1_DATABASE_ID"]
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query"
        self.token = os.environ["CLOUDFLARE_API_TOKEN"]

    def query(self, sql):
        try:
            out = http_json(self.url, headers={"Authorization": "Bearer " + self.token,
                                               "Content-Type": "application/json"},
                            data=json.dumps({"sql": sql}).encode())
        except urllib.error.HTTPError as err:
            raise RuntimeError(f"D1 HTTP {err.code}: " + err.read().decode('utf-8', 'replace')[:300])
        if not out.get("success"):
            raise RuntimeError("D1 error: " + json.dumps(out.get("errors"))[:300])
        return out["result"]

    def rows(self, sql):
        result = self.query(sql)
        return (result[0].get("results") or []) if result else []

    def run(self, sql):
        self.query(sql)

    def run_many(self, statements):
        # The D1 query endpoint takes ONE statement per call; a joined batch
        # is rejected with HTTP 400 (learned from the first live run).
        for sql in statements:
            self.query(sql)


def esc(value):
    return str(value).replace("'", "''")


class QuotaRest(Exception):
    """The one-time D1 bootstrap hit the daily row limit; rest quietly."""


class KV:
    def __init__(self):
        acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
        ns = os.environ["KV_NAMESPACE_ID"]
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{acct}/storage/kv/namespaces/{ns}/values"
        self.token = os.environ["CLOUDFLARE_API_TOKEN"]

    def get_raw(self, key):
        req = urllib.request.Request(f"{self.base}/{urllib.parse.quote(key, safe='')}")
        req.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                return resp.read().decode()
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            raise RuntimeError(f"KV HTTP {err.code}: " + err.read().decode('utf-8', 'replace')[:300])

    def put_raw(self, key, text):
        req = urllib.request.Request(f"{self.base}/{urllib.parse.quote(key, safe='')}",
                                     data=text.encode(), method="PUT")
        req.add_header("Authorization", "Bearer " + self.token)
        req.add_header("Content-Type", "text/plain")
        with urllib.request.urlopen(req, timeout=40) as resp:
            resp.read()

    def get_json(self, key, default=None):
        raw = self.get_raw(key)
        if raw is None:
            return default
        try:
            return json.loads(raw)
        except ValueError:
            return default

    def put_json(self, key, obj):
        self.put_raw(key, json.dumps(obj, separators=(",", ":")))


class MoneyStore:
    """All money memory in KV: money:state (alert/widget state strings),
    money:days (date -> stats row), money:formats ("date|placement" -> row).
    The database is read exactly once, by the bootstrap below, the first
    time the KV keys are missing."""

    def __init__(self):
        self.kv = KV()
        self.state = {}
        self.days = {}
        self.formats = {}
        self._state_dirty = False

    def load(self):
        state = self.kv.get_json("money:state")
        if state is None:
            self._bootstrap()
            return
        self.state = {str(k): str(v) for k, v in state.items()}
        self.days = self.kv.get_json("money:days", {}) or {}
        self.formats = self.kv.get_json("money:formats", {}) or {}

    def _bootstrap(self):
        try:
            d1 = D1()
            rows = d1.rows("SELECT key, value FROM config WHERE key LIKE 'money_%' OR key='payout_min_usd'")
            self.state = {r["key"]: str(r["value"]) for r in rows}
            self.days = {r["date"]: {"impressions": int(r["impressions"]), "clicks": int(r["clicks"]),
                                     "ctr": float(r["ctr"]), "cpm": float(r["cpm"]),
                                     "revenue": float(r["revenue"]), "updated_at": r.get("updated_at") or ""}
                         for r in d1.rows("SELECT * FROM adsterra_days")}
            self.formats = {f"{r['date']}|{r['placement_id']}": {"impressions": int(r["impressions"]),
                                                                 "clicks": int(r["clicks"]),
                                                                 "revenue": float(r["revenue"])}
                            for r in d1.rows("SELECT * FROM adsterra_formats")}
        except RuntimeError as exc:
            if "7500" in str(exc) or "free tier daily row" in str(exc):
                raise QuotaRest(str(exc))
            raise
        self.kv.put_json("money:state", self.state)
        self.kv.put_json("money:days", self.days)
        self.kv.put_json("money:formats", self.formats)
        total = sum(float(r["revenue"]) for r in self.days.values())
        print(f"money KV bootstrap: copied {len(self.days)} days, {len(self.formats)} placement rows, "
              f"{len(self.state)} state keys from D1 (total earned {total:.3f}); the database is not used again")

    def get_config(self, key, default=None):
        return self.state.get(key, default)

    def set_config(self, key, value):
        if self.state.get(key) != str(value):
            self.state[key] = str(value)
            self._state_dirty = True

    def flush_state(self):
        if self._state_dirty:
            self.kv.put_json("money:state", self.state)
            self._state_dirty = False

    def payout_min_raw(self):
        mirror = self.kv.get_raw("config:payout_min_usd")
        if mirror:
            return mirror
        return self.state.get("payout_min_usd")

    def save_days(self):
        self.kv.put_json("money:days", self.days)

    def save_formats(self):
        self.kv.put_json("money:formats", self.formats)


def send_telegram(text):
    token = os.environ.get("MONEY_BOT_TOKEN")
    chat = os.environ.get("MONEY_BOT_CHAT_ID")
    if not token or not chat:
        print("telegram: skipped (bot not configured)")
        return False
    try:
        out = http_json(f"https://api.telegram.org/bot{token}/sendMessage",
                        headers={"Content-Type": "application/json"},
                        data=json.dumps({"chat_id": chat, "text": text, "parse_mode": "HTML"}).encode())
        print("telegram: sent" if out.get("ok") else f"telegram: failed {out}")
        return bool(out.get("ok"))
    except Exception as exc:  # keep the run alive; state is not recorded, so it retries next run
        print("telegram: error", exc)
        return False


def send_rich(html):
    """Telegram Rich Messages (headings, tables, blockquotes, expandables).
    Returns False when the client/API rejects it; callers fall back."""
    token = os.environ.get("MONEY_BOT_TOKEN")
    chat = os.environ.get("MONEY_BOT_CHAT_ID")
    if not token or not chat:
        return False
    try:
        out = http_json(f"https://api.telegram.org/bot{token}/sendRichMessage",
                        headers={"Content-Type": "application/json"},
                        data=json.dumps({"chat_id": chat, "rich_message": {"html": html}}).encode())
        print("telegram rich: sent" if out.get("ok") else f"telegram rich: failed {out}")
        return bool(out.get("ok"))
    except Exception as exc:
        print("telegram rich: error", exc)
        return False


def send_alert(rich_html, fallback_html):
    if send_rich(rich_html):
        return True
    return send_telegram(fallback_html)


# ---------- live widget cards (pinned dashboards, updated in place) ----------
WIDGET_FILES = [("money_widget2_msg", "emerald_vault.html")]
# Bump whenever the widget HTML designs change: on the next run the checker
# sends FRESH widget messages with the new designs and takes over their IDs
# (a sent widget's HTML itself can never be edited in place).
WIDGET_VERSION = "v4-2026-11-11"


def bot_call(method, payload):
    token = os.environ.get("MONEY_BOT_TOKEN")
    chat = os.environ.get("MONEY_BOT_CHAT_ID")
    if not token or not chat:
        return None
    payload = dict(payload)
    payload["chat_id"] = chat
    try:
        return http_json(f"https://api.telegram.org/bot{token}/{method}",
                         headers={"Content-Type": "application/json"},
                         data=json.dumps(payload).encode())
    except Exception as exc:
        print(f"telegram {method}: error", exc)
        return None


def widget_chat_data(store, today, total, balance_est, payout_min):
    from datetime import datetime, timezone
    trow = store.days.get(today.isoformat()) or {}
    month_start = today.replace(day=1).isoformat()
    month_rows = [r for d, r in store.days.items() if d >= month_start]
    mrow = {"r": sum(float(r["revenue"]) for r in month_rows), "i": sum(int(r["impressions"]) for r in month_rows)}
    recent = sorted(store.days.keys(), reverse=True)[:7]
    trend = [float(store.days[d]["revenue"]) for d in reversed(recent)]
    while len(trend) < 7:
        trend.insert(0, 0.0)
    nxt = next((x for x in MILESTONES if x > total), MILESTONES[-1] * 2)
    data = {
        "revenue": float(trow.get("revenue", 0) or 0),
        "impressions": int(trow.get("impressions", 0) or 0),
        "clicks": int(trow.get("clicks", 0) or 0),
        "ctr": float(trow.get("ctr", 0) or 0),
        "cpm": float(trow.get("cpm", 0) or 0),
        "month_revenue": float(mrow["r"]),
        "month_impressions": int(mrow["i"]),
        "earned": total,
        "balance": balance_est,
        "milestone": float(nxt),
        "payout_target": float(payout_min),
        "trend": trend,
        "updated": datetime.now(timezone.utc).strftime("%b %d · %H:%M UTC"),
    }
    return json.dumps(data, separators=(",", ":"))


def sync_widgets(store, data_str):
    """Send the two live cards once, then keep their data fresh in place.
    Returns True when the bot is configured (widgets are the dashboard)."""
    if not (os.environ.get("MONEY_BOT_TOKEN") and os.environ.get("MONEY_BOT_CHAT_ID")):
        return False
    last = store.get_config("money_widget_data")
    stale = store.get_config("money_widget_version") != WIDGET_VERSION
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "widgets")
    for key, fname in WIDGET_FILES:
        msg_id = store.get_config(key)
        if not msg_id or stale:
            try:
                with open(os.path.join(base, fname), encoding="utf-8") as fh:
                    html = fh.read()
            except Exception as exc:
                print("widget file missing:", fname, exc)
                continue
            out = bot_call("sendWidget", {"html": html, "chat_data": data_str,
                                          "allow_queries": True})
            if out and out.get("ok"):
                store.set_config(key, str(out["result"]["message_id"]))
                print("widget sent:", fname, out["result"]["message_id"])
            else:
                print("widget send failed:", fname, (out or {}).get("description"))
        elif data_str != last:
            out = bot_call("editMessageWidgetData",
                           {"message_id": int(msg_id), "chat_data": data_str})
            if out and not out.get("ok") and "not modified" not in str(out.get("description", "")).lower():
                print("widget edit failed:", fname, out.get("description"))
    if stale and all(store.get_config(key) for key, _ in WIDGET_FILES):
        store.set_config("money_widget_version", WIDGET_VERSION)
        print("widget design version now", WIDGET_VERSION)
    if data_str != last:
        store.set_config("money_widget_data", data_str)
    store.flush_state()
    return True


def money(value):
    return f"${value:,.2f}"


def main():
    today = date.today()  # runner clock is UTC; stats days are UTC
    store = MoneyStore()
    store.load()

    # ---- 1) daily totals (one sequential call) ----------------------------
    # Window: from the epoch while the table is empty (first backfill), then
    # a rolling 45 days (older rows are already stored; totals read from D1).
    stored = len(store.days)
    pull_start = EPOCH if stored == 0 else max(EPOCH, today - timedelta(days=45))
    daily = adsterra("stats.json", {"domain": DOMAIN_ID,
                                    "start_date": pull_start.isoformat(),
                                    "finish_date": today.isoformat(),
                                    "group_by[]": "date"})
    items = daily.get("items") or []
    print(f"daily rows: {len(items)} (dbLastUpdateTime={daily.get('dbLastUpdateTime')})")
    if items:
        from datetime import datetime, timezone
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        for row in items:
            store.days[str(row["date"])] = {"impressions": int(row.get("impression", 0)),
                                            "clicks": int(row.get("clicks", 0)),
                                            "ctr": float(row.get("ctr", 0)),
                                            "cpm": float(row.get("cpm", 0)),
                                            "revenue": float(row.get("revenue", 0)),
                                            "updated_at": stamp}
        store.save_days()

    # ---- 2) per-placement split for the last 31 days ----------------------
    start31 = max(EPOCH, today - timedelta(days=30))
    placed = 0
    try:
        split = adsterra("stats.json", {"domain": DOMAIN_ID,
                                        "start_date": start31.isoformat(),
                                        "finish_date": today.isoformat(),
                                        "group_by[]": ["date", "placement"]})
        srows = {}
        for row in split.get("items") or []:
            if row.get("date") and row.get("placement_id"):
                srows[f"{row['date']}|{int(row['placement_id'])}"] = {
                    "impressions": int(row.get("impression", 0)), "clicks": int(row.get("clicks", 0)),
                    "revenue": float(row.get("revenue", 0))}
        if srows:
            store.formats.update(srows)
            store.save_formats()
            placed = len(srows)
    except Exception as exc:
        print("placement split (multi-group) failed, trying per-day:", exc)
    if not placed:  # fallback: one call per day for the last 7 days
        srows = {}
        for offset in range(7):
            day = today - timedelta(days=offset)
            if day < EPOCH:
                break
            res = adsterra("stats.json", {"domain": DOMAIN_ID,
                                          "start_date": day.isoformat(),
                                          "finish_date": day.isoformat(),
                                          "group_by[]": "placement"})
            for row in res.get("items") or []:
                pid = row.get("placement_id") or row.get("placement")
                if pid:
                    srows[f"{day.isoformat()}|{int(pid)}"] = {
                        "impressions": int(row.get("impression", 0)), "clicks": int(row.get("clicks", 0)),
                        "revenue": float(row.get("revenue", 0))}
        if srows:
            store.formats.update(srows)
            store.save_formats()
            placed = len(srows)
    print(f"placement rows stored: {placed}")

    # ---- 3) totals + alert state ------------------------------------------
    total = sum(float(r["revenue"]) for r in store.days.values())
    prev_total = float(store.get_config("money_last_total", "0") or 0)
    fired = {int(x) for x in (store.get_config("money_milestones_fired", "") or "").split(",") if x.strip()}
    paid_modeled = float(store.get_config("money_paid_modeled", "0") or 0)
    balance_est = total - paid_modeled
    print(f"total earned: {total} | previously seen: {prev_total} | balance estimate: {balance_est}")

    bot_ready = bool(os.environ.get("MONEY_BOT_TOKEN") and os.environ.get("MONEY_BOT_CHAT_ID"))

    def record(key, value):
        store.set_config(key, value)
        store.flush_state()

    # first earning
    if prev_total <= 0 < total and store.get_config("money_first_earning_done") != "1":
        msg = ("🎉 <b>First earning!</b>\n\n"
               "ScreenPeek just made its first money from ads.\n"
               f"💰 Total earned: <b>{money(total)}</b>\n\n"
               "<i>The ads are live and working. Next stop: the $10 milestone.</i>")
        rich = ("<h3>🎉 First earning!</h3>"
                f"<blockquote>💰 <b>{money(total)} earned</b> — the ads are live and working.</blockquote>"
                "<p>Next stop: the <b>$10</b> milestone.</p>")
        sent = send_alert(rich, msg) if bot_ready else False
        if sent or not bot_ready:
            record("money_first_earning_done", "1")

    # milestones
    newly = [m for m in MILESTONES if m <= total and m not in fired]
    for m in newly:
        nxt = next((x for x in MILESTONES if x > m), None)
        msg = (f"🏆 <b>Milestone complete — {money(m)}!</b>\n\n"
               f"💰 Total earnings: <b>{money(total)}</b>"
               + (f"\n🎯 Next milestone: <b>{money(nxt)}</b> ({money(nxt - total)} to go)" if nxt else "")
               + "\n\n<i>ScreenPeek keeps earning while you sleep.</i>")
        rich = (f"<h3>🏆 Milestone complete — {money(m)}!</h3>"
                f"<blockquote>💰 <b>Total earnings: {money(total)}</b></blockquote>"
                + (f"<p>🎯 Next milestone: <b>{money(nxt)}</b> ({money(nxt - total)} to go)</p>" if nxt else "")
                + "<p><i>ScreenPeek keeps earning while you sleep.</i></p>")
        if bot_ready:
            if send_alert(rich, msg):
                fired.add(m)
        else:
            fired.add(m)  # no bot yet: don't replay history when the bot arrives
    if newly:
        record("money_milestones_fired", ",".join(str(x) for x in sorted(fired)))

    # expected payout on NET-15 paydays (fire on the first day of each window)
    def period_of(day):
        if day.day <= 15:
            return (date(day.year, day.month, 1), date(day.year, day.month, 15),
                    date(day.year + (1 if day.month == 12 else 0), 1 if day.month == 12 else day.month + 1, 1))
        last = date(day.year + (1 if day.month == 12 else 0), 1 if day.month == 12 else day.month + 1, 1) - timedelta(days=1)
        return (date(day.year, day.month, 16), last,
                date(day.year + (1 if day.month == 12 else 0), 1 if day.month == 12 else day.month + 1, 16))

    # the period whose payday window opens today:
    candidate = None
    for back in range(0, 62):
        p_start, p_end, payday = period_of(today - timedelta(days=back))
        if payday == today:
            candidate = (p_start, p_end, payday)
            break
    if candidate:
        p_start, p_end, payday = candidate
        pkey = p_start.isoformat()
        if store.get_config("money_last_payout_alert") != pkey:
            through = sum(float(r["revenue"]) for d, r in store.days.items() if d <= p_end.isoformat())
            payable = through - paid_modeled
            minimum_raw = store.payout_min_raw()
            # Karn's payout method is crypto (USDT/BTC): $100 minimum.
            # Override any time via the D1 config key payout_min_usd.
            minimum = float(minimum_raw) if minimum_raw else 100.0
            if payable > 0 and (minimum is None or payable >= minimum):
                window = "1st–2nd" if payday.day == 1 else "16th–17th"
                msg = (f"💸 <b>Payout expected — about {money(payable)}</b>\n\n"
                       f"📅 Earnings period: up to <b>{p_end.strftime('%b %d, %Y')}</b>\n"
                       f"🗓 Adsterra pays on the <b>{window} ({payday.strftime('%B %Y')})</b>, 09:00–18:00 GMT\n"
                       "💳 Method: Crypto — minimum reached ✓\n\n"
                       "<i>This is the calendar expectation from your revenue. Adsterra's Payouts page is the final confirmation.</i>")
                rich = (f"<h3>💸 Payout expected — about {money(payable)}</h3>"
                        "<table><tbody>"
                        f"<tr><td>📅 Period</td><td>Up to <b>{p_end.strftime('%b %d, %Y')}</b></td></tr>"
                        f"<tr><td>🗓 Pay window</td><td><b>{window} ({payday.strftime('%B %Y')})</b>, 09:00–18:00 GMT</td></tr>"
                        "<tr><td>💳 Method</td><td>Crypto (USDT/BTC)</td></tr>"
                        "</tbody></table>"
                        "<ul><li>☑️ Balance passed the $100 minimum</li></ul>"
                        "<blockquote><i>Calendar expectation from your revenue — Adsterra's Payouts page is the final confirmation.</i></blockquote>")
                sent = send_alert(rich, msg) if bot_ready else False
                if sent or not bot_ready:
                    record("money_last_payout_alert", pkey)
                    paid_modeled += payable
                    record("money_paid_modeled", f"{paid_modeled:.3f}")
                    balance_est = total - paid_modeled
            else:
                record("money_last_payout_alert", pkey)  # below minimum: rolls over, no alert
                print(f"payout for period {pkey}: payable {payable} below minimum {minimum}; rolling over")

    # live widget cards: sent once, then refreshed in place every run.
    # When they are on, they REPLACE the daily summary message.
    _min_raw = store.payout_min_raw()
    payout_min = float(_min_raw) if _min_raw else 100.0
    widgets_on = sync_widgets(store, widget_chat_data(store, today, total, balance_est, payout_min))

    # daily summary at/after 03:00 UTC (09:00 Dhaka), once per UTC day
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    if widgets_on and now.hour >= 3 and store.get_config("money_last_daily") != today.isoformat():
        record("money_last_daily", today.isoformat())  # covered by the widgets now
    if now.hour >= 3 and not widgets_on and store.get_config("money_last_daily") != today.isoformat():
        yday = today - timedelta(days=1)
        yrow = store.days.get(yday.isoformat())
        month_start = today.replace(day=1)
        month_rows = [r for d, r in store.days.items() if d >= month_start.isoformat()]
        mrow = {"r": sum(float(r["revenue"]) for r in month_rows), "i": sum(int(r["impressions"]) for r in month_rows)}
        nxt = next((x for x in MILESTONES if x > total), None)
        lines = ["📊 <b>ScreenPeek — Daily Money Summary</b>",
                 f"<i>Yesterday · {yday.strftime('%b %d')} (UTC day)</i>",
                 "",
                 f"💵 Revenue: <b>{money(float(yrow['revenue'])) if yrow else money(0)}</b>"
                 + (f"\n👁 Impressions: <b>{int(yrow['impressions']):,}</b> · 🖱 Clicks: <b>{int(yrow['clicks'])}</b>\n📈 CPM: <b>${float(yrow['cpm']):.2f}</b>" if yrow else "\n<i>No ad data recorded for yesterday.</i>"),
                 "",
                 "━━━━━━━━━━━━━━",
                 f"📅 <b>This month:</b> {money(float(mrow['r']))} · {int(mrow['i']):,} impressions",
                 f"🏦 <b>Earned all time:</b> {money(total)}",
                 f"💰 <b>Balance (estimate):</b> {money(balance_est)}"]
        if nxt:
            lines.append(f"🎯 <b>Next milestone:</b> {money(nxt)} ({money(nxt - total)} to go)")
        filled = int(balance_est / 100 * 10) if balance_est < 100 else 10
        bar = "▰" * filled + "▱" * (10 - filled)
        if balance_est < 100:
            lines.append(f"🚀 <b>Payout progress:</b> {money(balance_est)} of $100\n{bar}")
        else:
            lines.append("🚀 <b>Payout minimum reached</b> — the next pay window (1st–2nd / 16th–17th) applies.")
        rich_lines = [
            "<h3>📊 ScreenPeek — Daily Money Summary</h3>",
            f"<p><i>Yesterday · {yday.strftime('%b %d')} (UTC day)</i></p>",
            (f"<blockquote><b>💵 Revenue: {money(float(yrow['revenue']))}</b><br>👁 {int(yrow['impressions']):,} impressions · 🖱 {int(yrow['clicks'])} clicks · 📈 CPM ${float(yrow['cpm']):.2f}</blockquote>" if yrow else "<blockquote><b>💵 Revenue: $0.00</b><br><i>No ad data recorded for yesterday.</i></blockquote>"),
            "<hr>",
            "<h4>📅 This month</h4>",
            f"<table><tbody><tr><td>Revenue</td><td><b>{money(float(mrow['r']))}</b></td></tr><tr><td>Impressions</td><td><b>{int(mrow['i']):,}</b></td></tr></tbody></table>",
            "<h4>🏦 Totals</h4>",
            f"<table><tbody><tr><td>Earned all time</td><td><b>{money(total)}</b></td></tr><tr><td>Balance (estimate)</td><td><b>{money(balance_est)}</b></td></tr>"
            + (f"<tr><td>Next milestone</td><td><b>{money(nxt)}</b> ({money(nxt - total)} to go)</td></tr>" if nxt else "") + "</tbody></table>",
            (f"<p>🚀 <b>Payout progress:</b> {money(balance_est)} of $100<br>{bar}</p>" if balance_est < 100 else "<p>🚀 <b>Payout minimum reached</b> — the next pay window (1st–2nd / 16th–17th) applies.</p>"),
            "<details><summary>ℹ️ How to read these numbers</summary><p>Figures come from Adsterra's official API and refresh every 30 minutes. Balance is an estimate: all earnings minus the payouts Adsterra's pay calendar says should already have been made.</p></details>",
        ]
        if send_alert("\n".join(rich_lines), "\n".join(lines)) or not bot_ready:
            record("money_last_daily", today.isoformat())

    record("money_last_total", f"{total:.3f}")
    store.flush_state()
    print("done")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except QuotaRest:
        print("money KV bootstrap: the one-time database copy hit the daily row limit; "
              "resting until it resets at 00:00 UTC. Not a failure.")
        sys.exit(0)
