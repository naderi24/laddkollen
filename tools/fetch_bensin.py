#!/usr/bin/env python3
"""Hämtar aktuella 95 (E10)-priser i Norrköping från bensinpriser.nu
och skriver data/bensin.json. Körs dagligen av GitHub Actions.

Endast standardbiblioteket används.
"""
import html
import json
import re
import statistics
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://bensinpriser.nu/stationer/95/ostergotlands-lan/norrkoping"
OUT = Path(__file__).resolve().parent.parent / "data" / "bensin.json"
UA = "Mozilla/5.0 (compatible; Laddkollen/1.0; privat hobbyapp)"
MAX_PAGES = 6

ROW = re.compile(r'<li class="cp-row".*?</li>\s*(?=<li class="cp-row"|</ul>)', re.S)


def text(s):
    return html.unescape(re.sub(r"<[^>]+>", " ", s)).split()


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def parse(page):
    stations = []
    for row in ROW.findall(page):
        price = re.search(r'class="cp-price">\s*([\d]+,[\d]+)', row)
        if not price:
            continue  # "inget aktuellt pris"
        brand = re.search(r'class="cp-title"><b>(.*?)</b>', row, re.S)
        addr = re.search(r'class="cp-addr">(.*?)</div>', row, re.S)
        date = re.search(r'class="cp-date">(.*?)</span>', row, re.S)
        stations.append({
            "kedja": " ".join(text(brand.group(1))) if brand else "",
            "adress": " ".join(text(addr.group(1))) if addr else "",
            "datum": " ".join(text(date.group(1))) if date else "",
            "pris": float(price.group(1).replace(",", ".")),
        })
    return stations


def main():
    seen, stations = set(), []
    for n in range(1, MAX_PAGES + 1):
        page = get(f"{BASE}/{n}" if n > 1 else BASE)
        found = parse(page)
        for s in found:
            key = (s["kedja"], s["adress"])
            if key not in seen:
                seen.add(key)
                stations.append(s)
        if f'/norrkoping/{n + 1}"' not in page:
            break

    prices = [s["pris"] for s in stations if 10 < s["pris"] < 40]
    if not prices:
        print("Inga priser hittades – behåller gammal fil.", file=sys.stderr)
        return 1

    old = {}
    if OUT.exists():
        old = json.loads(OUT.read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc)
    snitt = round(statistics.mean(prices), 2)
    historik = [h for h in old.get("historik", []) if h["datum"] != now.strftime("%Y-%m-%d")]
    historik.append({"datum": now.strftime("%Y-%m-%d"), "snitt": snitt})

    stations.sort(key=lambda s: s["pris"])
    data = {
        "uppdaterad": now.isoformat(timespec="minutes"),
        "kalla": "bensinpriser.nu",
        "drivmedel": "95 (E10)",
        "ort": "Norrköping",
        "snitt": snitt,
        "median": round(statistics.median(prices), 2),
        "lagst": stations[0],
        "antal": len(prices),
        "stationer": stations,
        "historik": historik[-90:],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(prices)} priser, snitt {snitt} kr/l")
    return 0


if __name__ == "__main__":
    sys.exit(main())
