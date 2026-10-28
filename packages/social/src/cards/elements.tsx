/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text -- satori draws these; nobody browses them */
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { EYEBROW, QUOTE, SLIDE_FOOTER, SLIDE_HEADER, slideBody, type CardLayout, type CoverLayout, type CtaLayout, type Frame, type LineBlock, type ListLayout, type QuoteLayout, type StatLayout, type TextBlock } from "./layout.js";
import type { CardArt, CardAssets, CardPage, CardSpec, CoverCardSpec, CtaCardSpec, ListCardSpec, QuoteCardSpec, StatCardSpec } from "./types.js";

/**
 * THE CARDS, AS SATORI DRAWS THEM: every box with more than one child is a
 * flex box, positions are absolute pixels from ./layout.ts, and the words are
 * set at the sizes ./layout.ts fitted them to.
 *
 * Plain by default: the ground, the words, the brand's mark and its accent.
 * `theme.flourish` adds the night-sky look (a faint star field, sparkles, a
 * star badge by the name); `theme.glow` a soft light behind a big number or
 * a picture. With no art the mark and the avatar are the brand's first
 * letter on its accent.
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

interface Ctx {
  readonly assets: CardAssets;
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

function Ground({ frame, assets, children }: { frame: Frame; assets: CardAssets; children: ReactNode }) {
  const { theme } = assets;
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        width: frame.width,
        height: frame.height,
        backgroundColor: theme.ground,
        ...(theme.groundImage ? { backgroundImage: theme.groundImage } : {}),
        color: theme.text,
        fontFamily: assets.sans,
        overflow: "hidden",
      }}
    >
      {theme.flourish ? <StarField frame={frame} color={theme.muted} /> : null}
      {children}
    </div>
  );
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

function Header({ frame, ctx, page, wordmark }: { frame: Frame; ctx: Ctx; page?: CardPage; wordmark: LineBlock }) {
  const { assets } = ctx;
  return (
    <div style={{ position: "absolute", left: frame.left, top: frame.top, width: frame.contentWidth, height: SLIDE_HEADER, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <Mark art={assets.brand.mark} name={assets.brand.name} size={56} ctx={ctx} />
        <Line block={wordmark} family={assets.serif} color={assets.theme.text} style={{ marginLeft: 16, lineHeight: 1 }} />
      </div>
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
  void spec;
  return (
    <Ground frame={frame} assets={assets}>
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
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", padding: 5, borderRadius: QUOTE.avatar, border: `3px solid ${theme.accent}` }}>
            <Mark art={assets.author.avatar} name={assets.author.name} size={QUOTE.avatar - 16} ctx={ctx} round />
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
  const art = spec.character && layout.art ? assets.characters?.[spec.character] : undefined;
  const artHeight = art ? layout.art : 0;
  const artWidth = art ? Math.round((artHeight * art.width) / art.height) : 0;
  const artTop = body.top + body.height - artHeight + 12;
  const artLeft = frame.left + (frame.contentWidth - artWidth) / 2;
  return (
    <Ground frame={frame} assets={assets}>
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
    <Ground frame={frame} assets={assets}>
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
    <Ground frame={frame} assets={assets}>
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
  const art = spec.character && layout.art ? assets.characters?.[spec.character] : undefined;
  const artHeight = art ? layout.art : 0;
  const artWidth = art ? Math.round((artHeight * art.width) / art.height) : 0;
  const block = (layout.eyebrow ? EYEBROW.size + EYEBROW.gap : 0) + (art ? artHeight + 36 : 0) + layout.site.size * 1.1 + 32 + layout.button.size * 1.2 + 56 + (layout.note ? layout.note.height + 32 : 0);
  const top = body.top + Math.max(0, (body.height - block) / 2);
  const center = frame.left + frame.contentWidth / 2;
  return (
    <Ground frame={frame} assets={assets}>
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
            backgroundColor: theme.accent,
            color: theme.onAccent,
          }}
        >
          <Line block={layout.button} family={assets.sans} weight={700} color={theme.onAccent} />
        </div>
        {layout.note ? <Words block={layout.note} family={assets.sans} color={theme.muted} style={{ marginTop: 32, fontWeight: 500 }} align="center" /> : null}
      </div>
      <Footer frame={frame} ctx={ctx} left={layout.footer} />
    </Ground>
  );
}

/** The card as a satori element. */
export function cardElement(spec: CardSpec, layout: CardLayout, assets: CardAssets): ReactElement {
  const ctx: Ctx = { assets };
  if (spec.kind === "quote" && layout.kind === "quote") return <QuoteCard spec={spec} layout={layout} ctx={ctx} />;
  if (spec.kind === "cover" && layout.kind === "cover") return <CoverCard spec={spec} layout={layout} ctx={ctx} />;
  if (spec.kind === "stat" && layout.kind === "stat") return <StatCard spec={spec} layout={layout} ctx={ctx} />;
  if (spec.kind === "list" && layout.kind === "list") return <ListCard spec={spec} layout={layout} ctx={ctx} />;
  if (spec.kind === "cta" && layout.kind === "cta") return <CtaCard spec={spec} layout={layout} ctx={ctx} />;
  throw new Error(`A ${spec.kind} card was laid out as a ${layout.kind} card.`);
}
