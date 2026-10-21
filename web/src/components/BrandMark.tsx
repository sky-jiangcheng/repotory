// BrandMark — the Repotory mark, drawn from the same construction as the
// brand SSOT (build/icon.svg) that generates the app icon, favicons and the
// VS Code extension icon.
//
// Why this exists: the navbar used a "▦" text glyph while every shipped
// artifact carried a different mark. Same product, two identities — and the
// glyph also inherited font metrics, so it shifted with the system font and
// broke at large sizes. One component, used everywhere in the app, keeps the
// UI on the same mark as the icon in the dock.
//
// The field is a single flat ink and the letter one fill: a gradient plus an
// inner bevel was what made the previous mark read as stock app-icon chrome.

interface Props {
  /** Rendered width/height in px. The mark is square. */
  size?: number
  className?: string
  /** Accessible name. Omit when an adjacent text label already names the product. */
  title?: string
}

export default function BrandMark({ size = 22, className, title }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <rect width="512" height="512" rx="116" fill="#0F2244" />
      {/* Same geometry as build/icon.svg — a filled R at a 320-unit cap
          height, shifted 6 right / 2 up because an R is heavier on the stem
          side and bounding-box centring reads left-heavy. The letterform is
          the R from IBM Plex Sans Bold (© IBM Corp., SIL OFL 1.1), outlined.
          Process: outputs/icon-redesign-v4. */}
      <g transform="translate(21.06 13.06) scale(0.941176)">
        <path
          fill="#F6F8FC"
          fillRule="nonzero"
          d="M195.6 426H121.56V86H282.79Q306.17 86 325.17 93.79Q344.17 101.59 357.56 115.96Q370.96 130.33 378.26 150.3Q385.57 170.27 385.57 194.62Q385.57 229.21 370.23 255.03Q354.88 280.84 323.71 292.53L390.44 426H308.12L248.69 301.3H195.6ZM273.54 238.95Q290.1 238.95 299.6 230.43Q309.09 221.9 309.09 205.34V183.91Q309.09 167.35 299.6 158.82Q290.1 150.3 273.54 150.3H195.6V238.95Z"
        />
      </g>
    </svg>
  )
}
