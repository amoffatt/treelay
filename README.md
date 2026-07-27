# treelay

An inheritance/composition system for directory trees — think `extends`/mixins
for the filesystem. A directory declares inheritance **parents** and **mixins**;
`treelay compile` resolves the whole graph and materializes a flat output
directory. The output stays **linked** to its template, so template changes can
be pulled into an already-created, already-edited project (`update`), and local
edits can be pushed back up into the layers they belong to (`promote`).

> **Status: early, working.** The architecture and full design are specified in
> [SPEC.md](./SPEC.md). Resolution (C3), value resolution, **`compile`**, and
> **`update`** are implemented and tested — you can materialize a real, composed
> project today and then pull template changes back into it after you have edited
> it, with rendering, deep-merge, append/prepend, tombstones, sidecar/suffix ops,
> **unified-diff patches with true 3-way merge**, `.treelay` state, and
> **`explain`** for tracing where any file came from. Remaining per SPEC §12: npm
> and git layer refs, `watch`, and `eject`.

## Why not just OverlayFS / copier / Kustomize?

- **OverlayFS** is a runtime union *mount* (Linux, root, ephemeral). treelay is a
  build-time *compiler* producing plain, portable files.
- **copier** does the living-template update loop, but has no inheritance or
  mixins — each template keeps an isolated answers file. treelay composes a graph
  of parents + mixins (C3-linearized) with **one merged questionnaire**.
- **Kustomize** does structured patch composition, but only for Kubernetes YAML
  and with throwaway output. treelay works on arbitrary file trees and keeps the
  link alive.

See [SPEC.md §1](./SPEC.md) for the full comparison.

## Core ideas

- **Composition graph** — `parents` (transitive, C3-linearized) and `mixins`,
  with precedence `parents < mixins < self`.
- **Per-file merge** — replace, deep-merge (JSON/YAML), 3-way text patch,
  structured patch (RFC 7386/6902), append/prepend, tombstone delete.
- **`.treelay` sidecars** — the canonical operation format carrying strategy, the
  recorded base (hash for drift detection, content for a true 3-way), and the
  patch payload. A patch that can't be reconciled fails the build rather than
  writing something half-merged.
- **Template variables** — declared across the graph and merged first, then
  content is rendered (LiquidJS, sandboxed). Suffix opt-in (`*.tmpl`).
- **Two-way link** — `update` pulls template changes down; `promote`/`extract`
  push instance edits up.
- **Living updates** — `update` merges the new template output against what it
  produced last time and what you have since edited. Your changes survive; files
  you never touched advance cleanly; genuine collisions surface as conflicts
  rather than being guessed at.

## CLI

```
treelay compile <src> <dest>   # materialize template → destination
treelay update  <dest>         # pull template changes down (3-way merge)
                               #   --on-conflict markers|rej  --dry-run
treelay status  <dest>         # list local changes vs baseline
treelay promote <dest> --to <layer>   # push edits up into a layer
treelay extract <dest> --as <path>    # capture edits as a new layer
treelay plan    [dir]          # print the linearized layer order
treelay explain <dir> [file]   # trace file provenance (--json for machine output)
```

### Pulling template changes into a project you've edited

This is the headline: a compiled project stays linked to its template, so the
template can keep evolving after the project exists.

```console
$ treelay update ./my-service
New variables: region
  U  .github/workflows/ci.yml      # you never touched it — updated cleanly
  M  pipeline.yml                  # both changed, merged
  D  legacy.cfg                    # template dropped it, you hadn't edited it
  … 2 file(s) with local edits left as-is.
```

Update reloads the answers it was built with and asks **only** about variables
the new template version introduced. Files you created yourself are never
touched. Genuine collisions are reported and written as conflicts rather than
guessed at — and `update` exits non-zero so CI notices:

```console
$ treelay update ./my-service --on-conflict rej
  C  pipeline.yml  ← conflict

1 conflict(s). Your files are unchanged; incoming versions are in *.rej.
```

`--on-conflict markers` (the default) writes diff3 markers in place, including
the base section so you can see what the template *used* to produce. `rej` keeps
the working file byte-identical and drops the incoming version at `<file>.rej` —
use it when a file has to stay parseable. `--dry-run` shows the plan and writes
nothing.

Run it twice and the second run is a no-op; the baseline advances to whatever
the template produced, so a conflict is never re-offered once you've dealt with
it.

### Tracing where a file came from

`explain` is the debugging story for a system whose whole job is "this file came
from somewhere non-obvious." Point it at a source layer or a compiled
destination; omit the file to explain the entire composition.

```console
$ treelay explain ./my-service src/config.json
Layers (lowest → highest precedence):
  1. @acme/node-base  (parent)
  2. with-ci  (mixin)
  3. my-service  (self)

src/config.json  ← with-ci (deep-merge)
  1. @acme/node-base    parent  create      src/config.json
  2. with-ci            mixin   deep-merge  src/config.json
  3. my-service         self    merge       src/config.json.treelay  [sidecar, base sha256:ab12cd3…]
  folded in: @acme/node-base, sidecar
```

Layers that cannot be written to — npm/git parents, once those land — are
tagged `[read-only]`, which is what filters them out as promotion targets (§8).

A compiled destination explains itself — it reconstructs its own graph from the
lockfile lineage and re-renders with the answers it was built with:

```console
$ treelay explain ./build --json | jq '.files["src/config.json"].winner'
```

Notes on behaviour worth knowing:

- **Tombstoned files still appear**, marked not-present, so you can see *what*
  deleted them rather than just finding them missing.
- **A patch that cannot be applied is described, not thrown on** — `explain`
  stays usable precisely when `compile` is failing.
- `winner`/`strategy`/`patchedFrom` mirror what `compile` records, and a test
  asserts the two agree so they cannot drift apart.

### Composition rules worth knowing

- **`.git` is never composed**, in either form — a real directory *or* the
  gitlink *file* that a git submodule checkout carries. Layers vendored as
  submodules are safe to compose; `.gitignore`/`.gitmodules` are ordinary
  content and compose normally. (SPEC §4)
- **The destination may live inside the source tree.** Compiling into a
  gitignored `build/` within the source repo is supported: the destination is
  pruned from the layer walk, so recompiles never re-consume their own output.
  A destination *equal to* a layer root is refused. (SPEC §7)

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup → dist/
```

## License

MIT
