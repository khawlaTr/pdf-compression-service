#!/usr/bin/env python3
"""
Removes images that repeat across many pages (a logo/letterhead stamped on
every page), keeping only their first occurrence.

Matching compares decoded pixel content with a tolerance, not raw bytes: the
same logo is usually re-encoded slightly differently on each page by whatever
produced the PDF. Byte-identical comparison therefore finds nothing — which is
also why Ghostscript's own -dDetectDuplicateImages doesn't help here (both
changed the output by ~0.1% on a real 3000+ page invoice). Exact hashing of a
quantized thumbnail doesn't work either: a single pixel landing on the wrong
side of a quantization boundary breaks the match, and with JPEG noise that is
near-certain. Hence an explicit distance threshold.

Usage: strip_repeated_images.py <input.pdf> <output.pdf> <min_pages>

Prints a one-line JSON summary to stdout: {"repeatedImages": N, "removedRefs": M}
"""
import sys
import json
import shutil
import hashlib

import pikepdf
from pikepdf import Name, PdfImage

# Only decode images below this pixel count. A repeated logo is small; a
# full-page 300 DPI scan is ~8 MP and decoding thousands of them would cost
# far more than the dedup could save. Larger images still match exactly by
# raw bytes.
MAX_DECODE_PIXELS = 4_000_000

# Thumbnail grid for content comparison — downscaling this far averages away
# JPEG artifacts while keeping enough structure to tell images apart.
THUMB_SIZE = 16

# Mean absolute per-channel difference (0-255 scale) below which two
# thumbnails count as the same image. Re-encodings of one logo land within a
# few units; visibly different images are tens to hundreds apart.
MATCH_TOLERANCE = 8.0


def raw_key(xobj):
    return 'raw:' + hashlib.sha256(xobj.read_raw_bytes()).hexdigest()


def thumbnail(xobj):
    """16x16 RGB bytes of the decoded image, or None if not decodable/too big."""
    try:
        width = int(xobj.get('/Width', 0))
        height = int(xobj.get('/Height', 0))
        if width * height == 0 or width * height > MAX_DECODE_PIXELS:
            return None
        img = PdfImage(xobj).as_pil_image().convert('RGB').resize((THUMB_SIZE, THUMB_SIZE))
        return img.tobytes()
    except Exception:
        return None


def mean_abs_diff(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


class ImageMatcher:
    """Assigns each image a cluster id, grouping near-identical content."""

    def __init__(self):
        self.clusters_by_dims = {}  # (w, h) -> list of (thumbnail, cluster_id)
        self.by_objgen = {}
        self.next_id = 0

    def key_for(self, xobj):
        objgen = getattr(xobj, 'objgen', None)
        if objgen is not None and objgen in self.by_objgen:
            return self.by_objgen[objgen]

        key = self._compute(xobj)
        if objgen is not None:
            self.by_objgen[objgen] = key
        return key

    def _compute(self, xobj):
        thumb = thumbnail(xobj)
        if thumb is None:
            return raw_key(xobj)

        dims = (int(xobj.get('/Width', 0)), int(xobj.get('/Height', 0)))
        bucket = self.clusters_by_dims.setdefault(dims, [])
        for existing_thumb, cluster_id in bucket:
            if mean_abs_diff(thumb, existing_thumb) <= MATCH_TOLERANCE:
                return cluster_id

        cluster_id = f'img:{self.next_id}'
        self.next_id += 1
        bucket.append((thumb, cluster_id))
        return cluster_id


def normalize(name):
    s = str(name)
    return s[1:] if s.startswith('/') else s


def iter_page_images(page):
    resources = page.get('/Resources')
    if resources is None or '/XObject' not in resources:
        return
    xobjects = resources['/XObject']
    for name in list(xobjects.keys()):
        xobj = xobjects[name]
        if xobj.get('/Subtype') == Name('/Image'):
            yield name, xobj


def main():
    if len(sys.argv) != 4:
        print("Usage: strip_repeated_images.py <input.pdf> <output.pdf> <min_pages>", file=sys.stderr)
        sys.exit(2)

    input_path, output_path, min_pages = sys.argv[1], sys.argv[2], int(sys.argv[3])

    pdf = pikepdf.open(input_path)
    matcher = ImageMatcher()

    # Pass 1: which pages does each distinct image appear on?
    occurrences = {}
    for page_index, page in enumerate(pdf.pages):
        for _name, xobj in iter_page_images(page):
            occurrences.setdefault(matcher.key_for(xobj), set()).add(page_index)

    repeated = {k for k, pages in occurrences.items() if len(pages) >= min_pages}

    if not repeated:
        pdf.close()
        shutil.copyfile(input_path, output_path)
        print(json.dumps({"repeatedImages": 0, "removedRefs": 0}))
        return

    keep_page = {k: min(occurrences[k]) for k in repeated}

    removed_refs = 0
    for page_index, page in enumerate(pdf.pages):
        names_to_strip = set()
        for name, xobj in iter_page_images(page):
            key = matcher.key_for(xobj)
            if key in repeated and page_index != keep_page[key]:
                names_to_strip.add(normalize(name))

        if not names_to_strip:
            continue

        # Remove the draw calls, not just the resource entries — an orphaned
        # resource is usually harmless but a dangling draw reference is not.
        kept = []
        for operands, operator in pikepdf.parse_content_stream(page):
            if str(operator) == 'Do' and len(operands) == 1 and normalize(operands[0]) in names_to_strip:
                removed_refs += 1
                continue
            kept.append((operands, operator))
        page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))

        xobjects = page['/Resources']['/XObject']
        for name in list(xobjects.keys()):
            if normalize(name) in names_to_strip:
                del xobjects[name]

    pdf.save(output_path)
    pdf.close()
    print(json.dumps({"repeatedImages": len(repeated), "removedRefs": removed_refs}))


if __name__ == '__main__':
    main()
