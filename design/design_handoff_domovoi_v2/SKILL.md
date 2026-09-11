---
name: domovoi-design
description: Use this skill to generate well-branded interfaces and assets for Domovoi, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for protoyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.
If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Fast orientation

- `readme.md` — the design guide. Content fundamentals and visual foundations are the two
  sections to read before designing anything.
- `styles.css` — link this one file and every token is available.
- `guidelines/*.card.html` — visual specimens for colour, type, spacing and brand.
- `components/*/  ` — React primitives, each with a `.prompt.md` stating what it is for.
- `ui_kits/*/` — full-screen recreations of the desktop app, the phone app and the site.

## Three rules that are easy to get wrong

1. **"Control plane" is banned copy.** Say "agent runner", or describe the mechanism.
2. **Never market "runs with no account."** It is an artifact of backend iteration 1.
   The line is "Bring your own agents, or tokens."
3. **Mono means machine-authored.** Paths, commands, shas, model ids, durations. If a
   human wrote it, it is sans.
