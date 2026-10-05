#!/usr/bin/env python3
"""Before/after measurement driver for BOAR over adb (Pixel 6a).

  bench.py cool                      wait until battery <= BENCH_MAX_C (33.0) C and thermal status 0
  bench.py convo LABEL               run the 6-question conversation in the real chat UI
  bench.py pull LABEL SINCE_MS       export telemetry + answers created after SINCE_MS (phone clock)
  bench.py now                       print the phone clock in ms
"""
import json, os, re, sqlite3, subprocess, sys, time

D = os.environ["ANDROID_SERIAL"]  # adb serial of the phone
PKG = "team.sopa.aoair"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "bench")
os.makedirs(OUT, exist_ok=True)

QUESTIONS = [
    "How do vaccines work?",
    "What are the side effects?",
    "Who proposed the theory of evolution by natural selection?",
    "What did he publish?",
    "Compare the French Revolution and the Industrial Revolution.",
    "What is the capital of Australia?",
]
PAUSE_S = 30


def adb(*args, check=True, binary=False):
    r = subprocess.run(["adb", "-s", D, *args], capture_output=True, timeout=120)
    if check and r.returncode != 0:
        raise RuntimeError(f"adb {' '.join(args)}: {r.stderr.decode(errors='replace')}")
    return r.stdout if binary else r.stdout.decode(errors="replace")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def phone_ms():
    return int(adb("shell", "date +%s%3N").strip())


def thermal():
    temp = int(re.search(r"temperature: (\d+)", adb("shell", "dumpsys battery")).group(1)) / 10
    status = int(re.search(r"Thermal Status: (\d+)", adb("shell", "dumpsys thermalservice")).group(1))
    return temp, status


def cool(max_c=float(os.environ.get("BENCH_MAX_C", "33.0")), timeout_s=1800):
    t0 = time.time()
    while True:
        temp, status = thermal()
        log(f"battery {temp:.1f} C, thermal status {status}")
        if temp <= max_c and status == 0:
            return temp, status
        if time.time() - t0 > timeout_s:
            log("still warm after the timeout; continuing anyway")
            return temp, status
        time.sleep(30)


def wake():
    adb("shell", "input keyevent KEYCODE_WAKEUP", check=False)


