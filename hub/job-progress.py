#!/usr/bin/env python3
# Current-tasks reporter (2026-09-29, the owner: "add another card ... what the current tasks are and the progress of those tasks
# with an ETA and a progress bar"). Runs on the the main server as owner every minute (job-progress.timer). Reads each running job's own
# progress (logs, progress files, landing dirs) - no heavy queries - and posts group="current" tasks to /api/tasks with
# done/total/rate/eta_s. Rates come from the previous sample (state file).
import json, os, re, subprocess, time, urllib.request
from hubcfg import BOX, BOX_NAME, CFG, MAIN, NODE

API = f"http://{CFG['main_ip']}:8090/api/tasks"
STATE = os.path.expanduser("~/dashboard/job-progress.state.json")
now = time.time()
try:
    prev = json.load(open(STATE))
except (OSError, ValueError):
    prev = {}
out, keep = [], {}


def task(tid, title, done, total=None, unit="items", state="running", host=MAIN, message=None):
    t = {"id": tid, "title": title, "group": "current", "host": host, "state": state, "unit": unit, "done": done,
         "total": total, "heartbeat_s": 120, "message": message, "owner": "Home-server single thread"}
    p = prev.get(tid)
    if state == "running" and p and done is not None and now > p["t"] and done >= p["d"]:
        r = (done - p["d"]) / (now - p["t"])
        r = r if not p.get("r") else 0.3 * r + 0.7 * p["r"]          # smoothed
        t["rate"] = r
        if r < 1e-9:                                                  # smoothing decays toward 0; avoid denormal rate -> inf ETA
            r = 0.0
        t["rate"] = r
        if total and r > 0:
            t["eta_s"] = max(0.0, (total - done) / r)
        keep[tid] = {"t": now, "d": done, "r": r}
    elif done is not None:
        keep[tid] = {"t": now, "d": done, "r": (p or {}).get("r")}
    if state in ("done", "failed"):
        t["finished_at"] = now
    out.append({k: v for k, v in t.items() if v is not None})


def sh(cmd, timeout=20):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout
    except subprocess.TimeoutExpired:
        return ""


def tail(path, pat=None, n=4000):
    try:
        lines = open(path, errors="replace").read()[-200000:].splitlines()
    except OSError:
        return []
    return [l for l in lines if not pat or re.search(pat, l)][-n:]


# 1. the GPU node /32a and /32b: hash check, then unique-copy + verify
USED = {"32a": 1.70e12, "32b": 1.70e12}
for m in ("32a", "32b"):
    p = sh(f"ssh -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes -i {CFG['ssh_key']} {CFG['ssh_user_at']}{CFG['node_ip']} cat /dev/shm/named-check/{m}/progress /dev/shm/named-check/{m}/copy.log 2>/dev/null")
    b = re.search(r"'bytes': (\d+)", p); miss = re.search(r"'missing': (\d+), 'missing_bytes': (\d+)", p)
    if "ingest exit" in p:
        task(f"cur/named-{m}", f"/{m}: evacuate unique files to {MAIN}", 1, 1, "percent", "done", NODE, "copied + verified; see ingest.txt")
    elif "unique to copy" in p:
        u = re.search(r"unique to copy: (\d+) files, ([\d.]+) GB", p)
        tot = float(u.group(2)) * 1e9 if u else None
        got = sh(f"du -sb /e/{NODE}-named/{m} 2>/dev/null | cut -f1").strip()
        task(f"cur/named-{m}", f"/{m}: copy unique files to {MAIN}", int(got or 0), tot, "bytes", "running", NODE)
    elif b:
        task(f"cur/named-{m}", f"/{m}: hash check vs {MAIN} catalog", int(b.group(1)), USED[m], "bytes", "running", NODE,
             f"not on {MAIN} so far: {int(miss.group(1)):,} files, {int(miss.group(2))/1e9:.1f} GB" if miss else None)

# 2. dedup removal, one volume at a time
runlog = tail("/opt/recovery/catalog/dedup-run-all.log")
for v in ("n2", "d", "c", "b", "e", "n4rest"):
    started = any(f"run carve-dedup-{v}-" in l for l in runlog)
    if not started:
        continue
    L = tail(f"/opt/recovery/catalog/carve-dedup-{v}.log", r"start:|progress:|finished:")
    st = next((re.search(r"start: (\d+) planned", l) for l in L if "start:" in l), None)
    total = int(st.group(1)) if st else None
    fin = [l for l in L if "finished:" in l]
    pr = [l for l in L if "progress:" in l]
    name = "/" + ("n4 (rest)" if v == "n4rest" else v)
    if fin:
        m = re.search(r"finished: (\d+) removed, (\d+) skipped, ([\d.]+) GB", fin[-1])
        task(f"cur/dedup-{v}", f"Dedup removal {name}", total, total, "files", "done", message=f"{int(m.group(1)):,} removed, {m.group(3)} GB freed" if m else None)
    else:
        m = re.search(r"progress: (\d+) removed, (\d+) skipped, ([\d.]+) GB", pr[-1]) if pr else None
        d = int(m.group(1)) + int(m.group(2)) if m else 0
        task(f"cur/dedup-{v}", f"Dedup removal {name}", d, total, "files", message=f"{m.group(3)} GB freed so far" if m else None)

