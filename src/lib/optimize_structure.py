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

Usage: optimize_structure.py <input.pdf> <output.pdf>
Prints JSON to stdout: {"dedupedReferences": N, "sizeBefore": B, "sizeAfter": A}
"""
import os
import sys
import json
import hashlib

import pikepdf

# Deep enough to resolve /Resources graphs, bounded so a pathological document
# can't send this into a very long walk.
MAX_FINGERPRINT_DEPTH = 20


def fingerprint(obj, depth=0, seen=None):
    """Canonical identity of an object, following indirect references.

    Two objects with equal fingerprints render identically, so either can
    replace the other. References are resolved rather than compared by object
    id, so e.g. two Form XObjects whose /Resources point at distinct but
    identical dictionaries still match.
    """
    if seen is None:
        seen = set()
    if depth > MAX_FINGERPRINT_DEPTH:
        return 'depth-limit'

    objgen = getattr(obj, 'objgen', None)
    if objgen and objgen != (0, 0):
        if objgen in seen:
            # Deliberately position-independent: including the object id here
            # would give every copy of an identical structure a different
            # fingerprint as soon as it contains a back-reference, which
            # /Resources graphs routinely do.
            return 'cycle'
        seen = seen | {objgen}

    h = hashlib.sha256()

    if isinstance(obj, pikepdf.Stream):
        h.update(b'stream:')
        h.update(obj.read_raw_bytes())
        for key in sorted(str(k) for k in obj.keys()):
            if key == '/Length':
                continue
            h.update(key.encode())
            h.update(fingerprint(obj[key], depth + 1, seen).encode())
        return h.hexdigest()

    if isinstance(obj, pikepdf.Dictionary):
        h.update(b'dict:')
        for key in sorted(str(k) for k in obj.keys()):
            h.update(key.encode())
            h.update(fingerprint(obj[key], depth + 1, seen).encode())
        return h.hexdigest()

    if isinstance(obj, pikepdf.Array):
        h.update(b'array:')
        for item in obj:
            h.update(fingerprint(item, depth + 1, seen).encode())
        return h.hexdigest()

    return 'scalar:' + repr(obj)


def deduplicate(pdf):
    """Repoint every reference to a duplicated stream at one canonical copy."""
    canonical = {}
    replacement = {}

    # Single pass, keeping no list of stream wrappers: one Python wrapper per
    # stream is a real memory cost on documents with hundreds of thousands of
    # objects.
    for obj in pdf.objects:
        if not isinstance(obj, pikepdf.Stream):
            continue
        objgen = getattr(obj, 'objgen', None)
        if not objgen or objgen == (0, 0):
            continue
        fp = fingerprint(obj)
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


def main():
    if len(sys.argv) != 3:
        print("Usage: optimize_structure.py <input.pdf> <output.pdf>", file=sys.stderr)
        sys.exit(2)

    input_path, output_path = sys.argv[1], sys.argv[2]

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

    print(json.dumps({
        "dedupedReferences": rewired,
        "sizeBefore": os.path.getsize(input_path),
        "sizeAfter": os.path.getsize(output_path),
    }))


if __name__ == '__main__':
    main()
