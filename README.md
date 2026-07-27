# treelay

An inheritance/composition system for directory trees — think `extends`/mixins
for the filesystem. A directory declares inheritance **parents** and **mixins**;
`treelay compile` resolves the whole graph and materializes a flat output
directory. The output stays **linked** to its template, so template changes can
be pulled into an already-created, already-edited project (`update`), and local
edits can be pushed back up into the layers they belong to (`promote`).

> **Status: early, working.** The architecture and full design are specified in
> [SPEC.md](./SPEC.md). Resolution (C3), value resolution, and **`compile`** are
> implemented and tested — you can materialize a real, composed project today,
> with rendering, deep-merge, append/prepend, tombstones, sidecar/suffix ops,
> **unified-diff patches with true 3-way merge**, `.treelay` state, and
> **`explain`** for tracing where any file came from. The bidirectional loop
> (`update` down, `promote`/`extract` up) is the next stub in the SPEC §12
> build order.

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

## CLI (planned surface)

```
treelay compile <src> <dest>   # materialize template → destination
treelay update  <dest>         # pull template changes down (3-way merge)
treelay status  <dest>         # list local changes vs baseline
treelay promote <dest> --to <layer>   # push edits up into a layer
treelay extract <dest> --as <path>    # capture edits as a new layer
treelay plan    [dir]          # print the linearized layer order
treelay explain <dir> [file]   # trace file provenance (--json for machine output)
```

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