# 3. dedup plan still building (n4 leftovers)
L = tail("/opt/recovery/catalog/carve-dedup-plan-n4rest.log", r"^id |^done:")
if L and L[-1].startswith("done:"):
    task("cur/plan-n4rest", "Dedup plan /n4 (rest)", 1, 1, "percent", "done", message=L[-1][:120])
elif L:
    m = re.search(r"^id (\d+):.*planned so far (\d+) \(([\d.]+) GB\)", L[-1])
    mx = sh(f"mysql --defaults-file=$HOME/.{CFG['db_cnf_name']} recovery -N -e 'select max(id) from files'").strip()
    if m and mx.isdigit():
        task("cur/plan-n4rest", "Dedup plan /n4 (rest)", int(m.group(1)), int(mx), "items", message=f"{int(m.group(2)):,} duplicates, {m.group(3)} GB")

# 4. laptop USB MainBackup2025 raw read (chunk folders named by byte offset on the the main server)
offs = [int(x) for x in re.findall(r"^c(\d+)-", sh(f"ls {CFG['media_root']}carve-landing/usb-mainbackup2025-2026-09-27/"), re.M)]
if offs:
    age = now - max((os.path.getmtime(p) for p in __import__("glob").glob(f"{CFG['media_root']}carve-landing/usb-mainbackup2025-2026-09-27/c*")), default=0)
    idle = age > 45 * 60   # no new chunk for 45 min: the laptop job is stopped (drive dropped / STOP) - the the main server can't see its flag
    task("cur/usb-read", "USB MainBackup2025: read + carve (laptop)", max(offs) + 18e9, 4000787030016, "bytes",
         "paused" if idle else "running", host="laptop",
         message=(f"paused: no new chunk for {age/3600:.0f} h (drive needs a power-cycle?)" if idle else "bad regions 72-87 and 573-591 GB retried last"))

# 5. carved-junk delete (no fixed total) and catalog queue
L = sh("grep -a 'running total' /opt/recovery/catalog/carved-junk-delete.log | tail -1").splitlines()
if L and sh("systemctl is-active carved-junk-delete-v3").strip() == "active":
    m = re.search(r"running total: (\d+) removed", L[-1])
    task("cur/junk", "Carved-junk delete", int(m.group(1)) if m else None, None, "files", message="total unknown; runs by category")
q = sh(f"mysql --defaults-file=$HOME/.{CFG['db_cnf_name']} recovery -N -e \"select count(*) from scan_queue where status in ('queued','running')\"").strip()
if q.isdigit():
    task("cur/catalog-queue", "Catalog: folders waiting to be hashed", int(q), None, "items", "running" if int(q) else "done")

# 6. image understanding pass 1 + 2 (qwen2.5vl on the the GPU node GPU)
# 2026-10-28: blank images (image_signals.blank) are skipped by the runners on purpose -> counted as skipped; queue empty = done (gets the ✕)
v = sh(f"mysql --defaults-file=$HOME/.{CFG['db_cnf_name']} recovery -N -e \"select (select count(*) from image_vlm_queue), (select count(*) from image_vlm where status='done'), (select count(*) from image_vlm where status='error'), "
       "(select count(*) from image_vlm_queue q left join image_vlm v on v.hash=q.hash join image_signals s on s.hash=q.hash where v.hash is null and s.blank=1)\"").split()
