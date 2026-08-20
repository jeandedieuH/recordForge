import type {
  OverlayDisplayItem,
  OverlayDisplayList,
  OverlayTransform,
} from "@recordforge/contracts"

export interface OverlayCanvasRenderOptions {
  assetUrls?: Readonly<Record<string, string>>
  imageCache?: Map<string, HTMLImageElement>
  onImageLoad?: () => void
}

export function renderOverlayDisplayList(
  displayList: OverlayDisplayList,
  canvas: HTMLCanvasElement,
  options: OverlayCanvasRenderOptions = {},
): void {
  const context = canvas.getContext("2d")
  if (!context) throw new Error("2D canvas context is unavailable")

  context.clearRect(0, 0, canvas.width, canvas.height)
  for (const item of displayList.items) renderDisplayItem(context, item, options)
}

function renderDisplayItem(
  context: CanvasRenderingContext2D,
  item: OverlayDisplayItem,
  options: OverlayCanvasRenderOptions,
): void {
  if (item.kind === "annotation") {
    renderAnnotation(context, item, options)
    return
  }
  if (item.kind === "text") {
    renderText(context, item, options)
    return
  }
  renderImage(context, item, options)
}

function renderAnnotation(
  context: CanvasRenderingContext2D,
  item: Extract<OverlayDisplayItem, { kind: "annotation" }>,
  _options: OverlayCanvasRenderOptions,
): void {
  const { transform } = item
  context.save()
  applyTransform(context, transform)
  context.globalAlpha *= item.drawProgress
  context.lineWidth = item.strokeWidth
  context.strokeStyle = item.strokeColor
  context.fillStyle = item.fillColor
  context.setLineDash(strokeDash(item.strokeStyle, item.strokeWidth))
  applyShadow(context, item.shadowEnabled, item.shadowColor, item.shadowBlur)

  if (item.annotationType === "spotlight") {
    renderSpotlight(context, item)
    context.restore()
    return
  }

  if (item.annotationType === "arrow" || item.annotationType === "line") {
    const startX = transform.x
    const startY = transform.y
    const endX = item.endX ?? transform.x + transform.width
    const endY = item.endY ?? transform.y + transform.height
    const dx = endX - startX
    const dy = endY - startY
    const len = Math.hypot(dx, dy)

    if (len > 0.001) {
      const headSize = Math.max(10, item.strokeWidth * 3.5)
      const startOffset =
        item.arrowStartHead !== "none"
          ? Math.min(len * 0.45, item.arrowStartHead === "circle" ? headSize / 2 : headSize * 0.7)
          : 0
      const endOffset =
        item.arrowEndHead !== "none"
          ? Math.min(len * 0.45, item.arrowEndHead === "circle" ? headSize / 2 : headSize * 0.7)
          : 0

      const ux = dx / len
      const uy = dy / len

      context.beginPath()
      context.moveTo(startX + ux * startOffset, startY + uy * startOffset)
      context.lineTo(endX - ux * endOffset, endY - uy * endOffset)
      context.stroke()

      drawArrowHead(context, item.arrowStartHead, startX, startY, endX, endY)
      drawArrowHead(context, item.arrowEndHead, endX, endY, startX, startY)
    }
    context.restore()
    return
  }

  const path = new Path2D()
  if (item.annotationType === "circle") {
    path.ellipse(
      transform.x + transform.width / 2,
      transform.y + transform.height / 2,
      transform.width / 2,
      transform.height / 2,
      0,
      0,
      Math.PI * 2,
    )
  } else {
    appendRoundedRect(
      path,
      transform.x,
      transform.y,
      transform.width,
      transform.height,
      item.annotationType === "rounded-rect" || item.annotationType === "callout"
        ? item.cornerRadius
        : item.annotationType === "badge"
          ? Math.min(8, transform.height / 2)
          : 0,
    )
  }
  context.fillStyle = withOpacity(item.fillColor, item.fillOpacity)
  context.fill(path)
  context.stroke(path)

  if ((item.annotationType === "callout" || item.annotationType === "badge") && item.text) {
    context.setLineDash([])
    context.fillStyle = item.textColor
    context.font = `700 ${item.fontSize}px ${fontFamily("sans")}`
    context.textAlign = "center"
    context.textBaseline = "middle"
    const maxLineWidth = Math.max(
      20,
      transform.width - (item.annotationType === "badge" ? 24 : item.fontSize * 1.5),
    )
    const lines = wrapTextToLines(item.text, maxLineWidth, (str) =>
      typeof context.measureText === "function"
        ? context.measureText(str).width
        : str.length * item.fontSize * 0.6,
    )
    const lineHeight = item.fontSize * 1.25
    const totalHeight = (lines.length - 1) * lineHeight
    const startY = transform.y + transform.height / 2 - totalHeight / 2
    lines.forEach((line, index) => {
      context.fillText(
        line,
        transform.x + transform.width / 2,
        startY + index * lineHeight,
      )
    })
  }
  context.restore()
}

