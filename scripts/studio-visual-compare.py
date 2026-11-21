"""Exact comparison of the visible original editor dock at 1440x900.

Usage: python scripts/studio-visual-compare.py BEFORE_DIR AFTER_DIR
Requires Pillow. This does not validate off-screen controls or physical devices.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageChops

before, after = map(Path, sys.argv[1:3])
results = []
for old in sorted(before.glob("editor-*.png")):
    new = after / old.name
    with Image.open(old) as a, Image.open(new) as b:
        assert a.size == b.size == (1440, 900), "Expected desktop captures"
        # Browser is outside the original instrument. Include the full visible
        # editor dock so material, labels, knobs and layout changes are detected.
        region = (248, 585, 1440, 900)
        changed = ImageChops.difference(a.crop(region), b.crop(region)).getbbox()
        results.append({"machine": old.stem.removeprefix("editor-"), "identical": changed is None})
report = {"scope": "visible desktop editor dock only", "region": [248,585,1440,900], "results": results}
print(json.dumps(report, indent=2))
sys.exit(0 if len(results) == 15 and all(r["identical"] for r in results) else 1)