if len(v) == 4 and v[0].isdigit():
    act = sh("systemctl is-active vlm-runner").strip() == "active"
    act_box = sh(f"systemctl is-active vlm-runner-{BOX}").strip() == "active"
    vdone = int(v[1]) + int(v[2]) + int(v[3])
    msg = ", ".join(x for x in (f"{int(v[2]):,} errors" if int(v[2]) else "", f"{int(v[3]):,} blank skipped" if int(v[3]) else "") if x) or None
    task("cur/vlm", "Image understanding (GPU): category + description", vdone, int(v[0]), "items",
         "running" if act or act_box else ("done" if vdone >= int(v[0]) else "paused"), f"{NODE} + {BOX_NAME}" if act_box else NODE, msg)
    # dashboard GPU-job chart feed (replaces the finished Copilot feed): the GPU node /dev/shm/gpu-job.vlm.json, images per second
    # 2026-10-27: one feed per GPU (image_vlm.gpu): gpu-job.vlm.json = the GPU node GPU, gpu-job.vlm-the intake box.json = the intake box GPU
    r60 = sh(f"mysql --defaults-file=$HOME/.{CFG['db_cnf_name']} recovery -N -e \"select count(*) from image_vlm where created_at > now() - interval 60 second and coalesce(gpu,'{NODE}-{CFG['node_gpu_tag']}')='{NODE}-{CFG['node_gpu_tag']}'\"").strip()
    # 2026-10-15: pass 2 (remaining screenshots + camera photos); a finished/stopped runner REMOVES its feed (: paused or
    # stopped graphs hide, finished feeds go) instead of writing state "stopped", which kept a stale graph on the dashboard
    doc = {"job": "image understanding (qwen2.5vl:7b)", "owner_thread": "Home-server single thread", "unit": "images",
           "done_total": int(v[1]) + int(v[2]), "rate_per_s": round(int(r60 or 0) / 60, 3), "updated_at": int(now),
           "state": "running" if act else "paused"}
    keep_feed = act or sh("systemctl is-active gpu-order").strip() == "active"
    subprocess.run(f"ssh -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes -i {CFG['ssh_key']} {CFG['ssh_user_at']}{CFG['node_ip']} "
                   + ("'cat > /dev/shm/gpu-job.vlm.json.tmp && mv /dev/shm/gpu-job.vlm.json.tmp /dev/shm/gpu-job.vlm.json'" if keep_feed
                      else "'cat > /dev/null; rm -f /dev/shm/gpu-job.vlm.json'"),
                   shell=True, input=json.dumps(doc).encode(), timeout=20)
    t60, tdone = sh(f"mysql --defaults-file=$HOME/.{CFG['db_cnf_name']} recovery -N -e \"select sum(created_at > now() - interval 60 second), count(*) from image_vlm where gpu='{BOX}-{CFG['box_gpu_short']}'\"").split() or ["0", "0"]
    doc = {"job": f"image understanding on {BOX_NAME} {CFG['box_gpu']} (qwen2.5vl:7b)", "owner_thread": "Home-server single thread", "unit": "images",
           "done_total": int(tdone if tdone.isdigit() else 0), "rate_per_s": round(int(t60 if t60.isdigit() else 0) / 60, 3),
           "updated_at": int(now), "state": "running"}
    subprocess.run(f"ssh -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes -i {CFG['ssh_key']} {CFG['ssh_user_at']}{CFG['node_ip']} "
                   + (f"'cat > /dev/shm/gpu-job.vlm-{BOX}.json.tmp && mv /dev/shm/gpu-job.vlm-{BOX}.json.tmp /dev/shm/gpu-job.vlm-{BOX}.json'" if act_box
                      else f"'cat > /dev/null; rm -f /dev/shm/gpu-job.vlm-{BOX}.json'"),
                   shell=True, input=json.dumps(doc).encode(), timeout=20)

# 7. one-time the main server -> the GPU node /raid6 copy (the GPU node-copy.sh): sum of each volume's rsync progress2 bytes vs volume sizes
RC = f"/opt/recovery/catalog/{NODE}-copy"
if os.path.exists(RC + "/driver.log"):
    SIZES = {"c": 3.28e12, "d": 2.96e12, "b": 2.17e12, "e": 2.64e12, "n2": 1.17e12, "n4": 2.88e12, f"root-{NODE}-carve": 0.98e12, "root-home": 0.055e12, "hidden": 2.12e12}
    drv = open(RC + "/driver.log").read()
    done_b = 0
    for n, sz in SIZES.items():
        m_ = {"b": "b2", "n4": "n4w"}.get(n) if f"start {({"b": "b2", "n4": "n4w"}).get(n, "-")} " in drv else n          # /b re-run whole-file as b2 (2026-10-01)
        if f"done {m_} exit 0" in drv or f"done {m_} exit 24" in drv:   # 24 = some files vanished mid-copy (deleted/moved); verify pass covers them
            done_b += sz; continue
        try:
            t = open(f"{RC}/{m_}.log", "rb").read()[-4000:].decode("utf-8", "replace").replace(chr(13), chr(10))
            m = [l for l in t.splitlines() if re.match(r"\s*[\d,]+\s+\d+%", l)]
            if m:
                done_b += min(sz, int(m[-1].split()[0].replace(",", "")))
        except OSError:
            pass
    fin = "one-time copy finished" in drv
    task(f"cur/{NODE}-copy", f"{MAIN} → {NODE} full copy (/raid6, one-time)", done_b, sum(SIZES.values()), "bytes",
         "done" if fin else "running", MAIN, "then mysqldump + verify vs catalog")