function renderSpotlight(
  context: CanvasRenderingContext2D,
  item: Extract<OverlayDisplayItem, { kind: "annotation" }>,
): void {
  const { transform } = item
  const centerX = transform.x + transform.width / 2
  const centerY = transform.y + transform.height / 2
  context.save()
  context.fillStyle = withOpacity(item.fillColor, item.fillOpacity)
  context.fillRect(0, 0, context.canvas.width, context.canvas.height)
  context.globalCompositeOperation = "destination-out"
  context.beginPath()
  context.ellipse(centerX, centerY, transform.width / 2, transform.height / 2, 0, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

function renderText(
  context: CanvasRenderingContext2D,
  item: Extract<OverlayDisplayItem, { kind: "text" }>,
  _options: OverlayCanvasRenderOptions,
): void {
  const { transform } = item
  context.save()
  applyTransform(context, transform)
  context.shadowColor = "transparent"
  context.shadowBlur = 0
  context.textBaseline = "top"

  const paddingX = Math.min(transform.width / 3, item.backdropPaddingX)
  const paddingY = Math.min(transform.height / 3, item.backdropPaddingY)
  const radius =
    item.backdropStyle === "pill"
      ? transform.height / 2
      : Math.min(transform.height / 2, item.backdropBorderRadius)

  if (item.backdropStyle !== "none") {
    const backdropPath = new Path2D()
    appendRoundedRect(
      backdropPath,
      transform.x,
      transform.y,
      transform.width,
      transform.height,
      radius,
    )
    context.fillStyle = withOpacity(item.backdropColor, item.backdropOpacity)
    applyShadow(context, item.shadowEnabled, item.shadowColor, item.shadowBlur)
    context.fill(backdropPath)
    context.shadowColor = "transparent"
    context.shadowBlur = 0

    if (item.backdropStyle === "outline" || item.backdropStyle === "glass") {
      context.strokeStyle = withOpacity(item.accentColor, 0.35)
      context.lineWidth = 1
      context.stroke(backdropPath)
    }
    if (item.backdropStyle === "accent-bar") {
      context.fillStyle = item.accentColor
      const barW = Math.max(3, Math.min(8, paddingX / 2))
      context.fillRect(transform.x, transform.y, barW, transform.height)
    }
  }

  // Clip text to backdrop card bounds
  clipRoundedRect(context, transform, radius)

  const textX = textPositionX(item.alignment, transform.x, transform.width, paddingX)
  context.textAlign = item.alignment

  const usableWidth = Math.max(20, transform.width - paddingX * 2)
  const availableH = Math.max(10, transform.height - paddingY * 2)

  // Initial base font sizes & metrics
  const basePrimaryFs = Math.max(12, Math.min(120, item.fontSize))
  const basePrimaryLineHeight = basePrimaryFs * 1.25
  const primaryText = revealText(item.primaryText, item.textProgress)
  const basePrimaryLines = wrapTextToLines(primaryText, usableWidth, (str) =>
    typeof context.measureText === "function"
      ? context.measureText(str).width
      : str.length * basePrimaryFs * 0.58,
  )
  const basePrimaryH = basePrimaryLines.length * basePrimaryLineHeight

  // Optional tag
  const hasTag = Boolean(item.tagText?.trim())
  const baseTagFs = Math.max(10, Math.min(18, Math.round(basePrimaryFs * 0.35)))
  const baseTagLineHeight = baseTagFs * 1.2
  const baseTagGap = 6
  const baseTagH = hasTag ? baseTagLineHeight + baseTagGap : 0

  // Optional secondary subtitle
  const hasSub = Boolean(item.secondaryText?.trim())
  const baseSubFs = Math.max(11, Math.min(48, Math.round(basePrimaryFs * 0.55)))
  const baseSubLineHeight = baseSubFs * 1.3
  const baseSubtitleGap = 5
  const baseSubLines =
    hasSub && item.secondaryText
      ? wrapTextToLines(item.secondaryText, usableWidth, (str) =>
          typeof context.measureText === "function"
            ? context.measureText(str).width
            : str.length * baseSubFs * 0.58,
        )
      : []
  const baseSubH =
    hasSub && baseSubLines.length > 0
      ? baseSubLines.length * baseSubLineHeight + baseSubtitleGap
      : 0

  const initialTotalContentH = baseTagH + basePrimaryH + baseSubH

  // Determine scale factor if autoScaleText is enabled
  const scale =
    item.autoScaleText && initialTotalContentH > availableH && initialTotalContentH > 0
      ? Math.min(1, Math.max(0.55, availableH / initialTotalContentH))
      : 1

  let primaryFs = basePrimaryFs
  let primaryLineHeight = basePrimaryLineHeight
  let primaryLines = basePrimaryLines
  let primaryH = basePrimaryH

  let tagFs = baseTagFs
  let tagLineHeight = baseTagLineHeight
  let tagGap = baseTagGap

  let subFs = baseSubFs
  let subLineHeight = baseSubLineHeight
  let subtitleGap = baseSubtitleGap
  let secondaryLines = baseSubLines
  let subH = baseSubH

  if (Math.abs(scale - 1) > 0.001) {
    primaryFs = Math.max(10, Math.min(120, basePrimaryFs * scale))
    primaryLineHeight = primaryFs * 1.25
    primaryLines = wrapTextToLines(primaryText, usableWidth, (str) =>
      typeof context.measureText === "function"
        ? context.measureText(str).width
        : str.length * primaryFs * 0.58,
    )
    primaryH = primaryLines.length * primaryLineHeight

    tagFs = Math.max(9, Math.min(18, Math.round(primaryFs * 0.35)))
    tagLineHeight = tagFs * 1.2
    tagGap = baseTagGap * scale

    subFs = Math.max(9, Math.min(48, Math.round(primaryFs * 0.55)))
    subLineHeight = subFs * 1.3
    subtitleGap = baseSubtitleGap * scale
    secondaryLines =
      hasSub && item.secondaryText
        ? wrapTextToLines(item.secondaryText, usableWidth, (str) =>
            typeof context.measureText === "function"
              ? context.measureText(str).width
              : str.length * subFs * 0.58,
          )
        : []
    subH =
      hasSub && secondaryLines.length > 0
        ? secondaryLines.length * subLineHeight + subtitleGap
        : 0
  }

  const tagH = hasTag ? tagLineHeight + tagGap : 0
  const totalContentH = tagH + primaryH + subH

  // Vertically center inside card
  let currentY =
    totalContentH < transform.height
      ? Math.max(transform.y + paddingY, transform.y + (transform.height - totalContentH) / 2)
      : transform.y + paddingY

  // 1. Render tag text at top
  if (hasTag && item.tagText) {
    context.fillStyle = item.accentColor
    context.font = `700 ${tagFs}px ${fontFamily(item.fontFamily)}`
    context.fillText(item.tagText.toUpperCase(), textX, currentY)
    currentY += tagLineHeight + tagGap
  }

  // 2. Render primary text
  context.fillStyle = item.textColor
  context.font = `${item.fontWeight} ${primaryFs}px ${fontFamily(item.fontFamily)}`
  for (const line of primaryLines) {
    context.fillText(line, textX, currentY)
    currentY += primaryLineHeight
  }

  // 3. Render secondary text
  if (hasSub && secondaryLines.length > 0) {
    currentY += subtitleGap
    context.fillStyle = item.secondaryTextColor
    context.font = `500 ${subFs}px ${fontFamily(item.fontFamily)}`
    for (const line of secondaryLines) {
      context.fillText(line, textX, currentY)
      currentY += subLineHeight
    }
  }

  context.restore()
}

function renderImage(
  context: CanvasRenderingContext2D,
  item: Extract<OverlayDisplayItem, { kind: "image" }>,
  options: OverlayCanvasRenderOptions,
): void {
  const { transform } = item
  context.save()
  applyTransform(context, transform)
  applyShadow(context, item.shadowEnabled, item.shadowColor, item.shadowBlur)

  const imageUrl = options.assetUrls?.[item.assetId]
  const image = imageUrl
    ? getImage(imageUrl, options.imageCache ?? new Map(), options.onImageLoad)
    : null
  if (image?.complete && image.naturalWidth > 0) {
    clipRoundedRect(context, transform, item.borderRadius)
    drawImageWithFit(context, image, transform, item.fit)
    context.restore()
    drawImageBorder(context, transform, item)
    return
  }

  context.fillStyle = "rgba(34, 211, 238, 0.16)"
  const placeholderPath = new Path2D()
  appendRoundedRect(
    placeholderPath,
    transform.x,
    transform.y,
    transform.width,
    transform.height,
    item.borderRadius,
  )
  context.fill(placeholderPath)
  context.restore()
  drawImageBorder(context, transform, item)
}

function getImage(
  url: string,
  cache: Map<string, HTMLImageElement>,
  onImageLoad?: () => void,
): HTMLImageElement | null {
  const cached = cache.get(url)
  if (cached) return cached
  if (typeof Image === "undefined") return null
  const image = new Image()
  image.decoding = "async"
  image.onload = () => onImageLoad?.()
  image.onerror = () => onImageLoad?.()
  image.src = url
  cache.set(url, image)
  return image
}

function drawImageWithFit(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  transform: OverlayTransform,
  fit: "contain" | "cover" | "fill",
): void {
  if (fit === "fill") {
    context.drawImage(image, transform.x, transform.y, transform.width, transform.height)
    return
  }
  const sourceRatio = image.naturalWidth / Math.max(1, image.naturalHeight)
  const targetRatio = transform.width / Math.max(1, transform.height)
  const isCover = fit === "cover"
  const drawWidth = isCover
    ? targetRatio > sourceRatio
      ? transform.width
      : transform.height * sourceRatio
    : targetRatio > sourceRatio
      ? transform.height * sourceRatio
      : transform.width
  const drawHeight = isCover
    ? targetRatio > sourceRatio
      ? transform.width / sourceRatio
      : transform.height
    : targetRatio > sourceRatio
      ? transform.height
      : transform.width / sourceRatio
  const x = transform.x + (transform.width - drawWidth) / 2
  const y = transform.y + (transform.height - drawHeight) / 2
  context.drawImage(image, x, y, drawWidth, drawHeight)
}

function drawImageBorder(
  context: CanvasRenderingContext2D,
  transform: OverlayTransform,
  item: Extract<OverlayDisplayItem, { kind: "image" }>,
): void {
  if (item.borderWidth <= 0) return
  context.save()
  applyTransform(context, transform)
  context.lineWidth = item.borderWidth
  context.strokeStyle = item.borderColor
  context.setLineDash([])
  const path = new Path2D()
  appendRoundedRect(
    path,
    transform.x,
    transform.y,
    transform.width,
    transform.height,
    item.borderRadius,
  )
  context.stroke(path)
  context.restore()
}

function applyTransform(context: CanvasRenderingContext2D, transform: OverlayTransform): void {
  const anchorX = transform.x + transform.width * transform.anchorX
  const anchorY = transform.y + transform.height * transform.anchorY
  context.translate(anchorX, anchorY)
  context.rotate((transform.rotation * Math.PI) / 180)
  context.translate(-anchorX, -anchorY)
  context.globalAlpha *= transform.opacity
}

function applyShadow(
  context: CanvasRenderingContext2D,
  enabled: boolean,
  color: string,
  blur: number,
): void {
  context.shadowColor = enabled ? color : "transparent"
  context.shadowBlur = enabled ? blur : 0
  context.shadowOffsetX = 0
  context.shadowOffsetY = enabled ? blur / 2 : 0
}

function clipRoundedRect(
  context: CanvasRenderingContext2D,
  transform: OverlayTransform,
  radius: number,
): void {
  if (typeof context.clip !== "function") return
  const path = new Path2D()
  appendRoundedRect(path, transform.x, transform.y, transform.width, transform.height, radius)
  context.clip(path)
}

function appendRoundedRect(
  path: Path2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(Math.max(0, radius), Math.min(width, height) / 2)
  path.moveTo(x + safeRadius, y)
  path.lineTo(x + width - safeRadius, y)
  path.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  path.lineTo(x + width, y + height - safeRadius)
  path.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  path.lineTo(x + safeRadius, y + height)
  path.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  path.lineTo(x, y + safeRadius)
  path.quadraticCurveTo(x, y, x + safeRadius, y)
  path.closePath()
}

function strokeDash(style: "solid" | "dashed" | "dotted", width: number): number[] {
  if (style === "dashed") return [width * 4, width * 3]
  if (style === "dotted") return [width, width * 2]
  return []
}

function drawArrowHead(
  context: CanvasRenderingContext2D,
  head: "none" | "arrow" | "circle" | "diamond",
  x: number,
  y: number,
  towardX: number,
  towardY: number,
): void {
  if (head === "none") return
  const angle = Math.atan2(towardY - y, towardX - x)
  const size = Math.max(10, context.lineWidth * 3.5)
  context.save()
  context.setLineDash([])
  if (head === "circle") {
    context.beginPath()
    context.arc(x, y, size / 2, 0, Math.PI * 2)
    context.fillStyle = context.strokeStyle
    context.fill()
  } else if (head === "diamond") {
    context.translate(x, y)
    context.rotate(angle)
    context.beginPath()
    context.moveTo(0, 0)
    context.lineTo(size * 0.75, size * 0.45)
    context.lineTo(size * 1.5, 0)
    context.lineTo(size * 0.75, -size * 0.45)
    context.closePath()
    context.fillStyle = context.strokeStyle
    context.fill()
  } else {
    // Standard arrow head pointing outward from (x, y) away from (towardX, towardY)
    context.translate(x, y)
    context.rotate(angle)
    context.beginPath()
    context.moveTo(0, 0)
    context.lineTo(size, size * 0.5)
    context.lineTo(size * 0.75, 0)
    context.lineTo(size, -size * 0.5)
    context.closePath()
    context.fillStyle = context.strokeStyle
    context.fill()
  }
  context.restore()
}

function withOpacity(color: string, opacity: number): string {
  if (opacity >= 1) return color
  if (color.startsWith("#")) {
    const hex = color.slice(1)
    const expanded =
      hex.length === 3
        ? hex
            .split("")
            .map((part) => part + part)
            .join("")
        : hex
    if (expanded.length === 6) {
      const red = Number.parseInt(expanded.slice(0, 2), 16)
      const green = Number.parseInt(expanded.slice(2, 4), 16)
      const blue = Number.parseInt(expanded.slice(4, 6), 16)
      return `rgba(${red}, ${green}, ${blue}, ${opacity})`
    }
  }
  return color
}

function fontFamily(family: string): string {
  if (family === "serif") return '"Source Serif 4", Georgia, serif'
  if (family === "mono") return '"JetBrains Mono", Consolas, monospace'
  if (family === "heading" || family === "outfit") return "Outfit, Inter, sans-serif"
  return "Inter, Segoe UI, sans-serif"
}

function textPositionX(
  alignment: "left" | "center" | "right",
  x: number,
  width: number,
  padding: number,
): number {
  if (alignment === "center") return x + width / 2
  if (alignment === "right") return x + width - padding
  return x + padding
}

function revealText(text: string, progress: number): string {
  if (progress >= 1) return text
  if (progress <= 0) return ""
  return text.slice(0, Math.max(0, Math.ceil(text.length * progress)))
}

export function wrapTextToLines(
  text: string,
  maxWidth: number,
  measureWidth?: (line: string) => number,
): string[] {
  if (!text) return []
  const paragraphs = text.split(/\r?\n/)
  const result: string[] = []

  for (const paragraph of paragraphs) {
    if (!paragraph || maxWidth <= 0 || !measureWidth) {
      result.push(paragraph)
      continue
    }

    const words = paragraph.split(" ")
    let currentLine = ""

    for (const word of words) {
      if (!currentLine) {
        currentLine = word
        continue
      }
      const testLine = `${currentLine} ${word}`
      if (measureWidth(testLine) <= maxWidth) {
        currentLine = testLine
      } else {
        result.push(currentLine)
        currentLine = word
      }
    }
    if (currentLine) {
      result.push(currentLine)
    }
  }

  return result
}
