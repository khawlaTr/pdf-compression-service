#!/usr/bin/env python3
"""Lossless structural optimization of a PDF.

Two effects, neither of which touches image quality:

1. Deduplication — documents produced by merging engines (SAP NetWeaver PDF
   Merger in the case this was built for) carry one private copy of every
   shared resource per merged sub-document: the same content streams, border
   and frame Form XObjects, logos, fonts, repeated hundreds of times. Every
   reference to a byte-identical object is repointed at a single copy.

2. Re-serialization with object streams and stream compression (libqpdf, via
   pikepdf), which also drops unreferenced objects. Generator output is often
   stored with little or no compression, so this alone is worth a lot.

Measured on a real 261-page, 15.7 MB SAP-merged invoice: 15.7 MB -> 2.4 MB,
decoded page content byte-identical on all 261 pages. On a 111 MB merge of
the same document: 111 MB -> 2.5 MB in ~3 min, where Ghostscript at its most
aggressive settings (grayscale, 24 DPI) plateaued at 10.5 MB in ~5 min.

Large documents are processed in page-range chunks. Peak memory follows the
size of a chunk rather than of the document: measured 185 MB peak on a 224 MB
/ 3000 page file, against roughly 2.6 GB for the same file processed whole
(pikepdf holds an object graph proportional to what gets touched, and the
dedup pass touches everything). Chunks are optimized independently, then
reassembled and passed once more so duplicates spanning chunk boundaries
collapse too — cheap by then, since the merged file is already far smaller.

Usage: optimize_structure.py <input.pdf> <output.pdf>
Env: STRUCTURE_CHUNK_PAGES (default 250), STRUCTURE_CHUNK_ABOVE_BYTES (30 MB)
Prints JSON to stdout: {"dedupedReferences": N, "sizeBefore": B, "sizeAfter": A, "chunks": C}
"""
import os
import sys
import json
import time
import shutil
import hashlib
import multiprocessing
import tempfile

import pikepdf

# Deep enough to resolve /Resources graphs, bounded so a pathological document
# can't send this into a very long walk.
MAX_FINGERPRINT_DEPTH = 20


def fingerprint(obj, cache):
    """Canonical identity of an object, following indirect references.

    Two objects with equal fingerprints render identically, so either can
    replace the other. References are resolved rather than compared by object
    id, so e.g. two Form XObjects whose /Resources point at distinct but
    identical dictionaries still match.

    `cache` memoizes per indirect object. Without it the same shared
    sub-graphs (/Resources and everything under them) get re-walked once per
    referencing object, which on a merged SAP document means hundreds of
    thousands of redundant traversals.
    """
    digest, _unstable = _fingerprint(obj, 0, set(), cache)
    return digest


def _fingerprint(obj, depth, in_progress, cache):
    """Returns (digest, unstable).

    `unstable` marks a result that depended on where the traversal started —
    a cycle or the depth cut-off — and therefore must not be memoized.
    """
    if depth > MAX_FINGERPRINT_DEPTH:
        return 'depth-limit', True

    objgen = getattr(obj, 'objgen', None)
    indirect = bool(objgen and objgen != (0, 0))

    if indirect:
        cached = cache.get(objgen)
        if cached is not None:
            return cached, False
        if objgen in in_progress:
            # Position-independent on purpose: including the object id here
            # would give every copy of an identical structure a different
            # fingerprint as soon as it contains a back-reference, which
            # /Resources graphs routinely do.
            return 'cycle', True
        in_progress.add(objgen)

    try:
        h = hashlib.sha256()
        unstable = False

        if isinstance(obj, pikepdf.Stream):
            h.update(b'stream:')
            h.update(obj.read_raw_bytes())
            for key in sorted(str(k) for k in obj.keys()):
                if key == '/Length':
                    continue
                child, child_unstable = _fingerprint(obj[key], depth + 1, in_progress, cache)
                unstable = unstable or child_unstable
                h.update(key.encode())
                h.update(child.encode())
            digest = h.hexdigest()
        elif isinstance(obj, pikepdf.Dictionary):
            h.update(b'dict:')
            for key in sorted(str(k) for k in obj.keys()):
                child, child_unstable = _fingerprint(obj[key], depth + 1, in_progress, cache)
                unstable = unstable or child_unstable
                h.update(key.encode())
                h.update(child.encode())
            digest = h.hexdigest()
        elif isinstance(obj, pikepdf.Array):
            h.update(b'array:')
            for item in obj:
                child, child_unstable = _fingerprint(item, depth + 1, in_progress, cache)
                unstable = unstable or child_unstable
                h.update(child.encode())
            digest = h.hexdigest()
        else:
            digest, unstable = 'scalar:' + repr(obj), False

        if indirect and not unstable:
            cache[objgen] = digest
        return digest, unstable
    finally:
        if indirect:
            in_progress.discard(objgen)


