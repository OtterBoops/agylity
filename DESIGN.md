---
name: Agylity
description: Autonomous Quota Sentry & Swarm Coordinator for Google Antigravity
colors:
  bg-base: '#191724'
  bg-surface: '#1f1d2e'
  bg-overlay: '#26233a'
  text-primary: '#e0def4'
  text-secondary: '#9893b8'
  text-muted: '#6e6a86'
  border-highlight: '#403d52'
  accent-foam: '#9ccfd8'
  accent-iris: '#c4a7e7'
  accent-pine: '#31748f'
  accent-gold: '#f6c177'
  accent-love: '#eb6f92'
  accent-rose: '#ebbcba'
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

The palette is rooted in three Rosé Pine variants (Default Dark, Moon, and Dawn) composed via Tailwind v4 CSS variables:

- **Surface Layers:**
  - `bg-base` (`#191724`): Application background and viewport canvas.
  - `bg-surface` (`#1f1d2e`): Primary cards, sidebars, and elevated containers.
  - `bg-overlay` (`#26233a`): Inputs, table header bands, modals, and badge backgrounds.
- **Text & Borders:**
  - `text-primary` (`#e0def4`): High-contrast titles, primary numbers, and headings.
  - `text-secondary` (`#9893b8`): Subtitles, helper text, and secondary metadata.
  - `text-muted` (`#6e6a86`): Disabled states, minor timestamps, and subtle borders.
  - `border-highlight` (`#403d52`): Structural card and table boundaries.
- **Accents:**
  - `accent-iris` (`#c4a7e7`): Primary brand action, active tabs, and identity pills.
  - `accent-foam` (`#9ccfd8`): Completed tasks, clean PR links, and stable states.
  - `accent-gold` (`#f6c177`): In-progress tasks, pre-reset triggers, and warning states.
  - `accent-love` (`#eb6f92`): Failed dispatches, quota depletion, and critical alerts.
  - `accent-pine` (`#31748f`): Model family indicators and healthy quota pools.

## Typography

Typography is strictly dual-stack: **Inter / system-ui** for structural copy and **monospace** for tokens, identifiers, and telemetry:

- **Headings (`h1`, `h2`):** `text-lg` (18px) to `text-xl` (20px), `font-semibold` or `font-bold`. Never bloated or oversized (`2xl:text-3xl` is prohibited).
- **Body & Captions:** `text-sm` (14px) for data tables and controls; `text-xs` (12px) for secondary metadata. Body text below 12px is prohibited.
- **Mono Telemetry:** `font-mono text-xs` or `text-sm` for task IDs, commit hashes, branches, durations, and credit balances.

## Layout

- **Container Isolation:** The desktop app is a non-scrolling flex shell (`md:flex md:h-full md:overflow-hidden`). The top bar is a fixed header (`shrink-0`), and the content area scrolls independently within its view container.
- **Settings Width Bounding:** All configuration forms enforce `max-w-5xl` to prevent input stretching on 1440p and ultrawide displays.
- **Responsive Hierarchy:** Mobile viewports (`< md`) collapse sidebars into a sticky top header with hamburger toggle, allowing the document body to scroll naturally with native touch mechanics.

## Elevation & Depth

- **Borders over Shadows:** Depth is established primarily via subtle 1px border lines (`border border-pine-highlight`) rather than heavy drop shadows.
- **Modal Backdrops:** Native HTML `<dialog>` elements rendered with `backdrop:bg-black/60` and light blur (`backdrop-blur-xs`).
- **Surface Layering:** Base (`#191724`) $\to$ Surface (`#1f1d2e`) $\to$ Overlay (`#26233a`).

## Shapes

- **Cards & Dialogs:** `rounded-xl` (12px) with subtle 1px borders.
- **Buttons & Selectors:** `rounded-lg` (8px).
- **Status Badges & Chips:** `rounded-md` (6px) or `rounded-sm` (4px).
- **Progress & Toggles:** `rounded-full`.

## Components

- **Data Tables:** Crisp table layout with `p-3.5` cell padding, uppercase monospace headers (`text-xs sm:text-[13px] tracking-wider text-pine-muted`), single-line rows, and right-aligned duration metrics.
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