def screen():
    adb("shell", "uiautomator dump /sdcard/bench-ui.xml", check=False)
    xml = adb("exec-out", "cat /sdcard/bench-ui.xml", check=False)
    nodes = []
    for n in re.findall(r"<node [^>]*>", xml):
        get = lambda k: (re.search(rf' {k}="([^"]*)"', n) or [None, ""])[1]
        b = [int(v) for v in re.findall(r"\d+", get("bounds"))]
        if len(b) == 4:
            nodes.append({"cls": get("class"), "text": get("text"), "desc": get("content-desc"), "x": (b[0] + b[2]) // 2, "y": (b[1] + b[3]) // 2, "b": b})
    global TOOLS
    t = next((n for n in nodes if n["desc"] == "Tools"), None)
    if t:
        TOOLS = t["b"]
    return nodes


def near_tools(x, y, margin=100):
    if not TOOLS:
        return False
    l, t, r, b = TOOLS
    return l - margin <= x <= r + margin and t - margin <= y <= b + margin


TOOLS = None  # bounds of the Expo dev "Tools" floating button, refreshed by screen()


def find(nodes, desc=None, cls=None):
    for n in nodes:
        if desc and n["desc"] == desc:
            return n
        if cls and cls in n["cls"]:
            return n
    return None


def tap(n):
    if near_tools(n["x"], n["y"]):
        raise RuntimeError(f"refusing to tap {n['desc'] or n['text']!r}: the Expo Tools button {TOOLS} is too close")
    adb("shell", f"input tap {n['x']} {n['y']}")


def type_text(text):
    # `input text`: spaces as %s; the whole argument single-quoted for the device shell.
    adb("shell", "input text '" + text.replace(" ", "%s").replace("'", "") + "'")


def busy(nodes):
    """Generating: no Send button (it turns into Stop while an answer streams)."""
    return find(nodes, desc="Send message") is None


def wait_answer(timeout_s=300):
    t0 = time.time()
    # First the answer has to start (the send button turns into stop), then end.
    started = False
    while time.time() - t0 < 25:
        wake()
        if busy(screen()):
            started = True
            break
        time.sleep(1)
    calm = 0
    while time.time() - t0 < timeout_s:
        wake()
        if not busy(screen()):
            calm += 1
            if calm >= 2:
                return time.time() - t0, started
        else:
            calm = 0
        time.sleep(4)
    return time.time() - t0, started


def to_chat(timeout_s=60):
    """Leave the Evaluation screen (its Done button) and wait for the chat's New Chat button."""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        wake()
        nodes = screen()
        if find(nodes, desc="New Chat Session"):
            log("on the chat screen")
            return True
        done = find(nodes, desc="Done")
        if done:
            # The Expo dev "Tools" button floats over most of Done: tap a point of Done outside it.
            tools = find(nodes, desc="Tools")
            x, y = done["x"], done["y"]
            if tools:
                l, t, r, btm = done["b"]
                tl, tt, tr, tb = tools["b"]
                if r - 4 > tr:
                    x, y = (tr + r) // 2, (t + btm) // 2
                elif tt - 4 > t:
                    x, y = (l + r) // 2, (t + tt) // 2
            if near_tools(x, y):
                raise RuntimeError(f"Done is covered by the Expo Tools button {TOOLS}; move the button")
            adb("shell", f"input tap {x} {y}")
            log(f"closed the Evaluation screen (tap {x},{y})")
        time.sleep(3)
    raise RuntimeError("could not get back to the chat screen")


def convo(label):
    adb("shell", f"monkey -p {PKG} -c android.intent.category.LAUNCHER 1", check=False)
    time.sleep(3)
    to_chat()
    nodes = screen()
    new_chat = find(nodes, desc="New Chat Session")
    if not new_chat:
        raise RuntimeError("New Chat button not found: is the chat screen open?")
    tap(new_chat)
    time.sleep(2)
    since = phone_ms()
    record = {"label": label, "since_ms": since, "questions": []}
    for i, q in enumerate(QUESTIONS):
        wake()
        nodes = screen()
        box, send = find(nodes, cls="EditText"), find(nodes, desc="Send message")
        if not box or not send:
            raise RuntimeError(f"input or send not found before question {i + 1}")
        tap(box)
        time.sleep(0.5)
        type_text(q)
        time.sleep(0.8)
        # Tap Send once, then wait for the box to clear. On main the app clears it only after the
        # background summary stops (the freeze the branch fixes); tapping again would send duplicates.
        send = find(screen(), desc="Send message") or send
        tapped = time.time()
        tap(send)
        while True:
            wake()
            box = find(screen(), cls="EditText")
            if box and q not in box["text"]:
                break
            if time.time() - tapped > 300:
                raise RuntimeError(f"question {i + 1} never left the input box")
            time.sleep(2)
        sent_at = time.time()
        held_s = round(sent_at - tapped, 1)
        log(f"{label} Q{i + 1} sent after {held_s}s in the box: {q}")
        took, started = wait_answer()
        log(f"{label} Q{i + 1} done after ~{took:.0f}s (started={started})")
        record["questions"].append({"q": q, "held_in_box_s": held_s, "wall_s": round(took, 1), "started": started, "sent_at": sent_at})
        if i < len(QUESTIONS) - 1:
            for _ in range(PAUSE_S // 10):
                wake()
                time.sleep(10)
    record["temp_after"] = thermal()
    path = os.path.join(OUT, f"{label}.convo.json")
    json.dump(record, open(path, "w"), indent=2)
    log(f"wrote {path}")
    return since


def pull(label, since_ms):
    dbdir = os.path.join(OUT, f"{label}.db")
    os.makedirs(dbdir, exist_ok=True)
    for f in ["aoair_knowledge.db", "aoair_knowledge.db-wal", "aoair_knowledge.db-shm"]:
        data = adb("exec-out", f"run-as {PKG} cat files/SQLite/{f}", binary=True, check=False)
        open(os.path.join(dbdir, f), "wb").write(data)
    c = sqlite3.connect(os.path.join(dbdir, "aoair_knowledge.db"))
    c.row_factory = sqlite3.Row
    rows = [dict(r) for r in c.execute(
        "SELECT created_at, model_id, task_type, ttft_ms, tok_per_sec, tokens_generated, generation_latency_ms, total_latency_ms, outcome "
        "FROM execution_telemetry WHERE created_at >= ? ORDER BY created_at", (int(since_ms),))]
    msgs = [dict(r) for r in c.execute(
        "SELECT created_at, role, text FROM chat_messages WHERE created_at >= ? ORDER BY created_at", (int(since_ms),))]
    out = {"label": label, "since_ms": int(since_ms), "telemetry": rows, "messages": msgs}
    path = os.path.join(OUT, f"{label}.results.json")
    json.dump(out, open(path, "w"), indent=2)
    log(f"{label}: {len(rows)} telemetry rows, {len(msgs)} messages -> {path}")
    for r in rows:
        print(f"  {r['model_id']:<30} ttft {r['ttft_ms'] or 0:>8.0f} ms  tok/s {r['tok_per_sec'] or 0:>5.1f}  tokens {r['tokens_generated'] or 0:>4}  total {r['total_latency_ms'] or 0:>8.0f} ms  {r['outcome']}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "cool":
        cool()
    elif cmd == "chat":
        to_chat()
    elif cmd == "now":
        print(phone_ms())
    elif cmd == "convo":
        s = convo(sys.argv[2])
        pull(sys.argv[2], s)
    elif cmd == "pull":
        pull(sys.argv[2], int(sys.argv[3]))
