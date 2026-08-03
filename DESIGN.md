---
name: Professional Trust
colors:
  surface: '#f9f9ff'
  surface-dim: '#d8d9e2'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3fc'
  surface-container: '#ecedf6'
  surface-container-high: '#e7e8f1'
  surface-container-highest: '#e1e2eb'
  on-surface: '#191c22'
  on-surface-variant: '#434653'
  inverse-surface: '#2e3037'
  inverse-on-surface: '#eff0f9'
  outline: '#737784'
  outline-variant: '#c3c6d5'
  surface-tint: '#2159be'
  primary: '#094db2'
  on-primary: '#ffffff'
  primary-container: '#3366cc'
  on-primary-container: '#e7ecff'
  inverse-primary: '#b0c6ff'
  secondary: '#4e5d86'
  on-secondary: '#ffffff'
  secondary-container: '#bfcefd'
  on-secondary-container: '#48577f'
  tertiary: '#7d308f'
  on-tertiary: '#ffffff'
  tertiary-container: '#984aaa'
  on-tertiary-container: '#ffe3ff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d9e2ff'
  primary-fixed-dim: '#b0c6ff'
  on-primary-fixed: '#001945'
  on-primary-fixed-variant: '#00419d'
  secondary-fixed: '#dae2ff'
  secondary-fixed-dim: '#b6c6f4'
  on-secondary-fixed: '#081a3f'
  on-secondary-fixed-variant: '#37466d'
  tertiary-fixed: '#fdd6ff'
  tertiary-fixed-dim: '#f4aeff'
  on-tertiary-fixed: '#340042'
  on-tertiary-fixed-variant: '#702383'
  background: '#f9f9ff'
  on-background: '#191c22'
  surface-variant: '#e1e2eb'
typography:
  headline-lg:
    fontFamily: Noto Serif
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
  headline-md:
    fontFamily: Noto Serif
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
  headline-sm:
    fontFamily: Noto Serif
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: Public Sans
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 8px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 16px
  margin: 24px
---

# Professional Trust Design System

## Brand & Style
The brand identity has transitioned from a high-energy, vibrant aesthetic to a more stable, professional, and trustworthy persona. By moving away from aggressive oranges toward a balanced palette of deep blues and purples, the brand evokes a sense of reliability and intelligence.

The design style follows a **Corporate / Modern** approach. It is balanced and professional, drawing inspiration from high-quality functional design systems. It prioritizes clarity, readability, and a calm user experience, making it ideal for information-dense applications where user focus and systemic trust are paramount.

## Colors
The color palette is anchored by a trustworthy blue, utilizing the `content` variant to ensure that colors are derived directly from the primary intent of the information being presented.

*   **Primary (#4273d9):** A confident, "content-first" blue used for key actions and brand presence.
*   **Secondary (#6776a0):** A muted slate blue that provides professional contrast without competing with primary actions.
*   **Tertiary (#984aaa):** A sophisticated purple used for accents, highlighting secondary information, or distinguishing specific data sets.
*   **Neutral (#75777f):** A balanced cool gray used for surfaces, borders, and secondary text, maintaining a clean and modern appearance.

The system is optimized for a **light** color mode, ensuring high legibility and a crisp, airy interface.

## Typography
The typography strategy employs a sophisticated mix of serif and sans-serif faces to create a clear hierarchy and an editorial feel.

*   **Headlines (Noto Serif):** Used for titles and major headings. The serif typeface adds an air of authority and traditional reliability.
*   **Body (Inter):** A modern, highly legible sans-serif designed for screen readability. It is used for all long-form text and general UI content.
*   **Labels (Public Sans):** A neutral, sturdy sans-serif used for UI elements, buttons, and small metadata, providing clarity at small sizes.

On mobile devices, large headlines (above 32px) should scale down to a maximum of 28px (`headline-md`) to ensure they fit within the viewport without excessive wrapping.

## Layout & Spacing
The system utilizes a **Fluid Grid** model with a base-8 spacing rhythm. This ensures consistency across the UI while allowing elements to scale naturally with the screen size.

*   **Grid:** A 12-column system for desktop, transitioning to 8 columns for tablet and 4 columns for mobile.
*   **Gutters/Margins:** Standard 16px gutters keep content separated, while 24px outer margins provide breathable space on smaller viewports.
*   **Rhythm:** All component padding and margins should be multiples of 4px or 8px to maintain a strict vertical and horizontal cadence.

## Elevation & Depth
Depth is communicated through **Tonal Layers** and subtle shadows. Instead of heavy physical metaphors, the system uses a tiered surface approach:

*   **Surface Level 0:** The main background, usually the lightest neutral.
*   **Surface Level 1:** Cards and containers, slightly elevated via a soft, diffused ambient shadow (low opacity, tinted with the neutral gray).
*   **Surface Level 2:** Overlays and menus, using a more pronounced shadow to indicate temporary placement atop the primary UI.

Low-contrast outlines are used for interactive elements like input fields to maintain a flat, professional aesthetic without unnecessary visual noise.

## Shapes
The design utilizes a **Soft** shape language. This provides a modern touch that feels approachable without being overly playful or informal.

*   **Standard Elements:** 4px (0.25rem) corner radius for buttons and input fields.
*   **Large Elements:** 8px (0.5rem) corner radius for cards and containers.
*   **Extra Large:** 12px (0.75rem) for large modals or featured content sections.

## Components
Components are designed for utility and professional clarity:

*   **Buttons:** Use the Primary Blue for main actions with 4px rounded corners. Text is set in Public Sans for maximum legibility.
*   **Cards:** Defined by Surface Level 1 elevation with an 8px radius and a subtle neutral border.
*   **Input Fields:** Use a 1px neutral border that thickens or changes to Primary Blue on focus.
*   **Chips & Tags:** Utilize the Secondary Slate or Tertiary Purple colors with small, 4px rounded corners for categorization.
*   **Lists:** Clean, strictly aligned with the 8px spacing rhythm, using Inter for content and Public Sans for metadata labels.