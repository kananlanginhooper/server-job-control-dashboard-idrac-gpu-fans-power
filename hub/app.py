#!/usr/bin/env python3
import glob, json, math, os, re, subprocess, threading, time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pymysql
from hubcfg import BOX, BOX_NAME, CFG, MAIN, NODE

# state files (runprofile.json, ...) live in HUB_STATE_DIR; default = next to this script, as before
HERE = os.environ.get("HUB_STATE_DIR") or os.path.dirname(os.path.abspath(__file__))
READ_ONLY = os.environ.get("HUB_READ_ONLY") == "1"   # check copy: HTTP GETs only, no loops, no writes, no POSTs
CNF = os.path.expanduser(f"~/.{CFG['db_cnf_name']}")
PORT = int(os.environ.get("HUB_PORT") or 8090)
HOST = MAIN
NIC = CFG['nic']
MOUNTS = ["/", "/b", "/c", "/d", "/e", "/n2", "/n4"]
DISKS = ["sda", "sdb", "sdc", "sdd", "sde", "nvme0n1", "nvme1n1"]
DU_TARGETS = {"e-intake": "/e/intake", "d-intake": "/d/intake"}
NODE_FOLDERS = [
    {"name": f"{CFG['node_old_home']}/recovery", "dest": f"/c/{NODE}-prior/{CFG['node_old_dest']}", "src_bytes": 2.8e12, "note": "PhotoRec output, 38,286 folders + ddrescue map"},
    {"name": "/samba", "dest": f"/d/{NODE}-prior/samba", "src_bytes": 1.9e12, "note": "PhotoRec output, 2,091 folders"},
    {"name": "/recovered_sda.img + photorec.se*", "dest": f"/d/{NODE}-prior/root-files", "src_bytes": 52e9, "note": "103 GB sparse image, ~52 GB stored"},
]
NODE_AGENT = f"http://{CFG['node_ip']}:8091/"
BOX_AGENT = f"http://{CFG['box_ip']}:8091/"   # the intake box (Threadripper, drive intake), copy of the the GPU node agent (2026-10-03); behind the Wi-Fi router NAT since 10-26 (<addr>, ports 22 + 8000-8100 forwarded)
RSYNC_RE = re.compile(r"^\s*([\d,]+)\s+(\d+)%\s+(\S+/s)\s+(\S+)(?:\s+\(xfr#(\d+), (?:to|ir)-chk=(\d+)/(\d+)\))?")
NODE_DU_EVERY = 600
CATALOG_ROOTS_EVERY = 1800   # 30 min (Power and Jobs Sizing 2026-09-28: the full `files` scan takes 7-8 min and was piling up every 5 min)

state = {"fast": {}, "slow": {}, "db": {}, NODE: {}, "history": deque(maxlen=180), "updated": 0,
         "laptop": {"at": 0, "fast": {}, "history": deque(maxlen=180)}, "hub": {}, "hub_claude": []}
HUB_FRESH = 20
HUB_TABLES = [
    """create table if not exists stats(tier char(2) not null, ts datetime not null, host varchar(32) not null,
        metric varchar(32) not null, value double, primary key(tier, host, metric, ts), key tier_ts(tier, ts)) engine=InnoDB""",
    """create table if not exists host_reports(host varchar(32) not null primary key, ts datetime(3) not null,
        report json) engine=InnoDB""",
    """create table if not exists claude_status(session varchar(40) not null primary key, ts datetime(3) not null,
        status text, tasks json) engine=InnoDB""",
    """create table if not exists claude_status_log(session varchar(40) not null, ts datetime(3) not null,
        status text, tasks json, primary key(session, ts)) engine=InnoDB""",
]
lock = threading.Lock()
pool = ThreadPoolExecutor(8)


def read(p, default=""):
    try:
        with open(p) as f:
            return f.read().strip()
    except OSError:
        return default


def with_timeout(fn, t, default=None):
    fut = pool.submit(fn)
    try:
        return fut.result(timeout=t)
    except Exception:
        return default


def cpu_times():
    v = [int(x) for x in read("/proc/stat").splitlines()[0].split()[1:]]
    return sum(v), v[3] + v[4]


def diskstats():
    out = {}
    for line in read("/proc/diskstats").splitlines():
        f = line.split()
        if f[2] in DISKS:
            out[f[2]] = (int(f[5]) * 512, int(f[9]) * 512)
    return out


def netbytes():
    b = f"/sys/class/net/{NIC}/statistics/"
    return int(read(b + "rx_bytes", "0")), int(read(b + "tx_bytes", "0"))


def mount_usage(m):
    def f():
        st = os.statvfs(m)
        return {"total": st.f_blocks * st.f_frsize, "free": st.f_bavail * st.f_frsize}
    r = with_timeout(f, 2)
    opts = ""
    for line in read("/proc/mounts").splitlines():
        p = line.split()
        if p[1] == m:
            opts = p[3]
    return {"mount": m, "usage": r, "shutdown": "shutdown" in opts or "emergency_ro" in opts, "mounted": bool(opts)}


def temps():
    out = {}
    for h in glob.glob("/sys/class/hwmon/hwmon*"):
        name = read(h + "/name")
        vals = [int(read(t, "0")) / 1000 for t in glob.glob(h + "/temp*_input")]
        if vals:
            out.setdefault(name, []).append(max(vals))
    return out


def edac():
    ce = ue = 0
    for m in glob.glob("/sys/devices/system/edac/mc/mc*"):
        ce += int(read(m + "/ce_count", "0")); ue += int(read(m + "/ue_count", "0"))
    return {"ce": ce, "ue": ue}


def nvme_states():
    return {os.path.basename(p): read(p + "/state") for p in glob.glob("/sys/class/nvme/nvme*")}


dwait = {}
STUCK_AFTER = 300


def cpu_ticks(pid):
    try:
        f = read(f"/proc/{pid}/stat").rsplit(")", 1)[1].split()
        return int(f[11]) + int(f[12])
    except (IndexError, ValueError):
        return None


def stuck_processes(dpids):
    now = time.time()
    for pid in list(dwait):
        if pid not in dpids:
            del dwait[pid]
    out = []
    for pid, name in dpids.items():
        ticks = cpu_ticks(pid)
        e = dwait.get(pid)
        if e is None or ticks != e["ticks"]:
            dwait[pid] = {"since": now, "ticks": ticks, "name": name}
        elif now - e["since"] >= STUCK_AFTER:
            out.append({"pid": pid, "name": name, "for_s": now - e["since"]})
    return out


def processes():
    r = subprocess.run(["ps", "-eo", "pid,etimes,stat,pcpu,args", "--no-headers"], capture_output=True, text=True).stdout
    watch = {"rsync": r"rsync --server", "catalog.py": r"catalog\.py scan", "mkfs": r"mkfs\.", "immich": r"immich",
             "mysqld": r"mysqld", "smbd": r"smbd"}
    out, dstate, dpids = {}, 0, {}
    rsync_dests = set()
    for line in r.splitlines():
        f = line.split(None, 4)
        if len(f) < 5:
            continue
        if f[2].startswith("D"):
            dstate += 1
            dpids[f[0]] = f[4][:80]
        if "rsync --server" in f[4]:
            rsync_dests.add(f[4].split()[-1].rstrip("/"))
        for k, pat in watch.items():
            if re.search(pat, f[4]):
                e = out.setdefault(k, {"count": 0, "cpu": 0.0, "oldest_s": 0, "sample": f[4][:140]})
                e["count"] += 1; e["cpu"] += float(f[3]); e["oldest_s"] = max(e["oldest_s"], int(f[1])); e["stopped"] = e.get("stopped", 0) + f[2].startswith("T")
    if "rsync" in out:
        out["rsync"]["dests"] = sorted(rsync_dests)
    state["stuck"] = stuck_processes(dpids)
    return out, dstate


def peers():
    r = subprocess.run(["ss", "-tnH", "state", "established"], capture_output=True, text=True).stdout
    out = {}
    for line in r.splitlines():
        f = line.split()
        if len(f) < 4:
            continue
        lport = f[2].rsplit(":", 1)[-1]; peer = f[3].rsplit(":", 1)[0].strip("[]")
        if lport in ("445", "22", "3306"):
            out.setdefault(peer, set()).add({"445": "smb", "22": "ssh", "3306": "mysql"}[lport])
    return {k: sorted(v) for k, v in out.items()}


LAPTOP_IPS = {CFG['laptop_ip1'], CFG['laptop_ip2'], CFG['laptop_ip3']}   # <addr> since ~2026-09-29 (DHCP change broke laptop pushes)
NODE_IPS = {CFG['node_ip'], CFG['node_ip3'], CFG['node_ip4'], CFG['node_ip2']}
SPEED_SOURCES = {"laptop": (LAPTOP_IPS, "445"), NODE: (NODE_IPS, None)}
NOT_COPY_PEER_PORTS = {"8091", "3003"}
speed = {"prev": {}, "minute": None, "acc": {}, "live": deque(maxlen=150)}
remain = {"now": {}, "hour_ago": None}
INTAKE_PREFIXES = ("/e/intake", "/d/intake", f"/c/{NODE}-prior", f"/d/{NODE}-prior")


def socket_bytes():
    r = subprocess.run(["ss", "-tinH", "state", "established"], capture_output=True, text=True).stdout
    out, key = {}, None
    for line in r.splitlines():
        if not line.startswith((" ", "\t")):
            f = line.split()
            key = None
            if len(f) >= 4:
                lport = f[2].rsplit(":", 1)[-1]; peer, pport = f[3].rsplit(":", 1)
                peer = peer.strip("[]").removeprefix("::ffff:")
                for src, (ips, port) in SPEED_SOURCES.items():
                    if peer in ips and (lport == port or (port is None and pport not in NOT_COPY_PEER_PORTS)):
                        key = (src, f[2], f[3])
        elif key:
            m = re.search(r"bytes_received:(\d+)", line)
            if m:
                out[key] = int(m.group(1))
            key = None
    return out


