#!/usr/bin/env python3
"""ScreenPeek money checker.

Pulls Adsterra statistics for the ScreenPeek domain into D1 (adsterra_days /
adsterra_formats) and sends Telegram money alerts via @TrafeeUpdatebot:
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
  * Alert state lives in D1 `config` (money_* keys) so runs are idempotent:
    stats upserts always happen; an alert is recorded only after its
    Telegram send succeeds (or when no bot is configured, it is recorded
    as skipped so a later bot setup does not replay history).

Required env: ADSTERRA_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
D1_DATABASE_ID. Optional env: MONEY_BOT_TOKEN, MONEY_BOT_CHAT_ID.
Config keys (D1 `config`): payout_min_usd (number, optional).
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


def get_config(d1, key, default=None):
    rows = d1.rows(f"SELECT value FROM config WHERE key='{esc(key)}'")
    return rows[0]["value"] if rows else default


def set_config(d1, key, value):
    d1.run(f"INSERT INTO config(key, value) VALUES('{esc(key)}', '{esc(value)}') "
           f"ON CONFLICT(key) DO UPDATE SET value='{esc(value)}'")


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
WIDGET_FILES = [("money_widget2_msg", "emerald_vault.html"),
                ("money_widget3_msg", "solar_pulse.html")]
# Bump whenever the widget HTML designs change: on the next run the checker
# sends FRESH widget messages with the new designs and takes over their IDs
# (a sent widget's HTML itself can never be edited in place).
WIDGET_VERSION = "v3-2026-11-11"


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


def widget_chat_data(d1, today, total, balance_est, payout_min):
    from datetime import datetime, timezone
    trow = (d1.rows(f"SELECT * FROM adsterra_days WHERE date='{today.isoformat()}'") or [None])[0] or {}
    month_start = today.replace(day=1)
    mrow = (d1.rows(f"SELECT COALESCE(SUM(revenue),0) AS r, COALESCE(SUM(impressions),0) AS i "
                    f"FROM adsterra_days WHERE date >= '{month_start.isoformat()}'") or [{"r": 0, "i": 0}])[0]
    rows = d1.rows("SELECT revenue FROM adsterra_days ORDER BY date DESC LIMIT 7")
    trend = [float(r["revenue"]) for r in reversed(rows)]
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


def sync_widgets(d1, data_str):
    """Send the two live cards once, then keep their data fresh in place.
    Returns True when the bot is configured (widgets are the dashboard)."""
    if not (os.environ.get("MONEY_BOT_TOKEN") and os.environ.get("MONEY_BOT_CHAT_ID")):
        return False
    last = get_config(d1, "money_widget_data")
    stale = get_config(d1, "money_widget_version") != WIDGET_VERSION
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "widgets")
    for key, fname in WIDGET_FILES:
        msg_id = get_config(d1, key)
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
                set_config(d1, key, str(out["result"]["message_id"]))
                print("widget sent:", fname, out["result"]["message_id"])
            else:
                print("widget send failed:", fname, (out or {}).get("description"))
        elif data_str != last:
            out = bot_call("editMessageWidgetData",
                           {"message_id": int(msg_id), "chat_data": data_str})
            if out and not out.get("ok") and "not modified" not in str(out.get("description", "")).lower():
                print("widget edit failed:", fname, out.get("description"))
    if stale and all(get_config(d1, key) for key, _ in WIDGET_FILES):
        set_config(d1, "money_widget_version", WIDGET_VERSION)
        print("widget design version now", WIDGET_VERSION)
    if data_str != last:
        set_config(d1, "money_widget_data", data_str)
    return True


def money(value):
    return f"${value:,.2f}"


def main():
    today = date.today()  # runner clock is UTC; stats days are UTC
    d1 = D1()

    # ---- 1) daily totals (one sequential call) ----------------------------
    # Window: from the epoch while the table is empty (first backfill), then
    # a rolling 45 days (older rows are already stored; totals read from D1).
    stored = int((d1.rows("SELECT COUNT(*) AS c FROM adsterra_days") or [{"c": 0}])[0]["c"])
    pull_start = EPOCH if stored == 0 else max(EPOCH, today - timedelta(days=45))
    daily = adsterra("stats.json", {"domain": DOMAIN_ID,
                                    "start_date": pull_start.isoformat(),
                                    "finish_date": today.isoformat(),
                                    "group_by[]": "date"})
    items = daily.get("items") or []
    print(f"daily rows: {len(items)} (dbLastUpdateTime={daily.get('dbLastUpdateTime')})")
    stmts = []
    for row in items:
        stmts.append(
            "INSERT OR REPLACE INTO adsterra_days(date, impressions, clicks, ctr, cpm, revenue, updated_at) "
            f"VALUES('{esc(row['date'])}', {int(row.get('impression', 0))}, {int(row.get('clicks', 0))}, "
            f"{float(row.get('ctr', 0))}, {float(row.get('cpm', 0))}, {float(row.get('revenue', 0))}, datetime('now'))")
    if stmts:
        d1.run_many(stmts)

    # ---- 2) per-placement split for the last 31 days ----------------------
    start31 = max(EPOCH, today - timedelta(days=30))
    placed = 0
    try:
        split = adsterra("stats.json", {"domain": DOMAIN_ID,
                                        "start_date": start31.isoformat(),
                                        "finish_date": today.isoformat(),
                                        "group_by[]": ["date", "placement"]})
        srows = []
        for row in split.get("items") or []:
            if row.get("date") and row.get("placement_id"):
                srows.append(
                    "INSERT OR REPLACE INTO adsterra_formats(date, placement_id, impressions, clicks, revenue) "
                    f"VALUES('{esc(row['date'])}', {int(row['placement_id'])}, {int(row.get('impression', 0))}, "
                    f"{int(row.get('clicks', 0))}, {float(row.get('revenue', 0))})")
        if srows:
            d1.run_many(srows)
            placed = len(srows)
    except Exception as exc:
        print("placement split (multi-group) failed, trying per-day:", exc)
    if not placed:  # fallback: one call per day for the last 7 days
        srows = []
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
                    srows.append(
                        "INSERT OR REPLACE INTO adsterra_formats(date, placement_id, impressions, clicks, revenue) "
                        f"VALUES('{day.isoformat()}', {int(pid)}, {int(row.get('impression', 0))}, "
                        f"{int(row.get('clicks', 0))}, {float(row.get('revenue', 0))})")
        if srows:
            d1.run_many(srows)
            placed = len(srows)
    print(f"placement rows stored: {placed}")

    # ---- 3) totals + alert state ------------------------------------------
    total = float((d1.rows("SELECT COALESCE(SUM(revenue),0) AS t FROM adsterra_days") or [{"t": 0}])[0]["t"])
    prev_total = float(get_config(d1, "money_last_total", "0") or 0)
    fired = {int(x) for x in (get_config(d1, "money_milestones_fired", "") or "").split(",") if x.strip()}
    paid_modeled = float(get_config(d1, "money_paid_modeled", "0") or 0)
    balance_est = total - paid_modeled
    print(f"total earned: {total} | previously seen: {prev_total} | balance estimate: {balance_est}")

    bot_ready = bool(os.environ.get("MONEY_BOT_TOKEN") and os.environ.get("MONEY_BOT_CHAT_ID"))

    def record(key, value):
        set_config(d1, key, value)

    # first earning
    if prev_total <= 0 < total and get_config(d1, "money_first_earning_done") != "1":
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
        if get_config(d1, "money_last_payout_alert") != pkey:
            through = float((d1.rows(
                f"SELECT COALESCE(SUM(revenue),0) AS t FROM adsterra_days WHERE date <= '{p_end.isoformat()}'")
                or [{"t": 0}])[0]["t"])
            payable = through - paid_modeled
            minimum_raw = get_config(d1, "payout_min_usd")
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
    _min_raw = get_config(d1, "payout_min_usd")
    payout_min = float(_min_raw) if _min_raw else 100.0
    widgets_on = sync_widgets(d1, widget_chat_data(d1, today, total, balance_est, payout_min))

    # daily summary at/after 03:00 UTC (09:00 Dhaka), once per UTC day
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    if widgets_on and now.hour >= 3 and get_config(d1, "money_last_daily") != today.isoformat():
        record("money_last_daily", today.isoformat())  # covered by the widgets now
    if now.hour >= 3 and not widgets_on and get_config(d1, "money_last_daily") != today.isoformat():
        yday = today - timedelta(days=1)
        yrow = (d1.rows(f"SELECT * FROM adsterra_days WHERE date='{yday.isoformat()}'") or [None])[0]
        month_start = today.replace(day=1)
        mrow = (d1.rows(f"SELECT COALESCE(SUM(revenue),0) AS r, COALESCE(SUM(impressions),0) AS i "
                        f"FROM adsterra_days WHERE date >= '{month_start.isoformat()}'") or [{"r": 0, "i": 0}])[0]
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
    print("done")


if __name__ == "__main__":
    sys.exit(main())