def deduplicate(pdf):
    """Repoint every reference to a duplicated stream at one canonical copy."""
    canonical = {}
    replacement = {}
    cache = {}

    # Single pass, keeping no list of stream wrappers: one Python wrapper per
    # stream is a real memory cost on documents with hundreds of thousands of
    # objects.
    for obj in pdf.objects:
        if not isinstance(obj, pikepdf.Stream):
            continue
        objgen = getattr(obj, 'objgen', None)
        if not objgen or objgen == (0, 0):
            continue
        fp = fingerprint(obj, cache)
        keeper = canonical.get(fp)
        if keeper is None:
            canonical[fp] = obj
        elif keeper.objgen != objgen:
            replacement[objgen] = keeper

    if not replacement:
        return 0

    # Rewiring has to descend into direct (inline) dictionaries and arrays:
    # most references live nested inside them (/Resources -> /XObject -> ref),
    # and visiting only top-level indirect objects misses nearly all of them.
    rewired = 0
    visited = set()

    def rewire(container):
        nonlocal rewired
        objgen = getattr(container, 'objgen', None)
        if objgen and objgen != (0, 0):
            if objgen in visited:
                return
            visited.add(objgen)

        if isinstance(container, (pikepdf.Dictionary, pikepdf.Stream)):
            for key in list(container.keys()):
                try:
                    value = container[key]
                except Exception:
                    continue
                vg = getattr(value, 'objgen', None)
                if vg and vg in replacement:
                    container[key] = replacement[vg]
                    rewired += 1
                elif isinstance(value, (pikepdf.Dictionary, pikepdf.Array, pikepdf.Stream)):
                    rewire(value)
        elif isinstance(container, pikepdf.Array):
            for i in range(len(container)):
                try:
                    value = container[i]
                except Exception:
                    continue
                vg = getattr(value, 'objgen', None)
                if vg and vg in replacement:
                    container[i] = replacement[vg]
                    rewired += 1
                elif isinstance(value, (pikepdf.Dictionary, pikepdf.Array, pikepdf.Stream)):
                    rewire(value)

    rewire(pdf.Root)
    rewire(pdf.trailer)
    for obj in pdf.objects:
        if isinstance(obj, (pikepdf.Dictionary, pikepdf.Array, pikepdf.Stream)):
            rewire(obj)

    return rewired


def optimize_whole(input_path, output_path):
    pdf = pikepdf.open(input_path)
    rewired = deduplicate(pdf)
    pdf.remove_unreferenced_resources()
    pdf.save(
        output_path,
        object_stream_mode=pikepdf.ObjectStreamMode.generate,
        compress_streams=True,
        recompress_flate=True,
    )
    pdf.close()
    return rewired


def optimize_fast(input_path, output_path):
    """Re-serialize only: object streams + stream compression, no dedup.

    Seconds rather than minutes, and still worth ~40% on generator output
    that ships poorly compressed streams. Used as the degraded mode when
    there is no budget left for the full pass.
    """
    pdf = pikepdf.open(input_path)
    pdf.remove_unreferenced_resources()
    pdf.save(
        output_path,
        object_stream_mode=pikepdf.ObjectStreamMode.generate,
        compress_streams=True,
        recompress_flate=True,
    )
    pdf.close()


