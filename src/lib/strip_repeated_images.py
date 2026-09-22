#!/usr/bin/env python3
"""
Removes images that repeat identically across many pages (a logo/letterhead
stamped on every page), keeping only their first occurrence. Ghostscript's
own -dDetectDuplicateImages does not reliably catch this case: it re-encodes
each page's image independently during resolution downsampling and does not
always recognize the results as identical afterwards. This operates on the
*source* PDF, before Ghostscript ever runs, comparing raw embedded image
bytes directly.

Usage: strip_repeated_images.py <input.pdf> <output.pdf> <min_pages>

<min_pages>: an image must appear on at least this many distinct pages to be
treated as a repeated header/logo and stripped from all but its first page.
Exits 0 and copies the file through unchanged if nothing qualifies.
"""
import sys
import shutil
import hashlib

import pikepdf
from pikepdf import Name


def image_hash(xobj):
    return hashlib.sha256(xobj.read_raw_bytes()).hexdigest()


def normalize(name):
    s = str(name)
    return s[1:] if s.startswith('/') else s


def main():
    if len(sys.argv) != 4:
        print("Usage: strip_repeated_images.py <input.pdf> <output.pdf> <min_pages>", file=sys.stderr)
        sys.exit(2)

    input_path, output_path, min_pages = sys.argv[1], sys.argv[2], int(sys.argv[3])

    pdf = pikepdf.open(input_path)

    # Pass 1: collect image hash -> set of page indices it appears on.
    occurrences = {}
    for page_index, page in enumerate(pdf.pages):
        resources = page.get('/Resources')
        if resources is None or '/XObject' not in resources:
            continue
        xobjects = resources['/XObject']
        for name in list(xobjects.keys()):
            xobj = xobjects[name]
            if xobj.get('/Subtype') != Name('/Image'):
                continue
            h = image_hash(xobj)
            occurrences.setdefault(h, set()).add(page_index)

    repeated_hashes = {h for h, pages in occurrences.items() if len(pages) >= min_pages}

    if not repeated_hashes:
        pdf.close()
        shutil.copyfile(input_path, output_path)
        print("no repeated image found above threshold; copied through unchanged", file=sys.stderr)
        return

    keep_page_for_hash = {h: min(occurrences[h]) for h in repeated_hashes}

    removed_refs = 0
    for page_index, page in enumerate(pdf.pages):
        resources = page.get('/Resources')
        if resources is None or '/XObject' not in resources:
            continue
        xobjects = resources['/XObject']

        names_to_strip = set()
        for name in list(xobjects.keys()):
            xobj = xobjects[name]
            if xobj.get('/Subtype') != Name('/Image'):
                continue
            h = image_hash(xobj)
            if h in repeated_hashes and page_index != keep_page_for_hash[h]:
                names_to_strip.add(normalize(name))

        if not names_to_strip:
            continue

        # Strip the Do operator invocations for these XObjects from the
        # content stream first — an unused resource entry alone is usually
        # harmless, but removing the draw call too avoids relying on every
        # viewer tolerating a dangling reference.
        instructions = pikepdf.parse_content_stream(page)
        kept_instructions = []
        for operands, operator in instructions:
            if str(operator) == 'Do' and len(operands) == 1 and normalize(operands[0]) in names_to_strip:
                removed_refs += 1
                continue
            kept_instructions.append((operands, operator))
        page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept_instructions))

        for name in list(xobjects.keys()):
            if normalize(name) in names_to_strip:
                del xobjects[name]

    pdf.save(output_path)
    pdf.close()
    print(
        f"stripped {len(repeated_hashes)} repeated image(s), {removed_refs} draw reference(s) removed",
        file=sys.stderr,
    )


if __name__ == '__main__':
    main()