def sample_speed(dt):
    cur = socket_bytes()
    rates = {s: 0.0 for s in SPEED_SOURCES}
    for k, v in cur.items():
        if k in speed["prev"]:
            rates[k[0]] += max(0, v - speed["prev"][k]) / dt
    speed["prev"] = cur
    now = time.time()
    with lock:
        arch = dict((remote_view().get("fast") or {}).get("archiver") or {})
    prev = speed.get("arch_prev") or {}
    rates[f"{NODE}_raw"] = sum(max(0, v["raw"] - prev[k]["raw"]) for k, v in arch.items() if k in prev) / dt
    speed["arch_prev"] = arch
    speed["live"].append({"t": now} | rates)
    minute = int(now // 60) * 60
    if speed["minute"] is not None and minute != speed["minute"] and speed["acc"]:
        pool.submit(stats_put, [(speed["minute"], "copy", s, sum(v) / len(v)) for s, v in speed["acc"].items()])
        speed["acc"] = {}
    speed["minute"] = minute
    for s, v in rates.items():
        speed["acc"].setdefault(s, []).append(v)
    return rates


LIMITS_PATHS = ("/usr/local/etc/component-limits.json", os.path.join(HERE, "component-limits.json"))
_LIMITS = {"m": None, "j": None}
def limits():   # one component definition shared with fan-control (2026-09-26); None = built-in defaults
    for p in LIMITS_PATHS:
        try:
            m = os.path.getmtime(p)
        except OSError:
            continue
        if m != _LIMITS["m"]:
            try:
                with open(p) as f:
                    _LIMITS["j"] = json.load(f)
            except Exception:
                _LIMITS["j"] = None
            _LIMITS["m"] = m
        return _LIMITS["j"]
    return None
def lim(kind, dflt, host=None):
    j = limits() or {}
    v = dict(((j.get("kinds") or {}).get(kind) or {}), **(((j.get("hosts") or {}).get(host) or {}).get(kind) or {}))
    return (v["yellow"], v["red"]) if v.get("yellow") is not None and v.get("red") is not None else dflt
KERR = re.compile(r"I/O error|critical medium error|medium error|unrecovered read|exception Emask|failed command|"
                  r"nvme.*(timeout|reset)|resetting controller|megaraid.*(error|fault)|sense key", re.I)


def smart_parse(j, host, dev, rc):
    temp = j.get("temperature") or {}
    d = {"host": host, "dev": dev, "serial": j.get("serial_number"), "rc": rc,
         "model": j.get("model_name") or " ".join(x for x in (j.get("scsi_vendor"), j.get("scsi_product")) if x),
         "proto": "NVMe" if "nvme_smart_health_information_log" in j else "SAS" if "scsi_error_counter_log" in j else "ATA",
         "passed": (j.get("smart_status") or {}).get("passed"), "temp": temp.get("current"), "trip": temp.get("drive_trip"),
         "hours": (j.get("power_on_time") or {}).get("hours"), "size": (j.get("user_capacity") or {}).get("bytes")}
    attrs = {a["id"]: a["raw"]["value"] for a in (j.get("ata_smart_attributes") or {}).get("table", [])}
    if attrs:
        d.update(realloc=attrs.get(5), pending=attrs.get(197), crc=attrs.get(199),
                 uncorrect=(attrs.get(187) or 0) + (attrs.get(198) or 0))
    n = j.get("nvme_smart_health_information_log")
    if n:
        d.update(wear=n.get("percentage_used"), spare=n.get("available_spare"), media=n.get("media_errors"),
                 crit=n.get("critical_warning"), errlog=n.get("num_err_log_entries"))
    s = j.get("scsi_error_counter_log")
    if s:
        d.update(grown=j.get("scsi_grown_defect_list"),
                 unc=sum((s.get(k) or {}).get("total_uncorrected_errors", 0) for k in ("read", "write", "verify")),
                 dcorr={k: (s.get(k) or {}).get("errors_corrected_by_eccdelayed", 0) for k in ("read", "write", "verify")})
    return d


def smart_run(cmd, host, dev):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        return smart_parse(json.loads(r.stdout or "{}"), host, dev, r.returncode)
    except Exception as e:
        return {"host": host, "dev": dev, "error": str(e)[:160]}


def kernel_errors():
    try:
        r = subprocess.run(["sudo", "-n", "journalctl", "-k", "--since", "-1h", "-o", "cat", "--no-pager"],
                           capture_output=True, text=True, timeout=30)
    except Exception:
        return None
    out = {}
    for line in r.stdout.splitlines():
        if KERR.search(line):
            m = re.search(r"\b(sd[a-z]+|nvme\d+(?:n\d+)?|ata\d+(?:\.\d+)?)\b", line)
            k = m.group(1) if m else "other"
            out[k] = out.get(k, 0) + 1
    return out


HEALTH_EVERY = 600
health = {MAIN: {}, "base": {}, "last": {}, "hist": {}, "graded": {"at": 0, "drives": []}}
COUNTERS = ("realloc", "pending", "uncorrect", "crc", "media", "unc", "grown")


def main_health():
    try:
        disks = json.loads(subprocess.run(["lsblk", "-J", "-dn", "-o", "NAME,TYPE,TRAN"], capture_output=True, text=True).stdout)["blockdevices"]
    except Exception:
        disks = []
    # never SMART-poll USB disks (2026-09-29: USB bridges/cradles hang on SMART/power queries; 1b supplies those values from its own logs)
    drives = [smart_run(["sudo", "-n", "smartctl", "-j", "-a", "/dev/" + d["name"]], HOST, d["name"]) for d in disks if d.get("type") == "disk" and (d.get("tran") or "").lower() != "usb"]
    return {"at": time.time(), "drives": drives, "kernel": kernel_errors()}


CRC_SEEN_FILE = os.path.join(HERE, "crc-seen.json")


def crc_changed_at(key, v):   # when this drive's CRC counter last changed (persisted); first sight counts as "long ago"
    try:
        with open(CRC_SEEN_FILE) as f:
            seen = json.load(f)
    except (OSError, ValueError):
        seen = {}
    old = seen.get(key)
    if old is None or old[0] != v:
        at = time.time() if old is not None else 0
        seen[key] = [v, at]
        try:
            with open(CRC_SEEN_FILE + ".tmp", "w") as f:
                json.dump(seen, f)
            os.replace(CRC_SEEN_FILE + ".tmp", CRC_SEEN_FILE)
        except OSError:
            pass
        return at
    return old[1]


def grade(d, base, rate_h, kerr):
    if d.get("error"):
        return "unknown", [("watch", "SMART read failed: " + d["error"])]
    issues = []
    if d.get("passed") is False:
        issues.append(("bad", "SMART health: FAILED"))
    if (d.get("rc") or 0) & 8:
        issues.append(("bad", "smartctl reports the disk is failing"))
    labels = {"pending": "pending sectors", "uncorrect": "uncorrectable errors", "media": "media errors", "unc": "uncorrected errors",
              "realloc": "reallocated sectors", "crc": "interface CRC errors (cable/backplane)", "grown": "grown defects"}
    for f, lab in labels.items():
        v, b = d.get(f), (base or {}).get(f)
        if not v:
            continue
        if f == "crc" and b is not None and v > b:   # link errors (cable/backplane), not a drive fault: only "watch" while still rising (2026-09-29)
            since = crc_changed_at(d.get("serial") or d.get("dev"), v)
            if time.time() - since < 86400:
                issues.append(("watch", f"{lab}: {v}, rising (up from {b} at baseline; last increase {time.strftime('%m-%d %H:%M', time.localtime(since))})"))
            else:
                issues.append(("info", f"{lab}: {v}, not rising{' since ' + time.strftime('%m-%d %H:%M', time.localtime(since)) if since else ''} (up from {b} at baseline): an old cable/backplane link problem, not a drive fault"))
        elif b is not None and v > b:
            issues.append(("bad", f"{lab}: {v}, up from {b} at baseline"))
        elif f in ("pending", "uncorrect", "media", "unc"):
            issues.append(("bad", f"{lab}: {v}"))
        else:
            issues.append(("info", f"{lab}: {v}, unchanged since baseline"))
    if d.get("crit"):
        issues.append(("bad", f"NVMe critical warning {d['crit']}"))
    if d.get("spare") is not None and d["spare"] < 20:
        issues.append(("watch", f"spare {d['spare']}% left"))
    if (d.get("wear") or 0) >= 80:
        issues.append(("watch", f"{d['wear']}% of rated endurance used"))
    t = d.get("temp")
    model = (d.get("model") or "").lower()
    h = d.get("host")
    warn, bad = lim("nvme", (80, 81), h) if d.get("proto") == "NVMe" else lim("ssd", (69, 70), h) if "wd red" in model else lim("toshiba", (45, 50), h) if "mg03sca" in model else lim("hdd", ((d.get("trip") or 60) - 5, d.get("trip") or 60), h)
    if t is not None and t >= bad:
        issues.append(("bad", f"{t}°C, at or over {bad}°C"))
    elif t is not None and t >= warn:
        issues.append(("watch", f"{t}°C, at the {warn}°C warning"))
    for k, r in (rate_h or {}).items():
        if r > 50:
            issues.append(("watch", f"delayed-corrected {k} errors climbing: +{r:.0f}/h"))
    if kerr:
        issues.append(("watch", f"{kerr} kernel disk errors in the last hour"))
    lv = [l for l, _ in issues]
    return ("bad" if "bad" in lv else "watch" if "watch" in lv else "ok"), issues


def health_setup(c):
    c.execute("select serial, details, unix_timestamp(checked_at), result from drive_checks where check_type = 'smart' and recorded_by = 'dashboard' "
              "and details is not null order by checked_at")
    for serial, details, t, result in c.fetchall():
        try:
            d = json.loads(details)
        except ValueError:
            continue
        health["base"].setdefault(serial, d)
        health["last"][serial] = {"t": float(t), "result": result, "d": d}


def health_loop():
    last_main = 0
    while True:
        t0 = time.time()
        try:
            if t0 - last_main >= HEALTH_EVERY:
                health[MAIN] = main_health()
                last_main = t0
            with lock:
                r7 = dict((remote_view().get("fast") or {}).get("drive_health") or {})
            sets = [health[MAIN], r7]
            out, writes = [], []
            for hs in sets:
                kern = hs.get("kernel") or {}
                for d in hs.get("drives") or []:
                    serial = d.get("serial") or f"{d.get('host')}:{d.get('dev')}"
                    snap = {k: d.get(k) for k in COUNTERS + ("temp", "hours", "wear", "spare", "crit")} | {"dcorr": d.get("dcorr")}
                    base = health["base"].get(serial)
                    hist = health["hist"].setdefault(serial, deque(maxlen=40))
                    if d.get("dcorr") and (not hist or hist[-1][0] < hs.get("at", 0)):
                        hist.append((hs.get("at", 0), d["dcorr"]))
                    rate_h = {}
                    old = [x for x in hist if hist[-1][0] - x[0] >= 3000]
                    if old and d.get("dcorr"):
                        t_old, c_old = old[-1]
                        rate_h = {k: (d["dcorr"][k] - c_old.get(k, 0)) * 3600 / (hist[-1][0] - t_old) for k in d["dcorr"]}
                    kerr = kern.get(d["dev"]) if d.get("host") == HOST else None
                    level, issues = grade(d, base, rate_h, kerr)
                    out.append(d | {"serial": serial, "level": level, "issues": issues, "rate_h": rate_h, "base": base,
                                    "checked": hs.get("at"), "kernel_host": kern})
                    if d.get("error"):
                        continue
                    last = health["last"].get(serial)
                    changed = last is None or last["result"] != level or any(last["d"].get(k) != snap.get(k) for k in COUNTERS)
                    if changed or t0 - last["t"] >= 6 * 3600:
                        writes.append((serial, d.get("host"), level, json.dumps(snap)))
                        health["last"][serial] = {"t": t0, "result": level, "d": snap}
                        health["base"].setdefault(serial, snap)
            if writes:
                db = dbconn()
                try:
                    db.cursor().executemany("insert into drive_checks(serial, checked_at, host, check_type, result, details, recorded_by) "
                                            "values(%s, now(), %s, 'smart', %s, %s, 'dashboard')", writes)
                finally:
                    db.close()
            with lock:
                state["health"] = {"at": t0, "drives": out, "kernel": {HOST: health[MAIN].get("kernel"), NODE: r7.get("kernel")},
                                   f"{NODE}_error": r7.get("error") or (None if r7 else f"no report from the {NODE} agent yet")}
            inv = [(d.get("hours"), d.get("realloc"), d.get("pending"), d.get("uncorrect") if d.get("uncorrect") is not None else d.get("unc"),
                    d.get("crc"), d.get("media"), d.get("wear"), d.get("temp"), d.get("level"), f"{d.get('host')}/{d.get('dev')}", d["serial"])
                   for d in out if d.get("serial") and not d.get("error")]
            if inv:   # drive inventory (2026-09-29: age, hours and errors per drive, for choosing offsite drives); SMART pass owns these columns
                db = dbconn()
                try:
                    db.cursor().executemany("update drives set power_on_hours=%s, reallocated=%s, pending=%s, uncorrectable=%s, crc_errors=%s, media_errors=%s, "
                                            "percentage_used=%s, temp_c=%s, health_level=%s, health_checked_at=now(), location=%s where serial=%s", inv)
                finally:
                    db.close()
        except Exception as e:
            print("health:", e, flush=True)
        time.sleep(max(10, 60 - (time.time() - t0)))


def ipmi_sensors(prefix):
    out = {"at": time.time(), "fans": [], "temps": [], "redundancy": None, "power_w": None}
    for typ in ("Fan", "Temperature", "Current"):
        try:
            r = subprocess.run(prefix + ["sdr", "type", typ], capture_output=True, text=True, timeout=20).stdout
        except Exception as e:
            out["error"] = str(e)[:120]
            continue
        for line in r.splitlines():
            f = [x.strip() for x in line.split("|")]
            if len(f) < 5:
                continue
            name, _, st, ent, val = f[:5]
            m = re.match(r"([\d.]+)\s*(RPM|degrees C|Watts)", val)
            if typ == "Fan":
                if m and m.group(2) == "RPM":
                    out["fans"].append({"name": name.replace(" RPM", ""), "rpm": float(m.group(1)), "ok": st == "ok"})
                elif "Redundan" in name:
                    out["redundancy"] = val
            elif typ == "Temperature" and m:
                label = {"3.1": "CPU1", "3.2": "CPU2"}.get(ent, name) if name == "Temp" else name.replace(" Temp", "")
                out["temps"].append({"name": label, "c": float(m.group(1)), "ok": st == "ok"})
            elif typ == "Current" and m and m.group(2) == "Watts":
                out["power_w"] = float(m.group(1))
    return out


SERVER_FAN_EVERY = 5   # server fans/temps every 5 s, re-read 0/3/8 s after fan-control changes the set %; GPU fan/temp every 1 s; always the latest reading


def ipmi_temps(txt):
    out = []
    for line in txt.splitlines():
        f = [x.strip() for x in line.split("|")]
        m = re.match(r"([\d.]+)\s*degrees C", f[4]) if len(f) >= 5 else None
        if m:
            label = {"3.1": "CPU1", "3.2": "CPU2"}.get(f[3], f[0]) if f[0] == "Temp" else f[0].replace(" Temp", "")
            out.append((label, float(m.group(1)), f[2] == "ok"))
    return out


def psu_read(prefix, cache):
    out = {1: {}, 2: {}}
    try:
        for typ in ("Voltage", "Current", "Power Supply"):
            r = subprocess.run(prefix + ["-S", cache, "sdr", "type", typ], capture_output=True, text=True, timeout=10).stdout
            st = 0
            for line in r.splitlines():
                f = [x.strip() for x in line.split("|")]
                if len(f) < 5:
                    continue
                m = re.match(r"(Voltage|Current) ([12])$", f[0])
                if m:
                    n = int(m.group(2))
                    v = re.match(r"([\d.]+)\s*(Volts|Amps)", f[4])
                    out[n]["v" if m.group(1) == "Voltage" else "a"] = float(v.group(1)) if v else None
                elif typ == "Power Supply" and f[0] == "Status":
                    st += 1
                    if st in out:
                        out[st]["status"] = f[4]
        return {f"ps{n}": d for n, d in out.items()}
    except (subprocess.TimeoutExpired, OSError):
        return None


def fan_loop(prefix, cache, gpu_fan=None, gpu_temp=None):
    srv, it, hw, gf, gt, last_srv = deque(), deque(), deque(), deque(), deque(), 0
    psu_now = None
    set_pct, resample = None, []
    while True:
        t0 = time.time()
        try:
            try:
                with open("/run/fan-control.json") as f:
                    pct = json.load(f).get("fan_pct")
            except (OSError, ValueError):
                pct = set_pct
            if pct != set_pct:
                if set_pct is not None:
                    resample = [t0, t0 + 3, t0 + 8]
                set_pct = pct
            due = [x for x in resample if x <= t0]
            if due:
                resample = [x for x in resample if x > t0]
                last_srv = 0
            if t0 - last_srv >= SERVER_FAN_EVERY:
                last_srv = t0
                if not os.path.exists(cache):
                    subprocess.run(prefix + ["sdr", "dump", cache], capture_output=True, timeout=60)
                r = subprocess.run(prefix + ["-S", cache, "sdr", "type", "Fan"], capture_output=True, text=True, timeout=10).stdout
                rpm = {}
                for line in r.splitlines():
                    f = [x.strip() for x in line.split("|")]
                    m = re.match(r"([\d.]+)\s*RPM", f[4]) if len(f) >= 5 else None
                    if m:
                        rpm[f[0].replace(" RPM", "")] = (float(m.group(1)), f[2] == "ok")
                if rpm:
                    srv.append((t0, rpm))
                psu_now = psu_read(prefix, cache)
                r = subprocess.run(prefix + ["-S", cache, "sdr", "type", "Temperature"], capture_output=True, text=True, timeout=10).stdout
                tl = ipmi_temps(r)
                if tl:
                    it.append((t0, tl))
                hw.append((t0, temps()))
            for q, fn in ((gf, gpu_fan), (gt, gpu_temp)):
                v = fn() if fn else None
                if v is not None:
                    q.append((t0, v))
            for h in (srv, it, hw, gf, gt):
                while len(h) > 1:
                    h.popleft()
            fans = [{"name": n, "rpm": v, "ok": ok, "at": srv[-1][0]} for n, (v, ok) in srv[-1][1].items()] if srv else None
            itemps = [{"name": n, "c": v, "ok": ok} for n, v, ok in it[-1][1]] if it else None
            hwlatest = hw[-1][1] if hw else None
            with lock:
                state["fanlatest"] = {"at": t0, "fans": fans, "ipmi_temps": itemps, "temps": hwlatest,
                                      "gpu_rpm": gf[-1][1] if gf else None, "gpu_temp": gt[-1][1] if gt else None,
                                      "server_every_s": SERVER_FAN_EVERY, "gpu_every_s": 1}
                if isinstance(state.get("ipmi"), dict):
                    if psu_now:
                        state["ipmi"]["psu"] = dict(psu_now, at=t0)
                    if fans:
                        state["ipmi"]["fans"] = fans
                    if itemps:
                        state["ipmi"]["temps"] = itemps
        except Exception as e:
            print("fan_loop:", e, flush=True)
        time.sleep(max(0.2, 1 - (time.time() - t0)))


def ipmi_loop(prefix, check=None):
    while True:
        t0 = time.time()
        if check and not os.path.exists(check):
            v = {"at": t0, "error": f"{check} missing (copy ipmitool + libfreeipmi from the {MAIN} after a reboot)"}
        else:
            v = ipmi_sensors(prefix)
        with lock:
            fm = state.get("fanlatest")
            if fm and t0 - fm["at"] < 15:
                if fm.get("fans"):
                    v["fans"] = fm["fans"]
                if fm.get("ipmi_temps"):
                    v["temps"] = fm["ipmi_temps"]
            state["ipmi"] = v
        time.sleep(max(5, 30 - (time.time() - t0)))




PW_SAMPLES = {"q": deque(maxlen=330), "gpu": deque(maxlen=330), "started": False}


def power_sampler(prefix, gpu_mw=None):
    while True:
        t0 = time.time()
        r = dcmi_read(prefix)
        if r and r.get("w") is not None:
            PW_SAMPLES["q"].append((t0, r["w"]))
        if gpu_mw:
            try:
                v = gpu_mw()
                if v is not None:
                    PW_SAMPLES["gpu"].append((t0, v))
            except Exception:
                pass
        time.sleep(max(0.2, 1 - (time.time() - t0)))


def dcmi_power(prefix, gpu_mw=None):
    if not PW_SAMPLES["started"]:
        PW_SAMPLES["started"] = True
        threading.Thread(target=power_sampler, args=(prefix, gpu_mw), daemon=True).start()
    q = list(PW_SAMPLES["q"])
    if not q:
        return None
    now = time.time()
    win = lambda s, qq=q: [w for t, w in qq if now - t <= s]
    g = list(PW_SAMPLES["gpu"])
    gw = lambda s: [w for t, w in g if now - t <= s]
    return {"t": q[-1][0], "w": q[-1][1], "peak_5s": max(win(5) or [q[-1][1]]), "max": max(win(60) or [q[-1][1]]),
            "avg": sum(win(60) or [q[-1][1]]) / len(win(60) or [1]), "min": min(win(60) or [q[-1][1]]), "samples_60s": len(win(60)), "max_5m": max(win(300) or [q[-1][1]]),
            "gpu_w": g[-1][1] if g else None, "gpu_peak_5s": max(gw(5)) if gw(5) else None, "every_s": 1}


def dcmi_read(prefix):
    try:
        r = subprocess.run(prefix + ["dcmi", "power", "reading"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    grab = lambda k: (lambda m: float(m.group(1)) if m else None)(re.search(k + r"[^:]*:\s*([\d.]+)\s*Watts", r))
    w = grab("Instantaneous power reading")
    return {"t": time.time(), "w": w, "avg": grab("Average power reading"), "min": grab("Minimum during"), "max": grab("Maximum during")} if w is not None else None


power = {"live": deque(maxlen=240), "acc": {}, "minute": None}


env = {"live": deque(maxlen=150), "acc": {}, "minute": None, "last": 0}
gpu_live = {"pts": deque(maxlen=180), "ts": None}
box_gpu_live = {"pts": deque(maxlen=1440), "at": None}   # GPU in the intake box, from the intake box's agent every 5 s, 2 h (2026-10-26)
laptop_gpu_live = {"pts": deque(maxlen=1440), "at": None}   # the laptop's GPU (now a GPU worker), from the laptop agent's push, 2 h (2026-10-31)


def host_temp_max(host, F, drives):
    vals = [x["c"] for x in (F.get("ipmi") or {}).get("temps", []) if x.get("name") != "Inlet"]
    t = F.get("temps") or {}
    vals += list(t.get("coretemp") or []) + list(t.get("nvme") or [])
    vals += [d["temp"] for d in drives if d.get("host") == host and d.get("temp") is not None]
    return max(vals) if vals else None


def laptop_temp_max(F):
    sn = F.get("sensors") or {}
    vals = [v for v in (sn.get("cpu"), sn.get("gpu"), sn.get("board"), (F.get("gpu") or {}).get("temp")) if v]
    vals += [s["temp"] for s in sn.get("ssd") or [] if s.get("temp")]
    return max(vals) if vals else None


def fan_max(F):
    fans = (F.get("ipmi") or {}).get("fans") or []
    return max(f["rpm"] for f in fans) if fans else None


def laptop_power(F):
    p = F.get("power") or {}
    if p.get("w") is not None:
        return p["w"]
    parts = [x for x in (p.get("cpu_pkg_w"), (F.get("gpu") or {}).get("power_w")) if x is not None]
    return sum(parts) if parts else None


FAN_MODES = {}
FAN_MODES_SQL = ("create table if not exists fan_modes(id bigint auto_increment primary key, ts datetime(3) not null, "
                 "host varchar(16) not null, from_mode varchar(16), to_mode varchar(16) not null, fan_pct int, "
                 "reason varchar(255), emergency varchar(255), key(ts), key(host, ts))")


def fan_mode_put(row):
    db = dbconn()
    try:
        c = db.cursor()
        c.execute(FAN_MODES_SQL)
        if row[2] is None:
            c.execute("select to_mode from fan_modes where host=%s order by ts desc, id desc limit 1", (row[1],))
            last = c.fetchone()
            if last and last[0] == row[3]:
                return
            row = row[:2] + ((last[0] if last else None),) + row[3:]
        c.execute("insert into fan_modes(ts, host, from_mode, to_mode, fan_pct, reason, emergency) "
                  "values(from_unixtime(%s), %s, %s, %s, %s, %s, %s)", row)
    finally:
        db.close()


def log_fan_modes(own):
    with lock:
        rv = remote_view()
    rf = (rv.get("fast") or {}) if rv.get("ok") else {}
    for host, fc in ((MAIN, own.get("fan_control")), (NODE, rf.get("fan_control"))):
        if not fc or not fc.get("mode") or time.time() - (fc.get("ts") or 0) > 30:
            continue
        prev = FAN_MODES.get(host)
        if prev != fc["mode"]:
            FAN_MODES[host] = fc["mode"]
            pool.submit(fan_mode_put, (fc["ts"], host, prev, fc["mode"], fc.get("fan_pct"), (fc.get("driven_by") or "")[:255],
                                       ",".join(fc.get("emergency") or [])[:255]))


EMERG_FILE, EMERG_KEEP = os.path.join(HERE, "emergencies.json"), 7 * 86400
try:
    with open(EMERG_FILE) as _f:
        EMERGENCIES = json.load(_f)
except (OSError, ValueError):
    EMERGENCIES = []


def emerg_temp(fc, name):
    if name == "exhaust":
        return fc.get("exhaust")
    for k in ("drives", "nvme", "cpus", "gpus"):
        v = (fc.get(k) or {}).get(name)
        if v is None and k in ("drives", "nvme"):
            v = (fc.get(k) or {}).get("/dev/" + name)
        if v is not None:
            return round(v)
    return None


LAST_ADAPT = {}


def emerg_track(host, fc, now):
    open_ep = next((e for e in EMERGENCIES if e["host"] == host and e.get("end") is None), None)
    hot = fc.get("emergency") or []
    fresh = fc.get("ts") and now - fc["ts"] < 60
    if not fresh:
        return False
    if not hot and fc.get("mode") != "emergency":
        a = fc.get("adaptive") or {}
        LAST_ADAPT[host] = {"mode": fc.get("mode"), "fan_pct": fc.get("fan_pct"), "target_rpm": a.get("target_rpm"), "max_rpm": a.get("max_rpm"), "ts": fc.get("ts")}
    if not hot:
        if open_ep:
            open_ep["end"] = fc["ts"]
            return True
        return False
    detail = fc.get("emergency_detail") or {}
    if not open_ep:
        pre = LAST_ADAPT.get(host) or {}
        lowered = (pre.get("mode") == "run-adaptive" and pre.get("target_rpm") is not None and pre.get("max_rpm") is not None
                   and pre["target_rpm"] < pre["max_rpm"])
        open_ep = {"host": host, "start": fc["ts"], "end": None, "why": (fc.get("driven_by") or "")[:300], "fan_pct": fc.get("fan_pct"), "sensors": {},
                   "before": pre, "lowered_target": lowered}
        EMERGENCIES.append(open_ep)
    changed = False
    for n in hot:
        t = emerg_temp(fc, n)
        d = detail.get(n) if isinstance(detail.get(n), dict) else {}
        if n not in open_ep["sensors"]:
            open_ep["sensors"][n], changed = {"first": t, "peak": t, "at": fc["ts"]}, True
        sv = open_ep["sensors"][n]
        if d.get("enter") is not None:
            sv["enter"] = d["enter"]
        if d.get("kind"):
            sv["kind"] = d["kind"]
        if t is not None and (sv.get("peak") is None or t > sv["peak"]):
            sv["peak"], changed = t, True
    open_ep["now"] = {n: emerg_temp(fc, n) for n in hot}
    open_ep["fan_pct"] = fc.get("fan_pct")
    if fc.get("gpu"):
        g = fc["gpu"]
        open_ep["gpu"] = {"temp": g.get("temp"), "limit_set": g.get("limit_set"), "card_fan": g.get("card_manual") or g.get("card_fan")}
    return changed


TEMP_HIST = {MAIN: deque(maxlen=480), NODE: deque(maxlen=480), BOX: deque(maxlen=480)}   # every sensor, every 15 s, 2 h (2026-09-28)
IO_HIST = {h: {"net": deque(maxlen=480), "disk": deque(maxlen=480), "gpujobs": deque(maxlen=480), "mem": deque(maxlen=480)} for h in (MAIN, NODE, BOX)}   # per NIC / per drive, 15 s, 2 h (2026-09-28)
_io_prev = {}
def _local_nics():
    out = {}
    with open("/proc/net/dev") as fh:
        for line in fh.readlines()[2:]:
            name, rest = line.split(":", 1)
            name, v = name.strip(), rest.split()
            if name == "lo" or name.startswith(("docker", "veth", "br-", "virbr", "tun", "tap")):
                continue
            out[name] = {"rx": int(v[0]), "tx": int(v[8])}
    return out
def io_sample(now, own_f, rem_f, box_f=None):
    box_f = box_f or {}
    for host, f, nics in ((MAIN, own_f, _local_nics()), (NODE, rem_f, (rem_f.get("net") or {}).get("nics") or {}),
                          (BOX, box_f, (box_f.get("net") or {}).get("nics") or {})):
        prev = _io_prev.get(host)
        if nics and prev and now > prev[0]:
            dt = now - prev[0]
            rates = {n: {"rx": max(0, (c["rx"] - prev[1][n]["rx"]) / dt), "tx": max(0, (c["tx"] - prev[1][n]["tx"]) / dt)}
                     for n, c in nics.items() if n in prev[1] and c.get("rx") is not None}
            if rates:
                IO_HIST[host]["net"].append([now, {n: {k: round(v) for k, v in r.items()} for n, r in rates.items()}])
        if nics:
            _io_prev[host] = (now, {n: {"rx": c.get("rx") or 0, "tx": c.get("tx") or 0} for n, c in nics.items()})
        gj = {j.get("_key", "job"): {"rate": j.get("rate_per_s") if now - (j.get("updated_at") or 0) < 120 else 0, "unit": j.get("unit"), "job": j.get("job"),
                                     "state": j.get("state") if now - (j.get("updated_at") or 0) < 300 else "stopped"}
              for j in (f.get("gpu_jobs") or []) if isinstance(j.get("rate_per_s"), (int, float)) and now - (j.get("updated_at") or 0) < 86400}   # a silent feed (paused/stopped job) plots 0, not a gap (2026-09-28)
        if gj:
            IO_HIST[host]["gpujobs"].append([now, gj])
        m, bw = f.get("mem") or {}, f.get("ram_bw") or {}   # RAM used and RAM bandwidth (IMC counters) per server (2026-09-28)
        if m.get("total"):
            bw = bw if now - (bw.get("ts") or 0) < 30 else {}
            IO_HIST[host]["mem"].append([now, {"used": m["total"] - (m.get("avail") or 0), "total": m["total"],
                                               "rd": round(bw["read_bps"]) if bw.get("read_bps") is not None else None,
                                               "wr": round(bw["write_bps"]) if bw.get("write_bps") is not None else None}])
        dk = {d: {"r": round(v.get("read") or 0), "w": round(v.get("write") or 0)} for d, v in (f.get("disks") or {}).items()
              if not d.startswith(("loop", "dm-", "zram", "ram"))}
        if dk:
            IO_HIST[host]["disk"].append([now, dk])


def temp_hist_loop():
    while True:
        try:
            with lock:
                own_f = state.get("fast") or {}
                rv = remote_view()
                tv = box_view()
            now = round(time.time())
            box_f = (tv.get("fast") or {}) if tv.get("ok") else {}
            try:
                io_sample(now, own_f, (rv.get("fast") or {}) if rv.get("ok") else {}, box_f)
            except Exception:
                pass
            for host, f in ((MAIN, own_f), (NODE, (rv.get("fast") or {}) if rv.get("ok") else {}), (BOX, box_f)):
                fc = f.get("fan_control") or {}
                m = {}
                if not fc:   # the intake box has no fan-control: plain hwmon sensors from the agent (k10temp, nvme, amdgpu)
                    for n, vals in (f.get("temps") or {}).items():
                        for i, t in enumerate(vals if isinstance(vals, list) else [vals]):
                            if isinstance(t, (int, float)):
                                m[n if i == 0 else f"{n}-{i}"] = round(t, 1)
                    if m:
                        TEMP_HIST[host].append([now, m])
                    continue
                for grp in ("drives", "nvme", "cpus", "gpus", "raid"):
                    for n, t in (fc.get(grp) or {}).items():
                        if isinstance(t, (int, float)):
                            m[str(n).replace("/dev/", "")] = round(t, 1)
                if isinstance(fc.get("exhaust"), (int, float)):
                    m["exhaust"] = fc["exhaust"]
                for x in ((f.get("ipmi") or {}).get("temps") or []):
                    if "inlet" in str(x.get("name", "")).lower() and isinstance(x.get("c"), (int, float)):
                        m["inlet"] = x["c"]
                if m:
                    TEMP_HIST[host].append([now, m])
        except Exception:
            pass
        time.sleep(15)


def emerg_loop():
    while True:
        now = time.time()
        try:
            with lock:
                own = (state.get("fast") or {}).get("fan_control") or {}
                rv = remote_view()
            rf = ((rv.get("fast") or {}).get("fan_control") or {}) if rv.get("ok") else {}
            dirty = False
            with lock:
                for host, fc in ((MAIN, own), (NODE, rf)):
                    dirty |= bool(emerg_track(host, fc, now))
                keep = [e for e in EMERGENCIES if e.get("end") is None or now - e["end"] < EMERG_KEEP]
                dirty |= len(keep) != len(EMERGENCIES)
                EMERGENCIES[:] = keep[-200:]
                snap = json.dumps(EMERGENCIES)
            if dirty:
                with open(EMERG_FILE + ".tmp", "w") as f:
                    f.write(snap)
                os.replace(EMERG_FILE + ".tmp", EMERG_FILE)
        except Exception as e:
            print("emergency tracker:", e, flush=True)
        time.sleep(5)


def sample_gpu_live(t):
    with lock:
        rv = remote_view()
    fc = ((rv.get("fast") or {}).get("fan_control") or {}) if rv.get("ok") else {}
    g, ag = fc.get("gpu") or {}, ((rv.get("fast") or {}).get("gpu") or {}) if rv.get("ok") else {}
    rb = ((rv.get("fast") or {}).get("ram_bw") or {}) if rv.get("ok") else {}
    rb = rb if t - (rb.get("ts") or 0) < 30 else {}
    if not g or fc.get("ts") == gpu_live["ts"] or t - (fc.get("ts") or 0) > 30:
        return
    gpu_live["ts"] = fc["ts"]
    gpu_live["pts"].append({"t": fc["ts"], "temp": g.get("temp"), "draw": g.get("draw"), "cap": g.get("limit_set") or g.get("limit"),
                            "mhz": g.get("sm_mhz"), "util": g.get("util"), "mode": fc.get("mode"), "emergency": int(bool(g.get("emergency"))),
                            "mem": ag.get("mem_used"), "mem_total": ag.get("mem_total"), "mem_bw": ag.get("mem_util"),
                            "pcie_rx": ag.get("pcie_rx"), "pcie_tx": ag.get("pcie_tx"), "pcie_gen": ag.get("pcie_gen"), "pcie_width": ag.get("pcie_width"),
                            "pcie_gen_max": ag.get("pcie_gen_max"), "pcie_width_max": ag.get("pcie_width_max"),
                            "ram_rd": rb.get("read_bps"), "ram_wr": rb.get("write_bps")})


def sample_box_gpu(t):
    with lock:
        tv = box_view()
    g = ((tv.get("fast") or {}).get("gpu") or {}) if tv.get("ok") else {}
    if not g or tv.get("at") == box_gpu_live["at"]:
        return
    box_gpu_live["at"] = tv["at"]
    box_gpu_live["pts"].append({"t": tv["at"], "temp": g.get("temp"), "draw": g.get("power_w"), "cap": g.get("power_limit_w"), "util": g.get("util"),
                                "fan": g.get("fan_pct"), "rpm": g.get("fan_rpm"), "mem": g.get("mem_used"), "mem_total": g.get("mem_total"),
                                "mem_bw": g.get("mem_util"), "pcie_gen": g.get("pcie_gen"), "pcie_width": g.get("pcie_width")})


def sample_laptop_gpu(t):
    with lock:
        lv = laptop_view()
    g = (lv.get("fast") or {}).get("gpu") or {}
    if not g or not lv.get("at") or t - lv["at"] > 30 or lv["at"] == laptop_gpu_live["at"]:
        return
    laptop_gpu_live["at"] = lv["at"]
    laptop_gpu_live["pts"].append({"t": lv["at"], "temp": g.get("temp"), "draw": g.get("power_w"), "cap": g.get("power_limit_w"), "util": g.get("util"),
                                   "mem": g.get("mem_used"), "mem_total": g.get("mem_total"), "mem_bw": g.get("mem_util"), "pcie_width": g.get("pcie_width")})


def sample_env(t, own):
    try:
        log_fan_modes(own)
    except Exception as e:
        print("fan modes:", e, flush=True)
    try:
        sample_gpu_live(t)
    except Exception as e:
        print("gpu live:", e, flush=True)
    try:
        sample_box_gpu(t)
    except Exception as e:
        print(f"{BOX} gpu live:", e, flush=True)
    try:
        sample_laptop_gpu(t)
    except Exception as e:
        print("laptop gpu live:", e, flush=True)
    if t - env["last"] < 4.5:
        return
    env["last"] = t
    with lock:
        rv, lv, tv = remote_view(), laptop_view(), box_view()
        drives = list((state.get("health") or {}).get("drives") or [])
    rf = (rv.get("fast") or {}) if rv.get("ok") else {}
    tg = ((tv.get("fast") or {}).get("gpu") or {}) if tv.get("ok") else {}   # GPU in the intake box (2026-10-26)
    lf = lv["fast"] if t - (lv.get("at") or 0) <= 30 else {}
    pk = lambda P: (P or {}).get("peak_5s", (P or {}).get("w"))
    tp = lambda P: (P or {}).get("peak_w") if P and t - (P.get("ts") or 0) < 90 else None   # iDRAC true peak, last 30 s window
    a7, a2 = pk(own.get("power")), pk(rf.get("power"))   # rolling combined peaks for power management (: "run power management against peak power")
    i7, i2 = tp(own.get("peak_power")), tp(rf.get("peak_power"))
    PEAKS.append((t, a7 + a2 if a7 is not None and a2 is not None else None, a2, i7 + i2 if i7 is not None and i2 is not None else None, i2))
    vals = {("power", MAIN): pk(own.get("power")), ("power", NODE): pk(rf.get("power")),
            ("power", f"{MAIN}_peak"): tp(own.get("peak_power")), ("power", f"{NODE}_peak"): tp(rf.get("peak_power")),
            ("power", "laptop"): laptop_power(lf) if lf else None,
            ("power", f"{NODE}_gpu"): ((rf.get("power") or {}).get("gpu_peak_5s") or (rf.get("gpu") or {}).get("power_w")) if rf else None,
            ("power", "laptop_gpu"): (lf.get("gpu") or {}).get("power_w") if lf else None,
            ("power", f"{BOX}_gpu"): tg.get("power_w"),
            ("temp", MAIN): host_temp_max(HOST, own, drives), ("temp", NODE): host_temp_max(NODE, rf, drives) if rf else None,
            ("temp", "laptop"): laptop_temp_max(lf) if lf else None,
            ("fan", "laptop"): (lambda fs: max(f["rpm"] for f in fs) if fs else None)(((lf.get("sensors") or {}).get("fans") or [])) if lf else None,
            ("fan", f"{NODE}_gpu"): (rf.get("gpu") or {}).get("fan_rpm") if rf else None,
            ("temp", f"{NODE}_gpu"): (rf.get("gpu") or {}).get("temp") if rf else None,
            ("temp", "laptop_gpu"): (lf.get("gpu") or {}).get("temp") if lf else None,
            ("fan", MAIN): fan_max(own), ("fan", NODE): fan_max(rf) if rf else None}
    for host, P in ((MAIN, (own.get("ipmi") or {}).get("psu")), (NODE, (rf.get("ipmi") or {}).get("psu") if rf else None)):
        for ps in ("ps1", "ps2"):
            vals[("volt", f"{host}_{ps}")] = ((P or {}).get(ps) or {}).get("v") if P and t - (P.get("at") or 0) < 60 else None
    env["live"].append({"t": t} | {f"{g}_{h}": v for (g, h), v in vals.items()})
    minute = int(t // 60) * 60
    if env["minute"] is not None and minute != env["minute"] and env["acc"]:
        pool.submit(stats_put, [(env["minute"], g, h, max(v) if g in ("temp", "power", "fan") else min(v) if g == "volt" else sum(v) / len(v)) for (g, h), v in env["acc"].items() if v])
        env["acc"] = {}
    env["minute"] = minute
    for k, v in vals.items():
        if v is not None:
            env["acc"].setdefault(k, []).append(v)


def sample_power(t, own):
    with lock:
        rv = remote_view()
    r7 = (rv.get("fast") or {}).get("power") if rv.get("ok") else None
    p = {"t": t, MAIN: (own or {}).get("peak_5s", (own or {}).get("w")), NODE: (r7 or {}).get("peak_5s", (r7 or {}).get("w"))}
    stamp = ((own or {}).get("t"), (r7 or {}).get("t"))
    if stamp == power.get("stamp"):
        return
    power["stamp"] = stamp
    power["live"].append(p)
    minute = int(t // 60) * 60
    if power["minute"] is not None and minute != power["minute"] and power["acc"]:
        pool.submit(stats_put, [(power["minute"], "power", k, max(v)) for k, v in power["acc"].items() if v])
        power["acc"] = {}
    power["minute"] = minute
    for k in (MAIN, NODE):
        if p[k] is not None:
            power["acc"].setdefault(k, []).append(p[k])


def compute_remaining():
    with lock:
        q = list(state["db"].get("queue") or [])
        dest = dict(state["slow"].get("dest_bytes") or {})
        intake = dict(state["slow"].get("intake") or {})
        r7 = state[NODE]
        rdest = dict(r7.get("dest_bytes") or {})
        roots = list(r7.get("catalog_roots") or [])
        arch = state["db"].get("archives")
        inflight = (remote_view().get("fast") or {}).get("archiver") or {}
        lf = laptop_view().get("fast") or {}
        landed = {str(k).rstrip("\\").lower(): v for k, v in ((state.get("lapjobs") or {}).get("du") or {}).items() if v is not None}
    out = {}
    if q:
        out["laptop_move"] = sum(max(0, (r["bytes"] or 0) - (dest.get(r["dest_root"]) or 0)) for r in q if r.get("bytes"))
        out["laptop_hash"] = sum((r["bytes"] or 0) * (1 - (r["hashed"] or 0) / r["files"]) for r in q if r.get("files"))
        out["laptop_unmeasured"] = sum(1 for r in q if r.get("bytes") is None)
    sweep, plan = lf.get("sweep") or {}, lf.get("copy_plan") or []
    batch = [(j, sweep.get(j["source"])) for j in plan]
    if batch:
        left = sum(max(0, gb * 1e9 - landed.get(j["dest"].rstrip("\\").lower(), 0)) for j, gb in batch if gb)
        out["laptop_batch_move"] = left
        out["laptop_move"] = out.get("laptop_move", 0) + left
    if arch and arch.get("groups"):
        planned = sum(float(g["raw"] or 0) for g in arch["groups"])
        verified = sum(float(g["raw"] or 0) for g in arch["groups"] if g["status"] == "verified")
        sending = sum(min(float(b["bytes_raw"] or 0), (inflight.get(b["name"]) or {}).get("raw", 0)) for b in arch.get("sending") or [])
        out[f"{NODE}_move"] = max(0, planned - verified - sending)
    elif rdest:
        out[f"{NODE}_move"] = sum(max(0, f["src_bytes"] - (rdest.get(f["dest"]) or 0)) for f in NODE_FOLDERS)
    if roots and intake:
        landed = sum(v or 0 for v in intake.values()) + sum(v or 0 for v in rdest.values())
        catalogued = sum(float(r["bytes"] or 0) for r in roots if str(r["root"]).startswith(INTAKE_PREFIXES))
        unhashed = sum(float(r.get("unhashed_bytes") or 0) for r in roots)
        out[f"{MAIN}_process"] = max(0, landed - catalogued) + unhashed
        out[f"{MAIN}_unhashed"] = unhashed
    return out


TIERS = {"1m": 60, "1h": 3600}
KEEP = {"1m": 86400}
SERVER_METRICS = {"cpu": "cpu", "net_rx": "rx", "net_tx": "tx", "disk_read": "r", "disk_write": "w"}
ROLLUP = """insert into stats(tier, ts, host, metric, value)
    select * from (select %s tier, from_unixtime(floor(unix_timestamp(ts) / %s) * %s) b, host, metric, if(host in ('power', 'temp', 'fan'), max(value), if(host = 'volt', min(value), avg(value))) v
                   from stats where tier = %s and ts >= now() - interval %s second
                   and ts < from_unixtime(floor(unix_timestamp(now()) / %s) * %s) group by b, host, metric) x
    on duplicate key update value = x.v"""


def dbconn(timeout=20):
    return pymysql.connect(read_default_file=CNF, charset="utf8mb4", connect_timeout=5, read_timeout=timeout, autocommit=True)


STATS_PENDING, STATS_PENDING_MAX = [], 50000
stats_lock = threading.Lock()


def stats_put(rows):
    with stats_lock:
        rows = STATS_PENDING + list(rows or [])
        STATS_PENDING.clear()
    if not rows:
        return
    try:
        db = dbconn()
        try:
            db.cursor().executemany("insert ignore into stats(tier, ts, host, metric, value) values('1m', from_unixtime(%s), %s, %s, %s)", rows)
        finally:
            db.close()
    except pymysql.MySQLError as e:
        with stats_lock:
            STATS_PENDING[:0] = rows[-STATS_PENDING_MAX:]
        print(f"stats_put: {len(rows)} rows held for retry ({e})", flush=True)


def stats_backfill(c):
    c.execute("select count(*) from stats")
    if c.fetchone()[0]:
        return
    for tier, secs, keep in (("1m", 60, KEEP["1m"]), ("1h", 3600, None)):
        b = f"from_unixtime(floor(unix_timestamp(ts) / {secs}) * {secs})"
        where = f"ts > now() - interval {keep} second" if keep else "1 = 1"
        sqls = [f"insert ignore into stats select '{tier}', {b} bb, 'copy', source, avg(bytes_per_s) from copy_speed where {where} group by bb, source",
                f"insert ignore into stats select '{tier}', {b} bb, 'remaining', metric, avg(bytes) from remaining_bytes where {where} group by bb, metric"]
        sqls += [f"insert ignore into stats select '{tier}', {b} bb, host, '{m}', avg({m}) from server_stats where {where} group by bb, host"
                 for m in SERVER_METRICS]
        for q in sqls:
            try:
                c.execute(q)
            except Exception as e:
                print("backfill:", e, flush=True)


def rollup_loop():
    last_prune = 0
    while True:
        t0 = time.time()
        try:
            db = dbconn(120)
            try:
                c = db.cursor()
                c.execute(ROLLUP, ("1h", 3600, 3600, "1m", 3 * 3600, 3600, 3600))
                if t0 - last_prune > 600:
                    for tier, keep in KEEP.items():
                        c.execute("delete from stats where tier = %s and ts < now() - interval %s second", (tier, keep))
                    c.execute("delete from stats where tier not in ('1m', '1h')")
                    c.execute("delete from task_samples where ts < now() - interval 7 day")
                    c.execute("delete from tasks where updated_at < now() - interval 30 day")
                    last_prune = t0
                c.execute("select unix_timestamp(ts), metric, value from stats where tier = '1m' and host = 'remaining' "
                          "and ts between now() - interval 3900 second and now() - interval 3300 second order by ts")
                ago = {}
                for t, m, v in c.fetchall():
                    if not ago:
                        ago["t"] = int(t)
                    if int(t) == ago["t"]:
                        ago[m] = v
                with lock:
                    remain["hour_ago"] = ago or None
            finally:
                db.close()
        except Exception as e:
            print("rollup:", e, flush=True)
        time.sleep(max(5, 60 - (time.time() - t0)))


def remaining_state():
    return {"now": remain["now"], "hour_ago": remain["hour_ago"], "series": []}


series_cache = {}


def tier_for(range_s):
    return "1m" if range_s <= 86400 else "1h"


def view_bucket(range_s):
    return 60 if range_s <= 3600 else 120 if range_s <= 21600 else 300 if range_s <= 86400 else 3600


def series(range_s):
    hit = series_cache.get(range_s)
    if hit and time.time() - hit[0] < (5 if range_s <= 600 else 30):
        return hit[1]
    tier = tier_for(range_s)
    db = dbconn()
    try:
        c = db.cursor()
        if range_s <= 600:
            c.execute("select unix_timestamp(ts), host, metric, value from stats where tier = '1m' and host = 'remaining' "
                      "and ts > now() - interval %s second order by ts", (range_s,))
        else:
            vb = view_bucket(range_s)
            c.execute("select floor(unix_timestamp(ts) / %s) * %s t, host, metric, if(host in ('power', 'temp', 'fan'), max(value), if(host = 'volt', min(value), avg(value))) from stats "
                      "where tier = %s and ts > now() - interval %s second group by 1, 2, 3 order by 1", (vb, vb, tier, range_s))
        rows = c.fetchall()
        gb = 60 if range_s <= 21600 else view_bucket(range_s)
        try:
            c.execute("select floor(unix_timestamp(ts) / %s) * %s t, avg(temp_avg), max(temp_max), avg(draw_avg), max(draw_max), avg(limit_w), "
                      "avg(sm_mhz), avg(util_avg), sum(output_tokens) / nullif(sum(output_tokens / nullif(output_tps, 0)), 0), "
                      "sum(prompt_tokens) / nullif(sum(prompt_tokens / nullif(prompt_tps, 0)), 0), max(emergency), "
                      "substring_index(group_concat(mode order by ts desc), ',', 1) from gpu_perf "
                      "where ts > now() - interval %s second group by 1 order by 1", (gb, gb, range_s))
            gpu_rows = c.fetchall()
        except pymysql.MySQLError:
            gpu_rows = []
        gpu_mem = {}
        try:
            c.execute("select floor(unix_timestamp(ts) / %s) * %s t, avg(mem_used_mb), max(mem_total_mb) from gpu_perf "
                      "where ts > now() - interval %s second group by 1", (gb, gb, range_s))
            gpu_mem = {int(r[0]): r[1:] for r in c.fetchall()}
        except pymysql.MySQLError:
            pass
        off = offsite_series(c, range_s, 600 if range_s <= 21600 else max(600, view_bucket(range_s)))
        carve_s = carve_series(c, range_s, 60 if range_s <= 21600 else view_bucket(range_s))
        gpu_pcie = {}
        try:
            c.execute("select floor(unix_timestamp(ts) / %s) * %s t, avg(pcie_rx_mbs), avg(pcie_tx_mbs) from gpu_perf "
                      "where ts > now() - interval %s second group by 1", (gb, gb, range_s))
            gpu_pcie = {int(r[0]): r[1:] for r in c.fetchall()}
        except pymysql.MySQLError:
            pass
        gpu_ram = {}
        try:
            c.execute("select floor(unix_timestamp(ts) / %s) * %s t, avg(ram_read_mbs), avg(ram_write_mbs) from gpu_perf "
                      "where ts > now() - interval %s second group by 1", (gb, gb, range_s))
            gpu_ram = {int(r[0]): r[1:] for r in c.fetchall()}
        except pymysql.MySQLError:
            pass
        gpu_bw = {}
        try:
            c.execute("select floor(unix_timestamp(ts) / %s) * %s t, avg(mem_bw_pct) from gpu_perf "
                      "where ts > now() - interval %s second group by 1", (gb, gb, range_s))
            gpu_bw = {int(r[0]): r[1] for r in c.fetchall()}
        except pymysql.MySQLError:
            pass
    finally:
        db.close()
    f = lambda v: None if v is None else float(v)
    gpu_pts = [{"t": int(r[0]), "temp": f(r[1]), "temp_max": f(r[2]), "draw": f(r[3]), "draw_max": f(r[4]), "cap": f(r[5]), "mhz": f(r[6]),
                "util": f(r[7]), "out_tps": f(r[8]), "prompt_tps": f(r[9]), "emergency": int(r[10] or 0), "mode": r[11],
                "mem": (lambda m: None if m is None else m * 1e6)(f((gpu_mem.get(int(r[0])) or (None, None))[0])),
                "mem_total": (lambda m: None if m is None else m * 1e6)(f((gpu_mem.get(int(r[0])) or (None, None))[1])),
                "mem_bw": f(gpu_bw.get(int(r[0]))),
                "pcie_rx": (lambda v: None if v is None else v * 1e6)(f((gpu_pcie.get(int(r[0])) or (None, None))[0])),
                "pcie_tx": (lambda v: None if v is None else v * 1e6)(f((gpu_pcie.get(int(r[0])) or (None, None))[1])),
                "ram_rd": (lambda v: None if v is None else v * 1e6)(f((gpu_ram.get(int(r[0])) or (None, None))[0])),
                "ram_wr": (lambda v: None if v is None else v * 1e6)(f((gpu_ram.get(int(r[0])) or (None, None))[1]))} for r in gpu_rows]
    hosts, pts, rem, pw = {}, {}, {}, {}
    for t, host, metric, v in rows:
        t, v = int(t), float(v or 0)
        if host == "copy":
            pts.setdefault(t, {"t": t} | {x: 0.0 for x in SPEED_SOURCES})[metric] = v
        elif host == "remaining":
            rem.setdefault(t, {"t": t})[metric] = v
        elif host in ("power", "temp", "fan", "volt"):
            pw.setdefault(t, {"t": t})[f"{host}_{metric}"] = v
        elif metric in SERVER_METRICS:
            hosts.setdefault(host, {}).setdefault(t, {"t": t, "rx": 0, "tx": 0, "r": 0, "w": 0, "cpu": 0})[SERVER_METRICS[metric]] = v
    b = view_bucket(range_s)
    speed_pts = [pts[t] for t in sorted(pts)]
    if range_s <= 600:
        now = time.time()
        with lock:
            speed_pts = [p for p in speed["live"] if p["t"] >= now - range_s]
        pw = {int(p["t"]): p for p in env["live"] if p["t"] >= now - range_s}
        b = 5
    out = {"range_s": range_s, "bucket_s": b,
           "speed": {"bucket_s": b, "range_s": range_s, "sources": list(SPEED_SOURCES), "points": speed_pts},
           "env": {"bucket_s": 30 if range_s <= 600 else b, "range_s": range_s, "points": [pw[t] for t in sorted(pw)]},
           "gpu_perf": {"bucket_s": gb, "range_s": range_s, "points": gpu_pts},
           "offsite": off,
           "carve": carve_s,
           "copilot": copilot_runs(),
           "remaining": {"series": [rem[t] for t in sorted(rem)], "bucket_s": 60 if range_s <= 600 else b},
           "servers": {"bucket_s": b, "hosts": {h: [v[t] for t in sorted(v)] for h, v in hosts.items()}}}
    series_cache[range_s] = (time.time(), out)
    return out


hub_db = {"conn": None, "lock": threading.Lock()}


def hub_cursor():
    if hub_db["conn"] is None:
        hub_db["conn"] = pymysql.connect(read_default_file=CNF, charset="utf8mb4", connect_timeout=5, read_timeout=20,
                                         write_timeout=20, autocommit=True)
    return hub_db["conn"].cursor()


def hub_write(host, report):
    with hub_db["lock"]:
        try:
            c = hub_cursor()
            c.execute("insert into host_reports(host, ts, report) values(%s, now(3), %s) "
                      "on duplicate key update ts = values(ts), report = values(report)", (host, json.dumps(report, default=str)))
        except Exception:
            hub_db["conn"] = None


TASK_STATES = {"queued", "running", "paused", "blocked", "done", "failed", "cancelled"}
TASK_FINAL = {"done", "failed", "cancelled"}
TASK_UNITS = {"bytes", "files", "items", "percent", "seconds"}
TASK_ID = re.compile(r"^[A-Za-z0-9._:/-]{1,120}$")
TASK_STR = {"title": 120, "group": 60, "host": 32, "owner": 40, "phase": 40, "message": 200, "error": 500, "parent": 120, "log": 300}
TASK_NUM = {"done", "total", "rate", "eta_s", "started_at", "finished_at"}
TASK_TABLES = [
    """create table if not exists tasks(id varchar(120) not null primary key, data json not null,
        updated_at datetime(3) not null, key upd(updated_at)) engine=InnoDB""",
    """create table if not exists task_samples(id varchar(120) not null, ts datetime not null, done double,
        primary key(id, ts), key ts(ts)) engine=InnoDB""",
]
tasks = {"items": {}, "samples": {}, "db_minute": {}, "lock": threading.Lock()}


def task_senders():
    return LAPTOP_IPS | NODE_IPS | {"127.0.0.1", CFG['main_ip']}


def task_db(sql, args):
    try:
        db = dbconn()
        try:
            db.cursor().execute(sql, args)
        finally:
            db.close()
    except Exception as e:
        print("tasks db:", e, flush=True)


def apply_task(o, sender, now):
    if not isinstance(o, dict):
        return None, "not an object"
    tid = o.get("id")
    if not isinstance(tid, str) or not TASK_ID.match(tid):
        return None, f"bad id {tid!r}"
    if o.get("delete") is True:
        with tasks["lock"]:
            tasks["items"].pop(tid, None); tasks["samples"].pop(tid, None)
        pool.submit(task_db, "delete from tasks where id = %s", (tid,))
        pool.submit(task_db, "delete from task_samples where id = %s", (tid,))
        return tid, None
    with tasks["lock"]:
        cur = dict(tasks["items"].get(tid) or {"id": tid, "created_at": now})
    for k, v in o.items():
        if k in ("id", "delete"):
            continue
        if v is None:
            cur.pop(k, None)
        elif k in TASK_STR:
            cur[k] = str(v)[:TASK_STR[k]]
        elif k in TASK_NUM:
            try:
                fv = float(v)
            except (TypeError, ValueError):
                return None, f"{tid}: {k} is not a number"
            if fv < 0:
                return None, f"{tid}: {k} is negative"
            cur[k] = fv
        elif k == "state":
            if v not in TASK_STATES:
                return None, f"{tid}: unknown state {v!r}"
            cur[k] = v
        elif k == "unit":
            if v not in TASK_UNITS:
                return None, f"{tid}: unknown unit {v!r}"
            cur[k] = v
        elif k == "heartbeat_s":
            try:
                cur[k] = max(5, min(86400, int(v)))
            except (TypeError, ValueError):
                return None, f"{tid}: heartbeat_s is not a number"
    st = cur.get("state")
    if st == "running" and not cur.get("started_at"):
        cur["started_at"] = now
    if st in TASK_FINAL and not cur.get("finished_at"):
        cur["finished_at"] = now
    if st not in TASK_FINAL and "finished_at" not in o:
        cur.pop("finished_at", None)
    if "eta_s" in o:
        cur["eta_at"] = now
    cur["updated_at"] = now
    cur["reported_from"] = sender
    minute = int(now // 60) * 60
    with tasks["lock"]:
        tasks["items"][tid] = cur
        if o.get("done") is not None:
            sm = tasks["samples"].setdefault(tid, deque(maxlen=400))
            if not sm or now - sm[-1][0] >= 10:
                sm.append((now, cur["done"]))
            write_sample = tasks["db_minute"].get(tid) != minute
            tasks["db_minute"][tid] = minute
        else:
            write_sample = False
    pool.submit(task_db, "insert into tasks(id, data, updated_at) values(%s, %s, from_unixtime(%s)) "
                "on duplicate key update data = values(data), updated_at = values(updated_at)", (tid, json.dumps(cur), now))
    if write_sample:
        pool.submit(task_db, "insert into task_samples(id, ts, done) values(%s, from_unixtime(%s), %s) "
                    "on duplicate key update done = values(done)", (tid, minute, cur["done"]))
    return tid, None


def task_view(t, now):
    v = dict(t)
    sm = list(tasks["samples"].get(t["id"]) or [])
    if v.get("rate") is None and sm and v.get("done") is not None:
        old = [x for x in sm if 60 <= now - x[0] <= 900]
        if old and v.get("state") == "running":
            t0, d0 = old[0]
            v["rate_calc"] = max(0.0, (v["done"] - d0) / max(1, sm[-1][0] - t0))
    r = v.get("rate") if v.get("rate") is not None else v.get("rate_calc")
    if v.get("eta_s") is not None and v.get("eta_at"):
        v["eta"] = max(0, v["eta_s"] - (now - v["eta_at"]))
    elif v.get("state") == "running" and r and v.get("total") is not None and v.get("done") is not None:
        v["eta"] = max(0, (v["total"] - v["done"]) / r)
    age, hb = now - v.get("updated_at", now), v.get("heartbeat_s") or 60
    v["age"] = age
    v["stale"] = 0 if v.get("state") not in ("running", "queued", "paused") else 3 if age > 20 * hb else 2 if age > 10 * hb else 1 if age > 3 * hb else 0
    v["spark"] = [(round(x[0]), x[1]) for x in sm if now - x[0] <= 3600][-60:]
    for k in ("eta", "eta_s", "rate", "rate_calc", "done", "total"):   # JSON has no Infinity/NaN: the page would go blank
        if isinstance(v.get(k), float) and not math.isfinite(v[k]):
            v[k] = None
    return v


def tasks_list(now, active=False, recent_only=True):
    with tasks["lock"]:
        items = list(tasks["items"].values())
    out = []
    for t in items:
        final = t.get("state") in TASK_FINAL
        if active and final:
            continue
        if recent_only and final and t.get("group") != "current" and now - (t.get("finished_at") or t.get("updated_at") or now) > 86400:
            continue
        out.append(task_view(t, now))
    return out


OFFSITE_DIR = os.path.expanduser("~/screenshot-ocr")
OFFSITE = {"now": None}
OFFSITE_SQL = ("create table if not exists offsite_progress(ts datetime not null, batch varchar(80) not null, "
               "hashes int, bytes bigint, primary key(ts, batch))")


JOB_LOCKS = os.path.expanduser("~/job-locks")


def job_locks():
    out = []
    for f in sorted(glob.glob(os.path.join(JOB_LOCKS, "*", "owner"))):
        d = {"job": os.path.basename(os.path.dirname(f))}
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    k, _, v = line.partition(":")
                    if k.strip() in ("owner", "claimed", "what"):
                        d[k.strip()] = v.strip()
        except OSError:
            continue
        out.append(d)
    return out


JOB_PS = {"at": 0, "rows": []}
JOB_DONE_RE = re.compile(r"^\s*(done|finished)\b|held for record|(?-i:\bDONE\b)", re.I)   # lock marked finished by its owner


def _ps_rows():   # the main server process table, cached 20 s
    if time.time() - JOB_PS["at"] > 20:
        out = subprocess.run(["ps", "-eo", "stat=,pcpu=,args="], capture_output=True, text=True, timeout=10).stdout
        JOB_PS.update(at=time.time(), rows=[(l.split(None, 2) + ["", "", ""])[:3] for l in out.splitlines() if l.strip()])
    return JOB_PS["rows"]


def carve_progress():   # 1a's feed (the GPU node /dev/shm/ram-carve-progress.json, copied to the the main server); verified vs assumed kept apart
    try:
        with open(f"/c/{NODE}-prior/ram-carve-progress.json") as f:
            d = json.load(f)
        return {"updated_at": d.get("updated_at"), "loops": {k: {x: v.get(x) for x in ("device", "status", "pct_done", "assumed_done_bytes", "assumed_done_source",
                "pct_done_including_assumed", "target_total_bytes", "unique_done_bytes", "remaining_bytes", "eta_hours", "photorec_running", "rate_bytes_per_s_10min")}
                for k, v in (d.get("loops") or {}).items()}}
    except (OSError, ValueError):
        return None


def job_status(locks, tasks, rf, carve):
    """Per job lock (2026-09-29): running / paused / idle / done / role, plus progress when the job reports it.
    Detected, not declared: scripts (*.py, *.sh) and services (*.service) named in the lock's "what" are looked up in the
    the main server process table (stopped = paused) and systemd; the GPU node jobs use the carve feed and the the GPU node agent's process counts."""
    rows = _ps_rows()
    out = []
    for j in locks:
        what = j.get("what") or ""
        scripts = sorted({os.path.basename(m) for m in re.findall(r"[\w./-]+\.(?:py|sh)\b", what)})
        units = sorted(set(re.findall(r"[\w@.-]+\.(?:service|timer)\b", what)))
        procs = [r for r in rows if any(sc in r[2] for sc in scripts) and "ps -eo" not in r[2]] if scripts else []
        st, detail, prog = None, "", None
        active_units = [u for u in units if subprocess.run(["systemctl", "is-active", "--quiet", u], timeout=5).returncode == 0] if units else []
        if procs:
            stopped = [r for r in procs if r[0].startswith("T")]
            st = "paused" if len(stopped) == len(procs) else "running"
            detail = f"{len(procs)} proc, {sum(float(r[1] or 0) for r in procs):.0f}% CPU"
        elif active_units:
            st, detail = "running", ", ".join(active_units)
        if j.get("job") == f"{NODE}-carve" and carve:
            loops = carve.get("loops") or {}
            run = [k for k, v in loops.items() if v.get("status") == "running"]
            st = "running" if run else "done"
            prog = {"pct": min((v.get("pct_done") or 0) for v in loops.values()) if loops else None,
                    "text": " · ".join(f"{k} {v.get('pct_done') or 0:.1f}%" for k, v in loops.items()) + " verified"}
            detail = f"{len(run)} loop(s) running, {sum(v.get('photorec_running') or 0 for v in loops.values())} photorec"
        if st is None:
            if JOB_DONE_RE.search(what):
                st = "done"
            elif not scripts and not units:
                st = "role"
            else:
                st, detail = "idle", "no process running"
        tk = [t for t in tasks if (t.get("id") or "").split("/")[0] == j.get("job") or t.get("group") == j.get("job")]
        if prog is None and tk:
            t = tk[0]
            if t.get("total"):
                prog = {"pct": 100 * (t.get("done") or 0) / t["total"], "text": f"{t.get('done')} / {t.get('total')} {t.get('unit') or ''}".strip()}
            if t.get("state") in ("paused", "blocked", "failed"):
                st = t["state"]
        out.append(dict(j, status=st, detail=detail, progress=prog))
    return out


CARVE_POS = f"/c/{NODE}-prior/carve-state/positions"
CARVE_SUPERSEDED = {"carve-v2-s2", "carve-v2-s4", "carve-v2-s4b-prev"}
V2_FREE_TOTAL = 4 * 8539336925184


def carve_view():
    rv = remote_view()
    c = ((rv.get("fast") or {}).get("carve") or {}) if rv.get("ok") else {}
    pos = {}
    try:
        for line in open(CARVE_POS):
            f = line.split()
            if len(f) >= 3:
                pos[f[0]] = {"sectors": int(f[1]), "status": f[2], "at": f[3] if len(f) > 3 else None}
    except (OSError, ValueError):
        pass
    free = {}
    for m in ("/b", "/c"):
        try:
            st = os.statvfs(m)
            free[m] = st.f_bavail * st.f_frsize
        except OSError:
            free[m] = None
    b_free = free["/b"]
    devs, now, runs = c.get("devs") or {}, time.time(), []
    for r in c.get("runs") or []:
        n = r["name"]
        if n in CARVE_SUPERSEDED or re.search(r"-prev\d*$", n):
            continue
        size = (devs.get(n) or {}).get("size") or ((devs.get("sdb2") or {}).get("size") if n == "carve-sdb2-all" else None)
        p = pos.get(n) or {}
        prev_b = sum(v["sectors"] * 512 for k, v in pos.items() if re.fullmatch(re.escape(n) + r"-prev\d*", k))
        done_b = p.get("sectors", 0) * 512
        log_age = now - r["log_mtime"] if r.get("log_mtime") else None
        if r.get("exit") or r.get("drained") or p.get("status") == "finished":
            state_ = "finished"
        elif r.get("hold") or r.get("state") == "T":
            state_ = "held"
        elif r.get("state") in ("S", "R", "D") and log_age is not None and log_age > 1800 and (r.get("cpu_pct") or 0) < 1:
            state_ = "stalled"
        elif r.get("pid") and r.get("state"):
            state_ = "running"
        else:
            state_ = "stopped"
        total_b = (size or 0) + prev_b
        runs.append(r | {"size": size, "pos_bytes": done_b, "prev_bytes": prev_b, "total_bytes": total_b or None,
                         "pct": 100.0 if state_ == "finished" else (min(100.0, (prev_b + done_b) / total_b * 100) if total_b else None),
                         "status": state_, "log_age": log_age, "pos_at": p.get("at")})
    shards = [r for r in runs if r["name"].startswith("carve-v2-s")]
    v2_total = V2_FREE_TOTAL
    v2_left = sum(0 if r["status"] == "finished" else max(0, (r["size"] or 0) - r["pos_bytes"]) for r in shards)
    return {"ts": c.get("ts"), "runs": runs, "devs": {k: v for k, v in devs.items() if v.get("type") in ("disk", "part")},
            "v2_total": v2_total, "v2_left": v2_left if shards else None, "b_free": b_free, "c_free": free["/c"], "error": c.get("error")}


CARVE_SQL = ("create table if not exists carve_progress(ts datetime not null primary key, v2_done bigint, v2_left bigint, "
             "files bigint, running int, stalled int)")


def carve_record_loop():
    while True:
        t0 = time.time()
        try:
            with lock:
                c = carve_view()
            if c.get("ts") and t0 - c["ts"] < 300 and c.get("v2_left") is not None:
                runs = c.get("runs") or []
                db = dbconn(30)
                try:
                    cur = db.cursor()
                    cur.execute(CARVE_SQL)
                    cur.execute("insert ignore into carve_progress values(from_unixtime(%s), %s, %s, %s, %s, %s)",
                                (int(t0 // 60 * 60), int(c["v2_total"] - c["v2_left"]), int(c["v2_left"]),
                                 sum(r.get("files_carved") or 0 for r in runs),
                                 sum(1 for r in runs if r["status"] == "running"), sum(1 for r in runs if r["status"] == "stalled")))
                finally:
                    db.close()
        except Exception as e:
            print("carve record:", e, flush=True)
        time.sleep(max(5, 60 - (time.time() - t0)))


def carve_series(c, range_s, vb):
    try:
        c.execute("select floor(unix_timestamp(ts) / %s) * %s t, max(v2_done), min(v2_left), max(files), min(running), max(stalled) "
                  "from carve_progress where ts > now() - interval %s second group by 1 order by 1", (vb, vb, range_s))
        return {"bucket_s": vb, "points": [{"t": int(r[0]), "done": float(r[1] or 0), "left": float(r[2] or 0), "files": float(r[3] or 0),
                                            "running": int(r[4] or 0), "stalled": int(r[5] or 0)} for r in c.fetchall()]}
    except pymysql.MySQLError:
        return {"bucket_s": vb, "points": []}


COPILOT = {"at": 0, "data": None, "total": None, "total_at": 0}
COPILOT_SQL = ("SELECT r.id, r.model, FLOOR(UNIX_TIMESTAMP(k.created_at)/600)*600 AS b, COUNT(*), "
               "COUNT(DISTINCT CASE WHEN k.error IS NULL THEN p.message_id END), AVG(k.wall_ms)/1000, "
               "SUM(k.output_tokens)/NULLIF(SUM(k.output_ms)/1000, 0), SUM(k.prompt_tokens)/NULLIF(SUM(k.prompt_ms)/1000, 0), "
               "SUM(k.error IS NOT NULL), SUM(JSON_CONTAINS(k.flags, '\"invalid_json\"')) "
               "FROM copilot_history.calls k JOIN copilot_history.prompt_instances p ON p.id = k.prompt_instance_id "
               "JOIN copilot_history.runs r ON r.id = k.run_id WHERE r.id IN ({}) GROUP BY r.id, r.model, b ORDER BY r.id, b")


def copilot_runs():
    now = time.time()
    if COPILOT["data"] is not None and now - COPILOT["at"] < 60:
        return COPILOT["data"]
    db = dbconn(60)
    try:
        c = db.cursor()
        if COPILOT["total"] is None or now - COPILOT["total_at"] > 3600:
            c.execute("SELECT COUNT(*) FROM copilot_history.messages")
            COPILOT["total"], COPILOT["total_at"] = int(c.fetchone()[0]), now
        c.execute("SELECT DISTINCT run_id FROM copilot_history.calls WHERE created_at > NOW() - INTERVAL 8 DAY")
        ids = sorted(int(r[0]) for r in c.fetchall())[-4:]
        runs = {}
        if ids:
            c.execute(COPILOT_SQL.format(",".join(str(i) for i in ids)))
            for rid, model, b, calls, done, wall, otps, ptps, err, inv in c.fetchall():
                r = runs.setdefault(int(rid), {"run_id": int(rid), "model": model, "points": [], "done": 0})
                r["done"] += int(done or 0)
                r["points"].append({"t": int(b), "calls": int(calls), "done": r["done"], "wall_s": float(wall or 0), "out_tps": float(otps or 0),
                                    "prompt_tps": float(ptps or 0), "errors": int(err or 0), "invalid_json": int(inv or 0)})
            c.execute("SELECT id, started_at, ended_at, status FROM copilot_history.runs WHERE id IN ({})".format(",".join(str(i) for i in ids)))
            for rid, st, fin, status in c.fetchall():
                if int(rid) in runs:
                    runs[int(rid)].update(started=str(st) if st else None, finished=str(fin) if fin else None, status=status)
    except pymysql.MySQLError as e:
        COPILOT.update(at=now, data={"error": str(e)[:200], "runs": [], "total": COPILOT["total"]})
        return COPILOT["data"]
    finally:
        db.close()
    total = COPILOT["total"] or 0
    out = []
    for r in sorted(runs.values(), key=lambda x: x["run_id"]):
        pts = r["points"]
        for p in pts:
            p["pct"] = p["done"] / total * 100 if total else None
        recent = [p for p in pts if p["t"] >= now - 3600 - 600]
        rate = (recent[-1]["done"] - recent[0]["done"]) if len(recent) > 1 else None
        span = (recent[-1]["t"] - recent[0]["t"]) if len(recent) > 1 else None
        rate_h = rate / span * 3600 if rate is not None and span else None
        last = pts[-1] if pts else {}
        out.append({"run_id": r["run_id"], "model": r["model"], "started": r.get("started"), "finished": r.get("finished"), "status": r.get("status"),
                    "done": r["done"], "pct": r["done"] / total * 100 if total else None, "rate_h": rate_h,
                    "eta_s": (total - r["done"]) / rate_h * 3600 if rate_h and total > r["done"] and not r.get("finished") else None,
                    "last_t": last.get("t"), "out_tps": last.get("out_tps"), "wall_s": last.get("wall_s"),
                    "errors": sum(p["errors"] for p in pts), "invalid_json": sum(p["invalid_json"] for p in pts), "points": pts})
    COPILOT.update(at=now, data={"total": total, "runs": out})
    return COPILOT["data"]


SEL_RE = re.compile(r"memory|ecc|power supply|voltage|thermal|temperature|intrusion|fan|critical|redundan", re.I)


def sel_loop():
    while True:
        t0 = time.time()
        try:
            out = subprocess.run(["sudo", "-n", "ipmitool", "sel", "elist"], capture_output=True, text=True, timeout=60).stdout
            info = subprocess.run(["sudo", "-n", "ipmitool", "sel", "info"], capture_output=True, text=True, timeout=30).stdout
            pct = next((int(m.group(1)) for m in [re.search(r"Percent Used\s*:\s*(\d+)", info)] if m), None)
            ev = []
            for line in out.splitlines():
                f = [x.strip() for x in line.split("|")]
                if len(f) < 5:
                    continue
                try:
                    ts = time.mktime(time.strptime(f[1] + " " + f[2].rsplit(" ", 1)[0], "%m/%d/%Y %I:%M:%S %p"))
                except ValueError:
                    continue
                text = " | ".join(f[3:])
                if t0 - ts < 7 * 86400 and SEL_RE.search(text):
                    ev.append({"id": f[0], "ts": ts, "sensor": f[3], "text": " | ".join(f[4:]), "ecc_uncorr": "uncorr" in text.lower() and "ecc" in text.lower(),
                               "dimm": (re.search(r"DIMM\s*([A-Z]\d+)", text) or [None, None])[1]})
            state["sel"] = {"at": t0, "percent_used": pct, "events": ev[-60:]}
        except Exception as e:
            state["sel"] = {"at": t0, "error": str(e)[:200]}
        time.sleep(300)


def rp_restore_loop():
    while True:
        try:
            if rp_file() is None:
                want = ((rp_desired().get("hosts") or {}).get(MAIN) or {})
                if want.get("profile"):
                    body = json.dumps({"profile": want["profile"], "dashboard_at": want.get("at") or time.time()})
                    r = subprocess.run(["sudo", "-n", "tee", RP_FILE], input=body, capture_output=True, text=True, timeout=10)
                    print(f"run profile restored after missing {RP_FILE}: {want['profile']} (rc {r.returncode})", flush=True)
        except Exception as e:
            print("rp restore:", e, flush=True)
        time.sleep(60)


def offsite_scan():
    import tempfile, shutil
    left = []
    for sh in sorted(glob.glob(os.path.join(OFFSITE_DIR, "push-*.sh"))):
        if os.path.basename(sh) in ("push-ctl.sh", "push-queue.sh"):
            continue
        tmp = tempfile.mkdtemp(prefix="offsite-dry-")
        try:
            r = subprocess.run(["bash", sh, "--dry-run"], capture_output=True, text=True, timeout=300,
                               env=dict(os.environ, TMPDIR=tmp), cwd=OFFSITE_DIR)
        except subprocess.TimeoutExpired:
            continue
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        m = re.search(r"batch (\S+): (\d+) hashes, ([\d.]+) GB to push", r.stdout)
        if m:
            left.append({"batch": m.group(1), "left_hashes": int(m.group(2)), "left_bytes": float(m.group(3)) * 1e9, "script": os.path.basename(sh)})
        else:
            lines = [l.strip() for l in (r.stdout + r.stderr).splitlines() if l.strip() and not l.startswith("rclone ")]
            OFFSITE.setdefault("notes", {})[os.path.basename(sh)] = lines[-1][:240] if lines else f"exit {r.returncode}, no output"
            continue
        OFFSITE.setdefault("notes", {}).pop(os.path.basename(sh), None)
    return left


def offsite_about():
    try:
        r = subprocess.run(["rclone", "about", "gdrive-offsite:", "--json"], capture_output=True, text=True, timeout=60)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except (subprocess.TimeoutExpired, ValueError, OSError):
        return None


def offsite_loop():
    last_about, about = 0, None
    while True:
        t0 = time.time()
        try:
            left = offsite_scan()
            if t0 - last_about > 1800:
                about, last_about = offsite_about() or about, t0
            db = dbconn(60)
            try:
                c = db.cursor()
                c.execute(OFFSITE_SQL)
                if left:
                    c.executemany("insert ignore into offsite_progress values(from_unixtime(%s), %s, %s, %s)",
                                  [(int(t0), b["batch"], b["left_hashes"], int(b["left_bytes"])) for b in left])
                c.execute("select batch, count(*), sum(size), unix_timestamp(max(verified_at)) from offsite_copy "
                          "where provider = 'gdrive' and placed_by = 'rclone_push' group by batch")
                done = {r[0]: {"done_files": int(r[1]), "done_bytes": float(r[2] or 0), "last": float(r[3] or 0)} for r in c.fetchall()}
                c.execute("select sum(if(verified_at > now() - interval 1 hour, size, 0)), sum(if(verified_at > now() - interval 1 day, size, 0)) "
                          "from offsite_copy where provider = 'gdrive' and placed_by = 'rclone_push' and verified_at > now() - interval 1 day")
                h1, d1 = c.fetchone()
            finally:
                db.close()
            names = [b["batch"] for b in left] + [n for n in done if n not in {b["batch"] for b in left}]
            byb = {b["batch"]: b for b in left}
            batches = [{"batch": n, **byb.get(n, {"left_hashes": None, "left_bytes": None}), **done.get(n, {"done_files": 0, "done_bytes": 0.0, "last": 0})} for n in names]
            if not left:
                db = dbconn(60)
                try:
                    c = db.cursor()
                    c.execute("select unix_timestamp(ts), batch, hashes, bytes from offsite_progress where ts = (select max(ts) from offsite_progress)")
                    last = c.fetchall()
                finally:
                    db.close()
                if last:
                    left_at = float(last[0][0])
                    left = [{"batch": b, "left_hashes": int(h), "left_bytes": float(v), "stale": True} for _, b, h, v in last]
                    byb = {b["batch"]: b for b in left}
                    names = [b["batch"] for b in left] + [n for n in done if n not in byb]
                    batches = [{"batch": n, **byb.get(n, {"left_hashes": None, "left_bytes": None}), **done.get(n, {"done_files": 0, "done_bytes": 0.0, "last": 0})} for n in names]
                    OFFSITE["left_at"] = left_at
            else:
                OFFSITE["left_at"] = t0
            OFFSITE["now"] = {"at": t0, "batches": batches, "notes": dict(OFFSITE.get("notes") or {}), "left_at": OFFSITE.get("left_at"), "rate_1h": float(h1 or 0) / 3600, "done_24h": float(d1 or 0),
                              "left_bytes": sum(b["left_bytes"] or 0 for b in left), "left_hashes": sum(b["left_hashes"] or 0 for b in left),
                              "about": about}
        except Exception as e:
            print("offsite:", e, flush=True)
        time.sleep(max(60, 600 - (time.time() - t0)))


def offsite_series(c, range_s, vb):
    try:
        c.execute("select coalesce(sum(size), 0) from offsite_copy where provider = 'gdrive' and placed_by = 'rclone_push' "
                  "and verified_at <= now() - interval %s second", (range_s,))
        base = float(c.fetchone()[0] or 0)
        c.execute("select floor(unix_timestamp(verified_at) / %s) * %s t, sum(size) from offsite_copy where provider = 'gdrive' "
                  "and placed_by = 'rclone_push' and verified_at > now() - interval %s second group by 1 order by 1", (vb, vb, range_s))
        up = [(int(t), float(v or 0)) for t, v in c.fetchall()]
        c.execute("select unix_timestamp(ts), sum(bytes) from offsite_progress where ts > now() - interval %s second group by ts order by ts", (range_s,))
        left = [(int(t), float(v or 0)) for t, v in c.fetchall()]
    except pymysql.MySQLError:
        return {"points": [], "bucket_s": vb}
    pts = {}
    cum = base
    for t, v in up:
        cum += v
        pts.setdefault(t, {"t": t})["uploaded"] = cum
    for t, v in left:
        pts.setdefault(int(t // vb) * vb, {"t": int(t // vb) * vb})["left"] = v
    out, last_up = [], base
    for t in sorted(pts):
        p = pts[t]
        last_up = p.get("uploaded", last_up)
        out.append({"t": t, "uploaded": last_up, "left": p.get("left")})
    now = int(time.time() // vb) * vb
    if OFFSITE["now"]:
        out.append({"t": now, "uploaded": cum, "left": OFFSITE["now"]["left_bytes"]})
    return {"points": out, "bucket_s": vb}


def tasks_setup(c):
    for t in TASK_TABLES:
        c.execute(t)
    c.execute("select data from tasks where updated_at > now() - interval 30 day")
    for (d,) in c.fetchall():
        try:
            t = json.loads(d)
            tasks["items"][t["id"]] = t
        except (ValueError, KeyError):
            pass
    c.execute("select id, unix_timestamp(ts), done from task_samples where ts > now() - interval 2 hour order by ts")
    for tid, t, d in c.fetchall():
        tasks["samples"].setdefault(tid, deque(maxlen=400)).append((float(t), d))


def hub_setup():
    db = pymysql.connect(read_default_file=CNF, charset="utf8mb4", connect_timeout=5, read_timeout=60, autocommit=True)
    try:
        c = db.cursor()
        for t in HUB_TABLES:
            c.execute(t)
        stats_backfill(c)
        health_setup(c)
        tasks_setup(c)
        c.execute("select report from host_reports where host = %s", (HOST,))
        row = c.fetchone()
        if row:
            state["history"].extend(json.loads(row[0] or "{}").get("recent") or [])
    finally:
        db.close()


def hub_loop():
    db = None
    while True:
        t0 = time.time()
        try:
            if db is None:
                db = pymysql.connect(read_default_file=CNF, charset="utf8mb4", connect_timeout=5, read_timeout=20, autocommit=True)
            c = db.cursor()
            c.execute("select host, unix_timestamp(ts), report from host_reports where host <> %s", (HOST,))
            hub = {}
            for h, t, r in c.fetchall():
                f = json.loads(r or "{}")
                hub[h] = {"at": float(t), "history": f.pop("recent", None) or [], "fast": f}
            c.execute("select session, unix_timestamp(ts), status, tasks from claude_status")
            cl = [{"session": se, "updated": float(t), "status": st, "tasks": json.loads(tk or "[]"), "via": "db"} for se, t, st, tk in c.fetchall()]
            with lock:
                state["hub"] = hub
                state["hub_claude"] = cl
        except Exception as e:
            print("hub:", e, flush=True)
            db = None
        time.sleep(max(1, 5 - (time.time() - t0)))


def hub_fresh(host):
    h = state["hub"].get(host)
    return h if h and time.time() - h["at"] <= HUB_FRESH else None


def remote_view():
    h = hub_fresh(NODE)
    if h:
        prog = parse_rsync((h["fast"].get("logs") or {}).get("/dev/shm/copy-prior.log"))
        return {"ok": True, "at": h["at"], "fast": h["fast"], "history": h["history"], "via": "db",
                "rsync": prog or state.get("remote", {}).get("rsync")}
    return dict(state.get("remote", {}), via="http")


def laptop_view():
    h = hub_fresh("laptop")
    if h:
        return {"at": h["at"], "fast": h["fast"], "history": h["history"], "via": "db"}
    return {"at": state["laptop"]["at"], "fast": state["laptop"]["fast"], "history": list(state["laptop"]["history"]), "via": "http"}


def fast_loop():
    prev_cpu, prev_disk, prev_net, prev_t = cpu_times(), diskstats(), netbytes(), time.time()
    while True:
        time.sleep(5)
        try:
            cpu, dk, net, t = cpu_times(), diskstats(), netbytes(), time.time()
            dt = t - prev_t
            busy = 1 - (cpu[1] - prev_cpu[1]) / max(1, cpu[0] - prev_cpu[0])
            disks = {d: {"read": (dk[d][0] - prev_disk.get(d, dk[d])[0]) / dt, "write": (dk[d][1] - prev_disk.get(d, dk[d])[1]) / dt}
                     for d in dk}
            rx, tx = (net[0] - prev_net[0]) / dt, (net[1] - prev_net[1]) / dt
            mem = {l.split(":")[0]: int(l.split()[1]) * 1024 for l in read("/proc/meminfo").splitlines()}
            procs, dcount = processes()
            copy_rates = sample_speed(dt)
            fast = {
                "copy_rates": copy_rates,
                "load": [float(x) for x in read("/proc/loadavg").split()[:3]], "cpu": busy, "ncpu": os.cpu_count(),
                "mem": {"total": mem["MemTotal"], "avail": mem["MemAvailable"]},
                "ram_bw": (lambda t: json.loads(t) if t else None)(read("/dev/shm/imc-bw.json")),
                "peak_power": (lambda t: json.loads(t) if t else None)(read("/dev/shm/peak-power.json")),   # iDRAC true 30-s peak (peak-power.service)
                "net": {"rx": rx, "tx": tx, "speed_mbit": int(read(f"/sys/class/net/{NIC}/speed", "0") or 0)},
                "disks": disks, "mounts": [mount_usage(m) for m in MOUNTS], "temps": (lambda fm: fm["temps"] if fm.get("temps") and time.time() - fm["at"] < 15 else temps())(state.get("fanlatest") or {}), "edac": edac(),
                "nvme": nvme_states(), "procs": procs, "dstate": dcount, "stuck": state.get("stuck", []), "peers": peers(), "ipmi": state.get("ipmi"),
                "power": dcmi_power(["sudo", "-n", "ipmitool"]),
                "fan_control": (lambda t: json.loads(t) if t else None)(read("/run/fan-control.json")),
                "uptime_s": float(read("/proc/uptime", "0 0").split()[0]),
            }
            sample = {"t": t, "rx": rx, "tx": tx, "cpu": busy,
                      "w": sum(v["write"] for v in disks.values()), "r": sum(v["read"] for v in disks.values())}
            with lock:
                state["fast"] = fast; state["updated"] = t
                state["history"].append(sample)
            pool.submit(hub_write, HOST, fast | {"recent": list(state["history"])[-120:]})
            sample_env(t, fast)
            prev_cpu, prev_disk, prev_net, prev_t = cpu, dk, net, t
        except Exception as e:
            with lock:
                state["fast"]["error"] = str(e)


def du(path, limit=300):
    r = subprocess.run(["timeout", str(limit), "ionice", "-c3", "du", "-sb", path], capture_output=True, text=True)
    try:
        return int(r.stdout.split()[0])
    except (IndexError, ValueError):
        return None


def dest_sizes(roots):
    out = {}
    for root in roots:
        out[root] = du(root) if os.path.isdir(root) else 0
    return out


def db_query():
    db = pymysql.connect(read_default_file=CNF, charset="utf8mb4", connect_timeout=5, read_timeout=20)
    try:
        c = db.cursor(pymysql.cursors.DictCursor)
        c.execute("select id, src_root, dest_root, status, files, bytes, hashed, started_at, finished_at, note "
                  f"from {CFG['laptop_inventory_table']} order by id")
        queue = c.fetchall()
        c.execute("select table_name, table_rows, data_length + index_length as bytes from information_schema.tables "
                  "where table_schema = database()")
        tables = c.fetchall()
        c.execute("select d.serial, d.model, d.size_bytes, d.interface, d.status, d.recovery_needed, d.role, d.last_host, "
                  "d.last_slot, d.last_dev, d.last_seen, d.first_seen, d.notes, d.power_on_hours, d.manufacture_date, d.reallocated, d.pending, d.uncorrectable, "
                  "d.crc_errors, d.other_error_count, d.media_errors, d.percentage_used, d.temp_c, d.health_level, d.health_checked_at, d.location, "
                  "(select concat(k.check_type, ': ', k.result, ' (', date_format(k.checked_at, '%Y-%m-%d %H:%i'), ')') "
                  " from drive_checks k where k.serial = d.serial order by k.checked_at desc, k.id desc limit 1) as last_check, "
                  "(select count(*) from drive_checks k where k.serial = d.serial) as checks "
                  "from drives d order by field(d.status,'spare','checked_clean','new','in_use','evidence','under_recovery','recovered','wiped','failed','retired'), "
                  "coalesce(d.reallocated,0)+coalesce(d.pending,0)+coalesce(d.uncorrectable,0), coalesce(d.power_on_hours, 999999)")   # offsite suitability first (2026-09-29)
        drives = c.fetchall()
        archives = None
        try:
            c.execute("select source_root, max(part) part, max(path) path, status, count(*) n, sum(files) files, sum(bytes_raw) raw, "
                      "sum(bytes_zst) zst, sum(errors) errors from archives where name not like 'test-%' group by source_root, status")
            groups = c.fetchall()
            c.execute("select name, source_root, part, files, bytes_raw, started_at from archives where status = 'sending' order by id")
            archives = {"groups": groups, "sending": c.fetchall()}
        except pymysql.MySQLError:
            pass
        return {"queue": queue, "tables": tables, "drives": drives, "archives": archives}
    finally:
        db.close()


def register_drives_and_stats():
    r = subprocess.run(["lsblk", "-J", "-d", "-b", "-o", "NAME,SERIAL,MODEL,SIZE,TRAN,TYPE"], capture_output=True, text=True)
    seen = [d for d in json.loads(r.stdout or '{"blockdevices":[]}')["blockdevices"] if d.get("type") == "disk" and d.get("serial")]
    now = time.time()
    with lock:
        f = dict(state["fast"])
        rv, lv = remote_view(), laptop_view()
        hosts = [(HOST, f, list(state["history"]), now - state["updated"] <= 30),
                 (NODE, dict(rv.get("fast") or {}), list(rv.get("history") or []), bool(rv.get("ok"))),
                 ("laptop", dict(lv["fast"]), list(lv["history"]), now - lv["at"] <= 20)]
    db = pymysql.connect(read_default_file=CNF, charset="utf8mb4", connect_timeout=5, read_timeout=20)
    try:
        c = db.cursor()
        for d in seen:
            iface = {"nvme": "NVMe", "sata": "SATA", "sas": "SAS", "usb": "USB"}.get((d.get("tran") or "").lower(), d.get("tran"))
            c.execute("insert into drives(serial, model, size_bytes, interface, status, last_seen, last_host, last_dev, notes) "
                      f"values(%s,%s,%s,%s,'evidence',now(),%s,%s,'auto-registered: assumed a recovery drive until fully scanned ({CFG['owner']} rule)') "
                      "on duplicate key update last_seen=now(), last_host=values(last_host), last_dev=values(last_dev)",
                      (d["serial"].strip(), (d.get("model") or "").strip(), d.get("size"), iface, HOST, d["name"]))
        if now - lv["at"] <= 120:   # laptop disks too (2026-09-29): internal = in use; USB/other = new until someone checks it
            for d in (lv["fast"].get("phys_disks") or []):
                if not d.get("serial"):
                    continue
                usb = d.get("bus", "").upper() == "USB"
                c.execute("insert into drives(serial, model, size_bytes, interface, status, last_seen, last_host, last_dev, notes) "
                          "values(%s,%s,%s,%s,%s,now(),'laptop',%s,%s) "
                          "on duplicate key update last_seen=now(), last_host='laptop', last_dev=values(last_dev)",
                          (d["serial"], d.get("model"), d.get("size"), d.get("bus"), "evidence" if usb else "in_use", d.get("media") or d.get("bus"),
                           f"auto-registered from the laptop: assumed a recovery drive until fully scanned ({CFG['owner']} rule)" if usb else "laptop internal drive (auto-registered)"))
        rows, minute = [], int(now // 60) * 60
        for host, F, hist, fresh in hosts:
            pts = hist[-12:]
            if not (fresh and F and pts):
                continue
            for m, k in SERVER_METRICS.items():
                rows.append((minute, host, m, sum(p.get(k) or 0 for p in pts) / len(pts)))
        db.commit()
    finally:
        db.close()
    stats_put(rows)


def scan_log():
    lines = read("/opt/recovery/catalog/scan.log").splitlines()
    return lines[-3:] if lines else []


ROOTS_BUSY = {"on": False}
LAPCHECK = {"at": 0, "rows": None, "busy": False}   # laptop copy verified by hash (laptop_copy_check view, ~20 s), every 30 min


def lapcheck_loop():
    while True:
        try:
            db = pymysql.connect(read_default_file=CNF, charset="utf8mb4", connect_timeout=5, read_timeout=300)
            try:
                c = db.cursor(pymysql.cursors.DictCursor)
                c.execute("select /*+ MAX_EXECUTION_TIME(240000) */ src_root, files, verified, missing, mismatched, not_hashed_yet from laptop_copy_check")
                rows = [{k: (int(v) if isinstance(v, (int, float)) or (v is not None and k != "src_root") else v) for k, v in r.items()} for r in c.fetchall()]
            finally:
                db.close()
            LAPCHECK.update(at=time.time(), rows=rows)
        except Exception as e:
            print("lapcheck:", e, flush=True)
        time.sleep(1800)
PEAKS = deque(maxlen=120)   # (t, combined 5-s peak, the GPU node 5-s peak, combined iDRAC 30-s peak, the GPU node iDRAC peak), every ~5 s


def catalog_roots():
    db = pymysql.connect(read_default_file=CNF, charset="utf8mb4", connect_timeout=5, read_timeout=960)
    try:
        c = db.cursor(pymysql.cursors.DictCursor)   # MySQL itself stops the scan at 15 min, so a given-up client never leaves it running
        c.execute("select /*+ MAX_EXECUTION_TIME(900000) */ root, count(*) files, sum(hash is not null) hashed, sum(err is not null) errors, sum(size) bytes, "
                  "sum(case when hash is null and err is null then size else 0 end) unhashed_bytes from files group by root")
        return c.fetchall()
    finally:
        db.close()


def node_loop():
    last_roots = 0
    while True:
        t0 = time.time()
        if t0 - last_roots >= CATALOG_ROOTS_EVERY and not ROOTS_BUSY["on"]:   # never overlap: skip while the last scan still runs
            def _roots():
                ROOTS_BUSY["on"] = True
                try:
                    roots = catalog_roots()
                    with lock:
                        state[NODE]["catalog_roots"] = roots
                except Exception as e:
                    print("catalog_roots:", e, flush=True)
                finally:
                    ROOTS_BUSY["on"] = False
            threading.Thread(target=_roots, daemon=True).start()
            last_roots = t0
        sizes = {f["dest"]: (du(f["dest"], 1800) if os.path.isdir(f["dest"]) else 0) for f in NODE_FOLDERS}
        with lock:
            prev = state[NODE].get("dest_bytes", {})
            prev_at = state[NODE].get("at")
            state[NODE]["rate"] = ({k: (sizes[k] - prev.get(k, 0)) / (time.time() - prev_at) for k in sizes
                                      if sizes[k] is not None and prev.get(k) is not None} if prev_at else {})
            state[NODE]["dest_bytes"] = sizes
            state[NODE]["at"] = time.time()
        time.sleep(max(30, NODE_DU_EVERY - (time.time() - t0)))


def parse_rsync(lines):
    for line in reversed(lines or []):
        m = RSYNC_RE.match(line)
        if m and m.group(5):
            done_b, pct, rate, _, xfr, left, total = m.groups()
            return {"bytes": int(done_b.replace(",", "")), "pct": int(pct), "rate": rate, "files_done": int(total) - int(left),
                    "files_total": int(total), "xfr": int(xfr), "line": line.strip()}
    return None


def remote_loop():
    import urllib.request
    while True:
        t = time.time()
        with lock:
            skip = hub_fresh(NODE) is not None
        if skip:
            time.sleep(5)
            continue
        try:
            with urllib.request.urlopen(NODE_AGENT, timeout=4) as r:
                data = json.loads(r.read())
            prog = parse_rsync((data.get("fast", {}).get("logs") or {}).get("/dev/shm/copy-prior.log"))
            with lock:
                state["remote"] = {"ok": True, "at": t, "fast": data.get("fast", {}), "history": data.get("history", []),
                                   "rsync": prog or state.get("remote", {}).get("rsync")}
        except Exception as e:
            with lock:
                prev = state.get("remote", {})
                state["remote"] = dict(prev, ok=False, error=str(e)[:200])
        time.sleep(max(1, 5 - (time.time() - t)))


def box_loop():   # the intake box server card (2026-10-03): same agent as the the GPU node, polled every 5 s
    import urllib.request
    while True:
        t = time.time()
        try:
            with urllib.request.urlopen(BOX_AGENT, timeout=4) as r:
                data = json.loads(r.read())
            with lock:
                state[BOX] = {"ok": True, "at": t, "fast": data.get("fast", {}), "history": data.get("history", [])}
        except Exception as e:
            with lock:
                state[BOX] = dict(state.get(BOX, {}), ok=False, error=str(e)[:200])
        time.sleep(max(1, 5 - (time.time() - t)))


def box_view():
    v = dict(state.get(BOX) or {})
    if v.get("at") and time.time() - v["at"] > 30:
        v["ok"] = False
    return v


def unc_to_local(dest):
    m = re.match(r"\\\\10\.0\.1\.73\\([ed])-intake\\(.+?)\\?$", dest or "", re.I)
    return f"/{m.group(1).lower()}/intake/" + m.group(2).replace("\\", "/") if m else None


def lapjob_loop():
    while True:
        t0 = time.time()
        with lock:
            jobs = list((laptop_view().get("fast") or {}).get("copy_jobs") or [])
        sizes = dict((state.get("lapjobs") or {}).get("du") or {})
        for j in jobs:
            if j.get("finished"):
                b = j.get("bytes") or []
                sizes[j.get("dest")] = (b[1] + b[2]) if len(b) > 2 else None
                continue
            local = unc_to_local(j.get("dest"))
            if local and os.path.isdir(local):
                sizes[j.get("dest")] = du(local, 600)
                with lock:
                    state["lapjobs"] = {"at": time.time(), "du": dict(sizes)}
        with lock:
            state["lapjobs"] = {"at": time.time(), "du": sizes}
        time.sleep(max(60, 300 - (time.time() - t0)) if jobs else 30)


def slow_loop():
    while True:
        try:
            with_timeout(register_drives_and_stats, 30)
        except Exception as e:
            print("register/stats:", e, flush=True)
        try:
            dbs = with_timeout(db_query, 30, {"error": "mysql timeout"})
            roots = [q["dest_root"] for q in dbs.get("queue", []) if q.get("dest_root")]
            sizes = dest_sizes(roots)
            with lock:
                state["db"] = dbs
                state["slow"] = {"dest_bytes": sizes, "scan_log": scan_log(), "at": time.time(),
                                 "intake": {k: du(v) for k, v in DU_TARGETS.items()}}
            rem = compute_remaining()
            if rem:
                t = int(time.time() // 60) * 60
                with lock:
                    remain["now"] = {"t": t} | rem
                pool.submit(stats_put, [(t, "remaining", k, v) for k, v in rem.items()])
        except Exception as e:
            with lock:
                state["slow"]["error"] = str(e)
        time.sleep(60)


def claude_status():
    with lock:
        out = list(state["hub_claude"])
    seen = {c["session"]: c for c in out}
    for p in sorted(glob.glob(os.path.join(HERE, "claude", "*.json"))):
        try:
            with open(p) as f:
                d = json.load(f)
            d = d | {"file_mtime": os.path.getmtime(p), "via": "file"}
            prev = seen.get(d.get("session"))
            if prev is None:
                out.append(d)
            elif (d.get("updated") or 0) > (prev.get("updated") or 0):
                out[out.index(prev)] = d
        except (OSError, ValueError) as e:
            out.append({"session": os.path.basename(p)[:-5], "error": str(e)})
    return sorted(out, key=lambda c: c.get("session") or "")


def roadmap():
    try:
        with open(os.path.join(HERE, "roadmap.json")) as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        return {"error": str(e)}


# 2026-10-28 the owner: take the old dashboard off-line to the internet - the the main server's IP is reachable from outside and :8090 answered
# there. Then (same evening): "we want to allow the 10 network for control and viewing of server settings and dashboard until we
# get the replacement live ... we don't want to lose access because of it" + "home network, minus router". So: any 10.x source
# (laptop, the GPU node on both ports, the intake box via its router <addr>) and localhost get the full dashboard, API and controls; the main
# router <addr> is excluded (it could forward internet traffic under its own address); everything else gets a blank page.
import ipaddress
HOME_NET, HOME_EXCLUDE = ipaddress.ip_network(CFG['home_net']), {CFG['router_ip']}
COMING_SOON = b"<!doctype html><html><head><meta charset=utf-8><title>Coming soon</title></head><body><p>Coming soon</p></body></html>"


def home_client(ip):
    ip = ip.removeprefix("::ffff:")
    if ip in ("127.0.0.1", "::1"):
        return True
    try:
        return ipaddress.ip_address(ip) in HOME_NET and ip not in HOME_EXCLUDE
    except ValueError:
        return False


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def gated(self):
        """True when this request gets the coming-soon page instead of the real dashboard or API."""
        if home_client(self.client_address[0]):
            return False
        self.send(200, COMING_SOON, "text/html; charset=utf-8")
        return True

    def send(self, code, body, ctype):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.gated():
            return
        if self.path.startswith("/api/state"):
            with lock:
                s = {"fast": state["fast"], "slow": state["slow"], "db": state["db"], "updated": state["updated"],
                     NODE: dict(state[NODE], folders=NODE_FOLDERS), "remote": remote_view(), BOX: box_view(),
                     "history": list(state["history"]), "roadmap": roadmap(), "now": time.time(), "remaining": remaining_state(),
                     "laptop": laptop_view(), "health": state.get("health", {}), "lapjobs": state.get("lapjobs", {}), "env_live": list(env["live"]), "gpu_live": list(gpu_live["pts"]), f"{BOX}_gpu_live": list(box_gpu_live["pts"]), "laptop_gpu_live": list(laptop_gpu_live["pts"]), "tasks": tasks_list(time.time()), "offsite": OFFSITE["now"], "job_locks": job_status(job_locks(), tasks_list(time.time()), None, carve_progress()), "carve_progress": carve_progress(), "lapcheck": {"at": LAPCHECK["at"], "rows": LAPCHECK["rows"]}, "sel": state.get("sel"), "carve": carve_view(), "meeting": meeting_desired(), "gpu_switch": gpu_desired(), "dismissed": dismissed(), "quickcool": qc_desired(), "runprofile": {"desired": rp_desired(), MAIN: rp_file(), "hold": profile_hold()}, "limits": limits(), "page_ver": int(os.path.getmtime(os.path.join(HERE, "index.html"))), "emergencies": [e for e in EMERGENCIES if e.get("end") is None or time.time() - e["end"] < 86400]}
            s["claude"] = claude_status()
            self.send(200, json.dumps(s, default=str), "application/json")
        elif self.path.startswith("/api/powertarget"):   # published per-mode power target jobs scale to (2026-09-28)
            md = bool(meeting_desired().get("on")); prof = (rp_desired() or {}).get("profile") or "adaptive"
            low = md or prof in ("normal", "daytime", "lowpower")
            now_ = time.time(); w5 = [x for x in PEAKS if now_ - x[0] <= 300]
            mx = lambda i: max((x[i] for x in w5 if x[i] is not None), default=None)
            peaks = {"combined_peak_5m": mx(1), f"{NODE}_peak_5m": mx(2), "combined_idrac_peak_5m": mx(3), f"{NODE}_idrac_peak_5m": mx(4),
                     "peak_note": "5-min max. *_peak_5m: same-moment sum of each server's 5-s peak of 1-s DCMI readings. *_idrac_peak_5m: sum of each server's iDRAC high-rate 30-s peak (catches sub-second spikes; slightly conservative when summed)."}
            pw = int((rp_desired() or {}).get("power_w") or 1250) if prof == "adaptive" else 1250   # Adaptive 1 kW / 1.25 kW / 1.5 kW (2026-09-30)
            body = {"combined_w": 600 if low else pw, f"{NODE}_w": 1000, "gpu_off": bool(gpu_desired().get("off")), f"{MAIN}_w": 550 if not low else 280, "mode": "meeting" if md else prof, "scale": "down" if low else "up",
                    "rule": f"Low Power/Meeting -> both servers combined ~600 W; Adaptive/Unattended -> combined ~1,250 W ({CFG['owner']} 2026-09-28, was 1,150), {NODE} max 1,000 W (two PSUs; {CFG['owner']} 2026-09-28, was 900, before that 715; 5-min max, wall watts). {CFG['owner']} 2026-09-28",
                    "at": time.time(), **peaks}
            self.send(200, json.dumps(body), "application/json")
        elif self.path.startswith("/api/iohist"):
            body = json.dumps({h: {k: list(v) for k, v in d.items()} for h, d in IO_HIST.items()}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif self.path.startswith("/api/temphist"):
            body = json.dumps({h: list(v) for h, v in TEMP_HIST.items()}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif self.path.startswith("/api/guardhist"):   # the power guard throttle history for the chart under total power (2026-10-01)
            self.send(200, json.dumps(guard_history()), "application/json")
        elif self.path.startswith("/api/throttle"):
            self.send(200, json.dumps(throttle_state()), "application/json")
        elif self.path.startswith("/api/powercaps"):
            try:
                with open(os.path.join(HERE, "power-caps.json")) as f:
                    caps = json.load(f)
                # the owner 2026-09-28: CPU wattage follows the mode. Normal/Daytime/Meeting -> the low cap; Adaptive/Unattended -> normal cap
                low = bool(meeting_desired().get("on")) or ((rp_desired() or {}).get("profile") or "adaptive") in ("normal", "daytime", "lowpower")
                for h, c in caps.items():
                    if isinstance(c, dict) and low and c.get("rapl_package_w_low"):
                        c["rapl_package_w"], c["mode_scaled"] = c["rapl_package_w_low"], "low"
                th = throttle_state().get(NODE)   # power-management throttle: lowers the the GPU node RAPL cap until it expires
                if th and isinstance(caps.get(NODE), dict) and th.get("rapl_package_w"):
                    c = caps[NODE]
                    if th["rapl_package_w"] < (c.get("rapl_package_w") or 1e9):
                        c["rapl_package_w"], c["throttle"] = th["rapl_package_w"], th
                self.send(200, json.dumps(caps), "application/json")
            except OSError:
                self.send(200, "{}", "application/json")
        elif self.path.startswith("/api/emergencies"):
            with lock:
                eps = list(EMERGENCIES)
            self.send(200, json.dumps({"now": time.time(), "episodes": eps}, default=str), "application/json")
        elif self.path.startswith("/api/runprofile"):
            self.send(200, json.dumps(rp_desired()), "application/json")
        elif self.path.startswith("/api/quickcool"):
            self.send(200, json.dumps(dict(qc_desired(), meeting=bool(meeting_desired().get("on")))), "application/json")
        elif self.path.startswith("/api/meeting"):
            low = rp_desired().get("profile") == "lowpower"   # the owner 2026-09-28: Low Power also pauses the laptop's Copilot GPU runs (laptop-agent -> meeting-mode.py)
            d = meeting_desired()
            self.send(200, json.dumps(dict(d, on=bool(d.get("on")) or low, low_power=low)), "application/json")
        elif self.path.startswith("/api/tasks"):
            body = tasks_list(time.time(), active="active=1" in self.path, recent_only=False)
            self.send(200, json.dumps(body, default=str), "application/json")
        elif self.path.startswith("/api/series"):
            m = re.search(r"range=(\d+)", self.path)
            rng = min(7 * 86400, max(600, int(m.group(1)) if m else 3600))
            body = with_timeout(lambda: series(rng), 20, {"error": "mysql timeout"})
            self.send(200, json.dumps(body, default=str), "application/json")
        elif self.path.startswith("/api/speed"):
            m = re.search(r"range=(\d+)", self.path)
            rng = min(7 * 86400, max(600, int(m.group(1)) if m else 3600))
            self.send(200, json.dumps((with_timeout(lambda: series(rng), 20, {}) or {}).get("speed")), "application/json")
        elif self.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                self.send(200, f.read(), "text/html; charset=utf-8")
        else:
            self.send(404, "not found", "text/plain")

    def do_POST(self):
        if self.gated():
            return
        if self.path.split("?")[0] == "/api/tasks":
            return self.post_tasks()
        if self.path.split("?")[0] == "/api/meeting":
            return self.post_meeting()
        if self.path.split("?")[0] == "/api/gpu":
            return self.post_gpu()
        if self.path.split("?")[0] == "/api/dismiss":
            return self.post_dismiss()
        if self.path.split("?")[0] == "/api/quickcool":
            return self.post_quickcool()
        if self.path.split("?")[0] == "/api/throttle":
            return self.post_throttle()
        if self.path.split("?")[0] == "/api/runprofile":
            return self.post_runprofile()
        if self.path != "/api/push/laptop" or self.client_address[0].removeprefix("::ffff:") not in LAPTOP_IPS and not lan_control_ok(self.client_address[0].removeprefix("::ffff:")):
            return self.send(403, "forbidden", "text/plain")
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= 262144:
            return self.send(413, "too large", "text/plain")
        try:
            body = json.loads(self.rfile.read(n))
        except ValueError:
            return self.send(400, "bad json", "text/plain")
        t = time.time()
        with lock:
            state["laptop"]["at"] = t
            state["laptop"]["fast"] = body | {"addr": self.client_address[0]}
            d = (body.get("disks") or {}).get("_Total") or {}
            net = body.get("net") or {}
            state["laptop"]["history"].append({"t": t, "rx": net.get("rx") or 0, "tx": net.get("tx") or 0, "cpu": body.get("cpu") or 0,
                                               "r": d.get("read") or 0, "w": d.get("write") or 0})
        self.send(200, "ok", "text/plain")


MEETING_FILE = os.path.join(HERE, "meeting.json")
QC_DESIRED, QC_HOOK = os.path.join(HERE, "quickcool.json"), "/dev/shm/quick-cool.json"
QC_PCT = 80   # the owner 2026-09-26: Quick Cool at 80% like Emergency, not 100%
RP_DESIRED, RP_FILE = os.path.join(HERE, "runprofile.json"), "/run/run-profile.json"


def rp_file():
    try:
        with open(RP_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def rp_desired():
    try:
        with open(RP_DESIRED) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def profile_hold():
    try:
        with open(os.path.join(HERE, "profile-hold.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def rp_current():
    with lock:
        rv = remote_view()
    rf = (rv.get("fast") or {}) if rv.get("ok") else {}
    node = ((rf.get("fan_control") or {}).get("profile")) or ((rf.get("run_profile") or {}).get("profile")) or "daytime"
    main = ((state.get("fast") or {}).get("fan_control") or {}).get("profile") or ((rp_file() or {}).get("profile")) or "daytime"
    return {MAIN: main, NODE: node}


def rp_apply(profiles, by, power_w=None):
    import urllib.request
    at, res = time.time(), {}
    d = rp_desired()
    d["power_w"] = power_w   # Adaptive power-target variant (1000/1250/1500 W); None for the other profiles
    d.setdefault("hosts", {})
    for h, p in profiles.items():
        d["hosts"][h] = {"profile": p, "at": at, "by": by}
    if len(set(profiles.values())) == 1:
        d.update(profile=next(iter(profiles.values())), at=at, by=by)
    with open(RP_DESIRED + ".tmp", "w") as f:
        json.dump(d, f)
    os.replace(RP_DESIRED + ".tmp", RP_DESIRED)
    if MAIN in profiles:
        cur = rp_file() or {}
        if cur.get("profile") != profiles[MAIN]:
            for k in ("run_rpm", "pl", "card_fan"):
                cur.pop(k, None)
        cur.update(profile=profiles[MAIN], dashboard_at=at)
        r = subprocess.run(["sudo", "-n", "tee", RP_FILE], input=json.dumps(cur), capture_output=True, text=True, timeout=10)
        res[MAIN] = "ok" if r.returncode == 0 else "couldn't write " + RP_FILE + ": " + r.stderr.strip()[:160]
    if NODE in profiles:
        try:
            req = urllib.request.Request(NODE_AGENT.rstrip("/") + "/runprofile", data=json.dumps({"profile": profiles[NODE], "at": at}).encode(),
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=4).read()
            res[NODE] = "ok"
        except Exception as e:
            res[NODE] = "agent push failed (" + str(e)[:80] + "); its 10 s poll will apply it"
    return at, res


def meeting_servers(on, by):
    d = meeting_desired()
    if False:   # the owner 2026-09-28: Meeting Mode is an overlay in fan-control (via the quick-cool file); it never changes run profiles
        pass
    elif not on and d.get("restore"):   # clean up a restore left by the old behaviour
        des = (rp_desired().get("hosts") or {})
        back = {h: p for h, p in d["restore"].items() if (des.get(h) or {}).get("by") == "meeting mode"}
        if back:
            rp_apply(back, "meeting mode (restore)")
        d.pop("restore", None)
        d.pop("restore_at", None)
    return d


THROTTLE = {}   # host -> {"rapl_package_w" | "dcmi_w" | "gpu_w", "until", "by", "reason", "at"}; power-management overrides (2026-09-29; GPU 2026-10-01)
THROTTLE_MAX_S = 900
THROTTLE_FILE_MAIN = "/dev/shm/power-throttle.json"   # read by the main server fan-control every tick


def throttle_state():
    now = time.time()
    return {h: dict(v, left_s=round(v["until"] - now)) for h, v in THROTTLE.items() if v and v["until"] > now}


def _throttle_write_main():
    v = throttle_state().get(MAIN) or {}
    try:
        with open(THROTTLE_FILE_MAIN + ".tmp", "w") as f:
            json.dump(v, f)
        os.replace(THROTTLE_FILE_MAIN + ".tmp", THROTTLE_FILE_MAIN)
    except OSError as e:
        print("throttle file:", e, flush=True)


def post_throttle(self):
    """POST /api/throttle {"host": "the GPU node", "rapl_package_w": 60, "seconds": 120, "by": "...", "reason": "..."}
    or {"host": "the main server", "dcmi_w": 350, ...}, or {"host": ..., "clear": true}. Temporary, lower-only CPU/server caps for the
    power-management thread. They expire by themselves (max 15 min); the mode caps come back automatically."""
    sender = self.client_address[0].removeprefix("::ffff:")
    if sender not in LAPTOP_IPS | {"127.0.0.1", CFG['main_ip'], CFG['node_ip']}:
        return self.send(403, json.dumps({"ok": False, "error": "throttle only from the laptop or the servers"}), "application/json")
    try:
        d = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        host = d.get("host")
        key = {NODE: "rapl_package_w", MAIN: "dcmi_w", f"{NODE}gpu": "gpu_w"}[host]   # the GPU nodegpu: GPU power limit (2026-10-01)
        if d.get("clear"):
            THROTTLE.pop(host, None)
        else:
            w, secs = float(d[key]), min(float(d.get("seconds") or 120), THROTTLE_MAX_S)
            if w <= 0 or secs <= 0:
                raise ValueError("watts and seconds must be positive")
            THROTTLE[host] = {key: w, "until": time.time() + secs, "by": str(d.get("by") or sender)[:60], "reason": str(d.get("reason") or "")[:200], "at": time.time()}
        if host == MAIN:
            _throttle_write_main()
        print(f"throttle {host}: {THROTTLE.get(host) or 'cleared'} from {sender}", flush=True)
        return self.send(200, json.dumps({"ok": True, "throttle": throttle_state()}), "application/json")
    except (KeyError, ValueError, TypeError) as e:
        return self.send(400, json.dumps({"ok": False, "error": f"bad request: {e}"}), "application/json")


def lan_control_ok(ip):   # the owner 2026-09-29: run profile / Quick Cool / Meeting may be changed from any device on the home LAN (10.x)
    return ip == "127.0.0.1" or ip.startswith("10.")


def post_runprofile(self):
    sender = self.client_address[0].removeprefix("::ffff:")
    if not lan_control_ok(sender):
        print(f"refused control request from {sender}: The run profile can only be changed from the home LAN", flush=True)
        return self.send(403, json.dumps({"ok": False, "error": "The run profile can only be changed from the home LAN"}), "application/json")
    n = int(self.headers.get("Content-Length") or 0)
    try:
        body = json.loads(self.rfile.read(n) if 0 < n <= 4096 else b"{}")
    except ValueError:
        return self.send(400, json.dumps({"ok": False, "error": "body is not JSON"}), "application/json")
    pw = body.get("power_w")
    if pw is not None and (body.get("profile") != "adaptive" or pw not in (1000, 1250, 1500)):
        return self.send(400, json.dumps({"ok": False, "error": "power_w must be 1000, 1250 or 1500, with profile adaptive"}), "application/json")
    if body.get("profile") not in ("daytime", "unattended", "normal", "adaptive", "lowpower"):
        return self.send(400, json.dumps({"ok": False, "error": "send {\"profile\": \"normal\"|\"daytime\"|\"adaptive\"|\"unattended\"}"}), "application/json")
    at, res = rp_apply({MAIN: body["profile"], NODE: body["profile"]}, sender, power_w=(pw or 1250) if body["profile"] == "adaptive" else None)
    if res.get(MAIN) != "ok":
        return self.send(500, json.dumps({"ok": False, "error": res.get(MAIN), "hosts": res}), "application/json")
    self.send(200, json.dumps({"ok": True, "profile": body["profile"], "at": at, "by": sender, "hosts": res}), "application/json")


H.post_runprofile = post_runprofile
H.post_throttle = post_throttle


def qc_desired():
    try:
        with open(QC_DESIRED) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"on": False}


def qc_loop():
    while True:
        d = qc_desired()
        try:
            tmp = QC_HOOK + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"on": bool(d.get("on")), "pct": QC_PCT, "since": d.get("at"), "ts": time.time(), "by": "dashboard",
                           "meeting": bool(meeting_desired().get("on"))}, f)
            os.replace(tmp, QC_HOOK)
        except OSError as e:
            print("quick cool hook:", e, flush=True)
        time.sleep(15)


def post_quickcool(self):
    sender = self.client_address[0].removeprefix("::ffff:")
    if not lan_control_ok(sender):
        print(f"refused control request from {sender}: Quick cool can only be changed from the home LAN", flush=True)
        return self.send(403, json.dumps({"ok": False, "error": "Quick cool can only be changed from the home LAN"}), "application/json")
    n = int(self.headers.get("Content-Length") or 0)
    try:
        body = json.loads(self.rfile.read(n) if 0 < n <= 4096 else b"{}")
    except ValueError:
        return self.send(400, json.dumps({"ok": False, "error": "body is not JSON"}), "application/json")
    if not isinstance(body.get("on"), bool):
        return self.send(400, json.dumps({"ok": False, "error": "send {\"on\": true|false}"}), "application/json")
    d = {"on": body["on"], "at": time.time(), "by": sender}
    tmp = QC_DESIRED + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.replace(tmp, QC_DESIRED)
    self.send(200, json.dumps({"ok": True} | d), "application/json")


H.post_quickcool = post_quickcool


def meeting_desired():
    try:
        with open(MEETING_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"on": False}


def post_meeting(self):
    sender = self.client_address[0].removeprefix("::ffff:")
    if not lan_control_ok(sender):
        print(f"refused control request from {sender}: meeting mode can only be changed from the home LAN", flush=True)
        return self.send(403, json.dumps({"ok": False, "error": "meeting mode can only be changed from the home LAN"}), "application/json")
    n = int(self.headers.get("Content-Length") or 0)
    try:
        body = json.loads(self.rfile.read(n) if 0 < n <= 4096 else b"{}")
    except ValueError:
        return self.send(400, json.dumps({"ok": False, "error": "body is not JSON"}), "application/json")
    if not isinstance(body.get("on"), bool):
        return self.send(400, json.dumps({"ok": False, "error": "send {\"on\": true|false}"}), "application/json")
    d = meeting_servers(body["on"], sender) | {"on": body["on"], "at": time.time(), "by": sender}
    tmp = MEETING_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.replace(tmp, MEETING_FILE)
    self.send(200, json.dumps({"ok": True} | d), "application/json")


H.post_meeting = post_meeting

GPU_FILE = os.path.join(HERE, "gpu.json")   # the owner 2026-09-30: manual GPU off switch, independent of the run mode


def gpu_desired():
    try:
        with open(GPU_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"off": False}


def post_gpu(self):
    sender = self.client_address[0].removeprefix("::ffff:")
    if not lan_control_ok(sender):
        return self.send(403, json.dumps({"ok": False, "error": "the GPU switch can only be changed from the home LAN"}), "application/json")
    n = int(self.headers.get("Content-Length") or 0)
    try:
        body = json.loads(self.rfile.read(n) if 0 < n <= 4096 else b"{}")
    except ValueError:
        return self.send(400, json.dumps({"ok": False, "error": "body is not JSON"}), "application/json")
    if not isinstance(body.get("off"), bool):
        return self.send(400, json.dumps({"ok": False, "error": "send {\"off\": true|false}"}), "application/json")
    d = {"off": body["off"], "at": time.time(), "by": sender}
    with open(GPU_FILE + ".tmp", "w") as f:
        json.dump(d, f)
    os.replace(GPU_FILE + ".tmp", GPU_FILE)
    self.send(200, json.dumps({"ok": True} | d), "application/json")


H.post_gpu = post_gpu


def post_tasks(self):
    sender = self.client_address[0].removeprefix("::ffff:")
    if sender not in task_senders():
        return self.send(403, json.dumps({"ok": False, "errors": [f"sender {sender} not allowed"]}), "application/json")
    n = int(self.headers.get("Content-Length") or 0)
    if not 0 < n <= 262144:
        return self.send(413, json.dumps({"ok": False, "errors": ["body missing or over 256 KB"]}), "application/json")
    try:
        body = json.loads(self.rfile.read(n))
    except ValueError:
        return self.send(400, json.dumps({"ok": False, "errors": ["body is not JSON"]}), "application/json")
    items = body if isinstance(body, list) else [body]
    if len(items) > 500:
        return self.send(413, json.dumps({"ok": False, "errors": ["more than 500 tasks"]}), "application/json")
    now, ids, errors = time.time(), [], []
    for o in items:
        tid, err = apply_task(o, sender, now)
        (errors.append(err) if err else ids.append(tid))
        if not err and o.get("state") in ("running", "queued", "paused", "blocked"):
            dismiss_clear("tasks", tid)
    self.send(200 if not errors else 400 if not ids else 207, json.dumps({"ok": not errors, "ids": ids, "errors": errors}), "application/json")


H.post_tasks = post_tasks

GUARD_LOG = f"{CFG['home_dir']}/{CFG['guard_log_rel']}"


def guard_history(days=7):
    """the power guard.py's throttle activity from its log: cap snapshots ("ok" lines) + DOWN / CLEAR / reset events.
    -> {"points": [[t, the main server_server_cap_w, the GPU node_cpu_cap_w_per_pkg, comb_peak, target]], "events": [[t, kind, host, text]]}"""
    import datetime as _dt
    pts, evs, cut = [], [], time.time() - days * 86400
    try:
        lines = open(GUARD_LOG, errors="replace").read().splitlines()[-20000:]
    except OSError:
        return {"points": [], "events": []}
    caps = {MAIN: None, NODE: None, f"{NODE}gpu": None}
    for ln in lines:
        m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)Z (\w+):? ?(.*)", ln)
        if not m:
            continue
        t = _dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=_dt.timezone.utc).timestamp()
        kind, rest = m.group(2), m.group(3)
        if kind == "ok":
            c = re.search(r"caps (\{.*?\})", rest)
            caps = {MAIN: None, NODE: None, f"{NODE}gpu": None}
            if c:
                for h, v in re.findall(r"'(r7[23]0(?:gpu)?)': (\d+)", c.group(1)):
                    caps[h] = int(v)
            pk = re.search(r"comb peak (\d+) avg \d+ / (\d+)", rest)
            if t >= cut:
                pts.append([t, caps[MAIN], caps[NODE], int(pk.group(1)) if pk else None, int(pk.group(2)) if pk else None, caps[f"{NODE}gpu"]])
        elif kind in ("DOWN", "UP", "CLEAR", "reset"):
            for h, v in re.findall(r"(r7[23]0) (?:CPU|server) cap -> (\d+)", rest):
                caps[h] = int(v)
            for v in re.findall(r"GPU cap -> (\d+)", rest):
                caps[f"{NODE}gpu"] = int(v)
            if kind in ("CLEAR", "reset"):
                hm = re.search(r"(r7[23]0(?:gpu)?)", rest)
                if hm:
                    caps[hm.group(1)] = None
            if t >= cut:
                evs.append([t, kind, ",".join(sorted(set(re.findall(r"r7[23]0", rest)))), rest[:200]])
                pts.append([t, caps[MAIN], caps[NODE], None, None, caps[f"{NODE}gpu"]])
    try:   # normal (un-throttled) caps, so the chart can show the effective cap at all times
        pc = json.load(open(os.path.join(HERE, "power-caps.json"))).get(NODE, {})
    except (OSError, ValueError):
        pc = {}
    return {"points": pts, "events": evs[-200:], "normal": {MAIN: 550, f"{NODE}_total": 2 * (pc.get("rapl_package_w") or 95),
            "gpu": pc.get("gpu_w") or 210}}


DISMISS_FILE = os.path.join(HERE, "dismissed.json")   # the owner 2026-09-30: ✕ on finished Current tasks and on each Needs-attention alert
_dismiss_lock = threading.Lock()


def dismissed():
    try:
        with open(DISMISS_FILE) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    d.setdefault("tasks", {}); d.setdefault("alerts", {})
    now = time.time()
    d["alerts"] = {k: v for k, v in d["alerts"].items() if now - v < 86400}   # an alert dismissed > 24 h ago shows again if it recurs
    return d


def _dismiss_save(d):
    with open(DISMISS_FILE + ".tmp", "w") as f:
        json.dump(d, f)
    os.replace(DISMISS_FILE + ".tmp", DISMISS_FILE)


def dismiss_clear(kind, key):
    with _dismiss_lock:
        d = dismissed()
        if key in d[kind]:
            d[kind].pop(key); _dismiss_save(d)


def post_dismiss(self):
    sender = self.client_address[0].removeprefix("::ffff:")
    if not lan_control_ok(sender):
        return self.send(403, json.dumps({"ok": False, "error": "home LAN only"}), "application/json")
    n = int(self.headers.get("Content-Length") or 0)
    try:
        body = json.loads(self.rfile.read(n) if 0 < n <= 4096 else b"{}")
        kind, key = body["kind"], str(body["key"])[:300]
        if kind not in ("tasks", "alerts"):
            raise KeyError
    except (ValueError, KeyError, TypeError):
        return self.send(400, json.dumps({"ok": False, "error": "send {\"kind\": \"tasks\"|\"alerts\", \"key\": ...}"}), "application/json")
    with _dismiss_lock:
        d = dismissed(); d[kind][key] = time.time(); _dismiss_save(d)
    self.send(200, json.dumps({"ok": True}), "application/json")


H.post_dismiss = post_dismiss


if READ_ONLY:   # refuse every POST in the check copy
    H.do_POST = lambda self: self.send(403, "read-only check copy", "text/plain")


if __name__ == "__main__" and READ_ONLY:
    print(f"hub READ-ONLY check copy on :{PORT}, state from {HERE}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()


if __name__ == "__main__":
    try:
        hub_setup()
    except Exception as e:
        print("hub setup:", e, flush=True)
    speed["prev"] = socket_bytes()
    threading.Thread(target=fast_loop, daemon=True).start()
    threading.Thread(target=slow_loop, daemon=True).start()
    threading.Thread(target=node_loop, daemon=True).start()
    threading.Thread(target=lapcheck_loop, daemon=True).start()
    threading.Thread(target=remote_loop, daemon=True).start()
    threading.Thread(target=box_loop, daemon=True).start()
    threading.Thread(target=hub_loop, daemon=True).start()
    threading.Thread(target=rollup_loop, daemon=True).start()
    threading.Thread(target=lapjob_loop, daemon=True).start()
    threading.Thread(target=qc_loop, daemon=True).start()
    threading.Thread(target=offsite_loop, daemon=True).start()
    threading.Thread(target=sel_loop, daemon=True).start()
    threading.Thread(target=rp_restore_loop, daemon=True).start()
    threading.Thread(target=carve_record_loop, daemon=True).start()
    threading.Thread(target=emerg_loop, daemon=True).start()
    threading.Thread(target=temp_hist_loop, daemon=True).start()
    threading.Thread(target=health_loop, daemon=True).start()
    threading.Thread(target=ipmi_loop, args=(["sudo", "-n", "ipmitool"],), daemon=True).start()
    threading.Thread(target=fan_loop, args=(["sudo", "-n", "ipmitool"], "/run/ipmi-sdr.cache"), daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
