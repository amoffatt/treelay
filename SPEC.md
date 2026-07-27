# treelay — design spec

An inheritance/composition system for directory trees. A directory can declare
inheritance **parents** and **mixins**; "compiling" it resolves the whole graph
and materializes a flat output directory. Crucially, the output stays **linked**
to its template, so template changes can be pulled into an already-created,
already-edited project via three-way merge.

> Status: design draft. Decisions marked **[decided]** are locked; **[open]**
> needs a call before implementation.

---

## 1. Mental model

A directory is a **class**; compiling it produces an **instance** (a plain,
flat directory). Everything else is borrowed from language semantics:

| Filesystem concept            | Language analogue            |
|-------------------------------|------------------------------|
| `parents`                     | base classes (*is-a*)        |
| `mixins`                      | traits/mixins (*with-a*)     |
| compile                       | instantiation / flattening   |
| same file in multiple layers  | method override / `super()`  |
| a `.patch` on an inherited file | calling `super()` then editing the result |
| a tombstone                   | deleting an inherited member  |

If a "what should happen here?" question comes up, the honest answer is usually
"what would the class-inheritance version do?"

### The two relationships, and why both exist

- **parent** — a full base you are a specialization of. Transitively resolved:
  a parent contributes *its own* parents into your lineage. Use for "this
  project *is a* TypeScript service."
- **mixin** — a focused, reusable fragment layered on top. Not necessarily
  buildable standalone. Use for "...also *with* Docker, *with* CI."

Precedence, lowest → highest:

```
parents (C3-linearized)  <  mixins (declaration order)  <  self
```

`self > mixins > parents`. Write this on the box; every user needs it in their head.

---

## 2. Manifest

Each overlay directory carries `treelay.json` (or a `"treelay"` key in
`package.json`, so an overlay *is* a normal npm package).

```jsonc
{
  "name": "@acme/service-base",
  "abstract": false,                 // true = inherit-only, not compilable standalone
  "parents": ["@acme/node-base@^2", "../shared-eslint"],
  "mixins":  ["@acme/with-docker", "@acme/with-ci"],
  "mounts":  { "packages": "git+https://host/acme/packages.git#v1.2.0" },
  "ignore":  ["node_modules", ".git", ".treelay"],
  "merge": {
    "*.json":       "deep-merge",
    "*.yaml":       "deep-merge",
    "package.json": "deep-merge",
    "**/*.png":     "replace"
  },
  "arrays": "replace",                // deep-merge array policy: replace | concat | by-key

  "templateSuffix": ".tmpl",          // only files ending in this are rendered (see §6)
  "variables": {
    "serviceName": { "type": "string", "prompt": "Service name?" },
    "port":        { "type": "number", "default": 3000 },
    "useDocker":   { "type": "boolean", "default": true },
    "registry":    { "type": "string", "default": "{{ org }}.registry.io", "computed": true },
    "license":     { "type": "string", "choices": ["MIT", "Apache-2.0"], "default": "MIT" }
  }
}
```

Variable *declarations* merge across the inheritance graph by the same layer
precedence as files (§3) — a parent declares, a mixin or the leaf overrides the
default — producing **one merged questionnaire** for the whole composition
(detailed in §6). This is the thing copier structurally cannot do (its templates
each keep an isolated answers file).

### Referencing layers (all npm-native) **[decided]** ✅ *implemented*

Three origins, told apart by shape alone so nothing has to be declared twice:

| Form | Example | Resolution |
|---|---|---|
| **local path** | `../base`, `/abs/base`, `file:./base` | as written (monorepo / dev) |
| **git** | `git+https://host/o/r.git#v1.2.0`, `git+ssh://git@host/o/r.git#main`, `git+file:///srv/r.git#main`, `github:acme/base#v2` | cloned and pinned to a commit |
| **npm** | `@acme/base@^2`, `pkg@1.2.3`, `npm:@acme/base@^2` | through the installed `node_modules` |

Any non-local ref may carry **`?path=<subdir>`** to use a subdirectory of the
fetched tree as the layer root — the monorepo-of-layers case
(`git+https://…/klamath.git?path=core/_layer#v3`). Order follows URL convention:
query before fragment.

**Git refs are enforced; npm refs are delegated.** A git ref names a commit, and
treelay materializes exactly that commit from its own cache, so a build
reproduces regardless of what has happened to the branch. An npm ref names a
*range*, and the package on disk was put there by a package manager that already
owns installation, integrity and an offline cache. treelay reads what is
installed, verifies it satisfies the declared range, and records the exact
version — it does not install, and it cannot roll a package back. Shipping a
second, worse package manager inside a composition engine would only produce two
lockfiles disagreeing about one tree. Reproducing an old npm pin is `npm ci`'s
job; that asymmetry is deliberate and is the one place where "pinned" means
*recorded* rather than *enforced*.

### Vendored trees: `mounts` **[decided]** ✅ *implemented*

A layer can pull an entire external tree into the composed output at a fixed
subpath:

```jsonc
{ "mounts": { "packages": "git+https://host/acme/packages.git#v1.2.0" } }
```

Every compiled tree then carries its own `packages/` — a self-contained
mini-monorepo where `file:`/workspace references resolve at stable internal
paths, with no registry and no path rewriting.

Mount **paths** merge across the graph by ordinary layer precedence: the highest
layer naming `packages` decides the ref. That is the whole feature — a leaf
holds a vendored tree back at an older pin while its parents float, using the
same override rule as everything else rather than a bespoke package mechanism.

