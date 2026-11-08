#!/usr/bin/env python3
"""Hämtar aktuella 95 (E10)-priser i Norrköping och Finspång från bensinpriser.nu
och skriver data/bensin.json. Körs två gånger om dagen av GitHub Actions.

Stationernas koordinater hämtas en gång från stationssidan och sparas i
data/koordinater.json så att varje körning bara gör några få anrop.
Endast standardbiblioteket används.
"""
import html
import json
import re
import statistics
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SITE = "https://bensinpriser.nu"
ORTER = [("norrkoping", "Norrköping"), ("finspang", "Finspång")]
DATA = Path(__file__).resolve().parent.parent / "data"
OUT = DATA / "bensin.json"
COORDS = DATA / "koordinater.json"
UA = "Mozilla/5.0 (compatible; Laddkollen/1.0; privat hobbyapp)"
MAX_PAGES = 6

ROW = re.compile(r'<li class="cp-row[ "].*?(?=<li class="cp-row[ "]|</ul>)', re.S)


def clean(s):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", s)).split())


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def parse(page, ort):
    out = []
    for row in ROW.findall(page):
        href = re.search(r'href="(/station/[^"]+)"', row)
        brand = re.search(r'class="cp-title"><b>(.*?)</b>', row, re.S)
        addr = re.search(r'class="cp-addr">(.*?)</div>', row, re.S)
        if not href or not brand:
            continue
        price = re.search(r'class="cp-price">\s*(\d+,\d+)', row)
        date = re.search(r'class="cp-date">(.*?)</span>', row, re.S)
        out.append({
            "id": href.group(1),
            "kedja": clean(brand.group(1)),
            "adress": clean(addr.group(1)) if addr else "",
            "ort": ort,
            "pris": float(price.group(1).replace(",", ".")) if price else None,
            "datum": clean(date.group(1)) if price and date else "",
        })
    return out


def coords_for(station_id, cache):
    if station_id in cache:
        return cache[station_id]
    try:
        page = get(SITE + station_id)
        lat = re.search(r"var lat = (-?\d+\.\d+)", page)
        lng = re.search(r"var lng = (-?\d+\.\d+)", page)
        cache[station_id] = [float(lat.group(1)), float(lng.group(1))] if lat and lng else None
    except Exception as e:  # en enskild station får inte stoppa körningen
        print(f"Koordinater saknas för {station_id}: {e}", file=sys.stderr)
        return None
    time.sleep(1)  # var snäll mot sajten
    return cache[station_id]


def main():
    stations, seen = [], set()
    for slug, ort in ORTER:
        base = f"{SITE}/stationer/95/ostergotlands-lan/{slug}"
        for n in range(1, MAX_PAGES + 1):
            page = get(f"{base}/{n}" if n > 1 else base)
            for s in parse(page, ort):
                if s["id"] not in seen:
                    seen.add(s["id"])
                    stations.append(s)
            if f'/{slug}/{n + 1}"' not in page:
                break
            time.sleep(1)

    priced = [s for s in stations if s["pris"] and 10 < s["pris"] < 40]
    if not priced:
        print("Inga priser hittades – behåller gammal fil.", file=sys.stderr)
        return 1

    cache = json.loads(COORDS.read_text(encoding="utf-8")) if COORDS.exists() else {}
    for s in stations:
        c = coords_for(s["id"], cache)
        s["lat"], s["lng"] = (c if c else (None, None))
    COORDS.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")

    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    now = datetime.now(timezone.utc)
    prices = [s["pris"] for s in priced]
    snitt = round(statistics.mean(prices), 2)
    historik = [h for h in old.get("historik", []) if h["datum"] != now.strftime("%Y-%m-%d")]
    historik.append({"datum": now.strftime("%Y-%m-%d"), "snitt": snitt})

    stations.sort(key=lambda s: (s["pris"] is None, s["pris"] or 0, s["ort"]))
    data = {
        "uppdaterad": now.isoformat(timespec="minutes"),
        "kalla": "bensinpriser.nu",
        "drivmedel": "95 (E10)",
        "orter": [o for _, o in ORTER],
        "snitt": snitt,
        "median": round(statistics.median(prices), 2),
        "lagst": priced and min(priced, key=lambda s: s["pris"]),
        "antal": len(prices),
        "stationer": stations,
        "historik": historik[-90:],
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(prices)} priser av {len(stations)} stationer, snitt {snitt} kr/l")
    return 0


if __name__ == "__main__":
    sys.exit(main())
