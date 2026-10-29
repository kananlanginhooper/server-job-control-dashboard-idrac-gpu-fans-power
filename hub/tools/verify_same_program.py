"""Prove a scrubbed hub file is the same program as the original, given the private config.

usage (python 3.12+): verify_same_program.py <original.py> <scrubbed.py> <config.json> [allowed-diff-stmt-prefix ...]
Both trees are normalized: docstrings dropped; in the scrubbed tree MAIN/NODE/BOX/BOX_NAME and CFG['k'] become the
config's constants; f-strings whose fields are all constants fold to plain strings; identifiers in the original
get the same renames the scrub applied (and any collision with an existing name fails the check).
Top-level statements whose source starts with an allowed prefix (e.g. "HERE =") may differ; they're listed.
"""
import ast, json, re, sys

orig_src, scr_src = open(sys.argv[1], encoding="utf-8").read(), open(sys.argv[2], encoding="utf-8").read()
cfg = json.load(open(sys.argv[3]))
allowed = sys.argv[4:]
# the scrub renamed identifiers containing host names: <main> -> main, <NODE> -> NODE, ... (names from the config)
NAME_MAP = {}
for var, word in (("MAIN", "main"), ("NODE", "node"), ("BOX", "box")):
    NAME_MAP[cfg[var]] = word
    NAME_MAP[cfg[var].upper()] = word.upper()
NAME_MAP[cfg["BOX_NAME"]] = "Box"
NAME_RX = re.compile("(" + "|".join(sorted(map(re.escape, NAME_MAP), key=len, reverse=True)) + ")")
CFG_NAMES = {"MAIN", "NODE", "BOX", "BOX_NAME"}


def idents(tree):
    out = set()
    for n in ast.walk(tree):
        for f in ("id", "name", "arg", "attr"):
            v = getattr(n, f, None)
            if isinstance(v, str):
                out.add(v)
        if isinstance(n, ast.alias):
            out.add(n.asname or n.name)
    return out


class Renamer(ast.NodeTransformer):
    def generic_visit(self, node):
        for f in ("id", "name", "arg", "attr"):
            v = getattr(node, f, None)
            if isinstance(v, str) and NAME_RX.search(v) and v != cfg["BOX"]:
                setattr(node, f, NAME_RX.sub(lambda m: NAME_MAP[m.group(1)], v))
        return super().generic_visit(node)


class Fold(ast.NodeTransformer):
    def __init__(self, scrubbed):
        self.scrubbed = scrubbed

    def visit_Name(self, n):
        if self.scrubbed and n.id in CFG_NAMES and isinstance(n.ctx, ast.Load):
            return ast.Constant(cfg[n.id])
        return n

    def visit_Subscript(self, n):
        self.generic_visit(n)
        if self.scrubbed and isinstance(n.value, ast.Name) and n.value.id == "CFG" and isinstance(n.slice, ast.Constant):
            return ast.parse(repr(cfg[n.slice.value]), mode="eval").body
        return n

    def visit_JoinedStr(self, n):
        self.generic_visit(n)
        parts = []
        for v in n.values:
            if isinstance(v, ast.FormattedValue) and isinstance(v.value, ast.Constant) and isinstance(v.value.value, str) \
                    and v.conversion == -1 and v.format_spec is None:
                v = ast.Constant(v.value.value)
            if isinstance(v, ast.Constant) and parts and isinstance(parts[-1], ast.Constant):
                parts[-1] = ast.Constant(parts[-1].value + v.value)
            else:
                parts.append(v)
        parts = [p for p in parts if not (isinstance(p, ast.Constant) and p.value == "")]
        if all(isinstance(p, ast.Constant) for p in parts):
            return ast.Constant("".join(p.value for p in parts))
        n.values = parts
        return n


def strip_docstrings(tree):
    for n in ast.walk(tree):
        body = getattr(n, "body", None)
        if isinstance(body, list) and body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                and isinstance(body[0].value.value, str):
            n.body = body[1:] or [ast.Pass()]
    return tree


def norm(src, scrubbed):
    t = strip_docstrings(ast.parse(src))
    if not scrubbed:
        t = Renamer().visit(t)
    return Fold(scrubbed).visit(t)


ot, st = ast.parse(orig_src), ast.parse(scr_src)
renamed = {v for v in idents(ot) if NAME_RX.search(v) and v != cfg["BOX"]}
targets = {NAME_RX.sub(lambda m: NAME_MAP[m.group(1)], v): v for v in renamed}
collide = sorted(t for t in targets if t in idents(ot) - renamed)
if collide:
    sys.exit(f"FAIL rename collisions: {collide}")

A, B = norm(orig_src, False).body, norm(scr_src, True).body
srcB = scr_src.splitlines()
def key(stmt, lines):
    return lines[stmt.lineno - 1].strip()
ia = ib = 0
diffs, allowed_hits = [], []
# align top-level statements; allowed statements in the scrubbed file may be extra/changed
while ia < len(A) or ib < len(B):
    a = A[ia] if ia < len(A) else None
    b = B[ib] if ib < len(B) else None
    if a is not None and b is not None and ast.dump(a) == ast.dump(b):
        ia += 1; ib += 1; continue
    if b is not None and any(key(b, srcB).startswith(p) for p in allowed):
        allowed_hits.append(f"{b.lineno}: {key(b, srcB)[:110]}")
        ib += 1
        if a is not None and ast.dump(a).split("(")[0] == ast.dump(b).split("(")[0] and getattr(a, "targets", None) and \
                getattr(b, "targets", None) and ast.dump(a.targets[0]) == ast.dump(b.targets[0]):
            ia += 1
        continue
    diffs.append((a.lineno if a else None, b.lineno if b else None))
    if len(diffs) > 5:
        break
    ia += 1; ib += 1
for line in allowed_hits:
    print("allowed:", line)
if diffs:
    for da, db in diffs:
        print(f"DIFF original line {da} vs scrubbed line {db}")
        if db: print("   scrubbed:", srcB[db - 1].strip()[:160])
        if da: print("   original:", orig_src.splitlines()[da - 1].strip()[:160])
    sys.exit("FAIL")
print(f"OK: same program ({len(A)} top-level statements), {len(renamed)} identifiers renamed, {len(allowed_hits)} allowed changes")
