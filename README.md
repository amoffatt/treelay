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
> with rendering, deep-merge, sidecar/suffix ops, and `.treelay` state. The
> bidirectional loop (`update`/`promote`) and unified-diff patches are the next
> stubs in the SPEC §12 build order.

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
- **`.treelay` sidecars** — the canonical operation format carrying strategy, a
  recorded base hash (for true 3-way), and the patch payload.
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
treelay explain <dir> <file>   # trace a file's provenance
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup → dist/
```

## License

MIT
