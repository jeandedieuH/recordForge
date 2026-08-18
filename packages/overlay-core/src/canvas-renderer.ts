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
    context.fillText(
      item.text,
      transform.x + transform.width / 2,
      transform.y + transform.height / 2,
      Math.max(1, transform.width - item.fontSize),
    )
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

  const paddingX = item.backdropPaddingX
  const paddingY = item.backdropPaddingY
  if (item.backdropStyle !== "none") {
    const backdropPath = new Path2D()
    appendRoundedRect(
      backdropPath,
      transform.x,
      transform.y,
      transform.width,
      transform.height,
      item.backdropBorderRadius,
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
      context.fillRect(transform.x, transform.y, Math.max(2, paddingX / 2), transform.height)
    }
  }

  const textX = textPositionX(item.alignment, transform.x, transform.width, paddingX)
  context.textAlign = item.alignment
  context.fillStyle = item.textColor
  context.font = `${item.fontWeight} ${item.fontSize}px ${fontFamily(item.fontFamily)}`
  const primaryText = revealText(item.primaryText, item.textProgress)
  context.fillText(
    primaryText,
    textX,
    transform.y + paddingY,
    Math.max(1, transform.width - paddingX * 2),
  )

  let nextY = transform.y + paddingY + item.fontSize * 1.2
  if (item.secondaryText) {
    context.fillStyle = item.secondaryTextColor
    context.font = `${Math.max(12, Math.round(item.fontSize * 0.55))}px ${fontFamily(item.fontFamily)}`
    context.fillText(item.secondaryText, textX, nextY, Math.max(1, transform.width - paddingX * 2))
    nextY += Math.max(12, Math.round(item.fontSize * 0.55)) * 1.25
  }

  if (item.tagText) {
    context.fillStyle = item.accentColor
    context.font = `700 ${Math.max(10, Math.round(item.fontSize * 0.4))}px ${fontFamily("sans")}`
    context.fillText(
      item.tagText.toUpperCase(),
      textX,
      nextY,
      Math.max(1, transform.width - paddingX * 2),
    )
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
  if (family === "serif") return '"Source Serif 4", serif'
  if (family === "mono") return '"JetBrains Mono", monospace'
  if (family === "heading") return "Outfit, sans-serif"
  return "Inter, sans-serif"
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