def optimize_chunked(input_path, output_path, pages_per_chunk, deadline=None):
    """Same result as optimize_whole, with peak memory bounded by chunk size.

    Degrades gracefully against `deadline`: chunks that there is no time left
    to optimize are carried through untouched, so the result is always a
    complete, valid document — just less optimized. Running out of time used
    to mean producing nothing at all, which left the caller with a hard
    failure after a quarter of an hour.
    """
    with pikepdf.open(input_path) as probe:
        n_pages = len(probe.pages)

    # Temp files live beside the output so the caller's own job cleanup covers
    # them even if this process is killed.
    workdir = tempfile.mkdtemp(prefix='struct-', dir=os.path.dirname(os.path.abspath(output_path)))
    try:
        # The source is reopened per chunk on purpose. Holding one handle open
        # across the whole split is ~30% faster but accumulates every touched
        # object in that handle — 1.3 GB instead of 580 MB on an 81 MB test
        # document — which defeats the point of chunking on large input.
        chunk_paths = []
        for index, start in enumerate(range(0, n_pages, pages_per_chunk)):
            chunk_path = os.path.join(workdir, f'chunk-{index}.pdf')
            with pikepdf.open(input_path) as source, pikepdf.Pdf.new() as chunk:
                chunk.pages.extend(source.pages[start:start + pages_per_chunk])
                chunk.save(chunk_path)
            chunk_paths.append(chunk_path)

        # Chunks are independent, so they are optimized in parallel, in waves
        # small enough to re-check the deadline between them. Each worker's
        # memory is bounded by its own chunk.
        workers = max(1, min(int(os.environ.get('STRUCTURE_WORKERS', '2')), len(chunk_paths)))
        optimized = []
        total_rewired = 0
        skipped = 0

        for wave_start in range(0, len(chunk_paths), workers):
            wave = chunk_paths[wave_start:wave_start + workers]
            if deadline is not None and time.time() >= deadline:
                # Out of time for the full pass: still re-serialize, which is
                # cheap and worth roughly 40%, rather than carrying the chunk
                # through untouched.
                for offset, chunk_path in enumerate(wave):
                    fast_path = os.path.join(workdir, f'fast-{wave_start + offset}.pdf')
                    optimize_fast(chunk_path, fast_path)
                    os.remove(chunk_path)
                    optimized.append(fast_path)
                skipped += len(wave)
                continue
            targets = [os.path.join(workdir, f'opt-{wave_start + i}.pdf') for i in range(len(wave))]
            if len(wave) > 1:
                with multiprocessing.Pool(len(wave)) as pool:
                    total_rewired += sum(pool.starmap(optimize_whole, list(zip(wave, targets))))
            else:
                total_rewired += optimize_whole(wave[0], targets[0])
            for chunk_path in wave:
                os.remove(chunk_path)
            optimized.extend(targets)

        merged_path = os.path.join(workdir, 'merged.pdf')
        merged = pikepdf.Pdf.new()
        handles = []
        try:
            for chunk_file in optimized:
                handle = pikepdf.open(chunk_file)
                handles.append(handle)
                merged.pages.extend(handle.pages)
            # Compressed on the way out: a plain save here would undo the
            # per-chunk work, since the chunks' gains live in their
            # serialization rather than in their content.
            merged.save(
                merged_path,
                object_stream_mode=pikepdf.ObjectStreamMode.generate,
                compress_streams=True,
            )
        finally:
            merged.close()
            for handle in handles:
                handle.close()

        if deadline is not None and time.time() >= deadline:
            # Chunks were already processed individually; re-processing the
            # reassembled document costs a memory peak proportional to the
            # whole file (3 GB measured), which is exactly what chunking
            # exists to avoid.
            shutil.move(merged_path, output_path)
        else:
            total_rewired += optimize_whole(merged_path, output_path)
        return total_rewired, len(optimized), skipped
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main():
    if len(sys.argv) != 3:
        print("Usage: optimize_structure.py <input.pdf> <output.pdf>", file=sys.stderr)
        sys.exit(2)

    input_path, output_path = sys.argv[1], sys.argv[2]
    pages_per_chunk = int(os.environ.get('STRUCTURE_CHUNK_PAGES', '250'))
    chunk_above = int(os.environ.get('STRUCTURE_CHUNK_ABOVE_BYTES', str(30 * 1024 * 1024)))

    budget = float(os.environ.get('STRUCTURE_BUDGET_SEC', '0'))
    deadline = (time.time() + budget) if budget > 0 else None

    size_before = os.path.getsize(input_path)
    if size_before > chunk_above:
        rewired, chunks, skipped = optimize_chunked(input_path, output_path, pages_per_chunk, deadline)
    else:
        rewired, chunks, skipped = optimize_whole(input_path, output_path), 1, 0

    print(json.dumps({
        "dedupedReferences": rewired,
        "sizeBefore": size_before,
        "sizeAfter": os.path.getsize(output_path),
        "chunks": chunks,
        "chunksSkipped": skipped,
    }))


if __name__ == '__main__':
    main()