# 8. video classification pipeline (2026-09-30): one Current task per stage, from recovery.video_pipeline status columns
vp = sh(f"mysql --defaults-file=$HOME/.{CFG['db_cnf_name']} recovery -N -e \"select 'frames',sum(frames_status in ('done','error')),count(*) from video_pipeline "
        "union all select 'vlm',sum(vlm_status in ('done','skip','error')),count(*) from video_pipeline "
        "union all select 'asr',sum(asr_status in ('done','skip','error')),count(*) from video_pipeline "
        "union all select 'captions',sum(caption_status in ('done','skip','error')),count(*) from video_pipeline "
        "union all select 'text',sum(text_status in ('done','skip','error')),count(*) from video_pipeline "
        "union all select 'decide',sum(verdict is not null),count(*) from video_pipeline\"")
NAMES = {"frames": "Videos 1/5: probe + frame checks (dark, static)", "vlm": "Videos 2/5: GPU labels from keyframes",
         "asr": "Videos 3/5: audio transcription (timed)", "captions": "Videos 3b/5: captions by screen area (timed)",
         "text": "Videos 4/5: transcript labels + sensitivity",
         "decide": "Videos 5/5: Immich include/hold verdict"}
for line in vp.splitlines():
    st, d, tot = line.split("\t")
    if tot.isdigit() and int(tot):
        act = sh(f"systemctl is-active video-pipeline@{st if st != 'asr' else 'asr1'}").strip() == "active"
        dn = int(d if d != "NULL" else 0)
        # 2026-10-03: a stage with every video processed (done/error/skip) is "done", not stuck at 100% running/paused
        task(f"cur/video-{st}", NAMES[st], dn, int(tot), "items", "done" if dn >= int(tot) else ("running" if act else "paused"))
# one dashboard chart per job (2026-10-01: every new job gets a graph; a paused job's graph hides)
def feed(name, job, unit, rate, state, total=None):
    doc = {"job": job, "owner_thread": "Home-server single thread", "unit": unit, "rate_per_s": round(rate, 4), "updated_at": int(now),
           "state": state}
    if total is not None:
        doc["done_total"] = total
    subprocess.run(f"ssh -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes -i {CFG['ssh_key']} {CFG['ssh_user_at']}{CFG['node_ip']} "
                   f"'cat > /dev/shm/gpu-job.{name}.json.tmp && mv /dev/shm/gpu-job.{name}.json.tmp /dev/shm/gpu-job.{name}.json'",
                   shell=True, input=json.dumps(doc).encode(), timeout=20)


def q1(sql):
    v = sh(f"mysql --defaults-file=$HOME/.{CFG['db_cnf_name']} recovery -N -e \"{sql}\"").strip()
    return float(v) if v.replace(".", "", 1).isdigit() else 0.0


def unit_state(*units):
    return "running" if any(sh(f"systemctl is-active {u}").strip() == "active" for u in units) else "paused"


feed("video-labels", "video GPU labels per 5-min window (qwen2.5vl:7b)", "windows",
     q1("select count(*) from video_segment where created_at > now() - interval 300 second") / 300, unit_state("video-pipeline@vlm"))
feed("video-text", "video transcript labels + sensitivity (qwen2.5vl:7b)", "videos",
     q1("select count(*) from video_description where source='text' and created_at > now() - interval 300 second") / 300, unit_state("video-pipeline@text"))
# whisper-the GPU node feed retired 2026-10-15: the GPU node transcription runs on the GPU now and whisper_server.py writes its own feed
# (gpu-job.whisper-gpu-<port>.json); this one duplicated it under the old "CPU (3 workers)" title.
subprocess.run(f"ssh -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes -i {CFG['ssh_key']} {CFG['ssh_user_at']}{CFG['node_ip']} 'rm -f /dev/shm/gpu-job.video.json /dev/shm/gpu-job.whisper-{NODE}.json'",
               shell=True, timeout=20)   # replaced by the per-job feeds above

json.dump(keep, open(STATE, "w"))
req = urllib.request.Request(API, data=json.dumps(out).encode(), headers={"Content-Type": "application/json"}, method="POST")
r = urllib.request.urlopen(req, timeout=10).read().decode(); print(r[:200]); print([e for e in json.loads(r).get("errors", [])][:5])
