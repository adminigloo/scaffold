/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text -- satori draws these; nobody browses them */
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { BYLINE, EYEBROW, LOGO, logoSize, PAGE_ROOM, QUOTE, SLIDE_FOOTER, SLIDE_HEADER, slideBody, type CardLayout, type CoverLayout, type CtaLayout, type Frame, type LineBlock, type ListLayout, type QuoteLayout, type StatLayout, type TextBlock } from "./layout.js";
import { cardDecor, cardLook, decorBox, decorSize, entranceOf } from "./looks.js";
import { cardAuthor, cardCharacter, cardLogo, type CardArt, type CardAssets, type CardDecor, type CardLook, type CardPage, type CardSpec, type CoverCardSpec, type CtaCardSpec, type ListCardSpec, type QuoteCardSpec, type StatCardSpec } from "./types.js";

/**
 * THE CARDS, AS SATORI DRAWS THEM: every box with more than one child is a
 * flex box, positions are absolute pixels from ./layout.ts, and the words are
 * set at the sizes ./layout.ts fitted them to.
 *
 * Plain by default: the ground, the words, the brand's mark and its accent.
 * `theme.flourish` adds the night-sky look (a faint star field, sparkles, a
 * star badge by the name); `theme.glow` a soft light behind a big number or
 * a picture. With no art the mark and the avatar are the brand's first
 * letter on its accent. A brand's whole logo (`brand.logo`), when it has one,
 * is the header instead of the mark and the name.
 *
 * A look (social 0.5) lays its pieces on the ground under the words, and may
 * put a picture behind the small capitals. For a video the card is also drawn
 * in parts: its ground alone (with any piece that doesn't move), its words
 * alone on nothing, and each piece on its own (`pieceElement`).
 */

/** The four-point sparkle. */
const SPARK = "M0 -1 L0.24 -0.24 L1 0 L0.24 0.24 L0 1 L-0.24 0.24 L-1 0 L-0.24 -0.24 Z";

/** A colour at no opacity, for a gradient that fades out without a grey fringe. */
export function fade(color: string): string {
  const rgba = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (rgba) {
    const [r = "0", g = "0", b = "0"] = rgba[1]!.split(",").map((s) => s.trim());
    return `rgba(${r}, ${g}, ${b}, 0)`;
  }
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  return hex ? `#${hex[1]}00` : "rgba(0, 0, 0, 0)";
}

/** A name's first letter or digit, upper case, for a mark with no art ("•" when it has none). */
export function initialOf(name: string): string {
  const first = [...name.trim()].find((ch) => /[\p{L}\p{N}]/u.test(ch));
  return first ? first.toLocaleUpperCase("en-US") : "•";
}

/** Which of a card's parts to draw: all of it, its ground alone, or its words alone. */
export type CardPart = "card" | "ground" | "words";

interface Ctx {
  readonly assets: CardAssets;
  readonly look: CardLook | undefined;
  readonly decor: readonly CardDecor[];
  readonly part: CardPart;
}

function Sparkle({ x, y, size, color, opacity = 1 }: { x: number; y: number; size: number; color: string; opacity?: number }) {
  return (
    <svg width={size} height={size} viewBox="-1 -1 2 2" style={{ position: "absolute", left: x - size / 2, top: y - size / 2, opacity }}>
      <path d={SPARK} fill={color} />
    </svg>
  );
}

/** The rosette with a star in it, beside the name (flourish only). */
function StarBadge({ size, color, ink }: { size: number; color: string; ink: string }) {
  const points: string[] = [];
  for (let i = 0; i < 24; i++) {
    const angle = (Math.PI * 2 * i) / 24 - Math.PI / 2;
    const r = i % 2 === 0 ? 1 : 0.84;
    points.push(`${(Math.cos(angle) * r).toFixed(4)} ${(Math.sin(angle) * r).toFixed(4)}`);
  }
  return (
    <svg width={size} height={size} viewBox="-1.12 -1.12 2.24 2.24">
      <path d={`M${points.join(" L")} Z`} fill={color} stroke={color} strokeWidth={0.16} strokeLinejoin="round" />
      <path d={SPARK} transform="scale(0.56)" fill={ink} />
    </svg>
  );
}

