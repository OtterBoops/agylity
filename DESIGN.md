---
name: Agylity
description: Autonomous Quota Sentry & Swarm Coordinator for Google Antigravity
colors:
  bg-base: '#232136'
  bg-surface: '#2a273f'
  bg-overlay: '#393552'
  text-primary: '#e0def4'
  text-secondary: '#a4a0c0'
  text-muted: '#6e6a86'
  border-highlight: '#44415a'
  accent-foam: '#9ccfd8'
  accent-iris: '#c4a7e7'
  accent-pine: '#3e8fb0'
  accent-gold: '#f6c177'
  accent-love: '#ee82a0'
  accent-rose: '#ea9a97'
typography:
  heading:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif'
    fontSize: '1.25rem'
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.02em'
  body:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif'
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: '0.8125rem'
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: '4px'
  md: '8px'
  lg: '12px'
  xl: '16px'
  full: '9999px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '14px'
  lg: '20px'
  xl: '28px'
components:
  button-primary:
    backgroundColor: '{colors.accent-iris}'
    textColor: '{colors.bg-base}'
    rounded: '{rounded.md}'
    padding: '6px 14px'
  card:
    backgroundColor: '{colors.bg-surface}'
    textColor: '{colors.text-primary}'
    rounded: '{rounded.lg}'
    padding: '20px 24px'
  badge:
    rounded: '{rounded.sm}'
    padding: '2px 8px'
---

# Agylity Design System

## Overview

Agylity is a high-density, technical operations dashboard and coordinator for Google Antigravity. Its visual world is defined by the **Rosé Pine** palette: dark, atmospheric, low-fatigue slate backgrounds with high-clarity muted pastel accents. The interface prioritizes telemetry scanability, deterministic single-page responsiveness, and dense, anti-AI engineering aesthetics.

## Colors

The palette is Rosé Pine Moon, held in a single `:root` block of Tailwind v4 CSS variables. There is one theme: no light variant, no runtime switching, and no `data-theme` attribute. Every text token clears WCAG AA (4.5:1) on all three surface layers except `text-muted`, which is deliberately quiet for de-emphasised metadata.

- **Surface Layers:**
  - `bg-base` (`#232136`): Application background and viewport canvas.
  - `bg-surface` (`#2a273f`): Primary cards, sidebars, and elevated containers.
  - `bg-overlay` (`#393552`): Inputs, table header bands, modals, and badge backgrounds.
- **Text & Borders:**
  - `text-primary` (`#e0def4`): High-contrast titles, primary numbers, and headings.
  - `text-secondary` (`#a4a0c0`): Subtitles, helper text, and secondary metadata.
  - `text-muted` (`#6e6a86`): Disabled states, minor timestamps, and subtle borders.
  - `border-highlight` (`#44415a`): Structural card and table boundaries.
- **Accents:**
  - `accent-iris` (`#c4a7e7`): Primary brand action, active tabs, and identity pills.
  - `accent-foam` (`#9ccfd8`): Completed tasks, clean PR links, and stable states.
  - `accent-gold` (`#f6c177`): In-progress tasks, pre-reset triggers, and warning states.
  - `accent-love` (`#ee82a0`): Failed dispatches, quota depletion, and critical alerts.
  - `accent-pine` (`#3e8fb0`): Model family indicators and healthy quota pools.
  - `accent-rose` (`#ea9a97`): Scheduled and routine-bound states.

## Typography

Typography is strictly dual-stack: **Inter / system-ui** for structural copy and **monospace** for tokens, identifiers, and telemetry:

- **Headings (`h1`, `h2`):** `text-lg` (18px) to `text-xl` (20px), `font-semibold` or `font-bold`. Never bloated or oversized (`2xl:text-3xl` is prohibited).
- **Root Scale:** The document root is `15.4px`, rising to `16.5px` at `sm` and `17.6px` at `2xl`; every rem-derived utility scales with it. Never reintroduce `zoom` on an ancestor — it double-scales any overlay positioned from `getBoundingClientRect()`.
- **Body & Captions:** `text-sm` for data tables and controls; `text-xs` for secondary metadata. Body text below 12px is prohibited.
- **Mono Telemetry:** `font-mono text-xs` or `text-sm` for task IDs, commit hashes, branches, durations, and credit balances.

## Layout

- **Container Isolation:** The desktop app is a non-scrolling flex shell (`md:flex md:h-full md:overflow-hidden`). The top bar is a fixed header (`shrink-0`), and the content area scrolls independently within its view container.
- **Settings Width Bounding:** All configuration forms enforce `max-w-5xl` to prevent input stretching on 1440p and ultrawide displays.
- **Responsive Hierarchy:** Mobile viewports (`< md`) collapse sidebars into a sticky top header with hamburger toggle, allowing the document body to scroll naturally with native touch mechanics.

## Elevation & Depth

- **Borders over Shadows:** Depth is established primarily via subtle 1px border lines (`border border-pine-highlight`) rather than heavy drop shadows.
- **Modal Backdrops:** Native HTML `<dialog>` elements rendered with `backdrop:bg-black/60` and light blur (`backdrop-blur-xs`).
- **Surface Layering:** Base (`#232136`) $\to$ Surface (`#2a273f`) $\to$ Overlay (`#393552`).

## Shapes

- **Cards & Dialogs:** `rounded-xl` (12px) with subtle 1px borders.
- **Buttons & Selectors:** `rounded-lg` (8px).
- **Status Badges & Chips:** `rounded-md` (6px) or `rounded-sm` (4px).
- **Progress & Toggles:** `rounded-full`.

## Components

- **Data Tables:** Crisp table layout with `p-3.5` cell padding, uppercase monospace headers (`text-xs sm:text-[14.3px] tracking-wider text-pine-muted`), single-line rows, and right-aligned duration metrics.
- **Status Badges:** Textual status pills (`[DONE]`, `[FAILED]`, `[ACTIVE]`) with `whitespace-nowrap`, 1px borders, and light alpha backgrounds (`bg-*/15 text-* border-*/40`).
- **Metric Cards:** Clean numerical displays with dual-tone progress bars and countdown timers.

## Do's and Don'ts

- **DO** use textual status tags (`[Alert]`, `[Blocked]`, `[Done]`).
- **DO** keep row heights uniform and compact in tables with `truncate` on long identifiers.
- **DO** compose styles strictly via Tailwind utility classes.
- **DON'T** use decorative emoji in embeds, logs, or UI (`🚨`, `⚡`, `⚠️`, `✅`).
- **DON'T** stack multi-line text (like branch names) inside narrow result/status cells.
- **DON'T** apply `border-l-4` or thick accent side-bars to cards.
- **DON'T** let settings cards stretch unconstrained across 1440p viewports.
