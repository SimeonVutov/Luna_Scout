"""Draws the figures used by the documentation in docs/images.

Run from the repository root:  uv run --with matplotlib --with numpy docs/figures/make_figures.py

Numbers come from the project's own measurements (see docs/physics.md); the skyline in the
horizon figure is an invented example, drawn only to show the idea.
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

OUT = Path(__file__).resolve().parent.parent / "images"
INK, MUTED, SUN, BLOCKED, CLEAR, EARTH = "#1f2933", "#7b8794", "#e8a317", "#c0392b", "#2c9c69", "#2f6fdb"

plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 11, "axes.edgecolor": MUTED, "axes.labelcolor": INK,
    "xtick.color": INK, "ytick.color": INK, "axes.spines.top": False, "axes.spines.right": False,
    "figure.facecolor": "white", "axes.facecolor": "white", "savefig.facecolor": "white",
})


def save(figure, name):
    figure.savefig(OUT / name, bbox_inches="tight", dpi=160)
    plt.close(figure)


def sun_disk():
    """37 equal-area rays across the Sun, and how a ridge hides only some of them."""
    count = 37
    index = np.arange(count)
    # Equal-area rings: radius r = R·√((i + ½)/N), turned by the golden angle ψ = iπ(3 − √5).
    radius = np.sqrt((index + 0.5) / count)
    angle = index * np.pi * (3 - np.sqrt(5))
    x, y = radius * np.cos(angle), radius * np.sin(angle)

    figure, axes = plt.subplots(1, 2, figsize=(9, 4.2))
    for axis, ridge, title in zip(axes, (0.12, 0.12), ("37 rays: the ridge hides part of the Sun", "1 ray: the same ridge, judged by the centre")):
        axis.set_aspect("equal"); axis.axis("off"); axis.set_title(title, fontsize=11, color=INK)
        axis.add_patch(plt.Circle((0, 0), 1, color=SUN, alpha=0.18))
        axis.add_patch(plt.Circle((0, 0), 1, fill=False, color=SUN, lw=1.5))
        axis.set_xlim(-1.35, 1.35); axis.set_ylim(-1.35, 1.35)
        if axis is axes[0]:
            blocked = y < ridge
            axis.fill_between([-1.35, 1.35], -1.35, ridge, color="#3e4c59", alpha=0.85, zorder=3)
            axis.scatter(x[~blocked], y[~blocked], s=36, color=CLEAR, zorder=4)
            axis.scatter(x[blocked], y[blocked], s=36, color=BLOCKED, zorder=4)
            axis.text(0, -1.2, f"{(~blocked).sum()} of {count} rays clear → {(~blocked).mean():.0%} lit",
                      ha="center", color="white", fontsize=10, zorder=5)
        else:
            axis.fill_between([-1.35, 1.35], -1.35, ridge, color="#3e4c59", alpha=0.85, zorder=3)
            axis.scatter([0], [0], s=60, color=BLOCKED, zorder=4)
            axis.text(0, -1.2, "1 ray blocked → 0% lit", ha="center", color="white", fontsize=10, zorder=5)
    figure.suptitle("Why the Sun is a disk of 37 rays, not one point", fontsize=12, color=INK)
    save(figure, "fig-sun-disk.svg")


def horizon_method():
    """A skyline in azimuth and elevation, with Sun positions classified against it."""
    azimuth = np.linspace(0, 360, 721)
    rng = np.random.default_rng(4)
    skyline = 1.2 + 1.6 * np.sin(np.radians(azimuth * 3)) + 0.8 * np.sin(np.radians(azimuth * 7 + 40))
    skyline += np.convolve(rng.normal(0, 0.25, azimuth.size), np.ones(9) / 9, mode="same")
    skyline = np.maximum(skyline, -0.5)

    figure, axis = plt.subplots(figsize=(9, 3.9))
    axis.fill_between(azimuth, -3, skyline, color="#3e4c59", alpha=0.9, label="Terrain skyline (built once per point)")
    axis.fill_between(azimuth, skyline - 0.05, skyline + 0.05, color=SUN, alpha=0.9, label="Within 0.05° of the skyline: traced exactly")

    # Sun rays sampled across a day: those clearly above or below the skyline are decided by lookup.
    t = np.linspace(20, 200, 40)
    elevation = 1.6 + 2.6 * np.sin(np.radians((t - 20) * 1.0)) * 0.9 - 0.6
    skyline_at = np.interp(t, azimuth, skyline)
    clear = elevation > skyline_at + 0.05
    blocked = elevation < skyline_at - 0.05
    axis.scatter(t[clear], elevation[clear], s=26, color=CLEAR, zorder=3, label="Above the skyline: clear")
    axis.scatter(t[blocked], elevation[blocked], s=26, color=BLOCKED, zorder=3, label="Below the skyline: blocked")
    axis.scatter(t[~clear & ~blocked], elevation[~clear & ~blocked], s=26, color=SUN, edgecolor=INK, zorder=3)
    axis.set_xlim(0, 360); axis.set_ylim(-1.5, 6)
    axis.set_xlabel("Azimuth from the site (degrees)"); axis.set_ylabel("Elevation (degrees)")
    axis.legend(loc="upper right", fontsize=8.5, frameon=False)
    axis.set_title("Horizon method: the skyline is computed once, every ray is then a lookup", fontsize=11, color=INK)
    save(figure, "fig-horizon-method.svg")


def horizon_speed():
    """Total time to compute n timestamps with and without horizon maps."""
    n = np.arange(0, 1001)
    figure, axis = plt.subplots(figsize=(9, 3.9))
    # Total time T(n) = B + p·n, with direct tracing p_d = horizon p × speed-up and no build cost.
    #   B - build seconds, p - seconds per timestamp. Figures are the project's measurements.
    for name, build, per, speedup, colour in (("Shackleton Rim", 44, 0.021, 15.6, EARTH), ("Connecting Ridge", 66, 0.012, 34.5, CLEAR)):
        axis.plot(n, build + per * n, color=colour, lw=2, label=f"{name}: horizon maps")
        axis.plot(n, per * speedup * n, color=colour, lw=1.5, ls="--", label=f"{name}: tracing every ray")
    axis.set_xlabel("Timestamps computed for one site"); axis.set_ylabel("Seconds")
    axis.set_title("The one-off horizon build pays for itself after about 150 timestamps", fontsize=11, color=INK)
    axis.legend(frameon=False, fontsize=9)
    axis.grid(axis="y", color="#e4e7eb")
    save(figure, "fig-horizon-speed.svg")


def receivers():
    """Daily energy at Shackleton for three receivers."""
    figure, axis = plt.subplots(figsize=(6.5, 3.4))
    names = ["Vertical panel that\nturns to the Sun (2 m)", "Panel on the ground", "Horizontal plate"]
    values = [24, 13, 0.7]
    bars = axis.barh(names[::-1], values[::-1], color=[MUTED, MUTED, SUN])
    for bar, value in zip(bars, values[::-1]):
        axis.text(bar.get_width() + 0.4, bar.get_y() + bar.get_height() / 2, f"{value:g}", va="center", color=INK)
    axis.set_xlabel("Energy collected at Shackleton (kWh/m² per day)")
    axis.set_title("The Sun skims the horizon, so the receiver's tilt decides everything", fontsize=10.5, color=INK)
    axis.set_xlim(0, 28)
    save(figure, "fig-receivers.svg")


def reuse():
    """Three overlapping date ranges, and which parts are computed."""
    figure, axis = plt.subplots(figsize=(9, 2.9))
    day = 1
    rows = [("Run A: days 1–2", 0, 2, "first request: computes both days"),
            ("Run B: days 2–4", 1, 3, "day 2 copied from A, only days 3–4 computed"),
            ("Run C: days 1–4", 0, 4, "everything copied, nothing computed")]
    for row, (label, start, length, note) in enumerate(rows):
        y = len(rows) - 1 - row
        computed = {0: (0, 2), 1: (2, 2), 2: (0, 0)}[row]
        axis.barh(y, length, left=start, height=0.5, color=MUTED, alpha=0.55)
        if computed[1]:
            axis.barh(y, computed[1], left=computed[0], height=0.5, color=EARTH)
        axis.text(-0.1, y, label, ha="right", va="center", color=INK)
        axis.text(4.1, y, note, ha="left", va="center", color=MUTED, fontsize=9.5)
    axis.set_xlim(0, 4); axis.set_ylim(-0.6, 2.6)
    axis.set_xticks([0.5, 1.5, 2.5, 3.5]); axis.set_xticklabels(["day 1", "day 2", "day 3", "day 4"])
    axis.spines["left"].set_visible(False); axis.set_yticks([])
    axis.set_title("Samples are shared between runs: blue is computed, grey is copied", fontsize=11, color=INK)
    save(figure, "fig-reuse.svg")


if __name__ == "__main__":
    sun_disk(); horizon_method(); horizon_speed(); receivers(); reuse()
    print("figures written to", OUT)
