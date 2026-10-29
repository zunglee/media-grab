# MediaGrab — identity

Per DESIGN-OS § 3, the product questions come before any UI decision.

**Who is this for?** Someone who wants a specific video or podcast off a page they are already looking
at — a lecture, a talk, a conference recording, an episode — usually to watch offline. Half of them do
not know what a bitrate is. The other half know exactly which codec they want.

**What are they trying to do?** Get the right file, once, without thinking about it.

**What should they feel?** *Certainty.* Not delight. The emotional failure mode of a downloader is
doubt: "is this the right one, is it the full thing, did it actually save".

**What should they remember?** That it told them the truth — including when it could not help.

**What is the most important action?** One button that takes the best version.

**What makes this different?** Every competitor shows you a list of URLs and makes the ranking your
problem. MediaGrab measures, ranks, and explains — and when it cannot help, it says why.

**What should not exist?** A settings-first interface. A wall of thirty rows. The word "failed" with
nothing after it.

---

## The thesis: SIGNAL

A web page is a set of media signals of varying strength. The extension is an instrument that reads
them. That single idea drives everything visual:

- the toolbar badge is a count, then a percentage, then a tick — a readout;
- every media row carries a five-segment **level meter** showing detection confidence;
- figures are monospaced and tabular so they line up column-wise down the list;
- field labels are small, uppercase, letterspaced mono — the voice of a panel, not of a marketing page;
- structure is drawn with hairline rules, never with shadows or cards floating on a gradient;
- exactly **one** accent colour (amber), used only to mark the thing you should act on. If two things
  on screen are amber, one of them is a bug.

The interface reads as equipment. That is deliberate: equipment is trusted to be accurate.

## What was rejected, and why

DESIGN-OS § 4's anti-generic list, taken as a checklist:

| Rejected | Why |
|---|---|
| Rounded glass cards on a gradient | A gradient behind a data readout makes the readout harder to read. Contrast is the product. |
| Purple/blue tech accent | It is the default of the category and says nothing. Amber reads as "instrument", and it is unambiguous against both grounds. |
| Fade-up animation on every row | The popup is open for four seconds. Animation is latency the user pays for nothing. Motion is limited to the progress fill and hover borders, and `prefers-reduced-motion` removes even those. |
| Thumbnails as the *primary* visual | Still rejected. A thumbnail is the one thing a hostile page fully controls, it is frequently the wrong frame, and sizing it to lead the row pushes the quality information below the fold. The meter carries more information in 5×40 px, and it stays first in the row. |
| A dashboard with charts | Nobody wants analytics about their downloads. |
| Big centred hero heading | It is a 384 px popup. |

## The preview (added 0.1.3)

A 76×43 thumbnail sits between the meter and the text — second in the reading order, never first.

It earns its place because recognition is faster than reading: on a page with three videos, the picture
tells you which one you meant before the title has been parsed. What it must not do is become the row.
So it is small, fixed-size, and squared off like everything else — no rounded card, no shadow, no
hover zoom.

Three states, all the same size so the list never reflows:

- the poster;
- a placeholder with a `▶` / `♪` / `CC` glyph and the container name in mono, when there is no poster;
- the same placeholder when the image fails to load.

The placeholder matters more than the picture. Most rows on most sites have no poster, and a blank grey
box reads as a broken extension. A box that says `HLS` reads as an instrument reporting what it found —
which is the whole thesis.

Its text uses `--ink-muted`, not `--ink-faint`: the faint token is tuned against `--ground` and only
reaches 4.24:1 on the sunken ground the placeholder sits on. Axe caught that.

## Palette

Warm near-black, not blue-black — blue-black reads as "generic dark mode", warm reads as instrument
housing. The light theme is warm paper, not white.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--ground` | `#f4f1ec` | `#171a1d` | page |
| `--ground-raised` | `#ffffff` | `#1e2225` | controls |
| `--ground-sunken` | `#e9e4dc` | `#101315` | the "best download" bar, inputs |
| `--ink` | `#1b1e21` | `#e8e2d8` | primary text |
| `--ink-muted` | `#5c6167` | `#9aa1a8` | metadata |
| `--ink-faint` | `#666b71` | `#868d93` | labels, secondary detail |
| `--signal` | `#9e4f10` | `#e07a2d` | the one accent |
| `--live` | `#b3261e` | `#ef5350` | live-stream marker |
| `--ok` / `--warn` / `--danger` | `#1f6b4f` / `#8a6100` / `#9d2c2c` | `#4fb98c` / `#d9a441` / `#e06c6c` | states |

Every text token clears 4.5:1 against its ground in both themes; `--ink-faint` was moved twice during
development because axe caught it at 2.8:1 (light) and 3.58:1 (dark). Contrast is a gate, not a review
note — see TESTING.md § 3.

## Type

System UI stack for prose, system mono for every number, label and URL. No web fonts: a popup that
waits on a font download has failed at the only thing it does. Sizes are small and few — 10.5, 11.5, 13,
14, 17 px — because the popup is dense by nature and a size scale with nine steps in a 384 px column is
noise.

## Motion

Two transitions exist: the progress fill (160 ms) and control borders on hover (90 ms). Both collapse to
0 ms under `prefers-reduced-motion`. There is no entrance animation anywhere.

## Simple vs Power

The same screen, one toggle. Simple shows a title, a one-line summary, and a download button. Power adds
codecs on each rung, the score with its reasons, and a scan-statistics line in the footer. Nothing is
*moved* between the modes — Power only reveals — so muscle memory survives the switch.

## Would it hold up next to Linear or Stripe?

The bar from CHARTER § 8. Honestly: the density, restraint and typographic discipline are in that
territory; the empty and error states are better than most of the category because they explain. What is
not there yet is craft in the small — the meter is the only piece of real visual invention, there is no
considered icon set beyond the generated mark, and the options page is a competent form rather than a
designed one. That is the next pass.