function Arrow({ color, width = 30 }: { color: string; width?: number }) {
  return (
    <svg width={width} height={(width * 16) / 30} viewBox="0 0 30 16">
      <path d="M1 8 H27 M20 1.5 L27.5 8 L20 14.5" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Picture({ art, height, style }: { art: CardArt; height: number; style?: CSSProperties }) {
  const width = Math.round((height * art.width) / art.height);
  return <img src={art.src} width={width} height={height} style={{ width, height, ...style }} />;
}

/** The brand's mark: its art, or its first letter on the accent in a rounded tile (a circle for an avatar). */
function Mark({ art, name, size, ctx, round = false }: { art: CardArt | undefined; name: string; size: number; ctx: Ctx; round?: boolean }) {
  if (art) return <img src={art.src} width={size} height={size} style={{ width: size, height: size, borderRadius: round ? size : 0 }} />;
  const { theme } = ctx.assets;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: round ? size : Math.round(size * 0.22),
        backgroundColor: theme.accent,
        color: theme.onAccent,
        fontFamily: ctx.assets.serif,
        fontSize: Math.round(size * 0.6),
        lineHeight: 1,
      }}
    >
      {initialOf(name)}
    </div>
  );
}

/** A soft light behind a number or a picture. */
function Glow({ cx, cy, radius, color }: { cx: number; cy: number; radius: number; color: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: cx - radius,
        top: cy - radius,
        width: radius * 2,
        height: radius * 2,
        display: "flex",
        backgroundImage: `radial-gradient(circle at 50% 50%, ${color} 0%, ${fade(color)} 70%)`,
      }}
    />
  );
}

/**
 * A faint night sky (flourish only): the same few dozen specks on every card
 * of a size (a fixed seed), brightest near the top, none near the bottom edge.
 */
function starDots(width: number, height: number, clear: readonly [number, number]): { x: number; y: number; r: string; opacity: string }[] {
  let seed = width * 31 + height;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const dots: { x: number; y: number; r: string; opacity: string }[] = [];
  for (let i = 0; i < 34; i++) {
    const x = Math.round(next() * width);
    const y = Math.round(next() ** 1.4 * height * 0.42);
    const r = 1 + next() * 1.8;
    const opacity = (0.08 + next() * 0.3) * (1 - y / (height * 0.5));
    if (y >= clear[0] && y <= clear[1]) continue;
    dots.push({ x, y, r: r.toFixed(2), opacity: opacity.toFixed(3) });
  }
  return dots;
}

function StarField({ frame, color }: { frame: Frame; color: string }) {
  return (
    <svg width={frame.width} height={frame.height} viewBox={`0 0 ${frame.width} ${frame.height}`} style={{ position: "absolute", left: 0, top: 0 }}>
      {starDots(frame.width, frame.height, [frame.top - 12, frame.top + SLIDE_HEADER + 12]).map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={color} opacity={d.opacity} />
      ))}
    </svg>
  );
}

/** One piece of a look, its centre `dx`, `dy` from where the card puts it (a piece drawn on its own is moved into its box). */
function Piece({ piece, assets, dx = 0, dy = 0 }: { piece: CardDecor; assets: CardAssets; dx?: number; dy?: number }) {
  const { width, height } = decorSize(piece);
  const place: CSSProperties = {
    position: "absolute",
    left: piece.x - width / 2 + dx,
    top: piece.y - height / 2 + dy,
    width,
    height,
    ...(piece.rotate ? { transform: `rotate(${piece.rotate}deg)` } : {}),
    ...(piece.opacity !== undefined && piece.opacity < 1 ? { opacity: Math.max(0, piece.opacity) } : {}),
  };
  switch (piece.kind) {
    case "art":
      return <img src={piece.art.src} width={width} height={height} style={place} />;
    case "ball":
      return (
        <div style={{ ...place, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: width, backgroundColor: piece.color }}>
          {piece.face ? (
            <img src={piece.face.src} width={width} height={height} style={{ position: "absolute", left: 0, top: 0, width, height }} />
          ) : piece.label ? (
            <div style={{ display: "flex", fontFamily: assets.sans, fontWeight: 700, fontSize: Math.round(width * 0.36), lineHeight: 1, letterSpacing: "-0.02em", color: piece.ink ?? assets.theme.onAccent }}>{piece.label}</div>
          ) : null}
        </div>
      );
    case "bit":
      return <div style={{ ...place, display: "flex", backgroundColor: piece.color, borderRadius: piece.shape === "rect" ? Math.max(2, Math.round(width * 0.16)) : width }} />;
  }
}

