# treelay

An inheritance/composition system for directory trees — think `extends`/mixins
for the filesystem. A directory declares inheritance **parents** and **mixins**;
`treelay compile` resolves the whole graph and materializes a flat output
directory. The output stays **linked** to its template, so template changes can
be pulled into an already-created, already-edited project (`update`), and local
edits can be pushed back up into the layers they belong to (`promote`).

> **Status: early, working — the link is bidirectional and layers are
> distributable.** The architecture and full design are specified in
> [SPEC.md](./SPEC.md). Resolution (C3), value resolution, **`compile`**,
> **`update`** (pulls template changes *down*) and **`status`/`promote`/`extract`**
> (push local edits *up*) are implemented and tested, with rendering, deep-merge,
> append/prepend, tombstones, sidecar/suffix ops, **unified-diff patches with true
> 3-way merge**, `.treelay` state, **`explain`** for tracing where any file came
> from, and **git/npm layer refs pinned in `treelay.lock`** with vendored
> `mounts` and drift detection. Remaining per SPEC §12: `watch` and `eject`.

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
  with precedence `mounts < parents < mixins < self`.
- **Distributable layers** — a parent, mixin or mount can be a local path, a git
  ref, or an npm package. Whatever a build resolves is pinned in `treelay.lock`,
  so the next build reproduces it and an upstream that has moved is *reported*
  rather than silently followed.
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
treelay status  <dest>         # list local changes vs baseline (--json)
treelay promote <dest> [files...] --to <layer>   # push edits up into a layer
                               #   --dry-run  --no-verify
treelay extract <dest> [files...] --as <path>    # capture edits as a new layer
                               #   --mixin  --name
treelay lock    [dir]          # resolve every layer ref and pin it
                               #   --check  --update  --drift
treelay plan    [dir]          # print the linearized layer order
treelay explain <dir> [file]   # trace file provenance (--json for machine output)
```

`compile`, `update` and `plan` also take `--frozen-lockfile`.

### Layers from git and npm, pinned

A parent, mixin or mount can live anywhere. The three forms are told apart by
shape, so nothing has to be declared twice:

```jsonc
{
  "parents": ["../core", "@acme/node-base@^2", "github:acme/base#v2"],
  "mounts":  { "packages": "git+https://host/acme/packages.git#v1.2.0" }
}
```

Add `?path=core/_layer` to any non-local ref to use a subdirectory of the
fetched tree as the layer root.

**`mounts` vendor a whole tree into the output** at a fixed subpath. Mount paths
merge by ordinary layer precedence, which is the point: a leaf can hold
`packages/` back at an older pin while its parents float, using the same
override rule as everything else rather than a separate package mechanism.

```console
$ treelay plan klamath/project/_layer
Layers (lowest → highest precedence):
  1. mount:packages  [mounted at packages/, pinned 64cf108ee311]
  2. core
  3. project
```

Whatever gets materialized is pinned in `treelay.lock` beside the leaf manifest
— canonical ref → exact commit (or version) plus an integrity hash over the
tree. It is deterministically serialized, so re-resolving an unchanged tree
produces byte-identical output and never shows up in a diff.

```console
$ treelay lock . --check      # CI: is the lockfile complete and current?
$ treelay lock . --drift      # has anything moved upstream? (exits 1 if so)
1 ref(s) have moved upstream since treelay.lock was written:
  git+https://host/acme/packages.git#v1.2.0
    pinned  64cf108ee311
    v1.2.0 is now  3991f53a3bf4  (packages/)
This build used the pinned revisions. Run `treelay lock --update` to advance them.
```

**Drift is reported, never followed.** `compile` and `update` keep producing the
locked revision even after a branch advances — that is what pinning means, and
an update that quietly recomposed at a newer commit would make "pull my
template's changes down" mean something different depending on the day.
`treelay lock --update` is the only thing that advances a pin, and
`--frozen-lockfile` refuses to resolve anything the lock does not already pin.

Two asymmetries worth knowing:

- **Git pins are enforced; npm pins are recorded.** treelay materializes a git
  commit from its own cache, so a build reproduces regardless of the branch. npm
  layers resolve through the installed `node_modules` — treelay checks the
  version satisfies the range and records it, but installation stays your
  package manager's job. Rolling one back is `npm ci`'s job, not treelay's.
- **Offline means *unknown*, not *unchanged*.** A drift probe that could not
  reach the remote says so rather than reporting in sync.

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

Layers that cannot be written to — fetched git/npm layers, and mounts — are
tagged `[read-only]`, which is what filters them out as promotion targets (§8).
Fetched layers also show the revision in use, so `explain` answers "which
version of the base am I actually on?" without a second command.

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

### Pushing an edit back up (reflux)

The mirror image of `update`. You edited a file in the compiled project and
realised it belongs in a layer, so every sibling project gets it too. `status`
is `git status` plus blame — it tells you not just what changed but where it
could go:

```console
$ treelay status ./out
  A  extra.ts   ← local-only (no template origin)
  M  notes.txt  ← produced by @acme/base

$ treelay promote ./out notes.txt --to @acme/base
Promoted into @acme/base:
  rewrite   notes.txt  → notes.txt
Round-trip verified: the destination reproduces from the template.

@acme/base is consumed beyond this project — 1 other layer inherits it. This edit reaches all of them on their next update.
```

After a verified promote the change flows down by inheritance, so it stops
showing up as local drift — `status` now lists only `extra.ts`.

**Three guards stand between you and a bad promotion:**

1. **Shadowing** — promoting somewhere a higher layer would override is refused,
   with the layer to use instead:
   ```console
   $ treelay promote ./out a.txt --to base
   Promoting a.txt to base has no effect; with-ci overrides this file at a higher precedence.
   Promote to with-ci or to the leaf instead (§8 guard 1).
   ```
2. **Round-trip verification** — after writing, treelay recompiles and asserts
   the destination reproduces byte-for-byte. If it doesn't, the layer writes are
   rolled back and nothing is left half-applied. Pass `--no-verify` to skip it.
3. **Blast radius** — promoting reaches every sibling layer and every compiled
   destination downstream of the target. That reach is reported (on stderr)
   rather than left for someone else to discover on their next `update`.

Where the change lands is chosen for you: a layer that already produces the file
gets its **source rewritten**; a layer above the producer gets a **sidecar with
only the delta** (recording both `base` and `baseContent`, so it still merges
cleanly after the parent drifts); a locally-added file is **created**; a deletion
becomes a **tombstone**.

`extract` does the same thing into a brand-new layer:

```console
$ treelay extract ./out a.txt --as ../house-style --mixin
Extracted 1 file(s) → /work/house-style
  a.txt
Wired in as a mixin of the leaf; round-trip verified.
```

Without `--mixin` the layer is created but left out of the graph — treelay says
so and deliberately skips verification and rebaselining, because the edits are
still local until you wire it in.

### Composition rules worth knowing

- **`.git` is never composed**, in either form — a real directory *or* the
  gitlink *file* that a git submodule checkout carries. Layers vendored as
  submodules are safe to compose; `.gitignore`/`.gitmodules` are ordinary
  content and compose normally. (SPEC §4)
- **`treelay.lock` never composes.** Like the manifest, it is layer metadata,
  not content — otherwise a layer's pins would be published into every tree
  built from it, and the leaf's own lockfile would show up as a generated file
  that `update` reports as changed.
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