Mounted layers sit at the **bottom** of the stack, below every declared layer.
Vendored content is substrate: any layer must be able to patch or tombstone a
file inside it, and that only works if the mount is beneath them all. The
alternative — placing a mount beside its declaring layer — would make an
intermediate layer's patch on `packages/**` apply or not depending on which
ancestor happened to win the ref, which is exactly the unexplainable-bug-report
outcome C3 exists to avoid. Overlapping mount paths are refused; they have no
unambiguous owner. Mounted layers are read-only for reflux in v1: promotion maps
an output path back to a layer path, and a mount's output paths carry a prefix
its sources do not (§8).

---

## 3. Resolution — the crux

A graph (with possible diamonds) flattened to a deterministic, ordered layer
list, lowest precedence → highest.

### Linearization: C3 **[decided]**

Use C3 linearization (Python's MRO) over the `parents` graph. It is the only
approach that simultaneously:

1. handles diamonds — a shared grandparent applies **once**, before both children;
2. respects local order — your declared parent order is honored;
3. is monotonic — a parent's ancestry is never reshuffled by a child.

The naive alternative (depth-first + last-wins dedupe) is simpler but produces
surprising orders in diamonds and generates unexplainable bug reports.

Final stack, lowest → highest:

0. `mounts` (§2), sorted by mount path — vendored substrate
1. linearized `parents` (C3 order)
2. `mixins` in declaration order (each strictly above all parents)
3. the directory's own files (always win)

The two lists run in opposite directions, which is worth stating plainly:
`parents` follows Python, so the **first**-declared base is the most derived and
outranks the ones after it; `mixins` are layered on in order, so the **last**
one declared wins. Parents answer "what am I a specialization of" (earlier =
closer to you); mixins answer "what is layered on top" (later = on top).

### Mixin ancestry **[decided]** ✅ *implemented*

A mixin may declare `parents` of its own. Each mixin's ancestry is C3-linearized
and placed **directly beneath that mixin**, while the whole group stays above
every one of the leaf's parents — so `parents < mixins < self` still holds when
read as groups rather than individual layers.

A layer that already appears lower in the stack keeps its position rather than
being re-inserted beneath its mixin. This is the diamond rule again: a shared
ancestor applies once, at its lowest position, because promoting it upward would
let it override the very layers it is supposed to sit beneath.

### Guards **[decided]**

- **Cycle detection** — `A → B → A` fails loud with the full path shown.
- **Lockfile** — `treelay.lock` records what every ref resolved to, for
  reproducible builds and upstream-drift detection (below).

### `treelay.lock` **[decided]** ✅ *implemented*

Committed beside the **leaf layer's manifest**. Deterministically serialized —
sorted keys, fixed field order, two-space indent, trailing newline — so
re-resolving an unchanged tree produces byte-identical output and never appears
in a diff.

```jsonc
{
  "lockfileVersion": 1,
  "refs": {
    "git+https://host/acme/packages.git#v1.2.0": {   // canonical ref = the key
      "kind": "git",
      "source": "https://host/acme/packages.git",
      "requested": "v1.2.0",                          // the mutable thing asked for
      "resolved": "3f2a1c9e…",                        // the immutable thing it became
      "integrity": "sha256:…",                        // over the materialized tree
      "path": "core/_layer",                          // ?path=, when present
      "requestedBy": ["klamath/project/_layer"]       // relative to the lockfile
    }
  }
}
```

Four properties worth stating outright:

- **The key is canonical, not textual.** `github:acme/base#v2` and
  `git+https://github.com/acme/base.git#v2` are the same layer and share one
  entry; the key is derived from the parsed ref, so two spellings cannot pin
  independently.
- **`requested` and `resolved` are both recorded.** A lock that stored only the
  commit could say *that* something changed but never *what was asked for* — and
  "v1.2.0 now points somewhere else" is the sentence a drift report needs.
- **`integrity` covers content, not history.** It hashes the materialized tree
  (`.git` and `node_modules` pruned), so a cache entry edited in place is caught
  even though its commit id is unchanged. It is enforced only when both sides
  claim the same revision — a *different* revision is drift, which for npm is
  legitimate and is reported rather than mistaken for corruption.
- **Only refs actually materialized are pinned.** A mount ref that lost the
  precedence contest is never fetched and never appears; the lock is a record of
  what was built, not of everything mentioned.

Distinct from `<dest>/.treelay/lock.json` (§7): that file is regenerated on
every compile and says what one *destination* was built from. `treelay.lock` is
the pin a repository commits and reviews.

**Fetching and the cache.** Fetched trees land at a path derived from what they
are — `<cache>/git/<repo-key>/rev/<commit>/` — never from who asked. Two layers
pinning the same commit share one checkout; a held-back pin coexists with a
floating one instead of fighting over a working directory; and the cache is
disposable, since the worst case is a re-fetch. Git trees are extracted with
`git archive`, so a checkout carries no `.git` at all and cannot leak a gitlink
into a composed tree (§4 guards the same hazard from the other side).
`TREELAY_CACHE_DIR` relocates it.

**Resolution is synchronous**, even though it may clone. Every caller in the
library and CLI treats `resolve` as a plain function, and a build cannot proceed
without its layers, so there is nothing to overlap with — going async would tax
every consumer for no gain.

### Drift: ref moved vs lock **[decided]** ✅ *implemented*

Drift is **reported, never acted on**. `compile` and `update` materialize the
locked revision even after `main` advances; that is what pinning means. An
update that silently recomposed at a newer revision would make "pull my
template's changes down" mean something different depending on the day.

- `treelay lock --drift` probes each pinned ref and exits non-zero if any moved.
- `update` prints moved refs on stderr before merging, then composes from the pins.
- `explain` / `plan` annotate each fetched layer with the revision in use.
- `treelay lock --update` is the *only* thing that advances a pin.
- `--frozen-lockfile` refuses to resolve anything the lock does not already
  pin — the CI posture: a build reproduces from what was committed, or it fails.

The probe is best-effort by construction. Offline, unauthenticated, or
uninstalled makes the current revision **unknown**, which is a distinct answer
from "unchanged" and is presented as one — an advisory check that reported
in-sync when it could not look would be worse than saying nothing. Annotated
tags are peeled before comparison, or every one of them would report drift
forever (a tag object's id is not the commit's).

Absent a lock entry, the first build resolves the ref, materializes it, and
records the pin — the package-manager convention, so day one needs no separate
step. That write touches the *source* tree, so it is always announced rather
than done silently.

---

## 4. Per-file merge semantics

When the same relative path exists in N layers:

| Strategy            | Default for             | Mechanism                                  |
|---------------------|-------------------------|--------------------------------------------|
| **replace**         | binary / unknown        | higher layer wins wholesale                |
| **deep-merge**      | JSON / YAML / TOML      | recursive merge (array policy configurable)|
| **patch**           | text                    | apply unified diff onto inherited file     |
| **append / prepend**| `.gitignore`, logs      | concatenate                                |
| **delete (tombstone)** | —                    | whiteout an inherited file                 |

Strategy is chosen three ways, in increasing power:

- **manifest globs** (`"merge"` block) — broad defaults.
- **filename suffix conventions** — discoverable one-off *sugar*:
  - `config.json.patch`   → apply diff onto inherited `config.json`
  - `.gitignore.append`   → append to inherited file
  - `config.json.delete`  → tombstone the inherited file
- **`.treelay` sidecar** — the canonical, full-power form (below). Suffixes
  desugar to a sidecar op; anything a suffix can express, a sidecar can too.

Array merge policy (`"arrays"`) defaults to **replace** — concat surprises people.

### The `.treelay` sidecar — canonical operation format

A `<targetPath>.treelay` file sitting beside where a file would land describes an
**operation on the inherited file**. It exists because filename suffixes can't
carry metadata — most importantly the **base** that §5's true 3-way merge
needs. YAML, so unified-diff payloads read cleanly as block scalars:

```yaml
# config.json.treelay   → operates on the inherited config.json
op: patch                # patch | merge | append | prepend | delete | replace
base: sha256:ab12…       # hash of the parent text this was authored against → drift detection
baseContent: |           # the parent text itself → enables true 3-way once it drifts (§5)
  {
    "name": "svc",
  }
when: "{{ useDocker }}"  # optional conditional (skip the op when false)
render: true             # render the payload/result with variables (§6)
patch: |
  @@ -2,3 +2,4 @@
     "name": "svc",
  +  "port": 3000,
```

```yaml
# package.json.treelay  → structured merge, no line-drift
op: merge
merge: { scripts: { build: "tsc" } }     # RFC 7386 JSON Merge Patch (or `jsonPatch:` for RFC 6902)
```

```yaml
# README.md.treelay     → remove an inherited file
op: delete
```

Division of power: a bare `*.patch` (no recorded base) is **best-effort apply**;
a sidecar `op: patch` carrying `baseContent` gets a **true 3-way merge**, and one
carrying only `base` gets honest drift detection in between (§5 spells out the
four cases). **Reflux (§8) auto-generates sidecars** with both fields baked in,
so hand-authoring is the exception, not the rule. (Sidecars are distinct from the
`.treelay/` *state directory*, which only ever exists in compiled destinations,
never in layers.)

### Never composed — built-in exclusions **[decided]**

Some paths are excluded from every layer's walk before any strategy applies —
an implicit tombstone that no manifest has to declare:

| Excluded | Why |
|---|---|
| `.git` (**file or directory**) | VCS metadata; see below |
| `node_modules/` | dependency install output, never template content |
| `.treelay/` | destination *state* dir (§7); only valid in an output |
| `treelay.{json,yaml,yml}` | the layer's own manifest, not payload |

**`.git` is excluded in both of its forms, and this matters.** A layer vendored
as a **git submodule** carries a `.git` *gitlink file* (`gitdir: …`) where a
normal clone has a directory. Composing either one publishes VCS metadata into
the output; the gitlink case is worse, because the compiled tree then looks to
git like a broken submodule pointing at a path that does not exist there. Only
the exact name `.git` is matched — `.gitignore` and `.gitmodules` are ordinary
content and compose normally.

This is deliberately *not* configurable. A layer that wants to ship VCS-adjacent
content can name it something else; there is no legitimate case for a compiled
instance inheriting its template's `.git`.

---

## 5. Patches & three-way merge **[decided]** ✅ *implemented*

Patches make this powerful *and* fragile: if a parent file changes, a child's
line-diff may no longer apply.

- **3-way merge with a recorded base.** A patch records the parent text it was
  authored against, so compile can reconstruct the author's intent
  (base → patched) and reconcile it against the drift the parent actually took
  (base → parent-now). Resolves cleanly far more often than a flat apply, and
  produces honest conflicts when it can't.
- **Structured patches for structured files.** JSON Merge Patch (RFC 7386) for
  simple cases, JSON Patch (RFC 6902) for precise array ops. No line-drift at
  all — prefer these for config.
- **Fail loud, never silent.** A patch that won't apply stops the build. Compile
  is all-or-nothing: nothing is materialized until every layer has merged, so a
  conflict leaves the destination untouched rather than half-written.

### `base` vs `baseContent` — why a hash is not enough

An earlier draft said the `base:` **hash** alone enabled a real 3-way merge. It
doesn't: a hash can prove the parent drifted, but it cannot reconstruct the
original text that diff3 needs as its merge base. The two fields split that job:

| Field | Carries | Buys you |
|---|---|---|
| `base:` | `sha256:…` of the authored-against parent | **drift detection** — cheap, and proves a clean apply when it still matches |
| `baseContent:` | the parent text itself | **true diff3** once the parent has moved on |

Compile picks its path accordingly:

1. **`baseContent` present** → true diff3. When `base` is also recorded it is
   verified against it; a mismatch means the sidecar contradicts itself and is
   rejected rather than trusted.
2. **`base` matches the inherited file** → no drift, so the file *is* the base;
   the patch is guaranteed to apply exactly.
3. **`base` no longer matches** → drift, with no way to reconstruct the original.
   Compile does *not* blindly apply a patch it knows was authored elsewhere: it
   relocates hunks that merely moved and fails loud on the rest.
4. **No `base` at all** (a bare `*.patch`) → best-effort apply, same as (3).

Reflux (§8) has the base text in hand when it generates a sidecar, so it records
both fields and case (1) is the norm for tool-authored patches; hand-authored
sidecars can record just the hash and still get honest drift detection.

### What "best-effort" actually recovers

Worth being precise, since it sets expectations for hand-authored patches:

- **Moved hunks** — recovered. The matcher searches for each hunk's location, so
  content added or removed *elsewhere* in the file doesn't break the patch.
- **Changed context** — rejected. If a line inside the hunk's context window
  changed, there is no safe way to guess, so it becomes a conflict. (A `fuzz`
  setting does not rescue this case; it only tolerates truncated leading/trailing
  context.) This is exactly the case `baseContent` upgrades to a clean merge:
  diff3 sees the two edits are separated by unchanged lines and takes both.
- **Overlapping edits** — conflict, including edits on *immediately adjacent*
  lines, which diff3 cannot order. Same rule git applies.

### Patch meets tombstone

A patch edits an inherited file, so it needs something to inherit — the `super()`
analogy of §1 holds:

- **tombstone above a patch** — the delete wins; the file is gone. (The patch ran
  at a lower layer; a later layer removing the file is a normal override.)
- **patch above a tombstone** — the patch has nothing to apply to and **fails
  loud**. It is not treated as a file-creating operation, because a patch that
  silently becomes "write this whole file" hides a real authoring mistake.
- **patch on a file no layer produces** — same failure, same reason.

---

## 6. Template variables **[decided]**

Layers declare variables; values are **merged and evaluated first**, then file
content is rendered with them. Variables compose across the inheritance graph,
which is what makes treelay's questionnaire fundamentally different from copier's
per-template, non-shared answers.

### The compile pipeline (where variables sit)

Ordering is the whole design. A compile runs:

1. **Resolve graph** (C3) → ordered layers (§3).
2. **Merge variable declarations** across the linearized stack → one schema.
   Declarations deep-merge per-key (parents C3 < mixins < self), so a child can
   override just a parent's `default` while keeping its `prompt`/`type`.
3. **Resolve values**, lowest → highest precedence:
   declared `default` → answers/values file(s) → interactive prompts → CLI
   `--set k=v` / env overrides.
4. **Evaluate computed variables** (`"computed": true`) in topological order;
   cycles are detected and fail loud.
5. **Render** each layer's file *names* and *contents* with the final value set.
6. **Merge** the rendered layers per-file (§4/§5) — i.e. **render-then-merge**.
7. **Drop conditional files** whose rendered name is empty.
8. **Materialize** to dest + persist answers and baseline (§7).

**Render-then-merge, not merge-then-render** — because a child's `.patch` is
authored against the parent's *rendered* output, and structured deep-merge needs
valid JSON/YAML on both sides, not template-y source. "Variables first, then
content" is exactly this ordering.

### Variable declaration

Mirrors copier's proven question set, but composed across layers:

```jsonc
"serviceName": {
  "type": "string",                  // string | number | boolean | json | yaml | path
  "prompt": "Service name?",          // omit → never prompted (pure default/computed)
  "default": "svc",                   // templatable: "{{ org }}-svc"
  "choices": ["a", "b"],              // optional enum (can be Jinja-dynamic)
  "when": "{{ useDocker }}",           // skip the question + value when false
  "validate": "...",                  // renders to "" if valid, else the error message
  "secret": true,                     // masked input; excluded from the persisted answers
  "computed": true                    // derived from other vars; never prompted
}
```

### What gets rendered — suffix opt-in **[decided]**

**Only files ending in `templateSuffix` (default `.tmpl`) are rendered**;
everything else is copied byte-for-byte. `config.json.tmpl` → renders →
`config.json`. This is copier's hard-won default, and the reason is collisions:
`{{ }}` is also GitHub Actions (`${{ }}`), Vue, Handlebars, Go templates… a
render-by-default tool would corrupt those files. Opt-in is the safe baseline; a
layer can set `"render": "all-text"` if it really wants render-by-default.

Suffix order: the template suffix is outermost — strip-and-render first, then the
inner merge suffix applies (`config.json.patch.tmpl` → render → treat as a
`.patch` against the inherited `config.json`).

### Engine & trust

Engine: **LiquidJS [decided]** — safe by design, very active, no arbitrary code
execution. Chosen over Nunjucks (most Jinja-familiar but a weaker sandbox) and
Eta (tiny/fast) because layers arrive as **third-party npm packages**: a template
that can run arbitrary code is a supply-chain hazard. Rendering runs with
filesystem/network access disabled — a template can only read the resolved
variable values, nothing else.

---

## 7. The living template — compile & update **[decided]**

This is the headline feature: a compiled project stays linked to its template
and can absorb template updates *after* it has been created and locally edited.

### Compile (template dir → destination dir)

```
treelay compile <srcDir> <destDir>
```

`srcDir` is the leaf overlay (the project template). It resolves parents/mixins
and writes the flattened result to `destDir`. The destination gets a state dir:

```
<destDir>/.treelay/
  lock.json          # resolved lineage + version refs at last compile
  answers.json       # resolved variable values (§6); secrets excluded
  baseline.json      # relative path → content hash of every generated file
  baseline/          # the generated content itself = the diff3 merge base
  manifest.json      # per file: generated-by-template | user-owned, + producing layer
```

**Why both a hash index and a content snapshot.** They answer different
questions. The hash cheaply decides *whether* a file changed, which is all the
first two merge cases below need. But a hash cannot reconstruct the text diff3
requires as its merge base, so "both sides changed" — the case the whole feature
exists for — needs the content itself. (Same lesson as `base` vs `baseContent`
in §5; a digest detects drift, it never reverses it.) The snapshot is replaced
wholesale on each write so files the template no longer produces cannot linger
as stale merge bases, and reads are verified against the recorded hash: a
snapshot that has fallen out of sync degrades to "no base available", which
surfaces as a conflict rather than a silently wrong merge.

`lock.json`'s lineage doubles as the pointer home — its last entry is the leaf,
which is how `treelay update <dest>` rediscovers the template it came from
without being told.

First compile = fresh instantiation. The baseline records "this is exactly what
the template produced *with these answers*," which is what later updates merge
against. Persisting `answers.json` is what makes re-rendering on update
deterministic (copier's `.copier-answers.yml`, but one file for the whole
composition rather than one per template).

#### Destinations inside the source tree **[decided]**

`destDir` may be **nested inside a layer** — compiling into a gitignored
`build/` within the source repo is a first-class, supported layout, not an
accident to be worked around. A destination that is a strict descendant of a
layer is pruned from that layer's walk, so a recompile never re-consumes its own
prior output. (The first compile is safe by construction — enumeration precedes
materialization — but the second would otherwise fold `build/` back in, and
again on the third, compounding each time.)

The degenerate case fails loud rather than silently eating its own sources:
`destDir` **equal to** a layer root is refused, because materializing over the
directory being read has no correct interpretation.

### Update (re-pull template changes into an edited project) ✅ *implemented*

```
treelay update <destDir> [--set k=v] [--on-conflict markers|rej] [--dry-run]
```

Update first reloads `answers.json`, prompts **only for variables the new
template version newly introduced** (existing answers are reused, not
re-asked), then recompiles. Three inputs, per file:

- **base**  = `.treelay/baseline` (template output at last compile)
- **ours**  = current working copy in `destDir` (user's edits)
- **theirs**= freshly recompiled template at the new version, same answers

Crucially, `theirs` is composed **in memory**. Recompiling onto the destination
would destroy the very edits the merge exists to preserve.

Per-file three-way merge:

- base == ours  → take theirs (user never touched it; accept update cleanly)
- base == theirs→ keep ours  (template unchanged; preserve user edits)
- both changed, mergeable → merge (structured merge for JSON/YAML; 3-way text merge otherwise)
- both changed, conflicting → surface for resolution (see below)
- file gone in theirs, unchanged in ours → delete it
- file gone in theirs, edited in ours → conflict (don't silently discard user work)
- file gone in ours, unchanged in theirs → stay deleted (a deletion is an edit too)
- file gone in ours, changed in theirs → conflict (don't silently resurrect it)
- file new in theirs, already present in ours → conflict (the user got there first)

**Text first, then structure.** For JSON/YAML the line merge is tried *before*
the structured one, because it preserves formatting and comments. Only when it
conflicts do we retry as merge patches, where two sides adding unrelated keys
compose cleanly however adjacent those keys happen to be — the `package.json`
case. The cost is reserialization, which is why it is the fallback and not the
default.

**Conflicts are written, not thrown.** Unlike compile (§5), which can safely
refuse to produce anything, `update` is editing a project that already exists —
doing nothing leaves the user stuck. So conflicts are reported in the plan and
materialized one of two ways:

- **`markers`** (default) — the merged file carries diff3 markers, *including the
  base section*, so you can see what the template previously produced rather than
  guessing why the two sides disagree.
- **`rej`** — the working file is left byte-identical and the incoming version
  lands at `<file>.rej`. For projects where a file must stay parseable (a
  committed lockfile, anything a pre-commit hook reads) markers are worse than
  useless.

Either way the *whole plan is computed before anything is written*, so a failure
partway through leaves the project exactly as it was — the same all-or-nothing
guarantee compile makes, applied to a tree that already has work in it.

The baseline is then rewritten to the new template output **unconditionally**,
including for conflicted files: "what the template last produced" is factually
`theirs` regardless of how each merge landed. This is what makes a repeated
update a no-op, and stops a conflict from being re-offered on every future run.

### Generated vs owned files

`.treelay/manifest.json` tracks which files the template is responsible for vs.
files the user added themselves. Update only governs generated files; user-owned
files are never touched. This is what stops `update` from clobbering the project.

---

## 8. Reflux / promotion — pushing instance edits back up **[decided]**

The mirror image of §7. `update` pulls template changes *down* into a project;
**reflux** pushes a project's local edits *up* into the inheritance graph. The
OOP analogue is exact: `compile` is instantiation, reflux is **"pull member up"**
— deciding an edit you made on the instance actually belongs on a superclass.
Together they make the template↔project link **bidirectional**.

treelay is unusually suited to this because per-file **provenance** is already
first-class (§10): the tool knows which layer produced each file, so it can
*suggest* where an edit belongs instead of making you pick blind — the
`git absorb` experience.

### Listing changes

Everything keys off `.treelay/baseline` (exactly what the template produced last
compile). The working copy diverges three ways: **modified** (hunks vs baseline),
**added** (user-owned, no template origin), **deleted** (tombstone candidate).

`treelay status` is `git status` *plus blame* — it annotates each change with the
layer that currently produces the file, because the useful question is "where
could this go," not just "what changed":

```
treelay status <dest>
  M  src/config.json      ← produced by @acme/node-base  (+ patched by with-ci)
  M  .eslintrc            ← produced by ../shared-eslint
  A  src/custom/thing.ts  ← local-only (no template origin)
  D  README.md            ← produced by @acme/service-base
```

### Dispositions — the menu per change

| Disposition | Meaning | OOP analogue |
|---|---|---|
| **Keep local**        | project-specific; never promote                       | instance field        |
| **Extract to new layer** | factor into a brand-new overlay (optionally a mixin) | extract superclass/trait |
| **Promote into parent/mixin** | push up into a *chosen existing* layer so siblings inherit it | pull member up |
| **Promote into self** | bake into the leaf template itself                    | edit the class directly |

The interactive flow is `git add -p` where the staging question is *"where does
this belong?"* rather than yes/no.

### Granularity

- **File-level** — promote whole files. Predictable; the v1 target.
- **Hunk-level** — a single file's edits split across targets (the `git absorb`
  power-move). Real jump in complexity; **v2**. **[open]**

### How a promoted change lands in the target layer

Chosen automatically by what the target layer already does with the file:

| Situation at target L | Mode | What lands |
|---|---|---|
| L already produces the file | **rewrite** | L's *own source file* is rewritten in place |
| a *lower* layer produces it, L does not | **patch** | a sidecar in L carrying only the delta |
| no layer produces it (locally added) | **create** | the file, dropped into L |
| the change is a deletion | **tombstone** | L's source removed if it is the sole producer, else an `op: delete` sidecar |

Two details matter more than they look:

- **Rewrite reuses the layer's existing source path.** If L produces `config.json`
  from `config.json.tmpl`, the rewrite goes back into the `.tmpl` — writing a
  plain `config.json` beside it would leave the layer producing the same path
  twice. The consequence is the one §8 already documents under
  "reflux meets variables": the promoted file stops being parametric. Round-trip
  verification is what makes that safe to do by default — if baking the rendered
  values in changes the output, the promotion fails rather than quietly
  de-templating the layer.
- **Patch mode records both `base` and `baseContent` (§5).** Reflux composes the
  sub-stack *below* L to obtain the exact inherited text, so it always has the
  base in hand and never has to emit the weaker hash-only form. Structured files
  get an RFC 7386 merge patch instead of a line diff.

### Why guard 1 refuses so little

Guard 1 (shadowing) fires only on a **wholesale** override above the target — a
higher layer that creates, replaces, or deletes the same path. Partial actions
(deep-merge, append, prepend, patch) are deliberately *not* treated as shadowing,
even though they can also stop a promotion from reproducing.

The split is about the quality of the answer. A wholesale override is provably
futile and can be named precisely: *"with-ci overrides this file; promote there
instead."* Whether a *partial* transform preserves the promoted bytes depends on
merge order, array policy, and re-rendering — questions a static check can only
guess at. Rather than guess, those fall to guard 2, which recompiles and simply
looks. The result is that guard 1 never produces a false refusal, and guard 2
never lets a bad promotion through; a failure there rolls the layer writes back
through an undo log, because a half-written layer would be picked up by the very
next compile.

**Layer writability — three tiers, not two:**

- **Writable in place** — local paths and monorepo packages. Edited directly.
- **Writable via a clone** — **git layers** (below). A git ref is a real repo
  with a push target, so reflux *can* land there — it just commits instead of
  rewriting a file on disk.
- **Truly read-only** — npm-package layers resolved as tarballs in
  `node_modules`. No upstream working tree to commit to; the tool falls back to
  "capture as a patch in a writable layer above it" and says so rather than
  failing silently.

### Committing reflux back to a git layer **[decided]**

A git-referenced layer (`github:acme/base#…`) is a first-class promotion target,
not a read-only one. The mechanics differ from a local path only at the end:

- **Mutable clone, not the resolved snapshot.** The snapshot pulled for *compile*
  is detached and unsuitable for writing. Promotion operates on a real working
  clone in a treelay cache (`~/.treelay/git/<repo>/`), shelling out to the user's
  configured `git` so SSH/credential-helper auth is respected — treelay never
  handles tokens itself.
- **Promote onto a branch, never a pinned ref.** A layer pinned to a tag or SHA
  is immovable by definition, so git promotion *requires* a target branch and
  refuses a detached/tag ref with an explanation. On success the project's own
  reference and `treelay.lock` are rewritten to the new commit — otherwise the
  project stays pinned to the old ref and would never see the change it just
  promoted.
- **Landing mode is the user's call, per promote.** The interactive flow offers,
  for each git promotion: **commit on a branch** (nothing leaves the machine),
  **commit + push** (branch only, never the pinned/default ref), or **commit +
  open a PR** (via `gh`/`glab` when available). Non-interactive runs
  (`--no-prompt`) default to the most conservative — local commit on a branch —
  and require an explicit flag to push or PR.
- **Round-trip verification still gates the commit (§8 guard 2).** After
  committing, re-resolve the layer at the new commit, recompile, and assert
  byte-identity. If it doesn't reproduce, the commit is rolled back
  (`git reset --hard`) — never left dangling.
- **Blast radius is maximal (§8 guard 3).** A pushed git layer reaches *every*
  consumer everywhere, and a push is far harder to walk back than editing a
  sibling directory. The warning is louder, and push/PR is always a deliberate,
  separately-confirmed step.

### The three guards (where reflux earns its keep)

1. **Precedence shadowing.** If you promote to `parent X` but `mixin Y` overrides
   the same file higher up, the change vanishes on recompile. The tool detects
   this from the resolved stack and refuses: *"Promoting to node-base has no
   effect; with-ci overrides this file. Promote to with-ci or self instead."*
2. **Round-trip verification.** After any promote/extract, **recompile and assert
   the working copy is byte-identical.** If the change doesn't reproduce (merge
   order interactions), fail loud. This is what makes reflux trustworthy.
3. **Blast radius.** Promoting up reaches *every sibling* inheriting that layer —
   the intent, but a footgun. Warn: *"node-base is consumed by 6 projects; this
   edit reaches all of them on their next update."*

After a verified promote, `.treelay/baseline` is rewritten so the change counts
as "from template" and drops off the local-changes list — it now flows down by
inheritance instead of being a local override.

### Reflux meets variables (the hard interaction) **[open]**

The working copy lives in **rendered** space; layers live in **template** space.
Promoting a rendered edit up therefore has a representation problem: the literal
text `port: 3000` in the project may have come from `port: {{ port }}` in a
layer. Default behavior: **store the promoted content literally** (rendered
values baked in) — correct and predictable, but the promoted file stops being
parametric in that layer. Optional **assisted re-templatization** can substitute
known variable *values* back to `{{ var }}` references, gated behind explicit
review (fragile when a value is a short/common string like `"1"` or `"true"`).
Round-trip verification (§8 guard 2) still applies — it re-renders the target
layer with the persisted answers and asserts byte-identity. Granularity of the
re-templatization assist is **[open]**.

---

## 9. CLI surface

```
treelay compile <src> <dest> [--set k=v] [--answers f] [--no-prompt]
                               # materialize template → destination (first run = instantiate)
treelay update  <dest> [--set k=v]   # re-render with saved answers (prompt only new vars) + 3-way merge
treelay status  <dest> [--json]  # list changes vs baseline, annotated with producing layer
treelay diff    <dest|a> [b]   # working-vs-baseline hunks, or layer-vs-layer
treelay promote <dest> [files...] [--to <layer>] [--dry-run] [--no-verify]
                               # push edits up; auto-suggests --to from provenance
                               # git targets: [--branch <name>] [--push] [--pr]
                               #   (commit-on-branch only unless --push/--pr given)
treelay extract <dest> [files...] --as <path> [--mixin] [--name <n>]
                               # capture edits as a NEW overlay layer
treelay lock    [dir] [--check] [--update] [--drift]
                               # resolve every layer ref and pin it in treelay.lock
                               #   --check  verify it is complete + current (CI), write nothing
                               #   --update advance moving refs to their current revision
                               #   --drift  report refs whose upstream has moved (network)
treelay plan    [dir]          # print linearized layer order + per-file resolution; write nothing
treelay explain <dir> [file] [--set k=v] [--answers f] [--json]
                               # trace which layers touched a file, in order, with patches
                               # <dir> = a source layer, or a compiled destination
                               # omit [file] to explain every path in the composition
treelay validate [dir]         # cycles? patches apply? unresolved conflicts? drift vs lock?
treelay watch   <src> <dest>   # recompile on change
treelay eject   <dest>         # flatten + drop .treelay state (sever the template link)
```

`promote` and `extract` always end with the §8 round-trip recompile-and-verify,
and both refuse read-only or shadowed targets with a clear explanation.

`compile`, `update` and `plan` all accept `--frozen-lockfile` (§3).

`plan` and `explain` are not nice-to-haves — they are the debugging story for a
system whose entire job is "this file came from somewhere non-obvious." Build
`plan` before `compile`.

---

## 10. Programmatic API

The CLI is a thin shell over a library (people will want this in build tools):

```ts
const graph  = await resolve(srcDir, { frozen, updateRefs, noLock, cacheDir });
// linearized layers + provenance, no output I/O
// graph.variables = merged declaration schema across all layers (§6)
// graph.lock / lockDirty / lockDir = pins resolved in memory (§3). Resolution
//   never writes: `explain` must not have a lockfile as a side effect, so the
//   caller that owns the source tree persists it.
writeLock(graph.lockDir, graph.lock);          // what `treelay lock` does
const drift = checkDrift(graph);               // [{ ref, requested, locked, current, status }]

const values = await resolveValues(graph, { answers, set, prompt });  // §6 steps 3–4
const result = await compile(graph, { destDir, values });
// result.files[path] = { fromLayer, strategy, patchedFrom, owned }  ← powers `explain`

const why  = await explain(graph, { values });  // no output I/O; read-only provenance
// why.layers    = [{ id, name, role: parent|mixin|self, position, writable }]
// why.files[p]  = { contributions[], present, winner, strategy, patchedFrom }
//   winner/strategy/patchedFrom mirror result.files[p] exactly (asserted by test)
const dest = await explainDest(destDir);        // re-explains from lockfile lineage + saved answers

const plan   = await planUpdate(destDir);      // dry-run 3-way, returns clean/conflict per file
await update(destDir, { onConflict: "markers" });  // reuses saved answers, prompts only new vars

const changes = await status(destDir);         // per file: kind (M/A/D) + producing layer + targets
// changes[i].targets already excludes layers a higher layer would shadow

const promoted = await promote(destDir, changes, { to: layerRef, verify: true });
// throws on a read-only or shadowed target, or a failed round-trip (writes rolled back)
// promoted.landed[i] = { path, mode: rewrite|patch|create|tombstone, wrote }
// promoted.blastRadius = { dependents[], destinations[] }  ← §8 guard 3

const created = await extract(destDir, changes, { as: path, asMixin: true });
// created.wired === false ⇒ not in the graph yet, so nothing was verified or rebaselined

// The guards are reusable on their own:
const check = await roundTripVerify(destDir, graph, values);   // { ok, mismatches, composed }
const reach = blastRadius(layerDir, { searchRoot });           // who else consumes this layer
```

---

## 11. Open decisions

- **Array merge default** — `replace` proposed; revisit if config use cases want `by-key`. **[open]**
- **What's tracked** — contents always; modes + symlinks proposed yes; empty dirs only via `.keep`. **[open]**
- **Conflict UX** — **[decided]**, split by direction. For **compile**: fail the
  build, write nothing (§5) — a template that can't compose has no partial output
  worth keeping. For **update**: write the conflict, since refusing to act on a
  project that already exists just leaves the user stuck. Both presentations ship
  because neither dominates — inline `markers` (diff3 style, base section shown)
  by default, `rej` sidecars when a file has to stay parseable (§7). An
  interactive resolver is deferred; it composes on top of either mode rather
  than replacing them.
- **Reflux granularity** — file-level for v1; hunk-level splitting + auto-`absorb` routing deferred to v2. **[open]**
- **Template engine** — **LiquidJS [decided]** (safe, sandboxed; over Nunjucks/Eta) — see §6.
- **Reflux re-templatization** — store promoted edits literally vs assisted value→`{{ var }}` substitution (§8). **[open]**
- **Git layer write-back** — git layers are writable via a working clone; reflux commits onto a branch (never a pinned ref), landing mode (commit / push / PR) chosen per promote, lockfile + project ref advanced on success. **[decided]** (§8)
- **Template variables** — interpolate values, merged across the graph, suffix opt-in rendering. **[decided]** (§6)
- **Layer refs & pinning** — three origins by shape, `?path=` subdirs, mounts at the
  bottom of the stack, deterministic `treelay.lock`, drift reported not followed.
  **[decided]** (§2, §3)
- **npm pins are recorded, not enforced** — installation stays the package
  manager's job; git pins *are* enforced from treelay's own cache. **[decided]** (§3)
- **Reflux into mounted layers** — a mount's output paths carry a prefix its
  sources do not, so promotion into one needs a path mapping that does not exist
  yet; read-only for now. **[open]**
- **Virtual/FUSE mode** — deferred; materialize-first is **[decided]**. Revisit later for dev loops.

---

## 12. MVP build order

De-risk by building resolution first, then output, then the bidirectional loops:

1. ✅ Manifest parsing + C3 resolution + `plan`     ← the risky core, visible early
2. ✅ `replace` / `deep-merge` / tombstone strategies (+ append/prepend, sidecar `merge`)
3. ✅ `compile` to a destination (fresh instantiation + `.treelay` state)
4. ✅ Variable schema merge + value resolution + suffix-opt-in rendering (§6)
5. ✅ Unified-diff patches with 3-way merge (`.patch` suffix, sidecar `op: patch`, `patch` merge glob)
6. ✅ `update` — the living-template three-way loop, reusing saved answers (pulls *down*)
7. ✅ `explain` — per-file provenance (source layers or a compiled destination; `--json`)
8. ✅ `status` + file-level `promote` / `extract` — reflux (pushes changes *up*)
9. ✅ npm/git layer resolution + `mounts` + `treelay.lock` (pins, drift, `--frozen-lockfile`)
10. `watch` / `eject`  ← next

Demoable and trustworthy after step 3; templated scaffolding works at step 4;
the headline pull-down lands at step 6, and the bidirectional link closes at
step 8.