/**
 * The ground: its colour, its gradient, the star field, and the look's pieces
 * under the words. Drawn as the ground alone it keeps only the pieces that
 * don't move in a video (they come on as layers of their own); as the words
 * alone it has nothing behind them, so the video can lay them over the rest.
 */
function Ground({ frame, ctx, children }: { frame: Frame; ctx: Ctx; children?: ReactNode }) {
  const { assets, part } = ctx;
  const { theme } = assets;
  const behind = part !== "words";
  const pieces = part === "card" ? ctx.decor : part === "ground" ? ctx.decor.filter((p) => entranceOf(p) === "none") : [];
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        width: frame.width,
        height: frame.height,
        ...(behind ? { backgroundColor: theme.ground, ...(theme.groundImage ? { backgroundImage: theme.groundImage } : {}) } : {}),
        color: theme.text,
        fontFamily: assets.sans,
        overflow: "hidden",
      }}
    >
      {behind && theme.flourish ? <StarField frame={frame} color={theme.muted} /> : null}
      {pieces.map((piece, i) => (
        <Piece key={`decor-${i}`} piece={piece} assets={assets} />
      ))}
      {part === "ground" ? null : children}
    </div>
  );
}

/** One piece of a card's look, alone in its own box (`decorBox`), for a video to bring on by itself. */
export function pieceElement(piece: CardDecor, assets: CardAssets): { element: ReactElement; width: number; height: number } {
  const box = decorBox(piece);
  return {
    element: (
      <div style={{ position: "relative", display: "flex", width: box.width, height: box.height, overflow: "hidden" }}>
        <Piece piece={piece} assets={assets} dx={-box.left} dy={-box.top} />
      </div>
    ),
    width: box.width,
    height: box.height,
  };
}

/** Words fitted by ./layout.ts: one box per paragraph, wrapped by satori at the fitted size. */
function Words({ block, family, color, style, balance = true, align = "left" }: { block: TextBlock; family: string; color: string; style?: CSSProperties; balance?: boolean; align?: "left" | "center" }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "center" ? "center" : "flex-start",
        width: block.box.width,
        fontFamily: family,
        fontSize: block.size,
        lineHeight: block.box.lineHeight,
        color,
        ...style,
      }}
    >
      {block.text.split("\n").map((paragraph, i) => (
        <div key={i} style={{ display: "block", maxWidth: block.box.width, wordBreak: block.broken ? "break-word" : "normal", textAlign: align, ...(balance && !block.broken ? { textWrap: "balance" as const } : {}) }}>
          {paragraph}
        </div>
      ))}
    </div>
  );
}

function Line({ block, family, weight, color, style }: { block: LineBlock; family: string; weight?: number; color: string; style?: CSSProperties }) {
  return (
    <div style={{ display: "flex", fontFamily: family, ...(weight ? { fontWeight: weight } : {}), fontSize: block.size, lineHeight: 1.15, color, whiteSpace: "nowrap", ...style }}>
      {block.text}
    </div>
  );
}

function Eyebrow({ block, ctx, style }: { block: LineBlock | null; ctx: Ctx; style?: CSSProperties }) {
  if (!block) return null;
  const brush = ctx.look?.eyebrow;
  if (brush) {
    // The look's picture (a brush stroke) behind the small capitals, a little wider and taller than they are.
    const height = EYEBROW.size * 1.15;
    const padX = Math.round(block.size * 0.75);
    const padY = Math.round(block.size * 0.5);
    return (
      <div style={{ position: "relative", display: "flex", height, marginBottom: EYEBROW.gap - EYEBROW.size * 0.15, ...style }}>
        <img src={brush.art.src} width={block.measured + padX * 2} height={height + padY * 2} style={{ position: "absolute", left: -padX, top: -padY, width: block.measured + padX * 2, height: height + padY * 2 }} />
        <Line block={block} family={ctx.assets.sans} weight={700} color={brush.color ?? ctx.assets.theme.accent} style={{ letterSpacing: `${EYEBROW.tracking}em`, height }} />
      </div>
    );
  }
  return (
    <Line
      block={block}
      family={ctx.assets.sans}
      weight={700}
      color={ctx.assets.theme.accent}
      style={{ letterSpacing: `${EYEBROW.tracking}em`, height: EYEBROW.size * 1.15, marginBottom: EYEBROW.gap - EYEBROW.size * 0.15, ...style }}
    />
  );
}

