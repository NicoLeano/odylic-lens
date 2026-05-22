#!/usr/bin/env python3
"""Generate the Odylic Lens app icon (.icns).

A clean, glassy serif "O" on a soft cream tile. Renders one 1024×1024
master PNG, scales to every Retina-friendly size macOS expects, and
runs `iconutil` to bundle them into AppIcon.icns.

Outputs:
  scripts/build/AppIcon.iconset/   intermediate PNGs
  scripts/build/AppIcon.icns        final macOS icon file
  web/public/odylic-icon.png        single 512px PNG for Linux .desktop + favicon
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    print("✗ Pillow not installed. Run from the API venv:", file=sys.stderr)
    print("  ../api/venv/bin/python scripts/make-icon.py", file=sys.stderr)
    sys.exit(2)


ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "scripts" / "build"
ICONSET = BUILD / "AppIcon.iconset"
ICNS = BUILD / "AppIcon.icns"
WEB_ICON = ROOT / "web" / "public" / "odylic-icon.png"

# Surface palette pulled from index.css. Matches the in-app cream surface.
BG_TOP = (255, 251, 245)      # slightly warm white at top
BG_BOTTOM = (242, 240, 237)   # cream surface
INK = (26, 26, 26)            # text-primary
GLASS = (255, 255, 255, 90)   # specular highlight on the inset card

# Best serif font available on the system.
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Times.ttc",
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "/System/Library/Fonts/Supplemental/Baskerville.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
]


def _serif_font(size_px: int) -> ImageFont.FreeTypeFont:
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size_px)
    # Fall back to PIL default. ugly but won't crash.
    return ImageFont.load_default()


def _rounded_rect_mask(size: int, radius: int) -> Image.Image:
    """Anti-aliased rounded-rect alpha mask at `size×size`."""
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def render_master(size: int = 1024) -> Image.Image:
    """The 1024 master that every other size derives from."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # ── 1. Rounded-rect base tile ────────────────────────────────────
    # macOS Big Sur icons are ~22% corner-radius of edge length.
    corner = int(size * 0.225)

    # Soft vertical gradient body so the tile doesn't read flat.
    body = Image.new("RGB", (size, size), BG_BOTTOM)
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        # Ease into the bottom color so the bulk of the surface is the cream tone.
        e = t * t * (3 - 2 * t)  # smoothstep
        r = int(BG_TOP[0] * (1 - e) + BG_BOTTOM[0] * e)
        g = int(BG_TOP[1] * (1 - e) + BG_BOTTOM[1] * e)
        b = int(BG_TOP[2] * (1 - e) + BG_BOTTOM[2] * e)
        grad.putpixel((0, y), (r, g, b))
    body = grad.resize((size, size))

    # Apply rounded-rect mask
    mask = _rounded_rect_mask(size, corner)
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    base.paste(body, (0, 0), mask)

    # ── 2. Inner specular highlight (top-left glassy gleam) ──────────
    # Soft white radial-ish gleam, only in the upper-left quadrant.
    gleam = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gleam)
    gleam_radius = int(size * 0.55)
    gleam_center = (int(size * 0.32), int(size * 0.28))
    for r, alpha in [(gleam_radius, 0), (int(gleam_radius * 0.55), 90)]:
        gd.ellipse(
            (gleam_center[0] - r, gleam_center[1] - r, gleam_center[0] + r, gleam_center[1] + r),
            fill=(255, 255, 255, alpha),
        )
    gleam = gleam.filter(ImageFilter.GaussianBlur(radius=int(size * 0.08)))
    # Clip to the rounded rect
    gleam_clipped = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gleam_clipped.paste(gleam, (0, 0), mask)
    base = Image.alpha_composite(base, gleam_clipped)

    # ── 3. Thin inner ring (glassy edge) ─────────────────────────────
    edge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ed = ImageDraw.Draw(edge)
    ed.rounded_rectangle((4, 4, size - 5, size - 5), radius=corner - 4, outline=(255, 255, 255, 130), width=4)
    base = Image.alpha_composite(base, edge)

    # ── 4. The serif "O" itself ──────────────────────────────────────
    # Source Serif 4 wasn't shipping in the repo so we use a system
    # serif at a size that fills the tile nicely. The "O" is dark
    # ink with a soft drop shadow.
    o_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    od = ImageDraw.Draw(o_layer)
    font_size = int(size * 0.72)
    font = _serif_font(font_size)
    text = "O"
    bbox = od.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = (size - th) // 2 - bbox[1] - int(size * 0.02)  # nudge up slightly so it sits visually centered
    # Drop shadow
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.text((tx + int(size * 0.008), ty + int(size * 0.012)), text, font=font, fill=(0, 0, 0, 60))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=int(size * 0.015)))
    base = Image.alpha_composite(base, shadow)
    od.text((tx, ty), text, font=font, fill=INK + (255,))
    base = Image.alpha_composite(base, o_layer)

    return base


def export_sizes(master: Image.Image) -> None:
    if BUILD.exists():
        shutil.rmtree(BUILD)
    ICONSET.mkdir(parents=True, exist_ok=True)
    # macOS .icns expects these (size, retina) pairs.
    specs = [
        (16, 1), (16, 2),
        (32, 1), (32, 2),
        (64, 2),                  # 64x64 alias is sometimes pulled from icon_32x32@2x
        (128, 1), (128, 2),
        (256, 1), (256, 2),
        (512, 1), (512, 2),
    ]
    for px, scale in specs:
        actual = px * scale
        name = f"icon_{px}x{px}{'@2x' if scale == 2 else ''}.png"
        if px == 64 and scale == 2:
            continue  # skip — 64@2x = 128 which is its own entry
        out = master.resize((actual, actual), Image.LANCZOS)
        out.save(ICONSET / name, format="PNG", optimize=True)
    print(f"  wrote {len(list(ICONSET.glob('*.png')))} PNGs to {ICONSET}")


def bundle_icns() -> bool:
    """macOS-only. uses iconutil to bundle the .iconset into .icns."""
    if not shutil.which("iconutil"):
        print("  ⚠ iconutil not found (non-macOS host). skipping .icns bundle.")
        return False
    res = subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET), "-o", str(ICNS)],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        print(f"  ⚠ iconutil failed:\n{res.stderr}")
        return False
    print(f"  ✓ {ICNS}  ({ICNS.stat().st_size // 1024}KB)")
    return True


def export_web_icon(master: Image.Image) -> None:
    """Single 512px PNG used by the Linux .desktop entry + browser favicon."""
    WEB_ICON.parent.mkdir(parents=True, exist_ok=True)
    master.resize((512, 512), Image.LANCZOS).save(WEB_ICON, format="PNG", optimize=True)
    print(f"  ✓ {WEB_ICON}")


def main() -> None:
    print("→ Rendering 1024px master")
    master = render_master(1024)
    print("→ Exporting all sizes")
    export_sizes(master)
    print("→ Bundling .icns")
    bundle_icns()
    print("→ Web icon (Linux launcher + favicon)")
    export_web_icon(master)
    print()
    print("Done. To install into the running .app:")
    print(f"  cp {ICNS} ~/Applications/Odylic\\ Lens.app/Contents/Resources/AppIcon.icns")
    print("  touch ~/Applications/Odylic\\ Lens.app  # force Finder to re-cache")


if __name__ == "__main__":
    main()