function Logo({ art, size }: { art: CardArt; size: { width: number; height: number } }) {
  return <img src={art.src} width={size.width} height={size.height} style={{ width: size.width, height: size.height }} />;
}

function Header({ frame, ctx, page, wordmark }: { frame: Frame; ctx: Ctx; page?: CardPage; wordmark: LineBlock }) {
  const { assets } = ctx;
  // The whole logo stands on the header's centre line, so a taller one reaches into the gap under it, never the words.
  const logo = assets.brand.logo;
  const size = logo ? logoSize(logo, LOGO.header, frame.contentWidth - PAGE_ROOM) : null;
  const height = size ? Math.max(SLIDE_HEADER, size.height) : SLIDE_HEADER;
  return (
    <div style={{ position: "absolute", left: frame.left, top: frame.top - (height - SLIDE_HEADER) / 2, width: frame.contentWidth, height, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      {logo && size ? (
        <Logo art={logo} size={size} />
      ) : (
        <div style={{ display: "flex", alignItems: "center" }}>
          <Mark art={assets.brand.mark} name={assets.brand.name} size={56} ctx={ctx} />
          <Line block={wordmark} family={assets.serif} color={assets.theme.text} style={{ marginLeft: 16, lineHeight: 1 }} />
        </div>
      )}
      {page && page.count > 1 ? (
        <div style={{ display: "flex", alignItems: "center", fontWeight: 600, fontSize: 24, letterSpacing: "0.1em", color: assets.theme.muted }}>
          {`${page.index} / ${page.count}`}
        </div>
      ) : null}
    </div>
  );
}

function Footer({ frame, ctx, left, cue }: { frame: Frame; ctx: Ctx; left: LineBlock; cue?: string | null }) {
  const { theme } = ctx.assets;
  return (
    <div
      style={{
        position: "absolute",
        left: frame.left,
        top: frame.height - frame.bottom - SLIDE_FOOTER,
        width: frame.contentWidth,
        height: SLIDE_FOOTER,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", fontWeight: 600, letterSpacing: "0.02em", color: theme.muted }}>
        <div style={{ display: "flex", width: 30, height: 3, backgroundColor: theme.accent, marginRight: 14 }} />
        <Line block={left} family={ctx.assets.sans} weight={600} color={theme.muted} />
      </div>
      {cue ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: SLIDE_FOOTER,
            padding: "0 22px 0 26px",
            borderRadius: SLIDE_FOOTER / 2,
            border: `2.5px solid ${theme.accent}`,
            fontWeight: 700,
            fontSize: 24,
            letterSpacing: "0.04em",
            color: theme.accent,
          }}
        >
          <div style={{ display: "flex", marginRight: 12 }}>{cue}</div>
          <Arrow color={theme.accent} width={28} />
        </div>
      ) : null}
    </div>
  );
}

function QuoteCard({ spec, layout, ctx }: { spec: QuoteCardSpec; layout: QuoteLayout; ctx: Ctx }) {
  const { assets } = ctx;
  const { theme } = assets;
  const { frame } = layout;
  const width = frame.width - QUOTE.padX * 2;
  const footerTop = frame.height - QUOTE.bottom - QUOTE.footer;
  const author = cardAuthor(spec, assets);
  const logo = cardLogo(spec, assets);
  return (
    <Ground frame={frame} ctx={ctx}>
      {theme.flourish ? (
        <>
          <Sparkle x={frame.width - 150} y={150} size={34} color={theme.accent} opacity={0.9} />
          <Sparkle x={frame.width - 96} y={226} size={18} color={theme.accent} opacity={0.6} />
          <Sparkle x={frame.width - 210} y={262} size={12} color={theme.accent} opacity={0.45} />
        </>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: QUOTE.padX,
          top: QUOTE.top,
          width,
          height: footerTop - QUOTE.footerGap - QUOTE.top,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        {logo ? (
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: QUOTE.avatar }}>
            <Logo art={logo} size={logoSize(logo, LOGO.quote, width)} />
            <Line block={layout.handle} family={assets.sans} weight={500} color={theme.muted} style={{ marginTop: 6 }} />
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", padding: 5, borderRadius: QUOTE.avatar, border: `3px solid ${theme.accent}` }}>
              <Mark art={author.avatar} name={author.name} size={QUOTE.avatar - 16} ctx={ctx} round />
            </div>
            <div style={{ display: "flex", flexDirection: "column", marginLeft: 28 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <Line block={layout.name} family={assets.serif} color={theme.text} style={{ lineHeight: 1.1 }} />
                {theme.flourish ? (
                  <div style={{ display: "flex", marginLeft: 12 }}>
                    <StarBadge size={Math.round(layout.name.size * 0.8)} color={theme.accent} ink={theme.onAccent} />
                  </div>
                ) : null}
              </div>
              <Line block={layout.handle} family={assets.sans} weight={500} color={theme.muted} style={{ marginTop: 4 }} />
            </div>
          </div>
        )}
        <Words block={layout.text} family={assets.serif} color={theme.text} style={{ marginTop: QUOTE.gap, letterSpacing: "-0.005em" }} />
      </div>
      <div style={{ position: "absolute", left: QUOTE.padX, top: footerTop, width, height: QUOTE.footer, display: "flex", alignItems: "center" }}>
        <Mark art={assets.brand.mark} name={assets.brand.name} size={40} ctx={ctx} />
        <Line block={layout.site} family={assets.sans} weight={600} color={theme.muted} style={{ marginLeft: 14, letterSpacing: "0.02em" }} />
      </div>
    </Ground>
  );
}

function CoverCard({ spec, layout, ctx }: { spec: CoverCardSpec; layout: CoverLayout; ctx: Ctx }) {
  const { assets } = ctx;
  const { theme } = assets;
  const { frame } = layout;
  const body = slideBody(frame);
  const art = layout.art ? cardCharacter(spec, assets) : undefined;
  const artHeight = art ? layout.art : 0;
  const artWidth = art ? Math.round((artHeight * art.width) / art.height) : 0;
  const artTop = body.top + body.height - artHeight + 12;
  const artLeft = frame.left + (frame.contentWidth - artWidth) / 2;
  return (
    <Ground frame={frame} ctx={ctx}>
      {art && theme.glow ? <Glow cx={artLeft + artWidth / 2} cy={artTop + artHeight * 0.52} radius={artHeight * 0.78} color={theme.glow} /> : null}
      {art && theme.flourish ? (
        <>
          <Sparkle x={artLeft - 10} y={artTop + artHeight * 0.18} size={30} color={theme.accent} opacity={0.85} />
          <Sparkle x={artLeft + 50} y={artTop - 6} size={16} color={theme.accent} opacity={0.55} />
        </>
      ) : null}
      <Header frame={frame} ctx={ctx} page={spec.page} wordmark={layout.wordmark} />
      <div style={{ position: "absolute", left: frame.left, top: body.top, width: frame.contentWidth, display: "flex", flexDirection: "column" }}>
        <Eyebrow block={layout.eyebrow} ctx={ctx} />
        <Words block={layout.text} family={assets.serif} color={theme.text} style={{ letterSpacing: "-0.01em" }} />
        {layout.byline ? <Line block={layout.byline} family={assets.sans} weight={600} color={theme.accent} style={{ marginTop: BYLINE.gap, lineHeight: BYLINE.lineHeight, letterSpacing: "0.01em" }} /> : null}
      </div>
      {art ? <Picture art={art} height={artHeight} style={{ position: "absolute", left: artLeft, top: artTop }} /> : null}
      <Footer frame={frame} ctx={ctx} left={layout.footer} cue={spec.cue ?? "Swipe"} />
    </Ground>
  );
}

function StatCard({ spec, layout, ctx }: { spec: StatCardSpec; layout: StatLayout; ctx: Ctx }) {
  const { assets } = ctx;
  const { theme } = assets;
  const { frame } = layout;
  const body = slideBody(frame);
  return (
    <Ground frame={frame} ctx={ctx}>
      {theme.glow ? <Glow cx={frame.left + layout.value.size * 0.9} cy={body.top + body.height * 0.42} radius={Math.max(320, layout.value.size * 1.5)} color={theme.glow} /> : null}
      {theme.flourish ? (
        <>
          <Sparkle x={frame.width - frame.right - 30} y={body.top + 40} size={30} color={theme.accent} opacity={0.8} />
          <Sparkle x={frame.width - frame.right - 92} y={body.top + 98} size={14} color={theme.accent} opacity={0.5} />
        </>
      ) : null}
      <Header frame={frame} ctx={ctx} page={spec.page} wordmark={layout.wordmark} />
      <div style={{ position: "absolute", left: frame.left, top: body.top, width: frame.contentWidth, height: body.height, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <Eyebrow block={layout.eyebrow} ctx={ctx} />
        <Line block={layout.value} family={assets.serif} color={theme.accent} style={{ lineHeight: 1.02, letterSpacing: "-0.02em", marginLeft: -layout.value.size * 0.03 }} />
        <Words block={layout.text} family={assets.serif} color={theme.text} style={{ marginTop: 32 }} />
        {layout.note ? <Words block={layout.note} family={assets.sans} color={theme.muted} style={{ marginTop: 40, fontWeight: 500 }} balance={false} /> : null}
      </div>
      <Footer frame={frame} ctx={ctx} left={layout.footer} />
    </Ground>
  );
}

function Medal({ rank, size, ctx }: { rank: number; size: number; ctx: Ctx }) {
  const { theme } = ctx.assets;
  const fill = rank === 1 ? theme.accent : rank === 2 ? (theme.silver ?? theme.muted) : rank === 3 ? (theme.bronze ?? theme.faint) : theme.faint;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: fill,
        color: rank <= 3 ? theme.onAccent : theme.text,
        fontFamily: ctx.assets.serif,
        fontSize: Math.round(size * 0.56),
        lineHeight: 1,
      }}
    >
      {String(rank)}
    </div>
  );
}

function ListCard({ spec, layout, ctx }: { spec: ListCardSpec; layout: ListLayout; ctx: Ctx }) {
  const { assets } = ctx;
  const { theme } = assets;
  const { frame } = layout;
  const body = slideBody(frame);
  return (
    <Ground frame={frame} ctx={ctx}>
      {theme.flourish ? <Sparkle x={frame.width - frame.right - 30} y={body.top + 30} size={28} color={theme.accent} opacity={0.75} /> : null}
      <Header frame={frame} ctx={ctx} page={spec.page} wordmark={layout.wordmark} />
      <div style={{ position: "absolute", left: frame.left, top: body.top, width: frame.contentWidth, height: body.height, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <Eyebrow block={layout.eyebrow} ctx={ctx} />
        <Words block={layout.text} family={assets.serif} color={theme.text} style={{ letterSpacing: "-0.01em" }} />
        <div style={{ display: "flex", flexDirection: "column", marginTop: 40 }}>
          {layout.rows.map((row, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                height: layout.rowHeight,
                borderTop: `2px solid ${theme.faint}`,
                ...(i === layout.rows.length - 1 ? { borderBottom: `2px solid ${theme.faint}` } : {}),
              }}
            >
              {layout.medal ? (
                <div style={{ display: "flex", marginRight: 28 }}>
                  <Medal rank={i + 1} size={layout.medal} ctx={ctx} />
                </div>
              ) : null}
              <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, justifyContent: "center" }}>
                <Line block={row.label} family={assets.sans} weight={700} color={theme.text} />
                {row.detail ? <Line block={row.detail} family={assets.sans} weight={500} color={theme.muted} style={{ marginTop: 6 }} /> : null}
              </div>
              {row.value ? (
                <div style={{ display: "flex", justifyContent: "flex-end", width: layout.valueWidth, marginLeft: 24 }}>
                  <Line block={row.value} family={assets.serif} color={theme.accent} style={{ lineHeight: 1 }} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {layout.note ? <Words block={layout.note} family={assets.sans} color={theme.muted} style={{ marginTop: 28, fontWeight: 500 }} balance={false} /> : null}
      </div>
      <Footer frame={frame} ctx={ctx} left={layout.footer} />
    </Ground>
  );
}

function CtaCard({ spec, layout, ctx }: { spec: CtaCardSpec; layout: CtaLayout; ctx: Ctx }) {
  const { assets } = ctx;
  const { theme } = assets;
  const { frame } = layout;
  const body = slideBody(frame);
  const art = layout.art ? cardCharacter(spec, assets) : undefined;
  const artHeight = art ? layout.art : 0;
  const artWidth = art ? Math.round((artHeight * art.width) / art.height) : 0;
  const block = (layout.eyebrow ? EYEBROW.size + EYEBROW.gap : 0) + (art ? artHeight + 36 : 0) + layout.site.size * 1.1 + 32 + layout.button.size * 1.2 + 56 + (layout.note ? layout.note.height + 32 : 0);
  const top = body.top + Math.max(0, (body.height - block) / 2);
  const center = frame.left + frame.contentWidth / 2;
  return (
    <Ground frame={frame} ctx={ctx}>
      {art && theme.glow ? <Glow cx={center} cy={top + artHeight * 0.5} radius={artHeight * 0.8} color={theme.glow} /> : null}
      {art && theme.flourish ? (
        <>
          <Sparkle x={center - artWidth / 2 - 20} y={top + artHeight * 0.3} size={30} color={theme.accent} opacity={0.85} />
          <Sparkle x={center + artWidth / 2 + 16} y={top + artHeight * 0.16} size={20} color={theme.accent} opacity={0.6} />
        </>
      ) : null}
      <Header frame={frame} ctx={ctx} page={spec.page} wordmark={layout.wordmark} />
      <div style={{ position: "absolute", left: frame.left, top, width: frame.contentWidth, display: "flex", flexDirection: "column", alignItems: "center" }}>
        {art ? <Picture art={art} height={artHeight} style={{ marginBottom: 36 }} /> : null}
        <Eyebrow block={layout.eyebrow} ctx={ctx} />
        <Line block={layout.site} family={assets.serif} color={theme.text} style={{ lineHeight: 1.1, letterSpacing: "-0.01em" }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: 32,
            height: Math.round(layout.button.size * 1.2 + 56),
            padding: "0 44px",
            borderRadius: 999,
            backgroundColor: theme.button ?? theme.accent,
            color: theme.onButton ?? theme.onAccent,
          }}
        >
          <Line block={layout.button} family={assets.sans} weight={700} color={theme.onButton ?? theme.onAccent} />
        </div>
        {layout.note ? <Words block={layout.note} family={assets.sans} color={theme.muted} style={{ marginTop: 32, fontWeight: 500 }} align="center" /> : null}
      </div>
      <Footer frame={frame} ctx={ctx} left={layout.footer} />
    </Ground>
  );
}

/** The card as a satori element: all of it, or (for a video) its ground or its words alone. */
export function cardElement(spec: CardSpec, layout: CardLayout, assets: CardAssets, part: CardPart = "card"): ReactElement {
  const ctx: Ctx = { assets, look: cardLook(spec, assets), decor: cardDecor(spec, assets), part };
  if (part === "ground") return <Ground frame={layout.frame} ctx={ctx} />;
  if (spec.kind === "quote" && layout.kind === "quote") return <QuoteCard spec={spec} layout={layout} ctx={ctx} />;
  if (spec.kind === "cover" && layout.kind === "cover") return <CoverCard spec={spec} layout={layout} ctx={ctx} />;
  if (spec.kind === "stat" && layout.kind === "stat") return <StatCard spec={spec} layout={layout} ctx={ctx} />;
  if (spec.kind === "list" && layout.kind === "list") return <ListCard spec={spec} layout={layout} ctx={ctx} />;
  if (spec.kind === "cta" && layout.kind === "cta") return <CtaCard spec={spec} layout={layout} ctx={ctx} />;
  throw new Error(`A ${spec.kind} card was laid out as a ${layout.kind} card.`);
}
